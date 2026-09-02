-- @asserts cron:clone-secret-forward-reconcile
--
-- Schedule the per-clone credential forward.
--
-- `prime_secret_forwards` is FLEET policy applied at PROVISIONING time: a name
-- marked `inherit` reaches every clone this platform ever creates, and only
-- while it is being created. Both halves are wrong for a credential one tenant
-- should hold and the next should not, wanted on a clone provisioned days ago.
-- GoHighLevel is the case: 36 of the prime's edge functions import its
-- resolver and the resolver THROWS rather than degrading, so a clone without
-- the key answers 500 on every one of them — while a GHL sub-account is a
-- tenant's own commercial relationship, so marking it `inherit` fleet-wide
-- decides for the next tenant a question that is theirs.
--
-- A row in `clone_secret_forwards` IS the authorisation, so applying it should
-- not depend on somebody remembering to press a button — and a clone
-- provisioned before the row existed is covered only because of this job.
--
-- Thirty minutes, not five. This settles: the ledger is the filter, so once a
-- clone holds its authorised names a pass is two queries and no Management API
-- call at all. A `failed` ledger row is deliberately NOT filtered out — that is
-- the state a retry exists for.
--
-- The write can only ever reach a clone: the ref comes from
-- `resolveCloneSecretTarget`, which refuses the prime's project, refuses
-- Mission Control's own, and refuses when it cannot tell which is which. What
-- may travel at all is decided by `cloneSecretForward.pure.ts`, where a class
-- refusal (a project signing key, half a CAPTCHA pair) outranks every row and
-- a deliberate fleet `inherit = false` is never overridden per clone.
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

  PERFORM cron.unschedule('clone-secret-forward-reconcile')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clone-secret-forward-reconcile');

  PERFORM cron.schedule(
    'clone-secret-forward-reconcile',
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
      v_base || '/hooks/clone-secret-forward-reconcile'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'clone secret forward reconcile NOT scheduled (%).', SQLERRM;
END $$;
