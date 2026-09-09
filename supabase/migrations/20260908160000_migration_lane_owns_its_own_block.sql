-- @asserts column:clone_backends.migration_blocked_at
-- @asserts column:clone_backends.migration_blocked_reason

-- The SQL migration lane gets its own exclusion field, and stops reading a
-- provisioning queue status as an answer about a tenant's schema.
--
-- ## What went wrong
--
-- `runFleetMigrationSync` selected `.eq("status", "ready")` on
-- `clone_backends`. That column is written by the PROVISIONING drain — it is
-- a queue status, describing a job — and read by the MIGRATION lane as though
-- it described a database. The two are different questions, and every reader
-- of `clone_backends` other than the migration lane already knows it: deploy,
-- secret forwarding, signing pairs, allowed origins and CI credentials all
-- ignore `status` entirely.
--
-- Measured 8 Sep 2026. `NPC Test` and `Preflight Property Group` were both
-- queued as REPAIRS at 01:07 and 01:08 on 7 September, were never claimed once
-- (`attempts: 0`, `worker_started_at` never set), and were swept to `failed`
-- exactly 24 hours later by the provisioning drain's wall-clock ceiling. Both
-- databases were, and are, entirely healthy — same `migration_version` as the
-- one clone that stayed `ready`, both serving 171 listings. But `failed` put
-- them outside the migration lane's query, so every half-hourly run for the
-- next day reported:
--
--     processed 1   advanced 0   up_to_date 1   excluded 2
--
-- and two of three tenants silently stopped receiving the prime's schema. The
-- symptom reached the operator as "SQL migrations don't run on clones", and
-- nothing else in the fleet looked wrong, because nothing else reads `status`.
--
-- ## The rule
--
-- **One field, one writer.** A migration is withheld from a clone because a
-- migration FAILED on that clone — a fact only the migration lane can
-- establish, and now the only thing that can write it down. A provisioning
-- verdict, whatever it says, no longer reaches this decision.
--
-- ## The backfill is the rule applied to history, not a hand-edit
--
-- Rows are blocked here if and only if their current state is the one the
-- migration lane itself writes on a failure: `status_detail` beginning
-- `Migration failed at `, which `fleet-migration.server.ts` composes and
-- nothing else does. Every other `failed` row is a queue or provisioning
-- fault, says nothing about the tenant's schema, and is therefore left
-- unblocked — which is exactly what releases the two clones above.
--
-- Prose is matched ONCE, here, over a closed historical set. It is never a
-- runtime predicate: from this migration forward the lane writes the column
-- and reads the column.

alter table public.clone_backends
  add column if not exists migration_blocked_at timestamptz,
  add column if not exists migration_blocked_reason text;

comment on column public.clone_backends.migration_blocked_at is
  'When a PRIME MIGRATION failed on this clone, taking it out of the fleet migration sync. '
  'Written and cleared only by the migration lane. A provisioning queue status is not an '
  'answer about a tenant schema and must never gate this lane again.';

comment on column public.clone_backends.migration_blocked_reason is
  'The migration that failed and what it said, for the operator who has to repair it.';

update public.clone_backends
set
  migration_blocked_at = coalesce(worker_finished_at, updated_at),
  migration_blocked_reason = coalesce(
    nullif(error_message, ''),
    status_detail,
    'A prime migration failed on this clone'
  )
where status = 'failed'
  and status_detail like 'Migration failed at %'
  and migration_blocked_at is null;

-- The lane's own query: eligible rows are the ones nothing is blocking and
-- nothing is mid-provision. Partial, because that is the only set it reads.
create index if not exists clone_backends_migration_eligible_idx
  on public.clone_backends (migration_version nulls first)
  where migration_blocked_at is null and supabase_project_ref is not null;
