-- @asserts cron:marketing-snapshots-daily
--
-- Schedule the Marketing module's nightly recorder (/hooks/marketing-snapshots).
--
-- One run records, for each connected source: today's reading of the YouTube
-- channel's lifetime counters, and the last seven days of each advertising
-- account (Meta, Google Ads on YouTube, TikTok) — re-read every night because
-- the platforms restate recent days as late conversions arrive. The first run
-- for an account reads ninety days, so the history starts with a quarter. A
-- source that is not connected is skipped and named in the response.
--
-- 19:50 UTC is 05:50 in Sydney in winter and 06:50 in summer: after the
-- platforms have closed the previous day, before anyone opens the page.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, and the URL is the custom domain rather than the lovable.app
-- origin (see 20260829100000_fix_agreements_refresh_cron.sql).
-- `check-cron-auth.mjs` fails CI on either.

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

  PERFORM cron.unschedule('marketing-snapshots-daily')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'marketing-snapshots-daily');

  PERFORM cron.schedule(
    'marketing-snapshots-daily',
    '50 19 * * *',
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
      v_base || '/hooks/marketing-snapshots'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'marketing snapshots NOT scheduled (%).', SQLERRM;
END $$;
