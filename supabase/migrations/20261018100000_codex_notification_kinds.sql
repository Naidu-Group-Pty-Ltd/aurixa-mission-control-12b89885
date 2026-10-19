-- @asserts enum:notification_kind
--
-- Three alarms the Codex security pipeline raises (src/server/codex-scan-alerts.server.ts,
-- src/server/codex-finding-sla.server.ts). Until now it raised none: a nightly
-- scan could find a committed service-role key and nobody heard about it until
-- they opened /security/scans.
--
-- `codex_findings_detected` -- a finished scan of Prime or a clone found a new
-- critical finding, a newly exposed credential, a high-or-critical finding that
-- came back after it was resolved, or a merged fix that did not remove its
-- finding. One per scan.
--
-- `codex_scanner_failing` -- a scanner has failed three scans of the same
-- repository in a row, or the scans themselves have. Raised once, at the third.
--
-- `codex_findings_overdue` -- the daily count of open findings past the
-- response time for their severity, with the oldest named.
--
-- Their own values rather than `security_finding_created` or
-- `remediation_failed`: `notification_preferences.muted_kinds` is keyed on this
-- enum, so a kind shared between two meanings is a mute that silences both.
--
-- ALTER TYPE lives in its own migration on purpose: a new enum value cannot be
-- added and used in the same transaction.
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'codex_findings_detected';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'codex_scanner_failing';
ALTER TYPE public.notification_kind ADD VALUE IF NOT EXISTS 'codex_findings_overdue';
