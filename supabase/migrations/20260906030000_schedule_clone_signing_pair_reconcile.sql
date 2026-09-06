-- @asserts cron:clone-signing-pair-reconcile
--
-- Schedule the per-clone internal signing PAIR repair.
--
-- Every scheduled job on a clone calls an edge function through
-- `cron_signed_internal_headers`, which signs with the vault's
-- `internal_edge_secret`; the function verifies against `INTERNAL_EDGE_SECRET`
-- in its environment. One secret, two places, and the call works only while
-- they are the same string.
--
-- Provisioning wrote exactly one of them — the environment half, as a random
-- it retained nowhere — so the vault never received it. Measured 6 Sep 2026 on
-- all three clones: the vault held `supabase_url` and nothing else, and
-- `cron.job_run_details` recorded ~13,900 failed runs in 24 hours per clone,
-- every one `internal_edge_secret not configured in vault`. No background job
-- on any clone had ever run.
--
-- Provisioning writes the pair now. This job covers the fleet as it stands and
-- any clone whose environment write failed once: the vault is the side that
-- can be read, so the sweep reads it and re-asserts the environment with the
-- SAME value — convergence, never rotation.
--
-- Thirty minutes. The sweep costs one vault read per clone and writes nothing
-- when both halves already agree; a failed repair is held for thirty minutes
-- before it is retried (`decideSigningPairRepair`).
--
-- The write can only ever reach a clone: the ref comes from
-- `resolveCloneSecretTarget`, which refuses the prime's project, refuses
-- Mission Control's own, and refuses when it cannot tell — and the service-role
-- key placed in the vault is read from that same project, so it is only ever
-- the clone's own.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, and the URL is the custom domain rather than the lovable.app
-- origin — the two faults that left `agreements-refresh` answering 401 on every
-- run since it was installed. `check-cron-auth.mjs` fails CI on either.

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

  PERFORM cron.unschedule('clone-signing-pair-reconcile')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clone-signing-pair-reconcile');

  PERFORM cron.schedule(
    'clone-signing-pair-reconcile',
    '*/30 * * * *',
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
      v_base || '/hooks/clone-signing-pair-reconcile'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'clone signing pair reconcile NOT scheduled (%).', SQLERRM;
END $$;
