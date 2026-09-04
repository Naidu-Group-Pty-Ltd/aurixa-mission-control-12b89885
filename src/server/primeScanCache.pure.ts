/**
 * When a provisioning pass may skip the expensive half of the prime snapshot.
 *
 * Fetching every bundle the prime repo defines is what the secret-name scan
 * needs — ~1,033 files across 423 bundles — and it is paid BEFORE the first
 * stage of a pass runs. Once it grew past what one invocation budget could
 * absorb, the pipeline stopped advancing at all: measured 4 Sep 2026, every
 * tick spent its 50s and paused at the same stage, one clone at `deploying
 * edge functions` and the other at `replicating the pg_cron schedule`, for
 * half an hour without either moving. A fixed cost in front of the first
 * stage is a livelock, not slow progress.
 *
 * The two things that fetch buys are properties of (repo, commit), so they
 * are cached by commit. This is the decision to trust the cache, and it is
 * pure so the conditions can be pinned rather than described.
 */
export type SkipFunctionSourceInput = {
  /** A resumed schema pass omits the source anyway — never reaches the fetch. */
  resumingSchema: boolean;
  /** Cached scan for exactly this commit, or null when there is none. */
  cachedSecretNames: readonly string[] | null;
  /** Cached declared slugs for exactly this commit, or null. */
  cachedDeclaredSlugs: readonly string[] | null;
  /** What the clone's project is running right now. */
  liveFunctionSlugs: readonly string[];
};

/**
 * True only when the fetch would buy nothing this pass can use.
 *
 * Every condition is a reason on its own, and each is the conservative side:
 *
 *  - A cache MISS buys the fetch. A commit nobody has scanned is a commit
 *    whose secret names are unknown, and unknown is not empty.
 *  - An EMPTY cached list is treated as a miss. The prime references 86
 *    secrets; a zero-length list is the shape a broken scan leaves behind,
 *    and trusting it would hand the clone no secrets at all while reporting
 *    success — which is the exact defect that made this repair necessary.
 *  - A clone MISSING any declared function buys the fetch, because the
 *    bundles are what deploying it needs.
 */
export function shouldSkipFunctionSource(input: SkipFunctionSourceInput): boolean {
  if (input.resumingSchema) return false;
  const { cachedSecretNames, cachedDeclaredSlugs } = input;
  if (!cachedSecretNames || cachedSecretNames.length === 0) return false;
  if (!cachedDeclaredSlugs || cachedDeclaredSlugs.length === 0) return false;
  const live = new Set(input.liveFunctionSlugs);
  return cachedDeclaredSlugs.every((slug) => live.has(slug));
}

/**
 * Whether a snapshot's scan may be written to the cache.
 *
 * Only completeness matters, and only one flag reports it. `functionSourceOmitted`
 * means no bundle was read at all; recording that pass's empty secret list
 * under a real commit would teach every later pass that the prime references
 * nothing — a wrong answer made permanent and indistinguishable from a right
 * one. The function CAP is deliberately not consulted: the scan reads every
 * bundle the repo defines regardless of how many this pass may deploy, which
 * is precisely why it is expensive.
 */
export function scanIsCacheable(snapshot: {
  functionSourceOmitted: boolean;
  sourceSha: string;
  secretNames: readonly string[];
}): boolean {
  return (
    !snapshot.functionSourceOmitted &&
    snapshot.sourceSha.length > 0 &&
    snapshot.secretNames.length > 0
  );
}
