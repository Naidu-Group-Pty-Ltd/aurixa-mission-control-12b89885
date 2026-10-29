/**
 * The module library follows the prime: the reads and writes
 * (docs/DELIVERY_SYSTEM_PLAN.md, D19, the owner's decision of 29 Oct 2026).
 *
 * `/hooks/module-library-follow` calls `followPrimeHead` every fifteen minutes.
 * It reads the prime's head, and while the catalogue is settled at it, that is
 * all it does. When the head has moved it detects the catalogue at the head,
 * in follow mode, and settles it there; what settling is, and when it stops
 * for a person instead, is decided in `libraryFollow.pure.ts`.
 *
 * Everything runs as the service role, with no actor: nobody starts a follow,
 * and the owner approved its entries by policy. So nothing here asks anyone's
 * role, and it is called only from the cron-secret hook.
 *
 * Asserted by effect. A write the settle depends on is read back by what it
 * returned, and a settle that could not complete closes its run `failed`, so
 * the next follow detects again rather than reading the commit as settled.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import { DEFAULT_CONFIG, RUNNING_RUN_WINDOW_MS, runDetection } from "./module-detection.server";
import { catalogueCompetitor } from "./library-reingest.server";
import { MODULE_COLUMNS, writeLibraryEntries } from "./libraryApproval.server";
import {
  describeDbError,
  libraryApprovalNotice,
  libraryEntryInsert,
  type DetectionRunCommit,
  type PublishableModule,
} from "./libraryApproval.pure";
import {
  FOLLOW_ATTEMPTS,
  FOLLOW_AUDIT_ACTION,
  FOLLOW_HELD,
  emptyFollowReport,
  entryChange,
  followAuditMetadata,
  holdBeforeWriting,
  isFollowRun,
  nextFollowStep,
  planSettle,
  stoppedNotice,
  type EntryChange,
  type FollowModule,
  type FollowReport,
  type FollowRun,
  type LatestEntry,
} from "./libraryFollow.pure";

type Db = SupabaseClient<Database>;

/** Rows per page of a paged read: PostgREST answers at most 1,000 rows a request. */
const PAGE = 1000;

/** Ids per `in` filter: 100 uuids is about 3.7 KB of query string. */
const ID_CHUNK = 100;

/** How many recent detection runs the follow reads to find its own. */
const RUNS_READ = 50;

export type FollowDeps = {
  /** The prime's head commit, or why it could not be read. */
  readHead: (supabase: Db) => Promise<{ ok: true; sha: string } | { ok: false; error: string }>;
  /** Who else is working on the catalogue (`catalogueCompetitor`). */
  competitor: (supabase: Db, own: { runId?: string }) => Promise<string | null>;
  detect: typeof runDetection;
  now: () => number;
};

/** The prime's default branch's head, as the follow's detection run will read it. */
async function readPrimeHead(
  supabase: Db,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const { data: prime, error } = await supabase
    .from("prime_config")
    .select("github_owner, github_repo, default_branch")
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, error: `prime_config unreadable: ${describeDbError(error)}` };
  if (!prime) return { ok: false, error: "the prime repository is not configured" };
  try {
    const { data: branch } = await getAppOctokit().repos.getBranch({
      owner: prime.github_owner,
      repo: prime.github_repo,
      branch: prime.default_branch,
    });
    return { ok: true, sha: branch.commit.sha };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const FOLLOW_DEPS: FollowDeps = {
  readHead: readPrimeHead,
  competitor: catalogueCompetitor,
  detect: runDetection,
  now: () => Date.now(),
};

function chunked<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Every row a paged read returns, or the read's error: a failed read is never an empty table. */
async function readPaged<T>(
  read: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
): Promise<{ ok: true; rows: T[] } | { ok: false; error: string }> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await read(from, from + PAGE - 1);
    if (error) return { ok: false, error: describeDbError(error) };
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < PAGE) return { ok: true, rows };
  }
}

/**
 * The audit row a follow that did something, or could not, records. `ownRun`
 * is the run this tick wrote, whose earlier runs' diagnostics it prunes first.
 */
async function record(supabase: Db, report: FollowReport, ownRun?: string | null): Promise<void> {
  if (ownRun) await pruneDiagnostics(supabase, report, ownRun);
  const { error } = await supabase.from("audit_log").insert({
    action: FOLLOW_AUDIT_ACTION,
    entity_type: "module_detection_run",
    entity_id: report.runId,
    actor_user_id: null,
    metadata: followAuditMetadata(report),
  });
  if (error) {
    console.error(`[library-follow] the follow's audit row did not land: ${error.message}`);
    report.warnings.push(`The audit row did not land: ${error.message}`);
  }
}

/** The operators' notice that the follow stopped for a person; a notice that did not land is a warning. */
async function tellOperators(supabase: Db, report: FollowReport): Promise<void> {
  const { error } = await supabase.from("notifications").insert(stoppedNotice(report));
  if (error) report.warnings.push(`The operators' notice did not land: ${error.message}`);
}

/**
 * Record a follow that failed, and tell the operators where it was the last
 * of its tries at the head: the next tick waits for the prime to move.
 */
async function recordFailure(
  supabase: Db,
  report: FollowReport,
  ownRun?: string | null,
): Promise<void> {
  report.outcome = "failed";
  if (
    report.attempt === FOLLOW_ATTEMPTS &&
    report.commitSha !== null &&
    report.commitSha === report.headSha
  ) {
    await tellOperators(supabase, report);
  }
  await record(supabase, report, ownRun);
}

/** Every module's slug and status, paged, for the hold asked before the run writes one. */
async function readCatalogue(
  supabase: Db,
): Promise<{ ok: true; rows: FollowModule[] } | { ok: false; error: string }> {
  return readPaged<FollowModule>((from, to) =>
    supabase
      .from("modules")
      .select("id, slug, name, status, detection_run_id, archived_by_follow_run_id")
      .order("id", { ascending: true })
      .range(from, to),
  );
}

/** The tables a detection run writes for diagnosis, which name the run. */
const DIAGNOSTIC_TABLES = [
  "module_backend_artifacts",
  "module_import_edges",
  "module_drift_alerts",
] as const;

/**
 * Delete the diagnostics of every finished detection run that started before
 * `ownRun`, but those of the run the catalogue is settled at (the newest
 * completed one). A run leaves about 13,700 rows (July's three each left
 * 2,000 import edges, 11,598 backend artifacts and 100 drift alerts, measured
 * 29 Oct 2026), the Modules page reads a module's artifacts across every run,
 * and the drift metrics count alerts across them, so a follow per prime merge
 * would multiply both. A run's own row is kept, and so is a running run's
 * every row. A delete that fails is a warning: the next follow prunes again.
 */
async function pruneDiagnostics(supabase: Db, report: FollowReport, ownRun: string): Promise<void> {
  const [own, settled] = await Promise.all([
    supabase.from("module_detection_runs").select("started_at").eq("id", ownRun).maybeSingle(),
    supabase
      .from("module_detection_runs")
      .select("id")
      .eq("status", "completed")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (own.error || !own.data?.started_at || settled.error) {
    const why = own.error ?? settled.error;
    report.warnings.push(
      `Earlier runs' diagnostics were not pruned: ${why ? describeDbError(why) : "this run's start was not found"}`,
    );
    return;
  }
  const startedAt = own.data.started_at;
  const keep = settled.data?.id ?? null;
  const earlier = await readPaged<{ id: string }>((from, to) =>
    supabase
      .from("module_detection_runs")
      .select("id")
      .lt("started_at", startedAt)
      .neq("status", "running")
      .order("started_at", { ascending: true })
      .range(from, to),
  );
  if (!earlier.ok) {
    report.warnings.push(`Earlier runs' diagnostics were not pruned: ${earlier.error}`);
    return;
  }
  const ids = earlier.rows.map((r) => r.id).filter((id) => id !== keep && id !== ownRun);
  for (const chunk of chunked(ids, ID_CHUNK)) {
    for (const table of DIAGNOSTIC_TABLES) {
      const { error } = await supabase.from(table).delete().in("detection_run_id", chunk);
      if (error) {
        report.warnings.push(
          `Earlier runs' ${table} were not all pruned: ${describeDbError(error)}`,
        );
        return;
      }
    }
    report.pruned.push(...chunk);
  }
}

/** Close the follow's run, from `running` only: a run something else closed stays as it was closed. */
async function closeRun(
  supabase: Db,
  runId: string,
  status: "completed" | "failed" | typeof FOLLOW_HELD,
  now: string,
  why: string | null,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("module_detection_runs")
    .update({ status, completed_at: now, ...(why ? { error_message: why } : {}) })
    .eq("id", runId)
    .eq("status", "running")
    .select("id");
  if (error)
    return `run ${runId.slice(0, 8)} could not be closed ${status}: ${describeDbError(error)}`;
  if ((data ?? []).length === 0)
    return `run ${runId.slice(0, 8)} was no longer running, so it was not closed ${status}`;
  return null;
}

/**
 * Follow the prime's head: nothing while the catalogue is settled at it, and
 * otherwise detect at the head and settle the catalogue there.
 */
export async function followPrimeHead(
  supabase: Db,
  deps: FollowDeps = FOLLOW_DEPS,
): Promise<FollowReport> {
  const report = emptyFollowReport();

  const head = await deps.readHead(supabase);
  if (!head.ok) {
    report.stoppedBecause = `The prime's head could not be read: ${head.error}`;
    await record(supabase, report);
    return report;
  }
  report.headSha = head.sha;

  const runsRead = await supabase
    .from("module_detection_runs")
    .select("id, status, commit_sha, parameters, started_at")
    .order("started_at", { ascending: false })
    .limit(RUNS_READ);
  if (runsRead.error) {
    report.stoppedBecause = `The detection runs could not be read: ${describeDbError(runsRead.error)}`;
    await record(supabase, report);
    return report;
  }
  const runs = (runsRead.data ?? []) as FollowRun[];
  const step = nextFollowStep({
    headSha: head.sha,
    runs,
    now: deps.now(),
    windowMs: RUNNING_RUN_WINDOW_MS,
  });
  if (step.kind === "up_to_date" || step.kind === "held") {
    // Recorded when it settled or held; a tick that changes nothing records nothing.
    report.outcome = step.kind;
    report.runId = step.run.id;
    report.commitSha = step.run.commit_sha;
    return report;
  }

  const now = new Date(deps.now()).toISOString();
  for (const stale of step.stale) {
    const why = await closeRun(
      supabase,
      stale.id,
      "failed",
      now,
      "The follow's invocation ended before it settled the catalogue at this run",
    );
    if (why) report.warnings.push(why);
    else report.closedStale.push(stale.id);
  }

  if (step.kind === "exhausted") {
    report.outcome = "exhausted";
    report.commitSha = head.sha;
    report.attempt = step.failed.length;
    report.runId = step.failed[0]?.id ?? null;
    report.stoppedBecause = `the follow failed ${step.failed.length} times at this commit`;
    // The try that died is closed now, by this tick: it was the last, so the
    // operators are told here. A tick after that records nothing.
    if (step.failed.some((r) => report.closedStale.includes(r.id))) {
      await tellOperators(supabase, report);
      await record(supabase, report);
    }
    return report;
  }
  report.attempt = step.attempt;

  // A reset or a detection a person started is not a failure of the follow,
  // which tries again at the next tick. Asked before the run's row is
  // written, so a tick that waits leaves no run behind; asked again by the
  // run once its row exists, for the one that started in between.
  const busy = await deps.competitor(supabase, {});
  if (busy) {
    report.outcome = "skipped";
    report.stoppedBecause = busy;
    return report;
  }
  const guarded: { competitor: string | null } = { competitor: null };
  const detection = await deps.detect({
    supabase,
    userId: null,
    config: { ...DEFAULT_CONFIG, deltaMode: false, follow: true },
    guard: async (runId) => (guarded.competitor = await deps.competitor(supabase, { runId })),
    beforeWriting: async (detectedSlugs) => {
      const catalogue = await readCatalogue(supabase);
      // Unread, the catalogue cannot say what the run would archive: the run
      // stops, and fails rather than holds, so it is tried again.
      if (!catalogue.ok) throw new Error(`The catalogue could not be read: ${catalogue.error}`);
      return holdBeforeWriting({ modules: catalogue.rows, detectedSlugs });
    },
  });
  report.runId = detection.runId || null;
  report.commitSha = detection.commitSha ?? null;
  if (detection.stoppedBeforeWriting) {
    report.outcome = "held";
    report.stoppedBecause = detection.stoppedBeforeWriting;
    const closing = await closeRun(
      supabase,
      detection.runId,
      FOLLOW_HELD,
      now,
      report.stoppedBecause,
    );
    if (closing) report.warnings.push(closing);
    await tellOperators(supabase, report);
    await record(supabase, report, detection.runId);
    return report;
  }
  if (!detection.ok) {
    report.stoppedBecause = detection.error ?? "the detection run failed without saying why";
    if (guarded.competitor) {
      report.outcome = "skipped";
      return report;
    }
    await recordFailure(supabase, report, detection.runId || null);
    return report;
  }
  if (!detection.commitSha) {
    report.stoppedBecause = "The detection run completed without saying which commit it read";
    const why = await closeRun(supabase, detection.runId, "failed", now, report.stoppedBecause);
    if (why) report.warnings.push(why);
    await recordFailure(supabase, report, detection.runId);
    return report;
  }

  await settle(supabase, deps, report, {
    runId: detection.runId,
    commitSha: detection.commitSha,
    detectedSlugs: detection.detectedSlugs ?? [],
  });
  return report;
}

/** Settle the catalogue at the follow's run. */
async function settle(
  supabase: Db,
  deps: FollowDeps,
  report: FollowReport,
  at: { runId: string; commitSha: string; detectedSlugs: string[] },
): Promise<void> {
  const { runId, commitSha } = at;
  const now = new Date(deps.now()).toISOString();
  const fail = async (why: string) => {
    report.stoppedBecause = why;
    const closing = await closeRun(supabase, runId, "failed", now, why);
    if (closing) report.warnings.push(closing);
    await recordFailure(supabase, report, runId);
  };

  // ── The catalogue, as the run left it ──
  const modulesRead = await readCatalogue(supabase);
  if (!modulesRead.ok) return fail(`The catalogue could not be read: ${modulesRead.error}`);
  const plan = planSettle({ runId, modules: modulesRead.rows, detectedSlugs: at.detectedSlugs });
  report.keptOut = plan.keptOut;

  if (plan.held) {
    // Asked before the run wrote a module, and asked again here: what
    // changed between the two was another writer's, and the run's modules
    // are written already, which the notice says.
    report.outcome = "held";
    report.stoppedBecause = `${plan.held} (found once the run had written its modules)`;
    const closing = await closeRun(supabase, runId, FOLLOW_HELD, now, report.stoppedBecause);
    if (closing) report.warnings.push(closing);
    await tellOperators(supabase, report);
    await record(supabase, report, runId);
    return;
  }

  // ── Approve what the run proposed, and bring back what it found again ──
  // Compare-and-set on the run and on the state the plan read: a module
  // another writer reshaped, approved or archived since is not approved
  // under this run's name. A person's archive is never undone here.
  const passes = [
    { modules: plan.approve, from: "proposed", followArchived: false },
    { modules: plan.revive, from: "archived", followArchived: true },
  ] as const;
  for (const pass of passes) {
    for (const ids of chunked(
      pass.modules.map((m) => m.id),
      ID_CHUNK,
    )) {
      let query = supabase
        .from("modules")
        .update({
          status: "approved",
          approved_by: null,
          approved_at: now,
          rejection_reason: null,
          archived_by_follow_run_id: null,
        })
        .in("id", ids)
        .eq("detection_run_id", runId)
        .eq("status", pass.from);
      if (pass.followArchived) query = query.not("archived_by_follow_run_id", "is", null);
      const { data, error } = await query.select("id");
      if (error) {
        return fail(`The modules the run found could not be approved: ${describeDbError(error)}`);
      }
      const landed = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id));
      const missed = ids.filter((id) => !landed.has(id));
      if (missed.length > 0) {
        return fail(
          `${missed.length} module(s) the run found were not approved, because they changed while ` +
            `the follow settled: ${pass.modules
              .filter((m) => missed.includes(m.id))
              .map((m) => m.slug)
              .join(", ")}`,
        );
      }
    }
  }
  report.approved = plan.approve.map((m) => m.slug).sort();
  report.revived = plan.revive.map((m) => m.slug).sort();

  // ── Archive what the run no longer found, as the follow's ──
  const archivedIds = new Set<string>();
  for (const ids of chunked(
    plan.archive.map((m) => m.id),
    ID_CHUNK,
  )) {
    const { data, error } = await supabase
      .from("modules")
      .update({ status: "archived", archived_by_follow_run_id: runId })
      .in("id", ids)
      .in("status", ["approved", "proposed"])
      .select("id");
    if (error)
      return fail(
        `The modules the run did not find could not be archived: ${describeDbError(error)}`,
      );
    for (const r of (data ?? []) as Array<{ id: string }>) archivedIds.add(r.id);
  }
  report.archived = plan.archive
    .filter((m) => archivedIds.has(m.id))
    .map((m) => m.slug)
    .sort();
  const notArchived = plan.archive.filter((m) => !archivedIds.has(m.id));
  if (notArchived.length > 0) {
    // A person changed them while the follow settled, and their change stands.
    report.warnings.push(
      `${notArchived.length} module(s) changed while the follow settled and were left as they ` +
        `are: ${notArchived.map((m) => m.slug).join(", ")}`,
    );
  }

  // ── Publish each module whose entry changed ──
  const published = await publish(supabase, report, {
    runId,
    commitSha,
    now,
    modules: plan.publish,
  });
  if (!published.ok) return fail(published.error);

  const closing = await closeRun(supabase, runId, "completed", now, null);
  if (closing) {
    // Settled, and not recorded as settled: the next follow detects again,
    // which finds the catalogue as this one left it and changes nothing.
    report.warnings.push(closing);
  }
  report.outcome = "settled";
  await record(supabase, report, runId);
}

const LATEST_COLUMNS =
  "slug, version, approval_status, source_commit_sha, name, description, route_path, entry_file, file_paths, metadata";

/** Publish an entry for each module whose entry would differ from its latest. */
async function publish(
  supabase: Db,
  report: FollowReport,
  at: { runId: string; commitSha: string; now: string; modules: readonly FollowModule[] },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (at.modules.length === 0) return { ok: true };

  const modules: PublishableModule[] = [];
  for (const ids of chunked(
    at.modules.map((m) => m.id),
    ID_CHUNK,
  )) {
    const { data, error } = await supabase.from("modules").select(MODULE_COLUMNS).in("id", ids);
    if (error)
      return {
        ok: false,
        error: `The modules to publish could not be read: ${describeDbError(error)}`,
      };
    modules.push(...((data ?? []) as PublishableModule[]));
  }

  const { data: run, error: runError } = await supabase
    .from("module_detection_runs")
    .select("id, commit_sha, created_at")
    .eq("id", at.runId)
    .maybeSingle();
  if (runError)
    return { ok: false, error: `The follow's run could not be read: ${describeDbError(runError)}` };
  const runs = new Map<string, DetectionRunCommit>(run ? [[run.id, run]] : []);

  const latest = new Map<string, LatestEntry>();
  for (const slugs of chunked([...new Set(modules.map((m) => m.slug))], ID_CHUNK)) {
    const { data, error } = await supabase
      .from("module_library")
      .select(LATEST_COLUMNS)
      .eq("is_latest", true)
      .in("slug", slugs);
    if (error) {
      return {
        ok: false,
        error: `The library's latest entries could not be read: ${describeDbError(error)}`,
      };
    }
    for (const entry of (data ?? []) as LatestEntry[]) {
      const known = latest.get(entry.slug);
      if (!known || entry.version > known.version) latest.set(entry.slug, entry);
    }
  }

  const tagsFor = (m: PublishableModule) => [m.layer].filter(Boolean);
  const change = new Map<string, EntryChange>();
  const changed: PublishableModule[] = [];
  for (const m of modules) {
    const candidate = libraryEntryInsert(m, {
      version: 0,
      runId: at.runId,
      commitSha: at.commitSha,
      publisherId: null,
      now: at.now,
      tags: tagsFor(m),
    });
    const verdict = entryChange(latest.get(m.slug), candidate);
    if (verdict === "unchanged") {
      report.unchanged++;
      continue;
    }
    change.set(m.slug, verdict);
    changed.push(m);
  }

  const written = await writeLibraryEntries(supabase, changed, runs, {
    publisherId: null,
    now: at.now,
    tagsFor,
  });
  report.published = written.entries
    .map((e) => ({ slug: e.slug, version: e.version, change: change.get(e.slug) ?? "changed" }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  report.refused = written.refused.map((r) => ({ slug: r.slug ?? r.moduleId, reason: r.reason }));
  report.warnings.push(...written.warnings);

  const notice = libraryApprovalNotice(written.entries);
  if (notice) {
    const { error: noticeError } = await supabase.from("notifications").insert(notice);
    if (noticeError)
      report.warnings.push(`The approval notice did not land: ${noticeError.message}`);
  }
  return { ok: true };
}

/**
 * The follow run the catalogue is settled at, for a reader that wants to say
 * which commit the catalogue it read was at (provisioning). Null where no
 * follow has settled it yet, or the runs could not be read: the caller says
 * that it does not know, never that the catalogue is current.
 */
export async function catalogueSettledAt(
  supabase: Db,
): Promise<{ runId: string; commitSha: string | null } | null> {
  const { data, error } = await supabase
    .from("module_detection_runs")
    .select("id, status, commit_sha, parameters, started_at")
    .eq("status", "completed")
    .order("started_at", { ascending: false })
    .limit(RUNS_READ);
  if (error) return null;
  const run = ((data ?? []) as FollowRun[]).find(isFollowRun);
  return run ? { runId: run.id, commitSha: run.commit_sha } : null;
}
