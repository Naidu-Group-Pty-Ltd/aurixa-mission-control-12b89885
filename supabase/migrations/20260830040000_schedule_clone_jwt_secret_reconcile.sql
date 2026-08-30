-- @asserts cron:clone-jwt-secret-reconcile
--
-- Schedule the per-clone signing-key repair.
--
-- `JWT_SECRET` is the one secret a clone's own backend is the only possible
-- source for. The clone's custom auth mints Supabase access tokens itself and
-- the clone's own project validates them, so the key can never be inherited
-- from the prime (that would let the clone mint tokens the PRIME's database
-- accepts, for any subject and any role) and can never be generated (PostgREST
-- validates against the project's own key, so a random value produces tokens
-- rejected by the very database they are for).
--
-- Provisioning writes it now. That covers clones provisioned after the capture
-- existed and nothing else: every clone already in the fleet has it missing,
-- and so does any project adopted rather than created here. The documented
-- remedy for those was a person opening the clone's Supabase settings and
-- pasting a signing key into a box — for a value Mission Control can read for
-- itself from the project's own PostgREST config. This job reads it.
--
-- Thirty minutes, not five. This settles: the sweep reads the candidate list
-- and the ledger in bulk and decides from those, so once every clone holds its
-- key a pass is two queries and no Management API call at all — resolving a
-- write target and reading a key are paid for only by clones that need work.
-- And `decideJwtSecretRepair` holds a failed repair for thirty minutes before
-- retrying, so a project whose config the Management API refuses costs two
-- calls an hour rather than sixty.
--
-- The write can only ever reach a clone: the ref comes from
-- `resolveCloneSecretTarget`, which refuses the prime's project, refuses
-- Mission Control's own, and refuses when it cannot tell — and the same ref the
-- key was READ from is the one it is written to, which is what stops this
-- becoming the cross-tenant defect it exists to repair.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, and the URL is the custom domain rather than the lovable.app
-- origin — the two faults that left `agreements-refresh` answering 401 on every
-- run since it was installed (see 20260829100000_fix_agreements_refresh_cron.sql).
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

  PERFORM cron.unschedule('clone-jwt-secret-reconcile')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clone-jwt-secret-reconcile');

  PERFORM cron.schedule(
    'clone-jwt-secret-reconcile',
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
      v_base || '/hooks/clone-jwt-secret-reconcile'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'clone JWT secret reconcile NOT scheduled (%).', SQLERRM;
END $$;
