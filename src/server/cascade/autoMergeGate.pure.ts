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
  | {
      merge: false;
      reason: "pending" | "failing" | "no_checks" | "awaiting_required" | "checks_unreadable";
      why: string;
    };

/**
 * Checks that must have REPORTED before any merge, named rather than counted.
 *
 * Counting is not enough and the reason is a race the first version lost.
 * Check runs appear asynchronously: `Vercel Preview Comments` completes in the
 * same second the pull request opens, while `verify` — the job that installs,
 * type-checks, builds and runs ~19,000 tests — takes about seventeen minutes to
 * even start reporting. A gate that reads "every check I can see has passed"
 * therefore sees exactly one passing check and merges, seventeen minutes before
 * the one that matters has an opinion.
 *
 * So the substantive jobs are named. A cascade merges when THESE have passed,
 * not when the fast ones have.
 */
export const REQUIRED_CHECKS = ["verify", "security"] as const;

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

export function decideCascadeMerge(
  checks: readonly CheckRun[],
  required: readonly string[] = REQUIRED_CHECKS,
): MergeVerdict {
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

  // A required check that has not reported at all is not a passing one. This
  // is the asynchronous case above: the fast checks are green and `verify` has
  // not been created yet, so it is absent rather than pending.
  const reported = new Set(checks.map((c) => c.name));
  const absent = required.filter((name) => !reported.has(name));
  if (absent.length > 0) {
    return {
      merge: false,
      reason: "awaiting_required",
      why: `Not merging — ${absent.join(", ")} ${absent.length === 1 ? "has" : "have"} not reported yet.`,
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

/**
 * The App cannot read this repository's check runs.
 *
 * `checks: read` is a separate GitHub App permission from `pull_requests`, and
 * without it `GET /repos/{o}/{r}/commits/{ref}/check-runs` answers
 * "Resource not accessible by integration". That is not a red check and not a
 * green one — it is no signal at all.
 *
 * There IS a weaker signal available without the permission: a pull request's
 * `mergeable_state` reads `clean` when checks pass and `unstable` when they do
 * not. It is deliberately NOT used as a fallback, because `clean` is also what
 * a pull request with NO checks reports — so falling back would quietly
 * reintroduce the exact hole `no_checks` exists to close, and would do it on
 * the deployments where the permission is missing, which are the ones nobody
 * is watching.
 *
 * So this fails closed and names the remedy. It is a HOLD rather than a
 * failure: nothing is broken, a permission is missing, and the cascade's pull
 * request is sitting there correctly waiting.
 */
export function checksUnreadable(error: unknown): boolean {
  const m = error instanceof Error ? error.message : String(error ?? "");
  return /Resource not accessible by integration|check-runs|checks\/runs/i.test(m);
}

export const CHECKS_PERMISSION_REMEDY =
  "The GitHub App cannot read check runs on this repository. Grant it the " +
  "read-only `Checks` permission (App settings → Permissions → Repository → " +
  "Checks: Read-only) and accept the permission request on the installation. " +
  "Until then a cascade pull request is opened and left for a human, never " +
  "merged unseen.";
