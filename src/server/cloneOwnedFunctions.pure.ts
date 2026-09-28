/**
 * The edge functions a clone carries and the prime does not — which ones they
 * are, whether this pass has to deploy them, and what gets recorded.
 *
 * ## Why this exists
 *
 * Every function a clone's project runs is deployed from the PRIME's
 * repository: provisioning and the self-healing deploy lane both post the
 * bundles `fetchPrimeBackendSnapshot` reads out of the prime's tree. That is
 * right for every function the prime declares and silent about the rest.
 *
 * A CRM-independent clone carries three the prime does not — `crm-calendar`,
 * `crm-inbound-message` and `crm-send-message` — built on
 * `_shared/crm/**`, which is also only in its own repository (measured
 * 28 Sep 2026 across the fleet: the three mirrors own nothing, the CRM clone
 * owns exactly those three). They were deployed to the one clone that has them
 * by hand. A clone created under the CRM-independent parent would come up
 * with a CRM front end calling three functions its project does not have.
 *
 * ## The rules
 *
 * - **Owned is clone-declared minus prime-declared.** Both are read from a
 *   tree with `isCloneFunctionPath`, so what the prime keeps for itself is in
 *   neither. A function the prime also declares is never deployed from the
 *   clone's repository, however the two copies differ: that one belongs to
 *   the prime's lane, and two lanes writing one function is how a project
 *   ends up running whichever wrote last.
 * - **A large owned set is refused, not deployed.** A clone owning more than
 *   `MAX_OWNED_FUNCTIONS` means the prime's declared list was misread or the
 *   clone has diverged by hundreds of functions — either way deploying them
 *   all from the clone's copy is the wrong act, and a person should look.
 * - **The digest is taken over blob ids, never bodies.** Everything a bundle
 *   is assembled from — its own files, the shared tree, the import map, its
 *   `verify_jwt` — is named by the tree walk alone, so deciding that nothing
 *   changed costs no content fetch. It is conservative: a change to any shared
 *   file redeploys the owned functions even when none of them imports it,
 *   which costs three deploys and is the safe direction.
 * - **Nothing here deletes.** A slug the clone once owned and no longer
 *   declares is recorded as `retired` for an operator to see. The platform
 *   deletes nothing a repository stops declaring, and a CRM conversion that
 *   must take these functions off a project does so as its own act.
 * - **Absent is not zero.** A project whose functions could not be read is
 *   `null`, and the decision then trusts the record rather than reading the
 *   failure as "none live".
 *
 * Pure: no I/O. Hashing is computation, not a read.
 */

import { createHash } from "node:crypto";

/** More than this and the lane refuses rather than deploying. */
export const MAX_OWNED_FUNCTIONS = 20;

/** One function's latest deploy by this lane. */
export type OwnedFunctionResult = {
  slug: string;
  success: boolean;
  verifyJwt?: boolean;
  error?: string;
};

/**
 * `clone_backends.clone_owned_functions`. NULL on the row means the lane has
 * never run for this clone; `{"slugs": []}` means it read the repository and
 * the clone owns nothing.
 */
export type CloneOwnedFunctionsRecord = {
  /** Every slug the clone owns at `source_sha`. */
  slugs: string[];
  /** "owner/repo" the functions were read from. */
  source_repo: string | null;
  /** The repository commit that was read. */
  source_sha: string | null;
  /** `ownedFunctionsDigest` of what the owned bundles are built from; null when nothing is owned. */
  digest: string | null;
  /** When this lane last deployed anything; null when it has never had to. */
  deployed_at: string | null;
  /** The latest result per owned slug. */
  results: OwnedFunctionResult[];
  /** Slugs once owned and no longer declared, still live on the project. Never deleted here. */
  retired: string[];
  /** When the repository was last read. */
  checked_at: string;
};

/** What one bundle is assembled from, before pruning — see `planFunctionBundles`. */
export type OwnedBundlePlan = {
  slug: string;
  entrypointPath: string;
  importMapPath: string | null;
  verifyJwt: boolean;
  files: ReadonlyArray<{ rel: string; sha: string }>;
};

/** The slugs the clone declares that the prime does not, sorted and distinct. */
export function ownedFunctionSlugs(
  cloneDeclared: readonly string[],
  primeDeclared: readonly string[],
): string[] {
  const prime = new Set(primeDeclared);
  return [...new Set(cloneDeclared)].filter((s) => !prime.has(s)).sort();
}

/**
 * One id for everything the owned bundles are built from, or null when the
 * clone owns nothing.
 *
 * Canonical before hashing: plans by slug, files by path, so the id cannot
 * depend on the order a tree listing happened to return.
 */
export function ownedFunctionsDigest(plans: readonly OwnedBundlePlan[]): string | null {
  if (plans.length === 0) return null;
  const canonical = [...plans]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((p) => ({
      slug: p.slug,
      entrypoint: p.entrypointPath,
      importMap: p.importMapPath,
      verifyJwt: p.verifyJwt,
      files: [...p.files]
        .sort((a, b) => a.rel.localeCompare(b.rel))
        .map((f) => `${f.rel}:${f.sha}`),
    }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Read a stored record, or null when there is none or it is not one this lane wrote. */
export function readOwnedRecord(raw: unknown): CloneOwnedFunctionsRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.slugs) || !r.slugs.every((s) => typeof s === "string")) return null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const results = Array.isArray(r.results)
    ? r.results.flatMap((x): OwnedFunctionResult[] => {
        if (!x || typeof x !== "object") return [];
        const o = x as Record<string, unknown>;
        if (typeof o.slug !== "string" || typeof o.success !== "boolean") return [];
        return [
          {
            slug: o.slug,
            success: o.success,
            ...(typeof o.verifyJwt === "boolean" ? { verifyJwt: o.verifyJwt } : {}),
            ...(typeof o.error === "string" ? { error: o.error } : {}),
          },
        ];
      })
    : [];
  return {
    slugs: r.slugs as string[],
    source_repo: str(r.source_repo),
    source_sha: str(r.source_sha),
    digest: str(r.digest),
    deployed_at: str(r.deployed_at),
    results,
    retired: Array.isArray(r.retired)
      ? (r.retired as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
    checked_at: str(r.checked_at) ?? "",
  };
}

export type OwnedDeployDecision =
  | { act: "refuse"; why: string }
  | { act: "none"; why: string }
  | { act: "skip"; why: string }
  | { act: "deploy"; slugs: string[]; why: string };

/**
 * Whether this pass deploys, and which.
 *
 * Everything owned when the bundles changed since the record (or there is no
 * record); otherwise only the slugs that are missing from the project or whose
 * last deploy failed. Nothing when the record is current — which is the
 * steady state and what keeps a half-hourly sweep from redeploying for ever.
 *
 * **Where there is nowhere to record** (`recordable: false` — a deployment the
 * column's migration has not reached) the record can never become current, so
 * "no record, deploy everything" would redeploy every owned function on every
 * sweep until the migration lands. There the decision is the project's alone:
 * deploy what it does not run, and nothing else. What that cannot see is a
 * change to a function the project already runs, and the skip says so rather
 * than implying the function is current.
 */
export function decideOwnedDeploy(input: {
  owned: readonly string[];
  digest: string | null;
  recorded: CloneOwnedFunctionsRecord | null;
  /** Slugs live on the project, or null when they could not be read. */
  live: readonly string[] | null;
  /**
   * Whether a record can be written. False where the column does not exist
   * yet; the default is true, the steady state.
   */
  recordable?: boolean;
  /** Deploy everything owned whatever the record says. */
  force?: boolean;
}): OwnedDeployDecision {
  const { owned, digest, recorded, live } = input;
  if (owned.length > MAX_OWNED_FUNCTIONS) {
    return {
      act: "refuse",
      why:
        `the repository declares ${owned.length} functions the prime does not ` +
        `(${owned.slice(0, 5).join(", ")}${owned.length > 5 ? ", …" : ""}) — more than ` +
        `${MAX_OWNED_FUNCTIONS}, which means the prime's list was misread or the clone has ` +
        "diverged; none were deployed from the clone's copy",
    };
  }
  if (owned.length === 0) {
    return { act: "none", why: "the repository declares no function the prime does not" };
  }
  if (input.force) {
    return {
      act: "deploy",
      slugs: [...owned],
      why: "a redeploy of every owned function was asked for",
    };
  }
  if (input.recordable === false) {
    // No record can be kept, so liveness is the only reading. An unread
    // project reads as nothing live — the conservative side, three idempotent
    // deploys — never as "all live", which would leave a new clone without
    // its functions on the one pass that exists to give them to it.
    const liveSet = live ? new Set(live) : null;
    const missing = liveSet ? owned.filter((s) => !liveSet.has(s)) : [...owned];
    if (missing.length === 0) {
      return {
        act: "skip",
        why:
          "every owned function is live; with nowhere to record a deploy yet, a change to one " +
          "the project already runs is not detected until the record's column exists",
      };
    }
    return {
      act: "deploy",
      slugs: [...missing].sort(),
      why: liveSet
        ? `not on the project: ${missing.join(", ")}`
        : "the project's functions could not be read and there is no record to trust instead",
    };
  }
  if (!recorded || recorded.digest === null) {
    return {
      act: "deploy",
      slugs: [...owned],
      why: "no deploy of these functions from the clone's repository is on record",
    };
  }
  if (recorded.digest !== digest) {
    return {
      act: "deploy",
      slugs: [...owned],
      why: "the files these functions are built from changed since they were last deployed",
    };
  }
  const liveSet = live ? new Set(live) : null;
  const succeeded = new Set(recorded.results.filter((r) => r.success).map((r) => r.slug));
  const missing = liveSet ? owned.filter((s) => !liveSet.has(s)) : [];
  const failed = owned.filter((s) => !succeeded.has(s));
  const pending = [...new Set([...missing, ...failed])].sort();
  if (pending.length === 0) {
    return {
      act: "skip",
      why: liveSet
        ? "every owned function is live and current"
        : "the record is current; the project's functions could not be read, so the record is trusted",
    };
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`not on the project: ${missing.join(", ")}`);
  const failedOnly = failed.filter((s) => !missing.includes(s));
  if (failedOnly.length > 0) parts.push(`last deploy failed: ${failedOnly.join(", ")}`);
  return { act: "deploy", slugs: pending, why: parts.join("; ") };
}

/**
 * The latest result per owned slug: this pass's where it deployed, the
 * record's where it did not. Slugs no longer owned drop out.
 */
export function mergeOwnedResults(
  previous: readonly OwnedFunctionResult[],
  fresh: readonly OwnedFunctionResult[],
  owned: readonly string[],
): OwnedFunctionResult[] {
  const byFresh = new Map(fresh.map((r) => [r.slug, r]));
  const byPrevious = new Map(previous.map((r) => [r.slug, r]));
  return [...owned].sort().flatMap((slug) => {
    const r = byFresh.get(slug) ?? byPrevious.get(slug);
    return r ? [r] : [];
  });
}

/**
 * Slugs the clone once owned and no longer declares. Kept only while the
 * project still runs them, when that is known — a retired function the
 * project no longer has is nothing to report.
 */
export function retiredOwnedSlugs(
  recorded: CloneOwnedFunctionsRecord | null,
  owned: readonly string[],
  live: readonly string[] | null,
): string[] {
  if (!recorded) return [];
  const ownedSet = new Set(owned);
  const liveSet = live ? new Set(live) : null;
  return [...new Set([...recorded.retired, ...recorded.slugs])]
    .filter((s) => !ownedSet.has(s))
    .filter((s) => (liveSet ? liveSet.has(s) : true))
    .sort();
}

/**
 * The record this pass leaves. `deployed` is what it attempted (possibly
 * nothing); the digest is the one read this pass, because after a deploy
 * every owned slug either succeeded against it or carries a failed result
 * that the next pass retries.
 */
export function nextOwnedRecord(input: {
  recorded: CloneOwnedFunctionsRecord | null;
  owned: readonly string[];
  digest: string | null;
  sourceRepo: string;
  sourceSha: string;
  live: readonly string[] | null;
  fresh: readonly OwnedFunctionResult[];
  now: string;
}): CloneOwnedFunctionsRecord {
  const { recorded, owned, fresh, now } = input;
  return {
    slugs: [...owned].sort(),
    source_repo: input.sourceRepo,
    source_sha: input.sourceSha,
    digest: input.digest,
    deployed_at: fresh.length > 0 ? now : (recorded?.deployed_at ?? null),
    results: mergeOwnedResults(recorded?.results ?? [], fresh, owned),
    retired: retiredOwnedSlugs(recorded, owned, input.live),
    checked_at: now,
  };
}

/** How often an unchanged record is re-stamped, so a live lane is visibly live. */
export const OWNED_RECORD_HEARTBEAT_MS = 24 * 3600_000;

/**
 * Whether this pass writes its record.
 *
 * Always when anything but `checked_at` differs; otherwise once a day. Not on
 * every pass, because every write to `clone_backends` bumps `updated_at`,
 * which the provisioning drain reads as liveness and as queue order — a
 * half-hourly sweep stamping unchanged rows would be noise in both.
 */
export function ownedRecordDue(
  before: CloneOwnedFunctionsRecord | null,
  after: CloneOwnedFunctionsRecord,
  nowMs: number,
): boolean {
  if (!before) return true;
  const strip = (r: CloneOwnedFunctionsRecord) => JSON.stringify({ ...r, checked_at: "" });
  if (strip(before) !== strip(after)) return true;
  const last = Date.parse(before.checked_at);
  return !Number.isFinite(last) || nowMs - last >= OWNED_RECORD_HEARTBEAT_MS;
}
