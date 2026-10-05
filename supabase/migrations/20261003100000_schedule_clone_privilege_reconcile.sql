-- @asserts cron:clone-privilege-reconcile
--
-- Schedule the per-clone function-privilege and view-option repair.
--
-- The catalogue clone path wrote every function with `pg_get_functiondef`,
-- which renders the body and nothing about who may EXECUTE it, and Postgres
-- starts a new function callable by PUBLIC. So every engine-built clone held
-- every prime function callable with its anon key, whatever the prime had
-- revoked — measured 3 Oct 2026 with Supabase's own advisor: 238 to 247
-- SECURITY DEFINER functions per clone against the prime's 4, including
-- `cron_service_role_headers`, `bootstrap_cron_vault` and
-- `admin_set_aml_roles_for_user`. Views lost `security_invoker` the same way,
-- because `create or replace view` without options replaces them with none.
--
-- Provisioning now converges both in its grants stage. A clone whose schema was
-- verified before that existed never re-enters introspection, so this job is
-- what reaches the existing fleet, and what catches any later drift.
--
-- Thirty minutes. It settles: once a clone matches the prime a pass is five
-- catalogue reads and no statement. The first pass on a clone is a few hundred
-- GRANT/REVOKE statements and may take two or three ticks; the plan is
-- re-derived each time, so a stopped pass loses nothing.
--
-- It can only ever write to a clone: the ref comes from
-- `resolveCloneSecretTarget`, which refuses the prime's project and Mission
-- Control's own. It never revokes from `service_role`, never touches a function
-- only the clone holds, and never makes less reachable a function the clone's
-- own policies, views or column defaults call.
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

  PERFORM cron.unschedule('clone-privilege-reconcile')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clone-privilege-reconcile');

  PERFORM cron.schedule(
    'clone-privilege-reconcile',
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
        timeout_milliseconds := 60000
      )$f$,
      v_base || '/hooks/clone-privilege-reconcile'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'clone privilege reconcile NOT scheduled (%).', SQLERRM;
END $$;
