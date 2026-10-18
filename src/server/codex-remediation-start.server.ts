// Starting a security fix: one path for a person's "Draft Fix PR" and for the
// fixes Mission Control dispatches by itself after the nightly scan
// (codex-autofix.server.ts). Server-only.
//
// Writes the remediation row, derives the remediation's own callback key and
// dispatches .github/workflows/codex-remediation.yml on Prime, naming the
// engine the finding's priority calls for: Claude for P0/P1, Codex for P2 and
// below (src/lib/codex-autofix-policy.ts). The fix PR then merges by itself
// once its checks pass, or is closed (self-healing.server.ts).
//
// Fixes are written on Prime only. A clone receives them through the cascade;
// a fix PR against a clone would be overwritten by the next one.

import crypto from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/json-cast";
import {
  FIX_ENGINE_LABEL,
  WORKFLOW_ENGINE,
  fixEngineFor,
  type FixEngine,
} from "@/lib/codex-autofix-policy";
import {
  REMEDIATION_CALLBACK_KEY_VERSION,
  deriveCallbackKey,
  resolveRemediationMasterSecrets,
} from "@/server/codex-callback-keys.server";
import { dispatchRemediationWorkflow } from "@/server/codex-remediation.server";
import { remediationCallbackUrl } from "@/server/codex-security-client.server";

const admin = supabaseAdmin;

/** Remediation statuses with a fix still in flight. */
export const IN_FLIGHT_REMEDIATION_STATUSES = [
  "queued",
  "dispatched",
  "pr_opened",
  "pr_updated",
  "approved",
  "changes_requested",
] as const;

const FIXABLE_STATES = ["open", "triaging", "fix_drafted", "pr_open"] as const;

export type StartRemediationResult =
  | { ok: true; remediationId: string; reused: boolean; engine: FixEngine }
  | { ok: false; error: string; remediationId?: string };

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export async function startRemediation(input: {
  findingId: string;
  /** The person who asked, or null for a fix Mission Control started itself. */
  requestedBy: string | null;
  /** Defaults to the engine the finding's severity calls for. */
  engine?: FixEngine | null;
  baseRef?: string | null;
  source: "operator" | "autofix";
}): Promise<StartRemediationResult> {
  const { data: finding, error: fErr } = await admin
    .from("codex_findings")
    .select("*")
    .eq("id", input.findingId)
    .maybeSingle();
  if (fErr) return { ok: false, error: fErr.message };
  if (!finding) return { ok: false, error: "finding not found" };
  if (!finding.scan_job_id) return { ok: false, error: "finding has no scan job" };
  if (finding.clone_id) {
    return {
      ok: false,
      error:
        "Clones are not fixed separately: Prime's fixes reach every clone through the cascade.",
    };
  }
  // A finding seen only on an open pull request is fixed on that PR's own
  // branch, by its author — not by a second PR against the default branch.
  const prNumber = (finding as { pr_number?: number | null }).pr_number;
  if (prNumber != null) {
    return {
      ok: false,
      error: `This finding is on open pull request #${prNumber}; fix it on that branch.`,
    };
  }
  if (!(FIXABLE_STATES as readonly string[]).includes(finding.state)) {
    return { ok: false, error: `Finding is ${finding.state} — reopen it before drafting a fix` };
  }

  // Never two fixes for one finding at once.
  const { data: existing, error: exErr } = await admin
    .from("codex_remediations")
    .select("id, engine")
    .eq("finding_id", finding.id)
    .in("status", [...IN_FLIGHT_REMEDIATION_STATUSES])
    .limit(1)
    .maybeSingle();
  if (exErr) return { ok: false, error: exErr.message };
  if (existing) {
    return {
      ok: true,
      remediationId: existing.id,
      reused: true,
      engine: existing.engine === "claude_code" ? "claude_code" : "codex_cli",
    };
  }

  const { data: prime, error: primeErr } = await admin
    .from("prime_config")
    .select("github_owner, github_repo, default_branch, github_app_installation_id")
    .limit(1)
    .maybeSingle();
  if (primeErr) return { ok: false, error: primeErr.message };
  if (!prime?.github_owner || !prime?.github_repo) {
    return { ok: false, error: "prime_config has no GitHub repository" };
  }

  const engine: FixEngine = input.engine ?? fixEngineFor(finding.severity) ?? "codex_cli";
  // Always the default branch unless a person names another: a scan's ref can
  // be a commit SHA, which `workflow_dispatch` refuses, and a fix belongs on
  // the branch that ships.
  const baseRef = input.baseRef || prime.default_branch || "main";
  // A fresh branch per attempt: the workflow never overwrites an existing
  // branch, and a finding whose first fix was closed is tried again.
  const branchName =
    `codex/fix-${slugify(finding.severity + "-" + finding.title)}-` +
    `${finding.codex_finding_id.slice(0, 8)}-${crypto.randomBytes(2).toString("hex")}`;

  const { data: row, error: insErr } = await admin
    .from("codex_remediations")
    .insert({
      finding_id: finding.id,
      scan_job_id: finding.scan_job_id,
      clone_id: null,
      repo_full_name: `${prime.github_owner}/${prime.github_repo}`,
      base_ref: baseRef,
      branch_name: branchName,
      status: "queued",
      // Which agent writes the patch — recorded so anyone can see what wrote it.
      engine,
      requested_by: input.requestedBy,
      dispatch_payload: asJson({
        finding_id: finding.codex_finding_id,
        title: finding.title,
        severity: finding.severity,
        engine,
        source: input.source,
        // The workflow signs callbacks with a key derived for this row.
        callback_key: REMEDIATION_CALLBACK_KEY_VERSION,
      }),
    })
    .select("id")
    .single();
  if (insErr) return { ok: false, error: insErr.message };

  try {
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
      owner: prime.github_owner,
      repo: prime.github_repo,
      baseRef,
      branchName,
      installationId: prime.github_app_installation_id ?? null,
      finding: {
        id: finding.codex_finding_id,
        title: finding.title,
        severity: finding.severity,
        description: finding.description,
        file: finding.affected_file,
        line: finding.affected_line,
        cwe: finding.cwe,
        // The offending source and the rule that fired: a title and a line
        // number alone make for weak patches.
        snippet: finding.snippet,
        scanner: finding.scanner,
        ruleId: finding.rule_id,
        engine: WORKFLOW_ENGINE[engine],
      },
      callbackUrl: remediationCallbackUrl(),
      callbackSecret,
    });

    const { error: remErr } = await admin
      .from("codex_remediations")
      .update({
        status: "dispatched",
        dispatched_at: new Date().toISOString(),
        workflow_run_id: res.workflowRunId,
        workflow_run_url: res.workflowRunUrl,
      })
      .eq("id", row.id);
    if (remErr) console.error("[codex-remediation] dispatched but not recorded:", remErr.message);

    const { error: stateErr } = await admin
      .from("codex_findings")
      .update({ state: "fix_drafted" })
      .eq("id", finding.id)
      .in("state", [...FIXABLE_STATES]);
    if (stateErr) console.error("[codex-remediation] finding mirror failed:", stateErr.message);

    const { error: findEvErr } = await admin.from("codex_finding_events").insert({
      finding_id: finding.id,
      actor: input.requestedBy,
      event_type: input.source === "autofix" ? "autofix.dispatched" : "fix_requested",
      from_state: finding.state,
      to_state: "fix_drafted",
      payload: asJson({ remediation_id: row.id, base_ref: baseRef, branch: branchName, engine }),
    });
    // Missing on an unmigrated deployment; history, not the record.
    if (findEvErr) console.warn("[codex-remediation] finding event failed:", findEvErr.message);

    const { error: evErr } = await admin.from("codex_scan_events").insert({
      job_id: finding.scan_job_id,
      event_type: "remediation.dispatched",
      actor: input.requestedBy,
      payload: asJson({
        remediation_id: row.id,
        finding_id: finding.id,
        workflow_run_id: res.workflowRunId,
        engine,
        engine_label: FIX_ENGINE_LABEL[engine],
        source: input.source,
      }),
    });
    if (evErr) console.warn("[codex-remediation] audit event failed:", evErr.message);
    return { ok: true, remediationId: row.id, reused: false, engine };
  } catch (err) {
    const message = (err as Error).message;
    const { error: failErr } = await admin
      .from("codex_remediations")
      .update({ status: "failed", last_error: message, completed_at: new Date().toISOString() })
      .eq("id", row.id);
    if (failErr) console.error("[codex-remediation] could not record failure:", failErr.message);
    const { error: evErr } = await admin.from("codex_scan_events").insert({
      job_id: finding.scan_job_id,
      event_type: "remediation.dispatch_failed",
      actor: input.requestedBy,
      payload: asJson({ remediation_id: row.id, error: message, engine }),
    });
    if (evErr) console.warn("[codex-remediation] audit event failed:", evErr.message);
    return { ok: false, error: message, remediationId: row.id };
  }
}
