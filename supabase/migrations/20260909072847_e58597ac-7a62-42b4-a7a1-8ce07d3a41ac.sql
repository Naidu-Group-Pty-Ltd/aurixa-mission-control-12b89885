-- @asserts none:revokes default grants and enables RLS on the backup table; creates no object

-- Closes the backup table taken above: it holds a verbatim copy of migration
-- SQL, which the drain executes as `postgres`, so it is REVOKEd from anon and
-- authenticated and has RLS on. The control is the REVOKE rather than a policy,
-- which is why `check-rls-policies` lists it as service-role-only.

revoke all on public.schema_migration_queue_backup_20260909 from anon, authenticated;
alter table public.schema_migration_queue_backup_20260909 enable row level security;