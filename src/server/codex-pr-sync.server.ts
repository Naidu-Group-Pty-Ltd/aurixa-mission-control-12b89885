// What GitHub tells Mission Control about pull requests that the Codex
// pipeline cares about. Server-only; called from the GitHub webhook.
//
// Two gaps this closes:
//
//  1. A fix PR closed or merged ON GITHUB was never reported back. The
//     remediation workflow only sends started / pushed / opened / failed, so
//     the remediation sat at `pr_opened`, its finding sat in `pr_open` — out
//     of every open count — and the scan page's button stayed on "Fix in
//     flight" for good, blocking a retry.
//  2. A pull request's own findings (PR scans write to a `<target>:pr:<n>`
//     target) had nothing to close them when the PR closed.
//
// And one thing it records: new commits on a fix PR. Approvals are pinned to
// a commit, so the review panel needs to know the head moved.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, TablesUpdate } from "@/integrations/supabase/types";
import { asJson, asRow } from "@/lib/json-cast";
import { targetKeyFor } from "@/lib/codex-finding-lifecycle";
import { resolveScanTarget } from "@/server/codex-scheduling.server";

const admin = supabaseAdmin;

const OPEN_REMEDIATION: Database["public"]["Enums"]["codex_remediation_status"][] = [
  "queued",
  "dispatched",
  "pr_opened",
  "pr_updated",
  "approved",
  "changes_requested",
];

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error && (error.code === "42703" || /column .* does not exist/i.test(error.message ?? ""))
  );
}

async function openRemediationsFor(repoFullName: string, prNumber: number) {
  const { data, error } = await admin
    .from("codex_remediations")
    .select("id, finding_id, scan_job_id, status, repo_full_name, branch_name")
    .ilike("repo_full_name", escapeLike(repoFullName))
    .eq("pr_number", prNumber)
    .in("status", OPEN_REMEDIATION);
  if (error) {
    console.error("[codex-pr-sync] remediation lookup failed:", error.message);
    return [];
  }
  return (data ?? []).filter((r) => r.repo_full_name.toLowerCase() === repoFullName.toLowerCase());
}

async function findingEvent(
  findingId: string,
  eventType: string,
  fromState: string | null,
  toState: string,
  payload: Record<string, unknown>,
) {
  const { error } = await admin.from("codex_finding_events").insert({
    finding_id: findingId,
    event_type: eventType,
    from_state: fromState,
    to_state: toState,
    payload: asJson(payload),
  });
  if (error)
    console.warn(`[codex-pr-sync] finding event ${eventType} not recorded:`, error.message);
}

/**
 * A remediation PR was closed on GitHub. Merged: the remediation is merged
 * and its finding waits on the next full scan to confirm or reopen it.
 * Closed unmerged: the remediation is closed and its finding is open again.
 */
export async function syncRemediationPullRequestClosed(input: {
  repoFullName: string;
  prNumber: number;
  merged: boolean;
  mergeSha: string | null;
  headSha: string | null;
}): Promise<{ remediations: number }> {
  const rems = await openRemediationsFor(input.repoFullName, input.prNumber);
  const nowIso = new Date().toISOString();
  let synced = 0;

  for (const rem of rems) {
    const patch: Record<string, unknown> = input.merged
      ? {
          status: "merged",
          merged_at: nowIso,
          merge_commit_sha: input.mergeSha,
          pr_state: "merged",
          completed_at: nowIso,
          merged_via: "github",
          ...(input.headSha ? { head_sha: input.headSha } : {}),
        }
      : { status: "closed", pr_state: "closed", completed_at: nowIso };
    let { error } = await admin
      .from("codex_remediations")
      .update(asRow<TablesUpdate<"codex_remediations">>(patch))
      .eq("id", rem.id);
    if (error && isMissingColumn(error)) {
      delete patch.merged_via;
      delete patch.head_sha;
      ({ error } = await admin
        .from("codex_remediations")
        .update(asRow<TablesUpdate<"codex_remediations">>(patch))
        .eq("id", rem.id));
    }
    if (error) {
      console.error("[codex-pr-sync] remediation update failed:", error.message);
      continue;
    }
    synced += 1;

    const { data: finding, error: fErr } = await admin
      .from("codex_findings")
      .select("id, state")
      .eq("id", rem.finding_id)
      .maybeSingle();
    if (fErr) console.warn("[codex-pr-sync] finding read failed:", fErr.message);
    if (finding && ["open", "triaging", "fix_drafted", "pr_open"].includes(finding.state)) {
      const next = input.merged ? "fix_merged" : finding.state === "triaging" ? null : "open";
      if (next && next !== finding.state) {
        const { error: upErr } = await admin
          .from("codex_findings")
          .update({
            state: next,
            remediation_pr_state: input.merged ? "merged" : "closed",
            ...(input.merged ? { resolved_at: nowIso } : {}),
          })
          .eq("id", finding.id);
        if (upErr) console.warn("[codex-pr-sync] finding update failed:", upErr.message);
        else
          await findingEvent(
            finding.id,
            input.merged ? "remediation.merged_on_github" : "remediation.closed_on_github",
            finding.state,
            next,
            {
              remediation_id: rem.id,
              pr_number: input.prNumber,
            },
          );
      }
    }

    if (rem.scan_job_id) {
      const { error: evErr } = await admin.from("codex_scan_events").insert({
        job_id: rem.scan_job_id,
        event_type: input.merged ? "remediation.merged_on_github" : "remediation.closed_on_github",
        payload: asJson({
          remediation_id: rem.id,
          pr_number: input.prNumber,
          merge_sha: input.mergeSha,
        }),
      });
      if (evErr) console.warn("[codex-pr-sync] scan event failed:", evErr.message);
    }
  }
  return { remediations: synced };
}

/**
 * New commits on a remediation PR. Approvals name a commit, so the PR's head
 * is recorded; a remediation that was `approved` drops back to `pr_updated`
 * because those approvals no longer cover what would merge.
 */
export async function noteRemediationPullRequestHead(input: {
  repoFullName: string;
  prNumber: number;
  headSha: string;
}): Promise<number> {
  const rems = await openRemediationsFor(input.repoFullName, input.prNumber);
  let noted = 0;
  for (const rem of rems) {
    const patch: Record<string, unknown> = { head_sha: input.headSha };
    if (rem.status === "approved") patch.status = "pr_updated";
    const { error } = await admin
      .from("codex_remediations")
      .update(asRow<TablesUpdate<"codex_remediations">>(patch))
      .eq("id", rem.id);
    if (error) {
      if (!isMissingColumn(error))
        console.error("[codex-pr-sync] head update failed:", error.message);
      continue;
    }
    noted += 1;
  }
  return noted;
}

/**
 * A pull request closed: its own findings (the PR target) are done. Merged,
 * they are now on the default branch, where the post-merge scan judges them
 * on the main target; closed unmerged, they never shipped.
 */
export async function closePullRequestFindings(input: {
  repoFullName: string;
  prNumber: number;
  merged: boolean;
}): Promise<number> {
  const target = await resolveScanTarget(input.repoFullName);
  if (!target) return 0;
  const targetKey = targetKeyFor(target.cloneId ?? null, input.prNumber);
  const { data, error } = await admin
    .from("codex_findings")
    .update({
      state: "resolved",
      resolution: input.merged ? "pr_merged" : "pr_closed",
      resolved_at: new Date().toISOString(),
    })
    .eq("target_key", targetKey)
    .in("state", ["open", "triaging"])
    .select("id");
  if (error) {
    if (!isMissingColumn(error))
      console.error("[codex-pr-sync] PR findings close failed:", error.message);
    return 0;
  }
  for (const row of data ?? []) {
    await findingEvent(row.id, input.merged ? "pr_merged" : "pr_closed", "open", "resolved", {
      pr_number: input.prNumber,
    });
  }
  return data?.length ?? 0;
}
