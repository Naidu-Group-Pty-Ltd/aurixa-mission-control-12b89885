/**
 * The reads a held line variant's three-way merge needs, and nothing else.
 *
 * The rule and its safety argument are in `variantMerge.pure.ts`. This module
 * only gathers the three texts and the base:
 *
 *   1. the commits on the clone's default branch that touched the path,
 *      newest first — the base is the prime revision the newest of them that
 *      names one names (`variantBaseFrom`). The engine passes the clone's
 *      head COMMIT as `cloneRef.branch`, so this history and the copy of ours
 *      in step 3 are read at the commit the kept verdict is keyed to, never
 *      at a branch that moved in between;
 *   2. prime's copy at that revision (the base), resolved to a full SHA first
 *      so an abbreviated name is never read as a branch. A reconcile naming
 *      several revisions gives several bases, each resolved and read, and
 *      `decideAcrossBases` merges against all of them; two names for one
 *      commit (an abbreviation at two lengths) are one base;
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
 * Five requests at most per path naming one revision (the commit list, the
 * revision, and the three file reads), four once the revision is cached; one
 * naming several adds a revision and a read for each, to at most nine. The
 * engine bounds the number of paths it asks about rather than the requests.
 */
import type { Octokit } from "@octokit/rest";
import {
  getFileContent,
  OversizeFileError,
  type RepoFile,
  type RepoRef,
} from "../github-app.server";
import { gitBlobSha } from "./gitBlobSha.pure";
import {
  decideAcrossBases,
  decideVariantMerge,
  MAX_AGREEING_BASES,
  variantBaseFrom,
  type VariantHistoryCommit,
  type VariantMergeVerdict,
} from "./variantMerge.pure";

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

  let commits: VariantHistoryCommit[];
  try {
    const { data } = await octokit.repos.listCommits({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      sha: cloneRef.branch,
      path,
      per_page: VARIANT_BASE_COMMITS,
    });
    commits = data.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      root: Array.isArray(c.parents) && c.parents.length === 0,
      date: c.commit.committer?.date ?? c.commit.author?.date ?? undefined,
    }));
  } catch (e) {
    return {
      act: "hold",
      why: `the line's history of this file could not be read (${msg(e)})`,
      ...(isTransientReadFailure(e) ? { transient: true as const } : {}),
    };
  }
  const named = variantBaseFrom(commits);
  if (named.kind === "none") return decideVariantMerge({ base: null, ours: "", theirs: "" });
  if (named.kind === "mirror") {
    return mergeOnMirrorBase({ ...args, root: named.commit, madeAt: named.date });
  }
  const names = named.kind === "named" ? [named.primeRevision] : named.primeRevisions;
  if (names.length > MAX_AGREEING_BASES) {
    // Refused before a request is spent on it; nothing was read, so no text.
    return decideAcrossBases({
      commit: named.commit,
      bases: names.map((revision) => ({ revision, text: null })),
      ours: "",
      theirs: "",
    });
  }

  // Each name resolved to the commit it means. One at a time: they almost
  // always share the cache, and a failure stops before spending the rest.
  const resolved: string[] = [];
  for (const name of names) {
    let revision = revisions?.get(name);
    if (!revision) {
      try {
        const { data } = await octokit.repos.getCommit({
          owner: primeRef.owner,
          repo: primeRef.repo,
          ref: name,
        });
        revision = data.sha;
        revisions?.set(name, revision);
      } catch (e) {
        return {
          act: "hold",
          why: `prime@${name} could not be resolved (${msg(e)})`,
          ...(isTransientReadFailure(e) ? { transient: true as const } : {}),
        };
      }
    }
    if (!resolved.includes(revision)) resolved.push(revision);
  }

  let bases: (RepoFile | null)[];
  let ours: RepoFile | null;
  let theirs: RepoFile | null;
  try {
    [ours, theirs, ...bases] = await Promise.all([
      getFileContent(octokit, cloneRef, path, { maxBytes }),
      getFileContent(octokit, primeRef, path, { maxBytes }),
      ...resolved.map((revision) =>
        getFileContent(octokit, { ...primeRef, branch: revision }, path, { maxBytes }),
      ),
    ]);
  } catch (e) {
    return {
      act: "hold",
      why: `a copy of this file could not be read (${msg(e)})`,
      ...(isTransientReadFailure(e) ? { transient: true as const } : {}),
    };
  }
  if (!ours || !theirs) return { act: "hold", why: "this file is not on both sides to merge" };
  if (ours.binary || theirs.binary || bases.some((b) => b?.binary)) {
    return { act: "hold", why: "a binary file is never merged line by line" };
  }
  return decideAcrossBases({
    commit: named.commit,
    bases: resolved.map((revision, i) => ({
      revision,
      text: bases[i] ? bases[i].content : null,
    })),
    ours: ours.content,
    theirs: theirs.content,
  });
}

/**
 * A held variant whose history names no revision and begins at the clone's
 * first commit (`variantBaseFrom` → `mirror`; "The copy the clone was made
 * with" there says why that copy is a prime version).
 *
 * Which prime revision held it is read off the prime's own history of the
 * path: the newest prime commit that touched it before the clone was made.
 * That revision's copy is the base only where it is byte-identical to the
 * clone's first copy — the copy the line's own edits were made on — and any
 * other answer holds for a person exactly as a path with no base always has.
 *
 * Five requests at most: the prime's history of the path, then the line's
 * copy, the prime's current copy, the base, and the clone's first copy. The
 * revision is kept in the pass's cache under the path, because it depends on
 * the path's own history.
 */
async function mergeOnMirrorBase(args: {
  octokit: Octokit;
  cloneRef: RepoRef;
  primeRef: RepoRef;
  path: string;
  maxBytes: number;
  revisions?: Map<string, string>;
  /** The clone's first commit. */
  root: string;
  /** When it was made. */
  madeAt: string;
}): Promise<VariantMergeVerdict> {
  const { octokit, cloneRef, primeRef, path, maxBytes, revisions } = args;
  const cacheKey = `mirror:${args.root}:${path}`;
  let revision = revisions?.get(cacheKey);
  if (!revision) {
    try {
      const { data } = await octokit.repos.listCommits({
        owner: primeRef.owner,
        repo: primeRef.repo,
        sha: primeRef.branch,
        path,
        until: args.madeAt,
        per_page: 1,
      });
      revision = data[0]?.sha;
    } catch (e) {
      return {
        act: "hold",
        why: `the prime's history of this file could not be read (${msg(e)})`,
        ...(isTransientReadFailure(e) ? { transient: true as const } : {}),
      };
    }
    if (!revision) {
      return {
        act: "hold",
        why: "no commit on this line names the prime revision it was reconciled to, and the prime held no copy of it when this clone was made",
      };
    }
    revisions?.set(cacheKey, revision);
  }

  let ours: RepoFile | null;
  let theirs: RepoFile | null;
  let base: RepoFile | null;
  let first: RepoFile | null;
  try {
    [ours, theirs, base, first] = await Promise.all([
      getFileContent(octokit, cloneRef, path, { maxBytes }),
      getFileContent(octokit, primeRef, path, { maxBytes }),
      getFileContent(octokit, { ...primeRef, branch: revision }, path, { maxBytes }),
      getFileContent(octokit, { ...cloneRef, branch: args.root }, path, { maxBytes }),
    ]);
  } catch (e) {
    return {
      act: "hold",
      why: `a copy of this file could not be read (${msg(e)})`,
      ...(isTransientReadFailure(e) ? { transient: true as const } : {}),
    };
  }
  if (!ours || !theirs) return { act: "hold", why: "this file is not on both sides to merge" };
  if (!base || !first || base.sha !== first.sha) {
    return {
      act: "hold",
      why:
        "no commit on this line names the prime revision it was reconciled to, and the copy " +
        `this clone was made with is not prime@${revision.slice(0, 7)}'s, so it cannot stand as the base`,
    };
  }
  if (ours.binary || theirs.binary || base.binary) {
    return { act: "hold", why: "a binary file is never merged line by line" };
  }
  return decideVariantMerge({
    base: { revision, text: base.content },
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
