// Migration drift -- "the migration ran" and "the thing it was for is there"
// are different questions, and on this deployment the ledger cannot answer
// either: 40 of 211 repo versions appear in `supabase_migrations.schema_migrations`
// and 103 of its rows match no repo file, because Lovable stamps its own apply
// timestamps.
//
// So each migration declares its own effect as a `-- @asserts` line, the hourly
// `/hooks/migration-drift` worker resolves those against the live schema, and
// this reads back what it found. Admin-gated: a list of which migrations have
// not taken is operator business.
import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "@/integrations/supabase/role-middleware";

export type MigrationAssertionRow = {
  migration: string;
  assertion: string;
  kind: string;
  /**
   * Six verdicts, not two. `error` is the probe failing, `unassertable` is
   * there being no channel that can answer, and `superseded` is a later
   * migration's recorded decision retiring the claim -- none of the three is
   * a failed claim.
   */
  status: "satisfied" | "unsatisfied" | "unassertable" | "not_applicable" | "error" | "superseded";
  detail: string;
  checked_at: string;
  last_satisfied_at: string | null;
};

/**
 * A migration waiting to be applied, or one that failed and is holding the
 * queue. Only the non-settled rows travel: an operator opening this page is
 * asking "did my migration land", and a roll call of everything that ever did
 * is the answer to a different question.
 */
export type MigrationQueueRow = {
  version: string;
  name: string;
  status: string;
  attempts: number;
  error: string | null;
  enqueued_at: string;
};

export type MigrationDriftReport = {
  rows: MigrationAssertionRow[];
  /** Queued, running or failed. Never the applied ones. */
  queue: MigrationQueueRow[];
  /**
   * A failed migration HALTS the queue -- migrations are ordered and applying
   * N+1 after N failed is how a schema becomes unreproducible. So this is not
   * one bad file, it is the pipeline stopped.
   */
  queueHalted: boolean;
  /** Claims compiled from the corpus, whether or not they have been checked. */
  declared: number;
  /** Migrations carrying at least one claim. */
  migrations: number;
  /** Declared claims with no observation recorded yet. */
  neverChecked: number;
  drifted: number;
  satisfied: number;
  unassertable: number;
  errored: number;
  /** Most recent observation of any claim; null before the first run. */
  lastCheckedAt: string | null;
  fetchedAt: string;
};

export const fetchMigrationDrift = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async (): Promise<MigrationDriftReport> => {
    const { supabaseAdmin } = await import(
      /* @vite-ignore */ "@/integrations/supabase/client.server"
    );
    const { MIGRATION_CLAIMS } = await import(
      /* @vite-ignore */ "@/server/migrationAssertions.generated"
    );
    // Imported, never re-implemented. A second spelling of a claim's source
    // form would silently stop matching the rows the worker writes, and the
    // symptom would be `neverChecked` counting claims that have been checked
    // every hour for a month.
    const { formatAssertion } = await import(
      /* @vite-ignore */ "@/server/migrationAssertions.pure"
    );

    const { data, error } = await supabaseAdmin
      .from("migration_assertion_checks")
      .select("migration, assertion, kind, status, detail, checked_at, last_satisfied_at")
      .order("checked_at", { ascending: false });
    if (error) throw new Error(`Could not read migration_assertion_checks: ${error.message}`);

    const rows = (data ?? []) as MigrationAssertionRow[];

    // Read separately, and a failure here does not fail the whole report: the
    // assertions and the queue answer different questions, and losing both
    // because one table is unreachable is worse than losing one.
    let queue: MigrationQueueRow[] = [];
    const { data: queued, error: queueError } = await supabaseAdmin
      .from("schema_migration_queue")
      .select("version, name, status, attempts, error, enqueued_at")
      .neq("status", "applied")
      .order("version", { ascending: true });
    if (queueError) {
      console.error("[migration-drift] could not read the queue:", queueError.message);
    } else {
      queue = (queued ?? []) as MigrationQueueRow[];
    }
    const seen = new Set(rows.map((r) => `${r.migration} ${r.assertion}`));
    const declared = MIGRATION_CLAIMS.reduce((n, c) => n + c.assertions.length, 0);

    // Counted from the corpus rather than from the table: a claim with no row
    // is the interesting case -- a migration merged an hour ago and the worker
    // has not reached it, or has not run at all. Reporting only what the table
    // holds would make an alarm that has never run look like an alarm with
    // nothing to report.
    let neverChecked = 0;
    for (const c of MIGRATION_CLAIMS) {
      for (const a of c.assertions) {
        const key = `${c.migration} ${formatAssertion(a)}`;
        if (!seen.has(key)) neverChecked += 1;
      }
    }

    return {
      rows,
      queue,
      queueHalted: queue.some((q) => q.status === "failed"),
      declared,
      migrations: MIGRATION_CLAIMS.length,
      neverChecked,
      drifted: rows.filter((r) => r.status === "unsatisfied").length,
      satisfied: rows.filter((r) => r.status === "satisfied").length,
      unassertable: rows.filter((r) => r.status === "unassertable").length,
      errored: rows.filter((r) => r.status === "error").length,
      lastCheckedAt: rows[0]?.checked_at ?? null,
      fetchedAt: new Date().toISOString(),
    };
  });
