-- @asserts column:cascade_results.progressed_at
-- When a pass last KEPT progress on a result row.
--
-- The drain judges an event at the attempt ceiling by whether its passes are
-- still getting somewhere: recent progress refunds an attempt, none retires
-- the event (`decideExhaustedEvent`). It read "recent" off the newest
-- `cascade_results.updated_at`. But the engine marks a row
-- `pushing, started_at` before any work, and the `update_cascade_results_updated_at`
-- trigger stamps `updated_at` on every write, so a pass the platform cut
-- before it learned anything still read as converging and was refunded.
-- Measured on 20 Oct 2026: five events for the CRM line, the oldest created
-- 19 Oct 05:32 UTC, sat at attempts 3 and cycled claim, cut, reclaim and
-- refund, while the line completed no pass after 17 Oct (F21 in
-- docs/HANDOFF_2026-10-19_CONTINUED.md).
--
-- This column is written by a pass in exactly two places, which are the two
-- things the drain already counts as progress for a pass that RETURNED
-- (`done > 0 || progressed`):
--
--  - the ledger flush, and only where the ledger it flushes holds an entry
--    the pass did not start with (`ledgerGrew`, by identity: a prepared blob,
--    a settled deletion or hold probe, a variant merge verdict);
--  - the row's settlement, when a pass takes it out of the queue for good
--    (succeeded, pr_opened, skipped or failed), because the event then has
--    one clone fewer to do.
--
-- Nothing else writes it: not the claim, not the `pushing` mark, not the
-- merge drain. A ledger is finite and a row settles once, so the refunds it
-- buys are bounded.
--
-- Additive and nullable: a row no pass has kept anything on is NULL, which
-- the judge reads as "nothing kept". Until this migration has run, the engine
-- writes retry without the stamp and the judge reads no verdict, so neither
-- the pass nor the drain fails on a database that predates it.
alter table public.cascade_results
  add column if not exists progressed_at timestamptz;

comment on column public.cascade_results.progressed_at is
  'When a pass last kept progress on this row: a ledger flush holding an entry it did not start with (ledgerGrew), or the row''s settlement out of the queue. Written only by the cascade engine''s pass; the drain judges an event at the attempt ceiling by the newest value across its rows. NULL: no pass has kept anything on this row.';
