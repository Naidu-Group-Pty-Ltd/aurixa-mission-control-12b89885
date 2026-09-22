-- @asserts rows:clones>=4
-- Give every existing clone its own billing identity.
--
-- `clones.billing_user_id` is read by seven call sites and was written by ONE
-- statement — the provisioning insert, `data.billingUserId ?? null`, taking a
-- wizard field that defaults blank under help text reading "Leave blank to
-- assign later". There was no later: nothing in Mission Control ever wrote the
-- column again. Measured 22 Sep 2026, all four live clones held NULL.
--
-- What that costs is not cosmetic. With no id:
--   • `/api/public/tokens/packs` answers a `topup_url` carrying no credential,
--     so the clone's own banner falls through to the constant its bundle
--     compiles in — `?uid=${VITE_AURIXA_BILLING_UID}`, which for every clone
--     mirrored from the prime defaulted to the PRIME's `npc-prime`; and
--   • a customer clicking "buy more tokens" therefore credits the prime's
--     balance. Stripe takes the money, a ledger row lands, and the number that
--     customer is looking at never moves.
--
-- ── This is a REPAIR, not a second authority ────────────────────────────────
--
-- `src/server/cloneBillingIdentity.pure.ts` is the rule, and provisioning now
-- goes through it so no future clone reaches this state. This migration only
-- applies that module's DERIVATION — the clone's own slug, which
-- `clones_slug_key` already keeps unique — to the rows that predate the
-- writer, and only where all four of its refusals are provably absent:
--
--   1. well-formed          lowercase alphanumerics and internal hyphens, 2..64
--   2. not reserved         never `npc-prime`; that is the prime install's own
--                           identity, compiled into its bundle, and a clone
--                           holding it would take every purchase the prime's
--                           customers make
--   3. not held by a clone  `clones_billing_user_id_uidx` would refuse it, but
--                           a named skip beats a 23505
--   4. not held by a FOREIGN tenant — the rule no column constraint can carry.
--                           The two unique indexes are PER TABLE, and
--                           `startUidCheckout` resolves a uid against `clones`
--                           BEFORE `tenants`. So a clone given a tenant's id
--                           does not collide with it; it SHADOWS it, silently,
--                           for every purchase made with that uid.
--
-- A row that fails any of them is left NULL and named in a warning, to be given
-- one by hand on the clone's own page — which now has that control.
--
-- Idempotent and non-destructive: `billing_user_id IS NULL` means an
-- operator-set value is never overwritten, and re-running changes nothing.

UPDATE public.clones c
   SET billing_user_id = c.slug
 WHERE c.billing_user_id IS NULL
   AND c.slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'
   AND length(c.slug) BETWEEN 2 AND 64
   AND c.slug <> 'npc-prime'
   AND NOT EXISTS (
     SELECT 1 FROM public.clones x
      WHERE x.billing_user_id = c.slug AND x.id <> c.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM public.tenants t
      WHERE t.billing_user_id = c.slug
        AND t.clone_id IS DISTINCT FROM c.id
   );

-- Asserted by EFFECT, never by the statement above having run: a WHERE clause
-- that matched nothing and a WHERE clause that matched everything are the same
-- migration from the outside.
DO $$
DECLARE
  unset   integer;
  r       RECORD;
BEGIN
  SELECT count(*) INTO unset FROM public.clones WHERE billing_user_id IS NULL;
  IF unset > 0 THEN
    FOR r IN SELECT id, slug FROM public.clones WHERE billing_user_id IS NULL LOOP
      RAISE WARNING
        'Clone % (%) still has no billing identity: its slug is malformed, reserved, or already held. Assign one on the clone''s page — until then its customers'' purchases credit whatever identity its bundle was built with.',
        r.slug, r.id;
    END LOOP;
  END IF;

  -- The shadow, checked after the fact rather than trusted to the WHERE.
  FOR r IN
    SELECT c.slug, t.id AS tenant_id
      FROM public.clones c
      JOIN public.tenants t
        ON t.billing_user_id = c.billing_user_id
       AND t.clone_id IS DISTINCT FROM c.id
     WHERE c.billing_user_id IS NOT NULL
  LOOP
    RAISE WARNING
      'Clone % shares a billing identity with tenant %, which belongs to a different workspace. A uid resolves against clones before tenants, so purchases made with it credit the clone.',
      r.slug, r.tenant_id;
  END LOOP;
END $$;
