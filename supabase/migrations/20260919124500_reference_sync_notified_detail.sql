-- @asserts column:clone_reference_syncs.notified_detail

-- "WAS IT FAILING" IS NOT "HAVE WE TOLD ANYONE".
--
-- The change beside this one stops a broken reference table raising an alert on
-- every pass — four times an hour under the new cadence, ~96 a day for one
-- table, which is an alert people mute. It did that by asking whether the
-- PREVIOUS pass recorded the same failure, and that predicate is wrong in a way
-- that is invisible until the day it deploys.
--
-- `clone_reference_syncs` has carried `status = 'failed'` with a reason since
-- long before anything notified at all — the catch recorded the failure and
-- announced nothing, which is the silence the change exists to end. So on the
-- first pass after deployment every one of those rows answers "yes, the same
-- failure as before", and the alert that was owed is suppressed for ever.
--
-- Measured 19 Sep 2026, and these are exactly the two rows the work was
-- motivated by:
--
--   npc-test-76b3b3        aml.sanctions_entries     failed  21,600 rows
--                          23503 sanctions_entries_sync_id_fkey   since 12 Sep
--   npc-client-dashboard   aml.retention_schedules   failed       0 rows
--                          23505 retention_schedules_entity_type_key  since 14 Sep
--
-- Neither has ever produced a notification. Under a status/detail predicate
-- neither ever would.
--
-- The same hole swallows a notice whose INSERT failed: `notifyOperators` logs
-- and returns, so the failure row is written either way and the next pass reads
-- it as proof of a delivery that never happened.
--
-- So the dedupe key is what was DELIVERED, not what was observed. This column
-- holds the `detail` an operator was last actually told about, written only
-- after the notification insert succeeded, and cleared whenever the table
-- stops failing so a recurrence after a repair is news again.
--
-- NULL on every existing row, which is the point: nothing has been delivered
-- for any of them, and the first pass after this lands says so.

alter table public.clone_reference_syncs
  add column if not exists notified_detail text;

comment on column public.clone_reference_syncs.notified_detail is
  'The failure detail an operator was last successfully notified about. Written '
  'only after the notification insert succeeds, and cleared when the table stops '
  'failing. Deduplicating on `status`/`detail` instead would read a failure that '
  'was merely RECORDED as one that was reported.';
