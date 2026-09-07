-- ─────────────────────────────────────────────────────────────────────────────
-- pg_cron's own run log was 55% of this database, and it is what took the
-- instance down.
--
-- `cron.job_run_details` records every scheduled run and prunes NOTHING by
-- default. Measured 6 September 2026, immediately after a five-hour outage:
--
--     rows          590,871
--     table size    590 MB
--     database      1,065 MB      -- so 55% of the whole database
--     net._http_response   500 rows   -- pg_net self-prunes; not a factor
--
-- Mission Control runs roughly ten scheduled jobs a minute across the fleet
-- (~14,400 rows a day), so this grows without bound and nothing reads it past
-- the last day: the ONLY reader is `cron_delivery_health`, which the health
-- endpoint calls with `_since_hours := 24`.
--
-- What it cost: the instance ran out of disk IO budget. Its own /api/health
-- answered `database_unavailable` for five hours with the failure time
-- climbing 15s -> 22.7s -> 27.9s -> no response, because autovacuum and every
-- checkpoint were grinding through 590 MB of log rows nothing reads. It could
-- not recover unaided, because the jobs kept firing and kept writing. The
-- instance was upgraded Tiny -> Mini with an 8 GB disk to get it back; this is
-- the other half, and without it the same wall arrives again on the new tier.
--
-- The backlog goes in one pass rather than in batches ON PURPOSE. There is no
-- index on `start_time`, so every batch would re-scan the whole table: twelve
-- scans of 590 MB costs far more IO than the single scan a whole-table delete
-- pays. The hourly job that follows operates on ~29,000 rows, where a scan is
-- trivial and an index would only add write cost to a table pg_cron appends to
-- constantly.
--
-- Retention is TWO days against a reader that looks back one. Bounded at
-- 100,000 rows a run so a future backlog (a cron storm, a paused sweep) drains
-- steadily instead of arriving as one spike on a live database — the rule the
-- provisioning drains already follow.
--
-- @asserts cron:mc-purge-cron-history
-- ─────────────────────────────────────────────────────────────────────────────

-- The backlog, once.
DELETE FROM cron.job_run_details
 WHERE start_time < now() - interval '2 days';

-- And keep it that way. `cron.schedule` upserts by name, so re-applying is a
-- no-op rather than a second job doing the same work.
SELECT cron.schedule(
  'mc-purge-cron-history',
  '23 * * * *',
  $$
  WITH doomed AS (
    SELECT ctid
      FROM cron.job_run_details
     WHERE start_time < now() - interval '2 days'
     LIMIT 100000
  )
  DELETE FROM cron.job_run_details d
   WHERE d.ctid IN (SELECT ctid FROM doomed)
  $$
);
