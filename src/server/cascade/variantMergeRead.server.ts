/**
 * The reads a held line variant's three-way merge needs, and nothing else.
 *
 * The rule and its safety argument are in `variantMerge.pure.ts`. This module
 * only gathers the three texts and the base:
 *
 *   1. the commits on the clone's default branch that touched the path,
 *      newest first — the base is the prime revision the newest of them that
 *      names one names (`variantBaseFrom`);
 *   2. prime's copy at that revision (the base), resolved to a full SHA first
 *      so an abbreviated name is never read as a branch;
 *   3. the clone's copy (ours) and prime's current copy (theirs).
 *
 * Every failure is a hold, never a guess: a read that FAILED is not a fact
 * that is ABSENT, and the safe side of a failed merge is yesterday's
 * behaviour — the file stays held for a person. A failure a retry could
 * change is marked `transient`, so the ledger records the path as asked
 * without recording the hold as its answer (`passProgress.pure.ts`): a
 * transient hold is asked again on a later pass, after every path that was
 * never asked at all.
 *
 * Four requests at most per path (the commit list, the revision, and the
 * three file reads minus the one a caller already holds), so the engine
 * bounds the number of paths it asks about rather than the requests.
 */
import type { Octokit } from "@octokit/rest";
import {
  getFileContent,
  OversizeFileError,
  type RepoFile,
  type RepoRef,
} from "../github-app.server";
import { gitBlobSha } from "./gitBlobSha.pure";
import { decideVariantMerge, variantBaseFrom, type VariantMergeVerdict } from "./variantMerge.pure";

/** How far back the clone's history of one path is read for a named base. */
export const VARIANT_BASE_COMMITS = 30;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const statusOf = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;

/**
 * Whether a failed read could answer differently if asked again. A 404 or a
 * 422 is the server's statement about the thing asked for, and an oversize
 * file stays oversize; anything else (a 5xx, a rate limit, a dropped
 * connection) is a statement about the moment.
 */
export function isTransientReadFailure(e: unknown): boolean {
  if (e instanceof OversizeFileError) return false;
  const status = statusOf(e);
  return status !== 404 && status !== 422;
}

export async function mergeHeldVariant(args: {
  octokit: Octokit;
  cloneRef: RepoRef;
  primeRef: RepoRef;
  path: string;
  maxBytes: number;
  /**
   * Named revision → its full SHA, shared across one pass's merges. Most of a
   * line's held paths name the same reconcile, so this saves one request on
   * all but the first.
   */
  revisions?: Map<string, string>;
}): Promise<VariantMergeVerdict> {
  const { octokit, cloneRef, primeRef, path, maxBytes, revisions } = args;

  let commits: { sha: string; message: string }[];
  try {
    const { data } = await octokit.repos.listCommits({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      sha: cloneRef.branch,
      path,
      per_page: VARIANT_BASE_COMMITS,
    });
    commits = data.map((c) => ({ sha: c.sha, message: c.commit.message }));
  } catch (e) {
    return {
      act: "hold",
      why: `the line's history of this file could not be read (${msg(e)})`,
      ...(isTransientReadFailure(e) ? { transient: true as const } : {}),
    };
  }
  const named = variantBaseFrom(commits);
  if (named.kind === "ambiguous") {
    return {
      act: "hold",
      why: `its newest reconcile (${named.commit.slice(0, 7)}) names more than one prime revision`,
    };
  }
  if (named.kind === "none") return decideVariantMerge({ base: null, ours: "", theirs: "" });

  let revision: string;
  const cached = revisions?.get(named.primeRevision);
  if (cached) {
    revision = cached;
  } else {
    try {
      const { data } = await octokit.repos.getCommit({
        owner: primeRef.owner,
        repo: primeRef.repo,
        ref: named.primeRevision,
      });
      revision = data.sha;
      revisions?.set(named.primeRevision, revision);
    } catch (e) {
      return {
        act: "hold",
        why: `prime@${named.primeRevision} could not be resolved (${msg(e)})`,
        ...(isTransientReadFailure(e) ? { transient: true as const } : {}),
      };
    }
  }

  let base: RepoFile | null;
  let ours: RepoFile | null;
  let theirs: RepoFile | null;
  try {
    [base, ours, theirs] = await Promise.all([
      getFileContent(octokit, { ...primeRef, branch: revision }, path, { maxBytes }),
      getFileContent(octokit, cloneRef, path, { maxBytes }),
      getFileContent(octokit, primeRef, path, { maxBytes }),
    ]);
  } catch (e) {
    return {
      act: "hold",
      why: `a copy of this file could not be read (${msg(e)})`,
      ...(isTransientReadFailure(e) ? { transient: true as const } : {}),
    };
  }
  if (!ours || !theirs) return { act: "hold", why: "this file is not on both sides to merge" };
  if (ours.binary || theirs.binary || base?.binary) {
    return { act: "hold", why: "a binary file is never merged line by line" };
  }
  return decideVariantMerge({
    base: { revision, text: base ? base.content : null },
    ours: ours.content,
    theirs: theirs.content,
  });
}

/**
 * Store a merge's text as a blob in the clone's repository, so a later pass
 * can take the verdict without merging again. The id is the text's own
 * (`gitBlobSha`) — a blob's id depends on its bytes alone — and the returned
 * id is checked against it, so the ledger never names a blob that does not
 * hold this text.
 */
export async function storeMergedVariant(
  octokit: Octokit,
  cloneRef: RepoRef,
  text: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.git.createBlob({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    });
    return data.sha === gitBlobSha(text) ? data.sha : null;
  } catch {
    // Not stored is not remembered: the next pass merges again.
    return null;
  }
}

/**
 * Read a stored merge back, or nothing. Nothing on any doubt — a failed
 * read, a blob that is not text, bytes whose id is not the one asked for —
 * and the caller merges again: a missed reuse costs one merge, a wrong one
 * delivers bytes nobody merged.
 */
export async function readMergedVariant(
  octokit: Octokit,
  cloneRef: RepoRef,
  blob: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.git.getBlob({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      file_sha: blob,
    });
    if (data.encoding !== "base64" && data.encoding !== "utf-8") return null;
    const text =
      data.encoding === "base64"
        ? Buffer.from(data.content, "base64").toString("utf8")
        : data.content;
    return gitBlobSha(text) === blob ? text : null;
  } catch {
    return null;
  }
}
