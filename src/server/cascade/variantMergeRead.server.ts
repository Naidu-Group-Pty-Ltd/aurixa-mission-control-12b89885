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
 * behaviour — the file stays held for a person.
 *
 * Four requests at most per path (the commit list, the revision, and the
 * three file reads minus the one a caller already holds), so the engine
 * bounds the number of paths it asks about rather than the requests.
 */
import type { Octokit } from "@octokit/rest";
import { getFileContent, type RepoFile, type RepoRef } from "../github-app.server";
import { decideVariantMerge, variantBaseFrom, type VariantMergeVerdict } from "./variantMerge.pure";

/** How far back the clone's history of one path is read for a named base. */
export const VARIANT_BASE_COMMITS = 30;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function mergeHeldVariant(args: {
  octokit: Octokit;
  cloneRef: RepoRef;
  primeRef: RepoRef;
  path: string;
  maxBytes: number;
}): Promise<VariantMergeVerdict> {
  const { octokit, cloneRef, primeRef, path, maxBytes } = args;

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
    return { act: "hold", why: `the line's history of this file could not be read (${msg(e)})` };
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
  try {
    const { data } = await octokit.repos.getCommit({
      owner: primeRef.owner,
      repo: primeRef.repo,
      ref: named.primeRevision,
    });
    revision = data.sha;
  } catch (e) {
    return { act: "hold", why: `prime@${named.primeRevision} could not be resolved (${msg(e)})` };
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
    return { act: "hold", why: `a copy of this file could not be read (${msg(e)})` };
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
