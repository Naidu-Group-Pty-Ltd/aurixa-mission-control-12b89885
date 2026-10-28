-- @asserts none:changes what two foreign keys do when their run is deleted; no table, column, function, cron job or row is created, and pg_constraint is not observable through PostgREST
--
-- The daily purge would start failing on 28 Jan 2027, and take eleven other
-- purges down with it.
--
-- `purge_log_tables()` (20260826010000, cron `purge-log-tables-daily`, 03:15
-- UTC) deletes `module_detection_runs` completed more than 180 days ago. Two
-- foreign keys point at that table with no ON DELETE, so Postgres refuses the
-- delete while either still points at a run it would remove:
--
--   * `modules_detection_run_id_fkey`: a module records the run that last
--     shaped it (20260423181712).
--   * `module_detection_runs_previous_run_id_fkey`: each run records the run
--     before it (20260423181712).
--
-- Measured 28 Oct 2026, read only: the three runs that exist all completed on
-- 31 Jul 2026, and 81 and 53 of the 135 modules point at two of them. They
-- become eligible on 27 Jan 2027 at 23:25 UTC, so the purge at 03:15 on 28 Jan
-- raises 23503. The purge is one function in one transaction, so the failure
-- rolls back every table it trims that day: ai_usage_log, audit_log,
-- cascade_events and the rest, and pg_cron's own run log. It fails again every
-- day after, for as long as a module points at a purged run. A run detected
-- today makes the second key bite the same day, since the new run records the
-- 31 Jul run as its previous one.
--
-- Every other foreign key into a table this function purges already answers a
-- delete (ON DELETE CASCADE or SET NULL, read the same day), so these two are
-- the whole of it.
--
-- ON DELETE SET NULL is what deleting a run from the History panel already
-- does to its modules: they are unlinked. A module whose run is purged keeps
-- its shape and its backend fields, and is detected again before its next
-- publication: with D19 (aurixa-mission-control#388), publishing a module with
-- no run is refused by name, and a library entry keeps the commit it was
-- approved at, copied when it was published. A run whose previous run is
-- purged keeps everything but that link. Both columns are indexed (idx_modules_detection_run_id,
-- idx_module_detection_runs_previous_run_id), so the purge does not scan
-- either table.
--
-- Re-runnable: each key is dropped by name if present and added back.

ALTER TABLE public.modules
  DROP CONSTRAINT IF EXISTS modules_detection_run_id_fkey;
ALTER TABLE public.modules
  ADD CONSTRAINT modules_detection_run_id_fkey
  FOREIGN KEY (detection_run_id) REFERENCES public.module_detection_runs(id)
  ON DELETE SET NULL;

ALTER TABLE public.module_detection_runs
  DROP CONSTRAINT IF EXISTS module_detection_runs_previous_run_id_fkey;
ALTER TABLE public.module_detection_runs
  ADD CONSTRAINT module_detection_runs_previous_run_id_fkey
  FOREIGN KEY (previous_run_id) REFERENCES public.module_detection_runs(id)
  ON DELETE SET NULL;
