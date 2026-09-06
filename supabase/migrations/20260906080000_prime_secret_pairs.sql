-- @asserts cron:prime-secret-pairs
--
-- The prime's own cron secrets, paired hourly.
--
-- Two scheduled jobs on the prime (`agent-planner-run-scheduled`,
-- `market-qa-subscriptions-run-due`) send `x-cron-secret` from a database
-- setting that was never set, to ten functions comparing it against an
-- environment variable that was never set: 401 on every tick, on the prime
-- and — since a clone mirrors the prime's shape — on every clone. The finance
-- reminder function compares the same header against a secret whose vault
-- half the prime never held.
--
-- `/hooks/prime-secret-pairs` writes each pair mirror-first and re-asserts
-- the environment from the mirror, so a pass over a prime that already
-- agrees writes nothing. Once the prime holds a half, the clone sweep gives
-- every clone its OWN pair.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, and the URL is the custom domain. `check-cron-auth.mjs` fails CI
-- on either.

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

  PERFORM cron.unschedule('prime-secret-pairs')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prime-secret-pairs');

  PERFORM cron.schedule(
    'prime-secret-pairs',
    '52 * * * *',
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
      v_base || '/hooks/prime-secret-pairs'
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'prime secret pairs NOT scheduled (%).', SQLERRM;
END $$;
