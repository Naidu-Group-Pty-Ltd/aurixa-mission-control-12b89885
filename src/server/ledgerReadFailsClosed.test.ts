/**
 * The replay refuses on a ledger it could not read, and sends nothing.
 *
 * ## What this is here to make impossible
 *
 * `applyPrimeMigrations` read the clone's ledger itself and turned any answer
 * it did not recognise into an EMPTY ledger, and its table count turned a
 * failure into 0. Empty and 0 together read as a fresh project, and a fresh
 * project is replayed from the corpus's first file. At a live tenant that is
 * every runnable version from `20250124160000` on. On the 27 Oct 2026 tree the
 * second file re-creates `update_updated_at_column()` as SECURITY DEFINER over
 * today's invoker body, and the replay then halts on an `ADD COLUMN` that is
 * not idempotent, on every clone in one sweep (audit of 27 Oct 2026). The
 * other readers of a clone's ledger already failed closed.
 *
 * Driven through the replay against a Management API double that answers as
 * the endpoint does, so what is asserted is what a clone would have been SENT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPrimeMigrations } from "./backend-provisioning.server";

const REF = "abcdefghijklmnopqrst";

const A = {
  id: "20260101000000",
  name: "20260101000000_alpha.sql",
  sql: "create table public.alpha (id int);",
};
const B = {
  id: "20260102000000",
  name: "20260102000000_bravo.sql",
  sql: "create table public.bravo (id int);",
};

const LEDGER_READ = /from supabase_migrations\.schema_migrations\s+union/i;
const TABLE_COUNT = /from pg_tables/i;
const TRACKING = /create schema if not exists supabase_migrations/i;
/** The schedule read the prime-only sweep makes after a replay sent something. */
const CRON_SWEEP_READ = /select jobid, jobname, command from cron\.job/i;

type Answer = { status?: number; body: unknown };

/** The endpoint, answering the replay's three reads as told and recording everything else. */
function endpoint(opts: { ledger: Answer; tables: Answer }) {
  const bodies: string[] = [];
  const reply = (a: Answer) =>
    new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), {
      status: a.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  const fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (TRACKING.test(query) || CRON_SWEEP_READ.test(query)) return reply({ body: [] });
    if (LEDGER_READ.test(query)) return reply(opts.ledger);
    if (TABLE_COUNT.test(query)) return reply(opts.tables);
    bodies.push(query);
    return reply({ body: [] });
  });
  vi.stubGlobal("fetch", fetch);
  return { bodies };
}

const scope = {
  corpus: [A, B].map((m) => ({ id: m.id, name: m.name })),
  runnableIds: new Set([A.id, B.id]),
};

beforeEach(() => {
  vi.stubEnv("SB_MGMT_API_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("applyPrimeMigrations — a ledger that was not read is not an empty one", () => {
  it("refuses an answer it does not recognise, sending no body", async () => {
    // A 2xx in an envelope the reader does not know: an error object, or a
    // wrapper the endpoint did not use to send.
    const api = endpoint({
      ledger: { body: { data: [{ version: A.id }] } },
      tables: { body: [{ n: 512 }] },
    });
    await expect(applyPrimeMigrations(REF, [A, B], undefined, undefined, scope)).rejects.toThrow(
      /^Migration sync refused: the clone's migration ledger could not be read \(the ledger query returned a shape with no rows in it\)/,
    );
    expect(api.bodies).toEqual([]);
  });

  it("refuses a ledger read the endpoint refused, sending no body", async () => {
    const api = endpoint({
      ledger: { status: 500, body: "upstream timeout" },
      tables: { body: [{ n: 512 }] },
    });
    await expect(applyPrimeMigrations(REF, [A, B], undefined, undefined, scope)).rejects.toThrow(
      /^Migration sync refused: the clone's migration ledger could not be read/,
    );
    expect(api.bodies).toEqual([]);
  });

  it("refuses when the tables could not be counted, sending no body", async () => {
    for (const tables of [
      { status: 500, body: "upstream timeout" },
      { body: { rows: [{ n: 512 }] } },
      { body: [{ n: "many" }] },
    ]) {
      const api = endpoint({ ledger: { body: [] }, tables });
      await expect(applyPrimeMigrations(REF, [A, B])).rejects.toThrow(
        "Migration sync refused: the clone's tables could not be counted, so a fresh project cannot be told from a built one.",
      );
      expect(api.bodies).toEqual([]);
    }
  });

  it("refuses an empty project to a scoped caller, which only serves provisioned clones", async () => {
    const api = endpoint({ ledger: { body: [] }, tables: { body: [{ n: 0 }] } });
    await expect(applyPrimeMigrations(REF, [A, B], undefined, undefined, scope)).rejects.toThrow(
      /^Migration sync refused: the clone reads as an empty project/,
    );
    expect(api.bodies).toEqual([]);
  });

  it("still replays a genuinely fresh project for provisioning, which passes no scope", async () => {
    const api = endpoint({ ledger: { body: [] }, tables: { body: [{ n: 0 }] } });
    const out = await applyPrimeMigrations(REF, [A, B]);
    expect(api.bodies.map((q) => q.split("\n;\n")[0])).toEqual([A.sql, B.sql]);
    expect(out.latestApplied).toBe(B.id);
  });

  it("and syncs a provisioned clone exactly as before", async () => {
    const api = endpoint({
      ledger: { body: [{ version: A.id, name: A.name }] },
      tables: { body: [{ n: 1 }] },
    });
    const out = await applyPrimeMigrations(REF, [A, B], undefined, undefined, scope);
    expect(api.bodies.map((q) => q.split("\n;\n")[0])).toEqual([B.sql]);
    expect(out.latestApplied).toBe(B.id);
  });
});
