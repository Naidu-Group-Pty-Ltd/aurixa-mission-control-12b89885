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
 *
 * Step 1's snapshot is written to the audit log before step 2 deletes
 * anything, every way out after that closes the record with what it could not
 * restore, and the next reset restores what earlier ones left owed
 * (`libraryReset.pure.ts`). A reset looks for a running reset or detection
 * before it snapshots and again once its row is written, and stops before the
 * wipe when one is there (`catalogueCompetitor`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  runDetection,
  findRunningDetection,
  runningRefusal,
  DEFAULT_CONFIG,
  RUNNING_RUN_WINDOW_MS,
  type DetectionRunConfig,
} from "./module-detection.server";
import {
  probeCommitColumns,
  publishModulesToLibrary,
  requireLibraryAdmin,
} from "./libraryApproval.server";
import {
  EMPTY_SNAPSHOT,
  RESET_AUDIT_ACTION,
  RESET_COMPLETE_AUDIT_ACTION,
  completionMetadata,
  installCount,
  judgeResetState,
  snapshotForAudit,
  withOwed,
  type AuditRow,
  type CloneInstallSnapshot,
  type PinSnapshot,
  type ResetSnapshot,
  type ResetState,
} from "./libraryReset.pure";
import { describeDbError } from "./libraryApproval.pure";
import type { Json } from "@/integrations/supabase/types";

type Supabase = SupabaseClient<Database>;

/** Rows per page of a paged read: PostgREST answers at most 1,000 rows a request. */
const SNAPSHOT_PAGE = 1000;

/** Typing this out is the point: it is hard to trigger by accident. */
export const RESET_CONFIRMATION = "RESET LIBRARY";

/**
 * Which resets are running and what earlier ones left owed, read from the
 * audit log (`judgeResetState`). `excludeId` leaves out the caller's own
 * reset, for the look it takes after recording it.
 *
 * Every reset and every completion is read, not the latest few: a debt stays
 * with the reset that left it until another takes it on, however many have
 * recorded themselves since. There are few: one of each on 28 Oct 2026.
 *
 * A failed read is an error, never "none running" or "nothing owed": a reset
 * that went on would wipe beside one that is running, or restore only what a
 * dead one left.
 */
export async function readResetState(
  supabase: Supabase,
  opts: { excludeId?: string; now?: number } = {},
): Promise<{ ok: true; state: ResetState } | { ok: false; error: string }> {
  const [resets, completions] = await Promise.all([
    readAuditTrail(supabase, RESET_AUDIT_ACTION),
    readAuditTrail(supabase, RESET_COMPLETE_AUDIT_ACTION),
  ]);
  if (!resets.ok) {
    return { ok: false, error: `the resets on record are unreadable: ${resets.error}` };
  }
  if (!completions.ok) {
    return { ok: false, error: `the resets' completions are unreadable: ${completions.error}` };
  }
  return {
    ok: true,
    state: judgeResetState({
      resets: resets.rows,
      completions: completions.rows,
      now: opts.now ?? Date.now(),
      windowMs: RUNNING_RUN_WINDOW_MS,
      excludeId: opts.excludeId,
    }),
  };
}

/** Every audit row of `action`, page by page, or the read's error. */
async function readAuditTrail(
  supabase: Supabase,
  action: string,
): Promise<{ ok: true; rows: AuditRow[] } | { ok: false; error: string }> {
  const rows: AuditRow[] = [];
  for (let from = 0; ; from += SNAPSHOT_PAGE) {
    const { data, error } = await supabase
      .from("audit_log")
      .select("id, created_at, metadata")
      .eq("action", action)
      .order("id", { ascending: true })
      .range(from, from + SNAPSHOT_PAGE - 1);
    if (error) return { ok: false, error: describeDbError(error) };
    const page = (data ?? []) as AuditRow[];
    rows.push(...page);
    if (page.length < SNAPSHOT_PAGE) return { ok: true, rows };
  }
}

/** The refusal a reset or a detection meets beside a reset that may still be running. */
export function resetRunningRefusal(reset: AuditRow): string {
  const retryAt = new Date(Date.parse(reset.created_at) + RUNNING_RUN_WINDOW_MS).toISOString();
  return (
    `The reset of ${reset.created_at} has not recorded its completion and may still be running. ` +
    `If it died, reset again after ${retryAt}, and that reset restores what it recorded.`
  );
}

/**
 * Who else is working on the catalogue, for a reset or a detection that has
 * just written its own marker (its reset row, or its run row) and looks again:
 * a reset still running, or a detection run, beside it. Null when nobody is.
 *
 * Asked only after the caller's own marker is written, so of two that start
 * together, the one that looks second sees the first and stops, and both can
 * never go on. A failed read stops the caller too: it cannot tell.
 */
export async function catalogueCompetitor(
  supabase: Supabase,
  own: { resetId?: string; runId?: string },
): Promise<string | null> {
  const [resets, runs] = await Promise.all([
    readResetState(supabase, { excludeId: own.resetId }),
    findRunningDetection(supabase, Date.now(), own.runId),
  ]);
  if (!resets.ok) return `${resets.error}, so it is not known whether a reset is running.`;
  if (resets.state.running.length > 0) return resetRunningRefusal(resets.state.running[0]);
  if (!runs.ok) return `${runs.error}, so it is not known whether a detection is running.`;
  if (runs.running) return runningRefusal(runs.running, own.resetId ? "a reset" : "a detection");
  return null;
}

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

/**
 * Every row of `table`, page by page, or the read's error. A snapshot that
 * stopped at the first page would restore a thousand installs and lose the
 * rest, and a failed read is never an empty table: the wipe that followed it
 * would take every install with it.
 */
async function readAllRows<T>(
  supabase: Supabase,
  table: "clone_modules" | "clone_library_pins",
  columns: string,
): Promise<{ ok: true; rows: T[] } | { ok: false; error: string }> {
  const rows: T[] = [];
  for (let from = 0; ; from += SNAPSHOT_PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order("id", { ascending: true })
      .range(from, from + SNAPSHOT_PAGE - 1);
    if (error) return { ok: false, error: `${table}: ${describeDbError(error)}` };
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < SNAPSHOT_PAGE) return { ok: true, rows };
  }
}

/** Read every clone's installed module slugs, so they survive the wipe. */
export async function snapshotCloneInstalls(
  supabase: Supabase,
): Promise<{ ok: true; installs: CloneInstallSnapshot[] } | { ok: false; error: string }> {
  const read = await readAllRows<{ clone_id: string; modules: { slug: string } | null }>(
    supabase,
    "clone_modules",
    "clone_id, modules(slug)",
  );
  if (!read.ok) return read;
  const byClone = new Map<string, string[]>();
  for (const row of read.rows) {
    if (!row.modules?.slug) continue;
    const list = byClone.get(row.clone_id) ?? [];
    list.push(row.modules.slug);
    byClone.set(row.clone_id, list);
  }
  return {
    ok: true,
    installs: [...byClone.entries()].map(([cloneId, slugs]) => ({
      cloneId,
      slugs: [...new Set(slugs)].sort(),
    })),
  };
}

export async function snapshotPins(
  supabase: Supabase,
): Promise<{ ok: true; pins: PinSnapshot[] } | { ok: false; error: string }> {
  const read = await readAllRows<{ clone_id: string; slug: string; version: number }>(
    supabase,
    "clone_library_pins",
    "clone_id, slug, version",
  );
  if (!read.ok) return read;
  return {
    ok: true,
    pins: read.rows.map((p) => ({ cloneId: p.clone_id, slug: p.slug, version: p.version })),
  };
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

  // Two runs at once write the same modules, and a reset beside a detection
  // that is still running wipes what it is writing. On 31 Jul 2026 three runs
  // overlapped, two of them started while the reset's own was reading. This is
  // the first look; the one that settles it is taken once this reset's row is
  // written (step 2).
  const running = await findRunningDetection(supabase);
  const runningWhy = !running.ok
    ? `${running.error}, so it is not known whether a detection is running.`
    : running.running
      ? runningRefusal(running.running, "a reset")
      : null;
  if (runningWhy) {
    if (!dryRun) {
      report.error = `${runningWhy} Nothing was wiped.`;
      return report;
    }
    report.warnings.push(`A real run would be refused: ${runningWhy}`);
  }

  // ── 1. Snapshot current state ──
  const [modulesRes, libraryRes, installsRead, pinsRead, stateRead] = await Promise.all([
    supabase.from("modules").select("id, slug, status"),
    supabase.from("module_library").select("id, slug"),
    snapshotCloneInstalls(supabase),
    snapshotPins(supabase),
    readResetState(supabase),
  ]);
  const unreadable = [
    modulesRes.error ? `modules: ${describeDbError(modulesRes.error)}` : null,
    libraryRes.error ? `module_library: ${describeDbError(libraryRes.error)}` : null,
    installsRead.ok ? null : installsRead.error,
    pinsRead.ok ? null : pinsRead.error,
    stateRead.ok ? null : stateRead.error,
  ].filter((why): why is string => why !== null);
  if (!installsRead.ok || !pinsRead.ok || !stateRead.ok || unreadable.length > 0) {
    report.error =
      `What the reset would remove and restore could not be read (${unreadable.join("; ")}). ` +
      `Nothing was wiped.`;
    return report;
  }

  // A reset with no completion inside the window may not be dead: it records
  // its snapshot before its detection run exists, and approves, publishes and
  // restores after that run says `completed`. A second reset now would wipe
  // what it is restoring.
  const otherReset = stateRead.state.running[0];
  if (otherReset) {
    const why = resetRunningRefusal(otherReset);
    if (!dryRun) {
      report.error = `${why} Nothing was wiped.`;
      return report;
    }
    report.warnings.push(`A real run would be refused: ${why}`);
  }

  // What earlier resets left on no clone, each by its own record: everything
  // one recorded when it died, or what its completion says it could not
  // restore. This reset takes all of it on.
  const current: ResetSnapshot = { installs: installsRead.installs, pins: pinsRead.pins };
  const owed = stateRead.state.owed;
  const snapshot = withOwed(current, owed);
  const { installs, pins } = snapshot;
  for (const debt of owed) {
    report.warnings.push(
      (debt.because === "died"
        ? `The reset of ${debt.from} never finished.`
        : `The reset of ${debt.from} could not restore everything it recorded.`) +
        ` The ${installCount(debt.snapshot)} install(s) and ${debt.snapshot.pins.length} pin(s) ` +
        `it left are restored with this one's.`,
    );
  }

  const existingModules = modulesRes.data ?? [];
  report.before = {
    modules: existingModules.length,
    libraryEntries: (libraryRes.data ?? []).length,
    cloneInstalls: installCount(snapshot),
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

  // ── 2. Record, look again, then wipe ──
  // The snapshot is written before anything is deleted. The wipe takes
  // `clone_modules` with the modules, so an invocation that died after it
  // would otherwise take the only record of what to restore with it.
  const { data: recorded, error: recordErr } = await supabase
    .from("audit_log")
    .insert({
      action: RESET_AUDIT_ACTION,
      entity_type: "module_library",
      actor_user_id: userId,
      metadata: {
        modules_removed: report.before.modules,
        library_entries_removed: report.before.libraryEntries,
        clone_installs_snapshotted: report.before.cloneInstalls,
        pins_snapshotted: report.before.libraryPins,
        ...(owed.length > 0 ? { restores_owed_by: owed.map((debt) => debt.resetId) } : {}),
        snapshot: snapshotForAudit(snapshot),
      },
    })
    .select("id")
    .single();
  if (recordErr || !recorded) {
    report.error =
      `The snapshot of what to restore could not be recorded ` +
      `(${recordErr ? describeDbError(recordErr) : "no row came back"}), so nothing was wiped.`;
    return report;
  }
  const resetId = recorded.id as string;

  // Every way out from here closes this reset's record, saying what it could
  // not restore, so the next reset restores that at once instead of waiting
  // out the window as it would for one that died.
  const complete = async (
    unrestored: ResetSnapshot,
    outcome: { stoppedBecause?: string; beforeWipe?: boolean; extra?: Record<string, Json> } = {},
  ) => {
    const { error } = await supabase.from("audit_log").insert({
      action: RESET_COMPLETE_AUDIT_ACTION,
      entity_type: "module_library",
      entity_id: report.runId ?? null,
      actor_user_id: userId,
      metadata: completionMetadata(resetId, { unrestored, ...outcome }),
    });
    if (error) {
      report.warnings.push(
        `This reset's completion could not be recorded (${describeDbError(error)}). The next ` +
          `reset waits out the window and then restores everything this one recorded.`,
      );
    }
  };

  // Of two resets, or a reset and a detection, that start together, the one
  // that looks second sees the first here and stops before anything is
  // deleted. It wiped nothing, so it owes nothing, and it hands back what it
  // took on: an earlier reset's debt stays with that reset's own record, for
  // the reset that goes on. The other reset may well have taken it on too.
  const competitor = await catalogueCompetitor(supabase, { resetId });
  if (competitor) {
    await complete(EMPTY_SNAPSHOT, { stoppedBecause: competitor, beforeWipe: true });
    report.error = `${competitor} This reset stopped before wiping anything.`;
    return report;
  }

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
    await complete(snapshot, { stoppedBecause: report.error });
    return report;
  }

  // ── 3. Re-detect ──
  const config: DetectionRunConfig = { ...DEFAULT_CONFIG, ...options.config, deltaMode: false };
  const detection = await runDetection({ supabase, userId, config });
  report.runId = detection.runId;

  if (!detection.ok) {
    report.error = `Detection failed after wipe: ${detection.error ?? "unknown"}`;
    await complete(snapshot, { stoppedBecause: report.error });
    report.warnings.push(
      "The catalogue is now empty. The clone installs are recorded as owed, and the next reset " +
        "restores them with its own: fix the detection error and reset again.",
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
    await complete(snapshot, { stoppedBecause: report.error });
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
  let installsUnrestored = false;
  let pinsUnrestored = false;

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
      if (error) {
        installsUnrestored = true;
        report.warnings.push(`Restoring clone installs failed: ${error.message}`);
      }
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
      if (error) {
        pinsUnrestored = true;
        report.warnings.push(`Restoring library pins failed: ${error.message}`);
      } else report.restored.pins = pinRows.length;
    }
    if (report.restored.unmappedPins.length > 0) {
      report.warnings.push(
        `${report.restored.unmappedPins.length} pin(s) referenced slugs that no longer exist and were dropped. ` +
          `Those clones now track the live module instead of a pinned version.`,
      );
    }
  }

  // What could not be written back is owed to the next reset, whole: an
  // upsert is idempotent, and which rows of a failed chunk landed is not known.
  // A slug the new catalogue no longer has is not owed: there is nothing to
  // restore it to.
  const unrestored: ResetSnapshot = {
    installs: installsUnrestored ? installs : [],
    pins: pinsUnrestored ? pins : [],
  };
  await complete(unrestored, {
    stoppedBecause: installsUnrestored || pinsUnrestored ? "a restore write failed" : undefined,
    extra: JSON.parse(
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
  if (installsUnrestored || pinsUnrestored) {
    report.error =
      "Some installs or pins could not be written back. They are recorded as owed, and the " +
      "next reset restores them.";
    return report;
  }

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
