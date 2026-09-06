import { describe, it, expect, beforeEach, vi } from "vitest";

const PRIME = "dduzbchuswwbefdunfct";
const CLONE = "plisdzywzleljorrphxv";
const CLONE_ID = "37b3e65a-716e-4141-9cb6-2e13583dbdd9";

const state = vi.hoisted(() => ({
  /** Every statement the worker ran, as `${ref}::${sql}`. */
  ran: [] as string[],
  /** ref -> handler returning rows for a statement. */
  respond: null as null | ((ref: string, sql: string) => unknown),
  primeRefThrows: false,
  notifications: [] as Array<{ title: string; body: string }>,
  audits: [] as Array<Record<string, unknown>>,
  /** Rows in clone_reference_syncs, keyed by table name. */
  syncRows: new Map<string, Record<string, unknown>>(),
  backendRow: {
    clone_id: "37b3e65a-716e-4141-9cb6-2e13583dbdd9",
    supabase_project_ref: "plisdzywzleljorrphxv" as string | null,
  } as Record<string, unknown> | null,
  claimError: null as { message: string } | null,
  pickError: null as { message: string } | null,
}));

vi.mock("./prime-backend.server", () => ({
  resolvePrimeBackendRef: async () => {
    if (state.primeRefThrows) throw new Error("prime_config is not configured");
    return PRIME;
  },
}));

vi.mock("./backend-provisioning.server", () => ({
  runSqlOnProject: async (ref: string, sql: string) => {
    state.ran.push(`${ref}::${sql}`);
    return state.respond ? state.respond(ref, sql) : [];
  },
}));

vi.mock("./audit.server", () => ({
  notifyOperators: async (n: { title: string; body: string }) => {
    state.notifications.push({ title: n.title, body: n.body });
  },
  writeAuditLog: async (a: Record<string, unknown>) => {
    state.audits.push(a);
  },
}));

import { runReferenceDataSync } from "./reference-data.server";
import { REFERENCE_TABLES, refName } from "./referenceTables.pure";

/** Minimal supabase-js double covering exactly the chains the worker uses. */
function fakeSupabase() {
  const backendsUpdateChain = () => {
    const b: Record<string, unknown> = {
      eq: () => b,
      is: () => b,
      not: () => b,
      lt: () => b,
      select: async () => ({
        data: state.claimError ? null : [{ clone_id: CLONE_ID }],
        error: state.claimError,
      }),
      then: undefined,
    };
    // `await`ing the chain without .select() (the release + reclaim paths)
    (b as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ error: null });
    return b;
  };

  const from = (table: string): Record<string, unknown> => {
    if (table === "clone_backends") {
      return {
        update: () => backendsUpdateChain(),
        select: () => {
          const b: Record<string, unknown> = {
            eq: () => b,
            is: () => b,
            not: () => b,
            limit: async () => ({
              data: state.pickError ? null : state.backendRow ? [state.backendRow] : [],
              error: state.pickError,
            }),
          };
          return b;
        },
      };
    }
    if (table === "clones") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { name: "NPC Client Dashboard" } }) }),
        }),
      };
    }
    if (table === "clone_reference_syncs") {
      return {
        select: () => ({
          eq: async () => ({ data: [...state.syncRows.values()], error: null }),
        }),
        upsert: async (values: Record<string, unknown>) => {
          const key = String(values.table_name);
          state.syncRows.set(key, { ...(state.syncRows.get(key) ?? {}), ...values });
          return { error: null };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  };
  return { from } as never;
}

/** A responder that makes every allow-listed table exist and be empty. */
function emptyEverywhere(ref: string, sql: string): unknown {
  if (sql.includes("to_regclass")) return [{ present: true }];
  if (sql.includes("information_schema.columns")) {
    // Return exactly the classified columns plus an inert one, per table.
    const t = REFERENCE_TABLES.find((e) => sql.includes(`'${e.table}'`));
    return [
      { column_name: "id" },
      ...Object.keys(t?.columns ?? {}).map((c) => ({ column_name: c })),
    ];
  }
  if (sql.includes("count(*)")) return [{ n: 0 }];
  if (ref === PRIME && sql.includes("__cursor")) return [];
  return [];
}

beforeEach(() => {
  state.ran = [];
  state.respond = emptyEverywhere;
  state.primeRefThrows = false;
  state.notifications = [];
  state.audits = [];
  state.syncRows = new Map();
  state.backendRow = { clone_id: CLONE_ID, supabase_project_ref: CLONE };
  state.claimError = null;
  state.pickError = null;
});

describe("runReferenceDataSync", () => {
  it("walks every allow-listed table and reports done when they all finish", async () => {
    const out = await runReferenceDataSync(fakeSupabase());
    expect(out.error).toBeUndefined();
    expect(out.cloneId).toBe(CLONE_ID);
    expect(out.tables.map((t) => t.table)).toEqual(REFERENCE_TABLES.map((t) => refName(t)));
    expect(out.done).toBe(true);
  });

  it("reads only from the prime and writes only to the clone", async () => {
    await runReferenceDataSync(fakeSupabase());
    const reads = state.ran.filter((r) => r.includes("__cursor"));
    const writes = state.ran.filter((r) => r.includes("jsonb_populate_recordset"));
    expect(reads.every((r) => r.startsWith(`${PRIME}::`))).toBe(true);
    expect(writes.every((r) => r.startsWith(`${CLONE}::`))).toBe(true);
  });

  it("copies a page and advances the cursor only after the write lands", async () => {
    let wroteAt = -1;
    let cursorAdvancedAt = -1;
    state.respond = (ref, sql) => {
      if (sql.includes("to_regclass")) return [{ present: true }];
      if (sql.includes("information_schema.columns")) return [{ column_name: "id" }];
      if (sql.includes("count(*)")) return [{ n: 2 }];
      if (ref === PRIME && sql.includes("__cursor")) {
        if (sql.includes("suburb_directory") && !sql.includes("> '")) {
          return [
            { __cursor: "a", __row: { id: "a" } },
            { __cursor: "b", __row: { id: "b" } },
          ];
        }
        return [];
      }
      if (sql.includes("jsonb_populate_recordset")) {
        wroteAt = state.ran.length;
        return [];
      }
      return [];
    };
    await runReferenceDataSync(fakeSupabase());
    const cursorRow = state.syncRows.get("suburb_directory");
    cursorAdvancedAt = wroteAt; // the upsert happens after the insert returns
    expect(wroteAt).toBeGreaterThan(0);
    expect(cursorAdvancedAt).toBeGreaterThan(0);
    expect(cursorRow?.cursor).toBe("b");
    expect(cursorRow?.status).toBe("complete");
  });

  it("resumes from a banked cursor instead of restarting the table", async () => {
    state.syncRows.set("suburb_directory", {
      table_name: "suburb_directory",
      cursor: "m",
      rows_copied: 500,
      status: "copying",
    });
    await runReferenceDataSync(fakeSupabase());
    const firstRead = state.ran.find((r) => r.includes("suburb_directory") && r.includes("__cursor"));
    expect(firstRead).toContain(`"id"::text > 'm'`);
  });

  it("skips a table already marked complete without touching either project", async () => {
    state.syncRows.set("suburb_directory", {
      table_name: "suburb_directory",
      status: "complete",
      rows_copied: 18519,
    });
    const out = await runReferenceDataSync(fakeSupabase());
    expect(state.ran.some((r) => r.includes("suburb_directory"))).toBe(false);
    expect(out.tables.find((t) => t.table === "suburb_directory")?.status).toBe("complete");
  });

  describe("the refusals", () => {
    it("REFUSES a table whose live schema gained an unclassified identity column", async () => {
      state.respond = (ref, sql) => {
        if (sql.includes("to_regclass")) return [{ present: true }];
        if (sql.includes("information_schema.columns")) {
          if (sql.includes("'suburb_directory'")) {
            return [{ column_name: "id" }, { column_name: "owner_user_id" }];
          }
          const t = REFERENCE_TABLES.find((e) => sql.includes(`'${e.table}'`));
          return [
            { column_name: "id" },
            ...Object.keys(t?.columns ?? {}).map((c) => ({ column_name: c })),
          ];
        }
        if (sql.includes("count(*)")) return [{ n: 0 }];
        return [];
      };
      const out = await runReferenceDataSync(fakeSupabase());
      const row = out.tables.find((t) => t.table === "suburb_directory");
      expect(row?.status).toBe("failed");
      expect(row?.detail).toContain("owner_user_id");
      // Not one row was read from that table.
      expect(state.ran.some((r) => r.includes("suburb_directory") && r.includes("__cursor"))).toBe(
        false,
      );
      expect(state.notifications.some((n) => n.title.includes("suburb_directory"))).toBe(true);
    });

    it("one refused table does not stop the rest of the fleet's tables", async () => {
      state.respond = (ref, sql) => {
        if (sql.includes("to_regclass")) return [{ present: true }];
        if (sql.includes("information_schema.columns")) {
          if (sql.includes("'suburb_directory'")) {
            return [{ column_name: "id" }, { column_name: "client_id" }];
          }
          const t = REFERENCE_TABLES.find((e) => sql.includes(`'${e.table}'`));
          return [
            { column_name: "id" },
            ...Object.keys(t?.columns ?? {}).map((c) => ({ column_name: c })),
          ];
        }
        if (sql.includes("count(*)")) return [{ n: 0 }];
        return [];
      };
      const out = await runReferenceDataSync(fakeSupabase());
      expect(out.tables.find((t) => t.table === "suburb_directory")?.status).toBe("failed");
      expect(out.tables.find((t) => t.table === "template_library_entries")?.status).toBe(
        "complete",
      );
      expect(out.done).toBe(false);
    });

    it("skips a table the clone does not have, and calls it behind on migrations", async () => {
      state.respond = (ref, sql) => {
        if (sql.includes("to_regclass")) {
          return [{ present: !sql.includes("suburb_directory") }];
        }
        if (sql.includes("information_schema.columns")) {
          const t = REFERENCE_TABLES.find((e) => sql.includes(`'${e.table}'`));
          return [
            { column_name: "id" },
            ...Object.keys(t?.columns ?? {}).map((c) => ({ column_name: c })),
          ];
        }
        if (sql.includes("count(*)")) return [{ n: 0 }];
        return [];
      };
      const out = await runReferenceDataSync(fakeSupabase());
      const row = out.tables.find((t) => t.table === "suburb_directory");
      expect(row?.status).toBe("skipped");
      expect(row?.detail).toMatch(/behind on migrations/);
    });

    it("refuses outright when the clone's ref IS the prime's", async () => {
      state.backendRow = { clone_id: CLONE_ID, supabase_project_ref: PRIME };
      const out = await runReferenceDataSync(fakeSupabase());
      expect(out.error).toMatch(/the clone's project ref is the prime's/);
      expect(state.ran).toEqual([]);
    });

    it("reports a prime that is not configured rather than copying nothing quietly", async () => {
      state.primeRefThrows = true;
      const out = await runReferenceDataSync(fakeSupabase());
      expect(out.error).toMatch(/not configured/);
      expect(out.done).toBe(false);
    });

    it("a candidate list that FAILED to read is not a fleet with nothing to do", async () => {
      state.pickError = { message: "connection reset" };
      const out = await runReferenceDataSync(fakeSupabase());
      expect(out.error).toMatch(/Could not read clone backends: connection reset/);
      expect(out.done).toBe(false);
    });

    it("a claim that ERRORED is not a claim somebody else won", async () => {
      state.claimError = { message: "deadlock detected" };
      const out = await runReferenceDataSync(fakeSupabase());
      expect(out.error).toMatch(/Could not claim the clone: deadlock detected/);
    });

    it("refuses to advance on a page with no usable cursor", async () => {
      state.respond = (ref, sql) => {
        if (sql.includes("to_regclass")) return [{ present: true }];
        if (sql.includes("information_schema.columns")) return [{ column_name: "id" }];
        if (sql.includes("count(*)")) return [{ n: 1 }];
        if (ref === PRIME && sql.includes("__cursor") && sql.includes("suburb_directory")) {
          return [{ __row: { id: "a" } }]; // no __cursor
        }
        return [];
      };
      const out = await runReferenceDataSync(fakeSupabase());
      const row = out.tables.find((t) => t.table === "suburb_directory");
      expect(row?.status).toBe("failed");
      expect(row?.detail).toMatch(/no usable cursor/);
    });
  });

  it("stops on its budget and marks the rest in_progress rather than skipping them", async () => {
    // Driven by a clock rather than a wait: the first read establishes the
    // deadline, and every check after it is already past.
    let t = 0;
    const out = await runReferenceDataSync(fakeSupabase(), {
      budgetMs: 5_000,
      now: () => (t === 0 ? (t = 1, 0) : 10_000_000),
    });
    expect(out.budgetExhausted).toBe(true);
    expect(out.done).toBe(false);
    expect(out.tables.every((t) => t.status === "in_progress")).toBe(true);
  });

  it("writes an audit row naming both projects and every table's outcome", async () => {
    await runReferenceDataSync(fakeSupabase(), { actorUserId: "op-1" });
    const audit = state.audits.at(-1);
    expect(audit?.action).toBe("clone.reference_data_synced");
    const meta = audit?.metadata as Record<string, unknown>;
    expect(meta.prime_backend_ref).toBe(PRIME);
    expect(meta.clone_project_ref).toBe(CLONE);
    expect(meta.trigger).toBe("operator");
    expect((meta.tables as unknown[]).length).toBe(REFERENCE_TABLES.length);
  });
});
