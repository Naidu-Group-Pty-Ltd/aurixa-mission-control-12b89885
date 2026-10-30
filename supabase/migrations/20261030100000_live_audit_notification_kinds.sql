-- @asserts enum:notification_kind
--
-- The live audit's three alarms (src/server/live-audit-alerts.server.ts).
--
-- `live_audit_findings_detected` -- a finished live audit of Prime found a new
-- critical or high defect, or one it had resolved came back, or one a merged
-- fix should have removed is still there. One per run.
--
-- `live_audit_run_failed` -- a live audit failed, or could not be dispatched,
-- three runs in a row. Raised once, at the third.
--
-- `live_audit_fix_ready` -- Claude opened a fix pull request for a live-audit
-- defect. A person merges those while the audit is being proven on Prime, so
-- somebody has to hear that one is waiting.
--
-- Their own values rather than the Codex kinds: `notification_preferences.
-- muted_kinds` is keyed on this enum, and a kind shared between two pipelines
-- is a mute that silences both.
--
-- ALTER TYPE lives in its own migration: a new enum value cannot be added and
-- used in the same transaction.
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'live_audit_findings_detected';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'live_audit_run_failed';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'live_audit_fix_ready';
