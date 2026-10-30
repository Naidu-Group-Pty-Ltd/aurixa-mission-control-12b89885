// What GitHub says about a live-audit fix's pull request. Server-only, and
// database-only: it never calls GitHub itself.
//
// The remediation workflow reports a fix up to its pull request opening. What
// happens to that pull request afterwards is a person's doing on GitHub, so
// two callers bring it here: the GitHub webhook (hooks.github.tsx) the moment
// a fix branch's pull request closes or moves, and the live audit's sweep
// (refreshLiveAuditFixPrs) for any delivery that went missing. Both apply the
// same transition, and only the first to arrive changes anything — so a
// merged fix never sits at "PR open", a closed one never blocks a retry, and
// no event is recorded twice.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/json-cast";

const admin = supabaseAdmin;

/** Every live-audit fix branch starts with this (fixBranchName, live-audit-policy.ts). */
export const LIVE_AUDIT_FIX_BRANCH_PREFIX = "live-audit/fix-";

/** Fix statuses a pull request can still move. */
const PR_MOVABLE = ["dispatched", "pr_opened", "pr_updated"];
/** Finding states that belong to a fix in flight. */
const FIXING = ["fix_queued", "fix_in_progress", "fix_pr_open"];

export type FixPullRequestState = {
  merged: boolean;
  /** Closed on GitHub, merged or not. */
  closed: boolean;
  headSha: string | null;
  mergedAt?: string | null;
};

export type FixRowForSync = {
  id: string;
  finding_id: string;
  status: string;
  head_sha: string | null;
  pr_number: number | null;
};

export type FixSyncOutcome = "merged" | "closed" | "updated" | "checked" | "unchanged" | "error";

/** One pull request's state, applied to its fix and the fix's finding. Never throws. */
export async function applyFixPullRequestState(
  fix: FixRowForSync,
  pr: FixPullRequestState,
  via: "webhook" | "sweep",
): Promise<FixSyncOutcome> {
  const now = new Date().toISOString();
  try {
    if (pr.closed) {
      const merged = pr.merged;
      const { data: moved, error } = await admin
        .from("live_audit_fixes")
        .update({
          status: merged ? "merged" : "closed",
          completed_at: now,
          pr_checked_at: now,
          ...(merged ? { merged_at: pr.mergedAt ?? now } : {}),
          ...(pr.headSha ? { head_sha: pr.headSha } : {}),
        })
        .eq("id", fix.id)
        .in("status", PR_MOVABLE)
        .select("id");
      if (error) {
        console.error("[live-audit-pr-sync] fix not updated:", error.message);
        return "error";
      }
      // Already moved by the other caller: nothing more to say.
      if (!moved?.length) return "unchanged";

      // Merged: the finding waits on the next complete run to confirm the
      // defect is gone (live_audit_finalize_run). Closed: it is open again.
      const to = merged ? "fix_merged" : "open";
      const { data: finding, error: readErr } = await admin
        .from("live_audit_findings")
        .select("id, state")
        .eq("id", fix.finding_id)
        .maybeSingle();
      if (readErr) console.warn("[live-audit-pr-sync] finding not read:", readErr.message);
      if (finding && FIXING.includes(finding.state)) {
        const { error: upErr } = await admin
          .from("live_audit_findings")
          .update({ state: to })
          .eq("id", finding.id)
          .eq("state", finding.state);
        if (upErr) console.warn("[live-audit-pr-sync] finding not moved:", upErr.message);
      }
      const { error: evErr } = await admin.from("live_audit_events").insert({
        finding_id: fix.finding_id,
        fix_id: fix.id,
        event_type: merged ? "fix.merged" : "fix.closed_unmerged",
        from_state: finding?.state ?? null,
        to_state: finding && FIXING.includes(finding.state) ? to : (finding?.state ?? null),
        payload: asJson({ pr: fix.pr_number, via }),
      });
      if (evErr) console.warn("[live-audit-pr-sync] event not recorded:", evErr.message);
      return merged ? "merged" : "closed";
    }

    const headMoved = Boolean(pr.headSha && pr.headSha !== fix.head_sha);
    if (!headMoved && via === "webhook") return "unchanged";
    const { error } = await admin
      .from("live_audit_fixes")
      .update({
        pr_checked_at: now,
        ...(headMoved ? { head_sha: pr.headSha, status: "pr_updated" } : {}),
      })
      .eq("id", fix.id)
      .in("status", PR_MOVABLE);
    if (error) {
      console.error("[live-audit-pr-sync] fix not updated:", error.message);
      return "error";
    }
    return headMoved ? "updated" : "checked";
  } catch (err) {
    console.error("[live-audit-pr-sync] failed:", (err as Error).message);
    return "error";
  }
}

/**
 * From the GitHub webhook: a pull request closed or gained commits. Anything
 * that is not a live-audit fix branch returns at once, without a query.
 */
export async function syncLiveAuditFixPullRequest(input: {
  repoFullName: string;
  prNumber: number;
  headRef: string | null;
  action: string | undefined;
  merged: boolean;
  headSha: string | null;
  mergedAt: string | null;
}): Promise<{ fixes: number }> {
  if (!input.headRef?.startsWith(LIVE_AUDIT_FIX_BRANCH_PREFIX)) return { fixes: 0 };
  if (input.action !== "closed" && input.action !== "synchronize") return { fixes: 0 };
  const { data, error } = await admin
    .from("live_audit_fixes")
    .select("id, finding_id, status, head_sha, pr_number, repo_full_name")
    .eq("branch_name", input.headRef)
    .in("status", PR_MOVABLE);
  if (error) {
    console.error("[live-audit-pr-sync] fix lookup failed:", error.message);
    return { fixes: 0 };
  }
  let fixes = 0;
  for (const fix of data ?? []) {
    // The branch is the fix's own, but only in the repository it was opened in.
    if (fix.repo_full_name.toLowerCase() !== input.repoFullName.toLowerCase()) continue;
    if (fix.pr_number != null && fix.pr_number !== input.prNumber) continue;
    const outcome = await applyFixPullRequestState(
      { ...fix, pr_number: fix.pr_number ?? input.prNumber },
      {
        merged: input.action === "closed" && input.merged,
        closed: input.action === "closed",
        headSha: input.headSha,
        mergedAt: input.mergedAt,
      },
      "webhook",
    );
    if (outcome !== "unchanged" && outcome !== "error") fixes += 1;
  }
  return { fixes };
}
