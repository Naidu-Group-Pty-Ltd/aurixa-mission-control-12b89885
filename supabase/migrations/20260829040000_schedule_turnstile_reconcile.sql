-- @asserts cron:turnstile-reconcile-10min
--
-- Schedule the Turnstile repair sweep.
--
-- The deployment drain mints a clone's own Turnstile widget in `syncing_env`.
-- That covers every clone provisioned from now on and NO clone provisioned
-- before the step existed — which is the entire fleet as it stands. A
-- per-tenant security credential that only future tenants receive is the same
-- gap `allowed-origins-reconcile` was written to close, and this closes it the
-- same way.
--
-- Ten minutes, not one. Every pass that acts is a Cloudflare write, the work is
-- repair rather than a critical path, and `decideTurnstileSweep` holds a failed
-- identity for thirty minutes before retrying — so a permanent misconfiguration
-- costs a handful of calls a day instead of 1,440.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, exactly as `schedule_deployment_drain.sql` explains at length: the
-- secret is never baked in at install time, and a missing one fails loudly
-- rather than resolving to the literal header `Bearer `.

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

  PERFORM cron.unschedule('turnstile-reconcile-10min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'turnstile-reconcile-10min');

  PERFORM cron.schedule(
    'turnstile-reconcile-10min',
    '*/10 * * * *',
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
      v_base || '/hooks/turnstile-reconcile'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'turnstile reconcile NOT scheduled (%).', SQLERRM;
END $$;
