// Two-key merge gate for Codex remediation PRs. Admins record approve /
// reject / changes-requested decisions; merging a PR requires N distinct
// approvals from admins other than the requester.
//
// An approval is for a COMMIT. Each one records the PR head it was given for,
// the merge only counts approvals for the head the PR has when it merges, and
// the merge itself is pinned to that head — so a commit pushed to the fix
// branch after two people approved does not merge on their approvals.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { approvalsAtHead, type ApprovalRecord } from "@/lib/remediation-approvals";

const ReviewInput = z.object({
  remediationId: z.string().uuid(),
  decision: z.enum(["approve", "reject", "changes_requested"]),
  comment: z.string().max(2000).optional(),
});

type ReviewRow = ApprovalRecord;

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error && (error.code === "42703" || /column .* does not exist/i.test(error.message ?? ""))
  );
}

async function resolveInstallationId(
  supabase: any,
  cloneId: string | null,
): Promise<string | null> {
  // The clone lookup goes through the tolerant loader — naming an optional
  // column inline fails the whole select on an unmigrated deployment.
  if (cloneId) {
    const { loadCloneInstallationId } = await import("@/server/clone-installation.server");
    return loadCloneInstallationId(supabase, cloneId);
  }
  const { data: p } = await supabase
    .from("prime_config")
    .select("github_app_installation_id")
    .limit(1)
    .maybeSingle();
  return p?.github_app_installation_id ?? null;
}

async function loadReviews(supabase: any, remediationId: string): Promise<ReviewRow[]> {
  const withHead = await supabase
    .from("codex_remediation_reviews")
    .select("decision, reviewer_id, head_sha")
    .eq("remediation_id", remediationId);
  if (!withHead.error) return (withHead.data ?? []) as ReviewRow[];
  if (!isMissingColumn(withHead.error)) throw withHead.error;
  const base = await supabase
    .from("codex_remediation_reviews")
    .select("decision, reviewer_id")
    .eq("remediation_id", remediationId);
  if (base.error) throw base.error;
  return (base.data ?? []) as ReviewRow[];
}

export const reviewRemediation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ReviewInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { data: rem, error: rErr } = await supabase
      .from("codex_remediations")
      .select(
        "id, requested_by, status, approvals_required, finding_id, scan_job_id, repo_full_name, pr_number, branch_name, base_ref, clone_id",
      )
      .eq("id", data.remediationId)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!rem) throw new Error("remediation not found");
    if (rem.requested_by === userId && data.decision === "approve") {
      throw new Error("Requester cannot approve their own remediation");
    }
    if (["merged", "closed", "rejected", "failed", "canceled"].includes(rem.status)) {
      throw new Error(`Cannot review remediation in status: ${rem.status}`);
    }

    // An approval names the exact commit it approves, read from GitHub now.
    let headSha: string | null = null;
    if (data.decision === "approve") {
      if (!rem.pr_number) throw new Error("There is no pull request to approve yet");
      const [owner, repo] = (rem.repo_full_name || "").split("/");
      if (!owner || !repo) throw new Error("Invalid repo on remediation");
      const { fetchRemediationPullRequest, remediationPrMismatch } =
        await import("@/server/codex-remediation.server");
      let pr;
      try {
        pr = await fetchRemediationPullRequest({
          owner,
          repo,
          prNumber: rem.pr_number,
          installationId: await resolveInstallationId(supabase, rem.clone_id),
        });
      } catch (err) {
        throw new Error(
          `Could not read PR #${rem.pr_number} from GitHub to record which commit you approved: ${(err as Error).message}`,
        );
      }
      const mismatch = remediationPrMismatch(pr, {
        owner,
        repo,
        branchName: rem.branch_name,
        baseRef: rem.base_ref,
      });
      if (mismatch) throw new Error(mismatch);
      headSha = pr.headSha;
    }

    // Upsert reviewer's decision (one review per admin per remediation).
    const review = {
      remediation_id: rem.id,
      reviewer_id: userId,
      decision: data.decision,
      comment: data.comment ?? null,
      head_sha: headSha,
    };
    let { error: upErr } = await supabase
      .from("codex_remediation_reviews")
      .upsert(review, { onConflict: "remediation_id,reviewer_id" });
    if (upErr && isMissingColumn(upErr)) {
      const { head_sha: _omit, ...legacyReview } = review;
      void _omit;
      ({ error: upErr } = await supabase
        .from("codex_remediation_reviews")
        .upsert(legacyReview, { onConflict: "remediation_id,reviewer_id" }));
    }
    if (upErr) throw upErr;

    // Recompute aggregate status.
    const reviews = await loadReviews(supabase, rem.id);
    const { count: approvals, stale } = approvalsAtHead(reviews, rem.requested_by, headSha);
    const rejects = reviews.filter((r) => r.decision === "reject").length;
    const changes = reviews.filter((r) => r.decision === "changes_requested").length;

    let newStatus: string | null = null;
    if (rejects > 0) newStatus = "rejected";
    else if (changes > 0 && approvals < rem.approvals_required) newStatus = "changes_requested";
    else if (approvals >= rem.approvals_required) newStatus = "approved";

    if (newStatus && newStatus !== rem.status) {
      const patch: Database["public"]["Tables"]["codex_remediations"]["Update"] = {
        status: newStatus as Database["public"]["Enums"]["codex_remediation_status"],
      };
      if (newStatus === "rejected") {
        patch.rejected_by = userId;
        patch.rejected_at = new Date().toISOString();
        patch.rejected_reason = data.comment ?? null;
      }
      const { error: stErr } = await supabase
        .from("codex_remediations")
        .update(patch)
        .eq("id", rem.id);
      if (stErr) throw stErr;
    }

    // Audit event. `codex_scan_events.job_id` is NOT NULL, so a remediation
    // that was never tied to a scan job simply has no event trail to append to.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const scanJobId = rem.scan_job_id;
    if (scanJobId) {
      const { error: evErr } = await supabaseAdmin.from("codex_scan_events").insert({
        job_id: scanJobId,
        event_type: `remediation.review.${data.decision}`,
        actor: userId,
        payload: {
          remediation_id: rem.id,
          approvals,
          stale_approvals: stale,
          rejects,
          changes_requested: changes,
          required: rem.approvals_required,
          head_sha: headSha,
        },
      });
      if (evErr) console.warn("[codex-remediation-reviews] audit event failed:", evErr.message);
    }

    return {
      approvals,
      stale_approvals: stale,
      rejects,
      changes_requested: changes,
      status: newStatus ?? rem.status,
      head_sha: headSha,
    };
  });

const ListInput = z.object({ remediationId: z.string().uuid() });

export const listRemediationReviews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ListInput.parse(d))
  .handler(async ({ data, context }) => {
    const withHead = await context.supabase
      .from("codex_remediation_reviews")
      .select("id, reviewer_id, decision, comment, created_at, head_sha")
      .eq("remediation_id", data.remediationId)
      .order("created_at", { ascending: true });
    if (!withHead.error) return { reviews: withHead.data ?? [] };
    if (!isMissingColumn(withHead.error)) throw withHead.error;
    const { data: rows, error } = await context.supabase
      .from("codex_remediation_reviews")
      .select("id, reviewer_id, decision, comment, created_at")
      .eq("remediation_id", data.remediationId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return { reviews: rows ?? [] };
  });

const MergeInput = z.object({
  remediationId: z.string().uuid(),
  method: z.enum(["squash", "merge", "rebase"]).optional(),
});

export const mergeRemediationPR = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => MergeInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { data: rem, error: remErr } = await supabase
      .from("codex_remediations")
      .select(
        "id, status, approvals_required, requested_by, repo_full_name, pr_number, scan_job_id, finding_id, clone_id, base_ref, branch_name",
      )
      .eq("id", data.remediationId)
      .maybeSingle();
    if (remErr) throw remErr;
    if (!rem) throw new Error("remediation not found");
    if (!rem.pr_number) throw new Error("PR not yet opened");
    if (rem.status === "merged") throw new Error("Already merged");
    if (rem.status === "rejected") throw new Error("Remediation was rejected");
    // NOT NULL on codex_scan_events.job_id: no scan job, no event trail.
    const scanJobId = rem.scan_job_id;

    const [owner, repo] = (rem.repo_full_name || "").split("/");
    if (!owner || !repo) throw new Error("Invalid repo on remediation");
    const installationId = await resolveInstallationId(supabase, rem.clone_id);

    // Verify approvals from the DB against the PR as GitHub has it NOW —
    // never against client state, and never against an older commit.
    const { fetchRemediationPullRequest, mergeRemediationPRViaGitHub } =
      await import("@/server/codex-remediation.server");
    const pr = await fetchRemediationPullRequest({
      owner,
      repo,
      prNumber: rem.pr_number,
      installationId,
    });
    const reviews = await loadReviews(supabase, rem.id);
    if (reviews.some((r) => r.decision === "reject")) {
      throw new Error("A reviewer rejected this remediation");
    }
    const { count, stale } = approvalsAtHead(reviews, rem.requested_by, pr.headSha);
    if (count < rem.approvals_required) {
      throw new Error(
        `Insufficient approvals for the PR's current commit ${pr.headSha.slice(0, 7)}: ` +
          `${count}/${rem.approvals_required}` +
          (stale
            ? ` (${stale} approval${stale === 1 ? " was" : "s were"} for an older commit)`
            : ""),
      );
    }
    const pinnedToHead = reviews.some((r) => r.head_sha !== undefined);

    const merge = await mergeRemediationPRViaGitHub({
      owner,
      repo,
      prNumber: rem.pr_number,
      installationId,
      branchName: rem.branch_name,
      baseRef: rem.base_ref,
      expectedHeadSha: pinnedToHead ? pr.headSha : null,
      commitTitle: `Codex remediation #${rem.pr_number}`,
      commitMessage: `Approved by ${count} reviewer(s) via Mission Control at ${pr.headSha.slice(0, 12)}.`,
      method: data.method || "squash",
    });

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Load finding title for cascade summary + audit payload.
    const { data: finding } = await supabaseAdmin
      .from("codex_findings")
      .select("title, severity, cwe")
      .eq("id", rem.finding_id)
      .maybeSingle();

    // Phase 3: cascade the merged security patch to the clone fleet.
    // Only fan out when the remediation lives in Prime — clone-scoped
    // fixes stay in that clone. Choose cascade mode from prime_config,
    // falling back to `pr` for safety.
    let cascadeEventId: string | null = null;
    let cascadeError: string | null = null;
    if (!rem.clone_id) {
      try {
        const { data: prime } = await supabaseAdmin
          .from("prime_config")
          .select("default_cascade_mode, default_branch")
          .limit(1)
          .maybeSingle();
        const mode = (prime?.default_cascade_mode as any) || "pr";
        const sourceBranch = prime?.default_branch || rem.base_ref || "main";
        const title = (finding?.title || "security patch").slice(0, 140);
        const severity = (finding?.severity || "").toUpperCase();
        const { createCascadeForAllClones } = await import("@/server/cascade-trigger.server");
        const cascade = await createCascadeForAllClones({
          supabase: supabaseAdmin,
          mode,
          trigger: "commit",
          sourceBranch,
          sourceSha: merge.sha,
          initiatedBy: userId,
          summary: `Codex security patch${severity ? ` [${severity}]` : ""}: ${title} (PR #${rem.pr_number})`,
        });
        cascadeEventId = cascade.eventId;
        if (cascade.error && !cascade.eventId) {
          cascadeError = cascade.error;
        }
      } catch (err) {
        cascadeError = (err as Error).message;
      }
    }

    const mergedAt = new Date().toISOString();
    const remPatch = {
      status: "merged" as const,
      merged_by: userId,
      merged_at: mergedAt,
      merge_commit_sha: merge.sha,
      pr_state: "merged",
      completed_at: mergedAt,
      cascade_event_id: cascadeEventId,
      head_sha: merge.headSha,
      merged_via: "mission_control",
    };
    let { error: remUpdErr } = await supabaseAdmin
      .from("codex_remediations")
      .update(remPatch)
      .eq("id", rem.id);
    if (remUpdErr && isMissingColumn(remUpdErr)) {
      const { head_sha: _h, merged_via: _m, ...legacyPatch } = remPatch;
      void _h;
      void _m;
      ({ error: remUpdErr } = await supabaseAdmin
        .from("codex_remediations")
        .update(legacyPatch)
        .eq("id", rem.id));
    }
    // The PR has merged on GitHub; a lost write here would leave Mission
    // Control offering to merge it again, so say so loudly.
    if (remUpdErr) {
      console.error(
        "[codex-remediation-reviews] merged but could not record it:",
        remUpdErr.message,
      );
    }

    // The next full scan confirms the fix (finding gone) or reopens it.
    const { error: findErr } = await supabaseAdmin
      .from("codex_findings")
      .update({ state: "fix_merged", resolved_at: mergedAt })
      .eq("id", rem.finding_id);
    if (findErr)
      console.error("[codex-remediation-reviews] finding mirror failed:", findErr.message);

    if (scanJobId) {
      const events = [
        {
          job_id: scanJobId,
          event_type: "remediation.merged",
          actor: userId,
          payload: {
            remediation_id: rem.id,
            sha: merge.sha,
            head_sha: merge.headSha,
            pr_number: rem.pr_number,
            cascade_event_id: cascadeEventId,
            cascade_error: cascadeError,
          },
        },
        ...(cascadeEventId
          ? [
              {
                job_id: scanJobId,
                event_type: "remediation.cascade_triggered",
                actor: userId,
                payload: {
                  remediation_id: rem.id,
                  cascade_event_id: cascadeEventId,
                  source_sha: merge.sha,
                },
              },
            ]
          : cascadeError
            ? [
                {
                  job_id: scanJobId,
                  event_type: "remediation.cascade_skipped",
                  actor: userId,
                  payload: { remediation_id: rem.id, reason: cascadeError },
                },
              ]
            : []),
      ];
      const { error: evErr } = await supabaseAdmin.from("codex_scan_events").insert(events);
      if (evErr) console.warn("[codex-remediation-reviews] audit events failed:", evErr.message);
    }

    return {
      ok: true,
      sha: merge.sha,
      // Remediation PRs are opened as drafts and GitHub refuses to merge a
      // draft; the merge helper clears the flag first. Surfaced so the
      // operator knows the PR left draft state on their behalf.
      wasDraft: merge.wasDraft,
      cascadeEventId,
      cascadeError,
    };
  });
