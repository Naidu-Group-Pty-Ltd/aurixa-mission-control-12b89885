-- @asserts column:clone_backends.chunk_cursor

-- A SEED TOO BIG FOR ONE INVOCATION CANNOT BE APPLIED BY RESTARTING IT.
--
-- `applyPrimeMigrations` can stream a body past the Management API's ceiling
-- and send it as chunked statements, and it accepts a cursor so a pass stopped
-- part-way resumes at the statement after the last one sent. The self-healing
-- `sql_migration` lane passes one, persisted on its run row. The FLEET sync
-- passes none, and said why:
--
--   "No cursor is passed. The self-healing lane persists one because it runs
--    inside a hard invocation budget; this job is reclaimed after
--    STALE_CLAIM_MINUTES and re-sends from the first statement, which is
--    idempotent by the clause above. Slower, never wrong."
--
-- Idempotent, yes. Slower, no — never. A pass that cannot reach the END of the
-- seed inside one invocation starts again at statement 1 on the pass after,
-- and the seed never lands however many times it is tried. That is a livelock,
-- and the template-library seed (one ~40 MB INSERT) is the shape that hits it.
--
-- Measured 19 Sep 2026, the day the streaming fetch first worked at all: with
-- the body finally readable, the two passes that followed both died mid-seed.
-- Neither recorded a `lane:fleet-migration-sync` usage row, both left
-- `worker_started_at` set — which also starves every other clone, because the
-- loop needs the claim free — and the fleet's `migration_version` did not move.
-- Before the fetch was fixed the same passes finished in about eight seconds,
-- because a 403 arrives quickly; the lane looked healthy precisely while it was
-- incapable of the work.
--
-- So the cursor gets somewhere to live. This column is the fleet lane's
-- equivalent of the run row's `chunk_cursor`, and it is written on EVERY
-- statement rather than at the end of a pass: a pass that is killed is the
-- ordinary case here, and a cursor only a surviving pass could write would be
-- exactly as useful as no cursor.
--
-- It is cleared when the migration it names is fully applied, because a cursor
-- into a finished file would make the next pass skip statements of the NEXT
-- oversized seed it meets. It is also cleared when a fresh Supabase project is
-- created for the row: statement boundaries are a fact about a file, but "the
-- first N landed" is a fact about a DATABASE, and the new one holds none of
-- them.

alter table public.clone_backends
  add column if not exists chunk_cursor jsonb;

comment on column public.clone_backends.chunk_cursor is
  'Where the fleet migration sync stopped inside a chunked oversized seed: {"migrationId","statementsDone"}. Written on every statement sent, so a pass the runtime kills still resumes. Cleared when that migration completes, and when a new Supabase project is created for this row.';
