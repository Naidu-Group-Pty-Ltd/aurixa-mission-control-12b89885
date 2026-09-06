-- @asserts column:clone_api_keys.delivered_project_ref
-- @asserts column:clone_api_keys.delivered_env_at
-- @asserts cron:clone-secrets-reconcile
--
-- Two things, for one fault: a clone's function environment did not hold what
-- belongs to the clone.
--
-- 1. WHERE A KEY WAS DELIVERED. Every clone is issued a Mission Control API
--    key at creation, hashed here and committed to the clone's repository as
--    `.aurixa/credentials.json` — a file nothing reads. What reads the key is
--    the prime's edge functions, through `MISSION_CONTROL_CLONE_API_KEY` in
--    their environment, which nothing ever wrote: measured 6 Sep 2026, every
--    key had `last_used_at` NULL. The link step now writes the environment
--    and records WHICH project it delivered to, on the key row, so a repair
--    pass can tell "linked" from "minted once, delivered nowhere" without
--    guessing — and never rotates a key that is already delivered.
--
-- 2. THE SWEEP. Twice an hour, offset from the signing-pair sweep: the
--    clone-owned secrets (reset and CSRF peppers, the VAPID pair — mirrored
--    in the clone's own vault so the pass re-asserts rather than rotates),
--    the Mission Control link, and the derived deployment config (public
--    URL, WebAuthn relying party, web-push host), re-computed from the
--    clone's CURRENT origins so a domain going live is reflected.
--
-- Authentication is the vault lookup INSIDE the command string, evaluated on
-- each run, and the URL is the custom domain rather than the lovable.app
-- origin. `check-cron-auth.mjs` fails CI on either.

ALTER TABLE public.clone_api_keys
  ADD COLUMN IF NOT EXISTS delivered_project_ref text,
  ADD COLUMN IF NOT EXISTS delivered_env_at timestamptz;

COMMENT ON COLUMN public.clone_api_keys.delivered_project_ref IS
  'The Supabase project whose function environment this key was written to as MISSION_CONTROL_CLONE_API_KEY. Null for keys that only ever reached the repository file.';
COMMENT ON COLUMN public.clone_api_keys.delivered_env_at IS
  'When the environment write succeeded. A key with a project ref and no stamp was minted and never delivered; the next pass replaces and revokes it.';

CREATE INDEX IF NOT EXISTS clone_api_keys_delivery_idx
  ON public.clone_api_keys (clone_id, delivered_project_ref)
  WHERE revoked_at IS NULL;

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

  PERFORM cron.unschedule('clone-secrets-reconcile')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clone-secrets-reconcile');

  PERFORM cron.schedule(
    'clone-secrets-reconcile',
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
      v_base || '/hooks/clone-secrets-reconcile'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'clone secrets reconcile NOT scheduled (%).', SQLERRM;
END $$;
