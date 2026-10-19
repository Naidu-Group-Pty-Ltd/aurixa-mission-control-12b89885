/**
 * Propose the refreshed digest manifest on Prime, as a pull request that
 * lands itself once CI passes.
 *
 * ## Why this moved out of the workflow
 *
 * `apply-migrations.yml` used to commit `scripts/applied-migration-digests.txt`
 * and push it straight to `main` with the job's own token — 47 commits from
 * github-actions[bot] up to 14 Oct 2026. Prime's default branch is protected
 * now (`primeBranchProtection.pure.ts`): nothing lands except through a pull
 * request whose CI passed, and no workflow token is on the bypass list,
 * because "any workflow token can push to main" is the hole that protection
 * closes. So the job asks Mission Control, and Mission Control proposes the
 * file through its App like every other change it makes to Prime. The job
 * keeps `contents: read` — the job that holds CRON_SECRET no longer holds a
 * write token as well.
 *
 * ## How it lands with nobody there
 *
 * Auto-merge, armed on the proposal: GitHub merges it when the required checks
 * pass and not before. `ensurePrimeBranchProtection` allows auto-merge on the
 * repository for exactly this. Where it cannot be armed the pull request stays
 * open and the answer says why. Either way there is only ever one: every
 * refresh moves the same branch, which holds nothing but this generated file,
 * so moving it by force loses nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "@/server/github-app.server";
import { readSettledDigests } from "@/server/migration-enqueue.server";
import { renderManifest } from "@/server/appliedDigestManifest.pure";

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

export async function proposeAppliedDigests(db: Db): Promise<DigestProposal> {
  const digests = await readSettledDigests(db);
  // Zero settled rows is not a state the queue can be in, so it is a failed
  // read — and proposing it would erase every entry in the manifest.
  if (digests.length === 0) {
    return {
      state: "failed",
      detail: "The queue reported no settled migrations at all; nothing was proposed.",
    };
  }

  const { data: prime } = await db
    .from("prime_config")
    .select("github_owner, github_repo, default_branch, github_app_installation_id")
    .limit(1)
    .maybeSingle();
  if (!prime?.github_owner || !prime?.github_repo) {
    return { state: "failed", detail: "prime_config has no GitHub repository." };
  }
  const owner = prime.github_owner;
  const repo = prime.github_repo;
  const base = prime.default_branch || "main";
  const octokit = getAppOctokit(prime.github_app_installation_id ?? undefined);

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
