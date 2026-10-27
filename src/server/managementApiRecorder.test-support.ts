/**
 * A Supabase Management API that answers the replay's reads and records the
 * rest — test support for the behavioural tests of `applyPrimeMigrations`,
 * imported by them and by nothing else.
 *
 * The replay reaches a clone through one endpoint, `database/query`, so what a
 * clone was SENT is exactly the sequence of queries posted there. This
 * answers the three the replay asks before it sends anything — the tracking
 * tables, the ledger union, the table count — and the schedule read the
 * prime-only sweep makes after it, and records every query, so a test can
 * assert what reached the clone and what its ledger was told.
 *
 * A body and its ledger record usually travel as ONE query
 * (`migrationRecordRequest.pure.ts`). `bodies()` gives the body part of each
 * and `recorded()` reads the record part, so a test asks what the clone was
 * sent and what its ledger was told without caring how the two were packed;
 * `sent` keeps every query whole, for a test that does care.
 *
 * It does not import the test runner: the caller installs `fetch` itself
 * (`vi.stubGlobal("fetch", api.fetch)`), which keeps this an ordinary module.
 */

import { LEDGER_RECORD_SEPARATOR } from "./migrationRecordRequest.pure";

/**
 * The ledger union, as `readCloneMigrationLedger` asks it: the replay reads
 * through that one fail-closed reader, which selects each row's name as well.
 */
const LEDGER_READ =
  /select version(?:, name)? from supabase_migrations\.schema_migrations\s+union/i;
const TABLE_COUNT = /from pg_tables/i;
const TRACKING = /create schema if not exists supabase_migrations/i;
/**
 * The read `sweepPrimeOnlyCronJobs` makes after a replay sent something: the
 * clone's schedule, asked for the prime's own jobs. Bookkeeping — nothing a
 * clone is sent — and answered from `cronJobs`, so a test can plant one.
 */
export const CRON_SWEEP_READ = /select jobid, jobname, command from cron\.job/i;
/** The write the sweep makes for each prime-only job it found. */
export const CRON_UNSCHEDULE = /select cron\.unschedule\((\d+)::bigint\)/i;

/** The ledger record for a version that ran: alone, or after the body it records. */
export const LEDGER_RECORD = /insert into supabase_migrations\.schema_migrations/i;

/**
 * The migration body a query carries: everything before its ledger record
 * where the two share the query, the whole query otherwise.
 */
export function bodyOf(query: string): string {
  const at = query.indexOf(LEDGER_RECORD_SEPARATOR);
  return at === -1 ? query : query.slice(0, at);
}

export type RecordingManagementApi = {
  /** Install as the global `fetch`. */
  fetch: (url: unknown, init?: { body?: unknown }) => Promise<Response>;
  /** Every query posted, in order. */
  sent: string[];
  /** Every migration body the clone was sent, in order: all but bookkeeping. */
  bodies: () => string[];
  /**
   * Every version the ledger was told, and the name it was told it under, by
   * a query the clone did not refuse: a refused query commits nothing.
   */
  recorded: () => Array<{ version: string | undefined; name: string | undefined }>;
};

/**
 * `applied` is the clone's ledger; `tables` its table count, which is what
 * lets a ledger with versions in it pass the pre-flight. `refuse` answers a
 * query with the 400 a clone's schema gives a statement it rejects, so a
 * failure travels the replay's own path rather than a thrown stub's.
 */
export function recordingManagementApi(
  opts: {
    applied?: string[];
    tables?: number;
    refuse?: (query: string) => boolean;
    /** The clone's `cron.job` rows, as the sweep reads them. Empty by default. */
    cronJobs?: Array<{ jobid: number; jobname: string; command: string }>;
  } = {},
): RecordingManagementApi {
  const sent: string[] = [];
  /** Queries answered with a refusal, which commit nothing, the record in them included. */
  const refused = new Set<number>();
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const bookkeeping = (q: string) =>
    TRACKING.test(q) ||
    LEDGER_READ.test(q) ||
    TABLE_COUNT.test(q) ||
    LEDGER_RECORD.test(q) ||
    CRON_SWEEP_READ.test(q) ||
    CRON_UNSCHEDULE.test(q);
  return {
    sent,
    fetch: async (_url, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      sent.push(query);
      if (opts.refuse?.(query)) {
        refused.add(sent.length - 1);
        return new Response("ERROR: 42P07", { status: 400 });
      }
      if (LEDGER_READ.test(query)) {
        return answer((opts.applied ?? []).map((version) => ({ version })));
      }
      if (TABLE_COUNT.test(query)) return answer([{ n: opts.tables ?? 0 }]);
      if (CRON_SWEEP_READ.test(query)) return answer(opts.cronJobs ?? []);
      return answer([]);
    },
    bodies: () =>
      sent.flatMap((q) =>
        q.includes(LEDGER_RECORD_SEPARATOR) ? [bodyOf(q)] : bookkeeping(q) ? [] : [q],
      ),
    recorded: () =>
      sent
        // A refused query is one transaction that did not commit.
        .filter((_, i) => !refused.has(i))
        // The record part alone where a body shares the query: a body can
        // spell anything. A query with no body is a record, or bookkeeping.
        .map((q) => (q.includes(LEDGER_RECORD_SEPARATOR) ? q.slice(bodyOf(q).length) : q))
        .filter((q) => LEDGER_RECORD.test(q))
        .map((q) => {
          const m = /values \('(\d{14})', '([^']*)', ARRAY/.exec(q);
          return { version: m?.[1], name: m?.[2] };
        }),
  };
}
