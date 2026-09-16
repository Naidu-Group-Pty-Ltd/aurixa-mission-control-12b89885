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

export type BudgetVerdict = { proceed: true } | { proceed: false; why: string };

export function decideSpend(input: {
  role: "cascade_claim" | "scan";
  /** Calls left in the installation's window, or null when unreadable. */
  remaining: number | null;
}): BudgetVerdict {
  if (input.remaining === null) return { proceed: true };
  const floor = input.role === "cascade_claim" ? CASCADE_CLAIM_FLOOR : SCAN_FLOOR;
  if (input.remaining >= floor) return { proceed: true };
  return {
    proceed: false,
    why:
      `${input.remaining} call(s) left in the installation's window, below the ` +
      `${input.role === "cascade_claim" ? "cascade" : "scan"} floor of ${floor}`,
  };
}
