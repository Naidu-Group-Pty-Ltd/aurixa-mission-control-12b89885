-- @asserts cron:agreements-refresh
-- @asserts cron:airtable-waitlist-sync
-- @asserts cron:crm-sweep-hourly
--
-- The DocuSign poll has never delivered a request.
--
-- `agreements-refresh` is the fallback behind the Connect webhook: it polls
-- every sent/delivered envelope with the same JWT credentials the send path
-- uses, so a signed agreement provisions its clone within ten minutes even
-- when no webhook is configured. It was installed by
-- 20260828070000_agreement_provisioning.sql with two independent faults, and
-- each on its own produces the identical symptom — HTTP 401, every ten
-- minutes, for as long as the job has existed. Measured 29 Aug 2026 from
-- `net._http_response`: 37 refusals across the ~6 hours pg_net retains, while
-- `cron.job_run_details` reported all 36 runs `succeeded`.
--
-- Fault 1 — the credential names a vault entry that does not exist.
--   'Bearer ' || (SELECT decrypted_secret … WHERE name = 'DRIFT_REFRESH_TOKEN')
-- The vault holds `cron_secret`, `public_app_url`,
-- `storefront_catalog_sync_token` and `storefront_catalog_sync_url` — and
-- nothing else. The subselect returns NULL, `'Bearer ' || NULL` is NULL, and
-- `jsonb_build_object` stores a null value rather than raising. This is the
-- same class `check-cron-auth.mjs` was written for one level deeper: there a
-- missing secret degraded into the literal header `Bearer `, here into a null
-- one. `verifyCronAuth` accepts CRON_SECRET or DRIFT_REFRESH_TOKEN as ENV
-- names, which is why the wrong VAULT name looked plausible — the two
-- namespaces are unrelated and only the vault one is read here.
--
-- Fault 2 — the URL is the lovable.app origin, which 307s to the custom
-- domain. pg_net follows the redirect, but libcurl drops `Authorization` on a
-- cross-host hop unless CURLOPT_UNRESTRICTED_AUTH is set, so the request
-- arrives unauthenticated however good the token is. Verified directly: the
-- same body and a correct `cron_secret` answers 401 against
-- aurixa-mission-control.lovable.app and 200 against
-- mission-control.aurixasystems.com.au.
--
-- Fixing either alone leaves the job at 401, which is why both move here.
--
-- Two more jobs carry the same pair in the CORPUS while running correctly in
-- production: `airtable-waitlist-sync` and `crm-sweep-hourly` were repaired
-- directly on the deployment and never in a migration, so the only file that
-- schedules either still installs the broken form. Nothing is failing today —
-- but a replay from zero would reinstall two jobs that can never
-- authenticate, and this repository already knows that the ledger and the
-- corpus barely overlap. They are rescheduled here to the command production
-- actually runs, which makes the corpus end-state true rather than merely
-- harmless. Both are idempotent: unschedule-then-schedule onto the same
-- command.

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

  PERFORM cron.unschedule('agreements-refresh')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'agreements-refresh');

  PERFORM cron.schedule(
    'agreements-refresh',
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
      v_base || '/hooks/agreements-refresh'
    )
  );

  PERFORM cron.unschedule('airtable-waitlist-sync')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'airtable-waitlist-sync');

  PERFORM cron.schedule(
    'airtable-waitlist-sync',
    '17 * * * *',
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
      v_base || '/hooks/airtable-sync'
    )
  );

  PERFORM cron.unschedule('crm-sweep-hourly')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'crm-sweep-hourly');

  PERFORM cron.schedule(
    'crm-sweep-hourly',
    '23 * * * *',
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
      v_base || '/hooks/crm-sweep'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'cron credential repair NOT applied (%).', SQLERRM;
END $$;
