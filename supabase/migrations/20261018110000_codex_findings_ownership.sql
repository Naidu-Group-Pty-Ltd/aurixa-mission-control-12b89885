-- @asserts column:codex_findings.assigned_to
-- @asserts column:codex_findings.assigned_at
--
-- Codex Security: who owns a finding.
--
-- A finding had no owner. The findings explorer could say a critical had been
-- open for forty days but not whose it was, so "someone is looking at it"
-- (`triaging`) was the closest thing to accountability, and it named nobody.
--
-- `assigned_to` is the person responsible for the next step; `assigned_at`
-- when that started, so the explorer can tell an old finding newly picked up
-- from one that has sat with the same person for weeks. Assignment is written
-- by the triage server function after its own admin check
-- (src/lib/codex-findings.functions.ts), and recorded on the finding's history.
--
-- Response times (how long a finding of each severity may stay open) are a
-- policy in src/lib/codex-finding-sla.ts, not a column: they apply to every
-- finding at once and change without a migration.

ALTER TABLE public.codex_findings
  ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS codex_findings_assigned_to_idx
  ON public.codex_findings(assigned_to);
