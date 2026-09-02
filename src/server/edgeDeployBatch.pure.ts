/**
 * How much of a clone's edge-function backlog one pass takes, and whether the
 * run may call itself finished.
 *
 * ## Why this is a module rather than four lines in the lane
 *
 * `edge_function_deploy` deployed every bundle it was given in a single
 * invocation. That was survivable while nothing ever asked it for the whole
 * fleet — and nothing ever did: measured 2 Sep 2026, the first such run in
 * the table's entire history asked for all 423, ran for thirty minutes and
 * deployed **nothing at all** before its invocation was killed. It then sat
 * in `executing`, a state no work list selects and no lane reads, for ever.
 *
 * So a pass is bounded now, and bounding introduces the only genuinely
 * delicate decision in the lane: *may this pass say the deployment is
 * complete?* Getting that wrong does not fail loudly — it marks a run
 * `succeeded` over functions that were never deployed, which is the shape of
 * every silent-success defect this platform has already paid for.
 *
 * ## The trap this exists to make impossible
 *
 * `fetchPrimeBackendSnapshot`'s `functionLimit` measures truncation over the
 * **unfiltered** deployable set. Handed a named slug list, a capped pass can
 * therefore return sixty bundles containing *none* of the wanted ones. The
 * lane filters, finds an empty batch, and reads its own empty result as
 * "nothing left to do" — succeeding on a deployment it never performed.
 *
 * The rule that closes it: **the cap belongs to the whole-fleet case, and
 * completion is measured against what was WANTED, never against what was
 * fetched.** A named list is bounded by the cascade that produced it, so it
 * is sliced here instead of being capped at the fetch.
 */

/** The slugs one pass will deploy, and whether the run owes more after it. */
export type EdgeDeployPass = {
  /** True when this run owes every function the prime has. */
  readonly wholeFleet: boolean;
  /** Slugs to deploy on this pass, in the order the snapshot returned them. */
  readonly batch: readonly string[];
  /**
   * True when bundles this run owes are still undeployed after this pass.
   *
   * A pass that carries only some of the functions may not pronounce the
   * deployment complete — the same rule `functionSourceTruncated` is
   * documented for, applied to a named list too.
   */
  readonly moreRemain: boolean;
};

/**
 * Which slugs the clone already holds a copy of that is newer than this run.
 *
 * Asked of the TARGET rather than of a diary the run keeps about itself. A
 * pass that deployed sixty bundles and then lost its invocation still counts,
 * which is the whole point: the state that has to survive a killed pass is on
 * the clone, not in a `result` column the dying pass never reached.
 *
 * A slug refreshed by some other route since this run began — the clone's own
 * CI, a provisioning pass — counts as done, and should: the question is
 * whether the clone holds a current copy, not who put it there.
 *
 * An unreadable start time answers EMPTY, so nothing is presumed fresh and
 * every bundle is redeployed. That direction costs work; the other silently
 * skips bundles that were never deployed at all.
 */
export function refreshedSince(
  freshness: ReadonlyMap<string, number>,
  startedAtIso: string | null | undefined,
): string[] {
  const startedMs = Date.parse(startedAtIso ?? "");
  if (!Number.isFinite(startedMs)) return [];
  const out: string[] = [];
  for (const [slug, updatedMs] of freshness) {
    if (Number.isFinite(updatedMs) && updatedMs >= startedMs) out.push(slug);
  }
  return out.sort();
}

/**
 * Decide this pass's batch and whether the run may finish after it.
 *
 * `fetched` is what the snapshot actually returned — already reduced by
 * `skipFunctionSlugs`, and already capped when the caller asked for a cap.
 * `truncated` is the snapshot's own `functionSourceTruncated`, which is
 * meaningful for the whole-fleet case alone (see the header).
 */
export function planEdgeDeployPass(input: {
  readonly wanted: readonly string[] | null;
  readonly fetched: readonly string[];
  readonly truncated: boolean;
  readonly batchLimit: number;
}): EdgeDeployPass {
  const wholeFleet = input.wanted === null;

  if (wholeFleet) {
    // The fetch was capped, so everything it returned is this pass's work and
    // the snapshot alone knows whether more was left behind.
    return { wholeFleet, batch: [...input.fetched], moreRemain: input.truncated };
  }

  const want = new Set(input.wanted ?? []);
  const candidates = input.fetched.filter((slug) => want.has(slug));
  // A limit of zero or less would slice to nothing and then report more
  // remaining for ever, so the batch is never empty while candidates exist.
  const limit = Math.max(1, input.batchLimit);
  const batch = candidates.slice(0, limit);
  return { wholeFleet, batch, moreRemain: candidates.length > batch.length };
}

/** What the lane does with a run once its pass has finished deploying. */
export type EdgeDeployResume =
  /** Nothing owed — the run may finish. */
  | { readonly kind: "complete" }
  /** More owed, and this pass earned another. */
  | { readonly kind: "requeue"; readonly attemptNeutral: boolean }
  /** More owed and the run has stopped getting anywhere. A person decides. */
  | { readonly kind: "park" };

/**
 * Whether a pass may finish, must go round again, or has stopped progressing.
 *
 * ## Why this is not three lines in the lane
 *
 * Bounding a pass in TIME as well as in count introduces a second delicate
 * decision beside the completion rule above, and it fails in both directions.
 *
 * Count every requeue as an attempt and a lane that pauses every 45 seconds
 * onto a two-minute tick spends all thirty attempts inside an hour — strictly
 * worse than the twenty-minute stall the budget replaces, and it lands on a
 * run that was working perfectly.
 *
 * Count none of them and a batch whose every deploy FAILS requeues for ever:
 * a failed bundle never becomes `refreshed`, so the next pass fetches exactly
 * the same work and fails at it again, silently, until somebody notices.
 *
 * ## The rule
 *
 * **A pass that landed at least one bundle made forward progress, and
 * forward progress does not spend an attempt.**
 *
 * That terminates. Every landed bundle becomes `refreshed` and is skipped by
 * the next pass, so an attempt-neutral pass strictly shrinks the remaining
 * set — and the set is finite. A pass that lands NOTHING keeps its attempt,
 * so `maxAttempts` still carries a genuinely stuck run to a human.
 *
 * `attempts` is the count from BEFORE this pass incremented it, which is what
 * lets the caller undo exactly this pass's increment rather than resetting a
 * counter that may be carrying a real earlier failure.
 */
export function planEdgeDeployResume(input: {
  /** Bundles this pass successfully deployed. */
  readonly landed: number;
  /** True when the plan says the run owes bundles it has not fetched yet. */
  readonly moreRemain: boolean;
  /** True when the invocation budget stopped this pass mid-batch. */
  readonly stoppedEarly: boolean;
  readonly attempts: number;
  readonly maxAttempts: number;
}): EdgeDeployResume {
  if (!input.moreRemain && !input.stoppedEarly) return { kind: "complete" };

  // Landed something: this pass moved the run closer to done, so it is not
  // charged for the invocation it took to do it.
  if (input.landed > 0) return { kind: "requeue", attemptNeutral: true };

  return input.attempts >= input.maxAttempts
    ? { kind: "park" }
    : { kind: "requeue", attemptNeutral: false };
}

/**
 * Work through a batch one item at a time, stopping at the invocation budget
 * and KEEPING what was done.
 *
 * ## Why the caller injects the deploy
 *
 * `deployEdgeFunctions` takes a `deadlineAt` of its own, and it signals the
 * budget by throwing `BudgetPause` and discarding the pass's `results`. That
 * is right for provisioning, which re-derives its progress by asking the
 * target which slugs it holds. It is wrong for the self-healing lane, which
 * has to know whether the pass it is about to requeue LANDED anything —
 * that answer is the whole input to `planEdgeDeployResume`, and a loop that
 * dropped its partial results would report every budget stop as barren and
 * charge it an attempt.
 *
 * So the stopping is here, where a test can hold it to that; the lane injects
 * the real deploy and the real clock.
 *
 * The first item is ALWAYS attempted. A budget already spent before the loop
 * began — by a slow snapshot read, say — would otherwise produce a pass that
 * deploys nothing, every time, each one charged an attempt for landing
 * nothing. One item a pass is slow; zero is stuck.
 */
export async function runWithinBudget<T, R>(input: {
  readonly items: readonly T[];
  readonly runOne: (item: T) => Promise<readonly R[]>;
  readonly isPastDeadline: () => boolean;
}): Promise<{ results: R[]; stoppedEarly: boolean }> {
  const results: R[] = [];
  for (let i = 0; i < input.items.length; i++) {
    if (i > 0 && input.isPastDeadline()) return { results, stoppedEarly: true };
    results.push(...(await input.runOne(input.items[i])));
  }
  return { results, stoppedEarly: false };
}

/**
 * How many bundles a pass actually put on the clone.
 *
 * Counted from the deploy results, never from the batch that was sent. The
 * two differ constantly — a bundle can be refused for its size, its slug or
 * its contents while the fifty beside it land — and the distinction carries
 * two separate weights: it is the input to `planEdgeDeployResume`, where
 * "landed nothing" is what spends an attempt, and it is what the run reports
 * as deployed, where counting the batch would credit the clone with functions
 * it refused.
 */
export function countLanded(results: readonly { readonly error?: unknown }[]): number {
  return results.filter((r) => !r.error).length;
}
