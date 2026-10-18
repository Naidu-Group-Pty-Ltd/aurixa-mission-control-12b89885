// The Codex scan webhook: what a scanner run reports, and how it is believed.
// Server-only; the route at /api/public/hooks/codex-security delegates here.
//
// In order, a callback must:
//   1. name a scan job that exists — an unknown id and a bad signature get the
//      same answer, so a caller that cannot authenticate learns nothing about
//      which job ids exist;
//   2. be signed with THAT job's derived key (codex-callback-keys.server.ts),
//      timestamped within the skew window when the workflow is current;
//   3. arrive while the job is still open — a closed job's key opens nothing;
//   4. come from a run in the scanned repository, when it names one;
//   5. not be a replay of a signature already processed.
//
// Then the batch is applied by `codex_ingest_scan_findings` and the scan
// closed by `codex_finalize_scan`, in Postgres, under row locks. On a
// deployment that has not applied 20261018090000 yet those functions do not
// exist and the legacy path records the scan the old way instead.
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { asJson, asRow } from "@/lib/json-cast";
import {
  SCAN_CALLBACK_KEY_VERSION,
  callbackKeysFor,
  claimCallbackReceipt,
  releaseCallbackReceipt,
  resolveScanMasterSecrets,
  verifyCallbackSignature,
} from "@/server/codex-callback-keys.server";
import { legacyFinalizeScan, legacyIngestFindings } from "@/server/codex-legacy-ingest.server";
import { completePrCheckForJob } from "@/server/codex-pr-checks.server";

/** Reject absurd bodies before spending CPU on HMAC and JSON parsing. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FindingSchema = z.object({
  id: z.string().min(1).max(200),
  fingerprint: z.string().max(200).optional().nullable(),
  legacy_fingerprint: z.string().max(200).optional().nullable(),
  title: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low", "info"]).default("medium"),
  // Nullable: the normalizer emits null for an empty field, and the previous
  // schema's bare `optional()` rejected the whole batch over one AI finding
  // that came back without a description.
  description: z.string().optional().nullable(),
  file: z.string().max(1000).optional().nullable(),
  line: z.number().int().min(0).optional().nullable(),
  cwe: z.string().max(40).optional().nullable(),
  cvss: z.number().min(0).max(10).optional().nullable(),
  auto_fix_confidence: z.number().min(0).max(1).optional().nullable(),
  scanner: z.string().max(60).optional().nullable(),
  rule_id: z.string().max(300).optional().nullable(),
  snippet: z.string().max(4000).optional().nullable(),
  raw: z.record(z.any()).optional(),
});

export const PayloadSchema = z.object({
  client_job_id: z.string().uuid(),
  external_scan_id: z.string().max(200).optional(),
  engine: z.string().max(60).optional(),
  workflow_version: z.number().int().min(1).optional(),
  workflow_run_id: z.number().int().optional().nullable(),
  workflow_run_url: z.string().url().max(500).optional().nullable(),
  event: z.enum(["scan.started", "scan.progress", "scan.completed", "scan.failed"]),
  batch: z.object({ index: z.number().int().min(0), count: z.number().int().min(1) }).optional(),
  summary: z.record(z.any()).optional(),
  findings: z.array(FindingSchema).max(500).optional(),
  findings_complete: z.boolean().optional(),
  error: z.string().max(4000).optional(),
});

export type ScanCallbackPayload = z.infer<typeof PayloadSchema>;

type ScanJob = {
  id: string;
  kind: string;
  status: string;
  clone_id: string | null;
  target_kind: string;
  repo_full_name: string;
  ref: string | null;
  request_payload: unknown;
  created_at: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized() {
  return json({ error: "invalid signature" }, 401);
}

function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST202" ||
    error.code === "42883" ||
    /Could not find the function|function .* does not exist/i.test(error.message ?? "")
  );
}

/**
 * A run URL must point into the repository the job scans. A key that leaked
 * from one repository's log cannot then be used to attribute results from a
 * different repository's run to this job.
 */
export function runUrlBelongsTo(runUrl: string, repoFullName: string): boolean {
  try {
    const path = new URL(runUrl).pathname.toLowerCase();
    return path.startsWith(`/${repoFullName.toLowerCase()}/actions/runs/`);
  } catch {
    return false;
  }
}

async function recordEvent(jobId: string, eventType: string, payload: Record<string, unknown>) {
  const { error } = await supabaseAdmin
    .from("codex_scan_events")
    .insert({ job_id: jobId, event_type: eventType, payload: asJson(payload) });
  // The event log is an audit convenience — never fail a scan over it.
  if (error) console.warn(`[codex-scan-callback] could not record ${eventType}:`, error.message);
}

export async function handleScanCallback(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "invalid payload" }, 400);
  }
  const claimed = (parsed as { client_job_id?: unknown } | null)?.client_job_id;
  if (typeof claimed !== "string" || !UUID.test(claimed)) return unauthorized();

  const { data: jobRow, error: jobErr } = await supabaseAdmin
    .from("codex_scan_jobs")
    .select(
      "id, kind, status, clone_id, target_kind, repo_full_name, ref, request_payload, created_at",
    )
    .eq("id", claimed)
    .maybeSingle();
  if (jobErr) return json({ error: "job lookup failed" }, 500);
  if (!jobRow) return unauthorized();
  const job = jobRow as ScanJob;

  const requestPayload = (job.request_payload ?? {}) as Record<string, unknown>;
  const masters = await resolveScanMasterSecrets();
  // Jobs created before per-job keys existed were dispatched with the shared
  // master itself; they can still report while they are open.
  const keys =
    requestPayload.callback_key === SCAN_CALLBACK_KEY_VERSION
      ? await callbackKeysFor(masters, "scan", job.id)
      : [masters.current, ...masters.previous];

  const verdict = await verifyCallbackSignature({
    rawBody: raw,
    signature:
      request.headers.get("x-codex-signature") || request.headers.get("x-webhook-signature"),
    timestamp: request.headers.get("x-codex-timestamp"),
    keys,
    allowUntimestamped: true,
  });
  if (!verdict.ok) return unauthorized();

  const result = PayloadSchema.safeParse(parsed);
  if (!result.success) {
    return json({ error: "invalid payload", detail: result.error.message.slice(0, 1000) }, 400);
  }
  const payload = result.data;

  if (TERMINAL.has(job.status)) {
    return json({ error: "scan job is closed", status: job.status }, 409);
  }
  if (payload.workflow_run_url && !runUrlBelongsTo(payload.workflow_run_url, job.repo_full_name)) {
    return json({ error: "workflow run is not in the scanned repository" }, 400);
  }

  const receipt = await claimCallbackReceipt("scan", verdict.digest, job.id);
  if (receipt === "duplicate") return json({ ok: true, duplicate: true });

  try {
    const outcome = await processScanEvent(job, payload, verdict.scheme);
    if (outcome.status >= 500 && receipt === "new") await releaseCallbackReceipt(verdict.digest);
    return json(outcome.body, outcome.status);
  } catch (err) {
    if (receipt === "new") await releaseCallbackReceipt(verdict.digest);
    return json({ error: "processing failed", detail: (err as Error).message }, 500);
  }
}

async function processScanEvent(
  job: ScanJob,
  payload: ScanCallbackPayload,
  scheme: "timestamped" | "legacy",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const nowIso = new Date().toISOString();
  const incoming = payload.findings ?? [];
  const workflowVersion =
    payload.workflow_version ??
    Number((payload.summary as { workflow_version?: unknown })?.workflow_version ?? 1);

  await recordEvent(job.id, payload.event, {
    count: incoming.length,
    batch: payload.batch ?? null,
    engine: payload.engine ?? null,
    workflow_version: workflowVersion || 1,
    signature: scheme,
    workflow_run_url: payload.workflow_run_url ?? null,
    error: payload.error ?? null,
    ...(payload.event === "scan.started" ? { summary: payload.summary ?? null } : {}),
  });

  // Where this scan is actually executing, as soon as we know.
  const runPatch: Record<string, unknown> = {};
  if (payload.workflow_run_id) runPatch.workflow_run_id = payload.workflow_run_id;
  if (payload.workflow_run_url) runPatch.workflow_run_url = payload.workflow_run_url;
  if (payload.external_scan_id) runPatch.external_scan_id = payload.external_scan_id;

  if (payload.event === "scan.started") {
    const { error } = await supabaseAdmin
      .from("codex_scan_jobs")
      .update(
        asRow<TablesUpdate<"codex_scan_jobs">>({
          ...runPatch,
          status: "running",
          started_at: nowIso,
          last_error: null,
        }),
      )
      .eq("id", job.id)
      .in("status", ["queued", "running"]);
    if (error) return { status: 500, body: { error: "job update failed", detail: error.message } };
  } else if (Object.keys(runPatch).length) {
    const { error } = await supabaseAdmin
      .from("codex_scan_jobs")
      .update(asRow<TablesUpdate<"codex_scan_jobs">>(runPatch))
      .eq("id", job.id);
    if (error) return { status: 500, body: { error: "job update failed", detail: error.message } };
  }

  let ingest: Record<string, unknown> = {};
  let legacy = false;
  if (incoming.length) {
    const res = await supabaseAdmin.rpc("codex_ingest_scan_findings", {
      p_job_id: job.id,
      p_findings: asJson(incoming),
    });
    if (res.error) {
      if (!isMissingFunction(res.error)) {
        await recordEvent(job.id, "findings_upsert_failed", {
          error: res.error.message,
          count: incoming.length,
        });
        return {
          status: 500,
          body: { error: "failed to persist findings", detail: res.error.message },
        };
      }
      legacy = true;
      const fallback = await legacyIngestFindings(job, incoming);
      if (!fallback.ok) {
        await recordEvent(job.id, "findings_upsert_failed", {
          error: fallback.error,
          count: incoming.length,
        });
        return {
          status: 500,
          body: { error: "failed to persist findings", detail: fallback.error },
        };
      }
      ingest = { regressions: fallback.regressions, ingest_path: "legacy" };
    } else {
      ingest = (res.data ?? {}) as Record<string, unknown>;
      const regressions = Number(ingest.regressions ?? 0);
      const ineffective = Number(ingest.fix_ineffective ?? 0);
      if (regressions > 0) await recordEvent(job.id, "regression_detected", { count: regressions });
      if (ineffective > 0)
        await recordEvent(job.id, "remediation.fix_ineffective", { count: ineffective });
    }
  }

  if (payload.event === "scan.completed") {
    const summary = {
      ...(payload.summary ?? {}),
      engine: payload.engine ?? "github_actions",
      workflow_version: workflowVersion || 1,
      signature_scheme: scheme,
    };
    const fin = legacy
      ? { data: null, error: { code: "PGRST202", message: "legacy path" } }
      : await supabaseAdmin.rpc("codex_finalize_scan", {
          p_job_id: job.id,
          p_summary: asJson(summary),
        });

    let finalSummary: Record<string, unknown> | null = null;
    if (fin.error) {
      if (!isMissingFunction(fin.error)) {
        return {
          status: 500,
          body: { error: "failed to finalize scan", detail: fin.error.message },
        };
      }
      const fallback = await legacyFinalizeScan(job, summary, payload.engine);
      if (!fallback.ok) {
        return { status: 500, body: { error: "failed to finalize scan", detail: fallback.error } };
      }
      finalSummary = fallback.summary;
    } else {
      finalSummary = (fin.data ?? null) as Record<string, unknown> | null;
    }

    if (job.kind === "pr_open") {
      await completePrCheckForJob({
        job,
        outcome: {
          kind: "finished",
          result: finalSummary,
          runUrl: payload.workflow_run_url ?? null,
        },
      });
    } else if (job.target_kind === "prime" && !job.clone_id) {
      // A Prime scan is what the security gate reads. When it trips, the
      // cascades already queued are held too: they deliver Prime's head as it
      // stands when they run, findings and all.
      const { evaluateCascadeSecurityGate, holdPendingCommitCascades } =
        await import("@/server/cascade-trigger.server");
      const gate = await evaluateCascadeSecurityGate(supabaseAdmin);
      if (gate.hold && gate.reason) {
        const held = await holdPendingCommitCascades(supabaseAdmin, gate.reason);
        if (held > 0)
          await recordEvent(job.id, "cascades_held", { count: held, reason: gate.reason });
      }
    }
    return {
      status: 200,
      body: { ok: true, ingested: incoming.length, ...ingest, summary: finalSummary },
    };
  }

  if (payload.event === "scan.failed") {
    const reason = (payload.error ?? "unknown").slice(0, 2000);
    const { error } = await supabaseAdmin
      .from("codex_scan_jobs")
      .update({ status: "failed", completed_at: nowIso, last_error: reason })
      .eq("id", job.id);
    if (error) return { status: 500, body: { error: "job update failed", detail: error.message } };
    if (job.kind === "pr_open") {
      await completePrCheckForJob({
        job,
        outcome: { kind: "failed", reason, runUrl: payload.workflow_run_url ?? null },
      });
    }
  }

  return { status: 200, body: { ok: true, ingested: incoming.length, ...ingest } };
}
