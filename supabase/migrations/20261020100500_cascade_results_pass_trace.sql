-- @asserts column:cascade_results.pass_trace
-- Where a cascade pass was when it stopped, per result row.
--
-- A pass the platform kills leaves nothing on its row but the `pushing` mark
-- it wrote before any work, so the database could say that a pass died and
-- never where. Measured 20 Oct 2026: the CRM line had not finished a pass since
-- 17 Oct, every pass was cut before its first ledger write, and the stage that
-- ran past the platform's wait could not be named (F21 in
-- docs/HANDOFF_2026-10-19_CONTINUED.md). Each remedy for a pass that does not
-- fit inside a tick starts from that answer.
--
-- The engine names each stage as it enters it and the drain writes the list
-- here without waiting on the write (`src/server/cascade/passTrace.pure.ts`).
-- A list that ends without an `outcome` is a pass ended in its last stage.
-- Observability only: nothing reads it to decide anything, a failed write is
-- dropped, and until this migration has run the engine traces nothing.
alter table public.cascade_results
  add column if not exists pass_trace jsonb;

comment on column public.cascade_results.pass_trace is
  'The latest pass''s stages, each with the milliseconds since the pass began, and its outcome where it had one (passTrace.pure.ts). A trace with no outcome is a pass the platform ended in its last stage. Observability only.';
