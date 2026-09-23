// The Voice Cloning Studio - server functions.
//
// Operators read everything; only admins create, plan, edit, approve, set keys
// and deploy. Two of those reads are narrower than the rest on purpose: the
// deploy settings come back as fingerprints and flags, never as values, and no
// function here selects an encrypted column.
//
// The work itself lives in src/server/voice-studio/ and is reached through
// the lazy server shim, so none of it is bundled for the browser.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import type { BuildPackage } from "@/lib/voice-studio/package.pure";
import type { Json } from "@/integrations/supabase/types";
import { diffPackages } from "@/lib/voice-studio/diff.pure";

const uuid = z.string().uuid();

const shim = () => import(/* @vite-ignore */ "@/lib/_server-shims/voice-studio.server");

export const VOICE_STUDIO_BUCKET = "voice-studio-docs";

/* --------------------------------- reading -------------------------------- */

export const listStudioProjects = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("voice_studio_projects")
      .select(
        "id, name, target_kind, clone_id, lead_id, agreement_id, status, created_at, updated_at, current_plan_id, current_package_id",
      )
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    const ids = (data ?? []).map((p) => p.id);
    const docCounts = new Map<string, number>();
    if (ids.length) {
      const { data: docs, error: docsError } = await context.supabase
        .from("voice_studio_documents")
        .select("project_id")
        .in("project_id", ids);
      if (docsError) throw docsError;
      for (const d of docs ?? [])
        docCounts.set(d.project_id, (docCounts.get(d.project_id) ?? 0) + 1);
    }
    return (data ?? []).map((p) => ({ ...p, document_count: docCounts.get(p.id) ?? 0 }));
  });

/** What a new project can target, for the New Project dialog. */
export const listStudioTargets = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async ({ context }) => {
    const [clones, leads, agreements] = await Promise.all([
      context.supabase.from("clones").select("id, name").order("name").limit(500),
      context.supabase
        .from("waitlist_leads")
        .select("id, entity_name, first_name, last_name, stage")
        .order("created_at", { ascending: false })
        .limit(300),
      context.supabase
        .from("client_agreements")
        .select("id, client_name, client_org, status")
        .order("created_at", { ascending: false })
        .limit(300),
    ]);
    for (const r of [clones, leads, agreements]) if (r.error) throw r.error;
    return {
      clones: (clones.data ?? []).map((c) => ({ id: c.id, label: c.name })),
      leads: (leads.data ?? []).map((l) => ({
        id: l.id,
        label:
          l.entity_name || `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim() || "Unnamed lead",
        detail: `Stage ${l.stage ?? 1}`,
      })),
      agreements: (agreements.data ?? []).map((a) => ({
        id: a.id,
        label: a.client_org || a.client_name,
        detail: a.status,
      })),
    };
  });

export const getStudioProject = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const sb = context.supabase;
    const { data: project, error } = await sb
      .from("voice_studio_projects")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!project) throw new Error("project_not_found");

    const [docs, runs, plans, packages, deployments, ledger] = await Promise.all([
      sb
        .from("voice_studio_documents")
        .select(
          "id, file_name, kind, size_bytes, extraction_status, truncated, page_count, error, created_at, extracted_text",
        )
        .eq("project_id", data.id)
        .order("created_at"),
      sb
        .from("voice_studio_runs")
        .select(
          "id, status, stage, attempts, last_error, cost_usd, usage, model, recipe_version, created_at, updated_at, completed_at",
        )
        .eq("project_id", data.id)
        .order("created_at", { ascending: false })
        .limit(10),
      sb
        .from("voice_studio_plans")
        .select("id, version, status, confidence, has_errors, edit_note, created_at, approved_at")
        .eq("project_id", data.id)
        .order("version", { ascending: false }),
      sb
        .from("voice_studio_packages")
        .select("id, plan_id, version, status, content_sha256, created_at, approved_at")
        .eq("project_id", data.id)
        .order("version", { ascending: false }),
      sb
        .from("voice_studio_deployments")
        .select(
          "id, package_id, mode, status, steps, verification, last_error, created_at, completed_at",
        )
        .eq("project_id", data.id)
        .order("created_at", { ascending: false })
        .limit(15),
      sb
        .from("voice_studio_vapi_ledger")
        .select("kind, key, vapi_id, verified_at, updated_at")
        .eq("project_id", data.id)
        .order("kind"),
    ]);
    for (const r of [docs, runs, plans, packages, deployments, ledger]) if (r.error) throw r.error;

    // Returned as stored JSON; the page reads it as a CloningPlan / BuildPackage.
    let currentPlan: Json | null = null;
    if (project.current_plan_id) {
      const { data: p, error: pError } = await sb
        .from("voice_studio_plans")
        .select("plan")
        .eq("id", project.current_plan_id)
        .maybeSingle();
      if (pError) throw pError;
      currentPlan = p?.plan ?? null;
    }
    let currentPackage: Json | null = null;
    if (project.current_package_id) {
      const { data: p, error: pError } = await sb
        .from("voice_studio_packages")
        .select("package")
        .eq("id", project.current_package_id)
        .maybeSingle();
      if (pError) throw pError;
      currentPackage = p?.package ?? null;
    }

    const { readDeploySettings, studioModelConfigured } = await shim();
    return {
      project,
      // The list view needs the size of what was read, not every character of it.
      documents: (docs.data ?? []).map(({ extracted_text, ...d }) => ({
        ...d,
        text_chars: extracted_text?.length ?? 0,
      })),
      runs: runs.data ?? [],
      plans: plans.data ?? [],
      packages: packages.data ?? [],
      deployments: deployments.data ?? [],
      ledger: ledger.data ?? [],
      currentPlan,
      currentPackage,
      deploySettings: await readDeploySettings(data.id),
      modelConfigured: studioModelConfigured(),
    };
  });

export const getStudioDocumentUrl = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ documentId: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { signedDocumentUrl } = await shim();
    return { url: await signedDocumentUrl(data.documentId) };
  });

export const getStudioPackageDiff = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ fromId: uuid.nullable(), toId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const ids = [data.toId, ...(data.fromId ? [data.fromId] : [])];
    const { data: rows, error } = await context.supabase
      .from("voice_studio_packages")
      .select("id, package")
      .in("id", ids);
    if (error) throw error;
    const to = rows?.find((r) => r.id === data.toId)?.package as unknown as
      | BuildPackage
      | undefined;
    const from = data.fromId
      ? (rows?.find((r) => r.id === data.fromId)?.package as unknown as BuildPackage | undefined)
      : null;
    if (!to) throw new Error("package_not_found");
    return diffPackages(from ?? null, to);
  });

/* --------------------------------- writing -------------------------------- */

export const createStudioProject = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        name: z.string().trim().min(2).max(200),
        targetKind: z.enum(["clone", "lead", "agreement", "prospect"]),
        cloneId: uuid.nullable().default(null),
        leadId: uuid.nullable().default(null),
        agreementId: uuid.nullable().default(null),
        notes: z.string().max(10_000).default(""),
      })
      .refine((v) => v.targetKind !== "clone" || v.cloneId, "clone_required")
      .refine((v) => v.targetKind !== "lead" || v.leadId, "lead_required")
      .refine((v) => v.targetKind !== "agreement" || v.agreementId, "agreement_required")
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("voice_studio_projects")
      .insert({
        name: data.name,
        target_kind: data.targetKind,
        clone_id: data.targetKind === "clone" ? data.cloneId : null,
        lead_id: data.targetKind === "lead" ? data.leadId : null,
        agreement_id: data.targetKind === "agreement" ? data.agreementId : null,
        notes: data.notes || null,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error?.code === "23505") throw new Error("this agreement already has a cloning project");
    if (error) throw error;
    return { id: row.id };
  });

export const updateStudioProjectNotes = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ id: uuid, notes: z.string().max(10_000) }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("voice_studio_projects")
      .update({ notes: data.notes || null })
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

export const registerStudioDocumentFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        projectId: uuid,
        storagePath: z.string().min(3).max(500),
        fileName: z.string().min(1).max(300),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { registerStudioDocument } = await shim();
    return registerStudioDocument({ ...data, userId: context.userId });
  });

export const deleteStudioDocumentFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ documentId: uuid }).parse(input))
  .handler(async ({ data }) => {
    const { deleteStudioDocument } = await shim();
    await deleteStudioDocument(data.documentId);
    return { ok: true };
  });

export const startStudioPlanning = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ projectId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { queuePlanningRun, studioModelConfigured } = await shim();
    if (!studioModelConfigured()) {
      throw new Error(
        "the planning agent is not configured on this deployment (VOICE_STUDIO_ANTHROPIC_API_KEY)",
      );
    }
    return queuePlanningRun(data.projectId, context.userId);
  });

export const cancelStudioRun = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ runId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: run, error } = await context.supabase
      .from("voice_studio_runs")
      .update({ status: "cancelled", completed_at: new Date().toISOString() })
      .eq("id", data.runId)
      .in("status", ["queued", "running"])
      .select("project_id")
      .maybeSingle();
    if (error) throw error;
    if (run) {
      const { error: projError } = await context.supabase
        .from("voice_studio_projects")
        .update({ status: "draft" })
        .eq("id", run.project_id);
      if (projError) throw projError;
    }
    return { ok: true };
  });

export const saveStudioPlanEdit = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        projectId: uuid,
        basePlanId: uuid,
        edit: z.unknown(),
        note: z.string().max(1000).default(""),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { savePlanEdit } = await shim();
    return savePlanEdit({ ...data, edit: data.edit, userId: context.userId });
  });

export const approveStudioPlan = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ planId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { approvePlanAndCompile } = await shim();
    return approvePlanAndCompile({ planId: data.planId, userId: context.userId });
  });

export const approveStudioPackage = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ packageId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { approvePackage } = await shim();
    await approvePackage({ packageId: data.packageId, userId: context.userId });
    return { ok: true };
  });

export const setStudioVapiKey = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z.object({ projectId: uuid, apiKey: z.string().min(16).max(200) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { setProjectVapiKey } = await shim();
    // Only the fingerprint travels back.
    return setProjectVapiKey({ ...data, userId: context.userId });
  });

export const setStudioDeploySettings = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        projectId: uuid,
        makeTransferHookUrl: z.string().max(300).nullable().optional(),
        escalationNumber: z.string().max(40).nullable().optional(),
        callLogUrl: z.string().max(500).nullable().optional(),
        callLogSecret: z.string().max(300).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { setDeploySettings } = await shim();
    await setDeploySettings({ ...data, userId: context.userId });
    return { ok: true };
  });

export const queueStudioDeployment = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        projectId: uuid,
        packageId: uuid,
        mode: z.enum(["dry_run", "apply", "rollback"]),
        phoneNumberId: z.string().trim().max(100).nullable().default(null),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { queueDeployment } = await shim();
    return queueDeployment({
      ...data,
      phoneNumberId: data.phoneNumberId || null,
      userId: context.userId,
    });
  });
