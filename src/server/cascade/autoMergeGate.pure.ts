/**
 * When an `auto_merge` cascade may actually merge.
 *
 * ## Why this exists
 *
 * `auto_merge` mode had two paths to landing code on a clone's default branch,
 * and NEITHER consulted CI.
 *
 * It first tried `git.updateRef` — a direct fast-forward push straight to the
 * clone's `main`. No pull request, no checks, nothing to review. That succeeds
 * whenever the branch is unprotected, which is the state every clone in this
 * fleet is in today (`npc-client-dashboard`'s `main` reports
 * `"protected": false`). Only when protection REFUSED the push did it fall back
 * to a pull request.
 *
 * The engine's own comment already said what that meant: "protection was doing
 * the work the cascade thought it was doing itself. Where protection is absent
 * it merged a tree nothing had built." And it named the day it bit — 26 Aug
 * 2026, a cascade carrying a `package.json`/`package-lock.json` pair that fails
 * `npm ci`, six of eight checks red, the clone's `main` unable to install or
 * deploy.
 *
 * The second path was the fallback's own fallback: when GitHub auto-merge could
 * not be armed, it called `pulls.merge` immediately — merging the pull request
 * it had just opened without waiting for a single check.
 *
 * So the rule is now: **an `auto_merge` cascade never writes to a default
 * branch except through a pull request whose checks it has actually read.**
 *
 * ## Why a pure module
 *
 * The damage needs a token that can push to production repositories, which is
 * exactly what a test must not hold. So the decision is separated from the
 * doing and asserted directly.
 */

/** One check run on the cascade's pull request, as GitHub reports it. */
export type CheckRun = {
  name: string;
  /** `queued` | `in_progress` | `completed` */
  status: string;
  /**
   * `success` | `failure` | `neutral` | `cancelled` | `timed_out`
   * | `action_required` | `skipped` | `stale` | null while running.
   */
  conclusion: string | null;
};

export type MergeVerdict =
  | { merge: true; why: string }
  | { merge: false; reason: "pending" | "failing" | "no_checks"; why: string };

/**
 * Conclusions that do not stand in the way of merging.
 *
 * `neutral` and `skipped` are how a job says it had nothing to do — a path
 * filter that did not match, a matrix leg that was excluded. `stale` is
 * GitHub's own marker for a run superseded by a newer one on the same head.
 * Everything else that has FINISHED and is not `success` is a failure,
 * including `cancelled`, `timed_out` and `action_required`: none of them is
 * evidence the tree is good, and treating an unfamiliar conclusion as passing
 * is how a gate quietly stops being one.
 */
const PASSING = new Set(["success", "neutral", "skipped", "stale"]);

export function decideCascadeMerge(checks: readonly CheckRun[]): MergeVerdict {
  // No checks at all is NOT "all checks passed". It means nothing has built
  // this tree, which is the precise condition that put a clone's `main` in a
  // state that could not install. A cascade is unattended by definition, so
  // there is nobody to notice; it stays open and says why.
  if (checks.length === 0) {
    return {
      merge: false,
      reason: "no_checks",
      why: "No check has reported on this pull request — nothing has built this tree.",
    };
  }

  const unfinished = checks.filter((c) => c.status !== "completed");
  const failed = checks.filter((c) => c.status === "completed" && !PASSING.has(c.conclusion ?? ""));

  // Failure outranks pending: if something has already gone red, waiting for
  // the rest changes nothing, and reporting "still running" would send an
  // operator back later to read the same answer.
  if (failed.length > 0) {
    return {
      merge: false,
      reason: "failing",
      why: `Not merging — ${failed.length} check(s) failing: ${failed.map((c) => `${c.name} (${c.conclusion ?? "?"})`).join(", ")}.`,
    };
  }

  if (unfinished.length > 0) {
    return {
      merge: false,
      reason: "pending",
      why: `Not merging yet — ${unfinished.length} check(s) still running: ${unfinished.map((c) => c.name).join(", ")}.`,
    };
  }

  return { merge: true, why: `All ${checks.length} check(s) passed.` };
}
