-- @asserts cron:backend-provisioning-drain-1min
--
-- Give the backend provisioning drain enough HTTP patience to finish the step
-- it is in.
--
-- WHAT WAS WRONG. `backend-provisioning-drain-1min` was scheduled with
-- `timeout_milliseconds := 60000` while the drain's own work budget was
-- 50,000 ms, measured from AFTER its reclaim sweep and checked BETWEEN units,
-- never inside one. That left about ten seconds for the unit a pass happens to
-- be inside when the budget runs out, and several units are longer than that:
-- the repository re-target is a run of GitHub commits, a function-source
-- snapshot is a dozen GraphQL batches, and an edge-function deploy is a
-- server-side bundle. A unit that crossed the sixty-second line was not
-- paused, it was KILLED: pg_net stops waiting, the runtime cancels the
-- request's work once its client disconnects, and the claim is left standing
-- until `isDeadPass` judges it dead at least five minutes later.
--
-- MEASURED on `tutorial-demo-orrimere-c158c7`, 30 Oct 2026: two consecutive
-- passes died in "Re-pointing the clone repository at its own project..."
-- (01:55 and 02:01 UTC, `clone_backend.pass_died`), and the job only finished
-- once it had been re-queued by hand at 02:16 — the backend reached `ready`
-- seventy seconds later. A kill costs a stall of five to fifteen minutes and,
-- where the job has died at that point before, one of its three attempts.
--
-- 150,000 ms is the patience the fleet migration lane was given for the same
-- reason (`20260922150000_fleet_sync_http_patience.sql`) and runs on today:
-- its passes routinely take 75–85 s and have taken 126 s, every one of them
-- heard. It is patience, not a licence: the drain still stops itself at its
-- own budget (`INVOCATION_BUDGET_MS`, derived from `BACKEND_DRAIN_PATIENCE_MS`
-- in `hooks.backend-provisioning-drain.tsx`, which
-- `backendDrainPatience.contract.test.ts` holds in step with this file), so a
-- pass is no longer than before except where the old patience would have
-- killed it. The budget is NOT raised, because pg_net sends a batch of
-- requests and starts the next batch only once every request of this one has
-- answered (see `20261029160000_library_follow_patience.sql`): a pass that ran
-- far longer would slow every other one-minute hook while a clone builds. And
-- so the order this lands in cannot matter: before it is applied, the drain
-- works exactly as it did.
--
-- ASSERTED BY EFFECT, NOT BY CONFIGURATION. Re-running this is a no-op once the
-- stored command carries the larger timeout — the guard reads the COMMAND, so
-- a job reverted by hand is repaired and a job already correct is left exactly
-- as it is. And it rewrites rather than re-composes: the URL and the vault
-- lookup are carried across from whatever is stored, so this migration cannot
-- re-point the job at another host or drop the `cron_secret` resolution.

DO $$
DECLARE
  r RECORD;
  v_new TEXT;
BEGIN
  FOR r IN
    SELECT jobid, jobname, schedule, command
      FROM cron.job
     WHERE jobname = 'backend-provisioning-drain-1min'
       AND command LIKE '%timeout_milliseconds%'
       AND command LIKE '%60000%'
  LOOP
    v_new := replace(r.command, 'timeout_milliseconds := 60000', 'timeout_milliseconds := 150000');

    IF v_new = r.command THEN
      RAISE NOTICE 'backend drain patience: % carries no 60000 timeout literal, left alone', r.jobname;
      CONTINUE;
    END IF;

    PERFORM cron.unschedule(r.jobname);
    PERFORM cron.schedule(r.jobname, r.schedule, v_new);
    RAISE NOTICE 'backend drain patience: % rescheduled at 150000 ms', r.jobname;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  -- A deployment without pg_cron must not fail the whole migration. The
  -- `cron:` assertion above is what says whether the job exists.
  RAISE WARNING 'backend drain patience NOT applied (%).', SQLERRM;
END $$;
