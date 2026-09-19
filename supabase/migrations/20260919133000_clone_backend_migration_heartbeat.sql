-- @asserts column:clone_backends.migration_heartbeat_at

-- A HEARTBEAT HAS TO BE OWNED BY THE CLAIM THAT BEATS IT.
--
-- The fleet migration lane reclaims a claim that is old AND quiet, so that a
-- leaked claim costs minutes rather than the full half-hour cadence. The first
-- version read `updated_at` for the "quiet" half, reasoning that
-- `onStatementDone` writes the chunk cursor on every statement and the table's
-- trigger bumps `updated_at` on every write.
--
-- That reasoning is wrong, and wrong in the direction that matters.
-- `updated_at` is ROW-wide. Every writer of `clone_backends` refreshes it, and
-- one of them is the reference-data lane, which claims and releases the same
-- `ready` backend through `reference_sync_started_at` and never looks at
-- `worker_started_at` at all.
--
-- The two lanes' schedules make it certain rather than unlucky. The fleet sync
-- runs `*/30` — :00 and :30 — and the reference sync was moved to
-- `13,28,43,58` in the change immediately before this one, so it writes two
-- minutes before every fleet pass. A dead migration claim on any clone that
-- lane touches is therefore ALWAYS "recent" when the reclaim looks, and sticks
-- for ever: strictly worse than the thirty-minute window it replaced.
--
-- So this column is the fleet lane's own. It is stamped when the claim is
-- taken and again on every statement the replay sends, and nothing else writes
-- it. A claim that is old and whose OWN heartbeat is old is abandoned; a claim
-- whose heartbeat is moving is alive, whatever else has touched the row.
--
-- NULL on every existing row. The reclaim treats NULL as stale, gated by the
-- claim's age, which is exactly the behaviour those rows had before this
-- column existed.

alter table public.clone_backends
  add column if not exists migration_heartbeat_at timestamptz;

comment on column public.clone_backends.migration_heartbeat_at is
  'Liveness of the FLEET MIGRATION lane''s claim on this row: stamped when the '
  'claim is taken and on every statement the replay sends. Owned by that lane '
  'alone — `updated_at` cannot serve, because every writer of this table '
  'refreshes it and the reference-data lane writes the same row minutes before '
  'each fleet pass.';
