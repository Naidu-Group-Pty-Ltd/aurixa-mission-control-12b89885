/**
 * Library reset + re-ingest.
 *
 * Rebuilds the module catalogue from scratch: wipe `modules` and
 * `module_library`, re-run detection against the prime, approve what comes
 * back, and publish every module as v1 of a fresh library. Publishing approves
 * each entry at the commit the new run read (`libraryApproval.server.ts`,
 * D19), so a reset that publishes is an admin's to run, and it asks before it
 * wipes anything rather than after.
 *
 * The reason this is not a couple of DELETE statements is blast radius.
 * `clone_modules.module_id` is `ON DELETE CASCADE`, so dropping the modules
 * table silently erases which modules every clone in the fleet has installed —
 * and the cascade engine reads exactly that table to decide what to push, so
 * every clone would quietly start cascading nothing. `clone_library_pins` and
 * `module_config_snapshots` hold soft references (no FK) and would be left
 * dangling, which makes the cascade pre-flight fail those clones outright.
 *
 * So the reset:
 *   1. snapshots clone installs and pins by *slug* (stable across re-ingest)
 *   2. wipes and re-detects
 *   3. restores what it can, by slug
 *   4. reports precisely what could not be restored, rather than dropping it
 *
 * `dryRun` performs step 1 and reports the plan without deleting anything.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { runDetection, DEFAULT_CONFIG, type DetectionRunConfig } from "./module-detection.server";
import {
  probeCommitColumns,
  publishModulesToLibrary,
  requireLibraryAdmin,
} from "./libraryApproval.server";

type Supabase = SupabaseClient<Database>;

/** Typing this out is the point: it is hard to trigger by accident. */
export const RESET_CONFIRMATION = "RESET LIBRARY";

export type CloneInstallSnapshot = {
  cloneId: string;
  slugs: string[];
};

export type PinSnapshot = {
  cloneId: string;
  slug: string;
  version: number;
};

export type ReingestReport = {
  ok: boolean;
  dryRun: boolean;
  error?: string;
  runId?: string;
  before: {
    modules: number;
    libraryEntries: number;
    cloneInstalls: number;
    clonesWithModules: number;
    libraryPins: number;
  };
  after: {
    modulesDetected: number;
    modulesApproved: number;
    libraryEntriesPublished: number;
    backendModules: number;
    fullstackModules: number;
  };
  restored: {
    cloneInstalls: number;
    /** Slugs that existed before but no longer do — installs that could not be restored. */
    unmappedSlugs: string[];
    /** Clones left with no modules because none of their slugs survived. */
    clonesLeftEmpty: string[];
    pins: number;
    unmappedPins: Array<{ cloneId: string; slug: string; version: number }>;
  };
  warnings: string[];
};

function emptyReport(dryRun: boolean): ReingestReport {
  return {
    ok: false,
    dryRun,
    before: {
      modules: 0,
      libraryEntries: 0,
      cloneInstalls: 0,
      clonesWithModules: 0,
      libraryPins: 0,
    },
    after: {
      modulesDetected: 0,
      modulesApproved: 0,
      libraryEntriesPublished: 0,
      backendModules: 0,
      fullstackModules: 0,
    },
    restored: {
      cloneInstalls: 0,
      unmappedSlugs: [],
      clonesLeftEmpty: [],
      pins: 0,
      unmappedPins: [],
    },
    warnings: [],
  };
}

/** Read every clone's installed module slugs, so they survive the wipe. */
export async function snapshotCloneInstalls(supabase: Supabase): Promise<CloneInstallSnapshot[]> {
  const { data } = await supabase.from("clone_modules").select("clone_id, modules(slug)");
  const byClone = new Map<string, string[]>();
  for (const row of (data ?? []) as Array<{
    clone_id: string;
    modules: { slug: string } | null;
  }>) {
    if (!row.modules?.slug) continue;
    const list = byClone.get(row.clone_id) ?? [];
    list.push(row.modules.slug);
    byClone.set(row.clone_id, list);
  }
  return [...byClone.entries()].map(([cloneId, slugs]) => ({
    cloneId,
    slugs: [...new Set(slugs)].sort(),
  }));
}

export async function snapshotPins(supabase: Supabase): Promise<PinSnapshot[]> {
  const { data } = await supabase.from("clone_library_pins").select("clone_id, slug, version");
  return ((data ?? []) as Array<{ clone_id: string; slug: string; version: number }>).map((p) => ({
    cloneId: p.clone_id,
    slug: p.slug,
    version: p.version,
  }));
}

export type ReingestOptions = {
  /** Must equal RESET_CONFIRMATION for anything to be deleted. */
  confirmation: string;
  /** Report the plan without deleting or writing anything. */
  dryRun?: boolean;
  /** Detection overrides; defaults to feature-first with backend detection on. */
  config?: Partial<DetectionRunConfig>;
  /** Re-install modules on clones by slug after the rebuild. Default true. */
  preserveCloneInstalls?: boolean;
  /** Publish every approved module to the library. Default true. */
  publishToLibrary?: boolean;
  /**
   * Also clear detection run history, drift alerts and import edges. The blob
   * analysis cache is always kept — it is content-addressed, so it stays valid
   * and re-fetching ~1,400 blobs would cost most of the GitHub App's budget.
   */
  clearHistory?: boolean;
};

export async function resetAndReingestLibrary(args: {
  supabase: Supabase;
  userId: string;
  options: ReingestOptions;
}): Promise<ReingestReport> {
  const { supabase, userId, options } = args;
  const dryRun = options.dryRun ?? false;
  const report = emptyReport(dryRun);

  if (!dryRun && options.confirmation !== RESET_CONFIRMATION) {
    report.error = `Confirmation required — pass "${RESET_CONFIRMATION}" to wipe the library`;
    return report;
  }

  // Publishing approves each entry, and only an admin may. Asked before the
  // wipe: a reset refused at its publish step would leave an empty library.
  if (options.publishToLibrary !== false) {
    const admin = await requireLibraryAdmin(
      supabase,
      userId,
      "publish library entries, which approves them",
    );
    if (!admin.ok) {
      if (!dryRun) {
        report.error = `${admin.error}. Nothing was wiped.`;
        return report;
      }
      report.warnings.push(`A real run would be refused: ${admin.error}.`);
    }
  }

  // The new detection run records the commit it read, and fails without
  // somewhere to record it: asked now, while nothing has been wiped.
  const columns = await probeCommitColumns(supabase);
  if (!columns.ok) {
    if (!dryRun) {
      report.error = `The commit columns cannot be read, so nothing was wiped: ${columns.error}`;
      return report;
    }
    report.warnings.push(`A real run would be refused: ${columns.error}.`);
  }

  // ── 1. Snapshot current state ──
  const [modulesRes, libraryRes, installs, pins] = await Promise.all([
    supabase.from("modules").select("id, slug, status"),
    supabase.from("module_library").select("id, slug"),
    snapshotCloneInstalls(supabase),
    snapshotPins(supabase),
  ]);

  const existingModules = modulesRes.data ?? [];
  report.before = {
    modules: existingModules.length,
    libraryEntries: (libraryRes.data ?? []).length,
    cloneInstalls: installs.reduce((n, c) => n + c.slugs.length, 0),
    clonesWithModules: installs.length,
    libraryPins: pins.length,
  };

  if (dryRun) {
    report.ok = true;
    report.warnings.push(
      `Dry run — nothing was deleted. A real run would remove ${report.before.modules} module(s) ` +
        `and ${report.before.libraryEntries} library entr(ies), then re-detect from the prime.`,
    );
    if (report.before.cloneInstalls > 0) {
      report.warnings.push(
        `${report.before.cloneInstalls} clone module install(s) across ${report.before.clonesWithModules} ` +
          `clone(s) would be snapshotted and restored by slug. Slugs that the new detection does not ` +
          `reproduce cannot be restored and will be reported.`,
      );
    }
    if (report.before.libraryPins > 0) {
      report.warnings.push(
        `${report.before.libraryPins} library pin(s) would be re-pointed at the newly published v1 entries.`,
      );
    }
    return report;
  }

  // ── 2. Wipe ──
  // Order matters: soft-referencing rows first, then the tables that cascade.
  await supabase.from("clone_library_pins").delete().not("id", "is", null);
  await supabase.from("module_library").delete().not("id", "is", null);

  if (options.clearHistory) {
    await supabase.from("modules").update({ detection_run_id: null }).not("id", "is", null);
    await supabase.from("module_drift_alerts").delete().not("id", "is", null);
    await supabase.from("module_import_edges").delete().not("id", "is", null);
    await supabase.from("module_backend_artifacts").delete().not("id", "is", null);
    await supabase
      .from("module_detection_runs")
      .update({ previous_run_id: null })
      .not("id", "is", null);
    await supabase.from("module_detection_runs").delete().not("id", "is", null);
  }

  // Config snapshots reference module UUIDs that are about to disappear.
  await supabase.from("module_config_snapshots").delete().not("id", "is", null);

  // This cascades clone_modules, module_drift_alerts and module_backend_artifacts.
  const { error: wipeErr } = await supabase.from("modules").delete().not("id", "is", null);
  if (wipeErr) {
    report.error = `Failed to wipe modules: ${wipeErr.message}`;
    return report;
  }

  await supabase.from("audit_log").insert({
    action: "module_library.reset",
    entity_type: "module_library",
    actor_user_id: userId,
    metadata: {
      modules_removed: report.before.modules,
      library_entries_removed: report.before.libraryEntries,
      clone_installs_snapshotted: report.before.cloneInstalls,
      pins_snapshotted: report.before.libraryPins,
    },
  });

  // ── 3. Re-detect ──
  const config: DetectionRunConfig = { ...DEFAULT_CONFIG, ...options.config, deltaMode: false };
  const detection = await runDetection({ supabase, userId, config });
  report.runId = detection.runId;

  if (!detection.ok) {
    report.error = `Detection failed after wipe: ${detection.error ?? "unknown"}`;
    report.warnings.push(
      "The catalogue is now empty. Fix the detection error and re-run — clone installs " +
        "were snapshotted but cannot be restored until modules exist again.",
    );
    return report;
  }

  const { data: fresh } = await supabase.from("modules").select("id, slug, layer");
  const freshModules = fresh ?? [];
  report.after.modulesDetected = freshModules.length;
  report.after.backendModules = freshModules.filter((m) => m.layer === "backend").length;
  report.after.fullstackModules = freshModules.filter((m) => m.layer === "fullstack").length;

  if (freshModules.length === 0) {
    report.error = "Detection produced no modules";
    return report;
  }

  // ── 4. Approve everything ──
  // A freshly re-ingested catalogue is the operator's intended state; leaving
  // it all "proposed" would mean nothing could be published or installed.
  const { error: approveErr } = await supabase
    .from("modules")
    .update({
      status: "approved",
      approved_by: userId,
      approved_at: new Date().toISOString(),
      rejection_reason: null,
    })
    .in(
      "id",
      freshModules.map((m) => m.id),
    );
  if (approveErr) {
    report.warnings.push(`Could not auto-approve modules: ${approveErr.message}`);
  } else {
    report.after.modulesApproved = freshModules.length;
  }

  // ── 5. Publish to the library ──
  if (options.publishToLibrary !== false) {
    const published = await publishAllToLibrary(supabase, userId);
    report.after.libraryEntriesPublished = published.count;
    if (published.errors.length > 0) {
      report.warnings.push(
        `${published.errors.length} module(s) failed to publish: ${published.errors.slice(0, 5).join("; ")}`,
      );
    }
    report.warnings.push(...published.warnings);
  }

  // ── 6. Restore clone installs by slug ──
  const idBySlug = new Map(freshModules.map((m) => [m.slug, m.id]));

  if (options.preserveCloneInstalls !== false && installs.length > 0) {
    const rows: Array<{ clone_id: string; module_id: string; installed_by: string }> = [];
    const unmapped = new Set<string>();
    const emptied: string[] = [];

    for (const inst of installs) {
      let mappedForClone = 0;
      for (const slug of inst.slugs) {
        const id = idBySlug.get(slug);
        if (id) {
          rows.push({ clone_id: inst.cloneId, module_id: id, installed_by: userId });
          mappedForClone++;
        } else {
          unmapped.add(slug);
        }
      }
      if (mappedForClone === 0) emptied.push(inst.cloneId);
    }

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase
        .from("clone_modules")
        .upsert(rows.slice(i, i + 500), { onConflict: "clone_id,module_id" });
      if (error) report.warnings.push(`Restoring clone installs failed: ${error.message}`);
    }

    report.restored.cloneInstalls = rows.length;
    report.restored.unmappedSlugs = [...unmapped].sort();
    report.restored.clonesLeftEmpty = emptied;

    if (unmapped.size > 0) {
      report.warnings.push(
        `${unmapped.size} old module slug(s) no longer exist, so ${report.before.cloneInstalls - rows.length} ` +
          `install(s) could not be restored. This is expected when switching detection strategy — ` +
          `the new modules are named after product domains, not individual routes. ` +
          `Re-select modules for affected clones.`,
      );
    }
    if (emptied.length > 0) {
      report.warnings.push(
        `${emptied.length} clone(s) now have no modules installed and will cascade nothing until ` +
          `modules are selected for them.`,
      );
    }
  }

  // ── 7. Re-point library pins ──
  if (pins.length > 0) {
    const { data: entries } = await supabase
      .from("module_library")
      .select("id, slug, version")
      .eq("is_latest", true);
    const entryBySlug = new Map(
      ((entries ?? []) as Array<{ id: string; slug: string; version: number }>).map((e) => [
        e.slug,
        e,
      ]),
    );

    const pinRows: Array<{
      clone_id: string;
      library_entry_id: string;
      slug: string;
      version: number;
      pinned_by: string;
      notes: string;
    }> = [];
    for (const p of pins) {
      const entry = entryBySlug.get(p.slug);
      if (!entry) {
        report.restored.unmappedPins.push(p);
        continue;
      }
      pinRows.push({
        clone_id: p.cloneId,
        library_entry_id: entry.id,
        slug: p.slug,
        version: entry.version,
        pinned_by: userId,
        notes: `Re-pointed from v${p.version} during library re-ingest`,
      });
    }

    if (pinRows.length > 0) {
      const { error } = await supabase
        .from("clone_library_pins")
        .upsert(pinRows, { onConflict: "clone_id,slug" });
      if (error) report.warnings.push(`Restoring library pins failed: ${error.message}`);
      else report.restored.pins = pinRows.length;
    }
    if (report.restored.unmappedPins.length > 0) {
      report.warnings.push(
        `${report.restored.unmappedPins.length} pin(s) referenced slugs that no longer exist and were dropped. ` +
          `Those clones now track the live module instead of a pinned version.`,
      );
    }
  }

  await supabase.from("audit_log").insert({
    action: "module_library.reingest_complete",
    entity_type: "module_library",
    entity_id: detection.runId,
    actor_user_id: userId,
    metadata: JSON.parse(
      JSON.stringify({
        strategy: config.strategy,
        before: report.before,
        after: report.after,
        restored: {
          clone_installs: report.restored.cloneInstalls,
          unmapped_slugs: report.restored.unmappedSlugs.slice(0, 100),
          pins: report.restored.pins,
        },
      }),
    ),
  });

  report.ok = true;
  return report;
}

/**
 * Publish every approved module, through the one publication path. Called
 * after a wipe, so there is no prior version to supersede and each entry is v1:
 * versions restart by design, which is what makes the new library readable
 * rather than carrying old numbering. Each entry is approved at the commit the
 * detection run read, and a module whose run recorded none is refused by name.
 */
export async function publishAllToLibrary(
  supabase: Supabase,
  userId: string,
): Promise<{ count: number; errors: string[]; warnings: string[] }> {
  const answer = await publishModulesToLibrary(supabase, {
    userId,
    moduleIds: "approved",
    tagsFor: (m) => [m.layer].filter(Boolean),
  });
  // One line per module that was not published; a refusal of the whole
  // publication (the role, a read) has no module to name, so it is its own line.
  const errors = answer.refused.map((r) => r.reason);
  if (!answer.ok && answer.error && errors.length === 0) errors.push(answer.error);
  return { count: answer.published, errors, warnings: answer.warnings };
}
