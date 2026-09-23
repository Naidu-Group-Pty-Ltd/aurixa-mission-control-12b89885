// Plans and packages after the model has finished: an operator's edits, the two
// approvals, and the compile between them.
//
// Every edit writes a NEW plan version and every compile a NEW package version,
// so an approval always names exactly what was approved and a deploy exactly
// what was approved to deploy. An edited plan is re-validated with the same
// checks the planner ran - an operator's words are linted for URLs, invented
// numbers and denied claims exactly like a model's, because the agent reads
// them out either way.
import * as z from "zod/v4";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  checkCitations,
  collectCitations,
  computePlanConfidence,
} from "@/lib/voice-studio/confidence.pure";
import { compilePackage } from "@/lib/voice-studio/package.pure";
import {
  AgentContent,
  BusinessProfile,
  KbPartDraft,
  PlanTopology,
  VoiceContextDraft,
  type CloningPlan,
} from "@/lib/voice-studio/schemas.pure";
import { CONTEXT_DOC_ID } from "@/lib/voice-studio/targetContext.pure";
import { hasErrors, validatePlan } from "@/lib/voice-studio/validate.pure";
import type { RunCursor } from "./planner.server";

/** The editable parts of a plan. Everything else is recomputed. */
export const PlanEdit = z.object({
  profile: BusinessProfile,
  topology: PlanTopology,
  agents: z.array(AgentContent),
  voiceContext: VoiceContextDraft,
  kb: z.array(KbPartDraft),
});
export type PlanEdit = z.infer<typeof PlanEdit>;

/** The extracted text a plan's citations and numbers are checked against. */
async function sourcesForRun(runId: string | null): Promise<Record<string, string>> {
  if (!runId) return {};
  const { data: run, error } = await supabaseAdmin
    .from("voice_studio_runs")
    .select("stage_cursor")
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  const cursor = (run?.stage_cursor ?? { docs: [] }) as unknown as RunCursor;
  const out: Record<string, string> = {};
  const ids = cursor.docs.map((d) => d.id);
  if (ids.length) {
    const { data: docs, error: docsError } = await supabaseAdmin
      .from("voice_studio_documents")
      .select("id, extracted_text")
      .in("id", ids);
    if (docsError) throw docsError;
    for (const d of cursor.docs) {
      const text = docs?.find((x) => x.id === d.id)?.extracted_text;
      if (text) out[d.docId] = text;
    }
  }
  const { data: ctx, error: ctxError } = await supabaseAdmin
    .from("voice_studio_artifacts")
    .select("data")
    .eq("run_id", runId)
    .eq("kind", "context")
    .eq("key", CONTEXT_DOC_ID)
    .maybeSingle();
  if (ctxError) throw ctxError;
  const text = (ctx?.data as { text?: string | null } | null)?.text;
  if (text) out[CONTEXT_DOC_ID] = text;
  return out;
}

/** Save an operator's edit as the next plan version, re-validated. */
export async function savePlanEdit(args: {
  projectId: string;
  basePlanId: string;
  edit: unknown;
  note: string;
  userId: string;
}): Promise<{ planId: string; version: number; hasErrors: boolean }> {
  const edit = PlanEdit.parse(args.edit);
  const { data: base, error } = await supabaseAdmin
    .from("voice_studio_plans")
    .select("id, project_id, run_id, plan")
    .eq("id", args.basePlanId)
    .single();
  if (error) throw error;
  if (base.project_id !== args.projectId) throw new Error("plan_not_in_project");
  const prior = base.plan as unknown as CloningPlan;

  const sources = await sourcesForRun(base.run_id);
  const result = validatePlan({ ...edit, sources });
  const openItems = [...prior.openItems.filter((o) => o.source === "planner"), ...result.openItems];
  const plan: CloningPlan = {
    ...prior,
    ...edit,
    topology: result.topology,
    issues: result.issues,
    openItems,
    confidence: computePlanConfidence({
      citations: checkCitations(collectCitations(edit.profile, edit.kb), sources),
      gapCount: edit.profile.gaps.length,
      issues: result.issues,
      openItemCount: openItems.length,
    }),
  };

  const { data: latest, error: vError } = await supabaseAdmin
    .from("voice_studio_plans")
    .select("version")
    .eq("project_id", args.projectId)
    .order("version", { ascending: false })
    .limit(1)
    .single();
  if (vError) throw vError;

  const { error: supersedeError } = await supabaseAdmin
    .from("voice_studio_plans")
    .update({ status: "superseded" })
    .eq("project_id", args.projectId)
    .eq("status", "draft");
  if (supersedeError) throw supersedeError;

  const version = latest.version + 1;
  const { data: row, error: insertError } = await supabaseAdmin
    .from("voice_studio_plans")
    .insert({
      project_id: args.projectId,
      run_id: base.run_id,
      version,
      plan: plan as unknown as Json,
      confidence: plan.confidence.score,
      has_errors: hasErrors(plan.issues),
      edit_note: args.note.slice(0, 1000) || null,
      created_by: args.userId,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;
  const { error: projError } = await supabaseAdmin
    .from("voice_studio_projects")
    .update({ current_plan_id: row.id, current_package_id: null, status: "plan_ready" })
    .eq("id", args.projectId);
  if (projError) throw projError;
  return { planId: row.id, version, hasErrors: hasErrors(plan.issues) };
}

/**
 * Approve a plan and compile its package. An errored plan is refused here
 * as well as in the browser: the button is a convenience, this is the rule.
 */
export async function approvePlanAndCompile(args: {
  planId: string;
  userId: string;
}): Promise<{ packageId: string; version: number }> {
  const { data: plan, error } = await supabaseAdmin
    .from("voice_studio_plans")
    .select("id, project_id, status, plan, has_errors")
    .eq("id", args.planId)
    .single();
  if (error) throw error;
  if (plan.has_errors)
    throw new Error("this plan has validation errors; fix them in an edit before approving it");
  if (plan.status === "superseded" || plan.status === "rejected")
    throw new Error(`this plan is ${plan.status}; approve the current version`);

  const cloning = plan.plan as unknown as CloningPlan;
  // Re-check on the server rather than trusting the stored flag alone.
  if (hasErrors(cloning.issues)) throw new Error("this plan has validation errors");

  const pkg = await compilePackage(cloning);
  const now = new Date().toISOString();
  if (plan.status !== "approved") {
    const { error: approveError } = await supabaseAdmin
      .from("voice_studio_plans")
      .update({ status: "approved", approved_by: args.userId, approved_at: now })
      .eq("id", plan.id);
    if (approveError) throw approveError;
  }

  const { data: latest, error: vError } = await supabaseAdmin
    .from("voice_studio_packages")
    .select("version")
    .eq("project_id", plan.project_id)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (vError) throw vError;

  // A package identical to one already compiled from this plan is that package.
  const { data: same, error: sameError } = await supabaseAdmin
    .from("voice_studio_packages")
    .select("id, version")
    .eq("plan_id", plan.id)
    .eq("content_sha256", pkg.contentSha256)
    .limit(1)
    .maybeSingle();
  if (sameError) throw sameError;
  if (same) return { packageId: same.id, version: same.version };

  const { error: supersedeError } = await supabaseAdmin
    .from("voice_studio_packages")
    .update({ status: "superseded" })
    .eq("project_id", plan.project_id)
    .eq("status", "draft");
  if (supersedeError) throw supersedeError;

  const version = (latest?.version ?? 0) + 1;
  const { data: row, error: insertError } = await supabaseAdmin
    .from("voice_studio_packages")
    .insert({
      project_id: plan.project_id,
      plan_id: plan.id,
      version,
      package: pkg as unknown as Json,
      content_sha256: pkg.contentSha256,
      created_by: args.userId,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;

  const { error: projError } = await supabaseAdmin
    .from("voice_studio_projects")
    .update({ status: "package_ready", current_plan_id: plan.id, current_package_id: row.id })
    .eq("id", plan.project_id);
  if (projError) throw projError;
  return { packageId: row.id, version };
}

export async function approvePackage(args: { packageId: string; userId: string }): Promise<void> {
  const { data: pkg, error } = await supabaseAdmin
    .from("voice_studio_packages")
    .select("id, project_id, status")
    .eq("id", args.packageId)
    .single();
  if (error) throw error;
  if (pkg.status === "superseded")
    throw new Error("this package has been superseded; approve the current version");
  if (pkg.status !== "approved") {
    const { error: approveError } = await supabaseAdmin
      .from("voice_studio_packages")
      .update({
        status: "approved",
        approved_by: args.userId,
        approved_at: new Date().toISOString(),
      })
      .eq("id", pkg.id);
    if (approveError) throw approveError;
  }
  const { error: projError } = await supabaseAdmin
    .from("voice_studio_projects")
    .update({ status: "package_approved", current_package_id: pkg.id })
    .eq("id", pkg.project_id);
  if (projError) throw projError;
}
