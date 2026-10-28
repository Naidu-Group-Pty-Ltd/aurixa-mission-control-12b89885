-- @asserts cron:airtable-waitlist-sync
--
-- The Airtable waitlist sync runs every six hours, not every hour.
--
-- Measured 28 Oct 2026, `airtable-waitlist-sync` ran at 17 minutes past
-- every hour: 48 runs in the 48 hours `cron.job_run_details` keeps (26 Oct
-- 06:17 to 28 Oct 05:17 UTC). Each run reads four tables of base
-- `apptyShYE0yzL4IGB` through the Lovable Airtable connector, 100 records a
-- page (`airtable-sync.server.ts`), so it makes at least four Airtable
-- requests. Hourly, that is at least 96 a day and 2,880 in a thirty-day
-- month, all of it drawn from the workspace's monthly API allowance. Every
-- six hours, it is at least 16 a day and 480 a month.
--
-- What waits longer: the sync is the backfill and the Stage 2 and Stage 3
-- progress feed. A fresh application is forwarded by the website's Make
-- scenarios to /api/public/leads/capture, which no schedule touches. A Stage 2
-- answer or a Stage 3 booking now reaches the console, and raises its stage
-- email, up to six hours after Airtable records it, inside the 72 hours
-- `LEAD_STAGE_EMAIL_MAX_AGE_HOURS` allows. The newest row in `waitlist_leads`
-- was written 30 Aug 2026, and none in the 30 days before this was measured.
--
-- Only the schedule changes. `cron.alter_job` keeps the job's id, its run
-- history and the command production runs, which 20260829100000 restated. A
-- missing job raises rather than passing: the queue would record a migration
-- that changed nothing as applied.

do $airtable$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid from cron.job where jobname = 'airtable-waitlist-sync';
  if v_jobid is null then
    raise exception 'airtable-waitlist-sync is not scheduled (20260829100000 schedules it)';
  end if;
  perform cron.alter_job(v_jobid, schedule := '17 */6 * * *');
end
$airtable$;
