/**
 * A migration and its ledger record, in one request — driven through the
 * replay itself, against a Management API that records every query, so what is
 * asserted is what a clone would have been SENT. The rule and its exceptions
 * are `migrationRecordRequest.pure.ts`'s.
 *
 * And the cursor the replay discards when the clone's ledger already records
 * the version it points into, which is the same lane's other half-applied
 * state (`docs/DELIVERY_SYSTEM_PLAN.md`, W7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyPrimeMigrations } from "./backend-provisioning.server";
import {
  LEDGER_RECORD_SEPARATOR,
  bodyWithLedgerRecord,
  transactionBlockRefusal,
} from "./migrationRecordRequest.pure";
import {
  LEDGER_RECORD,
  bodyOf,
  recordingManagementApi,
} from "./managementApiRecorder.test-support";

const REF = "abcdefghijklmnopqrst";

type File = { id: string; name: string; sql: string };

const A: File = {
  id: "20260101000000",
  name: "20260101000000_alpha.sql",
  sql: "create table public.alpha (id int);",
};
const B: File = {
  id: "20260102000000",
  name: "20260102000000_bravo.sql",
  sql: "create table public.bravo (id int);",
};
const C: File = {
  id: "20260103000000",
  name: "20260103000000_charlie.sql",
  sql: "create table public.charlie (id int);",
};

/** The recording API, installed as `fetch` for this test. */
function managementApi(opts?: Parameters<typeof recordingManagementApi>[0]) {
  const api = recordingManagementApi(opts);
  vi.stubGlobal("fetch", vi.fn(api.fetch));
  return api;
}

/** The queries that carry a migration body: everything but the replay's reads and the sweep. */
const bodyRequests = (api: ReturnType<typeof managementApi>, files: readonly File[]) =>
  api.sent.filter((q) => files.some((f) => bodyOf(q) === f.sql));

beforeEach(() => {
  vi.stubEnv("SB_MGMT_API_TOKEN", "test-token");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bodyWithLedgerRecord", () => {
  it("puts the record after the body's own bytes, never inside them", () => {
    const out = bodyWithLedgerRecord(A.sql, "insert into x values (1);");
    expect(out).toEqual({
      together: true,
      sql: `${A.sql}${LEDGER_RECORD_SEPARATOR}insert into x values (1);`,
    });
  });

  it("closes a body that ends on a line comment and no terminator", () => {
    // Without the leading newline the record would be inside the comment, and
    // without the `;` it would be part of the body's last statement.
    expect(LEDGER_RECORD_SEPARATOR.startsWith("\n;\n")).toBe(true);
    const body = "create table public.delta (id int) -- the last line";
    const out = bodyWithLedgerRecord(body, "select 1;");
    expect(out.together && out.sql.split("\n")[1]).toBe(";");
  });

  it("joins a body that commits its own transaction, after its COMMIT", () => {
    const wrapped = "BEGIN;\ncreate table public.echo (id int);\nCOMMIT;";
    const out = bodyWithLedgerRecord(wrapped, "select 1;");
    expect(out.together).toBe(true);
    expect(out.together && out.sql.startsWith(wrapped)).toBe(true);
  });

  it("joins a function body, whose BEGIN and END are PL/pgSQL", () => {
    const fn =
      "create function public.f() returns void language plpgsql as $$ begin perform 1; end; $$;";
    expect(bodyWithLedgerRecord(fn, "select 1;").together).toBe(true);
  });

  it.each([
    ["create index concurrently foxtrot_idx on public.foxtrot (id);", "concurrently"],
    ["DROP INDEX CONCURRENTLY public.foxtrot_idx;", "concurrently"],
    ["vacuum analyze public.foxtrot;", "vacuum"],
    ["reindex table public.foxtrot;", "reindex"],
    ["cluster public.foxtrot using foxtrot_pkey;", "cluster"],
    ["alter system set work_mem = '64MB';", "alter system"],
    ["create  database golf;", "create database"],
    ["create tablespace hotel location '/x';", "tablespace"],
    ["drop subscription india;", "drop subscription"],
    ["discard all;", "discard all"],
    ["commit prepared 'juliet';", "commit prepared"],
  ])("keeps two requests for %s", (body, phrase) => {
    expect(transactionBlockRefusal(body)).toBe(phrase);
    const out = bodyWithLedgerRecord(body, "select 1;");
    expect(out.together).toBe(false);
    expect(!out.together && out.why).toContain(phrase);
  });

  it("reads the raw text, so a comment naming one keeps two requests too", () => {
    // Wrong in the safe direction only: two requests is today's behaviour.
    expect(transactionBlockRefusal("-- run vacuum by hand afterwards\nselect 1;")).toBe("vacuum");
  });

  it("is not fooled by a word that merely contains one", () => {
    expect(transactionBlockRefusal("create table public.agent_subscription (id int);")).toBeNull();
    expect(
      transactionBlockRefusal("alter type public.t add value if not exists 'kilo';"),
    ).toBeNull();
  });
});

describe("applyPrimeMigrations — a migration is applied and recorded in one request", () => {
  it("sends one request per file, each carrying its own record and nobody else's", async () => {
    const api = managementApi();

    const out = await applyPrimeMigrations(REF, [A, B, C]);

    expect(out.results.map((r) => [r.name, r.success])).toEqual([
      [A.name, true],
      [B.name, true],
      [C.name, true],
    ]);
    const requests = bodyRequests(api, [A, B, C]);
    expect(requests).toHaveLength(3);
    requests.forEach((q, i) => {
      const file = [A, B, C][i];
      const record = q.slice(file.sql.length);
      expect(record.startsWith(LEDGER_RECORD_SEPARATOR)).toBe(true);
      expect(record).toMatch(LEDGER_RECORD);
      expect(record).toContain(`'${file.id}'`);
      expect(record).toMatch(/insert into aurixa\.schema_migrations/);
      expect(record).toMatch(/insert into aurixa\.migration_provenance/);
    });
    // No record travelled on its own, so no pass can end between a body and it.
    expect(api.sent.filter((q) => LEDGER_RECORD.test(q))).toEqual(requests);
    expect(api.recorded()).toEqual([
      { version: A.id, name: A.name },
      { version: B.id, name: B.name },
      { version: C.id, name: C.name },
    ]);
  });

  it("records nothing for a body the clone refuses, and halts there", async () => {
    const api = managementApi({ refuse: (q) => bodyOf(q) === B.sql });

    const out = await applyPrimeMigrations(REF, [A, B, C]);

    expect(api.recorded()).toEqual([{ version: A.id, name: A.name }]);
    expect(out.results.find((r) => !r.success)?.name).toBe(B.name);
    expect(api.sent.some((q) => q.includes("charlie"))).toBe(false);
    expect(out.latestApplied).toBe(A.id);
  });

  it("sends a body that may refuse a transaction block alone, then its record", async () => {
    const index: File = {
      id: "20260104000000",
      name: "20260104000000_index.sql",
      sql: "create index concurrently alpha_id_idx on public.alpha (id);",
    };
    const api = managementApi();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const out = await applyPrimeMigrations(REF, [index]);

    expect(out.results[0].success).toBe(true);
    const at = api.sent.indexOf(index.sql);
    expect(at).toBeGreaterThan(-1);
    expect(api.sent[at + 1]).toMatch(LEDGER_RECORD);
    expect(api.sent[at + 1]).toContain(`'${index.id}'`);
    expect(api.sent[at + 1]).not.toContain(LEDGER_RECORD_SEPARATOR);
    expect(api.recorded()).toEqual([{ version: index.id, name: index.name }]);
    expect(info).toHaveBeenCalledWith(
      "[migrations] a body and its record go in two requests",
      expect.objectContaining({ version: index.id }),
    );
    info.mockRestore();
  });

  it("sends a file wrapped in its own transaction byte for byte, with the record after its COMMIT", async () => {
    const wrapped: File = {
      id: "20260105000000",
      name: "20260105000000_wrapped.sql",
      sql: "BEGIN;\ncreate table public.wrapped (id int);\nCOMMIT;\n",
    };
    const api = managementApi();

    await applyPrimeMigrations(REF, [wrapped]);

    const requests = bodyRequests(api, [wrapped]);
    expect(requests).toHaveLength(1);
    expect(requests[0].startsWith(wrapped.sql)).toBe(true);
    expect(requests[0].slice(wrapped.sql.length)).toMatch(LEDGER_RECORD);
  });
});

describe("applyPrimeMigrations — a cursor the clone's ledger has passed is discarded", () => {
  const oversize = (migrationId: string) => ({
    streamSql: async () => {
      throw new Error("no seed is streamed by a pass that has nothing to send");
    },
    cursor: { migrationId, statementsDone: 47 },
  });

  it("says discard when the ledger records the version the cursor points into", async () => {
    managementApi({ applied: [A.id, B.id], tables: 10 });

    const out = await applyPrimeMigrations(
      REF,
      [A, B],
      undefined,
      undefined,
      undefined,
      undefined,
      oversize(A.id),
    );

    expect(out.chunkCursorDiscarded).toBe(true);
    expect(out.chunkCursor).toBeNull();
    expect(out.results.every((r) => r.success && r.skipped)).toBe(true);
  });

  it("keeps a cursor into a version the ledger does not hold", async () => {
    managementApi({ applied: [A.id], tables: 10 });

    const out = await applyPrimeMigrations(
      REF,
      [A],
      undefined,
      undefined,
      undefined,
      undefined,
      oversize(B.id),
    );

    expect(out.chunkCursorDiscarded).toBe(false);
  });

  it("says nothing about a cursor nobody passed", async () => {
    managementApi({ applied: [A.id], tables: 10 });

    const out = await applyPrimeMigrations(REF, [A]);

    expect(out.chunkCursorDiscarded).toBe(false);
  });
});
