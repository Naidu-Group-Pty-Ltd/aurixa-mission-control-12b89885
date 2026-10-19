/**
 * Propose the refreshed digest manifest on Mission Control's own repository,
 * as a pull request that lands itself once CI passes.
 *
 * Mission Control's repository, never Prime's (`missionControlRepo.pure.ts`):
 * the manifest records what Mission Control's own migration queue ran. The
 * first version of this read `prime_config` and opened its pull request on
 * Prime (19 Oct 2026); `retractStrayDigestProposal` takes that back.
 *
 * ## Why this moved out of the workflow
 *
 * `apply-migrations.yml` used to commit `scripts/applied-migration-digests.txt`
 * and push it straight to `main` with the job's own token — 47 commits from
 * github-actions[bot] up to 14 Oct 2026. Mission Control's default branch is
 * protected now (`missionControlBranchProtection.pure.ts`): nothing lands
 * except through a pull request whose CI passed, and no workflow token is on
 * the bypass list, because "any workflow token can push to main" is the hole
 * that protection closes. So the job asks Mission Control, and Mission Control
 * proposes the file through its App, as a pull request like any other change.
 * The job keeps `contents: read` — the job that holds CRON_SECRET no longer
 * holds a write token as well.
 *
 * ## How it lands with nobody there
 *
 * Auto-merge, armed on the proposal: GitHub merges it when the required checks
 * pass and not before. `ensureMissionControlBranchProtection` allows
 * auto-merge on the repository for exactly this. Where it cannot be armed the
 * pull request stays open and the answer says why. Either way there is only
 * ever one: every refresh moves the same branch, which holds nothing but this
 * generated file, so moving it by force loses nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "@/server/github-app.server";
import { readSettledDigests } from "@/server/migration-enqueue.server";
import { renderManifest } from "@/server/appliedDigestManifest.pure";
import { isPrimeRepo, missionControlRepo, parseRepoName } from "@/server/missionControlRepo.pure";

type Db = SupabaseClient<Database>;

export const DIGEST_MANIFEST_PATH = "scripts/applied-migration-digests.txt";
export const DIGEST_BRANCH = "mission-control/applied-digests";
export const DIGEST_PR_TITLE = "Refresh the applied-migration digest manifest";

export type DigestProposal =
  | { state: "current"; detail: string }
  | { state: "proposed"; number: number; url: string; armed: boolean; detail: string }
  | { state: "failed"; detail: string };

const statusOf = (e: unknown) => (e as { status?: number })?.status;
const messageOf = (e: unknown) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
  (e instanceof Error ? e.message : String(e));

const PR_BODY =
  "Written by Mission Control after a migration push settled: the digests of what " +
  "`public.schema_migration_queue` actually ran, so `check:applied-digests` can judge every " +
  "pull request against them offline.\n\n" +
  "Generated — do not edit. It merges itself once CI passes; a later refresh replaces it. " +
  "Locally: `npm run migrations:digests`.";

export async function proposeAppliedDigests(
  db: Db,
  opts: { requestedBy?: string | null } = {},
): Promise<DigestProposal> {
  const target = missionControlRepo();
  // The apply workflow says which repository it runs in. A refresh asked for
  // from anywhere else is not a refresh of this queue's manifest.
  if (opts.requestedBy != null) {
    const asker = parseRepoName(opts.requestedBy);
    if (!asker || asker.fullName.toLowerCase() !== target.fullName.toLowerCase()) {
      return {
        state: "failed",
        detail:
          `Asked for by ${String(opts.requestedBy).slice(0, 120)}, but this migration queue's ` +
          `manifest lives in ${target.fullName}. Nothing was proposed.`,
      };
    }
  }
  const { data: prime } = await db
    .from("prime_config")
    .select("github_owner, github_repo")
    .limit(1)
    .maybeSingle();
  if (isPrimeRepo(target, prime)) {
    return {
      state: "failed",
      detail: `${target.fullName} is Prime's repository; Mission Control's manifest never goes there.`,
    };
  }

  const digests = await readSettledDigests(db);
  // Zero settled rows is not a state the queue can be in, so it is a failed
  // read — and proposing it would erase every entry in the manifest.
  if (digests.length === 0) {
    return {
      state: "failed",
      detail: "The queue reported no settled migrations at all; nothing was proposed.",
    };
  }

  const { owner, repo } = target;
  // The App's default installation, which is the organisation's.
  const octokit = getAppOctokit();
  const { data: repoData } = await octokit.repos.get({ owner, repo });
  const base = repoData.default_branch || "main";

  const { data: tip } = await octokit.repos.getBranch({ owner, repo, branch: base });
  let existing = "";
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path: DIGEST_MANIFEST_PATH,
      ref: tip.commit.sha,
    });
    const file = data as { type?: string; content?: string };
    if (file.type === "file" && typeof file.content === "string") {
      existing = Buffer.from(file.content, "base64").toString("utf8");
    }
  } catch (e) {
    if (statusOf(e) !== 404) throw e;
  }

  const rendered = renderManifest(existing, digests);
  const { data: open } = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${DIGEST_BRANCH}`,
    base,
    state: "open",
    per_page: 5,
  });

  if (rendered === existing) {
    // A proposal still open from an earlier refresh says nothing `main` does not.
    for (const pr of open) {
      await octokit.pulls
        .update({ owner, repo, pull_number: pr.number, state: "closed" })
        .catch(() => undefined);
    }
    return {
      state: "current",
      detail: `${DIGEST_MANIFEST_PATH} on ${base} already lists all ${digests.length} settled migrations.`,
    };
  }

  const { data: blob } = await octokit.git.createBlob({
    owner,
    repo,
    content: Buffer.from(rendered, "utf8").toString("base64"),
    encoding: "base64",
  });
  const { data: tree } = await octokit.git.createTree({
    owner,
    repo,
    base_tree: tip.commit.commit.tree.sha,
    tree: [{ path: DIGEST_MANIFEST_PATH, mode: "100644", type: "blob", sha: blob.sha }],
  });
  const { data: commit } = await octokit.git.createCommit({
    owner,
    repo,
    message: `${DIGEST_PR_TITLE}\n\n${digests.length} settled migrations, read from the queue by Mission Control.`,
    tree: tree.sha,
    parents: [tip.commit.sha],
  });
  try {
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${DIGEST_BRANCH}`,
      sha: commit.sha,
    });
  } catch (e) {
    if (statusOf(e) !== 422) throw e;
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${DIGEST_BRANCH}`,
      sha: commit.sha,
      force: true,
    });
  }

  let pr = open[0] as { number: number; html_url: string; node_id: string } | undefined;
  if (!pr) {
    const { data } = await octokit.pulls.create({
      owner,
      repo,
      title: DIGEST_PR_TITLE,
      head: DIGEST_BRANCH,
      base,
      body: PR_BODY,
    });
    pr = data;
  }

  let armed = false;
  let why = "";
  try {
    await octokit.graphql(
      `mutation($id: ID!) {
         enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) {
           pullRequest { autoMergeRequest { enabledAt } }
         }
       }`,
      { id: pr.node_id },
    );
    armed = true;
  } catch (e) {
    why = messageOf(e);
    // Armed by an earlier refresh: moving the branch did not disarm it.
    armed = /already/i.test(why);
  }

  return {
    state: "proposed",
    number: pr.number,
    url: pr.html_url,
    armed,
    detail: armed
      ? `PR #${pr.number} carries ${digests.length} settled migrations and merges itself once CI passes.`
      : `PR #${pr.number} carries ${digests.length} settled migrations. Auto-merge could not be armed (${why}), so it waits for a person to merge it once CI passes.`,
  };
}

export type Retraction = { closed: number[]; branchDeleted: boolean; repo: string | null };

/**
 * Take back what the misdirected first refresh put on Prime: its pull request
 * from `mission-control/applied-digests`, and that branch. Nothing else on
 * Prime is touched — only a branch of exactly this name, which nothing but
 * this module has ever written. Idempotent: on a Prime without either it
 * reads two things and changes nothing. Run from the nightly hook.
 */
export async function retractStrayDigestProposal(db: Db): Promise<Retraction> {
  const { data: prime } = await db
    .from("prime_config")
    .select("github_owner, github_repo, github_app_installation_id")
    .limit(1)
    .maybeSingle();
  const target = missionControlRepo();
  if (!prime?.github_owner || !prime?.github_repo || isPrimeRepo(target, prime)) {
    return { closed: [], branchDeleted: false, repo: null };
  }
  const owner = prime.github_owner;
  const repo = prime.github_repo;
  const octokit = getAppOctokit(prime.github_app_installation_id ?? undefined);
  const closed: number[] = [];
  const { data: open } = await octokit.pulls.list({
    owner,
    repo,
    head: `${owner}:${DIGEST_BRANCH}`,
    state: "open",
    per_page: 10,
  });
  for (const pr of open) {
    await octokit.pulls.update({ owner, repo, pull_number: pr.number, state: "closed" });
    closed.push(pr.number);
  }
  let branchDeleted = false;
  try {
    await octokit.git.deleteRef({ owner, repo, ref: `heads/${DIGEST_BRANCH}` });
    branchDeleted = true;
  } catch (e) {
    if (statusOf(e) !== 404 && statusOf(e) !== 422) throw e;
  }
  return { closed, branchDeleted, repo: `${owner}/${repo}` };
}
