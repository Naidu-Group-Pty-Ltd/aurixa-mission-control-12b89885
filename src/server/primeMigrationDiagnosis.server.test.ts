/**
 * The trial run, exercised — because the property that matters is what is SENT
 * to the prime, and no amount of reading the source proves that.
 *
 * One rule carries this feature: a body that manages its own transaction must
 * never be wrapped in `BEGIN … ROLLBACK` and sent, because its own `COMMIT`
 * would end that transaction and make everything before it permanent. A "test"
 * that writes to the prime's production database is the worst failure this
 * surface can have, and it would look exactly like a success.
 *
 * So every statement the module sends is captured, and the assertions are
 * about that transcript rather than about a verdict. A verdict is a thing this
 * module computed; the transcript is a thing the database would have seen.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

const PRIME_REF = "dduzbchuswwbefdunfct";

const state = vi.hoisted(() => ({
  /** Every `${ref}::${sql}` the module sent, in order. */
  ran: [] as string[],
  respond: null as null | ((ref: string, sql: string) => unknown),
  /** Statements that should throw, matched as a substring. */
  failOn: null as null | { needle: string; error: string },
  files: [] as Array<{ id: string; name: string; path: string }>,
  /** Bodies by FILE name, as the corpus keys them: a shared version is two bodies. */
  bodies: new Map<string, string>(),
  /** Every file whose body was read, in order. */
  loaded: [] as string[],
  loadThrows: null as null | Error,
  sourceNull: false,
  backendThrows: false,
  /** Files the prime's MIGRATION_WITHDRAWN.json takes out of the corpus. */
  withdrawn: [] as Array<{ id: string; name: string; path: string }>,
}));

vi.mock("./github-app.server", () => ({ getAppOctokit: () => ({}) }));

vi.mock("./prime-backend.server", () => ({
  resolvePrimeSource: async () =>
    state.sourceNull
      ? null
      : { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" },
  resolvePrimeBackendRef: async () => {
    if (state.backendThrows) throw new Error("no prime backend is configured");
    return PRIME_REF;
  },
  openPrimeMigrationCorpus: async () => ({
    metas: state.files,
    sourceSha: "abc1234",
    withdrawal: {
      state: state.withdrawn.length > 0 ? "read" : "absent",
      excluded: state.withdrawn,
      unmatched: [],
    },
    loadSql: async (ref: string | { name: string }) => {
      if (state.loadThrows) throw state.loadThrows;
      const name = typeof ref === "string" ? state.files.find((f) => f.id === ref)?.name : ref.name;
      state.loaded.push(name ?? String(ref));
      const sql = name === undefined ? undefined : state.bodies.get(name);
      if (sql === undefined) throw new Error(`no body for ${name ?? String(ref)}`);
      return sql;
    },
  }),
}));

vi.mock("./backend-provisioning.server", () => ({
  runSqlOnProject: async (ref: string, sql: string) => {
    state.ran.push(`${ref}::${sql}`);
    if (state.failOn && sql.includes(state.failOn.needle)) {
      throw new Error(`SQL execution failed on ${ref}: 400 — ${state.failOn.error}`);
    }
    return state.respond ? state.respond(ref, sql) : [];
  },
}));

import { diagnosePrimeMigration, wrapForDryRun } from "./primeMigrationDiagnosis.server";

const LEDGER = "select version from supabase_migrations.schema_migrations";
const CATALOGUE = "pg_namespace";

/** Every statement that is neither the ledger read nor the catalogue read. */
const trialRuns = () =>
  state.ran
    .map((r) => r.slice(PRIME_REF.length + 2))
    .filter((sql) => sql !== LEDGER && !sql.includes(CATALOGUE));

function corpus(...entries: Array<[string, string, string]>) {
  state.files = entries.map(([id, name]) => ({
    id,
    name,
    path: `supabase/migrations/${name}`,
  }));
  state.bodies = new Map(entries.map(([, name, sql]) => [name, sql]));
}

/** The prime's ledger answers with these versions. */
function ledgerHolds(...versions: string[]) {
  state.respond = (_ref, sql) => {
    if (sql === LEDGER) return versions.map((version) => ({ version }));
    if (sql.includes(CATALOGUE)) return [{ o: "table:public.existing" }];
    return [];
  };
}

beforeEach(() => {
  state.withdrawn = [];
  state.ran = [];
  state.respond = null;
  state.failOn = null;
  state.files = [];
  state.bodies = new Map();
  state.loaded = [];
  state.loadThrows = null;
  state.sourceNull = false;
  state.backendThrows = false;
});

describe("the wrapper always ends the transaction", () => {
  it("opens, bounds itself on both clocks, and rolls back", () => {
    const w = wrapForDryRun("create table t (id int);");
    expect(w.startsWith("begin;")).toBe(true);
    expect(w).toContain("set local lock_timeout");
    expect(w).toContain("set local statement_timeout");
    expect(w.trimEnd().endsWith("rollback;")).toBe(true);
  });

  it("rolls back a body whose last statement carries no semicolon", () => {
    // Without the computed separator the body would run straight into the
    // word `rollback` and the transaction would never end.
    const w = wrapForDryRun("select 1");
    expect(w.trimEnd().endsWith("rollback;")).toBe(true);
    expect(w).toContain("select 1;\nrollback;");
  });

  it("both timeouts are SET LOCAL, so neither outlives the rollback", () => {
    // The connection is pooled. A session-level timeout left behind would
    // reach whoever the pool hands it to next.
    for (const line of wrapForDryRun("select 1").split("\n")) {
      if (line.includes("timeout")) expect(line).toMatch(/^set local /);
    }
  });
});

describe("a body that manages its own transaction is never sent", () => {
  it("does not reach the database at all, and says why", async () => {
    corpus([
      "20260901010000",
      "20260901010000_fix.sql",
      "begin;\ncreate table t (id int);\ncommit;",
    ]);
    ledgerHolds("20260101010000");

    const { diagnosis } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(diagnosis.verdict).toBe("unsafe_to_test");
    expect(trialRuns()).toEqual([]);
    // And the giveaway, asserted directly: nothing carrying the body was sent.
    expect(state.ran.some((r) => r.includes("create table t"))).toBe(false);
  });

  it("the same is true of CREATE INDEX CONCURRENTLY", async () => {
    corpus(["20260901010000", "20260901010000_i.sql", "create index concurrently i on t (a);"]);
    ledgerHolds("20260101010000");
    const { diagnosis } = await diagnosePrimeMigration({} as never, "20260901010000");
    expect(diagnosis.verdict).toBe("unsafe_to_test");
    expect(trialRuns()).toEqual([]);
  });
});

describe("a body that can be tried, is — wrapped", () => {
  it("sends it exactly once, inside the wrapper", async () => {
    corpus([
      "20260901010000",
      "20260901010000_t.sql",
      "create table if not exists public.t (id int);",
    ]);
    ledgerHolds("20260101010000");

    const { diagnosis } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(diagnosis.verdict).toBe("ready");
    expect(diagnosis.dispatchable).toBe(true);
    const runs = trialRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toBe(wrapForDryRun("create table if not exists public.t (id int);"));
  });

  it("a failure names the code and refuses the act", async () => {
    corpus(["20260901010000", "20260901010000_t.sql", "create table public.t (id int);"]);
    ledgerHolds("20260101010000");
    state.failOn = {
      needle: "create table public.t",
      error: '{"code":"42P07","message":"relation \\"t\\" already exists"}',
    };

    const { diagnosis } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(diagnosis.verdict).toBe("would_fail");
    expect(diagnosis.dispatchable).toBe(false);
    expect(diagnosis.headline).toContain("42P07");
  });
});

describe("nothing is tried that has a cheaper answer", () => {
  it("a version the prime has already run is not re-sent", async () => {
    corpus(["20260901010000", "20260901010000_t.sql", "create table t (id int);"]);
    ledgerHolds("20260901010000");

    const { diagnosis } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(diagnosis.verdict).toBe("already_applied");
    expect(trialRuns()).toEqual([]);
  });

  it("a version sitting behind a hole is not sent, so the failure cannot be misattributed", async () => {
    corpus(
      ["20260801010000", "20260801010000_first.sql", "create table a (id int);"],
      ["20260901010000", "20260901010000_second.sql", "create table b (id int);"],
    );
    // The prime has run neither, so the first one is a hole in front of the second.
    ledgerHolds("20260101010000");

    const { diagnosis } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(diagnosis.verdict).toBe("blocked_by_prerequisite");
    expect(diagnosis.blockedBy).toEqual(["20260801010000"]);
    expect(trialRuns()).toEqual([]);
  });

  it("an EMPTY ledger is a refusal, not a prime that has run nothing", async () => {
    // `assertPrimeLedgerUsable`'s rule, restated where it bites: with no
    // authority, every file in the tree reads as a hole.
    corpus(["20260901010000", "20260901010000_t.sql", "create table t (id int);"]);
    ledgerHolds();

    const { diagnosis } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(diagnosis.verdict).toBe("undiagnosed");
    expect(diagnosis.blockedBy).toBeNull();
    expect(trialRuns()).toEqual([]);
  });

  it("a body too large for one request is not sent, and the reason names the transport", async () => {
    // Above the ceiling a request-size refusal would read back as
    // `would_fail` — this module blaming a file for our own plumbing.
    corpus([
      "20260901010000",
      "20260901010000_seed.sql",
      `insert into t (a) values ('${"x".repeat(1024 * 1024 + 10)}') on conflict do nothing;`,
    ]);
    ledgerHolds("20260101010000");

    const { diagnosis } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(diagnosis.verdict).toBe("undiagnosed");
    expect(diagnosis.headline).toMatch(/larger than this console will send/);
    expect(trialRuns()).toEqual([]);
  });

  it("a body nobody could read is undiagnosed, and nothing is sent", async () => {
    corpus(["20260901010000", "20260901010000_t.sql", "create table t (id int);"]);
    ledgerHolds("20260101010000");
    state.loadThrows = new Error("GitHub answered 403");

    const { diagnosis } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(diagnosis.verdict).toBe("undiagnosed");
    expect(diagnosis.statementCount).toBeNull();
    expect(trialRuns()).toEqual([]);
  });
});

describe("what it refuses to answer at all", () => {
  it("no prime repository is an error, not an empty diagnosis", async () => {
    state.sourceNull = true;
    await expect(diagnosePrimeMigration({} as never, "20260901010000")).rejects.toThrow(
      /No prime repository is configured/,
    );
  });

  it("a version that is not in the tree is an error naming the repository", async () => {
    corpus(["20260801010000", "20260801010000_a.sql", "select 1;"]);
    ledgerHolds("20260801010000");
    await expect(diagnosePrimeMigration({} as never, "20260901010000")).rejects.toThrow(
      /npc-property-dashbord/,
    );
  });

  it("a withdrawn version is refused with the declaration, not as a missing file", async () => {
    corpus(["20260801010000", "20260801010000_a.sql", "select 1;"]);
    ledgerHolds("20260801010000");
    state.withdrawn = [
      {
        id: "20260728120000",
        name: "20260728120000_aml_verification_checks.sql",
        path: "supabase/migrations/20260728120000_aml_verification_checks.sql",
      },
    ];
    const attempt = diagnosePrimeMigration({} as never, "20260728120000");
    await expect(attempt).rejects.toThrow(
      /20260728120000_aml_verification_checks\.sql is declared withdrawn/,
    );
    await expect(diagnosePrimeMigration({} as never, "20260728120000")).rejects.not.toThrow(
      /No migration with version/,
    );
    // Nothing was sent anywhere to reach that answer.
    expect(state.ran).toEqual([]);
  });

  it("an unreachable prime backend still reads the file and says the run did not happen", async () => {
    corpus(["20260901010000", "20260901010000_t.sql", "create table t (id int);"]);
    state.backendThrows = true;

    const { diagnosis, primeRef } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(primeRef).toBeNull();
    expect(diagnosis.verdict).toBe("undiagnosed");
    expect(diagnosis.dryRun.ran).toBe(false);
    expect(trialRuns()).toEqual([]);
  });
});

describe("nothing is sent for a file whose answer the FILE already settles", () => {
  it("an undo is never sent, not even inside a transaction that rolls back", async () => {
    corpus([
      "20260901010000",
      "20260901010000_rollback_client_data_rls_policies.sql",
      "drop policy if exists p on t;",
    ]);
    ledgerHolds("20260101010000");

    const { diagnosis } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(diagnosis.verdict).toBe("rollback_script");
    expect(diagnosis.dispatchable).toBe(false);
    expect(trialRuns()).toEqual([]);
  });
});

describe("the collision survey rides every report", () => {
  it("names both files on a repeated version, and diagnoses the pair as one", async () => {
    corpus(
      ["20260901010000", "20260901010000_a.sql", "select 1;"],
      ["20260901010000", "20260901010000_b.sql", "select 2;"],
    );
    ledgerHolds("20260101010000");

    const { diagnosis, collisions } = await diagnosePrimeMigration({} as never, "20260901010000");

    expect(collisions).toEqual([
      { version: "20260901010000", names: ["20260901010000_a.sql", "20260901010000_b.sql"] },
    ]);
    expect(diagnosis.verdict).toBe("version_collision");
    expect(trialRuns()).toEqual([]);
    // The body read is the file the report names — the first — and never
    // whichever of the pair a lookup by version happened to resolve to.
    expect(state.loaded).toEqual(["20260901010000_a.sql"]);
  });
});
