/**
 * A shared version, driven through the replay itself.
 *
 * The contract tests around `applyPrimeMigrations` read its SOURCE. These run
 * it, against a Management API that answers the replay's three reads and
 * records every query it is sent — so what they assert is what a clone would
 * have been SENT and what its ledger would have been told, which is the one
 * thing a pin on the source cannot see. See `sharedVersionDelivery.pure.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPrimeMigrations } from "./backend-provisioning.server";
import { readCloneMigrationStanding } from "./cloneMigrationStanding.pure";
import { OversizedMigrationError, PrimeBodyUnavailableError } from "./oversizedMigration.pure";
import { MAX_MIGRATION_BYTES } from "./prime-backend.server";
import { SHARED_VERSION_SEPARATOR } from "./sharedVersionDelivery.pure";

const REF = "abcdefghijklmnopqrst";

type File = { id: string; name: string; sql?: string };

const A: File = {
  id: "20260101000000",
  name: "20260101000000_alpha.sql",
  sql: "create table public.alpha (id int);",
};
const B1: File = {
  id: "20260102000000",
  name: "20260102000000_bravo_one.sql",
  sql: "create table public.bravo_one (id int);",
};
const B2: File = {
  id: "20260102000000",
  name: "20260102000000_bravo_two.sql",
  // No terminator, and a trailing comment: the separator has to close both.
  sql: "create table public.bravo_two (id int) -- the last line",
};
const C: File = {
  id: "20260103000000",
  name: "20260103000000_charlie.sql",
  sql: "create table public.charlie (id int);",
};

const SHARED_NAME = `${B1.name} + ${B2.name}`;
const SHARED_SQL = `${B1.sql}${SHARED_VERSION_SEPARATOR}${B2.sql}`;

/** Metadata alone, as the scoped callers hand the corpus. */
const meta = (f: File) => ({ id: f.id, name: f.name });

const LEDGER_READ = /select version from supabase_migrations\.schema_migrations\s+union/i;
const TABLE_COUNT = /from pg_tables/i;
const TRACKING = /create schema if not exists supabase_migrations/i;
const RECORD = /insert into supabase_migrations\.schema_migrations/i;

/**
 * A Management API that answers the replay's reads and records the rest.
 *
 * `refuse` answers a query with the 400 a clone's schema gives a statement it
 * rejects, so a failure is the replay's own path rather than a thrown stub.
 */
function managementApi(
  opts: { applied?: string[]; tables?: number; refuse?: (query: string) => boolean } = {},
) {
  const sent: string[] = [];
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      sent.push(query);
      if (opts.refuse?.(query)) return new Response("ERROR: 42P07", { status: 400 });
      if (LEDGER_READ.test(query))
        return answer((opts.applied ?? []).map((version) => ({ version })));
      if (TABLE_COUNT.test(query)) return answer([{ n: opts.tables ?? 0 }]);
      return answer([]);
    }),
  );
  const bookkeeping = (q: string) =>
    TRACKING.test(q) || LEDGER_READ.test(q) || TABLE_COUNT.test(q) || RECORD.test(q);
  return {
    sent,
    /** Every migration body the clone was sent, in order. */
    bodies: () => sent.filter((q) => !bookkeeping(q)),
    /** Every version the ledger was told, and the name it was told it under. */
    recorded: () =>
      sent
        .filter((q) => RECORD.test(q))
        .map((q) => {
          const m = /values \('(\d{14})', '([^']*)', ARRAY/.exec(q);
          return { version: m?.[1], name: m?.[2] };
        }),
  };
}

beforeEach(() => {
  vi.stubEnv("SB_MGMT_API_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("applyPrimeMigrations — a shared version travels whole", () => {
  it("sends every file at a shared version in ONE request, then records the version once, naming each", async () => {
    const api = managementApi();

    const out = await applyPrimeMigrations(REF, [A, B1, B2, C]);

    expect(api.bodies()).toEqual([A.sql, SHARED_SQL, C.sql]);
    expect(api.recorded()).toEqual([
      { version: A.id, name: A.name },
      { version: B1.id, name: SHARED_NAME },
      { version: C.id, name: C.name },
    ]);
    // Recorded AFTER the request that ran both — never after the first file.
    expect(api.sent.indexOf(SHARED_SQL)).toBeLessThan(
      api.sent.findIndex((q) => RECORD.test(q) && q.includes(`'${B1.id}'`)),
    );
    // Neither file ever travelled alone.
    expect(api.sent).not.toContain(B1.sql);
    expect(api.sent).not.toContain(B2.sql);
    expect(out.results.map((r) => [r.name, r.success, r.skipped ?? false])).toEqual([
      [A.name, true, false],
      [B1.name, true, false],
      [B2.name, true, false],
      [C.name, true, false],
    ]);
    expect(out.results[1].sharedVersion).toEqual([B1.name, B2.name]);
    expect(out.results[2].sharedVersion).toEqual([B1.name, B2.name]);
    expect(out.latestApplied).toBe(C.id);
    expect(out.stoppedEarly).toBe(false);
  });

  it("writes one name to all three ledgers, and it is the name the standing reads each file from", async () => {
    const api = managementApi();

    await applyPrimeMigrations(REF, [B1, B2]);

    const record = api.sent.find((q) => RECORD.test(q)) ?? "";
    expect(record).toMatch(/insert into aurixa\.schema_migrations/);
    expect(record).toMatch(/insert into aurixa\.migration_provenance/);
    expect(record.split(`'${SHARED_NAME}'`).length - 1).toBe(3);

    // The row that record writes, read back by the page that says what a
    // clone is owed: both files are applied, and neither is a shared-version
    // puzzle, because the name says which ran — both did.
    const standing = readCloneMigrationStanding({
      runnable: [meta(B1), meta(B2)],
      ledger: [{ version: B1.id, name: SHARED_NAME }],
      recordedVersion: null,
    });
    expect(standing.pending).toEqual([]);
    expect(standing.sharedVersions).toEqual([]);
    expect(standing.appliedVersionCount).toBe(1);
  });

  it("sends a version one file carries byte for byte, exactly as it always did", async () => {
    const lone: File = {
      id: "20260104000000",
      name: "20260104000000_delta.sql",
      sql: "select 1 -- no terminator",
    };
    const api = managementApi();

    await applyPrimeMigrations(REF, [lone]);

    expect(api.bodies()).toEqual([lone.sql]);
    expect(api.recorded()).toEqual([{ version: lone.id, name: lone.name }]);
  });

  it("skips every file at a version the clone already records, and sends none of them", async () => {
    const api = managementApi({ applied: [A.id, B1.id], tables: 12 });

    const out = await applyPrimeMigrations(REF, [A, B1, B2, C]);

    expect(api.bodies()).toEqual([C.sql]);
    expect(api.recorded()).toEqual([{ version: C.id, name: C.name }]);
    expect(out.results.filter((r) => r.skipped).map((r) => r.name)).toEqual([
      A.name,
      B1.name,
      B2.name,
    ]);
  });

  it("reads each sibling's OWN body through the loader, by file", async () => {
    const api = managementApi();
    const bodies = new Map([B1, B2].map((f) => [f.name, f.sql as string]));
    const loadSql = vi.fn(async (m: { id: string; name: string }) => {
      const sql = bodies.get(m.name);
      if (sql === undefined) throw new Error(`no body for ${m.name}`);
      return sql;
    });

    await applyPrimeMigrations(REF, [meta(B1), meta(B2)], undefined, loadSql);

    expect(loadSql.mock.calls.map(([m]) => m.name)).toEqual([B1.name, B2.name]);
    expect(api.bodies()).toEqual([SHARED_SQL]);
  });
});

describe("applyPrimeMigrations — a shared version that cannot travel whole is held", () => {
  it("holds a version the corpus carries in a file the replay was not handed, and sends nothing at it", async () => {
    const api = managementApi();
    const scope = {
      corpus: [A, B1, B2, C].map(meta),
      // A caller that cleared the VERSION on the strength of one file — the
      // defect `wholeRunnableVersions` closes — and handed the replay only it.
      runnableIds: new Set([A.id, B1.id, C.id]),
    };

    const out = await applyPrimeMigrations(REF, [A, B1, C], undefined, undefined, scope);

    expect(api.bodies()).toEqual([A.sql]);
    expect(api.recorded()).toEqual([{ version: A.id, name: A.name }]);
    const held = out.results.find((r) => r.heldByRule);
    expect(held?.name).toBe(B1.name);
    expect(held?.success).toBe(false);
    expect(held?.heldByRule?.rule).toBe("shared_version");
    expect(held?.heldByRule?.detail).toContain(`only 1 was cleared to send here (${B1.name})`);
    expect(held?.heldByRule?.detail).toContain(`${B2.name} was not`);
    expect(held?.sharedVersion).toEqual([B1.name, B2.name]);
    // It HALTS: the version after it would run against a schema missing it.
    expect(api.sent.some((q) => q.includes("charlie"))).toBe(false);
    expect(out.latestApplied).toBe(A.id);
  });

  it("holds a version whose sibling is too large to hold, before anything at it is sent — and never hands the sibling to the chunking lane", async () => {
    const api = managementApi();
    const streamSql = vi.fn(async () => {
      throw new Error("the chunking lane must not be reached for part of a version");
    });
    const loadSql = vi.fn(async (m: { id: string; name: string }) => {
      if (m.name === B2.name)
        throw new OversizedMigrationError(B2.name, 41_600_000, MAX_MIGRATION_BYTES);
      return B1.sql as string;
    });

    const out = await applyPrimeMigrations(
      REF,
      [A, meta(B1), meta(B2), C],
      undefined,
      loadSql,
      undefined,
      undefined,
      { streamSql },
    );

    expect(api.bodies()).toEqual([A.sql]);
    expect(api.recorded()).toEqual([{ version: A.id, name: A.name }]);
    expect(streamSql).not.toHaveBeenCalled();
    const held = out.results.find((r) => r.heldByRule);
    expect(held?.heldByRule?.detail).toContain(`${B2.name} is too large to travel`);
    // A hold by rule, not the oversize hold the chunking lane answers.
    expect(held?.heldOversize).toBeUndefined();
    expect(out.results.some((r) => r.name === C.name)).toBe(false);
  });

  it("holds a version whose files are each under the ceiling and together past it, naming neither alone", async () => {
    const api = managementApi();
    const half = Math.floor(MAX_MIGRATION_BYTES / 2) + 1024;
    const big1: File = { ...B1, sql: `-- ${"x".repeat(half)}\nselect 1;` };
    const big2: File = { ...B2, sql: `-- ${"y".repeat(half)}\nselect 2;` };

    const out = await applyPrimeMigrations(REF, [A, big1, big2, C]);

    expect(api.bodies()).toEqual([A.sql]);
    const held = out.results.find((r) => r.heldByRule);
    expect(held?.heldByRule?.detail).toContain("together they are too large to travel");
    expect(held?.sharedVersion).toEqual([B1.name, B2.name]);
  });

  it("waits, rather than fails, when an upstream would not serve a sibling's body", async () => {
    const api = managementApi();
    const loadSql = vi.fn(async (m: { id: string; name: string }) => {
      if (m.name === B2.name) throw new PrimeBodyUnavailableError(B2.name, "rate limited", 403);
      return B1.sql as string;
    });

    const out = await applyPrimeMigrations(REF, [meta(B1), meta(B2)], undefined, loadSql);

    expect(api.bodies()).toEqual([]);
    expect(api.recorded()).toEqual([]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].heldUpstreamLimited).toBe(true);
    expect(out.results[0].heldByRule).toBeUndefined();
  });
});

describe("applyPrimeMigrations — a shared version is one migration to a failure and a budget", () => {
  it("leaves the version unrecorded when the request fails, names every file sent, and halts", async () => {
    const api = managementApi({ refuse: (q) => q === SHARED_SQL });

    const out = await applyPrimeMigrations(REF, [A, B1, B2, C]);

    expect(api.recorded()).toEqual([{ version: A.id, name: A.name }]);
    const failed = out.results.find((r) => !r.success);
    expect(failed?.name).toBe(B1.name);
    expect(failed?.heldByRule).toBeUndefined();
    expect(failed?.error).toContain(
      `[sent as one request with every file at version ${B1.id}: ${SHARED_NAME}]`,
    );
    expect(api.sent.some((q) => q.includes("charlie"))).toBe(false);
    expect(out.latestApplied).toBe(A.id);
  });

  it("never stops between two files of a version: a spent budget still lands the whole version it began", async () => {
    const api = managementApi();
    const budget = { isPastDeadline: vi.fn(() => true) };

    const out = await applyPrimeMigrations(
      REF,
      [B1, B2, C],
      undefined,
      undefined,
      undefined,
      budget,
    );

    expect(api.bodies()).toEqual([SHARED_SQL]);
    expect(api.recorded()).toEqual([{ version: B1.id, name: SHARED_NAME }]);
    expect(out.stoppedEarly).toBe(true);
    // Asked once, before the version after it — never between its files.
    expect(budget.isPastDeadline).toHaveBeenCalledTimes(1);
  });

  it("stops BEFORE a shared version when the budget is spent, sending none of its files", async () => {
    const api = managementApi();

    const out = await applyPrimeMigrations(REF, [A, B1, B2], undefined, undefined, undefined, {
      isPastDeadline: () => true,
    });

    expect(api.bodies()).toEqual([A.sql]);
    expect(api.recorded()).toEqual([{ version: A.id, name: A.name }]);
    expect(out.stoppedEarly).toBe(true);
    expect(out.results.map((r) => r.name)).toEqual([A.name]);
  });
});
