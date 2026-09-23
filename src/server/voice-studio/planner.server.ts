// One tick of the planning worker: claim queued runs and advance each as far as
// the tick's budget allows.
//
// What makes a run resumable lives in two places. Its ARTIFACTS hold every
// stage unit already paid for (plannerEngine.pure.ts), and its `stage_cursor`
// pins the two inputs that must not move under a run: which document is
// `doc:1`, `doc:2`..., fixed when the run was queued so a document uploaded
// mid-run cannot renumber the citations already written; and the context
// document, stored as an artifact on the first tick so every later stage (and
// the citation check) reads exactly what the first stage read.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { recipeBookSha, RECIPE_BOOK_VERSION } from "@/lib/voice-recipe/recipeBook.pure";
import {
  advanceRun,
  planIsApprovable,
  type SourceDocument,
  type Usage,
} from "@/lib/voice-studio/plannerEngine.pure";
import { CONTEXT_DOC_ID } from "@/lib/voice-studio/targetContext.pure";
import { anthropicPlannerModel, uploadPdfToFiles, VOICE_STUDIO_MODEL } from "./anthropic.server";
import { gatherTargetContext } from "./context.server";
import { VOICE_STUDIO_BUCKET } from "./documents.server";

const DEFAULT_TICK_BUDGET_MS = 150_000;
const DEFAULT_MAX_RUN_USD = 25;

export type RunCursor = { docs: Array<{ id: string; docId: string; title: string }> };

export function tickBudgetMs(): number {
  const n = Number(process.env.VOICE_STUDIO_TICK_BUDGET_MS);
  return Number.isFinite(n) && n >= 30_000 ? n : DEFAULT_TICK_BUDGET_MS;
}

export function maxRunUsd(): number {
  const n = Number(process.env.VOICE_STUDIO_MAX_RUN_USD);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RUN_USD;
}

/** Queue a planning run: fix the document numbering, then leave it for the worker. */
export async function queuePlanningRun(
  projectId: string,
  userId: string,
): Promise<{ runId: string }> {
  const { data: live, error: liveError } = await supabaseAdmin
    .from("voice_studio_runs")
    .select("id")
    .eq("project_id", projectId)
    .in("status", ["queued", "running"])
    .limit(1)
    .maybeSingle();
  if (liveError) throw liveError;
  if (live) throw new Error("a plan is already being made for this project");

  const { data: docs, error } = await supabaseAdmin
    .from("voice_studio_documents")
    .select("id, file_name, extraction_status")
    .eq("project_id", projectId)
    .in("extraction_status", ["extracted", "native"])
    .order("created_at", { ascending: true });
  if (error) throw error;

  const cursor: RunCursor = {
    docs: (docs ?? []).map((d, i) => ({ id: d.id, docId: `doc:${i + 1}`, title: d.file_name })),
  };
  const { data: run, error: insertError } = await supabaseAdmin
    .from("voice_studio_runs")
    .insert({
      project_id: projectId,
      stage_cursor: cursor as unknown as Json,
      requested_by: userId,
      model: VOICE_STUDIO_MODEL,
      recipe_version: RECIPE_BOOK_VERSION,
      recipe_sha: await recipeBookSha(),
    })
    .select("id")
    .single();
  if (insertError) throw insertError;

  const { error: projError } = await supabaseAdmin
    .from("voice_studio_projects")
    .update({ status: "planning" })
    .eq("id", projectId);
  if (projError) throw projError;
  return { runId: run.id };
}

type ClaimedRun = {
  id: string;
  project_id: string;
  stage_cursor: Json;
  cost_usd: number;
  usage: Json;
  requested_by: string | null;
  recipe_sha: string | null;
};

export async function runVoiceStudioPlanTick(): Promise<{
  claimed: number;
  completed: number;
  continued: number;
  failed: number;
}> {
  const started = Date.now();
  const deadline = started + tickBudgetMs();
  const { data: runs, error } = await supabaseAdmin.rpc("claim_voice_studio_runs", {
    _limit: 2,
    _lease_seconds: 600,
  });
  if (error) throw error;

  const summary = { claimed: runs?.length ?? 0, completed: 0, continued: 0, failed: 0 };
  // One at a time: two runs sharing a tick would each get half a budget, and a
  // run's own stages are already concurrent.
  for (const run of (runs ?? []) as ClaimedRun[]) {
    if (Date.now() >= deadline) {
      await requeue(run.id, "the tick's budget was spent before this run started");
      summary.continued++;
      continue;
    }
    try {
      const outcome = await processRun(run, deadline);
      summary[outcome]++;
    } catch (err) {
      summary.failed++;
      await failRun(run, err instanceof Error ? err.message : String(err));
    }
  }
  return summary;
}

async function requeue(runId: string, note: string | null): Promise<void> {
  const { error } = await supabaseAdmin
    .from("voice_studio_runs")
    .update({ status: "queued", claimed_at: null, last_error: note })
    .eq("id", runId);
  if (error) throw error;
}

async function failRun(run: ClaimedRun, message: string): Promise<void> {
  console.error(`[voice-studio] run ${run.id} failed: ${message}`);
  const { error } = await supabaseAdmin
    .from("voice_studio_runs")
    .update({
      status: "failed",
      last_error: message.slice(0, 2000),
      completed_at: new Date().toISOString(),
    })
    .eq("id", run.id);
  if (error)
    console.error(`[voice-studio] could not record the failure of run ${run.id}: ${error.message}`);
  const { error: projError } = await supabaseAdmin
    .from("voice_studio_projects")
    .update({ status: "failed" })
    .eq("id", run.project_id);
  if (projError)
    console.error(
      `[voice-studio] could not mark project ${run.project_id} failed: ${projError.message}`,
    );
}

async function processRun(run: ClaimedRun, deadline: number): Promise<"completed" | "continued"> {
  const { data: project, error: projectError } = await supabaseAdmin
    .from("voice_studio_projects")
    .select("id, name, target_kind, clone_id, lead_id, agreement_id, notes")
    .eq("id", run.project_id)
    .single();
  if (projectError) throw projectError;

  const cursor = (run.stage_cursor ?? { docs: [] }) as unknown as RunCursor;
  const artifacts = await loadArtifacts(run.id);

  // The context is fixed on the first tick.
  if (!artifacts.has(`context:${CONTEXT_DOC_ID}`)) {
    const text = await gatherTargetContext(project);
    await saveArtifact(run.id, "context", CONTEXT_DOC_ID, { text }, null);
    artifacts.set(`context:${CONTEXT_DOC_ID}`, { text });
  }
  const contextText = (artifacts.get(`context:${CONTEXT_DOC_ID}`) as { text: string | null }).text;

  const sources: SourceDocument[] = [];
  for (const d of cursor.docs) {
    const { data: doc, error } = await supabaseAdmin
      .from("voice_studio_documents")
      .select("id, kind, storage_path, file_name, extracted_text, anthropic_file_id")
      .eq("id", d.id)
      .maybeSingle();
    if (error) throw error;
    // A document deleted after the run was queued is simply not read.
    if (!doc) continue;
    let fileId = doc.anthropic_file_id;
    if (doc.kind === "pdf" && !fileId)
      fileId = await ensurePdfUploaded(doc.id, doc.storage_path, doc.file_name);
    sources.push({
      docId: d.docId,
      title: d.title,
      text: doc.kind === "pdf" ? null : doc.extracted_text,
      fileId,
    });
  }
  if (contextText)
    sources.push({
      docId: CONTEXT_DOC_ID,
      title: "Mission Control context",
      text: contextText,
      fileId: null,
    });

  const usageTotals = { ...((run.usage ?? {}) as Record<string, number>) };
  const model = anthropicPlannerModel({ runId: run.id, userId: run.requested_by });
  const outcome = await advanceRun(
    {
      sources,
      artifacts,
      costSoFar: Number(run.cost_usd ?? 0),
      maxCostUsd: maxRunUsd(),
      deadline,
      now: Date.now,
      recipeSha: run.recipe_sha ?? (await recipeBookSha()),
    },
    model,
    {
      saveArtifact: async (kind, key, data, usage) => {
        if (usage) addUsage(usageTotals, usage);
        await saveArtifact(run.id, kind, key, data, usage);
      },
      recordProgress: async (stage, costUsd) => {
        const { error } = await supabaseAdmin
          .from("voice_studio_runs")
          .update({
            stage,
            cost_usd: Number(costUsd.toFixed(4)),
            usage: usageTotals as unknown as Json,
          })
          .eq("id", run.id);
        if (error) throw error;
      },
    },
  );

  if (outcome.status === "continue") {
    await requeue(run.id, null);
    return "continued";
  }

  const { data: latest, error: versionError } = await supabaseAdmin
    .from("voice_studio_plans")
    .select("version")
    .eq("project_id", run.project_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (versionError) throw versionError;

  const { error: supersedeError } = await supabaseAdmin
    .from("voice_studio_plans")
    .update({ status: "superseded" })
    .eq("project_id", run.project_id)
    .eq("status", "draft");
  if (supersedeError) throw supersedeError;

  const { data: plan, error: planError } = await supabaseAdmin
    .from("voice_studio_plans")
    .insert({
      project_id: run.project_id,
      run_id: run.id,
      version: (latest?.version ?? 0) + 1,
      plan: outcome.plan as unknown as Json,
      confidence: outcome.plan.confidence.score,
      has_errors: !planIsApprovable(outcome.plan),
      created_by: run.requested_by,
    })
    .select("id")
    .single();
  if (planError) throw planError;

  const { error: runError } = await supabaseAdmin
    .from("voice_studio_runs")
    .update({
      status: "complete",
      stage: "assemble",
      last_error: null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", run.id);
  if (runError) throw runError;
  const { error: projError } = await supabaseAdmin
    .from("voice_studio_projects")
    .update({ status: "plan_ready", current_plan_id: plan.id })
    .eq("id", run.project_id);
  if (projError) throw projError;
  return "completed";
}

function addUsage(totals: Record<string, number>, u: Usage): void {
  totals.input_tokens = (totals.input_tokens ?? 0) + u.inputTokens;
  totals.output_tokens = (totals.output_tokens ?? 0) + u.outputTokens;
  totals.cache_read_tokens = (totals.cache_read_tokens ?? 0) + u.cacheReadTokens;
  totals.cache_write_tokens = (totals.cache_write_tokens ?? 0) + u.cacheWriteTokens;
  totals.calls = (totals.calls ?? 0) + 1;
}

async function loadArtifacts(runId: string): Promise<Map<string, unknown>> {
  const { data, error } = await supabaseAdmin
    .from("voice_studio_artifacts")
    .select("kind, key, data")
    .eq("run_id", runId);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [`${r.kind}:${r.key}`, r.data as unknown]));
}

async function saveArtifact(
  runId: string,
  kind: string,
  key: string,
  data: unknown,
  usage: Usage | null,
): Promise<void> {
  const { error } = await supabaseAdmin.from("voice_studio_artifacts").upsert(
    {
      run_id: runId,
      kind,
      key,
      data: data as Json,
      usage: (usage ?? {}) as unknown as Json,
    },
    { onConflict: "run_id,kind,key" },
  );
  if (error) throw error;
}

async function ensurePdfUploaded(
  documentId: string,
  storagePath: string,
  fileName: string,
): Promise<string> {
  const { data: blob, error } = await supabaseAdmin.storage
    .from(VOICE_STUDIO_BUCKET)
    .download(storagePath);
  if (error || !blob)
    throw new Error(`"${fileName}" could not be read from storage: ${error?.message ?? "empty"}`);
  const fileId = await uploadPdfToFiles(new Uint8Array(await blob.arrayBuffer()), fileName);
  const { error: updateError } = await supabaseAdmin
    .from("voice_studio_documents")
    .update({ anthropic_file_id: fileId })
    .eq("id", documentId);
  if (updateError) throw updateError;
  return fileId;
}
