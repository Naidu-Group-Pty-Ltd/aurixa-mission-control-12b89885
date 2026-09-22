-- @asserts cron:fleet-migration-sync-30min
-- @asserts cron:fleet-migration-drain-5min
--
-- Give the fleet passes enough HTTP patience to be HEARD.
--
-- WHAT WAS WRONG. `fleet-migration-sync-30min` and its five-minute drain
-- sibling were scheduled with `timeout_milliseconds := 60000`, while
-- `runFleetMigrationSync`'s own wall-clock budget (`FLEET_PASS_BUDGET_MS`) is
-- 45,000 ms of WORK — measured from before the first read, and checked
-- BETWEEN units rather than inside them. So the true duration of a pass is the
-- setup (resolve the prime, list the corpus, read the bodies it has not
-- digested at this commit) PLUS up to 45 s of applying. Sixty seconds leaves
-- roughly fifteen for all of the setup, DNS and TLS, and the setup is the part
-- that grew.
--
-- MEASURED 22 Sep 2026 on `net._http_response`, over the six hours the table
-- retains: EVERY half-hourly sweep — 08:00, 08:30, 09:00, 09:30, 10:00,
-- 10:30, 13:00, 13:30 — came back `status_code NULL` with
-- `Timeout of 60000 ms reached`. Not one scheduled sweep in that window was
-- heard. The only 200s are hand-fired passes.
--
-- WHY IT IS WORSE THAN A SLOW PASS. The request is DELIVERED; it is the
-- RESPONSE that is discarded. So the pass really runs, really claims a
-- backend, really applies a migration or two — and is then torn down before it
-- can write its verdict or release its claim. Three things follow, and all
-- three were observed:
--
--   * `clone_backends.status_detail` goes stale. The CRM clone read
--     "38 migration(s) held back" for hours after the pass that would have
--     written "6" had already run.
--   * `worker_started_at` strands, so the NEXT pass skips that backend as
--     `provisioning_in_flight` until `reclaimStale` frees it five minutes on.
--   * The pass is cut mid-slice, so a clone advances one migration per fire
--     instead of as many as its budget allows.
--
-- This is exactly the trap `SCREENING_EXECUTION.md` names from the other side:
-- **a green cron run is not a delivered request.** Here `cron.job_run_details`
-- says `succeeded` on every one of those fires, because what pg_cron reports
-- on is the SQL that queued the call. The honest signal is
-- `net._http_response.status_code`, and it was NULL every time.
--
-- 150,000 ms is chosen as roughly three times the declared work budget, which
-- is the same ratio the budget itself was picked on. It is patience, not a
-- licence: nothing here lets a pass do more work, because the pass still stops
-- itself at `FLEET_PASS_BUDGET_MS`. A hung pass is bounded by that, and by
-- `reclaimStale` five minutes after it stops beating.
--
-- ASSERTED BY EFFECT, NOT BY CONFIGURATION. Re-running this is a no-op once
-- the stored command already carries the larger timeout — the guard reads the
-- COMMAND rather than a version or a comment, so a job that was reverted by
-- hand is repaired and a job already correct is left exactly as it is. And it
-- rewrites rather than re-composes: the URL and the vault lookup are carried
-- across from whatever is stored, so this migration cannot silently re-point a
-- job at the default host or drop the `cron_secret` resolution.

DO $$
DECLARE
  r RECORD;
  v_new TEXT;
BEGIN
  FOR r IN
    SELECT jobid, jobname, schedule, command
      FROM cron.job
     WHERE jobname IN ('fleet-migration-sync-30min', 'fleet-migration-drain-5min')
       AND command LIKE '%timeout_milliseconds%'
       AND command LIKE '%60000%'
  LOOP
    v_new := replace(r.command, 'timeout_milliseconds := 60000', 'timeout_milliseconds := 150000');

    IF v_new = r.command THEN
      RAISE NOTICE 'fleet patience: % carries no 60000 timeout literal, left alone', r.jobname;
      CONTINUE;
    END IF;

    PERFORM cron.unschedule(r.jobname);
    PERFORM cron.schedule(r.jobname, r.schedule, v_new);
    RAISE NOTICE 'fleet patience: % rescheduled at 150000 ms', r.jobname;
  END LOOP;
END $$;
