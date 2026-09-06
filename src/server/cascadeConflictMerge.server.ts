/**
 * The fall-through that makes every conflicted cascade proposal converge.
 *
 * `cascadeProposalRepair.server.ts` regenerates a conflicted proposal that is
 * still entirely the engine's one statement. Before this module, everything it
 * refused was permanent: a branch somebody had committed to, a proposal whose
 * repair attempts were spent, and a pull request Mission Control held no
 * cascade record for all sat open indefinitely — the owner's report was
 * "whenever there are merge conflicts it never closes", with the standing
 * instruction that resolution always accepts the CURRENT change (the
 * proposal's side) and then merges.
 *
 * The mechanics live in `cascade/conflictMerge.pure.ts`. This module does the
 * reads and the one write:
 *
 *   1. the pull request's own file list (the statement, as GitHub holds it —
 *      no Mission Control record required),
 *   2. both branches' recursive trees,
 *   3. ONE merge commit on the proposal branch — tree = the base branch's
 *      tree with the proposal's paths restated, parents = [head, base] — and
 *      a fast-forward ref update. Never a force-push: the new commit's first
 *      parent IS the current head, so history is appended, not rewritten.
 *
 * The merge itself still goes through `decideCascadeMerge` on a later pass,
 * once checks have reported on the resolved head. This module removes the
 * conflict; it grants nothing.
 *
 * Bounded like the repair path: attempts are counted from the audit log inside
 * the same window, written BEFORE the push so a crash still counts, and past
 * the cap it holds with the once-per-reason notification the repair path uses.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { getAppOctokit } from "./github-app.server";
import { notifyOperators, writeAuditLog } from "./audit.server";
import {
  MAX_RESOLUTIONS,
  planResolutionMerge,
  resolutionCommitMessage,
  type PrFile,
  type TreeEntry,
} from "./cascade/conflictMerge.pure";

type Db = SupabaseClient<Database>;

/** The audit action a resolution records under. Also how attempts are counted. */
export const CONFLICT_RESOLUTION_ACTION = "cascade_conflict_resolution";

/** Same window the repair path counts attempts in. */
const ATTEMPT_WINDOW_HOURS = 6;

/** Only branches this engine names may ever be written to. */
const ENGINE_BRANCH_PREFIX = "aurixa/cascade-";

export type ConflictResolutionOutcome =
  | { act: "resolved"; why: string }
  | { act: "hold"; reason: string; why: string };

/**
 * Resolve one conflicted proposal in the proposal's favour.
 *
 * `cause` names why regeneration was not the answer — it travels into the
 * audit row and the operator line, so a resolved proposal says which formerly
 * permanent hold it would have been.
 */
export async function resolveConflictedProposal(args: {
  supabase: Db;
  octokit: ReturnType<typeof getAppOctokit>;
  clone: { id: string; label: string; owner: string; repo: string };
  prNumber: number;
  headRef: string;
  headSha: string;
  /** The clone's default branch name — the base the proposal must land in. */
  baseRef: string;
  cause: string;
}): Promise<ConflictResolutionOutcome> {
  const { supabase, octokit, clone, prNumber, headRef, headSha, baseRef, cause } = args;
  const gh = { owner: clone.owner, repo: clone.repo };

  // The one hard boundary: this writes to a branch, so the branch must be one
  // this engine names. Anything else is somebody's work whatever its state.
  if (!headRef.startsWith(ENGINE_BRANCH_PREFIX)) {
    return {
      act: "hold",
      reason: "not_engine_branch",
      why:
        `PR #${prNumber}'s head \`${headRef}\` is not a cascade branch, so the engine will not ` +
        "write to it. Resolve it by hand.",
    };
  }

  const attempts = await countResolutions(supabase, clone.id, prNumber);
  if (attempts >= MAX_RESOLUTIONS) {
    return await holdOnce(args, "resolution_exhausted", {
      why:
        `Resolved ${attempts} time(s) inside the window and PR #${prNumber} is conflicted again. ` +
        "Something is writing this clone's default branch faster than checks can pass; a person " +
        "should look before the engine spends more CI on it.",
    });
  }

  // Both ends read fresh: the base may have moved past what the pull request
  // object reported, and resolving against a stale base re-creates the
  // conflict one pass later.
  const { data: baseRefData } = await octokit.git.getRef({ ...gh, ref: `heads/${baseRef}` });
  const baseSha: string = baseRefData.object.sha;
  const [{ data: headCommit }, { data: baseCommit }] = await Promise.all([
    octokit.git.getCommit({ ...gh, commit_sha: headSha }),
    octokit.git.getCommit({ ...gh, commit_sha: baseSha }),
  ]);

  const prFiles: PrFile[] = [];
  for (let page = 1; page <= 31; page++) {
    const { data } = await octokit.pulls.listFiles({
      ...gh,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    for (const f of data as Array<Record<string, unknown>>) {
      prFiles.push({
        filename: String(f.filename),
        status: String(f.status),
        previous_filename: (f.previous_filename as string | undefined) ?? null,
      });
    }
    if ((data as unknown[]).length < 100) break;
  }

  const [{ data: headTree }, { data: baseTree }] = await Promise.all([
    octokit.git.getTree({ ...gh, tree_sha: headCommit.tree.sha, recursive: "1" }),
    octokit.git.getTree({ ...gh, tree_sha: baseCommit.tree.sha, recursive: "1" }),
  ]);

  const plan = planResolutionMerge({
    prFiles,
    headTree: {
      truncated: Boolean(headTree.truncated),
      entries: headTree.tree as TreeEntry[],
    },
    baseTree: {
      truncated: Boolean(baseTree.truncated),
      entries: baseTree.tree as TreeEntry[],
    },
  });
  if (!plan.ok) {
    // `missing_in_head` is the one transient reading — the file list and the
    // tree were read moments apart — so it waits for the next pass without
    // burning a notification.
    if (plan.reason === "missing_in_head") {
      return { act: "hold", reason: plan.reason, why: plan.refusal };
    }
    return await holdOnce(args, plan.reason, { why: plan.refusal });
  }

  // Written BEFORE the push, so a crash still counts as an attempt. Counting
  // only successes is how a failing resolution runs for ever.
  await writeAuditLog({
    action: CONFLICT_RESOLUTION_ACTION,
    entityType: "clone",
    entityId: clone.id,
    metadata: {
      pr: prNumber,
      act: "resolve",
      attempt: attempts + 1,
      cause,
      restated: plan.restated,
      deleted: plan.deleted,
      base_sha: baseSha,
      head_sha: headSha,
    },
  });

  const { data: newTree } = await octokit.git.createTree({
    ...gh,
    base_tree: baseCommit.tree.sha,
    tree: plan.entries,
  });
  const { data: newCommit } = await octokit.git.createCommit({
    ...gh,
    message: resolutionCommitMessage({
      prNumber,
      baseShort: baseSha.slice(0, 7),
      restated: plan.restated,
      deleted: plan.deleted,
    }),
    tree: newTree.sha,
    // Head first: the ref update below is then a fast-forward, so nothing on
    // the branch — the engine's statement or anybody's commit — is rewritten.
    parents: [headSha, baseSha],
  });
  await octokit.git.updateRef({
    ...gh,
    ref: `heads/${headRef}`,
    sha: newCommit.sha,
    force: false,
  });

  return {
    act: "resolved",
    why:
      `PR #${prNumber} was conflicted (${cause}) and has been resolved in the proposal's ` +
      `favour: ${plan.restated} path(s) restated, ${plan.deleted} deleted, everything else ` +
      `kept from \`${baseRef}\`. A merge commit, so nothing on the branch was rewritten; ` +
      "it merges through the ordinary gate once checks pass on the resolved head.",
  };
}

/** Hold with the once-per-reason notification the repair path established. */
async function holdOnce(
  args: {
    supabase: Db;
    clone: { id: string; label: string };
    prNumber: number;
  },
  reason: string,
  detail: { why: string },
): Promise<ConflictResolutionOutcome> {
  const { supabase, clone, prNumber } = args;
  const told = await alreadyReported(supabase, clone.id, prNumber, reason);
  if (!told) {
    await writeAuditLog({
      action: CONFLICT_RESOLUTION_ACTION,
      entityType: "clone",
      entityId: clone.id,
      metadata: { pr: prNumber, act: "hold", reason, why: detail.why },
    });
    await notifyOperators({
      kind: "drift_medium",
      severity: "warning",
      title: `${clone.label}: cascade PR #${prNumber} conflict needs a person`,
      body: detail.why,
      cloneId: clone.id,
      url: `/clones/${clone.id}`,
      metadata: { pr: prNumber, reason, source: CONFLICT_RESOLUTION_ACTION },
    });
  }
  return { act: "hold", reason, why: detail.why };
}

/** How many times this proposal has been merge-resolved inside the window. */
async function countResolutions(supabase: Db, cloneId: string, prNumber: number): Promise<number> {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_HOURS * 3600_000).toISOString();
  const { data, error } = await supabase
    .from("audit_log")
    .select("metadata")
    .eq("action", CONFLICT_RESOLUTION_ACTION)
    .eq("entity_id", cloneId)
    .gte("created_at", since)
    .limit(50);
  // A history that could not be READ is not an empty history — reporting zero
  // attempts on a database fault is how the loop guard stops guarding.
  if (error) throw new Error(`Could not read resolution history: ${error.message}`);
  return (data ?? []).filter((r) => {
    const m = r.metadata as { pr?: unknown; act?: unknown } | null;
    return m?.pr === prNumber && m?.act === "resolve";
  }).length;
}

/** Whether this exact refusal has already been raised for this proposal. */
async function alreadyReported(
  supabase: Db,
  cloneId: string,
  prNumber: number,
  reason: string,
): Promise<boolean> {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_HOURS * 3600_000).toISOString();
  const { data, error } = await supabase
    .from("audit_log")
    .select("metadata")
    .eq("action", CONFLICT_RESOLUTION_ACTION)
    .eq("entity_id", cloneId)
    .gte("created_at", since)
    .limit(50);
  // Erring towards "already told" on a failed read would silence a real
  // refusal, so an unreadable history means say it.
  if (error) return false;
  return (data ?? []).some((r) => {
    const m = r.metadata as { pr?: unknown; act?: unknown; reason?: unknown } | null;
    return m?.pr === prNumber && m?.act === "hold" && m?.reason === reason;
  });
}
