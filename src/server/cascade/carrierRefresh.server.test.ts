/**
 * The read, the write and the two refusals a database can produce.
 *
 * Every refusal is asserted on the STATE the fake holds afterwards rather than
 * on the return value alone: the whole risk in re-arming rows is that a
 * refusal still wrote something, and a return value cannot see that.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { refreshCarrierRows } from "./carrierRefresh.server";
import type { CarrierEventFacts } from "./carrierRefresh.pure";

type Row = {
  id: string;
  status: string;
  delivered_sha: string | null;
  completed_at: string | null;
  progress: unknown;
  pr_url: string | null;
  diff_summary: string | null;
  clones: { name: string | null } | null;
};

const HEAD = "075a088819cda6926c35ed865936e330b2bfb7f6";
const OLD = "c4ceeeb39d7991475cd0bed92a5c4e2712a5c0ed";

const CARRIER: CarrierEventFacts = { trigger: "commit", completed_at: null, scope_filter: null };

const state = {
  rows: [] as Row[],
  selects: 0,
  updates: 0,
  readError: null as { message: string } | null,
  writeError: null as { message: string } | null,
};

function row(over: Partial<Row> = {}): Row {
  return {
    id: "ncd",
    status: "skipped",
    delivered_sha: OLD,
    completed_at: "2026-09-20T18:00:40Z",
    progress: { cursor: 41 },
    pr_url: "https://github.com/o/r/pull/228",
    diff_summary: "PR #228 opened: 74 file(s)",
    clones: { name: "npc-client-dashboard" },
    ...over,
  };
}

/** Minimal supabase-js double covering exactly the chain this module uses. */
function fakeSupabase() {
  const from = (table: string) => {
    if (table !== "cascade_results") throw new Error(`unexpected table ${table}`);
    return {
      select: (_cols: string) => ({
        eq: async () => {
          state.selects++;
          if (state.readError) return { data: null, error: state.readError };
          return { data: state.rows, error: null };
        },
      }),
      update: (patch: Partial<Row>) => ({
        in: async (_col: string, ids: string[]) => {
          state.updates++;
          if (state.writeError) return { error: state.writeError };
          for (const r of state.rows) {
            if (ids.includes(r.id)) Object.assign(r, patch);
          }
          return { error: null };
        },
      }),
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from } as any;
}

beforeEach(() => {
  state.rows = [];
  state.selects = 0;
  state.updates = 0;
  state.readError = null;
  state.writeError = null;
});

describe("re-offering a finished clone", () => {
  it("puts the row back to queued and clears only the pass cursor", async () => {
    state.rows = [row()];
    const out = await refreshCarrierRows(fakeSupabase(), {
      eventId: "evt",
      event: CARRIER,
      head: HEAD,
    });

    expect(out.refreshed).toBe(1);
    expect(out.note).toContain("npc-client-dashboard");

    const r = state.rows[0];
    expect(r.status).toBe("queued");
    expect(r.completed_at).toBeNull();
    expect(r.progress).toBeNull();
    // The standing proposal survives the re-arm. The next pass finds it and
    // updates it in place; blanking it would lose it if the pass never ran.
    expect(r.pr_url).toBe("https://github.com/o/r/pull/228");
    expect(r.delivered_sha).toBe(OLD);
    // Written once, read for as long as the row exists.
    expect(r.diff_summary).toBe("PR #228 opened: 74 file(s)");
  });

  it("touches only the stale rows", async () => {
    state.rows = [
      row({ id: "ncd", delivered_sha: OLD }),
      row({ id: "crm", delivered_sha: HEAD, clones: { name: "npc-crm-independent" } }),
    ];
    const out = await refreshCarrierRows(fakeSupabase(), {
      eventId: "evt",
      event: CARRIER,
      head: HEAD,
    });
    expect(out.refreshed).toBe(1);
    expect(state.rows.find((r) => r.id === "ncd")!.status).toBe("queued");
    expect(state.rows.find((r) => r.id === "crm")!.status).toBe("skipped");
  });
});

describe("it costs nothing when it has no opinion", () => {
  it("asks no question at all of a manual event", async () => {
    state.rows = [row()];
    const out = await refreshCarrierRows(fakeSupabase(), {
      eventId: "evt",
      event: { ...CARRIER, trigger: "manual" },
      head: HEAD,
    });
    expect(out.refreshed).toBe(0);
    expect(state.selects).toBe(0);
    expect(state.updates).toBe(0);
  });

  it("reads once and writes nothing when the carrier has caught up", async () => {
    state.rows = [row({ delivered_sha: HEAD })];
    const out = await refreshCarrierRows(fakeSupabase(), {
      eventId: "evt",
      event: CARRIER,
      head: HEAD,
    });
    expect(out.refreshed).toBe(0);
    expect(state.selects).toBe(1);
    expect(state.updates).toBe(0);
  });
});

describe("a fault refreshes nothing and says so", () => {
  it("a read that failed is not a carrier with nothing to re-offer", async () => {
    state.rows = [row()];
    state.readError = { message: "connection reset" };
    const out = await refreshCarrierRows(fakeSupabase(), {
      eventId: "evt",
      event: CARRIER,
      head: HEAD,
    });
    expect(out.refreshed).toBe(0);
    expect(out.note).toBeNull();
    expect(out.why).toContain("connection reset");
    expect(state.updates).toBe(0);
    // The pass then behaves exactly as it does today, and the next claim asks
    // again — never a carrier retired over a transient fault.
    expect(state.rows[0].status).toBe("skipped");
  });

  it("a write that failed reports zero rather than the count it attempted", async () => {
    state.rows = [row()];
    state.writeError = { message: "deadlock detected" };
    const out = await refreshCarrierRows(fakeSupabase(), {
      eventId: "evt",
      event: CARRIER,
      head: HEAD,
    });
    expect(out.refreshed).toBe(0);
    expect(out.note).toBeNull();
    expect(out.why).toContain("deadlock detected");
  });
});
