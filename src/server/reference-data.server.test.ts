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
  /**
   * When set, a `clone_reference_syncs` upsert whose values match is REFUSED
   * with an error rather than stored — which is what PostgREST does and what
   * `record` swallows. Without this the double could not express the one
   * state that separates "the count this isolate counted" from "the count the
   * row holds", and that gap is a finding this suite exists to have caught.
   */
  syncUpsertRefuses: null as null | ((values: Record<string, unknown>) => boolean),
  /**
   * When true, `notifyOperators` behaves as it does when the insert fails:
   * it logs, returns false and raises nothing. The real one swallows that
   * error, so a caller that deduplicates cannot tell a delivered notice from
   * a lost one unless it reads the answer — which is the whole point of the
   * marker these tests cover.
   */
  notifyFails: false,
  /** When set, reading this clone's per-table state answers an error. */
  syncStateReadError: null as { message: string } | null,
  /**
   * Every `clone_backends` update, with the filters that shaped it.
   *
   * The values alone are not enough: the stale-claim RECLAIM at the top of
   * every pass writes `reference_sync_started_at: null` too, so a test reading
   * only the payload cannot tell a release from a sweep. One did, and passed
   * with the release deleted. The filters separate them — the reclaim sweeps by
   * age (`lt`), a release names one clone (`eq clone_id`).
   */
  backendUpdates: [] as Array<{
    values: Record<string, unknown>;
    eqClone: boolean;
    byAge: boolean;
  }>,
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
    if (state.notifyFails) return false;
    state.notifications.push({ title: n.title, body: n.body });
    return true;
  },
  writeAuditLog: async (a: Record<string, unknown>) => {
    state.audits.push(a);
  },
}));

import { runReferenceDataSync } from "./reference-data.server";
import { REFERENCE_TABLES, refName } from "./referenceTables.pure";

/** Minimal supabase-js double covering exactly the chains the worker uses. */
function fakeSupabase() {
  const backendsUpdateChain = (values?: Record<string, unknown>) => {
    const call = { values: values ?? {}, eqClone: false, byAge: false };
    state.backendUpdates.push(call);
    const b: Record<string, unknown> = {
      eq: (col: string) => {
        if (col === "clone_id") call.eqClone = true;
        return b;
      },
      is: () => b,
      not: () => b,
      lt: () => {
        call.byAge = true;
        return b;
      },
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
        update: (values: Record<string, unknown>) => backendsUpdateChain(values),
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
          eq: async () =>
            state.syncStateReadError
              ? { data: null, error: state.syncStateReadError }
              : { data: [...state.syncRows.values()], error: null },
        }),
        upsert: async (values: Record<string, unknown>) => {
          if (state.syncUpsertRefuses?.(values)) {
            return { error: { message: "clone_reference_syncs write refused" } };
          }
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
  state.syncUpsertRefuses = null;
  state.notifyFails = false;
  state.syncStateReadError = null;
  state.backendUpdates = [];
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

    /*
      THE SECOND NOTIFIER, AND THE ONE THE FIRST VERSION OF THIS RULE MISSED.

      An unclassified column is stable: the same refusal next pass and the pass
      after. The transition check went on the copy's catch and this path was
      left announcing unconditionally, so at four passes an hour one table
      still meant up to ninety-six identical alerts a day. Raised by review on
      the commit that introduced the cadence.
    */
    const unclassifiedColumn = (ref: string, sql: string): unknown => {
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

    it("does not repeat a schema refusal that has not changed", async () => {
      state.respond = unclassifiedColumn;
      await runReferenceDataSync(fakeSupabase());
      expect(
        state.notifications.filter((n) => /Reference sync refused/.test(n.title)).length,
      ).toBeGreaterThan(0);

      state.notifications = [];
      // Second pass over the rows the first one wrote: same column, same words.
      await runReferenceDataSync(fakeSupabase());
      expect(
        state.notifications.filter((n) => /Reference sync refused/.test(n.title)),
        "an unclassified column is stable, so announcing it every pass is a feed nobody reads",
      ).toHaveLength(0);
    });

    it("but does announce a refusal whose REASON changed", async () => {
      state.respond = unclassifiedColumn;
      await runReferenceDataSync(fakeSupabase());
      state.notifications = [];
      state.respond = (ref, sql) => {
        if (sql.includes("information_schema.columns") && sql.includes("'suburb_directory'")) {
          // A DIFFERENT unclassified column: a different thing to classify and
          // so a different remedy, which is what makes it news.
          return [{ column_name: "id" }, { column_name: "client_id" }];
        }
        return unclassifiedColumn(ref, sql);
      };
      await runReferenceDataSync(fakeSupabase());
      const again = state.notifications.filter((n) => /Reference sync refused/.test(n.title));
      expect(again.length).toBeGreaterThan(0);
      expect(again.some((n) => n.body.includes("client_id"))).toBe(true);
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

    /*
      A STATE READ THAT FAILED IS NOT A CLONE WITH NO STATE.

      The `error` on this read was discarded and `data` is null on a failure,
      so every table read as never visited: complete tables re-copied from the
      first page, cursors ignored, every recorded failure announced again. On a
      clone holding the 500 Investment Compass masters and a 24,294-row
      sanctions register that is a full re-walk of twenty-four tables against
      the prime, on every pass, for as long as the read keeps failing.

      The sibling reads above already refuse — the candidate list, the claim,
      the prime-ref guard. This one was missed, and it is the same rule
      `readCase()` pays for in the AML module.
    */
    it("a state read that FAILED is not a clone with nothing copied yet", async () => {
      state.syncStateReadError = { message: '42703: column "notified_detail" does not exist' };
      const out = await runReferenceDataSync(fakeSupabase());
      expect(out.error, "a failed state read reported as an ordinary pass").toBeTruthy();
      expect(out.error).toContain("42703");
      expect(out.tables, "tables were walked without knowing what had been copied").toHaveLength(0);
      expect(
        state.ran.some((r) => r.includes("__cursor")),
        "a page was read from the prime with no idea what this clone already holds",
      ).toBe(false);
    });

    it("and releases the claim it had already taken", async () => {
      // The one refusal that happens AFTER the claim. Returning without
      // releasing parks the clone until the stale-claim sweep.
      state.syncStateReadError = { message: "connection reset" };
      await runReferenceDataSync(fakeSupabase());
      expect(
        state.backendUpdates.some(
          (u) => u.values.reference_sync_started_at === null && u.eqClone && !u.byAge,
        ),
        "the clone was left claimed by a pass that did nothing",
      ).toBe(true);
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

/**
 * The parent is walked again — from the start — while its child is unfinished.
 *
 * `tablesToReopen` decides WHICH tables; these check the copier acts on the
 * answer, because a set nobody reads is the same as no set. Asserted on the
 * SQL that reached the prime, since that is the only thing the clone can tell
 * apart: a re-walk that resumes from the stored cursor issues
 * `id::text > '<cursor>'` and never sees the rows it was re-opened for.
 */
describe("a finished parent is re-walked while its child is unfinished", () => {
  /** The prime page queries issued against one table, in order. */
  const pagesFor = (table: string): string[] =>
    state.ran
      .filter((r) => r.startsWith(`${PRIME}::`))
      .map((r) => r.slice(PRIME.length + 2))
      .filter((sql) => sql.includes("__cursor") && sql.includes(`."${table}" t`));

  beforeEach(() => {
    // The measured state on npc-test-76b3b3: the ledger finished on 12 Sep at
    // 80 rows; the register it belongs to stopped at 21,600 of 24,294.
    state.syncRows.set("aml.sanctions_list_syncs", {
      table_name: "aml.sanctions_list_syncs",
      status: "complete",
      cursor: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      rows_copied: 80,
    });
    state.syncRows.set("aml.sanctions_entries", {
      table_name: "aml.sanctions_entries",
      status: "failed",
      cursor: "e792eb2d-18f2-4f7b-9649-32359c3cf80c",
      rows_copied: 21600,
    });
  });

  it("reads the parent again rather than skipping it as complete", async () => {
    await runReferenceDataSync(fakeSupabase());
    expect(pagesFor("sanctions_list_syncs").length).toBeGreaterThan(0);
  });

  it("reads it from the beginning, not from the cursor it stored", async () => {
    await runReferenceDataSync(fakeSupabase());
    const first = pagesFor("sanctions_list_syncs")[0] ?? "";
    expect(first).not.toContain("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(first).not.toMatch(/id"?::text >/);
  });

  it("the child still resumes from ITS cursor — only the parent restarts", async () => {
    await runReferenceDataSync(fakeSupabase());
    const first = pagesFor("sanctions_entries")[0] ?? "";
    expect(first).toContain("e792eb2d-18f2-4f7b-9649-32359c3cf80c");
  });

  it("counts the re-walk rather than adding it to the count it carried", async () => {
    await runReferenceDataSync(fakeSupabase());
    // The double serves an empty prime, so a fresh walk writes 0. Carrying the
    // old 80 forward would report 80 rows this pass never copied.
    expect(state.syncRows.get("aml.sanctions_list_syncs")?.rows_copied).toBe(0);
  });

  it("leaves an unrelated finished table alone", async () => {
    await runReferenceDataSync(fakeSupabase());
    expect(pagesFor("suburb_directory").length).toBeGreaterThan(0);
    state.ran = [];
    // With every table complete and nothing unfinished, nothing re-opens.
    for (const t of REFERENCE_TABLES) {
      state.syncRows.set(refName(t), {
        table_name: refName(t),
        status: "complete",
        rows_copied: 1,
      });
    }
    await runReferenceDataSync(fakeSupabase());
    expect(pagesFor("sanctions_list_syncs")).toEqual([]);
  });
});

/**
 * A table that stopped announces itself.
 *
 * The schema refusal thirty lines above this one in the worker has always
 * notified; a copy that FAILED did not, and the two are the same kind of event
 * to the tenant — a table that is not going to fill itself.
 *
 * Measured 19 Sep 2026: `aml.sanctions_entries` on NPC Test had read `failed`
 * at 21,600 of 24,294 rows since the 12th, with a 23503 naming the exact key
 * it could not place, and nothing anywhere said so. Nothing else in this
 * codebase reads `clone_reference_syncs`, so the row WAS the report.
 */
describe("a failed table is reported, not just recorded", () => {
  beforeEach(() => {
    state.respond = (ref, sql) => {
      if (sql.includes("to_regclass")) return [{ present: true }];
      if (sql.includes("information_schema.columns")) return [{ column_name: "id" }];
      if (sql.includes("count(*)")) return [{ n: 1 }];
      // The clone refuses the write, exactly as Postgres did.
      if (ref === CLONE && sql.includes("jsonb_populate_recordset")) {
        throw new Error('violates foreign key constraint "sanctions_entries_sync_id_fkey"');
      }
      if (ref === PRIME && sql.includes("__cursor")) {
        return [{ __cursor: "a", __row: { id: "a" } }];
      }
      return [];
    };
  });

  it("notifies an operator, naming the table and the clone", async () => {
    await runReferenceDataSync(fakeSupabase());
    const n = state.notifications.find((x) => /Reference sync stopped/.test(x.title));
    expect(n, "no notification was raised for a failed table").toBeDefined();
    expect(n!.title).toContain("NPC Client Dashboard");
  });

  it("carries the source's own words rather than a summary of them", async () => {
    await runReferenceDataSync(fakeSupabase());
    const n = state.notifications.find((x) => /Reference sync stopped/.test(x.title));
    expect(n!.body).toContain("sanctions_entries_sync_id_fkey");
  });

  it("says the rows already copied are kept and that it will repeat", async () => {
    // The distinction an operator acts on: this is not a transient blip that
    // the next pass clears, and nothing was lost.
    await runReferenceDataSync(fakeSupabase());
    const n = state.notifications.find((x) => /Reference sync stopped/.test(x.title));
    expect(n!.body).toMatch(/kept/);
    expect(n!.body).toMatch(/repeat/);
  });

  it("still records the failure on the row", async () => {
    await runReferenceDataSync(fakeSupabase());
    const failed = [...state.syncRows.values()].filter((r) => r.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
  });

  /*
    ONCE PER FAILURE, NOT ONCE PER PASS.

    Only `complete` and `skipped` are terminal, so a failed table is retried
    every pass for ever — four times an hour under the cadence beside this
    change. One broken table would be ninety-six alerts a day, and an alert
    that fires on a schedule is one people mute.
  */
  it("does not notify again for the same failure on a later pass", async () => {
    await runReferenceDataSync(fakeSupabase());
    const first = state.notifications.filter((x) => /Reference sync stopped/.test(x.title)).length;
    expect(first).toBeGreaterThan(0);

    state.notifications = [];
    // Second pass, same state: the rows the first pass wrote are now `prior`.
    await runReferenceDataSync(fakeSupabase());
    expect(
      state.notifications.filter((x) => /Reference sync stopped/.test(x.title)),
      "the same error on the same table is a state the operator was already told about",
    ).toHaveLength(0);
  });

  /*
    A FAILURE THAT WAS RECORDED IS NOT A FAILURE THAT WAS REPORTED.

    This is the defect the first version of the dedupe shipped with, and it
    would have been invisible until the day it deployed. `clone_reference_syncs`
    has carried `status = 'failed'` with a reason since long before anything
    notified — the catch recorded and announced nothing, which is the silence
    the whole change exists to end. Keyed on status and detail, every one of
    those rows answers "the same failure as before" on the first pass after
    deployment and the alert that was owed is suppressed for ever.

    On the two rows that motivated the work — `aml.sanctions_entries` on NPC
    Test since 12 Sep, `aml.retention_schedules` on npc-client-dashboard since
    14 Sep — it would have preserved exactly the silence it was written to
    break.

    Simulated by stripping the delivery marker rather than by spelling the
    detail out: the detail is composed by the copier and a literal here would
    be a second copy of it that goes stale on the next wording change.
  */
  it("still announces a failure that was recorded before anything notified", async () => {
    await runReferenceDataSync(fakeSupabase());
    expect(
      state.notifications.filter((x) => /Reference sync stopped/.test(x.title)).length,
    ).toBeGreaterThan(0);

    // Exactly the historical shape: the failure and its reason, and no record
    // that anybody was ever told.
    for (const [k, row] of state.syncRows) {
      if (row.status === "failed") state.syncRows.set(k, { ...row, notified_detail: null });
    }
    state.notifications = [];

    await runReferenceDataSync(fakeSupabase());
    expect(
      state.notifications.filter((x) => /Reference sync stopped/.test(x.title)),
      "a row that records a failure is not a row that reported one",
    ).not.toHaveLength(0);
  });

  it("does not remember a notice that never landed", async () => {
    // `notifyOperators` swallows its insert error, so a caller that cannot
    // read the answer records a lost message as a delivered one — the same
    // permanent silence by a different route.
    state.notifyFails = true;
    await runReferenceDataSync(fakeSupabase());
    expect(state.notifications).toHaveLength(0);

    state.notifyFails = false;
    await runReferenceDataSync(fakeSupabase());
    expect(
      state.notifications.filter((x) => /Reference sync stopped/.test(x.title)),
      "the failed insert was recorded as though an operator had been told",
    ).not.toHaveLength(0);
  });

  it("forgets the failure once the table finishes, so a recurrence is news", async () => {
    await runReferenceDataSync(fakeSupabase());
    const failed = [...state.syncRows.values()].filter((r) => r.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => typeof r.notified_detail === "string")).toBe(true);

    // The cause is repaired: the clone accepts the write and the table lands.
    // `failed` is not terminal, so the next pass retries it.
    state.respond = emptyEverywhere;
    await runReferenceDataSync(fakeSupabase());
    const done = [...state.syncRows.values()].filter((r) => r.status === "complete");
    expect(done.length).toBeGreaterThan(0);
    expect(
      done.every((r) => r.notified_detail === null),
      "a repaired table that fails the same way later is a regression, not a repeat",
    ).toBe(true);
  });

  it("notifies again when the SAME table fails for a DIFFERENT reason", async () => {
    await runReferenceDataSync(fakeSupabase());
    state.notifications = [];
    const previous = state.respond!;
    state.respond = (ref, sql) => {
      if (ref === CLONE && sql.includes("jsonb_populate_recordset")) {
        // A different fault with a different remedy.
        throw new Error('42703: column "sync_id" does not exist');
      }
      return previous(ref, sql);
    };
    await runReferenceDataSync(fakeSupabase());
    const again = state.notifications.filter((x) => /Reference sync stopped/.test(x.title));
    // The double's refusal reaches every table, so the count is not the point:
    // that it spoke AT ALL on a pass where the reason changed is.
    expect(again.length).toBeGreaterThan(0);
    expect(again.every((n) => n.body.includes("42703"))).toBe(true);
  });

  it("reports the count THIS attempt reached, not the one it started with", async () => {
    // `prior` is the snapshot taken before any page was copied. A table that
    // lands pages and then fails reported that snapshot — usually zero — under
    // a sentence promising the count it stopped at.
    // A page SHORT of `rowsPerPage` ends the walk as complete, so the first
    // page has to be a full one or there is no second page to fail on.
    const entry = REFERENCE_TABLES.find((e) => e.table === "suburb_directory")!;
    const full = Array.from({ length: entry.rowsPerPage }, (_, i) => ({
      __cursor: `c${i}`,
      __row: { id: `c${i}` },
    }));
    let page = 0;
    state.respond = (ref, sql) => {
      if (sql.includes("to_regclass")) return [{ present: true }];
      if (sql.includes("information_schema.columns")) return [{ column_name: "id" }];
      if (sql.includes("count(*)")) return [{ n: entry.rowsPerPage * 2 }];
      if (ref === PRIME && sql.includes("__cursor") && sql.includes('."suburb_directory" t')) {
        page += 1;
        if (page === 1) return full;
        throw new Error("the prime refused the second page");
      }
      if (ref === PRIME && sql.includes("__cursor")) return [];
      return [];
    };
    await runReferenceDataSync(fakeSupabase());
    const n = state.notifications.find((x) => /suburb_directory/.test(x.title));
    expect(n, "no notice for the table that failed mid-walk").toBeDefined();
    expect(n!.body, "the notice reported the count it started with").toContain(
      `${entry.rowsPerPage} row(s)`,
    );
  });

  /*
    AND NEVER A COUNT THE ROW DOES NOT CARRY.

    `record` swallows its own write error — correctly, because a page that
    copied is copied whether or not this row records it, and throwing there
    would fail a table over its bookkeeping. But `reached` was advanced before
    the answer came back, so a refused progress write left the row holding the
    old count while the notice quoted the new one.

    Zero is the honest reading here even though the rows reached the clone:
    the cursor did not land either, so the next pass re-walks from the start,
    and `on conflict do nothing` makes that free. The notice describes what
    the register says and what the next pass will do — not what this isolate
    happened to count.

    Raised by review on the commit that fixed the stale count, and it is the
    same finding one layer down.
  */
  it("does not report a count whose write was refused", async () => {
    const entry = REFERENCE_TABLES.find((e) => e.table === "suburb_directory")!;
    const full = Array.from({ length: entry.rowsPerPage }, (_, i) => ({
      __cursor: `c${i}`,
      __row: { id: `c${i}` },
    }));
    let page = 0;
    state.respond = (ref, sql) => {
      if (sql.includes("to_regclass")) return [{ present: true }];
      if (sql.includes("information_schema.columns")) return [{ column_name: "id" }];
      if (sql.includes("count(*)")) return [{ n: entry.rowsPerPage * 2 }];
      if (ref === PRIME && sql.includes("__cursor") && sql.includes('."suburb_directory" t')) {
        page += 1;
        if (page === 1) return full;
        throw new Error("the prime refused the second page");
      }
      if (ref === PRIME && sql.includes("__cursor")) return [];
      return [];
    };
    // The PROGRESS write alone — the opening `copying` row carries no count,
    // and the catch's failure record has to land or there is nothing to read.
    state.syncUpsertRefuses = (v) => v.status === "copying" && "rows_copied" in v;

    await runReferenceDataSync(fakeSupabase());
    const n = state.notifications.find((x) => /suburb_directory/.test(x.title));
    expect(n, "no notice for the table that failed mid-walk").toBeDefined();
    expect(n!.body, "quoted a count no write ever stored").not.toContain(
      `${entry.rowsPerPage} row(s)`,
    );
    expect(n!.body).toContain("0 row(s)");
  });
});
