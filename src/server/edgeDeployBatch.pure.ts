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
