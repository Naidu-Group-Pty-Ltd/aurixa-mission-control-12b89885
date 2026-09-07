-- @asserts cron:fleet-secret-forward-reconcile
--
-- Schedule the FLEET credential forward — the half that has never existed.
--
-- `prime_secret_forwards` is read by `runBackendProvisioning` and by nothing
-- else. So marking a name `inherit` reaches every clone this platform creates
-- FROM THEN ON, and no clone that already exists. The per-clone decision beside
-- it reports that same name as `already_fleet_wide` — "fleet policy already
-- forwards this name to every clone" — which is a true statement about
-- provisioning and a false one about the fleet.
--
-- Measured 7 Sep 2026: the five Didit names were marked `inherit` fleet-wide
-- and read `missing` on all three clones, and identity verification on each of
-- them refused as unconfigured. Nothing anywhere reported a problem.
--
-- The remedy that existed was `backend-provisioning-repair`: a whole-engine
-- convergence pass, minutes of vendor calls against a live tenant, refused
-- outright unless the backend is `ready`. Two of the three clones were
-- mid-migration at the time and could not have taken one. Adding a fleet
-- credential is an ordinary act and needed an ordinary lever.
--
-- Thirty minutes and offset from the per-clone sweep, which runs at :00/:30 —
-- the two would otherwise contend for the same clone's secret ledger and the
-- same Management API. This settles the same way: the ledger is the filter, so
-- once a clone holds fleet policy a pass is two queries and no Management API
-- call. A `failed` ledger row is deliberately NOT filtered out — that is the
-- state a retry exists for.
--
-- The write can only ever reach a clone: the ref comes from
-- `resolveCloneSecretTarget`, which refuses the prime's project, refuses
-- Mission Control's own, and refuses when it cannot tell which is which. What
-- may travel is decided in `cloneSecretForward.pure.ts`, and for the class
-- refusals by the SAME function the per-clone path calls — a signing key or
-- half a CAPTCHA pair is refused here for the same reason and by the same
-- code, rather than by a second copy that agrees today.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, and the URL is the custom domain rather than the lovable.app
-- origin. `check-cron-auth.mjs` fails CI on either.

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

  PERFORM cron.unschedule('fleet-secret-forward-reconcile')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fleet-secret-forward-reconcile');

  PERFORM cron.schedule(
    'fleet-secret-forward-reconcile',
    '15,45 * * * *',
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
      v_base || '/hooks/fleet-secret-forward-reconcile'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'fleet secret forward reconcile NOT scheduled (%).', SQLERRM;
END $$;
