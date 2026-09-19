/**
 * One installation, one hourly budget, many spenders — and no arbiter.
 *
 * Measured 16 Sep 2026: the App installation's 5,000-call window opening at
 * 09:23 was exhausted by 09:41 — the cascade got roughly a third of it, and
 * the rest went to everything else that shares the installation: the
 * periodic scans, the merge drain, and a zombie invocation re-running
 * unbudgeted probes. The actor that unblocks the fleet was living on
 * leftovers, and `/rate_limit` — which GitHub serves for free, uncounted —
 * was never asked.
 *
 * The policy is a floor per role, decided here and read everywhere:
 *
 *  - **The cascade claims only above `CASCADE_CLAIM_FLOOR`.** A claim into
 *    an empty budget spends an attempt, two tree listings and a probe chunk
 *    to learn what one free call already knew, then defers anyway.
 *  - **Observability yields below `SCAN_FLOOR`.** A drift number refreshed
 *    into a starved window is a measurement taken at the cost of the act it
 *    measures; the next scheduled run takes the reading instead. The merge
 *    drain is NOT a scan — it is the actor that lands finished work, its
 *    spend is a handful of calls, and it never yields.
 *  - **An unreadable allowance changes nothing.** Fail-open to yesterday's
 *    behaviour: the deferral machinery still catches a real 403, and a
 *    policy that can be tripped by its own telemetry is a second outage.
 */

/** Below this, a drain tick does not claim; it waits for the window. */
export const CASCADE_CLAIM_FLOOR = 250;

/** Below this, periodic GitHub-reading scans skip their run. */
export const SCAN_FLOOR = 1_500;

/**
 * Below this, an actor that is NOT the cascade stands down.
 *
 * The same floor as the cascade's claim, and for the same reason rather than
 * by coincidence: an actor lands work, so it yields only at the reserve that
 * keeps the next actor able to start. It is deliberately far below
 * `SCAN_FLOOR` — a measurement postponed costs a stale number, while an
 * apply postponed costs a clone sitting a migration behind the prime.
 *
 * Added 19 Sep 2026, because the floors above were only ever read by the
 * cascade and the scans. Measured that morning: `backend-provisioning-drain`
 * (every minute), `support-remediation-drain` (every two), `fleet-migration-
 * sync` (every thirty) and `handoff-parity-refresh` (hourly) all reached this
 * installation and none consulted the budget at all — so the policy protected
 * the window from the lanes that had already been taught to yield, and from
 * nothing else. The fleet sync exhausted it that night and three clones were
 * ejected on the strength of what the refusal looked like.
 *
 * `cascade-merge-drain` stays unbudgeted deliberately; see the header.
 */
export const ACTOR_FLOOR = 250;

export type BudgetRole = "cascade_claim" | "scan" | "actor";

export type BudgetVerdict = { proceed: true } | { proceed: false; why: string };

const FLOOR: Record<BudgetRole, number> = {
  cascade_claim: CASCADE_CLAIM_FLOOR,
  scan: SCAN_FLOOR,
  actor: ACTOR_FLOOR,
};

/** What the refusal calls each role, so an operator reads a lane and not an enum. */
const LABEL: Record<BudgetRole, string> = {
  cascade_claim: "cascade",
  scan: "scan",
  actor: "actor",
};

export function decideSpend(input: {
  role: BudgetRole;
  /** Calls left in the installation's window, or null when unreadable. */
  remaining: number | null;
}): BudgetVerdict {
  if (input.remaining === null) return { proceed: true };
  const floor = FLOOR[input.role];
  if (input.remaining >= floor) return { proceed: true };
  return {
    proceed: false,
    why:
      `${input.remaining} call(s) left in the installation's window, below the ` +
      `${LABEL[input.role]} floor of ${floor}`,
  };
}
