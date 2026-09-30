-- @asserts check:clone_payment_gate_events.kind=trial_extended
-- @asserts column:clone_payment_gates.trial_extension_count
-- @asserts column:clone_payment_gates.trial_extended_at
-- @asserts column:clone_payment_gates.trial_extended_by
-- @asserts column:clone_payment_gates.trial_extension_reason

-- EXTENDING A TRIAL, RATHER THAN OPENING A GATE BY HAND AND REMEMBERING TO SHUT IT.
--
-- An activation gate locks when its window runs out. Until now an operator
-- asked for "give them another week" had two acts to reach for, and neither
-- was that:
--
--   * UNLOCK — a standing override that holds the workspace open for ever.
--     Somebody then has to come back in a week and LOCK it again, and a close
--     that depends on somebody remembering is a gate that fails open. That is
--     the exact failure `20260831000000_clone_payment_gates.sql` was designed
--     around ("nothing here closes a gate"), reintroduced by hand.
--   * WINDOW — a new window measured from `armed_at`. Right for correcting
--     the original terms, wrong for this: on a lapsed trial the operator has
--     to work out how many hours since provisioning land a week from today.
--
-- The trial extension is the act that was missing. It moves `locks_at` later
-- and writes nothing else about the window, so the gate stays DERIVED: it
-- reopens because the new deadline is in the future and it closes again by
-- itself when that deadline passes, unless the activation payment lands
-- first. The rule is `planTrialExtension` in `src/lib/clonePaymentGate.pure.ts`
-- and nothing here restates it; this migration only gives the act somewhere
-- to record itself.
--
-- Nothing is scheduled and nothing is backfilled. Every existing gate reads
-- `trial_extension_count = 0`, which is true: none has been extended by this
-- act. The Window act's own `extended` events are not trial extensions and
-- are left exactly as they are.

-- ─── 1. The vocabulary, first ───────────────────────────────────────────────
--
-- `logGateEvent` deliberately swallows a refused insert, because an audit
-- write must never fail the act it records. Put together with a CHECK that
-- does not know `trial_extended`, that would make every extension happen
-- with no history at all and nothing reporting it — the shape
-- `20260907160000_clone_secret_withheld_status.sql` records paying for once.
--
-- It comes BEFORE the columns below on purpose. The act cannot run until those
-- columns exist, so even a file applied one statement at a time can never let
-- an extension write against a column that refuses its event.
--
-- The constraint was declared inline by `20260831000000`, so Postgres named
-- it. Rather than trust the generated name, whichever CHECK on this table
-- constrains `kind` is dropped and one is added under an explicit name. The
-- list must equal `GATE_EVENT_KINDS` in `clonePaymentGate.pure.ts`;
-- `paymentGate.contract.test.ts` holds the two together.

do $$
declare
  _constraint record;
begin
  for _constraint in
    select conname
    from pg_constraint
    where conrelid = 'public.clone_payment_gate_events'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ~ '\mkind\M'
  loop
    execute format(
      'alter table public.clone_payment_gate_events drop constraint %I',
      _constraint.conname
    );
  end loop;

  alter table public.clone_payment_gate_events
    add constraint clone_payment_gate_events_kind_check
    check (kind in ('armed', 'extended', 'trial_extended', 'locked', 'unlocked',
                    'override_cleared', 'payment_settled', 'payment_reversed',
                    'checkout_started', 'disarmed'));
end
$$;

comment on column public.clone_payment_gate_events.kind is
  'What happened. extended = the Window act (any change of window, shorter included); trial_extended = the deadline moved later by a trial extension, which only ever adds time. The list is GATE_EVENT_KINDS in clonePaymentGate.pure.ts.';

-- ─── 2. The latest extension, on the gate itself ────────────────────────────
--
-- The event log already holds every extension. These four columns hold the
-- LATEST, because the console lists gates without reading their history and
-- "trial extended twice, last by whom and why" is what an operator fielding
-- "why am I locked again" needs to see on the row. They are bookkeeping and
-- nothing else: `resolveGateState` never reads them, so no status can depend
-- on them.

alter table public.clone_payment_gates
  add column if not exists trial_extension_count integer not null default 0,
  add column if not exists trial_extended_at timestamptz,
  add column if not exists trial_extended_by uuid references auth.users(id),
  add column if not exists trial_extension_reason text;

-- An extension is a decision somebody made, so it says who, when and why —
-- the same rule `clone_payment_gates_override_attributed` holds an override
-- to. Never extended means all four are empty; extended means none is.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'clone_payment_gates_trial_extension_attributed'
      and conrelid = 'public.clone_payment_gates'::regclass
  ) then
    alter table public.clone_payment_gates
      add constraint clone_payment_gates_trial_extension_attributed
      check (
        (trial_extension_count = 0
          and trial_extended_at is null
          and trial_extended_by is null
          and trial_extension_reason is null)
        or (trial_extension_count > 0
          and trial_extended_at is not null
          and trial_extended_by is not null
          and trial_extension_reason is not null)
      );
  end if;
end
$$;

-- Like `idx_clone_payment_gates_override_by`: the foreign key's referencing
-- side is never indexed by Postgres itself (`check:fk-indexes`).
create index if not exists idx_clone_payment_gates_trial_extended_by
  on public.clone_payment_gates (trial_extended_by);

comment on column public.clone_payment_gates.trial_extension_count is
  'How many times this gate''s trial has been extended. Bookkeeping only — the gate''s state never reads it.';
comment on column public.clone_payment_gates.trial_extended_at is
  'When the latest trial extension was made. The full history is in clone_payment_gate_events (kind trial_extended).';
comment on column public.clone_payment_gates.trial_extended_by is
  'Who made the latest trial extension.';
comment on column public.clone_payment_gates.trial_extension_reason is
  'Why the latest trial extension was made, in the operator''s words.';
