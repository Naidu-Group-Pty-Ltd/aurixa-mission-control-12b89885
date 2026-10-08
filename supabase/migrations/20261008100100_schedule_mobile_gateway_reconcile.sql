-- @asserts cron:mobile-gateway-reconcile-30min
-- Schedule /hooks/mobile-gateway-reconcile.
--
-- WHAT IT IS FOR. Every clone is wired for the mobile apps at BIRTH
-- (provisioning step 5h: the gateway row, the `mmc_` credential delivered as a
-- clone secret, six release subscriptions, the seeded superadmin's grant).
-- This job runs that same function over the whole fleet, so:
--   - a clone provisioned before the gateway existed converges by the
--     identical code path — no separate injection, no orphan;
--   - a birth step that was interrupted (a Management API blip while writing
--     the secret) is finished without anybody pressing a button;
--   - a licence change on a partner portal reaches its subscription row.
--
-- THIRTY MINUTES. Nothing waits on it: birth does the work inline, and this is
-- the safety net. A converged clone costs reads only and records no event.
--
-- The secret is read inside the command, the shape `check:cron-auth`
-- enforces. Idempotent: an existing vault-reading job is left as it is.

DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1),
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  -- mobile-gateway-reconcile-30min -> /hooks/mobile-gateway-reconcile   (7,37 * * * *)
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'mobile-gateway-reconcile-30min' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('mobile-gateway-reconcile-30min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mobile-gateway-reconcile-30min');
    PERFORM cron.schedule(
      'mobile-gateway-reconcile-30min',
      '7,37 * * * *',
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
        v_base || '/hooks/mobile-gateway-reconcile'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'mobile-gateway-reconcile-30min', v_base;
  END IF;
END $$;
