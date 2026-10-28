import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { assessBlastRadius } from "@/lib/blast-radius";
import {
  runDetection,
  analyzeModuleIntelligence,
  DEFAULT_CONFIG,
  type DetectionStrategy,
  type DetectionRunConfig,
} from "./module-detection.server";
import { publishModulesToLibrary, readModuleLibrary } from "./libraryApproval.server";

// Enhanced multi-pass AI module detection
export const detectModules = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data?: {
      strategy?: DetectionStrategy;
      maxModules?: number;
      minModules?: number;
      sampleFileContent?: boolean;
      analyzeImports?: boolean;
      deltaMode?: boolean;
      detectBackend?: boolean;
      includeBackendGlobs?: boolean;
      synthesizeBackendModules?: boolean;
      maxBackendBlobs?: number;
    }) => data ?? {},
  )
  .handler(async ({ data, context }) => {
    const config: DetectionRunConfig = {
      strategy: data.strategy ?? DEFAULT_CONFIG.strategy,
      maxModules: data.maxModules ?? DEFAULT_CONFIG.maxModules,
      minModules: data.minModules ?? DEFAULT_CONFIG.minModules,
      sampleFileContent: data.sampleFileContent ?? DEFAULT_CONFIG.sampleFileContent,
      analyzeImports: data.analyzeImports ?? DEFAULT_CONFIG.analyzeImports,
      deltaMode: data.deltaMode ?? DEFAULT_CONFIG.deltaMode,
      detectBackend: data.detectBackend ?? DEFAULT_CONFIG.detectBackend,
      includeBackendGlobs: data.includeBackendGlobs ?? DEFAULT_CONFIG.includeBackendGlobs,
      synthesizeBackendModules:
        data.synthesizeBackendModules ?? DEFAULT_CONFIG.synthesizeBackendModules,
      maxBackendBlobs: data.maxBackendBlobs ?? DEFAULT_CONFIG.maxBackendBlobs,
    };

    const refused = (error: string) => ({
      ok: false,
      runId: "",
      proposed: 0,
      inserted: 0,
      updated: 0,
      orphanAlerts: 0,
      error,
    });
    // A detection beside a running reset or another run writes the same
    // modules. It looks before it starts, and again once its run row exists,
    // when the look settles it (`catalogueCompetitor`).
    const { catalogueCompetitor } = await import(/* @vite-ignore */ "./library-reingest.server");
    const competitor = await catalogueCompetitor(context.supabase, {});
    if (competitor) return refused(competitor);

    return runDetection({
      supabase: context.supabase,
      userId: context.userId,
      config,
      guard: (runId) => catalogueCompetitor(context.supabase, { runId }),
    });
  });

// Fetch detection run history
export const getDetectionRuns = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("module_detection_runs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return { ok: false as const, error: error.message, runs: [] };
    return { ok: true as const, runs: data ?? [] };
  });

// Delete a single detection run + its drift alerts + import edges.
// Modules created by the run are NOT deleted — they are unlinked
// (detection_run_id set to null) so curated modules survive history cleanup.
export const deleteDetectionRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { runId: string }) => {
    if (!data?.runId) throw new Error("runId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;

    // Unlink modules so we don't violate FK constraints.
    await supabase
      .from("modules")
      .update({ detection_run_id: null })
      .eq("detection_run_id", data.runId);

    // Cascade-style cleanup of dependent rows.
    await supabase.from("module_drift_alerts").delete().eq("detection_run_id", data.runId);
    await supabase.from("module_import_edges").delete().eq("detection_run_id", data.runId);

    // Clear back-pointer from any later runs that reference this one.
    await supabase
      .from("module_detection_runs")
      .update({ previous_run_id: null })
      .eq("previous_run_id", data.runId);

    const { error } = await supabase.from("module_detection_runs").delete().eq("id", data.runId);
    if (error) return { ok: false as const, error: error.message };

    await supabase.from("audit_log").insert({
      action: "detection_run.delete",
      actor_user_id: context.userId,
      entity_type: "module_detection_run",
      entity_id: data.runId,
      metadata: {},
    });

    return { ok: true as const };
  });

// Bulk-clear detection history. Optionally keep the most recent N runs.
export const clearDetectionHistory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data?: { keepLatest?: number; onlyFailed?: boolean }) => data ?? {})
  .handler(async ({ data, context }) => {
    const supabase = context.supabase;
    const keepLatest = Math.max(0, data.keepLatest ?? 0);
    const onlyFailed = data.onlyFailed ?? false;

    let query = supabase
      .from("module_detection_runs")
      .select("id, status, created_at")
      .order("created_at", { ascending: false });
    if (onlyFailed) query = query.eq("status", "failed");

    const { data: rows, error } = await query;
    if (error) return { ok: false as const, error: error.message, deleted: 0 };

    const targets = (rows ?? []).slice(keepLatest).map((r) => r.id as string);
    if (targets.length === 0) return { ok: true as const, deleted: 0 };

    await supabase
      .from("modules")
      .update({ detection_run_id: null })
      .in("detection_run_id", targets);
    await supabase.from("module_drift_alerts").delete().in("detection_run_id", targets);
    await supabase.from("module_import_edges").delete().in("detection_run_id", targets);
    await supabase
      .from("module_detection_runs")
      .update({ previous_run_id: null })
      .in("previous_run_id", targets);

    const { error: delErr } = await supabase
      .from("module_detection_runs")
      .delete()
      .in("id", targets);
    if (delErr) return { ok: false as const, error: delErr.message, deleted: 0 };

    await supabase.from("audit_log").insert({
      action: "detection_run.clear",
      actor_user_id: context.userId,
      entity_type: "module_detection_run",
      metadata: { count: targets.length, keep_latest: keepLatest, only_failed: onlyFailed },
    });

    return { ok: true as const, deleted: targets.length };
  });

// Fetch import graph for a detection run
export const getImportGraph = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { runId: string }) => {
    if (!data?.runId) throw new Error("runId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { data: edges, error } = await context.supabase
      .from("module_import_edges")
      .select("*")
      .eq("detection_run_id", data.runId)
      .limit(500);
    if (error) return { ok: false as const, error: error.message, edges: [] };
    return { ok: true as const, edges: edges ?? [] };
  });

// Fetch drift alerts
export const getDriftAlerts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data?: { runId?: string; resolved?: boolean }) => data ?? {})
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("module_drift_alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (data.runId) query = query.eq("detection_run_id", data.runId);
    if (data.resolved !== undefined) query = query.eq("resolved", data.resolved);
    const { data: alerts, error } = await query;
    if (error) return { ok: false as const, error: error.message, alerts: [] };
    return { ok: true as const, alerts: alerts ?? [] };
  });

// Resolve a drift alert
export const resolveDriftAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { alertId: string }) => {
    if (!data?.alertId) throw new Error("alertId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("module_drift_alerts")
      .update({
        resolved: true,
        resolved_at: new Date().toISOString(),
        resolved_by: context.userId,
      })
      .eq("id", data.alertId);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

// Batch approve/reject/archive modules
export const batchUpdateModuleStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      moduleIds: string[];
      status: "approved" | "archived" | "rejected";
      rejectionReason?: string;
    }) => {
      if (!Array.isArray(data?.moduleIds) || data.moduleIds.length === 0)
        throw new Error("moduleIds required");
      if (!["approved", "archived", "rejected"].includes(data.status))
        throw new Error("status must be approved, archived, or rejected");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("modules")
      .update({
        status: data.status,
        approved_by: data.status === "approved" ? context.userId : null,
        approved_at: data.status === "approved" ? new Date().toISOString() : null,
        rejection_reason: data.status === "rejected" ? (data.rejectionReason ?? null) : null,
      })
      .in("id", data.moduleIds);
    if (error) return { ok: false as const, error: error.message };

    await context.supabase.from("audit_log").insert({
      action: `module.batch_${data.status}`,
      entity_type: "module",
      actor_user_id: context.userId,
      metadata: {
        module_ids: data.moduleIds,
        count: data.moduleIds.length,
        status: data.status,
        rejection_reason: data.rejectionReason,
      },
    });

    return { ok: true as const, count: data.moduleIds.length };
  });

/**
 * Approve modules, then cascade the chosen clones.
 *
 * Asks the second-operator gate every operator-started cascade asks
 * (`assessBlastRadius`). It used to write its event with no
 * `requires_approval`, so an auto-merge across every clone from this dialog
 * ran with one operator where the same push from the cascade page waited for
 * two.
 *
 * And it says what it delivers. Approving a module does not narrow a cascade:
 * the engine reads `scope_filter.module_globs` and nothing else of a module
 * scope, and installed globs do not depend on approval, so each clone
 * receives its whole sync scope, as any cascade does. The event's summary
 * called it a module deploy.
 */
export const approveAndDeploy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { moduleIds: string[]; cloneIds: string[]; cascadeMode?: string }) => {
    if (!Array.isArray(data?.moduleIds) || data.moduleIds.length === 0)
      throw new Error("moduleIds required");
    if (!Array.isArray(data?.cloneIds) || data.cloneIds.length === 0)
      throw new Error("cloneIds required");
    return data;
  })
  .handler(async ({ data, context }) => {
    // Approve modules first
    const { error: modErr } = await context.supabase
      .from("modules")
      .update({
        status: "approved",
        approved_by: context.userId,
        approved_at: new Date().toISOString(),
        rejection_reason: null,
      })
      .in("id", data.moduleIds);
    if (modErr) return { ok: false as const, error: modErr.message };

    // Create cascade event
    const mode: Database["public"]["Enums"]["cascade_mode"] =
      data.cascadeMode === "auto_merge" ? "auto_merge" : "pr";
    const blast = assessBlastRadius(mode, data.cloneIds.length);
    const insertRow: Database["public"]["Tables"]["cascade_events"]["Insert"] = {
      trigger: "manual",
      mode,
      status: "pending",
      requires_approval: blast.requiresApproval,
      initiated_by: context.userId,
      scope_filter: { module_ids: data.moduleIds },
      summary:
        `Cascade after approving ${data.moduleIds.length} module(s) → ` +
        `${data.cloneIds.length} clone(s), each across its whole sync scope`,
    };
    const { data: event, error: evtErr } = await context.supabase
      .from("cascade_events")
      .insert(insertRow)
      .select("id")
      .single();
    if (evtErr) return { ok: false as const, error: evtErr.message };

    // Create cascade results for each clone
    const results = data.cloneIds.map((cloneId) => ({
      cascade_event_id: event.id,
      clone_id: cloneId,
      status: "queued" as const,
    }));
    const { error: resErr } = await context.supabase.from("cascade_results").insert(results);
    if (resErr) return { ok: false as const, error: resErr.message };

    // Create tracking job
    const { error: jobErr } = await context.supabase.from("module_cascade_jobs").insert({
      module_ids: data.moduleIds,
      clone_ids: data.cloneIds,
      cascade_event_id: event.id,
      status: "queued",
      initiated_by: context.userId,
      metadata: { cascade_mode: data.cascadeMode ?? "pr" },
    });
    if (jobErr) return { ok: false as const, error: jobErr.message };

    if (blast.requiresApproval) {
      const { error: noticeErr } = await context.supabase.from("notifications").insert({
        kind: "cascade_awaiting_approval",
        severity: "warning",
        title: "Approval needed · cascade after module approval",
        body: `${blast.reason ?? ""} Cascade across ${data.cloneIds.length} clone(s).`,
        cascade_event_id: event.id,
        url: `/cascades/${event.id}`,
        metadata: { mode, clone_count: data.cloneIds.length, module_ids: data.moduleIds },
      });
      if (noticeErr) {
        console.error(
          `[approve-and-deploy] ${event.id} awaits approval but its notice did not land: ${noticeErr.message}`,
        );
      }
    }

    // Audit
    const { error: auditErr } = await context.supabase.from("audit_log").insert({
      action: "module.approve_and_deploy",
      entity_type: "cascade_event",
      entity_id: event.id,
      actor_user_id: context.userId,
      metadata: {
        module_ids: data.moduleIds,
        clone_ids: data.cloneIds,
        cascade_mode: mode,
        requires_approval: blast.requiresApproval,
      },
    });
    if (auditErr) {
      console.error(
        `[approve-and-deploy] ${event.id}: the audit row did not land: ${auditErr.message}`,
      );
    }

    return {
      ok: true as const,
      cascadeEventId: event.id,
      count: data.moduleIds.length,
      requiresApproval: blast.requiresApproval,
      approvalReason: blast.reason,
    };
  });

// Get cascade deploy jobs
export const getModuleCascadeJobs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("module_cascade_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return { ok: false as const, error: error.message, jobs: [] };
    return { ok: true as const, jobs: data ?? [] };
  });

// Cross-clone module intelligence
export const getModuleIntelligence = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    try {
      const result = await analyzeModuleIntelligence(context.supabase);
      return { ok: true as const, ...result };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        coInstallation: [],
        healthScores: [],
      };
    }
  });

// ─── Library reset + re-ingest ──────────────────────────────────────

/**
 * Wipe the module catalogue and rebuild it from a fresh detection run.
 *
 * Destructive: pass `dryRun: true` first to see the plan, then repeat with
 * `confirmation: "RESET LIBRARY"` to actually run it.
 */
export const resetAndReingest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data?: {
      confirmation?: string;
      dryRun?: boolean;
      strategy?: DetectionStrategy;
      preserveCloneInstalls?: boolean;
      publishToLibrary?: boolean;
      clearHistory?: boolean;
    }) => data ?? {},
  )
  .handler(async ({ data, context }) => {
    const { resetAndReingestLibrary } = await import(
      /* @vite-ignore */ "./library-reingest.server"
    );
    return resetAndReingestLibrary({
      supabase: context.supabase,
      userId: context.userId,
      options: {
        confirmation: data.confirmation ?? "",
        dryRun: data.dryRun ?? false,
        preserveCloneInstalls: data.preserveCloneInstalls ?? true,
        publishToLibrary: data.publishToLibrary ?? true,
        clearHistory: data.clearHistory ?? false,
        config: data.strategy ? { strategy: data.strategy } : undefined,
      },
    });
  });

// ─── Backend Architecture ───────────────────────────────────────────

/**
 * Everything a module needs on the backend: edge functions, tables, RPCs,
 * secrets, migrations, buckets and cron jobs, plus the trace of how each was
 * linked. Drives the module detail view and the pre-cascade readiness check.
 */
export const getModuleBackend = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { moduleId?: string; slug?: string }) => {
    if (!data?.moduleId && !data?.slug) throw new Error("moduleId or slug required");
    return data;
  })
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("modules")
      // One literal, deliberately: supabase-js parses the column list at the
      // type level, and a concatenated string is just `string` — which degrades
      // the row to `GenericStringError` and silently un-checks every field read
      // off it.
      // prettier-ignore
      .select(
        "id, name, slug, layer, edge_functions, database_tables, database_rpcs, storage_buckets, cron_jobs, required_secrets, required_migrations, backend_file_globs, external_hosts, backend_manifest, file_globs",
      );
    query = data.moduleId ? query.eq("id", data.moduleId) : query.eq("slug", data.slug!);

    const { data: module, error } = await query.maybeSingle();
    if (error) return { ok: false as const, error: error.message, module: null, artifacts: [] };
    if (!module)
      return { ok: false as const, error: "Module not found", module: null, artifacts: [] };

    const { data: artifacts } = await context.supabase
      .from("module_backend_artifacts")
      .select("*")
      .eq("module_id", module.id)
      .order("artifact_kind", { ascending: true })
      .order("identifier", { ascending: true })
      .limit(2000);

    return { ok: true as const, module, artifacts: artifacts ?? [] };
  });

/**
 * Reverse lookup: which modules claim a given backend artifact. Answers
 * "if I uninstall this module, does anything else still need this table?"
 */
export const getArtifactConsumers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { artifactKind: string; identifier: string }) => {
    if (!data?.artifactKind || !data?.identifier)
      throw new Error("artifactKind and identifier required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("module_backend_artifacts")
      .select("module_id, module_slug, link_reason, confidence, detection_run_id")
      .eq("artifact_kind", data.artifactKind)
      .eq("identifier", data.identifier)
      .limit(500);
    if (error) return { ok: false as const, error: error.message, consumers: [] };

    // Collapse to one row per module — a module can be linked by several runs.
    const bySlug = new Map<string, (typeof rows)[number]>();
    for (const r of rows ?? []) {
      if (!bySlug.has(r.module_slug)) bySlug.set(r.module_slug, r);
    }
    return { ok: true as const, consumers: [...bySlug.values()] };
  });

/**
 * Repo-wide backend inventory summary for a detection run — the counts the
 * detection history panel shows alongside the frontend module counts.
 */
export const getBackendSummary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data?: { runId?: string }) => data ?? {})
  .handler(async ({ data, context }) => {
    const base = context.supabase
      .from("module_detection_runs")
      .select(
        "id, created_at, completed_at, status, edge_function_count, migration_count, " +
          "database_object_count, secret_count, backend_module_count, backend_summary",
      );

    const query = data.runId
      ? base.eq("id", data.runId)
      : base.order("created_at", { ascending: false }).limit(1);

    const { data: run, error } = await query.maybeSingle();
    if (error) return { ok: false as const, error: error.message, run: null };
    return { ok: true as const, run };
  });

/**
 * Backend coverage across all modules: how much of the repo's backend surface
 * is actually claimed by a module. Unclaimed edge functions are surface that
 * would never reach a clone through a module install.
 */
export const getBackendCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [modulesRes, runRes] = await Promise.all([
      context.supabase
        .from("modules")
        .select("slug, name, status, layer, edge_functions, database_tables, required_secrets")
        .neq("status", "archived"),
      context.supabase
        .from("module_detection_runs")
        .select("backend_summary, edge_function_count, completed_at")
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const modules = modulesRes.data ?? [];
    const claimedFns = new Set<string>();
    const claimedTables = new Set<string>();
    const claimedSecrets = new Set<string>();
    for (const m of modules) {
      for (const f of (m.edge_functions ?? []) as string[]) claimedFns.add(f);
      for (const t of (m.database_tables ?? []) as string[]) claimedTables.add(t);
      for (const s of (m.required_secrets ?? []) as string[]) claimedSecrets.add(s);
    }

    const totalFns = runRes.data?.edge_function_count ?? 0;

    return {
      ok: true as const,
      totals: {
        edge_functions_in_repo: totalFns,
        edge_functions_claimed: claimedFns.size,
        edge_functions_unclaimed: Math.max(0, totalFns - claimedFns.size),
        tables_claimed: claimedTables.size,
        secrets_required: claimedSecrets.size,
        modules_with_backend: modules.filter(
          (m) => ((m.edge_functions ?? []) as string[]).length > 0,
        ).length,
        modules_total: modules.length,
        backend_only_modules: modules.filter((m) => m.layer === "backend").length,
      },
      lastRunAt: runRes.data?.completed_at ?? null,
    };
  });

// ─── Module Library ─────────────────────────────────────────────────

/**
 * Publish modules to the library, which approves each entry, by an admin, at
 * the prime commit its module's files were detected at
 * (`libraryApproval.server.ts`; docs/DELIVERY_SYSTEM_PLAN.md, D19). A module
 * whose detection run recorded no commit is refused by name.
 */
export const publishToLibrary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { moduleIds: string[]; tags?: string[] }) => {
    if (!Array.isArray(data?.moduleIds) || data.moduleIds.length === 0)
      throw new Error("moduleIds required");
    return data;
  })
  .handler(async ({ data, context }) =>
    publishModulesToLibrary(context.supabase, {
      userId: context.userId,
      moduleIds: data.moduleIds,
      tagsFor: () => data.tags ?? [],
    }),
  );

/**
 * Library entries, every one of them (paged, never cut at a row count), with
 * the names of the admins who approved them.
 */
export const getModuleLibrary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data?: { latestOnly?: boolean; slug?: string }) => data ?? {})
  .handler(async ({ data, context }) =>
    readModuleLibrary(context.supabase, {
      latestOnly: data.latestOnly !== false,
      slug: data.slug,
    }),
  );

// Remove library entry
export const removeFromLibrary = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { entryId: string }) => {
    if (!data?.entryId) throw new Error("entryId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("module_library").delete().eq("id", data.entryId);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });
