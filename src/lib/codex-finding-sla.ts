// How long an open Codex finding of each severity may wait for a decision.
//
// Shown as age and "overdue" in the findings explorer, filterable, and counted
// in a daily notification. A finding stops the clock when it leaves `open` /
// `triaging` — fixed, dismissed with a reason, or marked a false positive — so
// the way to clear an overdue finding is the decision itself.
//
// The numbers follow common practice for internet-facing services (critical in
// a week, high in a month, medium in a quarter). `info` has no deadline: it is
// context, not work.

export type SlaSeverity = "critical" | "high" | "medium" | "low" | "info";

export const FINDING_SLA_DAYS: Readonly<Record<SlaSeverity, number | null>> = {
  critical: 7,
  high: 30,
  medium: 90,
  low: 180,
  info: null,
};

/** States in which the clock runs: nobody has decided yet. */
export const SLA_OPEN_STATES = ["open", "triaging"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since `since`, never negative. */
export function ageInDays(since: string | null | undefined, nowMs = Date.now()): number {
  const t = since ? Date.parse(since) : NaN;
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((nowMs - t) / DAY_MS));
}

export type SlaStatus = { ageDays: number; dueInDays: number | null; overdue: boolean };

/** Where a finding stands against its severity's response time. */
export function slaStatus(
  finding: { severity: string; state: string; first_seen_at: string | null | undefined },
  nowMs = Date.now(),
): SlaStatus {
  const ageDays = ageInDays(finding.first_seen_at, nowMs);
  const limit = FINDING_SLA_DAYS[finding.severity as SlaSeverity] ?? null;
  const running = (SLA_OPEN_STATES as readonly string[]).includes(finding.state);
  if (limit == null || !running) return { ageDays, dueInDays: null, overdue: false };
  return { ageDays, dueInDays: limit - ageDays, overdue: ageDays > limit };
}

/**
 * The first-seen cutoff per severity at `nowMs`: a finding first seen before
 * its severity's cutoff is overdue. For building a database filter.
 */
export function overdueCutoffs(
  nowMs = Date.now(),
): Array<{ severity: SlaSeverity; before: string }> {
  return (Object.entries(FINDING_SLA_DAYS) as Array<[SlaSeverity, number | null]>)
    .filter((e): e is [SlaSeverity, number] => e[1] != null)
    .map(([severity, days]) => ({
      severity,
      before: new Date(nowMs - (days + 1) * DAY_MS).toISOString(),
    }));
}
