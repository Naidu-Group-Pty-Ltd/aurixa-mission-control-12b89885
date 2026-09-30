/**
 * Which prime revision a clone's edge FUNCTIONS are at — read from the deploy
 * runs that put them there, never from a column somebody else also writes.
 *
 * ## The collision this replaces
 *
 * The catch-up sweep used to read `clone_backends.source_sha` as the functions
 * baseline, and the deploy lane stamped it on success. It is not the deploy
 * lane's column. Four writers share it: provisioning, the operator's migration
 * sync, the deploy lane — and the fleet migration lane, which rewrites it with
 * the prime's HEAD on every pass, every thirty minutes, whether or not a single
 * function moved.
 *
 * So the sweep diffed HEAD against (nearly) HEAD and answered
 * `no_backend_work`. Measured 26 Sep 2026: `preflight-property-group` and
 * `npc-test-76b3b3` last received a function on 19 Sep (prime `d86f485c`),
 * the prime changed `supabase/functions/_shared/` — which ships inside every
 * bundle — more than a dozen times since, and every sweep for a week reported
 * both clones as owing nothing.
 *
 * ## The rule
 *
 * **A revision is claimed only by the run that proves it.** A succeeded
 * `edge_function_deploy` records `functions_revision`: for a whole-fleet run,
 * the one revision every bundle came from; for a named run, the revision its
 * slug list was computed up to — never the snapshot's, which is newer and
 * whose other changes the named run did not deploy. A run that finished with a
 * bundle failed proves nothing, because the failed function is not at that
 * revision and a baseline past it would never plan it again.
 *
 * The baseline is then the newest proof per clone. Anything that proves
 * nothing is stepped over, back to an older proof — which only ever makes the
 * next diff WIDER. A clone with no proof at all owes every backend file, the
 * planner's own safe reading: a redeploy, never a skip.
 */

/** A full, lower-case git object id. Anything else is not a revision. */
const SHA = /^[0-9a-f]{40}$/;

function isSha(v: unknown): v is string {
  return typeof v === "string" && SHA.test(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * What a run's plan asked for, read the way the lane reads it.
 *
 * The lane takes `run.plan?.slugs ?? null`, so an absent key and an explicit
 * null are both the whole fleet. A value that is neither null nor a list is a
 * plan this module cannot vouch for, and says so rather than guessing.
 */
function plannedSlugs(plan: unknown): readonly string[] | null | "unreadable" {
  const slugs = asRecord(plan)?.slugs;
  if (slugs === null || slugs === undefined) return null;
  if (Array.isArray(slugs) && slugs.every((s) => typeof s === "string")) return slugs;
  return "unreadable";
}

/**
 * The revision a deploy run may record as its clone's functions baseline when
 * it SUCCEEDS, or null where it proves none.
 *
 * - A bundle failed: null. The failed function is still at whatever it was.
 * - Whole fleet: the revision the bundles were deployed from. A run succeeds
 *   only with the prime unmoved across its generation, so that is one revision.
 * - Named: the revision the slug list was computed UP TO (`plan.prime_sha`).
 *   The snapshot is newer, and its other changes were never deployed.
 */
export function functionsRevisionOfSuccess(input: {
  readonly wanted: readonly string[] | null;
  /** The snapshot revision the bundles came from. */
  readonly deployedFromSha: string | null | undefined;
  /** `plan.prime_sha` — the revision a named run's diff reaches. */
  readonly plannedToSha: string | null | undefined;
  readonly failedBundles: number;
}): string | null {
  if (input.failedBundles > 0) return null;
  if (!isSha(input.deployedFromSha)) return null;
  if (input.wanted === null) return input.deployedFromSha;
  return isSha(input.plannedToSha) ? input.plannedToSha : null;
}

/**
 * The revision a SUCCEEDED deploy run proves every function of its clone is
 * at, or null.
 *
 * `functions_revision` is the lane's own statement and wins wherever present.
 * Runs recorded before it existed carried only `revision_recorded` and the
 * snapshot's `source_sha`; for those the same rule as
 * {@link functionsRevisionOfSuccess} is applied to what they wrote down.
 */
export function recordedFunctionsRevision(run: {
  readonly plan: unknown;
  readonly result: unknown;
}): string | null {
  const result = asRecord(run.result);
  if (!result) return null;
  if ("functions_revision" in result) {
    return isSha(result.functions_revision) ? result.functions_revision : null;
  }
  if (result.revision_recorded !== true) return null;
  const wanted = plannedSlugs(run.plan);
  if (wanted === "unreadable") return null;
  return functionsRevisionOfSuccess({
    wanted,
    deployedFromSha: typeof result.source_sha === "string" ? result.source_sha : null,
    plannedToSha: asRecord(run.plan)?.prime_sha as string | null | undefined,
    // `revision_recorded: true` was only ever written with no bundle failed.
    failedBundles: 0,
  });
}

export type SucceededDeployRun = {
  readonly cloneId: string | null;
  readonly plan: unknown;
  readonly result: unknown;
  readonly completedAt: string | null;
};

function completedMs(run: SucceededDeployRun): number {
  const t = Date.parse(run.completedAt ?? "");
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Each clone's functions baseline: the newest succeeded run that proves one.
 *
 * Runs that prove nothing are stepped over rather than treated as a baseline
 * of null. An older proof still holds — a later run that failed a bundle left
 * that function where the older run put it — and stepping back to it only
 * widens the next diff. A clone absent from the answer has no proof at all.
 */
export function functionsBaselineByClone(runs: readonly SucceededDeployRun[]): Map<string, string> {
  const newestFirst = [...runs].sort((a, b) => completedMs(b) - completedMs(a));
  const out = new Map<string, string>();
  for (const run of newestFirst) {
    if (!run.cloneId || out.has(run.cloneId)) continue;
    const revision = recordedFunctionsRevision(run);
    if (revision) out.set(run.cloneId, revision);
  }
  return out;
}
