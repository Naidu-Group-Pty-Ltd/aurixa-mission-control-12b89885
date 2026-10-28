import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { decideLibraryEntry } from "./libraryApproval.server";
import { describeDbError, judgePinnable } from "./libraryApproval.pure";
import { validateClonePinsServer } from "./library-validation.server";

// ─── Library approval workflow (admin-only) ────────────────────────

/**
 * Approve, reject or reset a library entry. Admin only; approving needs the
 * commit the entry records, because an entry is approved at a commit
 * (`libraryApproval.server.ts`, `decideLibraryEntry`; D19).
 */
export const setLibraryApprovalStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { entryId: string; status: "approved" | "rejected" | "pending"; reason?: string }) => {
      if (!data?.entryId) throw new Error("entryId required");
      if (!["approved", "rejected", "pending"].includes(data.status))
        throw new Error("status must be approved, rejected, or pending");
      return data;
    },
  )
  .handler(async ({ data, context }) =>
    decideLibraryEntry(context.supabase, {
      userId: context.userId,
      entryId: data.entryId,
      status: data.status,
      reason: data.reason,
    }),
  );

// ─── Per-clone version pinning ─────────────────────────────────────

export const getCloneLibraryPins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { data: pins, error } = await context.supabase
      .from("clone_library_pins")
      .select("*")
      .eq("clone_id", data.cloneId)
      .order("slug", { ascending: true });
    if (error) return { ok: false as const, error: error.message, pins: [] };
    return { ok: true as const, pins: pins ?? [] };
  });

export const setCloneLibraryPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; libraryEntryId: string; notes?: string }) => {
    if (!data?.cloneId) throw new Error("cloneId required");
    if (!data?.libraryEntryId) throw new Error("libraryEntryId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    // Resolve the library entry → must be approved, at a commit it records
    const { data: entry, error: entryErr } = await context.supabase
      .from("module_library")
      .select("id, slug, version, approval_status, name, source_commit_sha")
      .eq("id", data.libraryEntryId)
      .maybeSingle();
    if (entryErr) return { ok: false as const, error: describeDbError(entryErr) };
    if (!entry) return { ok: false as const, error: "Library entry not found" };
    const pinnable = judgePinnable(entry);
    if (!pinnable.ok) {
      return {
        ok: false as const,
        error:
          pinnable.reason === "not approved"
            ? "Only approved library entries can be pinned"
            : `${entry.name} v${entry.version} ${pinnable.reason}, so it cannot be pinned`,
      };
    }

    // Upsert per (clone_id, slug)
    const { error: upErr } = await context.supabase.from("clone_library_pins").upsert(
      {
        clone_id: data.cloneId,
        library_entry_id: entry.id,
        slug: entry.slug,
        version: entry.version,
        pinned_by: context.userId,
        pinned_at: new Date().toISOString(),
        notes: data.notes ?? null,
      },
      { onConflict: "clone_id,slug" },
    );
    if (upErr) return { ok: false as const, error: upErr.message };

    await context.supabase.from("audit_log").insert({
      action: "library.pin",
      entity_type: "clone_library_pin",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: {
        clone_id: data.cloneId,
        slug: entry.slug,
        version: entry.version,
        library_entry_id: entry.id,
      },
    });

    return { ok: true as const };
  });

// Bulk apply: take a set of (slug, libraryEntryId) and upsert them across many clones.
// Skips entries that aren't approved and reports per-clone results.
export const bulkApplyClonePins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      cloneIds: string[];
      pins: Array<{ slug: string; libraryEntryId: string }>;
      notes?: string;
    }) => {
      if (!Array.isArray(data?.cloneIds) || data.cloneIds.length === 0)
        throw new Error("cloneIds required");
      if (!Array.isArray(data?.pins) || data.pins.length === 0)
        throw new Error("at least one pin required");
      return data;
    },
  )
  .handler(async ({ data, context }) => {
    // Resolve all entries up front
    const entryIds = Array.from(new Set(data.pins.map((p) => p.libraryEntryId)));
    const { data: entries, error: entryErr } = await context.supabase
      .from("module_library")
      .select("id, slug, version, approval_status, name, file_paths, source_commit_sha")
      .in("id", entryIds);
    if (entryErr) return { ok: false as const, error: describeDbError(entryErr), results: [] };

    const entryMap = new Map((entries ?? []).map((e) => [e.id, e]));

    type PerClone = {
      cloneId: string;
      applied: number;
      skipped: Array<{ slug: string; reason: string }>;
      error?: string;
    };
    const results: PerClone[] = [];

    for (const cloneId of data.cloneIds) {
      const perClone: PerClone = { cloneId, applied: 0, skipped: [] };
      const rows: Array<{
        clone_id: string;
        library_entry_id: string;
        slug: string;
        version: number;
        pinned_by: string;
        pinned_at: string;
        notes: string | null;
      }> = [];

      for (const p of data.pins) {
        const e = entryMap.get(p.libraryEntryId);
        if (!e) {
          perClone.skipped.push({ slug: p.slug, reason: "entry not found" });
          continue;
        }
        if (e.slug !== p.slug) {
          perClone.skipped.push({ slug: p.slug, reason: `slug mismatch (entry is ${e.slug})` });
          continue;
        }
        const pinnable = judgePinnable(e);
        if (!pinnable.ok) {
          perClone.skipped.push({ slug: p.slug, reason: pinnable.reason });
          continue;
        }
        rows.push({
          clone_id: cloneId,
          library_entry_id: e.id,
          slug: e.slug,
          version: e.version,
          pinned_by: context.userId,
          pinned_at: new Date().toISOString(),
          notes: data.notes ?? null,
        });
      }

      if (rows.length > 0) {
        const { error: upErr } = await context.supabase
          .from("clone_library_pins")
          .upsert(rows, { onConflict: "clone_id,slug" });
        if (upErr) perClone.error = upErr.message;
        else perClone.applied = rows.length;
      }
      results.push(perClone);
    }

    await context.supabase.from("audit_log").insert({
      action: "library.bulk_pin",
      entity_type: "clone_library_pin",
      entity_id: null,
      actor_user_id: context.userId,
      metadata: {
        clone_ids: data.cloneIds,
        pins: data.pins,
        applied_total: results.reduce((s, r) => s + r.applied, 0),
      },
    });

    return { ok: true as const, results };
  });

// Validate that pinned library entries still exist, are approved at a commit
// they record, and have file_paths, and report the commit each pin rests on.
// The cascade engine's pre-flight reads the same answer from the same module
// (`library-validation.server.ts`), so the page and the pass cannot disagree
// about which pin holds a delivery back.
export const validateClonePins = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneIds: string[] }) => {
    if (!Array.isArray(data?.cloneIds) || data.cloneIds.length === 0)
      throw new Error("cloneIds required");
    return data;
  })
  .handler(async ({ data, context }) => validateClonePinsServer(context.supabase, data.cloneIds));

export const removeCloneLibraryPin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { cloneId: string; slug: string }) => {
    if (!data?.cloneId || !data?.slug) throw new Error("cloneId and slug required");
    return data;
  })
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("clone_library_pins")
      .delete()
      .eq("clone_id", data.cloneId)
      .eq("slug", data.slug);
    if (error) return { ok: false as const, error: error.message };

    await context.supabase.from("audit_log").insert({
      action: "library.unpin",
      entity_type: "clone_library_pin",
      entity_id: data.cloneId,
      actor_user_id: context.userId,
      metadata: { clone_id: data.cloneId, slug: data.slug },
    });

    return { ok: true as const };
  });

// ─── Dependency graph viewer ───────────────────────────────────────
// Returns the import-edge subgraph for a single module, by intersecting
// the latest detection run's edges with the module's resolved files.

export const getModuleDependencyGraph = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { moduleId: string }) => {
    if (!data?.moduleId) throw new Error("moduleId required");
    return data;
  })
  .handler(async ({ data, context }) => {
    // 1. Load the module
    const { data: mod, error: modErr } = await context.supabase
      .from("modules")
      .select("*")
      .eq("id", data.moduleId)
      .maybeSingle();
    if (modErr || !mod) return { ok: false as const, error: modErr?.message ?? "Module not found" };

    const ownFiles = new Set<string>(
      ((mod.resolved_files as string[]) ?? mod.file_globs ?? []) as string[],
    );
    if (ownFiles.size === 0) {
      return {
        ok: true as const,
        module: { id: mod.id, name: mod.name, slug: mod.slug },
        ownFiles: [],
        edges: [],
        externalTargets: [],
        moduleDependencies: [],
      };
    }

    // 2. Pick most recent detection run that has edges for any of these files
    const runId = mod.detection_run_id as string | null;
    let edgesQuery = context.supabase
      .from("module_import_edges")
      .select("source_file, target_file, import_type")
      .in("source_file", Array.from(ownFiles))
      .limit(2000);
    if (runId) edgesQuery = edgesQuery.eq("detection_run_id", runId);

    const { data: edges, error: edgesErr } = await edgesQuery;
    if (edgesErr) return { ok: false as const, error: edgesErr.message };

    const edgeList = (edges ?? []) as Array<{
      source_file: string;
      target_file: string;
      import_type: string;
    }>;

    // 3. Identify external targets (files the module imports that are NOT in its own file set)
    const externalTargets = Array.from(
      new Set(edgeList.filter((e) => !ownFiles.has(e.target_file)).map((e) => e.target_file)),
    );

    // 4. Map external targets to owning modules (which other modules contain those files)
    const moduleDependencies: Array<{
      module_id: string;
      module_name: string;
      module_slug: string;
      shared_files: string[];
    }> = [];

    if (externalTargets.length > 0) {
      const { data: otherModules } = await context.supabase
        .from("modules")
        .select("id, name, slug, resolved_files")
        .neq("id", data.moduleId);

      for (const other of (otherModules ?? []) as Array<{
        id: string;
        name: string;
        slug: string;
        resolved_files: string[];
      }>) {
        const otherFiles = new Set(other.resolved_files ?? []);
        const shared = externalTargets.filter((t) => otherFiles.has(t));
        if (shared.length > 0) {
          moduleDependencies.push({
            module_id: other.id,
            module_name: other.name,
            module_slug: other.slug,
            shared_files: shared,
          });
        }
      }
    }

    return {
      ok: true as const,
      module: { id: mod.id, name: mod.name, slug: mod.slug },
      ownFiles: Array.from(ownFiles),
      edges: edgeList,
      externalTargets,
      moduleDependencies,
    };
  });
