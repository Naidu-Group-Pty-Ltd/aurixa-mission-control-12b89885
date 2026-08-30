/**
 * Ask prime's own history what happened to a path the clone has and prime does
 * not.
 *
 * The tree comparison that produces these candidates cannot tell a file prime
 * deleted from a file the clone invented. Only prime's history can, so this is
 * where the cascade goes and asks — one question per candidate, and a second
 * only when the answer was "prime removed it".
 *
 * ## Two calls, and why not one
 *
 * `listCommits({ path })` gives the last commit that touched the path. Because
 * the path is absent from prime's head, that commit is the one that removed it,
 * and its first parent is where the file was last alive. Reading the path at
 * that parent gives the blob prime deleted — which is the whole point, because
 * the decision is a byte comparison against it.
 *
 * The removing commit's own `files[]` also carries a pre-image blob SHA, which
 * would make this one call instead of two. It is deliberately not used: on a
 * merge commit that list is computed against the first parent and can omit or
 * re-attribute a path, and a 300-file cap silently truncates it. Being wrong
 * here does not fail loudly — it deletes the wrong file. Two calls is the
 * cheaper mistake.
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
  type DeletionCandidate,
  type DeletionEvidence,
} from "./cascade/deletionPropagation.pure";
import { mapWithConcurrency } from "@/lib/concurrency";

type Octo = ReturnType<typeof getAppOctokit>;

/**
 * What prime's history says about one path.
 *
 * Exported for the probe's own test; the engine calls `probeDeletions`.
 */
export async function probePrimeDeletion(
  octokit: Octo,
  primeRef: RepoRef,
  path: string,
): Promise<DeletionEvidence> {
  let removedIn: { sha: string; parent: string | null };
  try {
    const { data } = await octokit.repos.listCommits({
      owner: primeRef.owner,
      repo: primeRef.repo,
      sha: primeRef.branch,
      path,
      per_page: 1,
    });
    if (!Array.isArray(data) || data.length === 0) return { kind: "never_primes" };
    const head = data[0] as { sha: string; parents?: Array<{ sha: string }> };
    removedIn = { sha: head.sha, parent: head.parents?.[0]?.sha ?? null };
  } catch (e) {
    return { kind: "unsettled", why: reasonOf(e) };
  }

  if (!removedIn.parent) {
    // A root commit that also removes the file is not a shape that exists, so
    // this is something unmodelled rather than something to act on.
    return {
      kind: "removed",
      deletedIn: removedIn.sha,
      preImageSha: null,
    };
  }

  try {
    const { data } = await octokit.repos.getContent({
      owner: primeRef.owner,
      repo: primeRef.repo,
      path,
      ref: removedIn.parent,
    });
    // A directory answers with an array. That means the path we are asking
    // about is not the file we think it is, and nothing should be deleted on
    // the strength of it.
    if (Array.isArray(data) || !("sha" in data) || typeof data.sha !== "string") {
      return { kind: "removed", deletedIn: removedIn.sha, preImageSha: null };
    }
    return { kind: "removed", deletedIn: removedIn.sha, preImageSha: data.sha };
  } catch {
    // A 404 here is genuinely strange: the commit that last touched the path
    // did not have it at its parent either. It stays `removed` with no
    // pre-image, which `decideDeletion` routes to `unsettled` — the file is
    // kept, and the reason names the version it could not recover, which is
    // the part an operator can act on.
    return { kind: "removed", deletedIn: removedIn.sha, preImageSha: null };
  }
}

/**
 * Probe a bounded set of candidates, concurrently.
 *
 * Candidates are sorted before the cap so the same run twice asks the same
 * questions, and the overflow is reported rather than dropped silently.
 */
export async function probeDeletions(args: {
  octokit: Octo;
  primeRef: RepoRef;
  candidates: ReadonlyArray<{ path: string; cloneSha: string }>;
  maxProbes?: number;
}): Promise<{ candidates: DeletionCandidate[]; unprobed: number }> {
  const max = args.maxProbes ?? MAX_DELETION_PROBES;
  const ordered = [...args.candidates].sort((a, b) => a.path.localeCompare(b.path));
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
      evidence: await probePrimeDeletion(args.octokit, args.primeRef, c.path),
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
