-- @asserts column:schema_migration_queue.already_applied
-- @asserts check:schema_migration_queue.status=recorded

-- A MIGRATION THE PLATFORM ALREADY APPLIED IS RECORDED, NEVER RE-EXECUTED.
--
-- `aurixa.drain_schema_migrations()` runs `EXECUTE v_row.sql` unconditionally.
-- The statement immediately after it —
--
--     INSERT INTO supabase_migrations.schema_migrations (version)
--     SELECT v_row.version WHERE NOT EXISTS (...)
--
-- reads like an already-applied guard and is not one: it prevents a duplicate
-- ledger ROW, not a duplicate APPLY. Nothing anywhere stops a migration that
-- has already run from running a second time.
--
-- ## Why that is not theoretical here
--
-- Mission Control is edited in two places. This repository is one; Lovable is
-- the other, and Lovable APPLIES the migrations it authors, then commits the
-- file afterwards. Measured 12 Sep 2026 over the whole corpus:
--
--     268 migration files
--     141 authored by Lovable (UUID filenames, `gpt-engineer-app[bot]`)
--       3 of those postdate this queue
--       2 of those three reached the queue and were replayed
--
-- Both replays were harmless, and both were harmless BY LUCK. The header of
-- `20260909010118` says so itself: *"Applied OUT OF BAND on 9 Sep to unstick a
-- preview build, and committed afterwards … every statement here is
-- `IF NOT EXISTS` and the backfill is guarded."* That is a property of those
-- particular files, not of the pipeline.
--
-- The third one shows the cost when the luck runs out. `20260909072756` carries
-- a non-idempotent INSERT and an UPDATE that resets six queue rows to `queued`;
-- its own header reads **"DO NOT REPLAY"**, because releasing those six adds a
-- rollup quantity a second time (`billable_quantity + SUM(quantity)` is an
-- absolute, not a delta) and flips the `absorbed` rows to billable, charging
-- for calls the business absorbs. It escaped only because its own count
-- assertion refused on the retry and an operator deleted the row by hand.
--
-- Both of the two that were replayed arrived by a direct push to `main` from
-- `gpt-engineer-app[bot]`, commit messages "Work in progress" and "Changes".
--
-- ## Why the LEDGER cannot answer this, measured
--
-- The obvious fix is for the drain to skip a version already in
-- `supabase_migrations.schema_migrations`. It does not work, and the reason is
-- a measurement rather than an opinion. Of the 141 Lovable-authored files:
--
--     ledger carries the file's OWN version exactly :  36
--     ledger carries a row within 10 seconds        : 138
--     no ledger row within 10 seconds               :   3
--
--     skew (ledger minus filename): -7s, -4s, -3s, -2s, +2s … +7s
--
-- Lovable stamps the ledger when it BEGINS applying and names the file when it
-- WRITES it, so the two timestamps differ by a few seconds in either direction
-- and by no constant amount. A version-equality test answers "never ran" for
-- 105 files that demonstrably ran. A ±10s window is a guess, and in a burst of
-- migrations seconds apart it lands on a DIFFERENT migration's row. The ledger
-- records that something ran; it cannot say which file.
--
-- The filename shape is not the answer either. `migrationProvenance.pure.ts`
-- in this same repository was written after a shape heuristic classified six
-- genuine hand-carried applies as assertions. A UUID filename is a shape.
--
-- ## So the submitter declares it, and the declaration is an ACCOUNT
--
-- `apply-migrations.yml` knows who authored the commit that ADDED each file.
-- A migration added by the Lovable app was applied by Lovable before it
-- reached the repository — that is how the platform works. It is read from
-- git, it names an account, and it is not an inference from the file.
--
-- ## What keeps the declaration honest
--
-- The dangerous direction is the other one: if Lovable ever commits a
-- migration it did NOT apply, recording it would leave the schema silently
-- short of the effect. That is caught, by machinery this repository already
-- runs. Every migration declares a checkable effect (`-- @asserts`),
-- `public.migration_assertion_checks` holds the verdicts, and
-- `migration-drift-hourly` — scheduled `17 * * * *`, confirmed active —
-- evaluates them every hour and surfaces them on `/health`.
--
-- So the declaration is trusted for WHAT TO RUN and never for whether the
-- effect arrived. Those are different questions and different authorities.
--
-- ## `recorded` is its own status, not a kind of `applied`
--
-- "this queue ran it" and "this queue was told it had already run" are
-- different facts. Collapsing them loses exactly the distinction an operator
-- needs at the moment it matters — when an assertion later fails and the
-- question is whether anything ever executed that file here.

alter table public.schema_migration_queue
  add column if not exists already_applied boolean not null default false;

comment on column public.schema_migration_queue.already_applied is
  'The submitter declares this migration was applied OUT OF BAND before it was '
  'committed — in practice, authored and applied by Lovable and pushed afterwards. '
  'The drain RECORDS such a row (stamps the ledger, status `recorded`) and never '
  'EXECUTEs it. Set from the git author of the commit that added the file, which '
  'is an account rather than an inference; the ledger cannot answer this, because '
  'Lovable stamps a version 2-7 seconds from the filename''s in either direction. '
  'Whether the effect actually arrived is a separate question, answered hourly by '
  'migration-drift-hourly against the file''s own @asserts claims.';

-- `recorded` joins the terminal states. `queued` and `running` are not terminal;
-- `failed` halts the queue and keeps doing so.
alter table public.schema_migration_queue
  drop constraint if exists schema_migration_queue_status_check;

alter table public.schema_migration_queue
  add constraint schema_migration_queue_status_check
  check (status = any (array['queued'::text, 'running'::text, 'applied'::text,
                             'recorded'::text, 'failed'::text]));

-- The drain, with one branch added and nothing else changed.
--
-- The recorded path sits INSIDE the same sub-block as the applied path, so a
-- ledger-stamp failure is handled identically — rolled back to the savepoint,
-- counted as an attempt, terminal on the third. A path that could not fail
-- would be a path whose failures are invisible.
create or replace function aurixa.drain_schema_migrations(_max_per_run integer default 20)
returns jsonb
language plpgsql
set search_path to 'public', 'extensions', 'pg_catalog'
as $function$
DECLARE
  v_row      public.schema_migration_queue%ROWTYPE;
  v_applied  integer := 0;
  v_recorded integer := 0;
  v_failed   integer := 0;
  v_names    text[]  := ARRAY[]::text[];
  v_noted    text[]  := ARRAY[]::text[];
  v_msg      text;
  v_state    text;
  v_terminal boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('aurixa.drain_schema_migrations')) THEN
    RETURN jsonb_build_object('skipped', 'another drain holds the lock');
  END IF;

  IF EXISTS (SELECT 1 FROM public.schema_migration_queue WHERE status = 'failed') THEN
    RETURN jsonb_build_object('halted', 'a failed migration is blocking the queue');
  END IF;

  WHILE v_applied + v_recorded + v_failed < GREATEST(COALESCE(_max_per_run, 20), 1) LOOP
    SELECT * INTO v_row
      FROM public.schema_migration_queue
     WHERE status = 'queued'
     ORDER BY version, enqueued_at
     LIMIT 1;
    EXIT WHEN NOT FOUND;

    UPDATE public.schema_migration_queue
       SET status = 'running', started_at = now(), attempts = attempts + 1
     WHERE id = v_row.id;

    BEGIN
      -- The whole change. A declared-applied row is stamped and never run.
      IF NOT v_row.already_applied THEN
        EXECUTE v_row.sql;
      END IF;

      INSERT INTO supabase_migrations.schema_migrations (version)
      SELECT v_row.version
       WHERE NOT EXISTS (
         SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = v_row.version
       );

      UPDATE public.schema_migration_queue
         SET status = CASE WHEN v_row.already_applied THEN 'recorded' ELSE 'applied' END,
             finished_at = now(),
             error = NULL
       WHERE id = v_row.id;

      IF v_row.already_applied THEN
        v_recorded := v_recorded + 1;
        v_noted := v_noted || v_row.name;
      ELSE
        v_applied := v_applied + 1;
        v_names := v_names || v_row.name;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_state = RETURNED_SQLSTATE;
        v_terminal := (v_row.attempts + 1) >= 3;
        UPDATE public.schema_migration_queue
           SET status = CASE WHEN v_terminal THEN 'failed' ELSE 'queued' END,
               error = format('%s %s', v_state, v_msg),
               finished_at = CASE WHEN v_terminal THEN now() ELSE NULL END
         WHERE id = v_row.id;
        v_failed := v_failed + 1;
        EXIT;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'applied', v_applied,
    'recorded', v_recorded,
    'failed', v_failed,
    'names', to_jsonb(v_names),
    'noted', to_jsonb(v_noted)
  );
END $function$;

-- `aurixa` has no `pg_default_acl` entry, but PostgreSQL grants EXECUTE on a
-- new function to PUBLIC regardless, and `create or replace` above replaces a
-- function whose grants were already taken away. Restated so a replacement can
-- never quietly re-open it.
revoke all on function aurixa.drain_schema_migrations(integer) from public;

do $revoke_fn$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function aurixa.drain_schema_migrations(integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function aurixa.drain_schema_migrations(integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'revoke all on function aurixa.drain_schema_migrations(integer) from service_role';
  end if;
end $revoke_fn$;
