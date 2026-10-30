// Fixing what the live audit finds: Claude, every time. Server-only.
//
// A fix is `codex-remediation.yml` (version 5) on Prime with a `kind: "bug"`
// finding: Claude Code, whatever the defect's severity, with the audit's
// evidence in its prompt, the model and effort chosen on the Live Audit
// settings, and every guard a security fix passes — no CI, configuration or
// migration changes, gitleaks on the added lines, the repository's checks on
// the base plus the patch. It flows through the Anthropic key Mission Control
// syncs into Prime's Actions secrets for the Claude Code fixes, and only once a
// person has turned on "Use Claude" in the live audit's settings: a key being
// configured (Mission Control holds an org-scoped one for Codex) is not consent
// to spend it here. Until both hold, no fix is dispatched and the page says why.
//
// The pull request opens as a draft on a `live-audit/fix-…` branch and a
// PERSON merges it while the audit is being proven on Prime. The sweep follows
// it (`refreshLiveAuditFixPrs`); the next complete run that covers the page
// confirms the defect is gone (`live_audit_finalize_run`), or reopens it.
import crypto from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { asJson } from "@/lib/json-cast";
import {
  autofixQueue,
  fixBranchName,
  fixEligibility,
  renderFixEvidence,
  type FixCandidate,
} from "@/lib/live-audit-policy";
import { verifyCallbackSignature } from "@/server/codex-callback-keys.server";
import {
  RemediationPayloadSchema,
  TERMINAL_REMEDIATION,
  nextRemediationStatus,
  prUrlBelongsTo,
} from "@/server/codex-remediation-callback.server";
import { runUrlBelongsTo } from "@/server/codex-scan-callback.server";
import { dispatchRemediationWorkflow } from "@/server/codex-remediation.server";
import { getAppOctokit } from "@/server/github-app.server";
import { alertOnFixReady } from "@/server/live-audit-alerts.server";
import {
  liveAuditFixCallbackUrl,
  loadLiveAuditSettings,
  resolvePrimeRepo,
} from "@/server/live-audit-dispatch.server";
import {
  LIVE_AUDIT_FIX_KEY_VERSION,
  claimLiveAuditReceipt,
  deriveLiveAuditKey,
  liveAuditKeysFor,
  releaseLiveAuditReceipt,
  resolveLiveAuditMasterSecrets,
} from "@/server/live-audit-keys.server";
import { applyFixPullRequestState } from "@/server/live-audit-pr-sync.server";

const admin = supabaseAdmin;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fix statuses with work still in flight. */
export const IN_FLIGHT_FIX_STATUSES = ["queued", "dispatched", "pr_opened", "pr_updated"] as const;

/**
 * The Anthropic key the fixes flow through. Mission Control's own copy is what
 * its secret sync writes into Prime's repository (github-secrets.server.ts);
 * engine health separately confirms Prime's repository holds one.
 */
export function anthropicKeyConfigured(): boolean {
  return Boolean((process.env.ANTHROPIC_API_KEY ?? "").trim());
}

type FindingRow = FixCandidate & {
  fingerprint: string;
  title: string;
  description: string | null;
  route: string | null;
  route_template: string | null;
  detector: string;
  repro_steps: unknown;
  evidence: unknown;
  suspected_files: unknown;
  fix_hint: string | null;
  last_seen_run_id: string | null;
  target_key: string;
};

export type StartFixResult =
  | { ok: true; fixId: string; reused: boolean }
  | { ok: false; error: string; fixId?: string };

export async function startLiveAuditFix(input: {
  findingId: string;
  requestedBy: string | null;
  source: "operator" | "autofix";
}): Promise<StartFixResult> {
  if (!UUID.test(input.findingId)) return { ok: false, error: "not a finding id" };
  const { data: f, error: fErr } = await admin
    .from("live_audit_findings")
    .select("*")
    .eq("id", input.findingId)
    .maybeSingle();
  if (fErr) return { ok: false, error: fErr.message };
  if (!f) return { ok: false, error: "finding not found" };
  const finding = f as unknown as FindingRow;

  const { data: existing, error: exErr } = await admin
    .from("live_audit_fixes")
    .select("id")
    .eq("finding_id", finding.id)
    .in("status", [...IN_FLIGHT_FIX_STATUSES])
    .limit(1)
    .maybeSingle();
  if (exErr) return { ok: false, error: exErr.message };
  if (existing) return { ok: true, fixId: existing.id, reused: true };

  const settings = await loadLiveAuditSettings(finding.target_key);
  const verdict = fixEligibility(finding, {
    source: input.source,
    minConfidence: Number(settings?.autofix_min_confidence ?? 0.7),
    // No settings row reads as off: the switch is the consent, never a default.
    claudeEnabled: settings?.claude_enabled === true,
    keyPresent: anthropicKeyConfigured(),
  });
  if (!verdict.ok) return { ok: false, error: verdict.reason };

  const prime = await resolvePrimeRepo();
  const branchName = fixBranchName(
    finding.title,
    finding.fingerprint,
    crypto.randomBytes(3).toString("hex"),
  );
  const { data: row, error: insErr } = await admin
    .from("live_audit_fixes")
    .insert({
      finding_id: finding.id,
      run_id: finding.last_seen_run_id,
      status: "queued",
      model: settings?.fix_model ?? null,
      repo_full_name: `${prime.owner}/${prime.repo}`,
      base_ref: prime.defaultBranch,
      branch_name: branchName,
      requested_by: input.requestedBy,
      source: input.source,
      dispatch_payload: asJson({
        callback_key: LIVE_AUDIT_FIX_KEY_VERSION,
        fingerprint: finding.fingerprint,
        severity: finding.severity,
        effort: settings?.fix_effort ?? null,
      }),
    })
    .select("id")
    .single();
  if (insErr) {
    if (insErr.code === "23505")
      return { ok: false, error: "a fix for this finding is already in flight" };
    return { ok: false, error: insErr.message };
  }

  const fromState = finding.state;
  const { error: claimErr } = await admin
    .from("live_audit_findings")
    .update({
      state: "fix_queued",
      fix_attempts: finding.fix_attempts + 1,
      last_fix_at: new Date().toISOString(),
    })
    .eq("id", finding.id)
    .in("state", ["open", "triaging"]);
  if (claimErr) console.error("[live-audit-fix] finding not marked fix_queued:", claimErr.message);

  try {
    const master = (await resolveLiveAuditMasterSecrets()).current;
    if (!master)
      throw new Error("No callback master is configured: the fix could not report back.");
    const firstFile = Array.isArray(finding.suspected_files)
      ? (finding.suspected_files as Array<{ path?: string; line?: number | null }>)[0]
      : undefined;
    await dispatchRemediationWorkflow({
      remediationId: row.id,
      owner: prime.owner,
      repo: prime.repo,
      baseRef: prime.defaultBranch,
      branchName,
      installationId: prime.installationId,
      finding: {
        id: `live-audit/${finding.fingerprint.slice(0, 16)}`,
        title: finding.title,
        severity: finding.severity,
        description: [
          finding.description ?? "",
          finding.fix_hint ? `\nSuggested direction: ${finding.fix_hint}` : "",
        ].join(""),
        file: firstFile?.path ?? null,
        line: firstFile?.line ?? null,
        cwe: null,
        snippet: null,
        scanner: "live-audit",
        ruleId: finding.detector,
        engine: "claude",
        kind: "bug",
        evidence: renderFixEvidence(finding),
        model: settings?.fix_model ?? null,
        effort: settings?.fix_effort ?? null,
      },
      callbackUrl: liveAuditFixCallbackUrl(),
      callbackSecret: await deriveLiveAuditKey(master, "fix", row.id),
    });
    const { error: upErr } = await admin
      .from("live_audit_fixes")
      .update({ status: "dispatched", dispatched_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "queued");
    if (upErr) console.error("[live-audit-fix] dispatched but not recorded:", upErr.message);
    const { error: evErr } = await admin.from("live_audit_events").insert({
      finding_id: finding.id,
      fix_id: row.id,
      run_id: finding.last_seen_run_id,
      actor: input.requestedBy,
      event_type: input.source === "autofix" ? "fix.autofix_dispatched" : "fix.requested",
      from_state: fromState,
      to_state: "fix_queued",
      payload: asJson({
        branch: branchName,
        engine: "claude_code",
        model: settings?.fix_model ?? null,
      }),
    });
    if (evErr) console.warn("[live-audit-fix] event not recorded:", evErr.message);
    return { ok: true, fixId: row.id, reused: false };
  } catch (err) {
    const message = (err as Error).message;
    const { error: failErr } = await admin
      .from("live_audit_fixes")
      .update({
        status: "failed",
        last_error: message.slice(0, 2000),
        completed_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (failErr) console.error("[live-audit-fix] failure not recorded:", failErr.message);
    const { error: backErr } = await admin
      .from("live_audit_findings")
      .update({ state: fromState })
      .eq("id", finding.id)
      .eq("state", "fix_queued");
    if (backErr) console.error("[live-audit-fix] finding not returned:", backErr.message);
    return { ok: false, error: message, fixId: row.id };
  }
}

// ── The fix workflow's callbacks ──────────────────────────────────────────

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The finding state a fix event moves its finding to, or null. Pure. */
export function findingStateForFixEvent(event: string, current: string): string | null {
  const fixing = ["fix_queued", "fix_in_progress", "fix_pr_open"];
  if (!fixing.includes(current)) return null;
  switch (event) {
    case "workflow.started":
    case "branch.pushed":
      return current === "fix_queued" ? "fix_in_progress" : null;
    case "pr.opened":
    case "pr.updated":
      return "fix_pr_open";
    case "pr.merged":
      return "fix_merged";
    case "pr.closed":
    case "workflow.failed":
      return "open";
    default:
      return null;
  }
}

export async function handleLiveAuditFixCallback(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > 1024 * 1024) return json({ error: "payload too large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "invalid payload" }, 400);
  }
  const claimed = (parsed as { remediation_id?: unknown } | null)?.remediation_id;
  if (typeof claimed !== "string" || !UUID.test(claimed))
    return json({ error: "invalid signature" }, 401);

  const { data: fixRow, error: fixErr } = await admin
    .from("live_audit_fixes")
    .select("id, finding_id, status, repo_full_name, branch_name, head_sha")
    .eq("id", claimed)
    .maybeSingle();
  if (fixErr) return json({ error: "fix lookup failed" }, 500);
  if (!fixRow) return json({ error: "invalid signature" }, 401);

  const verdict = await verifyCallbackSignature({
    rawBody: raw,
    // The remediation workflow's own header names: it is the same workflow
    // that fixes security findings.
    signature: request.headers.get("x-codex-signature"),
    timestamp: request.headers.get("x-codex-timestamp"),
    keys: await liveAuditKeysFor(await resolveLiveAuditMasterSecrets(), "fix", fixRow.id),
    allowUntimestamped: false,
  });
  if (!verdict.ok) return json({ error: "invalid signature" }, 401);

  const result = RemediationPayloadSchema.safeParse(parsed);
  if (!result.success)
    return json({ error: "invalid payload", detail: result.error.message.slice(0, 1000) }, 400);
  const p = result.data;
  if (TERMINAL_REMEDIATION.has(fixRow.status))
    return json({ error: "fix is closed", status: fixRow.status }, 409);
  if (p.branch_name && p.branch_name !== fixRow.branch_name)
    return json({ error: "branch is not this fix's" }, 400);
  if (p.workflow_run_url && !runUrlBelongsTo(p.workflow_run_url, fixRow.repo_full_name)) {
    return json({ error: "workflow run is not in Prime's repository" }, 400);
  }
  if (p.pr_url && !prUrlBelongsTo(p.pr_url, fixRow.repo_full_name, p.pr_number)) {
    return json({ error: "pull request is not in Prime's repository" }, 400);
  }

  const receipt = await claimLiveAuditReceipt("fix", verdict.digest, fixRow.id);
  if (receipt === "duplicate") return json({ ok: true, duplicate: true });

  try {
    const headChanged = Boolean(p.head_sha && fixRow.head_sha && p.head_sha !== fixRow.head_sha);
    const next = nextRemediationStatus(fixRow.status, p.event, headChanged);
    const patch: TablesUpdate<"live_audit_fixes"> = {};
    if (next) patch.status = next;
    if (p.workflow_run_id) patch.workflow_run_id = p.workflow_run_id;
    if (p.workflow_run_url) patch.workflow_run_url = p.workflow_run_url;
    if (p.pr_number) patch.pr_number = p.pr_number;
    if (p.pr_url) patch.pr_url = p.pr_url;
    if (p.head_sha) patch.head_sha = p.head_sha;
    if (p.model) patch.model = p.model;
    if (p.verification) patch.verification = asJson(p.verification);
    if (p.files_changed !== undefined) patch.files_changed = p.files_changed;
    if (p.lines_added !== undefined) patch.lines_added = p.lines_added;
    if (p.lines_removed !== undefined) patch.lines_removed = p.lines_removed;
    if (p.summary) patch.summary = p.summary;
    if (p.event === "workflow.failed") {
      patch.last_error = (p.error ?? "the fix workflow failed").slice(0, 2000);
      patch.completed_at = new Date().toISOString();
    }
    if (Object.keys(patch).length) {
      const { error } = await admin.from("live_audit_fixes").update(patch).eq("id", fixRow.id);
      if (error) {
        if (receipt === "new") await releaseLiveAuditReceipt(verdict.digest);
        return json({ error: "fix update failed", detail: error.message }, 500);
      }
    }

    const { data: finding, error: findingErr } = await admin
      .from("live_audit_findings")
      .select("id, state, title, severity")
      .eq("id", fixRow.finding_id)
      .maybeSingle();
    if (findingErr) console.warn("[live-audit-fix] finding not read:", findingErr.message);
    if (finding) {
      const to = findingStateForFixEvent(p.event, finding.state);
      if (to && to !== finding.state) {
        const { error } = await admin
          .from("live_audit_findings")
          .update({ state: to })
          .eq("id", finding.id)
          .eq("state", finding.state);
        if (error) console.warn("[live-audit-fix] finding state not mirrored:", error.message);
      }
      const { error: evErr } = await admin.from("live_audit_events").insert({
        finding_id: finding.id,
        fix_id: fixRow.id,
        event_type: `fix.${p.event}`,
        from_state: finding.state,
        to_state: to ?? finding.state,
        reason: p.event === "workflow.failed" ? (p.error ?? null) : null,
        payload: asJson({
          pr_url: p.pr_url ?? null,
          model: p.model ?? null,
          files: p.files_changed ?? null,
        }),
      });
      if (evErr) console.warn("[live-audit-fix] event not recorded:", evErr.message);
      if (p.event === "pr.opened") {
        await alertOnFixReady({
          fixId: fixRow.id,
          findingTitle: finding.title,
          prUrl: p.pr_url ?? null,
          severity: finding.severity,
        });
      }
    }
    return json({ ok: true, status: next ?? fixRow.status });
  } catch (err) {
    if (receipt === "new") await releaseLiveAuditReceipt(verdict.digest);
    return json({ error: "processing failed", detail: (err as Error).message }, 500);
  }
}

// ── The sweep's two jobs for fixes ────────────────────────────────────────

/**
 * After a completed run, its fixes, once: when automatic fixes are on and the
 * key is configured. The run's `autofix.dispatched` event is the claim.
 */
export async function dispatchAutomaticLiveAuditFixes(): Promise<{
  ran: boolean;
  reason?: string;
  dispatched?: number;
}> {
  const settings = await loadLiveAuditSettings("prime");
  if (!settings?.autofix_enabled) return { ran: false, reason: "automatic fixes are off" };
  if (settings.claude_enabled !== true)
    return { ran: false, reason: "Claude is off for the live audit" };
  if (!anthropicKeyConfigured()) return { ran: false, reason: "waiting on the Anthropic key" };

  const { data: run, error: runErr } = await admin
    .from("live_audit_runs")
    .select("id")
    .eq("target_key", "prime")
    .eq("status", "completed")
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A failed read is not "no run": it says so, and the next tick asks again.
  if (runErr) return { ran: false, reason: `the latest run could not be read: ${runErr.message}` };
  if (!run) return { ran: false, reason: "no completed run" };
  const { data: claimed, error: claimReadErr } = await admin
    .from("live_audit_events")
    .select("id")
    .eq("run_id", run.id)
    .eq("event_type", "autofix.dispatched")
    .limit(1)
    .maybeSingle();
  if (claimReadErr)
    return { ran: false, reason: `the run's fixes could not be checked: ${claimReadErr.message}` };
  if (claimed) return { ran: false, reason: "this run's fixes were already started" };
  const { error: claimErr } = await admin
    .from("live_audit_events")
    .insert({ run_id: run.id, event_type: "autofix.dispatched", payload: asJson({}) });
  if (claimErr) return { ran: false, reason: claimErr.message };

  const { data: open, error } = await admin
    .from("live_audit_findings")
    .select(
      "id, state, severity, category, confidence, fix_attempts, last_fix_at, first_seen_at, deterministic, reproduced",
    )
    .eq("target_key", "prime")
    .eq("last_seen_run_id", run.id)
    .in("state", ["open", "triaging"]);
  if (error) return { ran: false, reason: error.message };
  const queue = autofixQueue((open ?? []) as FixCandidate[], {
    max: settings.autofix_max_per_run,
    minConfidence: Number(settings.autofix_min_confidence),
    claudeEnabled: true,
    keyPresent: true,
  });
  let dispatched = 0;
  for (const f of queue) {
    const r = await startLiveAuditFix({ findingId: f.id, requestedBy: null, source: "autofix" });
    if (r.ok && !r.reused) dispatched += 1;
  }
  return { ran: true, dispatched };
}

/** How long a fix pull request goes unread by the sweep: the webhook is the fast path. */
export const FIX_PR_RECHECK_MINUTES = 60;

/**
 * Follow open fix pull requests to their merge or close, for any the GitHub
 * webhook did not report (live-audit-pr-sync.server.ts). One GET per pull
 * request, at most hourly each; budgeted by the sweep's caller.
 */
export async function refreshLiveAuditFixPrs(
  limit = 10,
): Promise<{ checked: number; merged: number; closed: number; error?: string }> {
  const stale = new Date(Date.now() - FIX_PR_RECHECK_MINUTES * 60_000).toISOString();
  const { data: fixes, error } = await admin
    .from("live_audit_fixes")
    .select("id, finding_id, status, pr_number, head_sha, repo_full_name")
    .in("status", ["pr_opened", "pr_updated"])
    .not("pr_number", "is", null)
    .or(`pr_checked_at.is.null,pr_checked_at.lt.${stale}`)
    .order("pr_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) return { checked: 0, merged: 0, closed: 0, error: error.message };
  if (!fixes?.length) return { checked: 0, merged: 0, closed: 0 };
  const prime = await resolvePrimeRepo();
  const octokit = getAppOctokit(prime.installationId ?? undefined);
  let checked = 0;
  let merged = 0;
  let closed = 0;
  for (const fix of fixes) {
    const [owner, repo] = fix.repo_full_name.split("/");
    if (!owner || !repo) continue;
    try {
      const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: fix.pr_number as number,
      });
      checked += 1;
      const outcome = await applyFixPullRequestState(
        fix,
        {
          merged: Boolean(pr.merged),
          closed: pr.state === "closed",
          headSha: pr.head?.sha ?? null,
          mergedAt: pr.merged_at ?? null,
        },
        "sweep",
      );
      if (outcome === "merged") merged += 1;
      if (outcome === "closed") closed += 1;
    } catch (err) {
      console.warn(`[live-audit-fix] PR #${fix.pr_number} not read:`, (err as Error).message);
    }
  }
  return { checked, merged, closed };
}

/** The remediation job's 90 minutes, a runner queue, and slack. */
export const FIX_REPORT_TIMEOUT_MINUTES = 150;

/**
 * Fixes whose workflow never reported a pull request or a failure: failed,
 * with their finding open again, so a person can retry. A cancelled or
 * timed-out job runs no failure step, and nothing else would ever say so.
 */
export async function failSilentLiveAuditFixes(): Promise<{ failed: string[]; error?: string }> {
  const cutoff = new Date(Date.now() - FIX_REPORT_TIMEOUT_MINUTES * 60_000).toISOString();
  const { data, error } = await admin
    .from("live_audit_fixes")
    .select("id, finding_id, status")
    .in("status", ["queued", "dispatched"])
    .lt("created_at", cutoff)
    .limit(50);
  if (error) return { failed: [], error: error.message };
  const failed: string[] = [];
  for (const fix of data ?? []) {
    const reason =
      fix.status === "queued"
        ? "The fix was never dispatched."
        : `The fix workflow reported nothing within ${FIX_REPORT_TIMEOUT_MINUTES} minutes: it was cancelled, timed out or never started. See Prime's Actions.`;
    const { data: moved, error: upErr } = await admin
      .from("live_audit_fixes")
      .update({ status: "failed", last_error: reason, completed_at: new Date().toISOString() })
      .eq("id", fix.id)
      .eq("status", fix.status)
      .select("id");
    if (upErr) {
      console.error("[live-audit-fix] silent fix not failed:", upErr.message);
      continue;
    }
    if (!moved?.length) continue;
    failed.push(fix.id);
    const { data: back, error: backErr } = await admin
      .from("live_audit_findings")
      .update({ state: "open" })
      .eq("id", fix.finding_id)
      .in("state", ["fix_queued", "fix_in_progress"])
      .select("id");
    if (backErr) console.warn("[live-audit-fix] finding not reopened:", backErr.message);
    const { error: evErr } = await admin.from("live_audit_events").insert({
      finding_id: fix.finding_id,
      fix_id: fix.id,
      event_type: "fix.timed_out",
      to_state: back?.length ? "open" : null,
      reason,
      payload: asJson({ status: fix.status }),
    });
    if (evErr) console.warn("[live-audit-fix] event not recorded:", evErr.message);
  }
  return { failed };
}
