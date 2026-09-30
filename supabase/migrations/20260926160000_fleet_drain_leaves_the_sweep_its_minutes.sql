-- @asserts cron:fleet-migration-drain-5min
--
-- The drain keeps its five-minute cadence and gives up the two minutes the
-- sweep already owns, so two fleet passes never run at once.
--
-- WHAT WAS WRONG. `fleet-migration-sync-30min` fires at :00 and :30 and
-- `fleet-migration-drain-5min` fired every five minutes — so on the hour and
-- the half hour BOTH fired, in the same pg_net batch, and each claimed a
-- different clone. When both clones were part-way through a chunked seed, two
-- passes were streaming a ~41 MB file and holding a window of statements in
-- the same Worker, whose isolate has 128 MB for every request it is serving.
--
-- MEASURED 26 Sep 2026 on `net._http_response`, which keeps six hours. In
-- every stretch of the day when a lone pass fitted its isolate, the only fleet
-- passes that died were ones that shared a minute:
--
--   * every lone drain tick answered 200 — 10:10 to 13:25, 13:35 to 13:55,
--     14:05, and every tick from 15:35, once the seed window (Mission Control
--     #292) bounded one pass to ~21 MB of held statements;
--   * the paired ticks at 13:30, 14:00 and 15:30 each came back as two
--     `502 Internal server error`s — the shape of an isolate killed for
--     memory, with nothing logged;
--   * the paired ticks from 10:30 to 13:00, and at 16:00, answered 200 twice.
--
-- So sharing a minute is not always fatal — it turns on what the two passes
-- happen to be holding when they overlap — but it is the only condition under
-- which a pass that fits alone has died. 15:30, on #292's code, is the clearest
-- case: the two clones' own Postgres logs put the last statement of each pass
-- at 15:31:17.8 and 15:31:18.1, two passes ending in the same instant, which is
-- one isolate going rather than two passes failing. Both claims were left
-- standing, so the 15:35 drain skipped both clones as `provisioning_in_flight`.
-- (14:10 to 15:25 is left out on purpose: between the 90 s budget going live
-- and the window going live, lone passes died too, so that stretch says nothing
-- about pairing either way.)
--
-- WHY THE DRAIN MOVES AND NOT THE SWEEP. The drain serves only clones with a
-- seed in flight, and the sweep serves everything eligible, those included —
-- so at :00 and :30 the drain was a second worker on a queue the sweep was
-- already draining. Dropping those two ticks takes no clone out of reach. It
-- does give up the second pass those two minutes carried when the pair
-- survived — at 16:00 it advanced three clones where the sweep alone would have
-- advanced one or two — and that is the price, paid knowingly: ten drain ticks
-- an hour instead of twelve, against never again losing both passes and both
-- claims in one instant. The gap either side is five minutes, against a pass
-- bounded by its 90 s budget and its request's 150 s HTTP patience
-- (`20260922150000_fleet_sync_http_patience.sql`), so no pass outlives its slot
-- into the other's. `fleetDrainCadence.test.ts` reads both schedules from the
-- migrations and asserts exactly that relation.
--
-- ONLY THE SCHEDULE MOVES. `cron.alter_job` leaves the job's id, its command
-- — the URL, the vault-read secret, the 150 s patience — and its run history
-- exactly as they are, so this cannot re-point the job or drop the secret
-- lookup, and the job keeps its name, which every `@asserts` line, the cron
-- coverage check and the drift alarm know it by.
--
-- ASSERTED BY EFFECT. The guard reads the stored SCHEDULE: a job still on
-- `*/5` is moved, a job already on the new list is left alone, and a job an
-- operator has set to anything else is left alone and named, because
-- overwriting a hand-set schedule would undo a decision this migration knows
-- nothing about.

DO $$
DECLARE
  v_job RECORD;
  v_new CONSTANT TEXT := '5,10,15,20,25,35,40,45,50,55 * * * *';
BEGIN
  SELECT jobid, schedule INTO v_job
    FROM cron.job
   WHERE jobname = 'fleet-migration-drain-5min';

  IF NOT FOUND THEN
    RAISE NOTICE 'fleet drain: no fleet-migration-drain-5min job to move';
  ELSIF v_job.schedule = v_new THEN
    RAISE NOTICE 'fleet drain: already off the sweep''s minutes';
  ELSIF v_job.schedule = '*/5 * * * *' THEN
    PERFORM cron.alter_job(v_job.jobid, schedule := v_new);
    RAISE NOTICE 'fleet drain: moved off :00 and :30 (%)', v_new;
  ELSE
    RAISE NOTICE 'fleet drain: schedule % was set by hand, left alone', v_job.schedule;
  END IF;
END $$;
