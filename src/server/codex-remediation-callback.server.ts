// The remediation webhook: lifecycle events from codex-remediation.yml.
// Server-only; /api/public/hooks/codex-remediation delegates here.
//
// What changed, and why it matters: this callback's fields feed the merge.
// `pr_number` is what Mission Control merges, and `verified` plus the patch
// size are what the self-healing queue reads when it decides whether a merge
// needs a person. They were accepted from anyone holding the shared callback
// secret — which every fleet repository's Actions logs printed.
//
// Now a callback must be signed with its remediation's own derived key, must
// arrive while the remediation is open, may only name a PR and a run in the
// remediation's own repository, cannot rename the branch Mission Control
// chose, and cannot move the remediation backwards. Merges additionally
// re-read the PR from GitHub and pin the head commit (see
// codex-remediation.server.ts), so a forged PR number still cannot land code.
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { asJson, asRow } from "@/lib/json-cast";
import {
  REMEDIATION_CALLBACK_KEY_VERSION,
  callbackKeysFor,
  claimCallbackReceipt,
  releaseCallbackReceipt,
  resolveRemediationMasterSecrets,
  verifyCallbackSignature,
} from "@/server/codex-callback-keys.server";
import { runUrlBelongsTo } from "@/server/codex-scan-callback.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1024 * 1024;

const VerificationSchema = z.object({
  ok: z.boolean().nullable().optional(),
  secrets_clean: z.boolean().optional(),
  checks: z
    .array(
      z.object({
        name: z.string().max(100),
        ok: z.boolean(),
        skipped: z.boolean().optional(),
        ms: z.number().optional(),
        detail: z.string().max(4000).optional(),
      }),
    )
    .max(50)
    .optional(),
  // The CI the workflow found in the base (workflow version 4 on). The merge
  // lane runs it on the fix and merges only once it passes there
  // (src/server/fixCiGate.pure.ts); without this field it would be stripped.
  ci: z
    .object({
      workflow: z.string().max(200).nullable(),
      dispatchable: z.boolean(),
    })
    .optional(),
});

export const RemediationPayloadSchema = z.object({
  remediation_id: z.string().uuid(),
  event: z.enum([
    "workflow.started",
    "branch.pushed",
    "pr.opened",
    "pr.updated",
    "pr.merged",
    "pr.closed",
    "workflow.failed",
  ]),
  engine: z.string().max(60).optional(),
  model: z.string().max(120).optional(),
  pr_number: z.number().int().positive().optional(),
  pr_url: z.string().url().max(500).optional(),
  pr_state: z.string().max(40).optional(),
  head_sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .optional(),
  workflow_run_id: z.number().int().optional(),
  workflow_run_url: z.string().url().max(500).optional(),
  branch_name: z.string().max(255).optional(),
  verification: VerificationSchema.optional(),
  files_changed: z.number().int().min(0).optional(),
  lines_added: z.number().int().min(0).optional(),
  lines_removed: z.number().int().min(0).optional(),
  summary: z.string().max(4000).optional(),
  error: z.string().max(4000).optional(),
  detail: z.record(z.any()).optional(),
  workflow_version: z.number().int().optional(),
});

export type RemediationPayload = z.infer<typeof RemediationPayloadSchema>;

/** Statuses after which a callback has nothing left to say. */
export const TERMINAL_REMEDIATION = new Set(["merged", "closed", "rejected", "failed", "canceled"]);

const EVENT_STATUS: Record<RemediationPayload["event"], string> = {
  "workflow.started": "dispatched",
  "branch.pushed": "dispatched",
  "pr.opened": "pr_opened",
  "pr.updated": "pr_updated",
  "pr.merged": "merged",
  "pr.closed": "closed",
  "workflow.failed": "failed",
};

const STATUS_RANK: Record<string, number> = {
  queued: 0,
  dispatched: 1,
  pr_opened: 2,
  pr_updated: 2,
  approved: 3,
  changes_requested: 3,
  rejected: 4,
  merged: 4,
  closed: 4,
  failed: 4,
  canceled: 4,
};

/**
 * The status an event moves a remediation to, or null to leave it alone.
 * Status only moves forward — a late `workflow.started` must not undo
 * `pr_opened` — except that new commits on the PR (`pr.updated` with a new
 * head) invalidate approvals given for the old head.
 */
export function nextRemediationStatus(
  current: string,
  event: RemediationPayload["event"],
  headChanged: boolean,
): string | null {
  const target = EVENT_STATUS[event];
  if (TERMINAL_REMEDIATION.has(current)) return null;
  if (event === "pr.updated" && headChanged) return "pr_updated";
  return (STATUS_RANK[target] ?? 0) > (STATUS_RANK[current] ?? 0) ? target : null;
}

/** A PR link is only believed when it points at this remediation's repo. */
export function prUrlBelongsTo(prUrl: string, repoFullName: string, prNumber?: number): boolean {
  try {
    const path = new URL(prUrl).pathname.toLowerCase();
    const base = `/${repoFullName.toLowerCase()}/pull/`;
    if (!path.startsWith(base)) return false;
    return prNumber == null || path.slice(base.length).replace(/\/.*$/, "") === String(prNumber);
  } catch {
    return false;
  }
}

/** Finding states a remediation event may move a finding out of. */
const FIX_STATES = new Set(["open", "triaging", "fix_drafted", "pr_open"]);

export function findingStateForEvent(
  event: RemediationPayload["event"],
  current: string | null | undefined,
): string | null {
  if (!current || !FIX_STATES.has(current)) return null; // verdicts are not overridden
  switch (event) {
    case "pr.opened":
    case "pr.updated":
      return current === "pr_open" ? null : "pr_open";
    case "pr.merged":
      return "fix_merged";
    case "pr.closed":
    case "workflow.failed":
      // A closed or failed fix leaves the finding exactly as unfixed as before.
      return current === "fix_drafted" || current === "pr_open" ? "open" : null;
    default:
      return null;
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type RemediationRow = {
  id: string;
  finding_id: string;
  scan_job_id: string | null;
  status: string;
  repo_full_name: string;
  branch_name: string | null;
  pr_number: number | null;
  head_sha?: string | null;
  dispatch_payload: unknown;
};

async function loadRemediation(
  id: string,
): Promise<{ row: RemediationRow | null; error?: string }> {
  const full = await supabaseAdmin
    .from("codex_remediations")
    .select(
      "id, finding_id, scan_job_id, status, repo_full_name, branch_name, pr_number, head_sha, dispatch_payload",
    )
    .eq("id", id)
    .maybeSingle();
  if (!full.error) return { row: (full.data as RemediationRow | null) ?? null };
  // Before 20261018090000 there is no head_sha column.
  if (full.error.code === "42703" || /column .* does not exist/i.test(full.error.message)) {
    const base = await supabaseAdmin
      .from("codex_remediations")
      .select(
        "id, finding_id, scan_job_id, status, repo_full_name, branch_name, pr_number, dispatch_payload",
      )
      .eq("id", id)
      .maybeSingle();
    if (base.error) return { row: null, error: base.error.message };
    return { row: (base.data as RemediationRow | null) ?? null };
  }
  return { row: null, error: full.error.message };
}

export async function handleRemediationCallback(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "invalid payload" }, 400);
  }
  const claimed = (parsed as { remediation_id?: unknown } | null)?.remediation_id;
  if (typeof claimed !== "string" || !UUID.test(claimed))
    return json({ error: "invalid signature" }, 401);

  const loaded = await loadRemediation(claimed);
  if (loaded.error) return json({ error: "remediation lookup failed" }, 500);
  const rem = loaded.row;
  if (!rem) return json({ error: "invalid signature" }, 401);

  const dispatch = (rem.dispatch_payload ?? {}) as Record<string, unknown>;
  const masters = await resolveRemediationMasterSecrets();
  const keys =
    dispatch.callback_key === REMEDIATION_CALLBACK_KEY_VERSION
      ? await callbackKeysFor(masters, "remediation", rem.id)
      : [masters.current, ...masters.previous];
  const verdict = await verifyCallbackSignature({
    rawBody: raw,
    signature:
      request.headers.get("x-codex-signature") || request.headers.get("x-webhook-signature"),
    timestamp: request.headers.get("x-codex-timestamp"),
    keys,
    allowUntimestamped: true,
  });
  if (!verdict.ok) return json({ error: "invalid signature" }, 401);

  const result = RemediationPayloadSchema.safeParse(parsed);
  if (!result.success) {
    return json({ error: "invalid payload", detail: result.error.message.slice(0, 1000) }, 400);
  }
  const payload = result.data;

  if (TERMINAL_REMEDIATION.has(rem.status)) {
    return json({ error: "remediation is closed", status: rem.status }, 409);
  }
  if (payload.workflow_run_url && !runUrlBelongsTo(payload.workflow_run_url, rem.repo_full_name)) {
    return json({ error: "workflow run is not in the remediation's repository" }, 400);
  }
  if (payload.pr_url && !prUrlBelongsTo(payload.pr_url, rem.repo_full_name, payload.pr_number)) {
    return json({ error: "pull request is not in the remediation's repository" }, 400);
  }
  if (rem.pr_number != null && payload.pr_number != null && payload.pr_number !== rem.pr_number) {
    return json({ error: "a remediation's pull request cannot change" }, 400);
  }

  const receipt = await claimCallbackReceipt("remediation", verdict.digest, rem.id);
  if (receipt === "duplicate") return json({ ok: true, duplicate: true });

  const outcome = await processRemediationEvent(rem, payload, verdict.scheme);
  if (outcome.status >= 500 && receipt === "new") await releaseCallbackReceipt(verdict.digest);
  return json(outcome.body, outcome.status);
}

async function processRemediationEvent(
  rem: RemediationRow,
  payload: RemediationPayload,
  scheme: "timestamped" | "legacy",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const nowIso = new Date().toISOString();
  const headChanged = !!payload.head_sha && payload.head_sha !== (rem.head_sha ?? null);
  const nextStatus = nextRemediationStatus(rem.status, payload.event, headChanged);

  const patch: Record<string, unknown> = { last_event: asJson({ ...payload, signature: scheme }) };
  if (nextStatus) patch.status = nextStatus;
  if (payload.pr_number != null) patch.pr_number = payload.pr_number;
  if (payload.pr_url) patch.pr_url = payload.pr_url;
  if (payload.pr_state) patch.pr_state = payload.pr_state;
  if (payload.workflow_run_id != null) patch.workflow_run_id = payload.workflow_run_id;
  if (payload.workflow_run_url) patch.workflow_run_url = payload.workflow_run_url;
  // The branch is Mission Control's choice, recorded at dispatch. A callback
  // may fill it in for a pre-existing row that never had one, never rename it.
  if (payload.branch_name && !rem.branch_name) patch.branch_name = payload.branch_name;
  if (payload.engine) patch.engine = payload.engine;
  if (payload.model) patch.model = payload.model;
  if (payload.files_changed != null) patch.files_changed = payload.files_changed;
  if (payload.lines_added != null) patch.lines_added = payload.lines_added;
  if (payload.lines_removed != null) patch.lines_removed = payload.lines_removed;
  if (payload.head_sha) patch.head_sha = payload.head_sha;
  if (payload.verification) {
    patch.verification = payload.verification;
    // `verified` stays NULL when the workflow could not determine it, which
    // reads differently from an explicit false in the UI.
    patch.verified = typeof payload.verification.ok === "boolean" ? payload.verification.ok : null;
  }
  if (payload.event === "workflow.failed") {
    patch.last_error = (payload.error ?? "workflow failed").slice(0, 4000);
    patch.completed_at = nowIso;
  }
  if (nextStatus === "merged" || nextStatus === "closed") patch.completed_at = nowIso;

  // The authoritative write. A lost update here means the remediation record
  // disagrees with the workflow that just finished, so fail the hook and let
  // the sender retry rather than answering ok.
  let { error: remErr } = await supabaseAdmin
    .from("codex_remediations")
    .update(asRow<TablesUpdate<"codex_remediations">>(patch))
    .eq("id", rem.id);
  if (remErr && (remErr.code === "42703" || /column .* does not exist/i.test(remErr.message))) {
    // Unmigrated deployment: drop the columns 20261018090000 adds.
    delete patch.head_sha;
    ({ error: remErr } = await supabaseAdmin
      .from("codex_remediations")
      .update(asRow<TablesUpdate<"codex_remediations">>(patch))
      .eq("id", rem.id));
  }
  if (remErr)
    return { status: 500, body: { error: "remediation update failed", detail: remErr.message } };

  // Mirror onto the finding — a mirror, so failures are logged, not fatal.
  const { data: finding, error: findErr } = await supabaseAdmin
    .from("codex_findings")
    .select("id, state")
    .eq("id", rem.finding_id)
    .maybeSingle();
  if (findErr) console.warn("[codex-remediation] finding read failed:", findErr.message);
  const nextFinding = findingStateForEvent(payload.event, finding?.state);
  if (finding && nextFinding) {
    const findingPatch: Record<string, unknown> = { state: nextFinding };
    if (payload.pr_url) findingPatch.remediation_pr_url = payload.pr_url;
    if (payload.pr_state) findingPatch.remediation_pr_state = payload.pr_state;
    if (nextFinding === "open")
      findingPatch.remediation_pr_state = payload.event === "pr.closed" ? "closed" : "failed";
    if (nextFinding === "fix_merged") findingPatch.resolved_at = nowIso;
    const { error: mirrorErr } = await supabaseAdmin
      .from("codex_findings")
      .update(asRow<TablesUpdate<"codex_findings">>(findingPatch))
      .eq("id", finding.id);
    if (mirrorErr) {
      console.warn("[codex-remediation] finding mirror failed:", mirrorErr.message);
    } else {
      const { error: evErr } = await supabaseAdmin.from("codex_finding_events").insert({
        finding_id: finding.id,
        event_type: `remediation.${payload.event}`,
        from_state: finding.state,
        to_state: nextFinding,
        payload: asJson({ remediation_id: rem.id, pr_number: payload.pr_number ?? rem.pr_number }),
      });
      if (evErr) console.warn("[codex-remediation] finding event failed:", evErr.message);
    }
  }

  // codex_scan_events.job_id is NOT NULL; intake-sourced findings have no
  // scan job, so skip the audit row rather than failing the hook.
  if (rem.scan_job_id) {
    const { error: eventErr } = await supabaseAdmin.from("codex_scan_events").insert({
      job_id: rem.scan_job_id,
      event_type: `remediation.${payload.event}`,
      payload: asJson({
        remediation_id: rem.id,
        pr_number: payload.pr_number,
        pr_url: payload.pr_url,
        pr_state: payload.pr_state,
        head_sha: payload.head_sha,
        verified: payload.verification?.ok ?? null,
        secrets_clean: payload.verification?.secrets_clean ?? null,
        files_changed: payload.files_changed,
        error: payload.error,
        signature: scheme,
      }),
    });
    if (eventErr) console.warn("[codex-remediation] scan event insert failed:", eventErr.message);
  }

  return { status: 200, body: { ok: true, status: nextStatus ?? rem.status } };
}
