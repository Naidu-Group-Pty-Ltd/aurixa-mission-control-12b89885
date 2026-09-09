-- @asserts column:clone_backends.migration_blocked_at
-- @asserts column:clone_backends.migration_blocked_reason
-- @asserts column:clones.merge_drain_at

-- Applied OUT OF BAND on 9 Sep to unstick a preview build, and committed
-- afterwards. Its statements are the same ones `20260908160000` and
-- `20260908170000` carry, which is why those two landed as no-ops: every
-- statement here is `IF NOT EXISTS` and the backfill is guarded. Kept rather
-- than deleted because it is the honest record of how this schema arrived.

-- Migration lane gets its own exclusion field
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

create index if not exists clone_backends_migration_eligible_idx
  on public.clone_backends (migration_version nulls first)
  where migration_blocked_at is null and supabase_project_ref is not null;

-- Merge drain rotation cursor
alter table public.clones
  add column if not exists merge_drain_at timestamptz;

comment on column public.clones.merge_drain_at is
  'When the cascade merge drain last VISITED this clone, whether or not anything merged. '
  'Ordering by it nulls-first is what stops a run that fits its budget from serving the same '
  'head of the list every time while the tail starves unreported.';

create index if not exists clones_merge_drain_rotation_idx
  on public.clones (merge_drain_at nulls first)
  where github_owner is not null and github_repo is not null;