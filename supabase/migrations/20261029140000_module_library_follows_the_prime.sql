-- @asserts column:modules.archived_by_follow_run_id
-- @asserts cron:module-library-follow-15min
--
-- The module library follows the prime (docs/DELIVERY_SYSTEM_PLAN.md, D19).
--
-- The owner decided on 29 Oct 2026 that the library updates itself whenever
-- the prime changes, rather than when an admin resets and re-ingests it, so
-- that a new clone is always reconciled against the catalogue as the prime
-- holds it. Measured on Mission Control's database that day, read only:
--
--   * `modules` holds 135 rows, every one `approved`, shaped by the last
--     detection run, of 31 Jul 2026, which recorded no commit.
--   * `module_library` holds 134 entries, every one `pending` and none
--     recording a commit, so none can be pinned.
--   * `clone_modules` holds 328 installs across the four clones.
--   * Detection at prime@122b761, replayed against a copy of the prime, finds
--     143 modules: 121 of the 135 slugs, 22 new ones, and 14 gone.
--
-- `/hooks/module-library-follow` (`library-follow.server.ts`) reads the
-- prime's head and does nothing while the catalogue is settled at it. When the
-- head has moved, it detects the catalogue at the head and settles it there:
-- it approves what the run proposed, archives what the run no longer found,
-- and publishes an entry for each module whose entry changed, approved at the
-- run's commit. It changes no clone: a new clone is reconciled when it is
-- provisioned, against the catalogue the follow keeps at the prime's head.
--
-- `modules.archived_by_follow_run_id` is the follow run that archived a module
-- because it no longer found it, and NULL for every module a person archived.
-- A module the follow archived is brought back when a later run finds it
-- again; one a person archived never is. It is a soft reference, as
-- `detection_run_id` is: a run can be purged 180 days after it completes, and
-- the module outlives it. Additive and nullable, and no row is written.
--
-- The schedule's patience is longer than any other job's. A follow that has
-- detection to do reads about 4,600 files from GitHub by batch and writes the
-- catalogue, and the last detection runs (31 Jul 2026, file by file) took 601
-- to 742 seconds. A request pg_net stops waiting for is torn down before it
-- can settle (20260922150000), so the follow is given ten minutes, and it runs
-- every fifteen. A follow started while another is running finds that one's
-- run `running` and stops before it reads anything.

ALTER TABLE public.modules
  ADD COLUMN IF NOT EXISTS archived_by_follow_run_id uuid;

COMMENT ON COLUMN public.modules.archived_by_follow_run_id IS
  'The library follow''s detection run that archived this module because it no longer found it at the prime''s head (library-follow.server.ts). NULL for a module a person archived, which the follow never brings back. Soft reference: the run may be purged.';

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  PERFORM cron.unschedule('module-library-follow-15min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'module-library-follow-15min');

  PERFORM cron.schedule(
    'module-library-follow-15min',
    '4,19,34,49 * * * *',
    format(
      $f$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Lovable-Context','cron',
          'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
        ),
        body := jsonb_build_object('source','pg_cron'),
        timeout_milliseconds := 600000
      )$f$,
      v_base || '/hooks/module-library-follow'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration. The `cron:` assertion above is
  -- what says whether the job exists.
  RAISE WARNING 'module-library-follow schedule NOT applied (%).', SQLERRM;
END $$;
