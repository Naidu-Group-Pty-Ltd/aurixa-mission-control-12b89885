// The live audit's webhook: what a run reports, and how it is believed.
// Server-only; /api/public/hooks/live-audit delegates here.
//
// In order, a callback must:
//   1. name a run that exists — an unknown id and a bad signature get the same
//      401, so a caller that cannot authenticate learns nothing about ids;
//   2. be signed with THAT run's derived key, timestamped inside the window;
//   3. arrive while the run is open — a closed run's key opens nothing (409);
//   4. come from a workflow run in Prime's repository, when it names one;
//   5. not replay a signature already processed.
//
// Then the event is applied. Findings are upserted by `live_audit_ingest_
// findings` and the run closed by `live_audit_finalize_run`, in Postgres, under
// row locks; a finding is resolved by its absence there, and only on a run the
// runner reports complete, on the page templates it reports it covered.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/json-cast";
import {
  RunCallbackSchema,
  coveredTemplates,
  runWasComplete,
  type LiveAuditFinding,
  type RunCallback,
} from "@/lib/live-audit-contract";
import { verifyCallbackSignature } from "@/server/codex-callback-keys.server";
import { runUrlBelongsTo } from "@/server/codex-scan-callback.server";
import {
  claimLiveAuditReceipt,
  liveAuditKeysFor,
  releaseLiveAuditReceipt,
  resolveLiveAuditMasterSecrets,
} from "@/server/live-audit-keys.server";
import { alertOnRunCompleted, alertOnRunFailed } from "@/server/live-audit-alerts.server";

const admin = supabaseAdmin;

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
export const EVIDENCE_BUCKET = "live-audit-evidence";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "failed", "canceled"]);
const OPEN_STATUSES = ["queued", "dispatched", "running"];

type Run = {
  id: string;
  target_key: string;
  status: string;
  repo_full_name: string;
  phases: unknown;
  started_at: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function recordEvent(runId: string, eventType: string, payload: Record<string, unknown>) {
  const { error } = await admin
    .from("live_audit_events")
    .insert({ run_id: runId, event_type: eventType, payload: asJson(payload) });
  // The timeline is an audit convenience — never fail a run over it.
  if (error) console.warn(`[live-audit-callback] could not record ${eventType}:`, error.message);
}

export async function handleLiveAuditCallback(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "invalid payload" }, 400);
  }
  const claimed = (parsed as { run_id?: unknown } | null)?.run_id;
  if (typeof claimed !== "string" || !UUID.test(claimed))
    return json({ error: "invalid signature" }, 401);

  const { data: runRow, error: runErr } = await admin
    .from("live_audit_runs")
    .select("id, target_key, status, repo_full_name, phases, started_at")
    .eq("id", claimed)
    .maybeSingle();
  if (runErr) return json({ error: "run lookup failed" }, 500);
  if (!runRow) return json({ error: "invalid signature" }, 401);
  const run = runRow as Run;

  const masters = await resolveLiveAuditMasterSecrets();
  const verdict = await verifyCallbackSignature({
    rawBody: raw,
    signature: request.headers.get("x-live-audit-signature"),
    timestamp: request.headers.get("x-live-audit-timestamp"),
    keys: await liveAuditKeysFor(masters, "run", run.id),
    allowUntimestamped: false,
  });
  if (!verdict.ok) return json({ error: "invalid signature" }, 401);

  const result = RunCallbackSchema.safeParse(parsed);
  if (!result.success) {
    return json({ error: "invalid payload", detail: result.error.message.slice(0, 1000) }, 400);
  }
  const payload = result.data;
  if (TERMINAL.has(run.status)) return json({ error: "run is closed", status: run.status }, 409);
  if (payload.workflow_run_url && !runUrlBelongsTo(payload.workflow_run_url, run.repo_full_name)) {
    return json({ error: "workflow run is not in Prime's repository" }, 400);
  }

  const receipt = await claimLiveAuditReceipt("run", verdict.digest, run.id);
  if (receipt === "duplicate") return json({ ok: true, duplicate: true });

  try {
    const outcome = await applyEvent(run, payload);
    if (outcome.status >= 500 && receipt === "new") await releaseLiveAuditReceipt(verdict.digest);
    return json(outcome.body, outcome.status);
  } catch (err) {
    if (receipt === "new") await releaseLiveAuditReceipt(verdict.digest);
    return json({ error: "processing failed", detail: (err as Error).message }, 500);
  }
}

/** Where the workflow run is, as soon as a callback says. */
function runPatch(payload: RunCallback): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (payload.workflow_run_id) patch.workflow_run_id = payload.workflow_run_id;
  if (payload.workflow_run_url) patch.workflow_run_url = payload.workflow_run_url;
  if (payload.runner_version !== undefined) patch.runner_version = payload.runner_version;
  return patch;
}

function withPhase(phases: unknown, name: string, value: Record<string, unknown>) {
  const current =
    phases && typeof phases === "object" && !Array.isArray(phases)
      ? (phases as Record<string, unknown>)
      : {};
  return asJson({ ...current, [name]: { ...value, at: new Date().toISOString() } });
}

async function applyEvent(
  run: Run,
  payload: RunCallback,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const now = new Date().toISOString();

  switch (payload.event) {
    case "run.started": {
      const { error } = await admin
        .from("live_audit_runs")
        .update({
          ...runPatch(payload),
          status: "running",
          started_at: run.started_at ?? now,
          auth_state: payload.auth?.state ?? null,
          anthropic: asJson(payload.anthropic ?? null),
          phases: withPhase(run.phases, "started", {
            status: "ok",
            mode: payload.mode ?? null,
            sha: payload.sha ?? null,
            auth: payload.auth ?? null,
            knowledge: payload.knowledge ?? null,
          }),
          last_error: null,
        })
        .eq("id", run.id)
        .in("status", OPEN_STATUSES);
      if (error)
        return { status: 500, body: { error: "run update failed", detail: error.message } };
      await recordEvent(run.id, "run.started", {
        auth: payload.auth?.state ?? null,
        anthropic: (payload.anthropic as { available?: unknown } | undefined)?.available ?? null,
        workflow_run_url: payload.workflow_run_url ?? null,
      });
      return { status: 200, body: { ok: true } };
    }

    case "run.context": {
      // What the run should not report as new, and should re-test: every
      // finding Mission Control holds for this target that is not resolved,
      // dismissed ones included, so the triage agent can name them duplicates.
      const { data, error } = await admin
        .from("live_audit_findings")
        .select("fingerprint, route_template, title, state, severity")
        .eq("target_key", run.target_key)
        .neq("state", "resolved")
        .order("last_seen_at", { ascending: false })
        .limit(300);
      if (error)
        return {
          status: 500,
          body: { error: "findings could not be read", detail: error.message },
        };
      return { status: 200, body: { ok: true, findings: data ?? [] } };
    }

    case "run.progress": {
      const { phase, status, ...rest } = payload as RunCallback & {
        phase: string;
        status?: string;
      };
      const detail = Object.fromEntries(
        Object.entries(rest).filter(
          ([k]) =>
            ![
              "run_id",
              "event",
              "runner_version",
              "workflow_run_id",
              "workflow_run_url",
              "sent_at",
            ].includes(k),
        ),
      );
      const { error } = await admin
        .from("live_audit_runs")
        .update({
          ...runPatch(payload),
          status: "running",
          phases: withPhase(run.phases, phase, { status: status ?? null, ...detail }),
        })
        .eq("id", run.id)
        // Never back to running: the sweep may have closed it since it was read.
        .in("status", OPEN_STATUSES);
      if (error)
        return { status: 500, body: { error: "run update failed", detail: error.message } };
      await recordEvent(run.id, `phase.${phase}`, { status: status ?? null, ...detail });
      return { status: 200, body: { ok: true } };
    }

    case "run.findings": {
      const findings = payload.findings;
      const shots = new Map<string, NonNullable<LiveAuditFinding["screenshot"]>>();
      const rows = findings.map((f) => {
        const { screenshot, ...rest } = f;
        if (screenshot) shots.set(f.fingerprint, screenshot);
        return rest;
      });
      const ingest = await admin.rpc("live_audit_ingest_findings", {
        p_run_id: run.id,
        p_findings: asJson(rows),
      });
      if (ingest.error) {
        await recordEvent(run.id, "findings.ingest_failed", {
          error: ingest.error.message,
          count: rows.length,
        });
        return {
          status: 500,
          body: { error: "failed to persist findings", detail: ingest.error.message },
        };
      }
      const result = (ingest.data ?? {}) as {
        ids?: Array<{ fingerprint: string; id: string }>;
        inserted?: number;
        regressions?: number;
        fix_ineffective?: number;
      };
      const stored = await storeEvidence(run, result.ids ?? [], shots);
      await recordEvent(run.id, "run.findings", {
        batch: payload.batch,
        count: rows.length,
        inserted: result.inserted ?? 0,
        regressions: result.regressions ?? 0,
        fix_ineffective: result.fix_ineffective ?? 0,
        screenshots: stored,
      });
      return { status: 200, body: { ok: true, ...result, ids: undefined, screenshots: stored } };
    }

    case "run.completed": {
      const summary = payload.summary;
      const fin = await admin.rpc("live_audit_finalize_run", {
        p_run_id: run.id,
        p_summary: asJson(summary),
        p_complete: runWasComplete(summary),
        p_covered: coveredTemplates(summary),
      });
      if (fin.error)
        return {
          status: 500,
          body: { error: "failed to finalize run", detail: fin.error.message },
        };
      const s = summary as { auth?: { state?: string }; anthropic?: unknown; phases?: unknown };
      const { error } = await admin
        .from("live_audit_runs")
        .update({
          ...runPatch(payload),
          auth_state: s.auth?.state ?? null,
          anthropic: asJson(s.anthropic ?? null),
          phases: withPhase(run.phases, "completed", { status: "ok", phases: s.phases ?? null }),
        })
        .eq("id", run.id);
      if (error) console.warn("[live-audit-callback] completed run not annotated:", error.message);
      await recordEvent(run.id, "run.completed", {
        ...(fin.data as Record<string, unknown>),
        complete: runWasComplete(summary),
      });
      await alertOnRunCompleted(run.id);
      return { status: 200, body: { ok: true, ...(fin.data as Record<string, unknown>) } };
    }

    case "run.failed": {
      const reason = (payload.error ?? "the run failed").slice(0, 2000);
      const { error } = await admin
        .from("live_audit_runs")
        .update({
          ...runPatch(payload),
          status: "failed",
          completed_at: now,
          last_error: reason,
          ...(payload.summary ? { summary: asJson(payload.summary) } : {}),
          phases: withPhase(run.phases, "failed", {
            status: "failed",
            phase: payload.phase ?? null,
            error: reason,
          }),
        })
        .eq("id", run.id)
        .in("status", OPEN_STATUSES);
      if (error)
        return { status: 500, body: { error: "run update failed", detail: error.message } };
      await recordEvent(run.id, "run.failed", { phase: payload.phase ?? null, error: reason });
      await alertOnRunFailed(run.id);
      return { status: 200, body: { ok: true } };
    }
  }
}

/**
 * One screenshot per finding, replaced as it is seen again. Best effort: a
 * finding whose evidence could not be stored is still a finding.
 */
async function storeEvidence(
  run: Run,
  ids: Array<{ fingerprint: string; id: string }>,
  shots: Map<string, { mime: string; data: string }>,
): Promise<number> {
  let stored = 0;
  for (const { fingerprint, id } of ids) {
    const shot = shots.get(fingerprint);
    if (!shot || !UUID.test(id)) continue;
    const path = `${run.target_key}/${id}/latest.${shot.mime === "image/png" ? "png" : "jpg"}`;
    try {
      const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
      const { error } = await admin.storage
        .from(EVIDENCE_BUCKET)
        .upload(path, bytes, { contentType: shot.mime, upsert: true });
      if (error) {
        console.warn("[live-audit-callback] evidence not stored:", error.message);
        continue;
      }
      const { error: upErr } = await admin
        .from("live_audit_findings")
        .update({ screenshot_path: path })
        .eq("id", id);
      if (upErr) console.warn("[live-audit-callback] evidence path not recorded:", upErr.message);
      else stored += 1;
    } catch (err) {
      console.warn("[live-audit-callback] evidence not decoded:", (err as Error).message);
    }
  }
  return stored;
}
