-- @asserts cron:backend-catchup
--
-- Schedule the backend catch-up that only ever ran inside a cascade.
--
-- `requestBackendSyncAfterCascade` already knows exactly what a clone's
-- backend owes: it diffs the PRIME between two of its own revisions and queues
-- the stale edge functions and any migrations. It is not theoretical — eight
-- `edge_function_deploy` runs have succeeded through it, the last at 04:00 UTC
-- on 4 September 2026.
--
-- It had two callers, the cascade engine and the merge drain, and BOTH fire
-- only when a cascade MERGES. A cascade merges only when the clone
-- repository's own CI goes green, and since 05:35 UTC on 4 September GitHub
-- has started no job on any of the three private clone repositories. So no
-- clone has received a backend change since — silently, while the cascade
-- opened its pull requests on schedule and recorded zero errors against
-- itself.
--
-- The deploy never needed the clone's CI. It reads the PRIME's repository and
-- writes to the clone's Supabase project through the Management API; the
-- clone's own Actions minutes have nothing to do with it. The catch-up was
-- simply chained to an event that can stop happening, which is the same shape
-- as the fleet secret forward one layer up: an ordinary act with no ordinary
-- lever.
--
-- Four rules, and the first is the one that would do damage if it were wrong.
-- The sweep PLANS and never advances `last_synced_sha`: that column means the
-- clone's repository CONTENT is at that prime revision, and this deploys
-- FUNCTIONS. Advancing it would tell the next cascade the files are current
-- and skip them, leaving the clone running new functions against old content.
-- A clone with a NULL baseline owes everything, which is the planner's own
-- safe reading and is never invented here. It settles, because the planner
-- widens an open run rather than queuing a second one. And a read that FAILED
-- is never a clone that owes nothing — a rate limit on the prime read plans
-- nothing at all rather than recording the fleet as current.
--
-- Twenty past and ten to, offset from the fleet secret forward at :15/:45 and
-- the per-clone secret sweep at :07/:37, so the three do not contend for the
-- same GitHub installation quota.
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

  PERFORM cron.unschedule('backend-catchup')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'backend-catchup');

  PERFORM cron.schedule(
    'backend-catchup',
    '20,50 * * * *',
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
      v_base || '/hooks/backend-catchup'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration.
  RAISE WARNING 'backend catch-up NOT scheduled (%).', SQLERRM;
END $$;
