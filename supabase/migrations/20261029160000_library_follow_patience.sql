-- @asserts cron:module-library-follow-15min
--
-- The library follow's hook is given two and a half minutes, not ten
-- (docs/DELIVERY_SYSTEM_PLAN.md §16).
--
-- Measured 29 Oct 2026, on the first follow ticks after 20261029140000
-- scheduled the hook with ten minutes' patience. pg_net sends a batch of
-- requests and starts the next batch only once every request of this one has
-- answered. The follow invocations of 14:19 and 14:49 UTC were cut 68 and 71
-- seconds in (a 502), and for those seconds no other cron hook was sent: the
-- requests the 14:50 jobs queued went out at 14:50:14. A follow invocation
-- that hung rather than died would have held every cron hook in Mission
-- Control for ten minutes. The 14:49 invocation had detected, written and
-- approved the whole catalogue 68 seconds in, and was publishing an entry
-- every 87 ms when it was cut, so the whole of a follow is under two
-- minutes; a settle whose caller stopped waiting is finished by a later tick
-- (`libraryFollow.pure.ts`). 150 seconds, the fleet-migration drain's
-- patience, is the follow's too.
--
-- The job is scheduled again exactly as 20261029140000 scheduled it, but for
-- `timeout_milliseconds`.

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

  PERFORM cron.unschedule('module-library-follow-15min')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'module-library-follow-15min');

  PERFORM cron.schedule(
    'module-library-follow-15min',
    '4,19,34,49 * * * *',
    format(
      $f$SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type','application/json',
          'Lovable-Context','cron',
          'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret' LIMIT 1)
        ),
        body := jsonb_build_object('source','pg_cron'),
        timeout_milliseconds := 150000
      )$f$,
      v_base || '/hooks/module-library-follow'
    )
  );
EXCEPTION WHEN OTHERS THEN
  -- Same posture as every other scheduling block here: a deployment without
  -- pg_cron must not fail the whole migration. The `cron:` assertion above is
  -- what says whether the job exists.
  RAISE WARNING 'module-library-follow schedule NOT applied (%).', SQLERRM;
END $$;
