-- @asserts cron:fleet-migration-drain-5min
-- Schedule /hooks/fleet-migration-drain, every five minutes.
--
-- WHY A SECOND CADENCE. `20260827070000_schedule_fleet_migration_sync.sql` set
-- the sweep at thirty minutes and said why:
--
--   THIRTY MINUTES, not one. Nothing here is queue-draining: a clone's schema
--   does not change between ticks, and there is no user waiting on the next one.
--
-- That was true when it was written. Oversized seeds made it false for one
-- case. A clone part-way through a chunked seed IS a queue being drained:
-- measured 20 Sep 2026 by running this repository's own `readSeedShape` and
-- `chunkSeedStatements` over the prime's
-- `20261203000000_seed_template_library_v14_tier_separation.sql` (41,678,125
-- bytes, 543 rows), the seed is 45 statements at the 1 MB ceiling. Each takes
-- seconds to send, a 45-second invocation carries about two dozen, and the
-- remainder waited half an hour for the next tick. Four such seeds were
-- outstanding across the fleet, so the arithmetic was days.
--
-- WHAT IT IS NOT. It is not a fix for the prefix a resumed pass re-reads.
-- GitHub's blob endpoint ignores `Range` (measured: HTTP 200 carrying the full
-- `Content-Length`, no `Accept-Ranges`), so a resumed pass does stream the
-- whole body and discard the statements it already sent — and that costs about
-- 2.4 seconds of a 45-second budget at the ~17 MB/s the production egress
-- measures, against ~1.7 seconds for each statement it then sends. Roughly 5%
-- of a pass. The cadence was the other 95%.
--
-- CHEAP WHEN THERE IS NOTHING IN FLIGHT. The drain door asks `clone_backends`
-- whether any row carries a chunk cursor, before it spends anything, and
-- returns if none does — one indexed select, no GitHub round
-- trip, not even the free one to `/rate_limit`, and no write. A fleet with no
-- seed in flight pays 288 of those a day and nothing else.
--
-- IT CAN REACH NO CLONE THE SWEEP CANNOT. The mode narrows an already-eligible
-- set; `migrationEligibility` runs first and is untouched. So this schedule
-- grants no new authority — it only stops a clone already being served from
-- waiting thirty minutes between statements.
--
-- ITS OWN ROUTE, NOT A MODE IN THE BODY. `check-cron-coverage` refuses two jobs
-- pointing at one hook, correctly: that is what a rescheduled job under a new
-- name looks like when nobody retired the old one, and nothing in `cron.job`
-- could tell the two apart. Both doors call one handler, so the auth, the
-- allowance and the shape of the answer cannot drift between cadences.
--
-- THE SECRET IS READ INSIDE THE COMMAND, for the reason the sweep's own
-- migration gives: a rotation needs no reschedule, and a missing secret fails
-- as a 401 in `net._http_response` rather than as a job that silently declines
-- to schedule.
--
-- Idempotent: re-running leaves an existing vault-reading job exactly as it is.

DO $$
DECLARE
  v_base TEXT;
BEGIN
  v_base := COALESCE(
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'public_app_url' LIMIT 1),
    NULLIF(current_setting('app.settings.public_app_url', true), ''),
    'https://mission-control.aurixasystems.com.au'
  );
  v_base := rtrim(v_base, '/');

  -- fleet-migration-drain-5min -> /hooks/fleet-migration-drain  (*/5 * * * *)
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
     WHERE jobname = 'fleet-migration-drain-5min' AND command LIKE '%vault.decrypted_secrets%'
  ) THEN
    PERFORM cron.unschedule('fleet-migration-drain-5min')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fleet-migration-drain-5min');
    PERFORM cron.schedule(
      'fleet-migration-drain-5min',
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
        v_base || '/hooks/fleet-migration-drain'
      )
    );
    RAISE NOTICE 'scheduled % against %', 'fleet-migration-drain-5min', v_base;
  END IF;
END $$;
