// Whether an automatic fleet cascade waits for a person because of what the
// security scans say about Prime.
//
// Before this, nothing waited on scan results: a push to Prime's default
// branch started the fleet cascade before the post-merge scan had even been
// dispatched, and no gate anywhere looked at open findings. With the gate on,
// automatic commit cascades are held for approval while Prime has open
// findings at or above the configured severity. Off by default — Prime's
// first scans under the new workflow need triaging before a gate on them is
// meaningful, and a gate tripped by noise teaches people to approve blindly.
//
// A held cascade carries its reason in `cascade_events.hold_reason`, which
// the drain's gate reassessment honours (gateReassessment.pure.ts): unlike a
// blast-radius gate, a security hold is never discharged by re-deriving a
// rule — only a person's approval releases it.

export type CascadeSecurityGate = "off" | "critical" | "high";

export const CASCADE_SECURITY_GATES: readonly CascadeSecurityGate[] = ["off", "critical", "high"];

export function parseCascadeSecurityGate(value: unknown): CascadeSecurityGate {
  return CASCADE_SECURITY_GATES.includes(value as CascadeSecurityGate)
    ? (value as CascadeSecurityGate)
    : "off";
}

export type GateDecision = { hold: false; reason: null } | { hold: true; reason: string };

export function securityGateDecision(
  gate: CascadeSecurityGate,
  openCounts: { critical?: number | null; high?: number | null },
): GateDecision {
  if (gate === "off") return { hold: false, reason: null };
  const critical = Math.max(0, openCounts.critical ?? 0);
  const high = gate === "high" ? Math.max(0, openCounts.high ?? 0) : 0;
  if (critical + high === 0) return { hold: false, reason: null };
  const parts = [critical ? `${critical} critical` : null, high ? `${high} high` : null].filter(
    Boolean,
  );
  return {
    hold: true,
    reason:
      `Security gate: Prime has ${parts.join(" and ")} open finding${critical + high === 1 ? "" : "s"}. ` +
      `Triage or fix ${critical + high === 1 ? "it" : "them"} on /security/scans, or approve this cascade to deliver anyway.`,
  };
}

/**
 * Commit title the self-healing queue gives a fix it merged by itself
 * ("Self-healing: security fix PR #12 (Claude)"; older merges said "codex
 * remediation PR"). Such a fix cascades like any commit and passes this gate.
 */
export const SELF_HEALING_MERGE_TITLE = /^Self-healing: (?:codex remediation|security fix) PR #\d+/;
/**
 * Commit title of a fix merged after two admin approvals on /security/scans,
 * before fixes merged by themselves. Still recognised: such a commit's
 * cascade passes this gate like a self-healing merge's.
 */
export const REVIEWED_REMEDIATION_MERGE_TITLE = /^Codex remediation #\d+/;
