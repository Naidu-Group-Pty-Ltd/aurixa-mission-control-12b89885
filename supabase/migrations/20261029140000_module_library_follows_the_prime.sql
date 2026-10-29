-- @asserts column:modules.archived_by_follow_run_id
-- @asserts column:module_detection_runs.diagnostics_pruned_at
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
-- The mark is the follow's only while the follow's archive stands. A trigger
-- clears it on any status change that does not write it, so a module a person
-- approved, archived again or rejected after the follow archived it is a
-- person's, and the follow never brings it back. The follow writes the mark
-- on its archive and clears it on its revive, so it is never cleared under the
-- follow. Measured 29 Oct 2026: no module carries an archived status, so no
-- row changes.
--
-- `module_detection_runs.diagnostics_pruned_at` is when a follow deleted the
-- run's diagnostics: its import edges, backend artifacts and drift alerts.
-- Each of the 31 Jul runs left 13,698 such rows, the Modules page reads a
-- module's artifacts across every run, and the drift metrics count alerts
-- across them, so a finished follow prunes the runs before its own but the
-- one the catalogue is settled at, ten runs at a time, and stamps each.
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

CREATE OR REPLACE FUNCTION public.modules_follow_mark_is_the_follows()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- A status change that does not write the mark was not the follow's.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.archived_by_follow_run_id IS NOT DISTINCT FROM OLD.archived_by_follow_run_id THEN
    NEW.archived_by_follow_run_id := NULL;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS modules_follow_mark_is_the_follows ON public.modules;
CREATE TRIGGER modules_follow_mark_is_the_follows
  BEFORE UPDATE OF status ON public.modules
  FOR EACH ROW EXECUTE FUNCTION public.modules_follow_mark_is_the_follows();

ALTER TABLE public.module_detection_runs
  ADD COLUMN IF NOT EXISTS diagnostics_pruned_at timestamptz;

COMMENT ON COLUMN public.module_detection_runs.diagnostics_pruned_at IS
  'When the library follow deleted this run''s import edges, backend artifacts and drift alerts (library-follow.server.ts). NULL while they are kept.';

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
