/**
 * When a PARKED deploy run may be retired so the work folded into it can be
 * planned again — and when it has to stay in front of a person.
 *
 * ## The trap
 *
 * The planner keeps one open `edge_function_deploy` per clone and folds every
 * later cascade into it. `awaiting_validation` counts as open, but the drain
 * executes only `planned` and `approved` — so a parked run is a queue slot
 * nobody serves, and everything folded into it is queued behind nobody.
 *
 * Measured 26 Sep 2026: `preflight-property-group` (run 09857881) and
 * `npc-test-76b3b3` (run 45045984) parked on 19 Sep with
 * `stalled after 30 attempt(s)` and `failed: []`. No bundle had errored: that
 * day's passes were killed mid-batch while the prime merged under them, and
 * each killed pass cost an attempt. Every cascade for the next week reported
 * "already queued (that run covers every function) — BLOCKED" and neither
 * clone received a function. The same day `npc-client-dashboard` needed 31
 * attempts and finished, which is the whole difference between them.
 *
 * ## The rule
 *
 * **A park that records only exhaustion is not a decision anybody has to
 * make.** Such a run spent its attempts on invocations the platform ended; a
 * fresh run with a fresh budget is the same work asked again, and the lane
 * already refuses to count a bundle twice. So it is retired and replanned.
 *
 * Everything else stays parked, because retiring it would overrule a reason:
 * a bundle that FAILED (a fresh run would fail it again, every thirty
 * minutes, for ever), a lane precondition (no clone scope, no prime source),
 * or anything this module does not recognise. And even a mechanical park is
 * retired at most {@link MAX_CONSECUTIVE_SUPERSESSIONS} times in a row: a run
 * that keeps being killed the same way is telling somebody something, and at
 * that point the BLOCKED line is the right answer rather than a loop.
 */

/** Consecutive retirements a chain of mechanically parked runs may have. */
export const MAX_CONSECUTIVE_SUPERSESSIONS = 3;

/** The two exhaustion parks the edge-deploy lane writes, and nothing else. */
const STALL_EXHAUSTION = /^stalled after \d+ attempt\(s\)$/;
const PASS_EXHAUSTION = /^\d+ bundle\(s\) deployed over \d+ passes and more remain$/;

export type ParkedDeployRun = {
  readonly id: string;
  readonly status: string;
  readonly last_error?: string | null;
  readonly policy?: unknown;
  readonly result?: unknown;
  readonly plan?: unknown;
};

export type SupersessionVerdict =
  | {
      readonly supersede: true;
      /** Every run this chain has retired, oldest first, this one included. */
      readonly chain: readonly string[];
      readonly why: string;
    }
  | { readonly supersede: false; readonly why: string };

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function firstReason(policy: unknown): string | null {
  const reasons = asRecord(policy)?.reasons;
  return Array.isArray(reasons) && typeof reasons[0] === "string" ? reasons[0] : null;
}

/** The ids this run's plan says it already superseded, if any. */
export function supersededChain(plan: unknown): string[] {
  const chain = asRecord(plan)?.supersedes;
  return Array.isArray(chain) ? chain.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Whether a parked run may be retired in favour of a fresh one.
 *
 * Only `awaiting_validation`; only an exhaustion park; only where the last
 * pass recorded no failed bundle; and only while the chain is short.
 */
export function supersessionVerdict(run: ParkedDeployRun): SupersessionVerdict {
  if (run.status !== "awaiting_validation") {
    return { supersede: false, why: `the run is ${run.status}, not parked` };
  }

  const stalled = STALL_EXHAUSTION.test(run.last_error ?? "");
  const exhausted = PASS_EXHAUSTION.test(firstReason(run.policy) ?? "");
  if (!stalled && !exhausted) {
    return {
      supersede: false,
      why: "it was parked for a reason other than running out of attempts",
    };
  }

  const failed = asRecord(run.result)?.failed;
  if (Array.isArray(failed) && failed.length > 0) {
    return {
      supersede: false,
      why: `its last pass could not deploy ${failed.length} bundle(s), and a fresh run would meet the same failure`,
    };
  }
  if (failed !== undefined && !Array.isArray(failed)) {
    return { supersede: false, why: "its record of failed bundles is unreadable" };
  }

  const prior = supersededChain(run.plan);
  if (prior.length >= MAX_CONSECUTIVE_SUPERSESSIONS) {
    return {
      supersede: false,
      why: `${prior.length} runs before it were retired the same way — a person should look`,
    };
  }

  return {
    supersede: true,
    chain: [...prior, run.id],
    why: stalled
      ? "it ran out of attempts to killed passes, with no bundle failed"
      : "it ran out of attempts with bundles still owed, and no bundle failed",
  };
}

/**
 * What the fresh run owes: everything the retired run still owed, plus this
 * plan's work. A whole-fleet side makes the whole fleet.
 */
export function slugsOwedAfterSupersession(
  parked: readonly string[] | null,
  planned: readonly string[] | null,
): string[] | null {
  if (parked === null || planned === null) return null;
  return [...new Set([...parked, ...planned])].sort();
}
