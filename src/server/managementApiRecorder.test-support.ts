/**
 * A Supabase Management API that answers the replay's reads and records the
 * rest — test support for the behavioural tests of `applyPrimeMigrations`,
 * imported by them and by nothing else.
 *
 * The replay reaches a clone through one endpoint, `database/query`, so what a
 * clone was SENT is exactly the sequence of queries posted there. This
 * answers the three the replay asks before it sends anything — the tracking
 * tables, the ledger union, the table count — and records every query, so a
 * test can assert what reached the clone and what its ledger was told.
 *
 * It does not import the test runner: the caller installs `fetch` itself
 * (`vi.stubGlobal("fetch", api.fetch)`), which keeps this an ordinary module.
 */

const LEDGER_READ = /select version from supabase_migrations\.schema_migrations\s+union/i;
const TABLE_COUNT = /from pg_tables/i;
const TRACKING = /create schema if not exists supabase_migrations/i;

/** The write `recordReplayedVersion` makes after a version has run. */
export const LEDGER_RECORD = /insert into supabase_migrations\.schema_migrations/i;

export type RecordingManagementApi = {
  /** Install as the global `fetch`. */
  fetch: (url: unknown, init?: { body?: unknown }) => Promise<Response>;
  /** Every query posted, in order. */
  sent: string[];
  /** Every migration body the clone was sent, in order: all but bookkeeping. */
  bodies: () => string[];
  /** Every version the ledger was told, and the name it was told it under. */
  recorded: () => Array<{ version: string | undefined; name: string | undefined }>;
};

/**
 * `applied` is the clone's ledger; `tables` its table count, which is what
 * lets a ledger with versions in it pass the pre-flight. `refuse` answers a
 * query with the 400 a clone's schema gives a statement it rejects, so a
 * failure travels the replay's own path rather than a thrown stub's.
 */
export function recordingManagementApi(
  opts: { applied?: string[]; tables?: number; refuse?: (query: string) => boolean } = {},
): RecordingManagementApi {
  const sent: string[] = [];
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const bookkeeping = (q: string) =>
    TRACKING.test(q) || LEDGER_READ.test(q) || TABLE_COUNT.test(q) || LEDGER_RECORD.test(q);
  return {
    sent,
    fetch: async (_url, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      sent.push(query);
      if (opts.refuse?.(query)) return new Response("ERROR: 42P07", { status: 400 });
      if (LEDGER_READ.test(query)) {
        return answer((opts.applied ?? []).map((version) => ({ version })));
      }
      if (TABLE_COUNT.test(query)) return answer([{ n: opts.tables ?? 0 }]);
      return answer([]);
    },
    bodies: () => sent.filter((q) => !bookkeeping(q)),
    recorded: () =>
      sent
        .filter((q) => LEDGER_RECORD.test(q))
        .map((q) => {
          const m = /values \('(\d{14})', '([^']*)', ARRAY/.exec(q);
          return { version: m?.[1], name: m?.[2] };
        }),
  };
}
