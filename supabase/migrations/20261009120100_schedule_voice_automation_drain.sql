-- @asserts cron:voice-automation-drain
--
-- Schedule the voice-automation drain (/hooks/voice-automation-drain) every five
-- minutes.
--
-- A tenant's settings change is applied the moment it is saved; this job is what
-- carries everything that could NOT finish then: a connection the tenant is
-- authorising in another tab (the drain notices when Make says it is
-- authorised, binds it and applies the revision that was waiting on it), an
-- apply that failed on a Make error (retried on a back-off, then handed to an
-- operator), and the daily drift reading that tells an operator when somebody
-- edited the live CFG record in Make by hand.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, and the URL is the custom domain (check-cron-auth.mjs fails CI on
-- either being otherwise).

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

  PERFORM cron.unschedule('voice-automation-drain')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'voice-automation-drain');

  PERFORM cron.schedule(
    'voice-automation-drain',
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
        timeout_milliseconds := 120000
      )$f$,
      v_base || '/hooks/voice-automation-drain'
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'voice automation drain NOT scheduled (%).', SQLERRM;
END $$;
