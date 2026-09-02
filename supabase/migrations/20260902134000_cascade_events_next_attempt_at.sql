-- @asserts column:cascade_events.next_attempt_at
--
-- When a cascade event may next be claimed.
--
-- The drain claimed any `pending` event at once, so an event that could not
-- run YET was indistinguishable from one that could: the only way to hold one
-- back was to fail it. Two conditions need holding back rather than failing.
--
-- A GitHub rate limit. Measured 2 Sep 2026 at 13:19:50 UTC: event 844df9e5
-- failed for all three clones with "API rate limit exceeded for installation
-- ID 157200201". The limit is a window with a published reset time; the
-- prime commit it carried (79a9cb78) is not wrong, and a `failed` event is
-- never claimed again, so that commit would have reached no clone without a
-- person re-arming the row by hand.
--
-- The invocation budget. A fleet event processes every queued clone in one
-- pass inside a hook pg_net abandons at 60 seconds, so a pass that stops at
-- its budget with clones still queued has to come back on the next tick — at
-- once, not after a stall reclaim, and without spending an attempt on work
-- that was progressing.
--
-- NOT NULL with a default of now(), so the claim is `next_attempt_at <= now()`
-- with no NULL branch — the shape `remediation_runs` and
-- `edge_provisioning_jobs` already use. A filter composed as a PostgREST
-- `.or()` string is the thing this repository's screening worker got wrong,
-- and a column that never needs one cannot repeat it.
alter table public.cascade_events
  add column if not exists next_attempt_at timestamptz not null default now();

comment on column public.cascade_events.next_attempt_at is
  'Earliest moment the drain may claim this event. now() on insert; moved forward by a rate-limit deferral (to the reset the response named) and reset to now() by a pass that paused at its invocation budget. Never in the past by more than the tick that claims it.';

-- The claim reads `status = pending and worker_started_at is null and
-- next_attempt_at <= now()`, oldest first.
create index if not exists idx_cascade_events_claimable
  on public.cascade_events (next_attempt_at, created_at)
  where status = 'pending' and worker_started_at is null;
