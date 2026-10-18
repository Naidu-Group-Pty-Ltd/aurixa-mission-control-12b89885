import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Mirrors REMEDIATION_ENGINE in @/server/codex-remediation.server. Declared
// literally rather than imported: this module is loaded by route components,
// and a static `*.server.ts` import would fail client import protection.
const REMEDIATION_ENGINE = "codex_cli";
// Mirrors REMEDIATION_CALLBACK_KEY_VERSION in @/server/codex-callback-keys.server,
// for the same reason (codex-callback-keys.server.test.ts pins the two equal).
export const REMEDIATION_CALLBACK_KEY_VERSION = "rem-v1";

const DraftInput = z.object({
  findingId: z.string().uuid(),
  baseRef: z.string().optional(),
});

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function resolveRepo(
  supabase: any,
  targetKind: string,
  cloneId: string | null,
  fallbackRepo: string,
) {
  if (targetKind === "prime") {
    const { data: p } = await supabase
      .from("prime_config")
      .select("github_owner, github_repo, default_branch, github_app_installation_id")
      .limit(1)
      .maybeSingle();
    if (!p) throw new Error("prime_config not set");
    return {
      owner: p.github_owner,
      repo: p.github_repo,
      baseRef: p.default_branch || "main",
      installationId: p.github_app_installation_id ?? null,
    };
  }
  if (!cloneId) throw new Error("cloneId missing for clone remediation");
  // Installation id fetched separately — see clone-installation.server.ts for
  // why naming an optional column inline is unsafe here.
  const { loadCloneInstallationId } = await import("@/server/clone-installation.server");
  const [{ data: c }, installationId] = await Promise.all([
    supabase
      .from("clones")
      .select("github_owner, github_repo, default_branch")
      .eq("id", cloneId)
      .maybeSingle(),
    loadCloneInstallationId(supabase, cloneId),
  ]);
  if (!c) throw new Error("clone not found");
  const [owner, repo] = (fallbackRepo || "").split("/");
  return {
    owner: c.github_owner || owner,
    repo: c.github_repo || repo,
    baseRef: c.default_branch || "main",
    installationId,
  };
}

export const draftRemediationPR = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => DraftInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Admin-only gate — RLS enforces too.
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { data: finding, error: fErr } = await supabase
      .from("codex_findings")
      .select("*")
      .eq("id", data.findingId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!finding) throw new Error("finding not found");
    if (!finding.scan_job_id) throw new Error("finding has no scan job");
    // A finding seen only on an open pull request is fixed on that PR's own
    // branch, by its author — not by a second PR against the default branch.
    if ((finding as { pr_number?: number | null }).pr_number != null) {
      throw new Error(
        `This finding is on open pull request #${(finding as { pr_number?: number }).pr_number}; fix it on that branch.`,
      );
    }
    if (!["open", "triaging", "fix_drafted", "pr_open"].includes(finding.state)) {
      throw new Error(`Finding is ${finding.state} — reopen it before drafting a fix`);
    }

    const { data: job, error: jobErr } = await supabase
      .from("codex_scan_jobs")
      .select("id, target_kind, clone_id, repo_full_name, ref")
      .eq("id", finding.scan_job_id)
      .maybeSingle();
    if (jobErr) throw jobErr;
    if (!job) throw new Error("scan job not found");

    // Refuse to double-book an in-flight remediation for the same finding.
    const { data: existing, error: exErr } = await supabase
      .from("codex_remediations")
      .select("id, status")
      .eq("finding_id", finding.id)
      .in("status", [
        "queued",
        "dispatched",
        "pr_opened",
        "pr_updated",
        "approved",
        "changes_requested",
      ])
      .limit(1)
      .maybeSingle();
    if (exErr) throw exErr;
    if (existing) {
      return { remediationId: existing.id, reused: true };
    }

    const repoInfo = await resolveRepo(supabase, job.target_kind, job.clone_id, job.repo_full_name);
    // Always the default branch unless an operator names another: a scan's
    // ref can be a commit SHA (PR heads, post-merge revalidation), which
    // `workflow_dispatch` refuses as a ref, and a fix belongs on the branch
    // that ships.
    const baseRef = data.baseRef || repoInfo.baseRef;
    const branchName = `codex/fix-${slugify(finding.severity + "-" + finding.title)}-${finding.codex_finding_id.slice(0, 8)}`;

    const { data: row, error: insErr } = await supabase
      .from("codex_remediations")
      .insert({
        finding_id: finding.id,
        scan_job_id: finding.scan_job_id,
        clone_id: finding.clone_id,
        repo_full_name: `${repoInfo.owner}/${repoInfo.repo}`,
        base_ref: baseRef,
        branch_name: branchName,
        status: "queued",
        // The patch is authored by the OpenAI Codex CLI on the target repo's
        // Actions runner — recorded so a reviewer can see what wrote it.
        engine: REMEDIATION_ENGINE,
        requested_by: userId,
        dispatch_payload: {
          finding_id: finding.codex_finding_id,
          title: finding.title,
          severity: finding.severity,
          // The workflow signs callbacks with a key derived for this row.
          callback_key: REMEDIATION_CALLBACK_KEY_VERSION,
        },
      })
      .select()
      .single();
    if (insErr) throw insErr;

    // Awaited, not fire-and-forget: a floating promise here was routinely
    // killed with the serverless isolate, leaving remediations stuck at
    // `queued` with no error recorded anywhere.
    const dispatch = async () => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      try {
        const { dispatchRemediationWorkflow } = await import("@/server/codex-remediation.server");
        const { remediationCallbackUrl } = await import("@/server/codex-security-client.server");
        const { resolveRemediationMasterSecrets, deriveCallbackKey } =
          await import("@/server/codex-callback-keys.server");
        const master = (await resolveRemediationMasterSecrets()).current;
        if (!master) {
          throw new Error(
            "No remediation callback secret configured — the workflow would have no way " +
              "to report the PR back. Set CODEX_REMEDIATION_WEBHOOK_SECRET.",
          );
        }
        // This remediation's own key; the master never leaves Mission Control.
        const callbackSecret = await deriveCallbackKey(master, "remediation", row.id);
        const res = await dispatchRemediationWorkflow({
          remediationId: row.id,
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          baseRef,
          branchName,
          installationId: repoInfo.installationId,
          finding: {
            id: finding.codex_finding_id,
            title: finding.title,
            severity: finding.severity,
            description: finding.description,
            file: finding.affected_file,
            line: finding.affected_line,
            cwe: finding.cwe,
            // Give the model the offending source and which rule fired —
            // a title and a line number alone make for weak patches.
            snippet: finding.snippet,
            scanner: finding.scanner,
            ruleId: finding.rule_id,
          },
          callbackUrl: remediationCallbackUrl(),
          callbackSecret,
        });
        const { error: remErr } = await supabaseAdmin
          .from("codex_remediations")
          .update({
            status: "dispatched",
            dispatched_at: new Date().toISOString(),
            workflow_run_id: res.workflowRunId,
            workflow_run_url: res.workflowRunUrl,
          })
          .eq("id", row.id);
        if (remErr)
          console.error("[codex-remediation] dispatched but not recorded:", remErr.message);

        const { error: stateErr } = await supabaseAdmin
          .from("codex_findings")
          .update({ state: "fix_drafted" })
          .eq("id", finding.id)
          .in("state", ["open", "triaging", "fix_drafted", "pr_open"]);
        if (stateErr) console.error("[codex-remediation] finding mirror failed:", stateErr.message);

        const { error: findEvErr } = await supabaseAdmin.from("codex_finding_events").insert({
          finding_id: finding.id,
          actor: userId,
          event_type: "fix_requested",
          from_state: finding.state,
          to_state: "fix_drafted",
          payload: { remediation_id: row.id, base_ref: baseRef, branch: branchName },
        });
        // Missing on an unmigrated deployment; history, not the record.
        if (findEvErr) console.warn("[codex-remediation] finding event failed:", findEvErr.message);

        // Intake-sourced findings carry no scan job; codex_scan_events.job_id
        // is NOT NULL, so skip the audit row rather than throwing.
        if (finding.scan_job_id) {
          const { error: evErr } = await supabaseAdmin.from("codex_scan_events").insert({
            job_id: finding.scan_job_id,
            event_type: "remediation.dispatched",
            actor: userId,
            payload: {
              remediation_id: row.id,
              finding_id: finding.id,
              workflow_run_id: res.workflowRunId,
            },
          });
          if (evErr) console.warn("[codex-remediation] audit event failed:", evErr.message);
        }
        return { ok: true as const };
      } catch (err) {
        const message = (err as Error).message;
        const { error: failErr } = await supabaseAdmin
          .from("codex_remediations")
          .update({
            status: "failed",
            last_error: message,
            completed_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (failErr)
          console.error("[codex-remediation] could not record failure:", failErr.message);
        if (finding.scan_job_id) {
          const { error: evErr } = await supabaseAdmin.from("codex_scan_events").insert({
            job_id: finding.scan_job_id,
            event_type: "remediation.dispatch_failed",
            actor: userId,
            payload: { remediation_id: row.id, error: message },
          });
          if (evErr) console.warn("[codex-remediation] audit event failed:", evErr.message);
        }
        return { ok: false as const, error: message };
      }
    };

    const outcome = await dispatch();
    if (!outcome.ok) throw new Error(outcome.error);

    return { remediationId: row.id, reused: false };
  });

const ListInput = z.object({
  jobId: z.string().uuid().optional(),
  findingId: z.string().uuid().optional(),
});

const REMEDIATION_BASE_COLUMNS =
  "id, finding_id, scan_job_id, repo_full_name, base_ref, branch_name, workflow_run_id, workflow_run_url, pr_number, pr_url, pr_state, status, last_error, dispatched_at, completed_at, created_at, requested_by, approvals_required, merged_at, merged_by, merge_commit_sha, clone_id, cascade_event_id";
// 20260728090000
const REMEDIATION_VERIFICATION_COLUMNS =
  "engine, model, verification, verified, files_changed, lines_added, lines_removed, fix_confirmed_at";
// 20261018090000: the commit approvals name, and how a merge happened.
const REMEDIATION_HEAD_COLUMNS = "head_sha, fix_ineffective_at, merged_via";

export const listRemediations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ListInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    // Newest schema first, then each older one: a deployment that has not
    // applied a migration yet keeps its remediation list rather than blanking
    // it over a missing column.
    const attempts = [
      `${REMEDIATION_BASE_COLUMNS}, ${REMEDIATION_VERIFICATION_COLUMNS}, ${REMEDIATION_HEAD_COLUMNS}`,
      `${REMEDIATION_BASE_COLUMNS}, ${REMEDIATION_VERIFICATION_COLUMNS}`,
      REMEDIATION_BASE_COLUMNS,
    ];
    let lastError: { code?: string; message?: string } | null = null;
    for (const columns of attempts) {
      let q = context.supabase
        .from("codex_remediations")
        .select(columns)
        .order("created_at", { ascending: false })
        .limit(100);
      if (data.jobId) q = q.eq("scan_job_id", data.jobId);
      if (data.findingId) q = q.eq("finding_id", data.findingId);
      const { data: rows, error } = await q;
      if (!error) return { remediations: (rows ?? []) as any[] };
      if (error.code !== "42703" && !/column .* does not exist/i.test(error.message ?? "")) {
        throw error;
      }
      lastError = error;
    }
    throw lastError;
  });
