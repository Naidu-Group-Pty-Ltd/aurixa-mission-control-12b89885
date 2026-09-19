-- @asserts column:clone_backends.schema_verified_at

-- A SCHEMA THAT HAS BEEN VERIFIED ONCE MUST NOT BE RE-VERIFIED EVERY MINUTE.
--
-- Measured against `npc-crm-independent-6505dc` on 19 Sep 2026. The backend
-- drain ticks every minute and `deployEdgeFunctions` manages about seven
-- functions per pass, so seven a minute is the ceiling. Observed: nineteen
-- functions in eleven minutes — the frontier moved from position 106 to 125
-- of the prime's 413 declared bundles. Under two a minute, against a ceiling
-- of seven, means roughly three ticks in four bought no functions at all.
--
-- They bought a re-verification of a schema that was already complete. The
-- pass order is introspect → stamp → deploy, and the edge-function pause
-- carries no `resumeStage`, which the caller reads as "leave the stored
-- marker alone". The marker is null by then, so the next pass starts the
-- introspection from the first stage: twelve stages, each asking the prime
-- and the clone what they hold, over ~650 tables. The module's own comment
-- calls that pass "cheap — every finished stage answers `alreadyReconciled`
-- with two COUNTs", and at this size it is not.
--
-- This column is the fact that pass was establishing. It is written ONLY
-- after a full, non-partial introspection reconciles every stage AND the
-- migration ledger stamp that follows it succeeds — never between the two,
-- because a pass that died in the gap would otherwise teach the next one to
-- skip a stamp that never ran. `stampMigrationLedgerFromPrime` is what makes
-- the introspected schema syncable at all, so skipping it silently is the
-- one outcome worse than re-verifying.
--
-- It is CLEARED whenever a fresh Supabase project is created for the row, so
-- a verification of the previous project can never be read as a statement
-- about the new one. A resume onto a surviving project keeps it, which is
-- the entire point.

alter table public.clone_backends
  add column if not exists schema_verified_at timestamptz;

comment on column public.clone_backends.schema_verified_at is
  'When a full introspection pass last reconciled every stage against the prime AND stamped the migration ledger. Set only after both; cleared when a new Supabase project is created for this row. While set, the provisioner skips introspection and resumes at the edge functions.';
