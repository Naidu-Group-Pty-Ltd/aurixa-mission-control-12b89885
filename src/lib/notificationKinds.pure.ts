/**
 * The inbox's kind filter, derived from the database's own list of kinds.
 *
 * It was a hand list of 22 kinds in `notifications.tsx`, and the enum kept
 * growing without it: 75 kinds at `7dcd33a`. Measured 27 Oct 2026, it lacked
 * `cascade_blocked`, `remediation_failed` (116 unread),
 * `deployment_bundle_identity` (917 unread) and `clone_ci_attention`, so two
 * of the noisiest kinds in the inbox, and the one that means "this will fail
 * until a person acts", could be neither filtered to nor bulk-cleared. The URL
 * schema was the same list, so a link to one of them fell back to "All kinds".
 *
 * So the list is read from `ALL_NOTIFICATION_KINDS`, the generated enum, and
 * a person's label is kept where one was written. A kind added next year
 * appears in the filter with a readable label derived from its name, rather
 * than waiting for someone to remember this file.
 *
 * Client-safe: pure.
 */
import { ALL_NOTIFICATION_KINDS, type NotificationKind } from "./notificationDisposition";

/**
 * Labels a person wrote, kept verbatim from the hand list they replace. A kind
 * not named here is labelled from its name by `notificationKindLabel`.
 */
export const NOTIFICATION_KIND_LABELS: Readonly<Partial<Record<NotificationKind, string>>> = {
  cascade_started: "Cascade started",
  cascade_completed: "Cascade completed",
  cascade_partial: "Cascade partial",
  cascade_failed: "Cascade failed",
  cascade_awaiting_approval: "Cascade awaiting approval",
  cascade_approved: "Cascade approved",
  cascade_rejected: "Cascade rejected",
  drift_high: "Drift — high",
  drift_medium: "Drift — medium",
  clone_created: "Clone created",
  clone_deleted: "Clone deleted",
  module_installed: "Module installed",
  module_removed: "Module removed",
  tokens_key_issued: "API key issued",
  tokens_key_rotated: "API key rotated",
  seat_limit_approaching: "Seat limit approaching",
  seat_limit_reached: "Seat limit reached",
  seat_plan_changed: "Seat plan changed",
  device_limit_reached: "Device limit reached",
  device_registered: "Device registered",
  device_released: "Device released",
  lead_captured: "Lead captured",
  live_audit_findings_detected: "Live audit — new defects",
  live_audit_run_failed: "Live audit — failing",
  live_audit_fix_ready: "Live audit — fix ready",
};

/** Words a kind's name spells in lower case that a person writes another way. */
const WORD_SPELLINGS: Readonly<Record<string, string>> = {
  api: "API",
  ci: "CI",
  crm: "CRM",
  github: "GitHub",
  pr: "PR",
  sla: "SLA",
};

/**
 * A kind's label: the one a person wrote, or its name read as words
 * (`clone_ci_attention` is "Clone CI attention").
 */
export function notificationKindLabel(kind: string): string {
  const written = NOTIFICATION_KIND_LABELS[kind as NotificationKind];
  if (written) return written;
  const words = kind
    .split("_")
    .filter(Boolean)
    .map((w) => WORD_SPELLINGS[w] ?? w);
  if (words.length === 0) return kind;
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/** Every value the inbox's `kind` filter accepts: "all", then every kind the enum declares. */
export const NOTIFICATION_KIND_FILTER_VALUES: readonly ["all", ...NotificationKind[]] = [
  "all",
  ...ALL_NOTIFICATION_KINDS,
];

/**
 * The filter's options: "All kinds" first, then every kind by label, so a
 * long list reads as an index rather than in the order the enum grew.
 */
export const NOTIFICATION_KIND_FILTER_OPTIONS: ReadonlyArray<{
  value: "all" | NotificationKind;
  label: string;
}> = [
  { value: "all", label: "All kinds" },
  ...ALL_NOTIFICATION_KINDS.map((kind) => ({
    value: kind,
    label: notificationKindLabel(kind),
  })).sort((a, b) => a.label.localeCompare(b.label)),
];
