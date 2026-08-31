-- @asserts table:clone_payment_gates
-- @asserts table:clone_payment_gate_events
-- @asserts column:prime_config.clone_gate_default_hours
--
-- The activation gate: a clone provisioned onto a PAID plan boots locked on a
-- clock, and Stripe opens it.
--
-- ============================================================================
-- WHY THE STATE IS DERIVED AND NOT STORED
-- ============================================================================
--
-- The obvious design is a `status` column that a worker flips to 'locked' when
-- the deadline passes. It is rejected, and the reason is in this repository's
-- own history: `docs/THE_CLONING_ENGINE.md` records six pg_cron jobs that were
-- never scheduled at all, silently, for months, because the migration that was
-- supposed to schedule them read an empty vault and RETURNed. Two of the three
-- provisioning engines had never run and every check reported healthy.
--
-- A gate whose CLOSING depends on a worker is a gate that fails OPEN when the
-- worker is missing — which is exactly the failure this platform has already
-- had, and the one it cannot detect. So nothing here closes a gate. The gate's
-- state is a pure function of four stored facts (`manual_override`, `paid_at`,
-- `locks_at`, now) evaluated on every read, by one module
-- (`src/lib/clonePaymentGate.pure.ts`) that Mission Control and every clone
-- both import. An unrun worker cannot hold a gate open, because no worker
-- holds it open.
--
-- ============================================================================
-- WHY `manual_override` IS ONE COLUMN
-- ============================================================================
--
-- "Manual lock" and "manual unlock" are two operator acts and the temptation is
-- two booleans. Two booleans can be true at once, and then the resolution order
-- decides — which is a rule nobody typed, sitting in code, deciding whether a
-- paying customer can work. One nullable column with a CHECK makes the
-- contradiction unrepresentable rather than merely unlikely.
--
-- ============================================================================
-- WHY NOTHING IS BACKFILLED
-- ============================================================================
--
-- Every existing clone, and the prime, must be unaffected. A row here IS the
-- gate; no row means no gate, and `clone-provisioning.functions.ts` is the ONLY
-- writer of a new one. This migration deliberately inserts zero rows. Adding a
-- backfill later would lock the fleet, so the absence is the feature.

-- ─── 0. Notification kinds ──────────────────────────────────────────────────
-- Declared before anything uses them. `20260820120000_notification_kinds_never_declared.sql`
-- records what happens otherwise: three kinds were inserted that the enum had
-- never contained, Postgres refused every write, the discarded error meant
-- nobody found out, and the notifications simply never arrived.

ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'clone_gate_armed';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'clone_gate_locked';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'clone_gate_unlocked';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'clone_gate_expiring';

-- ─── 1. Platform defaults ───────────────────────────────────────────────────
-- `prime_config` is the platform singleton and already carries defaults of
-- exactly this shape (`default_clone_org`, `default_cascade_mode`,
-- `codex_nightly_cron`).

ALTER TABLE public.prime_config
  ADD COLUMN IF NOT EXISTS clone_gate_default_hours integer NOT NULL DEFAULT 72,
  ADD COLUMN IF NOT EXISTS clone_gate_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.prime_config.clone_gate_default_hours IS
  'Default activation window, in hours, for a newly provisioned paid clone. 72 = three days.';
COMMENT ON COLUMN public.prime_config.clone_gate_enabled IS
  'Master switch. Off means provisioning arms no new gates; existing gates are untouched, because turning a feature off must never silently unlock a fleet.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prime_config_clone_gate_default_hours_check'
  ) THEN
    ALTER TABLE public.prime_config
      ADD CONSTRAINT prime_config_clone_gate_default_hours_check
      CHECK (clone_gate_default_hours BETWEEN 1 AND 8760);
  END IF;
END $$;

-- ─── 2. The gate ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.clone_payment_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- One gate per clone. The UNIQUE is what makes arming idempotent and what
  -- makes "does this clone have a gate?" a single lookup.
  clone_id uuid NOT NULL UNIQUE REFERENCES public.clones(id) ON DELETE CASCADE,

  -- The paid plan the gate was armed for, recorded at arm time. Kept even if
  -- the clone later changes plan: it is what the customer was asked to pay.
  plan_slug text,
  plan_name text,
  amount_due_cents integer,
  currency text NOT NULL DEFAULT 'AUD',

  -- The window. `grace_hours` is what an operator typed; `locks_at` is the
  -- instant derived from it. Both are stored because an operator who moves
  -- `armed_at` must not silently move the deadline, and a deadline set by hand
  -- has no hours to speak of.
  grace_hours integer,
  armed_at timestamptz NOT NULL DEFAULT now(),
  locks_at timestamptz,

  -- The operator's standing decision. NULL = the clock and the payment decide.
  manual_override text CHECK (manual_override IN ('locked', 'unlocked')),
  manual_override_reason text,
  manual_override_by uuid REFERENCES auth.users(id),
  manual_override_at timestamptz,

  -- Payment. `paid_at` is the unlock: because state is derived, stamping this
  -- IS the act, and there is no second write that could fail after it.
  paid_at timestamptz,
  payment_source text CHECK (
    payment_source IN ('stripe_checkout', 'stripe_subscription', 'stripe_invoice', 'operator')
  ),
  amount_paid_cents integer,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  stripe_subscription_id text,
  stripe_customer_id text,

  -- Observability. The clone stamps these when it asks; without them a gate
  -- that a deployment has never once read is indistinguishable from one that
  -- is working, and this platform has shipped that confusion before.
  last_checked_at timestamptz,
  check_count integer NOT NULL DEFAULT 0,
  first_locked_seen_at timestamptz,

  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- An override is a decision somebody made; it must say who and when.
  CONSTRAINT clone_payment_gates_override_attributed CHECK (
    manual_override IS NULL
    OR (manual_override_by IS NOT NULL AND manual_override_at IS NOT NULL)
  ),
  -- A payment must say where it came from, or the ledger cannot be reconciled
  -- against Stripe.
  CONSTRAINT clone_payment_gates_payment_attributed CHECK (
    paid_at IS NULL OR payment_source IS NOT NULL
  )
);

COMMENT ON TABLE public.clone_payment_gates IS
  'Activation gate for a paid clone. The presence of a row is the gate; its STATE is derived at read time by clonePaymentGate.pure.ts and is never stored.';
COMMENT ON COLUMN public.clone_payment_gates.locks_at IS
  'When the window closes. NULL means no deadline — the gate stays open until an operator locks it.';
COMMENT ON COLUMN public.clone_payment_gates.manual_override IS
  'Operator standing decision. NULL = clock + payment decide. One column, so ''locked'' and ''unlocked'' cannot both be set.';
COMMENT ON COLUMN public.clone_payment_gates.paid_at IS
  'Set when Stripe captured the activation payment. Stamping this unlocks the gate, because the state is derived.';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.clone_payment_gates TO authenticated;
ALTER TABLE public.clone_payment_gates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators can read clone payment gates"
  ON public.clone_payment_gates FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));
CREATE POLICY "Operators can insert clone payment gates"
  ON public.clone_payment_gates FOR INSERT TO authenticated
  WITH CHECK (public.is_operator(auth.uid()));
CREATE POLICY "Operators can update clone payment gates"
  ON public.clone_payment_gates FOR UPDATE TO authenticated
  USING (public.is_operator(auth.uid()));
CREATE POLICY "Admins can delete clone payment gates"
  ON public.clone_payment_gates FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- `clone_id` is covered by its UNIQUE constraint. These two are not.
CREATE INDEX IF NOT EXISTS idx_clone_payment_gates_override_by
  ON public.clone_payment_gates(manual_override_by);
-- The console's default view: everything not yet paid, soonest deadline first.
CREATE INDEX IF NOT EXISTS idx_clone_payment_gates_unpaid_locks_at
  ON public.clone_payment_gates(locks_at)
  WHERE paid_at IS NULL;

CREATE TRIGGER update_clone_payment_gates_updated_at
  BEFORE UPDATE ON public.clone_payment_gates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── 3. The event log ───────────────────────────────────────────────────────
-- The gate row holds the CURRENT answer. This holds how it got there, which is
-- what an operator needs when a customer says "I paid and it was still locked".

CREATE TABLE IF NOT EXISTS public.clone_payment_gate_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_id uuid NOT NULL REFERENCES public.clone_payment_gates(id) ON DELETE CASCADE,
  clone_id uuid NOT NULL REFERENCES public.clones(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (
    kind IN ('armed', 'extended', 'locked', 'unlocked', 'override_cleared',
             'payment_settled', 'payment_reversed', 'checkout_started', 'disarmed')
  ),
  -- The derived status either side of the event, so the log reads as a story
  -- rather than a list of writes.
  status_before text,
  status_after text,
  reason text,
  actor_id uuid REFERENCES auth.users(id),
  -- 'operator' | 'stripe' | 'system'. A NULL actor_id with actor 'stripe' is a
  -- machine act, which is different from an act nobody signed.
  actor text NOT NULL DEFAULT 'operator',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.clone_payment_gate_events IS
  'Append-only history of every act on an activation gate. Never updated, never deleted except by the gate''s own cascade.';

GRANT SELECT, INSERT ON public.clone_payment_gate_events TO authenticated;
ALTER TABLE public.clone_payment_gate_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Operators can read clone payment gate events"
  ON public.clone_payment_gate_events FOR SELECT TO authenticated
  USING (public.is_operator(auth.uid()));
CREATE POLICY "Operators can insert clone payment gate events"
  ON public.clone_payment_gate_events FOR INSERT TO authenticated
  WITH CHECK (public.is_operator(auth.uid()));

CREATE INDEX IF NOT EXISTS idx_clone_payment_gate_events_gate
  ON public.clone_payment_gate_events(gate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clone_payment_gate_events_clone
  ON public.clone_payment_gate_events(clone_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clone_payment_gate_events_actor
  ON public.clone_payment_gate_events(actor_id);
