-- @asserts cron:cascade-merge-drain
--
-- Schedule the cascade merge drain.
--
-- `auto_merge` opens a pull request and does NOT merge it on the spot. Check
-- runs appear asynchronously — `Vercel Preview Comments` completes in the same
-- second, `verify` takes about seventeen minutes — so a gate reading the checks
-- once, immediately, would see one fast green check and merge before the job
-- that installs, type-checks, builds and runs ~19,000 tests has an opinion.
--
-- GitHub's own auto-merge is the mechanism designed for that wait, and it
-- cannot be armed on a repository with no required status checks. Every clone
-- here has an unprotected default branch. Without this drain the honest gate
-- therefore produces the old symptom by another route: pull requests opened,
-- nothing merged, `0 merged` for ever — which is exactly the state 108 of the
-- last 110 cascades were in.
--
-- Five minutes. The work is one `pulls.list` per clone and a `checks.listForRef`
-- per open cascade pull request, so a settled fleet costs a couple of API calls
-- and merges nothing.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, and the URL is the custom domain rather than the lovable.app
-- origin — the two faults that left `agreements-refresh` answering 401 on every
-- run since it was installed. `check-cron-auth.mjs` fails CI on either.

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

  PERFORM cron.unschedule('cascade-merge-drain')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cascade-merge-drain');

  PERFORM cron.schedule(
    'cascade-merge-drain',
    '*/5 * * * *',
    format(
      $f$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Lovable-Context','cron',
          'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
        ),
        body := jsonb_build_object('source','pg_cron'),
        timeout_milliseconds := 60000
      )$f$,
      v_base || '/hooks/cascade-merge-drain'
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'cascade merge drain NOT scheduled (%).', SQLERRM;
END $$;
