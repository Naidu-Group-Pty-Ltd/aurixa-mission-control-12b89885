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
import {
  REFERENCE_TABLES,
  planColumns,
  refName,
  tablesToReopen,
  type ReferenceTable,
} from "./referenceTables.pure";
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

  /*
    Pick a clone.

    `status = 'ready'` is this lane's OWN gate, and it is deliberately stricter
    than the migration sync's — which is the opposite of what this comment used
    to say ("the same gate the migration sync uses"). That lane's eligibility
    admits a `failed` row carrying no migration block on purpose, because such
    a row was failed by the PROVISIONING lane and establishes nothing about the
    schema; its claim is then a compare-and-swap on whatever status eligibility
    was decided against, never a requirement of `ready`. Measured 19 Sep 2026:
    the 11:00 fleet pass claimed `npc-client-dashboard` while it read `failed`.

    Stricter is the right answer HERE — seeding a catalogue into a schema that
    may be mid-rebuild is not something `on conflict do nothing` makes safe —
    but the cost has to be stated rather than hidden behind a false equivalence:
    a clone that goes `failed` stops receiving reference data entirely, with
    nothing reporting it, and `npc-client-dashboard` sat that way from 14 Sep.

    Widening this gate is NOT the fix for that, and must not be done before
    `skipped` stops being terminal: a clone admitted while it is still behind on
    migrations has every table it does not yet hold marked `skipped`, and a
    skipped table is never retried — so it would trade a visible freeze for a
    permanent, silent gap.
  */
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

  const { data: stateRows, error: stateErr } = await supabase
    .from("clone_reference_syncs")
    .select("table_name, cursor, rows_copied, status, detail, notified_detail")
    .eq("clone_id", cloneId);
  /*
    A STATE READ THAT FAILED IS NOT A CLONE WITH NO STATE.

    The `error` here was discarded, and `data` is null on a failure, so
    `stateOf` came out EMPTY and every table read as never visited: complete
    tables re-copied from the first page, cursors ignored, and — since this
    commit — every recorded failure announced again as though it were new. On
    a clone carrying the 500 Investment Compass masters and a 24,294-row
    sanctions register that is a full re-walk of twenty-four tables against the
    prime, on every pass, for as long as the read keeps failing.

    Pre-existing, and reachable from today: adding `notified_detail` to this
    select means a deployment that lands before its migration reads 42703 here
    on a column the table does not have yet. `apply-migrations.yml`'s own header
    states the rule — "a column that exists before its reader is inert, a column
    that arrives after is a 42703" — and this is the read it lands on.

    So it refuses, exactly as the three reads above it already do: the candidate
    list that could not be read, the claim that errored, and the prime-ref
    guard. It is the same rule `readCase()` pays for in the AML module, where a
    discarded 42703 made twelve handlers report "Case not found" about a case
    the operator had open.

    The claim is released first. This is the one refusal that happens AFTER the
    claim, and returning without it parks the clone until the stale-claim sweep.
  */
  if (stateErr) {
    const { error: relErr } = await supabase
      .from("clone_backends")
      .update({ reference_sync_started_at: null })
      .eq("clone_id", cloneId);
    if (relErr) {
      console.error("[reference-data] could not release claim after a failed state read", {
        cloneId,
        error: relErr.message,
      });
    }
    return {
      ...EMPTY,
      cloneId,
      cloneName,
      error: `Could not read this clone's reference-sync state: ${stateErr.message}`,
    };
  }
  const stateOf = new Map((stateRows ?? []).map((r) => [r.table_name, r]));
  // A parent's copy is not finished while a child referencing it is
  // unfinished: `complete` is terminal, so without this a long child advances
  // against a parent frozen at an earlier pass and the clone refuses the page
  // with 23503. See `tablesToReopen` for the measurement.
  const reopen = tablesToReopen(new Map((stateRows ?? []).map((r) => [r.table_name, r.status])));

  const out: ReferenceSyncResult = {
    ...EMPTY,
    cloneId,
    cloneName,
    tables: [],
  };

  for (const entry of REFERENCE_TABLES) {
    const name = refName(entry);
    const prior = stateOf.get(name);
    const reopened = reopen.has(name);
    /** Rows this attempt has copied, for a failure notice that is about it. */
    let reached = prior?.rows_copied ?? 0;
    if (!reopened && (prior?.status === "complete" || prior?.status === "skipped")) {
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

    /**
     * Records progress, and says whether the write LANDED.
     *
     * Swallowing the error is right: a page that copied is copied whether or
     * not this row records it, and throwing here would fail a table over its
     * own bookkeeping. What was missing is the answer coming back, because
     * `reached` below is a claim about what this ROW says — and advancing it
     * on a write that failed is how a notice comes to quote a count nothing
     * stored.
     */
    const record = async (fields: Record<string, unknown>): Promise<boolean> => {
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
        return false;
      }
      return true;
    };

    /**
     * ONE SPELLING OF "the operator has already been told this".
     *
     * Two paths announce a table that will not fill itself — the live-schema
     * refusal below and the copy's own catch — and both are reached on every
     * pass for ever, because only `complete` and `skipped` are terminal. The
     * first version of this change put the comparison inline in the catch and
     * left the refusal notifying unconditionally, which at the cadence beside
     * it is up to ninety-six identical alerts a day for one table. Two
     * spellings of one rule is how the two come to disagree; this is the one.
     *
     * A table that was not failing is news. A table now failing for a
     * DIFFERENT reason is news — a 23503 becoming a 42703 is a different fault
     * with a different remedy. The same error on the same table is a state the
     * operator has already been told about, and `clone_reference_syncs` still
     * carries it in full for anyone looking.
     *
     * It reads `prior`, the snapshot taken before this pass touched the row,
     * which is exactly right: the question is what the operator was told LAST
     * time, not what this pass has just written.
     *
     * AND IT KEYS ON THE DELIVERY, NOT ON THE STATE.
     *
     * The first version compared `status === "failed" && detail === detail`,
     * and that predicate is wrong in a way invisible until the day it deploys.
     * This table has carried failures with reasons since long before anything
     * notified at all — the catch recorded and announced nothing, which is the
     * silence this whole change exists to end. Every one of those rows would
     * have answered "the same failure as before" on the first pass after
     * deployment, and suppressed for ever the alert that was owed. On the two
     * rows that motivated the work — `aml.sanctions_entries` on NPC Test since
     * 12 Sep, `aml.retention_schedules` on npc-client-dashboard since 14 Sep —
     * it would have preserved exactly the silence it was written to break.
     *
     * The same hole swallows a notice whose insert FAILED: `notifyOperators`
     * logs and returns, so the failure row is written either way and the next
     * pass reads it as proof of a delivery that never happened.
     *
     * So `notified_detail` is the key: the reason an operator was last
     * successfully told about, written only after the insert succeeded and
     * cleared when the table stops failing, so a recurrence after a repair is
     * news again. NULL on every historical row, which is the point.
     */
    const isRepeatFailure = (detail: string): boolean => prior?.notified_detail === detail;

    /**
     * Announce a failure unless the operator already holds this exact one, and
     * remember it only if the notice actually went.
     *
     * Both notifying paths go through here so they cannot hold different ideas
     * of what has been reported — the defect that produced this helper's
     * predecessor was one path fixed and the other left announcing on every
     * pass.
     */
    const announceFailure = async (
      detail: string,
      notice: Parameters<typeof notifyOperators>[0],
    ): Promise<void> => {
      if (isRepeatFailure(detail)) return;
      const delivered = await notifyOperators(notice);
      // Only a delivered notice is remembered. An insert that failed leaves the
      // marker alone, so the next pass tries again rather than recording a
      // silence as a report.
      if (delivered) await record({ notified_detail: detail });
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
          // Stopped failing, so the next failure is news again — including the
          // same one, which after a repair is a REGRESSION and not a repeat.
          notified_detail: null,
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
        // An unclassified column is stable: it is the same refusal next pass
        // and the pass after that. Announced on the transition, by the same
        // helper the catch answers to.
        await announceFailure(plan.refusal, {
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

      // A re-opened parent re-walks from the start. The page query orders on
      // `<pageKey>::text` and resumes with `key::text > cursor`, and a new
      // row's uuid sorts anywhere — so resuming from the stored cursor is
      // exactly how the rows this re-walk exists to fetch get missed. The
      // carried count goes with it, because this is one walk of the whole
      // table rather than a continuation of the last one.
      const resumeCursor = reopened ? null : (prior?.cursor ?? null);
      await record({
        status: "copying",
        source_rows: sourceRows,
        started_at: resumeCursor ? undefined : new Date().toISOString(),
      });

      const carried = reopened ? 0 : (prior?.rows_copied ?? 0);
      // Where this attempt got to, kept OUTSIDE the try so the catch can read
      // it. `prior` is the snapshot taken before any page was copied, so a
      // table that landed nine pages and failed on the tenth reported the
      // count it started with — usually zero — under a sentence promising the
      // count it stopped at.
      reached = carried;
      const { rowsCopied, complete, cursor } = await copyTable({
        entry,
        primeRef,
        cloneRef,
        cursor: resumeCursor,
        deadline,
        now,
        onProgress: async (c, n) => {
          const landed = await record({ cursor: c, rows_copied: carried + n, status: "copying" });
          // Only a CONFIRMED write moves it. `record` swallows its error, so a
          // progress write that failed leaves the row holding the older count
          // and the older cursor — and the catch below upserts `status` and
          // `detail` alone, which preserves both. Advancing regardless is how
          // the notice comes to name a count the row does not carry, under a
          // sentence promising the count it stopped at.
          if (landed) reached = carried + n;
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
        // Cleared only where the table FINISHED. A pass that merely got
        // further is still inside the same failure if it hits one again, and
        // clearing on `copying` would put the flood back one pass later.
        ...(complete ? { notified_detail: null } : {}),
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
        rowsCopied: reached,
        sourceRows: null,
        detail,
      });
      /*
        A TABLE THAT STOPPED HAS TO SAY SO.

        The refusal thirty lines above — a live schema this allow-list has not
        classified — notifies. This did not, and the two are the same kind of
        event to the tenant: a table that is not going to fill itself.

        Measured 19 Sep 2026. `aml.sanctions_entries` on NPC Test has read
        `failed` at 21,600 of 24,294 rows since 12 Sep with a 23503 naming the
        exact key it could not place, and nothing anywhere announced it. Nothing
        else in this codebase reads `clone_reference_syncs` either — only
        `migrationAssertions.pure.ts`, which is a static declaration — so the
        row WAS the whole report, and no one was reading it.

        Worth notifying even though the sync retries: a table whose failure is
        deterministic retries into the same error every hour for ever, which is
        indistinguishable from progress in every reading except this one. The
        status line is the copy an operator acts on, so it carries the table,
        the count it reached and the source's own words rather than a summary
        of them.
      */
      /*
        ONCE PER FAILURE, NOT ONCE PER PASS.

        Only `complete` and `skipped` are terminal, so a failed table is
        retried every pass for ever — and the cadence beside this change makes
        that four times an hour. Notifying each time turns one broken table
        into ninety-six alerts a day, and a shared outage into a feed nobody
        can read past; an alert that fires on a schedule is an alert people
        mute, which costs the silence this whole change exists to end.

        So the notice is about the TRANSITION. A table that was not failing is
        news, and a table now failing for a DIFFERENT reason is news — the
        23503 becoming a 42703 is a different fault with a different remedy.
        The same error on the same table is the state an operator has already
        been told about, and `clone_reference_syncs` still carries it in full
        for anyone looking.
      */
      await announceFailure(detail, {
        kind: "cascade_failed",
        severity: "error",
        title: `Reference sync stopped on ${name} for ${cloneName}`,
        body:
          `Copying ${name} into this clone stopped at ${reached} row(s): ${detail}. ` +
          "The rows already copied are kept and the next pass resumes from the same cursor, so " +
          "this will repeat until the cause is fixed — you are told once per distinct failure, " +
          "not once per pass. Reference data a clone is missing is not tenant data: it is the " +
          "seeded catalogue the product reads, and a clone without it cannot draw the documents " +
          "that depend on it.",
        cloneId,
        url: `/clones/${cloneId}`,
        metadata: { table: name, rows_copied: reached },
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
