-- @asserts cron:voice-stack-drain
--
-- Schedule the voice-stack drain (/hooks/voice-stack-drain) every five minutes.
--
-- It carries every clone's Vapi custody and voice stack forward:
--   1. custody — turns on receiving for a clone's domain and mints its Vapi
--      login once the clone's email identity has a domain; notices Vapi's
--      verification mail arriving (the operator then completes sign-up);
--   2. stacks — re-judges each stack's requirements, then runs the build steps
--      one tick may afford, in order, recording each object the moment it
--      exists; re-checks a stack waiting on a tenant's grant and switches it on
--      when the grant arrives;
--   3. line changes — parks the stack of the line a converted clone left and
--      starts (or resumes) the one for the line it joined.
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

  PERFORM cron.unschedule('voice-stack-drain')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'voice-stack-drain');

  PERFORM cron.schedule(
    'voice-stack-drain',
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
        timeout_milliseconds := 290000
      )$f$,
      v_base || '/hooks/voice-stack-drain'
    )
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'voice stack drain NOT scheduled (%).', SQLERRM;
END $$;
