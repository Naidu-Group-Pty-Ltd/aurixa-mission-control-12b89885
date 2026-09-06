/**
 * Copying the prime's reference data into a clone, server-side.
 *
 * ## What this is for
 *
 * A provisioned clone has the prime's whole schema and none of its rows, by
 * design — `provisionCloneBackend` says so in as many words: *"Structure only —
 * no data ever leaves the prime."* The consequence is a tenant that cannot draw
 * a document, because the 500-master template catalogue is data.
 *
 * The obvious repair — apply the four `seed_template_library_*` migrations — is
 * not available and should not be. They are 36-41 MB each, past what the
 * Management API will take in one statement, and they are also the wrong shape:
 * a migration replays whatever the prime's repo said months ago, while what a
 * tenant needs is the catalogue as it stands.
 *
 * ## Why it runs here rather than through a person
 *
 * The data never touches an operator's browser or a developer's terminal. It
 * moves prime → Mission Control's server → clone, a page at a time, and the
 * identity columns are stripped *on the prime* before the page is read, so a
 * prime user's id is never in this process's memory at all.
 *
 * ## The shape: budgeted and resumed, not looped
 *
 * ~19 MB across eight tables does not fit in one edge invocation, and a worker
 * that tries is the shape that timed the mirror cascade out at exactly
 * 60,000 ms. So a run works to a wall-clock budget, banks a keyset cursor per
 * table, and returns; the next tick picks up where it stopped. That is the same
 * contract the investment-report generator lives under, for the same reason.
 *
 * ## One engine, two callers
 *
 * The hourly job and the operator's button both call `runReferenceDataSync`.
 * They were never allowed to become two ideas of what a clone is owed — that is
 * how a button and a cron come to disagree.
 *
 * Provisioning deliberately calls neither. A backend that has just reached
 * `ready` is exactly what the hourly sweep claims, so a new clone is seeded
 * without the provisioning pipeline growing a step that can fail and leave a
 * half-built tenant behind. Seeding is a property of a ready clone, not a stage
 * of building one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { resolvePrimeBackendRef } from "./prime-backend.server";
import { runSqlOnProject } from "./backend-provisioning.server";
import { notifyOperators, writeAuditLog } from "./audit.server";
import { REFERENCE_TABLES, planColumns, refName, type ReferenceTable } from "./referenceTables.pure";
import {
  buildPageQuery,
  buildInsertStatement,
  buildCountQuery,
  buildColumnsQuery,
  buildTableExistsQuery,
} from "./referenceCopy.pure";

type Db = SupabaseClient<Database>;

/**
 * Wall-clock budget for one invocation.
 *
 * Under the cron's 120 s pg_net timeout and well under the isolate ceiling, so
 * the worker stops itself between pages and records where it got to. Being cut
 * off mid-page is survivable — the cursor only advances after a page lands —
 * but it wastes the page, and a job that always wastes its last page never
 * finishes a big table.
 */
const DEFAULT_BUDGET_MS = 90_000;

/** A claim older than this is treated as abandoned. */
const STALE_CLAIM_MINUTES = 30;

/** Smallest page the copier will fall back to before giving up on a table. */
const MIN_ROWS_PER_PAGE = 1;

export type ReferenceTableResult = {
  table: string;
  status: "complete" | "in_progress" | "skipped" | "failed";
  rowsCopied: number;
  sourceRows: number | null;
  detail?: string;
};

export type ReferenceSyncResult = {
  cloneId: string | null;
  cloneName: string | null;
  tables: ReferenceTableResult[];
  /** Rows written during THIS invocation, not cumulative. */
  rowsCopied: number;
  /** Every allow-listed table is complete or deliberately skipped. */
  done: boolean;
  /** The run stopped on its budget with work outstanding. */
  budgetExhausted: boolean;
  error?: string;
};

const EMPTY: ReferenceSyncResult = {
  cloneId: null,
  cloneName: null,
  tables: [],
  rowsCopied: 0,
  done: false,
  budgetExhausted: false,
};

/** PostgREST and the Management API both wrap rows differently; tolerate both. */
function rowsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const o = raw as { rows?: unknown[]; result?: unknown[] } | null;
  if (Array.isArray(o?.rows)) return o.rows;
  if (Array.isArray(o?.result)) return o.result;
  return [];
}

async function reclaimStale(supabase: Db): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  const { error } = await supabase
    .from("clone_backends")
    .update({ reference_sync_started_at: null })
    .eq("status", "ready")
    .not("reference_sync_started_at", "is", null)
    .lt("reference_sync_started_at", cutoff);
  if (error) throw new Error(`Could not reclaim stale reference-sync claims: ${error.message}`);
}

/**
 * Copy one table until it is exhausted or the budget runs out.
 *
 * Returns the row count written and whether the table finished. Throws only on
 * something that makes the table uncopyable; the caller records that against
 * the table and moves to the next one, because `template_library_entries`
 * gaining a column is no reason for `suburb_directory` to stay empty.
 */
async function copyTable(args: {
  entry: ReferenceTable;
  primeRef: string;
  cloneRef: string;
  cursor: string | null;
  deadline: number;
  now: () => number;
  onProgress: (cursor: string | null, rowsCopied: number) => Promise<void>;
}): Promise<{ rowsCopied: number; complete: boolean; cursor: string | null }> {
  const { entry, primeRef, cloneRef, deadline, now, onProgress } = args;
  let cursor = args.cursor;
  let rowsCopied = 0;
  let pageSize = entry.rowsPerPage;

  for (;;) {
    if (now() >= deadline) return { rowsCopied, complete: false, cursor };

    const raw = await runSqlOnProject(
      primeRef,
      buildPageQuery(entry, PLANNED_NULLS.get(refName(entry)) ?? [], cursor, pageSize),
    );
    const page = rowsOf(raw) as Array<{ __cursor?: unknown; __row?: unknown }>;
    if (page.length === 0) return { rowsCopied, complete: true, cursor };

    const rows = page.map((r) => r.__row).filter((r) => r !== undefined && r !== null);
    const lastCursor = page[page.length - 1]?.__cursor;
    if (typeof lastCursor !== "string") {
      throw new Error(
        `${entry.table}: the prime returned a page with no usable cursor on ` +
          `\`${entry.pageKey}\`. Refusing to advance — guessing the next cursor is how a ` +
          "resumable copy silently skips rows.",
      );
    }

    try {
      await runSqlOnProject(cloneRef, buildInsertStatement(entry, JSON.stringify(rows)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // An oversized statement is a page-size problem, not a data problem. Halve
      // and retry the SAME cursor rather than failing the table: row widths grow
      // when a seed grows, and a hardcoded page size that was right when it was
      // written should not become an outage later.
      const oversized = /413|too large|payload|statement too long|request entity/i.test(msg);
      if (oversized && pageSize > MIN_ROWS_PER_PAGE) {
        pageSize = Math.max(MIN_ROWS_PER_PAGE, Math.floor(pageSize / 2));
        continue;
      }
      throw new Error(`${entry.table}: insert failed at cursor ${lastCursor}: ${msg}`);
    }

    // The cursor advances only after the page has landed. A crash between the
    // read and the write re-copies a page, which `on conflict do nothing` makes
    // free; advancing first would skip it, which nothing would ever notice.
    cursor = lastCursor;
    rowsCopied += rows.length;
    await onProgress(cursor, rowsCopied);

    if (page.length < pageSize) return { rowsCopied, complete: true, cursor };
  }
}

/**
 * Per-run cache of which columns each table nulls.
 *
 * Populated from the LIVE prime schema inside `runReferenceDataSync` before any
 * page is read, so `copyTable` cannot be reached with an unvetted table. It is
 * module-scoped only to keep `copyTable`'s signature honest about what it does
 * not decide — it never persists across invocations of the worker.
 */
const PLANNED_NULLS = new Map<string, string[]>();

export async function runReferenceDataSync(
  supabase: Db,
  opts?: {
    cloneId?: string;
    budgetMs?: number;
    actorUserId?: string | null;
    /**
     * Clock seam. Present so the budget behaviour can be asserted without a
     * test that actually waits — a budget nobody can exercise is a budget
     * nobody has checked, and this one decides whether a half-copied table is
     * recorded as resumable or as finished.
     */
    now?: () => number;
  },
): Promise<ReferenceSyncResult> {
  const now = opts?.now ?? Date.now;
  const deadline = now() + Math.max(5_000, opts?.budgetMs ?? DEFAULT_BUDGET_MS);
  PLANNED_NULLS.clear();

  let primeRef: string;
  try {
    primeRef = await resolvePrimeBackendRef(supabase);
  } catch (e) {
    return { ...EMPTY, error: e instanceof Error ? e.message : "Prime backend is not configured" };
  }

  await reclaimStale(supabase);

  // Pick a clone. `status = 'ready'` is the same gate the migration sync uses:
  // never seed data into a schema that is mid-migration.
  let q = supabase
    .from("clone_backends")
    .select("clone_id, supabase_project_ref")
    .eq("status", "ready")
    .is("reference_sync_started_at", null)
    .not("supabase_project_ref", "is", null);
  if (opts?.cloneId) q = q.eq("clone_id", opts.cloneId);
  const { data: candidates, error: pickErr } = await q.limit(1);
  // A candidate list that could not be READ is not a fleet with nothing to do.
  if (pickErr) {
    return { ...EMPTY, error: `Could not read clone backends: ${pickErr.message}` };
  }
  const backend = candidates?.[0];
  if (!backend?.supabase_project_ref) return { ...EMPTY, done: true };

  const cloneId = backend.clone_id;
  const cloneRef = backend.supabase_project_ref;

  if (cloneRef === primeRef) {
    // Belt and braces. Nothing should ever produce this, and if something does,
    // the copy would be writing the prime's reference rows back onto the prime.
    return { ...EMPTY, cloneId, error: "Refusing to sync: the clone's project ref is the prime's" };
  }

  const { data: claimed, error: claimErr } = await supabase
    .from("clone_backends")
    .update({ reference_sync_started_at: new Date().toISOString() })
    .eq("clone_id", cloneId)
    .eq("status", "ready")
    .is("reference_sync_started_at", null)
    .select("clone_id");
  // A claim that ERRORED is not a claim somebody else won.
  if (claimErr) {
    return { ...EMPTY, cloneId, error: `Could not claim the clone: ${claimErr.message}` };
  }
  if (!claimed || claimed.length === 0) return { ...EMPTY, cloneId, done: false };

  const { data: cloneRow } = await supabase
    .from("clones")
    .select("name")
    .eq("id", cloneId)
    .maybeSingle();
  const cloneName = cloneRow?.name ?? cloneId;

  const { data: stateRows } = await supabase
    .from("clone_reference_syncs")
    .select("table_name, cursor, rows_copied, status")
    .eq("clone_id", cloneId);
  const stateOf = new Map((stateRows ?? []).map((r) => [r.table_name, r]));

  const out: ReferenceSyncResult = {
    ...EMPTY,
    cloneId,
    cloneName,
    tables: [],
  };

  for (const entry of REFERENCE_TABLES) {
    const name = refName(entry);
    const prior = stateOf.get(name);
    if (prior?.status === "complete" || prior?.status === "skipped") {
      out.tables.push({
        table: name,
        status: prior.status,
        rowsCopied: prior.rows_copied ?? 0,
        sourceRows: null,
      });
      continue;
    }

    if (now() >= deadline) {
      out.budgetExhausted = true;
      out.tables.push({
        table: name,
        status: "in_progress",
        rowsCopied: prior?.rows_copied ?? 0,
        sourceRows: null,
        detail: "not reached this run",
      });
      continue;
    }

    const record = async (fields: Record<string, unknown>) => {
      const { error } = await supabase.from("clone_reference_syncs").upsert(
        {
          clone_id: cloneId,
          table_name: name,
          updated_at: new Date().toISOString(),
          ...fields,
        } as never,
        { onConflict: "clone_id,table_name" },
      );
      if (error) {
        console.error("[reference-data] progress not recorded", {
          cloneId,
          table: name,
          error: error.message,
        });
      }
    };

    try {
      // Does the clone even have the table? A clone behind on migrations does
      // not, and that is a different problem with a different fix.
      const present = rowsOf(await runSqlOnProject(cloneRef, buildTableExistsQuery(entry)));
      if ((present[0] as { present?: unknown } | undefined)?.present !== true) {
        await record({
          status: "skipped",
          detail: "the clone does not have this table yet — it is behind on migrations",
          completed_at: new Date().toISOString(),
        });
        out.tables.push({
          table: name,
          status: "skipped",
          rowsCopied: 0,
          sourceRows: null,
          detail: "table absent on the clone (behind on migrations)",
        });
        continue;
      }

      // Vet the LIVE schema before a single row is read. This is the guard that
      // protects a tenant, and it runs every time rather than at review time.
      const colRows = rowsOf(await runSqlOnProject(primeRef, buildColumnsQuery(entry)));
      const actualColumns = colRows
        .map((r) => (r as { column_name?: unknown }).column_name)
        .filter((c): c is string => typeof c === "string");
      const plan = planColumns(entry, actualColumns);
      if (!plan.ok) {
        await record({ status: "failed", detail: plan.refusal });
        out.tables.push({
          table: name,
          status: "failed",
          rowsCopied: prior?.rows_copied ?? 0,
          sourceRows: null,
          detail: plan.refusal,
        });
        await notifyOperators({
          kind: "cascade_failed",
          severity: "error",
          title: `Reference sync refused ${name}`,
          body: plan.refusal,
          cloneId,
          url: `/clones/${cloneId}`,
          metadata: { table: name },
        });
        continue;
      }
      PLANNED_NULLS.set(name, plan.nulled);

      const countRows = rowsOf(await runSqlOnProject(primeRef, buildCountQuery(entry)));
      const sourceRows = Number((countRows[0] as { n?: unknown } | undefined)?.n ?? 0) || 0;

      await record({
        status: "copying",
        source_rows: sourceRows,
        started_at: prior?.cursor ? undefined : new Date().toISOString(),
      });

      const carried = prior?.rows_copied ?? 0;
      const { rowsCopied, complete, cursor } = await copyTable({
        entry,
        primeRef,
        cloneRef,
        cursor: prior?.cursor ?? null,
        deadline,
        now,
        onProgress: async (c, n) => {
          await record({ cursor: c, rows_copied: carried + n, status: "copying" });
        },
      });

      out.rowsCopied += rowsCopied;
      await record({
        cursor,
        rows_copied: carried + rowsCopied,
        status: complete ? "complete" : "copying",
        source_rows: sourceRows,
        detail: complete ? null : "resumed on the next run",
        completed_at: complete ? new Date().toISOString() : null,
      });
      out.tables.push({
        table: name,
        status: complete ? "complete" : "in_progress",
        rowsCopied: carried + rowsCopied,
        sourceRows,
      });
      if (!complete) out.budgetExhausted = true;
    } catch (e) {
      const detail = e instanceof Error ? e.message : "Unknown error";
      await record({ status: "failed", detail });
      out.tables.push({
        table: name,
        status: "failed",
        rowsCopied: prior?.rows_copied ?? 0,
        sourceRows: null,
        detail,
      });
    }
  }

  out.done = out.tables.every((t) => t.status === "complete" || t.status === "skipped");

  const { error: relErr } = await supabase
    .from("clone_backends")
    .update({ reference_sync_started_at: null })
    .eq("clone_id", cloneId);
  if (relErr) {
    console.error("[reference-data] could not release claim", { cloneId, error: relErr.message });
  }

  await writeAuditLog({
    action: "clone.reference_data_synced",
    entityType: "clone",
    entityId: cloneId,
    actorUserId: opts?.actorUserId ?? null,
    metadata: {
      trigger: opts?.actorUserId ? "operator" : "schedule",
      prime_backend_ref: primeRef,
      clone_project_ref: cloneRef,
      rows_copied: out.rowsCopied,
      done: out.done,
      budget_exhausted: out.budgetExhausted,
      tables: out.tables.map((t) => ({
        table: t.table,
        status: t.status,
        rows: t.rowsCopied,
        of: t.sourceRows,
      })),
    },
  });

  return out;
}
