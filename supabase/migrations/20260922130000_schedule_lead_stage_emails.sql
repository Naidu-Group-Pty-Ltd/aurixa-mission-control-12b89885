-- Schedule the priority-access stage mailer.
--
-- @asserts cron:lead-stage-emails
--
-- Every five minutes, not every minute. A stage email is an acknowledgement,
-- not an alert: five minutes is inside what anybody notices, and the applicant
-- backstop deliberately waits out a grace period anyway
-- (`LEAD_STAGE_APPLICANT_GRACE_MINUTES`, 45 by default) so that the Make
-- scenario's own send is never overtaken. A one-minute tick would spend 288
-- extra invocations a day to arrive no sooner.
--
-- The base URL and the Authorization header follow 20260829100000 exactly, and
-- for its reason: `aurixa-mission-control.lovable.app` 301s to the custom
-- domain, and libcurl drops `Authorization` on a cross-host hop — so a job
-- pointed at the lovable.app host arrives unauthenticated however good the
-- token is.

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

  PERFORM cron.unschedule('lead-stage-emails')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lead-stage-emails');

  PERFORM cron.schedule(
    'lead-stage-emails',
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
      v_base || '/hooks/lead-stage-emails'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration. The mailer is still reachable
  -- by hand at POST /hooks/lead-stage-emails with the cron secret.
  RAISE WARNING 'lead-stage-emails NOT scheduled (%).', SQLERRM;
END $$;
