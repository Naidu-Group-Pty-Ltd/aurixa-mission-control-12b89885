-- @asserts rows:prime_secret_forwards>=44
-- @asserts check:migration_assertion_checks.status=superseded
-- @supersedes 20260906100000_didit_fleet_forward.sql:rows:prime_secret_forwards>=45

-- A CLAIM A LATER DECISION WITHDREW IS RETIRED, NEVER LEFT CRYING WOLF.
--
-- `20260906100000_didit_fleet_forward.sql` claimed `rows:prime_secret_forwards
-- >= 45` — true the day it applied. On 7 Sep 2026 the platform measured what
-- a fleet-forwarded Didit key can reach (every tenant's customers' identity
-- documents; see the prime repo's docs/aml/VERIFICATION_BROKER.md) and
-- deliberately WITHDREW that key from the forward set: the credential stopped
-- travelling and the call travels through Mission Control instead. The table
-- has correctly held 44 rows since, and the drift alarm has correctly read
-- the old claim `unsatisfied` every hour for nine days — an alarm that is
-- right about a stale claim, which trains operators to ignore it, which is
-- how the next real drift gets missed.
--
-- An applied migration's file cannot be edited (the applied-digest manifest
-- pins it), so the amendment is a new migration: the `@supersedes` line above
-- retires the old claim in the corpus — the hourly check records it as
-- `superseded`, naming this file, instead of probing it — and the first line
-- restates the floor at the level the 7 Sep decision left true. The ledger
-- keeps both: the original claim, and the recorded decision that withdrew it.
--
-- The status vocabulary gains `superseded`, so the CHECK constraint widens —
-- and a CHECK a column refuses fails at the write while looking, from the
-- worker, exactly like a write nobody attempted, which is why the widening
-- ships in the same migration as the corpus change that needs it.
alter table public.migration_assertion_checks
  drop constraint if exists migration_assertion_checks_status_check;
alter table public.migration_assertion_checks
  add constraint migration_assertion_checks_status_check
  check (status in ('satisfied', 'unsatisfied', 'unassertable', 'not_applicable', 'error', 'superseded'));

comment on column public.migration_assertion_checks.status is
  'satisfied | unsatisfied (the only alarm) | unassertable | not_applicable | error | superseded (a later migration''s @supersedes retired this claim; the detail names it).';

comment on table public.prime_secret_forwards is
  'Prime-owned vendor credentials forwarded to clone projects. 44 rows since 7 Sep 2026: the Didit key was deliberately withdrawn when the verification broker replaced fleet forwarding — a forwarded Didit key can read every tenant''s customers'' identity documents. Floor asserted by 20260916180000.';
