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
 * The order a pass offers a clone's bundles in: the copy the clone has held
 * longest goes first.
 *
 * ## The defect this closes
 *
 * A whole-fleet pass takes a prefix of the deployable set, and the prefix
 * was alphabetical; a named list is sliced from the same order. That holds
 * while a generation lasts: what one pass lands, the next skips, so the
 * walk moves on. It starves the end of the alphabet as soon as generations
 * stop lasting. `planDeployGeneration` restarts one on every prime merge,
 * the restart empties the skip list, and an alphabetical prefix starts
 * again at `abs-data-service`.
 *
 * Measured 8 Oct 2026 (UTC) on NPC Test:
 *
 * - The prime merged twenty times that day.
 * - A pass landed about 2.3 bundles, because its snapshot read spends most
 *   of the 45 s budget.
 * - The clone got a pass every eight minutes, so reaching the 220th of 395
 *   bundles takes about thirteen hours with no merge in between.
 * - From the 19:54 restart to 21:03, nine passes took the first twenty-one
 *   bundles, `abs-data-service` to `agent-task-runner`.
 * - `manage-agency-agreements`, the 220th, still held the copy deployed on
 *   6 Oct. `property-team`, added to the prime at 13:14 that day, was on no
 *   clone at all.
 *
 * Nothing reported it. Every pass landed bundles, and landing bundles is
 * what this lane counts as progress.
 *
 * ## The rule
 *
 * **Order by what the clone holds, never by name.** A missing bundle comes
 * first, then the copy with the oldest `updated_at`, and the name breaks
 * ties. The order is read from the TARGET, the same read `refreshedSince`
 * takes, so it survives a restart the skip list does not. What a pass
 * landed is now the clone's newest copy and goes to the back. The copy the
 * clone has held longest comes next, whatever the prime did meanwhile.
 *
 * No deploy and no restart moves a bundle further back. What a pass lands
 * goes behind it, and a restart changes only the skip list. Two things can
 * still keep it waiting. A function the prime adds goes to the front,
 * because the clone holds no copy of it. And a bundle the clone refuses on
 * every pass works its way to the front and stays there, because its copy
 * never gets newer.
 *
 * That last case has a cost. Once nothing staler is left, the refused
 * bundle takes the first deploy of every pass, close to half of what a pass
 * carries. A pass with time for only that deploy lands nothing, so it
 * throws and spends an attempt. The alphabetical walk paid the same, but
 * only once it reached the bundle, and between merges it reached only the
 * first names. In return the failure is no longer hidden behind a walk that
 * never gets there. Passes record it in `failed`, and `supersessionVerdict`
 * sends a park that records a failed bundle to a person rather than to a
 * fresh run that would meet the same failure. A run those short passes fail
 * keeps what it deployed: those copies are now the clone's newest, so the
 * next run the catch-up plans starts on other bundles. An alphabetical run
 * started on the same first names again.
 *
 * It changes WHICH bundles a pass carries, never WHETHER the run has
 * finished. Completion is still the skip list's answer against the
 * generation's baseline, and truncation is still measured over the
 * deployable set. Reordering that set changes neither its size nor its
 * members.
 *
 * `listProjectEdgeFunctionFreshness` answers an empty map when the read
 * fails. Every key is then equal, and equal keys keep the snapshot's
 * alphabetical order, which is the order the lane used before.
 */
export function stalestFirst(freshness: ReadonlyMap<string, number>): (slug: string) => number {
  return (slug) => {
    const updatedMs = freshness.get(slug);
    return typeof updatedMs === "number" && Number.isFinite(updatedMs)
      ? updatedMs
      : Number.NEGATIVE_INFINITY;
  };
}

/**
 * `items` in ascending `deployOrder`, keeping the given order between equal
 * keys. Without a `deployOrder` they come back as they arrived.
 *
 * The tie-break is the old order, made explicit rather than left to the
 * engine's sort, because it is what makes an unreadable clone safe: every
 * key equal means exactly the order the lane used before.
 *
 * A key that is not a number (`NaN`) sorts first, as a missing copy does.
 * A comparator handed `NaN` is not a total order, and given one an engine
 * may return any permutation at all.
 */
export function inDeployOrder<T extends { readonly slug: string }>(
  items: readonly T[],
  deployOrder?: (slug: string) => number,
): T[] {
  if (!deployOrder) return [...items];
  const keyed = items.map((item, index) => {
    const key = deployOrder(item.slug);
    return { item, index, key: Number.isNaN(key) ? Number.NEGATIVE_INFINITY : key };
  });
  // Compared, never subtracted: two missing copies would be `-Infinity`
  // minus `-Infinity`, which is `NaN`.
  keyed.sort((a, b) => (a.key === b.key ? a.index - b.index : a.key < b.key ? -1 : 1));
  return keyed.map((entry) => entry.item);
}

/**
 * Where a run's "already delivered" mark starts — its GENERATION.
 *
 * ## The defect this closes
 *
 * `refreshedSince` reads "the clone holds a copy newer than this run began"
 * as "this run has delivered that bundle." That is true only while a run
 * deploys from ONE revision of the prime, and the lane does not: it resolves
 * the prime's HEAD again on every pass, so a run that spans a prime merge
 * deploys its early bundles from revision A and its late ones from revision
 * B — and every bundle from A is now permanently `refreshed` and will never
 * be looked at again. The run finishes `succeeded` over a clone carrying a
 * MIXED tree, which is the silent-success shape this lane already exists to
 * make impossible, one layer up.
 *
 * Measured 13 Sep 2026 on `npc-client-dashboard`. One run, started 03:53:04,
 * walking 435 bundles alphabetically over four passes. The prime merged at
 * 05:38:21. `email-sync-cron` (05:16:38), `ghl-conversations-cron`
 * (05:30:33), `ghl-calendar` (05:32:05) and `import-clients-from-ghl`
 * (05:34:18) landed from the tree BEFORE that merge; `outlook-email-sync`
 * (05:48:22) landed from the tree after it. Read back from the project, the
 * first four carried none of the merge's code and the fifth carried all of
 * it — on one clone, from one run, reported as 435 deployed.
 *
 * It does not self-heal. The catch-up sweep widens an open run rather than
 * queuing a second one, and once this one succeeds the sweep diffs the
 * clone's `last_synced_sha` against the prime's HEAD, finds them equal, and
 * answers `no_backend_work` — for ever.
 *
 * ## The rule
 *
 * **A bundle counts as delivered only against the revision this pass is
 * deploying.** When the observed revision differs from the one the last pass
 * recorded, the prime moved underneath the run: everything deployed so far
 * came from a different tree, so the generation restarts HERE and the run
 * owes the whole set again.
 *
 * Two directions are deliberately not symmetric. **An unreadable revision
 * never restarts a generation** — answering "moved" to a GitHub blip would
 * buy a 435-bundle redeploy on every pass and never terminate, so an absent
 * sha keeps the baseline it had. And **a restart is charged an attempt**
 * (see `planEdgeDeployResume`), because that is what bounds a prime merging
 * faster than a pass can complete: thirty restarts and the run goes to a
 * person instead of spinning.
 */
export function planDeployGeneration(input: {
  /** When the run first executed. The baseline before any revision is known. */
  readonly runStartedAt: string | null | undefined;
  /** The baseline the last pass recorded, if this run has already restarted. */
  readonly lastGenerationAt: string | null | undefined;
  /** The prime revision the last pass deployed from, if there was one. */
  readonly lastSourceSha: string | null | undefined;
  /** The prime revision THIS pass is deploying from. */
  readonly observedSourceSha: string | null | undefined;
  /** This pass's clock, injected so a test can hold it still. */
  readonly now: string;
}): { readonly baselineAt: string | null; readonly sourceMoved: boolean } {
  const held = input.lastGenerationAt ?? input.runStartedAt ?? null;
  const observed = (input.observedSourceSha ?? "").trim();
  const last = (input.lastSourceSha ?? "").trim();

  // Nothing to compare against: the first pass of a run, or a HEAD read that
  // failed. Both keep the baseline they have — see the header for why the
  // failed read must not be read as movement.
  if (!observed || !last) return { baselineAt: held, sourceMoved: false };
  if (observed === last) return { baselineAt: held, sourceMoved: false };

  return { baselineAt: input.now, sourceMoved: true };
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
  /**
   * True when the prime moved under this run — `planDeployGeneration`'s
   * answer. Everything already deployed came from a different tree, so the
   * run owes the whole set again however finished this pass looked.
   */
  readonly sourceMoved?: boolean;
}): EdgeDeployResume {
  const sourceMoved = input.sourceMoved === true;

  if (!sourceMoved && !input.moreRemain && !input.stoppedEarly) return { kind: "complete" };

  // The generation restarted. This outranks every reading below it: a pass
  // that deployed the last outstanding bundle from a superseded tree has
  // finished nothing, and must never report `complete`.
  //
  // Charged an attempt, unlike ordinary forward progress. A restart is the
  // one requeue that does NOT shrink the remaining set — it grows it back to
  // the whole fleet — so the neutral case's termination argument does not
  // hold for it, and `maxAttempts` is what stops a prime merging faster than
  // a pass completes from spinning this run for ever.
  if (sourceMoved) {
    return input.attempts >= input.maxAttempts
      ? { kind: "park" }
      : { kind: "requeue", attemptNeutral: false };
  }

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
  /**
   * Asked before every item but the first, and handed the longest an item
   * has taken so far in this pass.
   *
   * A deadline that answers only "is it past?" lets a pass START an item it
   * cannot finish: with a 45 s budget inside a 60 s invocation, a deploy
   * begun at 44 s that takes twenty is killed at sixty, the requeue is never
   * written, and the run sits in `executing` until the stall reclaim moves
   * it twenty minutes later. Observed on `npc-client-dashboard`, 2 Sep 2026,
   * at 307 of 423 bundles. The slowest item this pass has seen is the best
   * available estimate of the next one, so the caller can reserve it.
   */
  readonly isPastDeadline: (reserveMs: number) => boolean;
  /** Injectable for tests; the wall clock otherwise. */
  readonly now?: () => number;
}): Promise<{ results: R[]; stoppedEarly: boolean }> {
  const now = input.now ?? Date.now;
  const results: R[] = [];
  let slowestMs = 0;
  for (let i = 0; i < input.items.length; i++) {
    if (i > 0 && input.isPastDeadline(slowestMs)) return { results, stoppedEarly: true };
    const startedAt = now();
    results.push(...(await input.runOne(input.items[i])));
    slowestMs = Math.max(slowestMs, now() - startedAt);
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
