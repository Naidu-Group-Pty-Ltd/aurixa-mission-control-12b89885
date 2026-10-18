// Server-only helpers for dispatching a Codex Security remediation PR
// workflow. Uses the Aurixa GitHub App to trigger a `workflow_dispatch`
// event on the target repository (Prime or a clone). The workflow itself
// lives in the target repo at `.github/workflows/codex-remediation.yml`
// and is responsible for producing the draft PR and calling the
// remediation callback with the resulting PR URL / state.
//
// Engine: the patch is authored by the OpenAI Codex CLI (`@openai/codex`)
// running inside the target repo's GitHub Actions runner with
// `--sandbox workspace-write`. It edits real files in a checkout of
// `base_ref`; the workflow then verifies the patched tree against the
// repo's own checks, commits, and opens a DRAFT pull request. Mission
// Control never writes code itself. Merging follows the review policy: two
// independent approvals for the PR's current commit, unless the finding sits
// at or below the auto-merge ceiling an admin set (off by default).
//
// Callbacks are authenticated by codex-remediation-callback.server.ts with a
// key derived for each remediation; the master secret never leaves here.

import { getAppOctokit } from "@/server/github-app.server";
import { withRetry, isTransientHttpError } from "@/lib/with-retry";

export const REMEDIATION_ENGINE = "codex_cli";

export type DispatchRemediationInput = {
  remediationId: string;
  owner: string;
  repo: string;
  baseRef: string;
  branchName: string;
  installationId?: string | null;
  finding: {
    id: string;
    title: string;
    severity: string;
    description?: string | null;
    file?: string | null;
    line?: number | null;
    cwe?: string | null;
    /** Offending source excerpt, when the scanner captured one. */
    snippet?: string | null;
    scanner?: string | null;
    ruleId?: string | null;
  };
  callbackUrl: string;
  callbackSecret: string;
  workflowFile?: string;
};

export type DispatchRemediationResult = {
  workflowRunId: number | null;
  workflowRunUrl: string | null;
};

/**
 * Serialise a finding into the workflow's single `finding` input.
 *
 * Field lengths are clamped here as well as in the workflow: this side keeps
 * the dispatch request inside GitHub's payload limit, and the workflow side
 * cannot trust that a repo received its inputs from this code path.
 *
 * `scanner`, `ruleId` and `snippet` matter to patch quality — a title and a
 * line number alone make for weak fixes. They travel as their own fields
 * rather than being stuffed into `description` so the workflow can clamp and
 * present each one on its own terms.
 */
export function buildFindingInput(finding: DispatchRemediationInput["finding"]): string {
  return JSON.stringify({
    id: finding.id,
    title: (finding.title || "").slice(0, 200),
    severity: finding.severity,
    file: finding.file ?? "",
    line: finding.line == null ? "" : String(finding.line),
    cwe: finding.cwe ?? "",
    description: (finding.description ?? "").slice(0, 4000),
    scanner: finding.scanner ?? "",
    ruleId: finding.ruleId ?? "",
    snippet: (finding.snippet ?? "").slice(0, 2000),
  });
}

/**
 * Trigger the codex-remediation workflow on the target repo.
 *
 * The run id is NOT polled for here: `workflow_dispatch` does not return
 * one, and the previous approach (sleep 1.5s, then take the newest matching
 * run) both added latency to every dispatch and could attribute somebody
 * else's concurrent run to this remediation. The workflow reports its own
 * `GITHUB_RUN_ID` in the `workflow.started` callback instead.
 */
export async function dispatchRemediationWorkflow(
  input: DispatchRemediationInput,
): Promise<DispatchRemediationResult> {
  const octokit = getAppOctokit(input.installationId ?? undefined);
  const workflowFile = input.workflowFile || "codex-remediation.yml";

  const inputs = {
    remediation_id: input.remediationId,
    // One JSON field rather than seven flat finding_* inputs: GitHub caps
    // workflow_dispatch at 10 inputs and rejects the entire workflow file
    // past that, so the flat form could never be dispatched at all. The
    // workflow parses this with node and never lets the text reach a shell.
    finding: buildFindingInput(input.finding),
    base_ref: input.baseRef,
    branch_name: input.branchName,
    callback_url: input.callbackUrl,
    callback_secret: input.callbackSecret,
  } as Record<string, string>;

  try {
    await withRetry(
      () =>
        octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: input.owner,
          repo: input.repo,
          workflow_id: workflowFile,
          ref: input.baseRef,
          inputs,
        }),
      { attempts: 3, shouldRetry: isTransientHttpError },
    );
  } catch (err) {
    throw new Error(
      describeRemediationDispatchError(err, input.owner, input.repo, workflowFile, input.baseRef),
    );
  }

  return { workflowRunId: null, workflowRunUrl: null };
}

/**
 * GitHub answers a missing workflow file, a missing branch, and a missing
 * permission all with "Not Found". Say which one it probably is.
 */
function describeRemediationDispatchError(
  err: unknown,
  owner: string,
  repo: string,
  workflowFile: string,
  ref: string,
): string {
  const status = (err as { status?: number })?.status;
  const message =
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    (err instanceof Error ? err.message : String(err));
  const target = `${owner}/${repo}`;

  if (status === 404) {
    return (
      `GitHub returned 404 dispatching ${workflowFile} on ${target}@${ref}. ` +
      `Check that .github/workflows/${workflowFile} exists on branch "${ref}", that the ` +
      `branch exists, and that the Aurixa GitHub App is installed on ${target} with ` +
      `Actions: read & write.`
    );
  }
  if (status === 403) {
    return (
      `GitHub returned 403 dispatching ${workflowFile} on ${target}. The App installation ` +
      `is missing Actions: read & write (re-accept its permissions). Detail: ${message}`
    );
  }
  if (status === 422) {
    return (
      `GitHub rejected the dispatch inputs for ${workflowFile} on ${target}@${ref}: ${message}. ` +
      `The workflow file in the target repo is probably an older revision whose ` +
      `workflow_dispatch inputs no longer match — re-sync the workflow template.`
    );
  }
  return `Remediation dispatch failed for ${target}@${ref}${status ? ` [${status}]` : ""}: ${message}`;
}

/**
 * Take a draft PR out of draft state.
 *
 * Remediation PRs are opened as drafts on purpose, but GitHub refuses to
 * merge a draft ("Draft pull requests cannot be merged", 405) and the REST
 * API has no endpoint to clear the flag — only the GraphQL
 * `markPullRequestReadyForReview` mutation can. Without this step the
 * two-key merge gate could be fully satisfied and merging would still
 * always fail.
 */
export async function markPullRequestReady(input: {
  owner: string;
  repo: string;
  prNumber: number;
  installationId?: string | null;
}): Promise<{ wasDraft: boolean }> {
  const octokit = getAppOctokit(input.installationId ?? undefined);

  const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
  });

  if (!pr?.draft) return { wasDraft: false };

  await octokit.graphql(
    `mutation($id: ID!) {
       markPullRequestReadyForReview(input: { pullRequestId: $id }) {
         pullRequest { isDraft }
       }
     }`,
    { id: pr.node_id },
  );

  return { wasDraft: true };
}

export type RemediationPullRequest = {
  number: number;
  state: string;
  merged: boolean;
  draft: boolean;
  headRef: string;
  headSha: string;
  headRepoFullName: string;
  baseRef: string;
};

/** The PR as GitHub has it now — never as a callback described it. */
export async function fetchRemediationPullRequest(input: {
  owner: string;
  repo: string;
  prNumber: number;
  installationId?: string | null;
}): Promise<RemediationPullRequest> {
  const octokit = getAppOctokit(input.installationId ?? undefined);
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
  });
  const pr = data as {
    number: number;
    state: string;
    merged?: boolean;
    draft?: boolean;
    head: { ref: string; sha: string; repo?: { full_name?: string } | null };
    base: { ref: string };
  };
  return {
    number: pr.number,
    state: pr.state,
    merged: !!pr.merged,
    draft: !!pr.draft,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    headRepoFullName: pr.head.repo?.full_name ?? "",
    baseRef: pr.base.ref,
  };
}

/**
 * Why this PR must not be merged as this remediation, or null when it may.
 *
 * The PR number arrives from a workflow callback. Before anything merges,
 * the PR has to be this remediation's own branch, opened from the same
 * repository (never a fork), still open, and against the base the fix was
 * written for. A forged number that points at some other open PR stops here.
 */
export function remediationPrMismatch(
  pr: RemediationPullRequest,
  expected: { owner: string; repo: string; branchName: string | null; baseRef?: string | null },
): string | null {
  if (pr.state !== "open") return `PR #${pr.number} is ${pr.merged ? "already merged" : pr.state}`;
  if (!expected.branchName)
    return "The remediation has no recorded branch to compare the PR against";
  if (pr.headRef !== expected.branchName) {
    return `PR #${pr.number} is from branch "${pr.headRef}", not this remediation's "${expected.branchName}"`;
  }
  if (pr.headRepoFullName.toLowerCase() !== `${expected.owner}/${expected.repo}`.toLowerCase()) {
    return `PR #${pr.number} comes from ${pr.headRepoFullName || "an unknown repository"}, not ${expected.owner}/${expected.repo}`;
  }
  const base = expected.baseRef ?? "";
  if (base && !/^[0-9a-f]{40}$/i.test(base) && pr.baseRef !== base) {
    return `PR #${pr.number} targets "${pr.baseRef}", not "${base}"`;
  }
  return null;
}

/**
 * Merge a Codex remediation PR via the GitHub App installation. Uses a
 * squash-merge by default so the branch history stays clean. Returns the
 * merge commit SHA on success.
 *
 * The PR is re-read and checked against the remediation first, and the merge
 * is pinned to the head commit that was checked (and, when given, to the
 * commit the approvals name): GitHub refuses the merge if the branch moved in
 * between, so nothing pushed after an approval can ride along with it.
 */
export async function mergeRemediationPRViaGitHub(input: {
  owner: string;
  repo: string;
  prNumber: number;
  installationId?: string | null;
  branchName: string | null;
  baseRef?: string | null;
  /** The head commit the counted approvals were given for. */
  expectedHeadSha?: string | null;
  commitTitle?: string;
  commitMessage?: string;
  method?: "squash" | "merge" | "rebase";
}): Promise<{ sha: string; merged: boolean; wasDraft: boolean; headSha: string }> {
  const octokit = getAppOctokit(input.installationId ?? undefined);

  const pr = await fetchRemediationPullRequest(input);
  const mismatch = remediationPrMismatch(pr, input);
  if (mismatch) throw new Error(`Refusing to merge: ${mismatch}`);
  if (input.expectedHeadSha && pr.headSha !== input.expectedHeadSha) {
    throw new Error(
      `Refusing to merge: PR #${pr.number} has new commits since it was approved ` +
        `(approved ${input.expectedHeadSha.slice(0, 7)}, now ${pr.headSha.slice(0, 7)}).`,
    );
  }

  // Clear the draft flag first — see markPullRequestReady.
  const { wasDraft } = await markPullRequestReady({
    owner: input.owner,
    repo: input.repo,
    prNumber: input.prNumber,
    installationId: input.installationId,
  });

  const res = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
    merge_method: input.method || "squash",
    commit_title: input.commitTitle,
    commit_message: input.commitMessage,
    sha: pr.headSha,
  });

  const merged = res.data as { sha: string; merged: boolean };
  return { sha: merged.sha, merged: merged.merged, wasDraft, headSha: pr.headSha };
}
