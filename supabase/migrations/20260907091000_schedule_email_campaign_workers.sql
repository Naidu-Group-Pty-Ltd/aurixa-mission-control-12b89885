-- @asserts cron:email-campaign-dispatch-1min
-- @asserts cron:email-bounce-scan-15min
--
-- The email scheduler's two workers.
--
-- **Dispatch, every minute.** The gap between messages is a per-campaign
-- setting measured in seconds, so the tick has to be finer than the finest gap
-- anybody would set; a minute is what the outbound voice queue already uses and
-- what the planner is written against. One tick honours a gap SHORTER than a
-- minute by waiting inside itself, bounded by a wall-clock budget, so a
-- five-second cadence does not need a five-second cron.
--
-- **Bounce scan, every fifteen minutes.** This is the only thing that puts a
-- bounce in front of the never-mail-a-bouncer rule: Microsoft Graph raises no
-- webhook when an application-identity send fails downstream, and the failure
-- arrives as an ordinary message in the sending mailbox. Fifteen minutes is a
-- compromise between how fast a bad address should stop costing sender
-- reputation and how many Graph reads a mailbox with no bounces in it is worth.
-- Nothing here is idempotent by accident: each run resumes from the newest
-- timestamp a SUCCEEDED run recorded, so a failed run re-reads its window
-- rather than stepping over it.
--
-- Both follow the two rules `check-cron-auth.mjs` enforces, for reasons that
-- cost this deployment real outages: the secret is read from the VAULT rather
-- than from a GUC (an unset GUC coalesced to '' produces the literal header
-- `Bearer `, a well-formed request every hook answers 401, and pg_cron reports
-- every one of those runs as succeeded because queueing the HTTP call is the
-- success it reports), and it is read INSIDE the command string so a rotation
-- takes effect on the next run instead of replaying whatever was true at
-- install time. The URL is the custom domain, because the `.lovable.app` origin
-- answers the hooks 401.

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

  PERFORM cron.unschedule('email-campaign-dispatch-1min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-campaign-dispatch-1min');

  PERFORM cron.schedule(
    'email-campaign-dispatch-1min',
    '* * * * *',
    format(
      $f$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Lovable-Context','cron',
          'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
        ),
        body := jsonb_build_object('source','pg_cron'),
        timeout_milliseconds := 55000
      )$f$,
      v_base || '/hooks/email-campaign-dispatch'
    )
  );

  PERFORM cron.unschedule('email-bounce-scan-15min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-bounce-scan-15min');

  PERFORM cron.schedule(
    'email-bounce-scan-15min',
    '*/15 * * * *',
    format(
      $f$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Lovable-Context','cron',
          'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
        ),
        body := jsonb_build_object('source','pg_cron'),
        timeout_milliseconds := 55000
      )$f$,
      v_base || '/hooks/email-bounce-scan'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block in this corpus: a deployment
  -- without pg_cron must not fail the whole migration.
  RAISE WARNING 'email campaign workers NOT scheduled (%).', SQLERRM;
END $$;
