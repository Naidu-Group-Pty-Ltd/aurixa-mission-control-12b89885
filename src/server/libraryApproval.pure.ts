/**
 * Approving a library entry: what an admin may publish, what the entry then
 * records, and what a pin on it may rely on.
 *
 * ## The rule (docs/DELIVERY_SYSTEM_PLAN.md, D19)
 *
 * The owner decided on 27 Oct 2026 that library pins stay, for clones that stay
 * module-scoped, that the module catalogue is detected again, and that each
 * entry is approved when it is published, recording the prime commit it was
 * approved at. Measured on 28 Oct, before this: 134 entries, every one
 * `pending`, none recording a commit; no pin, because a pin needs an approved
 * entry; and the last detection run (31 Jul) recorded a hash of its file list,
 * not the commit it read.
 *
 * So publishing IS approving. An admin publishes; the entry is written
 * `approved`, with its approver and the commit in the same insert. The commit
 * is the one the detection run that shaped the module read — the commit its
 * files were detected at, not the prime's head at the moment of publishing,
 * which may hold files nobody reviewed.
 *
 * ## No entry is approved without a commit
 *
 * Every run before commit recording began recorded none, so a module those
 * runs shaped is refused, by name. Approving an existing entry that records no
 * commit is refused too, which is what keeps the 134 pending entries pending
 * until a publication supersedes them. A pin on an approved entry without one
 * is refused at the pass's pin pre-flight, as a pin on an unapproved one is.
 *
 * ## One run holds everything an entry publishes
 *
 * An entry carries the module's frontend files and its backend globs, and
 * records one commit. Detection refreshes an approved or archived module's
 * backend fields on every run but keeps the run that found its files, so a
 * module detected at commit A and detected again at B holds A's files beside
 * B's functions and migrations, and its run still says A. Published, it would
 * say it was approved at A while carrying what A never held (Codex, #388).
 * Each backend manifest names the run that found it, and a module whose
 * backend another run found, or whose manifest names no run, is refused, by
 * name.
 *
 * ## A failed read is never "no commit"
 *
 * The verdicts here are reached only from rows that were read. A read that
 * failed is the caller's to report as the failure it is
 * (`libraryApproval.server.ts`, `library-validation.server.ts`); it never
 * arrives here as an empty map that reads "not found" or "no commit".
 */
import type { Database, Json } from "@/integrations/supabase/types";
import { isCommitSha, primeCommitLabel } from "@/lib/libraryCommit.pure";

type ModuleRow = Database["public"]["Tables"]["modules"]["Row"];
type LibraryInsert = Database["public"]["Tables"]["module_library"]["Insert"];
type NotificationInsert = Database["public"]["Tables"]["notifications"]["Insert"];

/** The migration that adds the two commit columns, named wherever their absence is the error. */
export const COMMIT_COLUMNS_MIGRATION = "20261028120000_library_entries_record_their_commit";

/**
 * A database error, with the migration named when the error is a commit column
 * that is not there yet.
 *
 * The code reaches production through Lovable and the migration through
 * `apply-migrations.yml`, separately. A read of a column that has not arrived
 * answers 42703 from Postgres, and a write PGRST204 from PostgREST's schema
 * cache. Either is a refusal with a reason a person can act on, never "no
 * commit".
 */
export function describeDbError(error: { message: string; code?: string }): string {
  const missing =
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /column .* does not exist|could not find the .* column/i.test(error.message);
  const commitColumn = /commit_sha/.test(error.message);
  return missing && commitColumn
    ? `${error.message} (migration ${COMMIT_COLUMNS_MIGRATION} has not been applied)`
    : error.message;
}

// ─── Publishing ─────────────────────────────────────────────────────────────

/** What a publication reads of a module: the entry's contents and the run that detected it. */
export type PublishableModule = Pick<
  ModuleRow,
  | "id"
  | "name"
  | "slug"
  | "status"
  | "description"
  | "routes"
  | "route_entry_file"
  | "resolved_files"
  | "file_globs"
  | "backend_file_globs"
  | "backend_manifest"
  | "detection_run_id"
  | "layer"
  | "cohesion_score"
  | "coupling_score"
  | "ai_confidence"
  | "ai_reasoning"
  | "shared_by_modules"
  | "edge_functions"
  | "database_tables"
  | "required_secrets"
  | "required_migrations"
  | "storage_buckets"
  | "cron_jobs"
>;

/** What a publication reads of the run that detected a module. */
export type DetectionRunCommit = { id: string; commit_sha: string | null; created_at: string };

export type PublicationVerdict =
  | { ok: true; runId: string; commitSha: string }
  | { ok: false; reason: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `31 Jul 2026`, in UTC, or null for a timestamp that is not one. */
function day(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Detection rewrites a module's files only while it is `proposed` or
 * `rejected` (`module-detection.server.ts`, "Persist modules"): an approved
 * or archived module keeps its curated files and has only its backend surface
 * refreshed, and keeps the run that first shaped it. So running detection
 * again does not give such a module a run that recorded a commit, and a
 * refusal that only said "run detection again" would send an admin round in a
 * circle.
 */
const KEEPS_ITS_FILES =
  ". Detection keeps an approved or archived module's files as they are, so it re-detects " +
  "this one only while it is proposed or rejected";

/**
 * The run a module's backend manifest says found its backend, or null where
 * it names none: every manifest written before runs were recorded in it.
 */
export function backendRunOf(manifest: Json | null | undefined): string | null {
  if (manifest === null || manifest === undefined) return null;
  if (typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const run = manifest.detection_run_id;
  return typeof run === "string" && run !== "" ? run : null;
}

/**
 * Whether `module` may be published, and at which commit.
 *
 * `runs` holds the detection runs that were READ, keyed by id. A run the
 * module names that is not among them was not found by a read that worked —
 * the caller does not reach this with a failed read.
 */
export function judgePublication(
  module: Pick<
    PublishableModule,
    "name" | "slug" | "status" | "detection_run_id" | "backend_manifest"
  >,
  runs: ReadonlyMap<string, DetectionRunCommit>,
): PublicationVerdict {
  const who = `${module.name} (${module.slug})`;
  const keeps = module.status === "approved" || module.status === "archived";
  const runId = module.detection_run_id;
  if (!runId) {
    return {
      ok: false,
      reason: `${who} names no detection run, so nothing records the commit its files were detected at`,
    };
  }
  const run = runs.get(runId);
  if (!run) {
    return { ok: false, reason: `${who}: its detection run ${runId.slice(0, 8)} was not found` };
  }
  if (run.commit_sha === null || run.commit_sha === "") {
    const when = day(run.created_at);
    return {
      ok: false,
      reason:
        `${who}: its files were detected by run ${runId.slice(0, 8)}` +
        `${when ? ` on ${when}` : ""}, which recorded no commit` +
        (keeps ? KEEPS_ITS_FILES : ""),
    };
  }
  if (!isCommitSha(run.commit_sha)) {
    return {
      ok: false,
      reason: `${who}: its detection run ${runId.slice(0, 8)} recorded "${run.commit_sha}", which is not a commit`,
    };
  }
  const backendRun = backendRunOf(module.backend_manifest);
  if (backendRun === null) {
    return {
      ok: false,
      reason:
        `${who}: its backend manifest names no detection run, so nothing says its functions ` +
        `and migrations were found at the commit its files were` +
        (keeps ? KEEPS_ITS_FILES : ""),
    };
  }
  if (backendRun !== runId) {
    return {
      ok: false,
      reason:
        `${who}: its files were detected by run ${runId.slice(0, 8)} and its backend by run ` +
        `${backendRun.slice(0, 8)}, so no one commit holds what it would publish` +
        (keeps ? KEEPS_ITS_FILES : ""),
    };
  }
  return { ok: true, runId, commitSha: run.commit_sha };
}

/**
 * The library entry a publication writes: approved, by its publisher, at the
 * commit its module was detected at, all in the one insert.
 *
 * A clone that pins an entry has that module's globs REPLACED by its
 * `file_paths` at cascade time (`cascade/installedGlobs.server.ts`), so the
 * backend globs travel with the frontend files: an entry of frontend paths
 * alone would strip the module's edge functions and migrations from every
 * clone that pins it.
 */
export function libraryEntryInsert(
  module: PublishableModule,
  at: {
    version: number;
    runId: string;
    commitSha: string;
    publisherId: string;
    /** One instant for the whole publication: it is published and approved at once. */
    now: string;
    tags: string[];
  },
): LibraryInsert {
  const resolved = module.resolved_files ?? [];
  const frontendPaths = resolved.length > 0 ? resolved : (module.file_globs ?? []);
  const filePaths = [...new Set([...frontendPaths, ...(module.backend_file_globs ?? [])])];
  return {
    name: module.name,
    slug: module.slug,
    description: module.description,
    route_path: module.routes?.[0] ?? null,
    entry_file: module.route_entry_file ?? module.slug,
    file_paths: filePaths,
    file_count: filePaths.length,
    version: at.version,
    source_detection_run_id: at.runId,
    source_module_id: module.id,
    source_commit_sha: at.commitSha,
    published_by: at.publisherId,
    published_at: at.now,
    approval_status: "approved",
    approved_by: at.publisherId,
    approved_at: at.now,
    rejection_reason: null,
    is_latest: true,
    tags: at.tags,
    metadata: {
      cohesion_score: module.cohesion_score,
      coupling_score: module.coupling_score,
      ai_confidence: module.ai_confidence,
      ai_reasoning: module.ai_reasoning,
      shared_by_modules: module.shared_by_modules,
      // A pinned install needs the same backend contract as a live one.
      layer: module.layer,
      edge_functions: module.edge_functions ?? [],
      database_tables: module.database_tables ?? [],
      required_secrets: module.required_secrets ?? [],
      required_migrations: module.required_migrations ?? [],
      storage_buckets: module.storage_buckets ?? [],
      cron_jobs: module.cron_jobs ?? [],
    } satisfies Json,
  };
}

// ─── Approving after publication ────────────────────────────────────────────

/** What is wrong with an entry's recorded commit, or null when it records one. */
function commitProblem(sha: string | null | undefined): string | null {
  if (sha === null || sha === undefined || sha === "") return "records no commit";
  if (!isCommitSha(sha)) return `records "${sha}", which is not a commit`;
  return null;
}

/**
 * Whether an existing entry may be set `approved`.
 *
 * An entry is approved when it is published, at the commit it records. One
 * that records none — every entry published before commit recording began —
 * stays where it is until a publication supersedes it.
 */
export function judgeApproval(entry: {
  name: string;
  version: number;
  source_commit_sha: string | null;
}): { ok: true } | { ok: false; reason: string } {
  const problem = commitProblem(entry.source_commit_sha);
  if (problem === null) return { ok: true };
  return {
    ok: false,
    reason:
      `${entry.name} v${entry.version} ${problem}, so it cannot be approved. Publishing approves ` +
      `an entry at the commit its module was detected at: detect the catalogue again and ` +
      `publish the module.`,
  };
}

/** An entry an approval decision was written to, as the notice names it. */
export type DecidedEntry = {
  id: string;
  name: string;
  slug: string;
  version: number;
  source_commit_sha: string | null;
};

/**
 * The bell's notice that entries were approved, from a publication or a
 * single decision alike: one notice per act, however many entries it approved,
 * so a catalogue published in one go is one line in the bell, not 135.
 */
export function libraryApprovalNotice(entries: DecidedEntry[]): NotificationInsert | null {
  if (entries.length === 0) return null;
  const commits = [
    ...new Set(
      entries.map((e) => primeCommitLabel(e.source_commit_sha)).filter((c): c is string => !!c),
    ),
  ];
  const at =
    commits.length === 1
      ? ` at ${commits[0]}`
      : commits.length > 1
        ? ` at ${commits.length} commits`
        : "";
  if (entries.length === 1) {
    const [e] = entries;
    return {
      kind: "library_entry_approved",
      severity: "success",
      title: `Library approved · ${e.name} v${e.version}`,
      body: `Approved${at}. Now available for pinning to clones.`,
      url: "/modules",
      metadata: {
        library_entry_id: e.id,
        slug: e.slug,
        version: e.version,
        source_commit_sha: e.source_commit_sha,
      },
    };
  }
  const named = entries.slice(0, 5).map((e) => `${e.name} v${e.version}`);
  const more = entries.length > 5 ? ` and ${entries.length - 5} more` : "";
  return {
    kind: "library_entry_approved",
    severity: "success",
    title: `Library approved · ${entries.length} entries`,
    body: `${named.join(", ")}${more}, approved${at}. Now available for pinning to clones.`,
    url: "/modules",
    metadata: {
      library_entry_ids: entries.map((e) => e.id),
      slugs: entries.map((e) => e.slug),
      source_commit_shas: [...new Set(entries.map((e) => e.source_commit_sha))],
    },
  };
}

/** The bell's notice that an entry was rejected. */
export function libraryRejectionNotice(entry: DecidedEntry, reason?: string): NotificationInsert {
  return {
    kind: "library_entry_rejected",
    severity: "warning",
    title: `Library rejected · ${entry.name} v${entry.version}`,
    body: reason ? reason : "Entry was not approved for fleet use.",
    url: "/modules",
    metadata: { library_entry_id: entry.id, slug: entry.slug, version: entry.version },
  };
}

// ─── Pins ───────────────────────────────────────────────────────────────────

/** Whether an entry may be pinned: approved, at a commit it records. */
export function judgePinnable(entry: {
  approval_status: string;
  source_commit_sha: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (entry.approval_status !== "approved") return { ok: false, reason: "not approved" };
  const problem = commitProblem(entry.source_commit_sha);
  return problem === null ? { ok: true } : { ok: false, reason: problem };
}

/** A pin, as `clone_library_pins` holds it. */
export type ClonePin = {
  clone_id: string;
  slug: string;
  version: number;
  library_entry_id: string;
};

/** What a pin check reads of the entry a pin names. */
export type PinnedEntry = {
  id: string;
  approval_status: string;
  file_paths: string[] | null;
  source_commit_sha: string | null;
};

export type PinIssue = {
  cloneId: string;
  slug: string;
  version: number;
  severity: "error" | "warning";
  reason: string;
};

/** Each pin, with the commit its entry records: null where it records none, or was not read. */
export type PinCommit = {
  cloneId: string;
  slug: string;
  version: number;
  libraryEntryId: string;
  commitSha: string | null;
};

/**
 * What is wrong with each pin, and the commit each one's entry records.
 *
 * `entries` is the entries that were read, or the reason they could not be.
 * An unread entry is reported as unread — never as deleted, which is what a
 * failed read used to read as here, and never as an entry without a commit.
 * Every issue is an `error`, which the pass's pre-flight holds a module-scoped
 * clone's delivery on, as it always has for a deleted, unapproved or empty
 * entry.
 */
export function judgeClonePins(
  pins: ClonePin[],
  entries: ReadonlyMap<string, PinnedEntry> | { unread: string },
): { issues: PinIssue[]; pins: PinCommit[] } {
  const issues: PinIssue[] = [];
  const reported: PinCommit[] = [];
  for (const p of pins) {
    const issue = (reason: string) =>
      issues.push({
        cloneId: p.clone_id,
        slug: p.slug,
        version: p.version,
        severity: "error",
        reason,
      });
    const entry = "unread" in entries ? undefined : entries.get(p.library_entry_id);
    reported.push({
      cloneId: p.clone_id,
      slug: p.slug,
      version: p.version,
      libraryEntryId: p.library_entry_id,
      commitSha: entry && isCommitSha(entry.source_commit_sha) ? entry.source_commit_sha : null,
    });
    if ("unread" in entries) {
      issue(`Library entry could not be read: ${entries.unread}`);
      continue;
    }
    if (!entry) {
      issue("Library entry was deleted");
      continue;
    }
    if (entry.approval_status !== "approved") {
      issue(`Entry is now ${entry.approval_status}`);
    } else {
      const problem = commitProblem(entry.source_commit_sha);
      if (problem !== null) issue(`Approved entry ${problem}`);
    }
    if ((entry.file_paths ?? []).length === 0) issue("Pinned entry has no file paths");
  }
  return { issues, pins: reported };
}

/** `checkout@v3 (prime@abc1234)`: a pin a delivery honoured, as its summary names it. */
export function pinLabel(pin: { slug: string; version: number; commitSha: string | null }): string {
  return `${pin.slug}@v${pin.version} (${primeCommitLabel(pin.commitSha) ?? "no commit recorded"})`;
}
