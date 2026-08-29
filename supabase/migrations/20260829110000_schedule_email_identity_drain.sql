-- @asserts cron:email-identity-drain
--
-- Schedule the per-clone email identity drain.
--
-- Every other provisioning pipeline here has one — deployment, backend, edge,
-- cascade, entitlement, voice — and email identity did not. An identity waiting
-- on DNS propagation therefore sat still until a person reopened the clone's
-- page and pressed Advance. That is how a clone ends up registered, with its
-- records installed and its domain verified, and still holding no key: one
-- click short of the mail outage the feature exists to end.
--
-- Five minutes, not one. A pass that acts is several Resend calls and possibly
-- a Cloudflare write, DNS propagation is measured in minutes rather than
-- seconds, and `decideEmailIdentitySweep` holds a failed identity for thirty
-- minutes before retrying — so a permanent misconfiguration costs a handful of
-- calls an hour instead of sixty.
--
-- The drain ADVANCES and never STARTS: it acts only on a row that already
-- carries a `resend_domain_id`, because registering a sending domain chooses a
-- hostname and a region and creates a resource at Resend, which is an
-- operator's decision and not a sweep's.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, and the URL is the custom domain rather than the lovable.app
-- origin — the two faults that left `agreements-refresh` answering 401 on
-- every run since it was installed (see
-- 20260829100000_fix_agreements_refresh_cron.sql). `check-cron-auth.mjs` now
-- fails CI on either.

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

  PERFORM cron.unschedule('email-identity-drain')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'email-identity-drain');

  PERFORM cron.schedule(
    'email-identity-drain',
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
      v_base || '/hooks/email-identity-drain'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'email identity drain NOT scheduled (%).', SQLERRM;
END $$;
