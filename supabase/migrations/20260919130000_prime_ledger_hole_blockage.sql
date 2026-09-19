-- @asserts check:clone_sync_blockages.class=prime_ledger_hole
--
-- A prime-ledger hole becomes a blockage the ledger can hold.
--
-- `clone_sync_blockages.class` is CHECK-constrained, so a new class has to be
-- added to the column or every write is rejected there while looking, from the
-- function, exactly like a write nobody attempted. That is the failure this
-- migration exists to avoid rather than to fix.
--
-- WHY THE CLASS EXISTS
--
-- Rule #71 — a clone never runs a migration the prime itself has not run — is
-- enforced against the prime's own `supabase_migrations.schema_migrations`.
-- Nothing enforces what ENTERS that ledger: the prime applies migrations by
-- `workflow_dispatch` on a named file, so the ledger records what somebody
-- remembered to dispatch rather than what merged.
--
-- Measured 19 September 2026. Four migrations sat on prime's `main` unrecorded
-- and, asserted by effect rather than by the ledger, genuinely unapplied:
-- every object `20261202090000_builder_marketplace_ranking.sql` declares is
-- absent from the prime's live catalogue. Two tenants were held at frontier
-- `20261201100000` behind it, both reading `status: ready` with
-- `migration_blocked_at` NULL — the condition's only trace anywhere was prose
-- in `clone_backends.status_detail`.
--
-- No backfill. A blockage row is an OBSERVATION, and the sweep that makes them
-- will write these on its next pass from evidence it reads then. Inventing
-- rows here would date them to this migration and attribute them to nobody.

alter table public.clone_sync_blockages
  drop constraint if exists clone_sync_blockages_class_check;

alter table public.clone_sync_blockages
  add constraint clone_sync_blockages_class_check
  check (
    class = any (
      array[
        'policy_unseeded',
        'repo_retargeted',
        'unreconciled_proposal',
        'attempts_exhausted',
        'partial_clone_dropped',
        'approval_pending',
        'deferred_far_future',
        'event_stuck_running',
        'invocation_cut',
        'consecutive_failures',
        'ci_red',
        'prime_ledger_hole',
        'unclassified'
      ]::text[]
    )
  );

comment on constraint clone_sync_blockages_class_check on public.clone_sync_blockages is
  'The blockage taxonomy. Mirrors BlockageClass in src/server/cascade/blockageTaxonomy.pure.ts; a class in the code and not here is a write that fails as though nobody attempted it.';
