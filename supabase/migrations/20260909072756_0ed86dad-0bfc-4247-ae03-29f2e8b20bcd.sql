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