/**
 * Ask prime's own history what happened to a path the clone has and prime does
 * not.
 *
 * The tree comparison that produces these candidates cannot tell a file prime
 * deleted from a file the clone invented. Only prime's history can, so this is
 * where the cascade goes and asks — one question per candidate, and a second
 * only when the answer was "prime removed it".
 *
 * ## One call, then a walk that usually stops immediately
 *
 * `listCommits({ path })` returns every commit that touched the path, newest
 * first, in one request. Because the path is absent from prime's head the first
 * of them is the removal, and the rest are the revisions prime held. Reading
 * the path at each gives those versions.
 *
 * The walk stops at the first version that matches the clone's copy, so a clone
 * that is current on the file pays one extra call and only a genuinely stale
 * one pays more. Whether the walk reached the END of the history travels with
 * the answer: without that, a blob missing from the list cannot be told apart
 * from one further back than we looked.
 *
 * The removing commit's own `files[]` carries a pre-image blob SHA and would
 * save the first of those calls. It is deliberately not used: on a merge commit
 * that list is computed against the first parent and can omit or re-attribute a
 * path, and a 300-file cap silently truncates it. Being wrong here does not
 * fail loudly — it deletes the wrong file.
 *
 * ## What a failure means
 *
 * Nothing is ever deleted on a failed read. Every error path here returns
 * `unsettled`, which `decideDeletion` keeps. That is the same rule the
 * exclusion policy runs on: a read that FAILED is not a fact that is ABSENT.
 */
import type { getAppOctokit } from "./github-app.server";
import type { RepoRef } from "./github-app.server";
import {
  MAX_DELETION_PROBES,
  MAX_VERSION_WALK,
  orderDeletionCandidates,
  type DeletionCandidate,
  type DeletionEvidence,
} from "./cascade/deletionPropagation.pure";
import { MAX_HOLD_RELEASE_PROBES, type HeldPathEvidence } from "./cascade/heldEvidence.pure";
import { mapWithConcurrency } from "@/lib/concurrency";

type Octo = ReturnType<typeof getAppOctokit>;

/**
 * What prime's history says about one path.
 *
 * Walks back through the versions prime held, newest first, and stops the
 * moment one matches the clone's copy — so a file the clone is current on
 * costs one extra call and a stale one costs a few.
 *
 * Exported for the probe's own test; the engine calls `probeDeletions`.
 */
export async function probePrimeDeletion(
  octokit: Octo,
  primeRef: RepoRef,
  path: string,
  cloneSha: string,
): Promise<DeletionEvidence> {
  let commits: Array<{ sha: string }>;
  try {
    const { data } = await octokit.repos.listCommits({
      owner: primeRef.owner,
      repo: primeRef.repo,
      sha: primeRef.branch,
      path,
      // One more than the walk, so a full page tells us the history did not end.
      per_page: MAX_VERSION_WALK + 1,
    });
    if (!Array.isArray(data) || data.length === 0) return { kind: "never_primes" };
    commits = data as Array<{ sha: string }>;
  } catch (e) {
    return { kind: "unsettled", why: reasonOf(e) };
  }

  const deletedIn = commits[0].sha;
  // The walk is exhaustive when the page did not fill: GitHub returned every
  // commit that touched this path, so a blob absent from the list is a blob
  // prime never had here.
  const versionsExhaustive = commits.length <= MAX_VERSION_WALK;
  const walk = commits.slice(0, MAX_VERSION_WALK);

  const versions: string[] = [];
  for (const commit of walk) {
    const sha = await blobAt(octokit, primeRef, path, commit.sha);
    if (!sha) continue; // the removing commit itself, or an unreadable revision
    if (!versions.includes(sha)) versions.push(sha);
    // Early exit. Everything older is irrelevant once we know the clone holds
    // a version prime had.
    if (sha === cloneSha) return { kind: "removed", deletedIn, versions, versionsExhaustive };
  }

  return { kind: "removed", deletedIn, versions, versionsExhaustive };
}

/** The blob prime held at `path` in `ref`, or null if it held none. */
async function blobAt(
  octokit: Octo,
  primeRef: RepoRef,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({
      owner: primeRef.owner,
      repo: primeRef.repo,
      path,
      ref,
    });
    // A directory answers with an array. That means the path is not the file we
    // think it is, and nothing should be decided on the strength of it.
    if (Array.isArray(data) || !("sha" in data) || typeof data.sha !== "string") return null;
    return data.sha;
  } catch {
    // A 404 is the ordinary answer at the commit that removed the file.
    return null;
  }
}

/**
 * Probe a bounded set of candidates, concurrently.
 *
 * The order comes from `orderDeletionCandidates`, which spends the budget on
 * the candidates that can produce a deletion first; the overflow is reported
 * rather than dropped silently.
 */
export async function probeDeletions(args: {
  octokit: Octo;
  primeRef: RepoRef;
  candidates: ReadonlyArray<{ path: string; cloneSha: string }>;
  /** Directories prime's tree contains, for probe ordering only. */
  primeDirectories: ReadonlySet<string>;
  maxProbes?: number;
  /** Slides the probe window between passes — see `orderDeletionCandidates`. */
  rotation?: number;
}): Promise<{ candidates: DeletionCandidate[]; unprobed: number }> {
  const max = args.maxProbes ?? MAX_DELETION_PROBES;
  const ordered = orderDeletionCandidates(
    args.candidates,
    args.primeDirectories,
    args.rotation ?? 0,
  );
  const probing = ordered.slice(0, max);

  // Four at a time. The write path already runs eight concurrent content reads
  // against the same secondary rate limit, and this runs before it in the same
  // request — a cascade refused for hammering GitHub delivers nothing at all.
  const probed = await mapWithConcurrency<{ path: string; cloneSha: string }, DeletionCandidate>(
    probing,
    4,
    async (c) => ({
      path: c.path,
      cloneSha: c.cloneSha,
      evidence: await probePrimeDeletion(args.octokit, args.primeRef, c.path, c.cloneSha),
    }),
  );

  return { candidates: probed, unprobed: ordered.length - probing.length };
}

function reasonOf(e: unknown): string {
  if (e && typeof e === "object" && "status" in e) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === "number") return `HTTP ${status}`;
  }
  return e instanceof Error ? e.message : "unknown error";
}

// ─────────────────────────────────────────────────────────────────────────────
// The same walk, asked about a path prime STILL HOLDS.
//
// `decideHoldRelease` (cascade/heldEvidence.pure.ts) needs the same evidence
// the deletion rule runs on — "is the clone's blob a version prime itself
// held at this path?" — for a `manual_reconcile` path that differs upstream.
// The mechanics are identical to `probePrimeDeletion`: one `listCommits` for
// the path, then the blob at each revision, newest first, stopping at the
// first match. Only the reading differs: on a live path the first commit is
// the newest edit rather than the removal, so the answer carries no
// `deletedIn` and the versions include prime's current content.
// ─────────────────────────────────────────────────────────────────────────────

/** What versions prime has held at a path it still has. */
export async function probePrimeVersions(
  octokit: Octo,
  primeRef: RepoRef,
  path: string,
  cloneSha: string,
): Promise<HeldPathEvidence> {
  let commits: Array<{ sha: string }>;
  try {
    const { data } = await octokit.repos.listCommits({
      owner: primeRef.owner,
      repo: primeRef.repo,
      sha: primeRef.branch,
      path,
      per_page: MAX_VERSION_WALK + 1,
    });
    if (!Array.isArray(data) || data.length === 0) return { kind: "never_primes" };
    commits = data as Array<{ sha: string }>;
  } catch (e) {
    return { kind: "unsettled", why: reasonOf(e) };
  }

  const versionsExhaustive = commits.length <= MAX_VERSION_WALK;
  const walk = commits.slice(0, MAX_VERSION_WALK);

  const versions: string[] = [];
  for (const commit of walk) {
    const sha = await blobAt(octokit, primeRef, path, commit.sha);
    if (!sha) continue;
    if (!versions.includes(sha)) versions.push(sha);
    if (sha === cloneSha) return { kind: "prime_versions", versions, versionsExhaustive };
  }

  return { kind: "prime_versions", versions, versionsExhaustive };
}

/**
 * Probe a bounded set of held paths, concurrently, at the same width as the
 * deletion probe and for the same reason: this runs inside the pass, before
 * the write path's own eight-wide content reads.
 */
export async function probeHeldPaths(args: {
  octokit: Octo;
  primeRef: RepoRef;
  candidates: ReadonlyArray<{ path: string; cloneSha: string }>;
  maxProbes?: number;
}): Promise<Map<string, HeldPathEvidence>> {
  const max = args.maxProbes ?? MAX_HOLD_RELEASE_PROBES;
  const probing = args.candidates.slice(0, max);
  const out = new Map<string, HeldPathEvidence>();
  await mapWithConcurrency(probing, 4, async (c) => {
    out.set(c.path, await probePrimeVersions(args.octokit, args.primeRef, c.path, c.cloneSha));
  });
  return out;
}
