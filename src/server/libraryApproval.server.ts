/**
 * The reads and writes behind approving library entries.
 *
 * The decisions are in `libraryApproval.pure.ts`, with the reasoning beside
 * them (docs/DELIVERY_SYSTEM_PLAN.md, D19). This is everything around them:
 * who is asking, what was read, and what was written.
 *
 * Everything runs as the caller. `supabase` is the user-scoped client the
 * server function was handed, so row-level security still decides what the
 * caller may read and write. Row-level security does NOT decide who may
 * approve: `module_library`'s update and insert policies admit any operator,
 * and the 20260425 migration that added approval says in its own words that
 * "the function-level guard in code is what enforces who may set
 * approval_status". This module is that guard, for every path that approves.
 *
 * ## One publication path
 *
 * `publishToLibrary` (the Modules tab) and `publishAllToLibrary` (the library
 * re-ingest) each used to write their own entries, and neither approved one,
 * recorded a commit or asked who was publishing. Both now come through
 * `publishModulesToLibrary`, so the entry has one shape and the rule has one
 * place to hold.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { mapWithConcurrencyOrThrow } from "@/lib/concurrency";
import {
  describeDbError,
  judgeApproval,
  judgePublication,
  libraryApprovalNotice,
  libraryEntryInsert,
  libraryRejectionNotice,
  type DecidedEntry,
  type DetectionRunCommit,
  type PublishableModule,
} from "./libraryApproval.pure";

type Db = SupabaseClient<Database>;
type LibraryRow = Database["public"]["Tables"]["module_library"]["Row"];

// ─── Who may approve ────────────────────────────────────────────────────────

/** A precondition: met, or not, with the reason in words a person can act on. */
export type Check = { ok: true } | { ok: false; error: string };

/**
 * Whether `userId` may approve library entries: `has_role` for admin, then
 * super_admin, the check `setLibraryApprovalStatus` has always made.
 *
 * A role read that failed is said to have failed. It used to read as "not an
 * admin", which refuses the right person for the wrong reason.
 */
export async function requireLibraryAdmin(
  supabase: Db,
  userId: string,
  act: string,
): Promise<Check> {
  for (const role of ["admin", "super_admin"] as const) {
    const { data, error } = await supabase.rpc("has_role", { _user_id: userId, _role: role });
    if (error) {
      return {
        ok: false,
        error: `Could not check whether you may ${act}, so nothing was done: ${error.message}`,
      };
    }
    if (data === true) return { ok: true };
  }
  return { ok: false, error: `Admin role required to ${act}` };
}

// ─── Whether the commit columns are there ──────────────────────────────────

/**
 * Whether both commit columns exist, asked of each table with a read that
 * returns no row.
 *
 * Asked by the library re-ingest before it wipes anything: its detection run
 * cannot run without somewhere to record its commit, and finding that out
 * after the wipe would leave an empty catalogue and every clone's installs
 * gone with it.
 */
export async function probeCommitColumns(supabase: Db): Promise<Check> {
  const runs = await supabase.from("module_detection_runs").select("commit_sha").limit(0);
  if (runs.error) return { ok: false, error: describeDbError(runs.error) };
  const entries = await supabase.from("module_library").select("source_commit_sha").limit(0);
  if (entries.error) return { ok: false, error: describeDbError(entries.error) };
  return { ok: true };
}

// ─── Publishing ─────────────────────────────────────────────────────────────

/**
 * The columns of `modules` a publication reads. One literal: supabase-js
 * parses a column list at the type level, and a built-up string would type
 * the row as an error. The library follow reads the modules it publishes with
 * it too, so both publish from the same read.
 */
export const MODULE_COLUMNS =
  "id, name, slug, status, description, routes, route_entry_file, resolved_files, file_globs, backend_file_globs, backend_manifest, detection_run_id, layer, cohesion_score, coupling_score, ai_confidence, ai_reasoning, shared_by_modules, edge_functions, database_tables, required_secrets, required_migrations, storage_buckets, cron_jobs";

/** Ids per `in` read of `modules`: 100 uuids is about 3.7 KB of query string. */
const MODULE_READ_CHUNK = 100;

function chunked<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export type PublishedEntry = DecidedEntry;

export type RefusedModule = { moduleId: string; slug: string | null; reason: string };

export type PublishAnswer = {
  ok: boolean;
  /** Set when nothing was published, saying why. */
  error?: string;
  published: number;
  entries: PublishedEntry[];
  /** Each module that was not published, by name, and why. */
  refused: RefusedModule[];
  /** Published, but something after the entry was written did not land. */
  warnings: string[];
};

export type PublishRequest = {
  userId: string;
  /** The modules to publish, or every module whose status is `approved` (the re-ingest). */
  moduleIds: string[] | "approved";
  /** Tags for each entry. Defaults to none. */
  tagsFor?: (module: PublishableModule) => string[];
};

function failed(error: string, refused: RefusedModule[] = []): PublishAnswer {
  return { ok: false, error, published: 0, entries: [], refused, warnings: [] };
}

/**
 * Publish modules to the library, which approves each entry, at the commit its
 * module's files were detected at.
 *
 * A module that cannot be published is refused by name, with its reason, and
 * the rest are published; an answer that published nothing says so as an
 * error. A read the whole publication depends on — the caller's role, the
 * modules, the runs that detected them — that fails stops it before anything
 * is written.
 */
export async function publishModulesToLibrary(
  supabase: Db,
  request: PublishRequest,
): Promise<PublishAnswer> {
  const admin = await requireLibraryAdmin(
    supabase,
    request.userId,
    "publish library entries, which approves them",
  );
  if (!admin.ok) return failed(admin.error);

  const wanted = request.moduleIds === "approved" ? null : [...new Set(request.moduleIds)];
  if (wanted !== null && wanted.length === 0) return failed("No modules were named to publish");

  // Read in chunks: "Select all" on the Modules tab names every module, and an
  // `in` list of 135 ids is most of a URL already.
  const modules: PublishableModule[] = [];
  const chunks = wanted === null ? [null] : chunked(wanted, MODULE_READ_CHUNK);
  for (const ids of chunks) {
    const base = supabase.from("modules").select(MODULE_COLUMNS);
    const { data: moduleRows, error: modulesError } = await (ids === null
      ? base.eq("status", "approved")
      : base.in("id", ids));
    if (modulesError) {
      return failed(`Could not read the modules to publish: ${describeDbError(modulesError)}`);
    }
    modules.push(...(moduleRows ?? []));
  }

  const refused: RefusedModule[] = [];
  if (wanted !== null) {
    const found = new Set(modules.map((m) => m.id));
    for (const id of wanted) {
      if (!found.has(id))
        refused.push({ moduleId: id, slug: null, reason: `module ${id} not found` });
    }
  }
  if (modules.length === 0) {
    return failed(
      wanted === null ? "No approved module to publish" : "None of the modules named was found",
      refused,
    );
  }

  // The commit each module's files were detected at, from the run that
  // detected it. Read once for the whole publication; a failure here is an
  // error for all of it, never a module "without a commit".
  const runIds = [
    ...new Set(modules.map((m) => m.detection_run_id).filter((id): id is string => !!id)),
  ];
  const runs = new Map<string, DetectionRunCommit>();
  if (runIds.length > 0) {
    const { data: runRows, error: runsError } = await supabase
      .from("module_detection_runs")
      .select("id, commit_sha, created_at")
      .in("id", runIds);
    if (runsError) {
      return failed(
        `Could not read the detection runs these modules were detected by, so no commit was ` +
          `checked and nothing was published: ${describeDbError(runsError)}`,
        refused,
      );
    }
    for (const r of runRows ?? []) runs.set(r.id, r);
  }

  const now = new Date().toISOString();
  const written = await writeLibraryEntries(supabase, modules, runs, {
    publisherId: request.userId,
    now,
    tagsFor: request.tagsFor,
  });
  const { entries, warnings } = written;
  refused.push(...written.refused);

  const { error: auditError } = await supabase.from("audit_log").insert({
    action: "module.publish_to_library",
    entity_type: "module_library",
    actor_user_id: request.userId,
    metadata: {
      module_ids: wanted ?? modules.map((m) => m.id),
      published: entries.map((e) => ({
        library_entry_id: e.id,
        slug: e.slug,
        version: e.version,
        source_commit_sha: e.source_commit_sha,
      })),
      refused: refused.map((r) => ({ module_id: r.moduleId, slug: r.slug, reason: r.reason })),
      approved_at: now,
    },
  });
  if (auditError) {
    console.error(`[library] the publication's audit row did not land: ${auditError.message}`);
    warnings.push(`The audit row did not land: ${auditError.message}`);
  }

  const notice = libraryApprovalNotice(entries);
  if (notice) {
    const { error: noticeError } = await supabase.from("notifications").insert(notice);
    if (noticeError) {
      console.error(`[library] the approval notice did not land: ${noticeError.message}`);
      warnings.push(`The approval notice did not land: ${noticeError.message}`);
    }
  }

  if (entries.length === 0) {
    // Every refusal is in `refused`, by name; the sentence names the first few.
    const named = refused.slice(0, 3).map((r) => r.reason);
    const more = refused.length > 3 ? `; and ${refused.length - 3} more` : "";
    return {
      ok: false,
      error: `Nothing was published: ${refused.length} module(s) refused. ${named.join("; ")}${more}`,
      published: 0,
      entries,
      refused,
      warnings,
    };
  }
  return { ok: true, published: entries.length, entries, refused, warnings };
}

/**
 * Write each module's next entry, approved at the commit `runs` records for
 * it: the one writer both publications go through. It asks nobody's role,
 * so it is called only behind a check that did: `publishModulesToLibrary`,
 * after `requireLibraryAdmin`, and the library follow, from the cron-secret
 * hook (`libraryFollowCallers.contract.test.ts` holds it to those two).
 * `publisherId` is null for the follow, whose entries the owner approved by
 * policy.
 *
 * A module that cannot be published is refused by name, with its reason, and
 * the rest are written. Five modules at a time, each its version read, its
 * insert and its supersede in that order: a Worker holds at most six
 * connections open, and the follow's first invocations were cut about 70 s
 * in, 23 entries into a publication that wrote one every 87 ms (29 Oct
 * 2026). What it returns is in the order of `modules`, as it always was.
 */
export async function writeLibraryEntries(
  supabase: Db,
  modules: readonly PublishableModule[],
  runs: ReadonlyMap<string, DetectionRunCommit>,
  at: {
    publisherId: string | null;
    now: string;
    tagsFor?: (module: PublishableModule) => string[];
  },
): Promise<{ entries: PublishedEntry[]; refused: RefusedModule[]; warnings: string[] }> {
  type Outcome = { entry?: PublishedEntry; refused?: RefusedModule; warning?: string };
  const write = async (m: PublishableModule): Promise<Outcome> => {
    const verdict = judgePublication(m, runs);
    if (!verdict.ok) return { refused: { moduleId: m.id, slug: m.slug, reason: verdict.reason } };

    // The next version. A read that failed is not "no versions": numbering the
    // entry v1 would write a second v1 beside the first.
    const { data: latest, error: versionError } = await supabase
      .from("module_library")
      .select("version")
      .eq("slug", m.slug)
      .order("version", { ascending: false })
      .limit(1);
    if (versionError) {
      return {
        refused: {
          moduleId: m.id,
          slug: m.slug,
          reason: `${m.name} (${m.slug}): could not read its published versions: ${describeDbError(versionError)}`,
        },
      };
    }
    const version = (latest?.[0]?.version ?? 0) + 1;

    const { data: written, error: insertError } = await supabase
      .from("module_library")
      .insert(
        libraryEntryInsert(m, {
          version,
          runId: verdict.runId,
          commitSha: verdict.commitSha,
          publisherId: at.publisherId,
          now: at.now,
          tags: at.tagsFor?.(m) ?? [],
        }),
      )
      .select("id, name, slug, version, source_commit_sha")
      .single();
    if (insertError || !written) {
      // module_library_slug_version_key (20261028140000): a publication of the
      // same module that read the same last version wrote this number first.
      const raced = insertError?.code === "23505";
      return {
        refused: {
          moduleId: m.id,
          slug: m.slug,
          reason: raced
            ? `${m.name} (${m.slug}): another publication wrote v${version} first, so this one ` +
              `wrote nothing; publish it again to number it after that one`
            : `${m.name} (${m.slug}): the entry was not written: ${
                insertError ? describeDbError(insertError) : "no row came back"
              }`,
        },
      };
    }

    // Superseded only once the new entry exists. Flipping first, as this used
    // to, left a slug with no latest entry whenever the insert then failed.
    // Only versions below this one: a publication that numbered itself after
    // this one, and landed while this one was being written, stays latest.
    // Clearing every other latest row let two publications clear each other.
    const { error: supersedeError } = await supabase
      .from("module_library")
      .update({ is_latest: false })
      .eq("slug", m.slug)
      .eq("is_latest", true)
      .lt("version", version);
    return {
      entry: written,
      warning: supersedeError
        ? `${m.slug} v${version} was published, but its earlier versions still read latest: ${supersedeError.message}`
        : undefined,
    };
  };

  const outcomes = await mapWithConcurrencyOrThrow([...modules], 5, write);
  return {
    entries: outcomes.flatMap((o) => (o.entry ? [o.entry] : [])),
    refused: outcomes.flatMap((o) => (o.refused ? [o.refused] : [])),
    warnings: outcomes.flatMap((o) => (o.warning ? [o.warning] : [])),
  };
}

// ─── Deciding entries already published ─────────────────────────────────────

export type Decision = "approved" | "rejected" | "pending";

const DECIDED_COLUMNS = "id, name, slug, version, source_commit_sha";

function decisionUpdate(status: Decision, userId: string, reason: string | undefined) {
  return {
    approval_status: status,
    approved_by: status === "approved" ? userId : null,
    approved_at: status === "approved" ? new Date().toISOString() : null,
    rejection_reason: status === "rejected" ? (reason ?? null) : null,
  } satisfies Database["public"]["Tables"]["module_library"]["Update"];
}

type CommitNarrowable<Q> = { not(column: "source_commit_sha", operator: "is", value: null): Q };

/**
 * An approval writes only rows that record a commit: the judgement read the
 * row first, and this holds the write to it whatever changed in between.
 * Any other decision writes the rows as they are.
 */
function whereCommitRecordedIf<Q extends CommitNarrowable<Q>>(query: Q, approving: boolean): Q {
  return approving ? query.not("source_commit_sha", "is", null) : query;
}

/**
 * Approve, reject or reset one entry (`setLibraryApprovalStatus`).
 *
 * Approving needs the commit the entry records, and the write itself is
 * filtered on one being there, so an entry that records none cannot become
 * approved by any interleaving.
 */
export async function decideLibraryEntry(
  supabase: Db,
  input: { userId: string; entryId: string; status: Decision; reason?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = await requireLibraryAdmin(supabase, input.userId, "approve library entries");
  if (!admin.ok) return admin;

  const { data: entry, error: readError } = await supabase
    .from("module_library")
    .select(DECIDED_COLUMNS)
    .eq("id", input.entryId)
    .maybeSingle();
  if (readError) return { ok: false, error: describeDbError(readError) };
  if (!entry) return { ok: false, error: "Library entry not found" };

  if (input.status === "approved") {
    const verdict = judgeApproval(entry);
    if (!verdict.ok) return { ok: false, error: verdict.reason };
  }

  const { data: updated, error } = await whereCommitRecordedIf(
    supabase
      .from("module_library")
      .update(decisionUpdate(input.status, input.userId, input.reason))
      .eq("id", input.entryId),
    input.status === "approved",
  )
    .select(DECIDED_COLUMNS)
    .maybeSingle();
  if (error) return { ok: false, error: describeDbError(error) };
  if (!updated) {
    return {
      ok: false,
      error: "The entry changed while it was being decided; nothing was written",
    };
  }

  const { error: auditError } = await supabase.from("audit_log").insert({
    action: `library.${input.status}`,
    entity_type: "module_library",
    entity_id: input.entryId,
    actor_user_id: input.userId,
    metadata: {
      status: input.status,
      reason: input.reason ?? null,
      source_commit_sha: updated.source_commit_sha,
    },
  });
  if (auditError)
    console.error(`[library] the decision's audit row did not land: ${auditError.message}`);

  // Fan-out so the fleet sees approval decisions in the bell.
  const notice =
    input.status === "approved"
      ? libraryApprovalNotice([updated])
      : input.status === "rejected"
        ? libraryRejectionNotice(updated, input.reason)
        : null;
  if (notice) {
    const { error: noticeError } = await supabase.from("notifications").insert(notice);
    if (noticeError)
      console.error(`[library] the decision's notice did not land: ${noticeError.message}`);
  }

  return { ok: true };
}

/**
 * Approve, reject or reset several entries (the Library tab's bulk bar).
 *
 * Approving refuses the whole batch, naming each entry, when any of them
 * records no commit, rather than approving part of a selection the operator
 * made as one.
 */
export async function decideLibraryEntries(
  supabase: Db,
  input: { userId: string; ids: string[]; status: Decision; reason?: string },
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const admin = await requireLibraryAdmin(supabase, input.userId, "approve library entries");
  if (!admin.ok) return admin;

  if (input.status === "approved") {
    const { data: rows, error: readError } = await supabase
      .from("module_library")
      .select(DECIDED_COLUMNS)
      .in("id", input.ids);
    if (readError) return { ok: false, error: describeDbError(readError) };
    const refusals = (rows ?? [])
      .map((e) => judgeApproval(e))
      .filter((v): v is { ok: false; reason: string } => !v.ok);
    if (refusals.length > 0) {
      return {
        ok: false,
        error:
          `Nothing was approved: ${refusals.length} of the ${input.ids.length} entries cannot be. ` +
          refusals
            .slice(0, 5)
            .map((r) => r.reason)
            .join(" ") +
          (refusals.length > 5 ? ` …and ${refusals.length - 5} more.` : ""),
      };
    }
  }

  const { data: updated, error } = await whereCommitRecordedIf(
    supabase
      .from("module_library")
      .update(decisionUpdate(input.status, input.userId, input.reason))
      .in("id", input.ids),
    input.status === "approved",
  ).select("id");
  if (error) return { ok: false, error: describeDbError(error) };

  const { error: auditError } = await supabase.from("audit_log").insert({
    action: `library.bulk_${input.status}`,
    entity_type: "module_library",
    actor_user_id: input.userId,
    metadata: {
      count: (updated ?? []).length,
      ids: input.ids,
      reason: input.reason ?? null,
    },
  });
  if (auditError)
    console.error(`[library] the bulk decision's audit row did not land: ${auditError.message}`);

  return { ok: true, count: (updated ?? []).length };
}

// ─── Reading the library ────────────────────────────────────────────────────

/** Rows per page. Under PostgREST's default `max_rows` (1,000), so a page is never cut short by it. */
const LIBRARY_PAGE = 500;

export type LibraryRead =
  | {
      ok: true;
      entries: LibraryRow[];
      /** Display names of the entries' approvers, by user id, where a profile names one. */
      approvers: Record<string, string>;
      /** Set when the approvers' names could not be read; the entries still are. */
      approversError: string | null;
    }
  | {
      ok: false;
      error: string;
      entries: [];
      approvers: Record<string, never>;
      approversError: null;
    };

/**
 * Every library entry, and the names of the people who approved them.
 *
 * This read stopped at 200 rows, ordered by name. The library held 134 entries
 * on 28 Oct 2026, and publishing the catalogue again adds one per module, so
 * the panel would have shown the first 200 alphabetically and the pin pickers
 * offered nothing past them, without a word. It pages now, to the count the
 * first page reports.
 */
export async function readModuleLibrary(
  supabase: Db,
  options: { latestOnly: boolean; slug?: string },
): Promise<LibraryRead> {
  const entries: LibraryRow[] = [];
  for (let from = 0; ; ) {
    let query = supabase
      .from("module_library")
      .select("*", { count: "exact" })
      .order("name", { ascending: true })
      .order("version", { ascending: false })
      .order("id", { ascending: true });
    if (options.latestOnly) query = query.eq("is_latest", true);
    if (options.slug) query = query.eq("slug", options.slug);
    const { data, error, count } = await query.range(from, from + LIBRARY_PAGE - 1);
    if (error) {
      return {
        ok: false,
        error: describeDbError(error),
        entries: [],
        approvers: {},
        approversError: null,
      };
    }
    const page = data ?? [];
    entries.push(...page);
    from += page.length;
    if (page.length === 0) break;
    if (
      count !== null && count !== undefined ? entries.length >= count : page.length < LIBRARY_PAGE
    ) {
      break;
    }
  }

  const approverIds = [
    ...new Set(entries.map((e) => e.approved_by).filter((id): id is string => !!id)),
  ];
  const approvers: Record<string, string> = {};
  let approversError: string | null = null;
  if (approverIds.length > 0) {
    const { data: profiles, error } = await supabase
      .from("profiles")
      .select("user_id, display_name")
      .in("user_id", approverIds);
    if (error) approversError = error.message;
    for (const p of profiles ?? []) if (p.display_name) approvers[p.user_id] = p.display_name;
  }

  return { ok: true, entries, approvers, approversError };
}
