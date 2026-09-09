-- @asserts table:schema_migration_queue_backup_20260909

-- ONE-TIME REPAIR SCAFFOLDING — 9 Sep 2026. DO NOT REPLAY.
-- Full account: docs/INCIDENT_2026-09-08_MIGRATION_QUEUE_HALT.md
--
-- This backs up six queued migrations, strips the `BEGIN;`/`COMMIT;` that had
-- halted the drain with `0A000`, and RESETS THOSE SIX ROWS TO `queued`. That
-- last step is why it must never run again: those six were deliberately marked
-- applied without executing, because the database already carried their effect
-- and replaying `20260908040300` would add its rollup quantity a SECOND time
-- (its update is `billable_quantity + SUM(quantity)`, an absolute, not a delta)
-- and would flip the `absorbed` rows to billable, charging for calls the
-- business absorbs.
--
-- It failed here and its own guard is why: the insert is not idempotent, the
-- retry doubled the backup to 12 rows, and the count assertion refused. The row
-- was deleted from the queue rather than retried. The file remains only as the
-- record of the repair.

create table if not exists public.schema_migration_queue_backup_20260909 as
select * from public.schema_migration_queue where false;

revoke all on public.schema_migration_queue_backup_20260909 from public;

insert into public.schema_migration_queue_backup_20260909
select * from public.schema_migration_queue
where version in ('20260908040000','20260908040100','20260908040300','20260908110000','20260908110100','20260908110200');

do $$
declare _n int;
begin
  select count(*) into _n from public.schema_migration_queue_backup_20260909;
  if _n <> 6 then
    raise exception 'expected 6 backup rows, got %', _n;
  end if;
end $$;

update public.schema_migration_queue
set sql = regexp_replace(sql, '(?im)^[ \t]*(begin|commit)[ \t]*;[ \t]*\r?$\n?', '', 'g'),
    status = 'queued',
    attempts = 0,
    error = null,
    started_at = null,
    finished_at = null
where version in ('20260908040000','20260908040100','20260908040300','20260908110000','20260908110100','20260908110200');

do $$
declare _bad int;
begin
  select count(*) into _bad
  from public.schema_migration_queue q
  join public.schema_migration_queue_backup_20260909 b using (version)
  where regexp_replace(b.sql, '(?im)^[ \t]*(begin|commit)[ \t]*;[ \t]*\r?$\n?', '', 'g') is distinct from q.sql;
  if _bad > 0 then
    raise exception 'unexpected difference on % row(s)', _bad;
  end if;
end $$;