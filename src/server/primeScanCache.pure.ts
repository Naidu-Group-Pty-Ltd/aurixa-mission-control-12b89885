import { isPrimeOnlyFunction } from "./primeOnlyFeatures.pure";

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
 * Whether this pass can reach the edge-function stage at all — and so whether
 * the prime's function source is worth fetching on it.
 *
 * A pass that builds the schema by introspection reaches the edge functions
 * only once the schema is VERIFIED: a resumed pass ends `partial`, and a full
 * pass either pauses inside the build or finishes it, records
 * `schema_verified_at`, and then meets the omitted-source guard in front of
 * the deploys, which pauses with an empty marker. The pass after that reads
 * the verification, so it is the one that fetches — the condition moves, so
 * the guard cannot livelock the way the first version of it did.
 *
 * Until now only the RESUMED half of that was honoured, and the full pass paid
 * for the source it could not use. Measured 29 Oct 2026 on
 * `tutorial-demo-orrimere-c158c7`: the prime's function tree had grown to 33
 * MB, every pass without a resume marker fetched and scanned all of it before
 * its first stage, and five of six such passes were killed by the runtime
 * (HTTP 502, no response body) while every resumed pass around them paused
 * cleanly with HTTP 200. Three kills in a row exhausted the job's attempts and
 * failed a clone whose schema was still converging.
 *
 * The legacy replay strategy never records a verification, so it keeps the
 * old rule: only a resumed pass is known not to need the source.
 */
export function passCanReachEdgeFunctions(input: {
  resumingSchema: boolean;
  schemaStrategy: "introspection" | "migration-replay";
  /** The project an earlier pass created, or null on the first pass. */
  projectRef: string | null;
  /** `clone_backends.schema_verified_at`, or null when no pass has verified it. */
  schemaVerifiedAt: string | null;
}): boolean {
  if (input.resumingSchema) return false;
  if (input.schemaStrategy === "migration-replay") return true;
  return Boolean(input.projectRef) && Boolean(input.schemaVerifiedAt);
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
 *
 * A snapshot whose names CAME from the cache (`secretScanFromCache`) performed
 * no scan, so it records nothing: writing it back would restamp a row with
 * its own contents and call that a reading.
 */
export function scanIsCacheable(snapshot: {
  functionSourceOmitted: boolean;
  sourceSha: string;
  secretNames: readonly string[];
  secretScanFromCache?: boolean;
}): boolean {
  return (
    !snapshot.functionSourceOmitted &&
    !snapshot.secretScanFromCache &&
    snapshot.sourceSha.length > 0 &&
    snapshot.secretNames.length > 0
  );
}

/**
 * A cached declared-slug list, as a clone is contracted to carry it today.
 *
 * `prime_snapshot_scans` is keyed by commit, and a row scanned before the
 * prime's own feature was held out of the function tree still lists its
 * functions. Read as it stands, such a row names functions no clone is given,
 * and `shouldSkipFunctionSource` would wait for them to go live on the clone
 * before it trusted the cache again — every pass buying the fetch it exists to
 * skip, for as long as the prime's head stays on that commit. The row is not
 * rewritten; it is read through the same rule the tree walk applies.
 */
export function withoutPrimeOnlyFunctions(slugs: readonly string[]): string[] {
  return slugs.filter((slug) => !isPrimeOnlyFunction(slug));
}
