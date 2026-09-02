-- @asserts cron:clone-deployer-declaration-reconcile
--
-- Keep `BACKEND_DEPLOYED_BY` declared on every clone repository.
--
-- A clone's own `deploy-supabase-functions.yml` stands down only on a POSITIVE
-- assertion: that repository variable saying, in as many words, that somebody
-- else deploys. Without it the job goes red on every push touching a function
-- — correct on the prime, where nothing else deploys, and noise on a clone,
-- where Mission Control already did.
--
-- It used to be an ACT: written at provisioning, written on cascade, and
-- otherwise written by a button an operator had to find. So a clone whose
-- write was refused — the App lacked `variables: write` until somebody granted
-- it — had no way back except waiting for the next cascade or remembering to
-- click. A declaration nothing keeps true drifts, and the drift reads as a red
-- check everybody learns to ignore. This makes it standing state.
--
-- There is no "off" position, and that is a property of the workflow rather
-- than a simplification: its stand-down step requires that NO deploy token is
-- present, so a tenant whose CI holds a scoped token deploys exactly as it
-- would have, declared or not. Keeping this on everywhere cannot suppress
-- anybody's own pipeline.
--
-- Thirty minutes, not five. It settles: once a repository says it, a pass is
-- one variable listing and no write at all, and a quiet fleet files no audit
-- row either.
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

  PERFORM cron.unschedule('clone-deployer-declaration-reconcile')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clone-deployer-declaration-reconcile');

  PERFORM cron.schedule(
    'clone-deployer-declaration-reconcile',
    '*/30 * * * *',
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
      v_base || '/hooks/clone-deployer-declaration-reconcile'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'clone deployer declaration reconcile NOT scheduled (%).', SQLERRM;
END $$;
