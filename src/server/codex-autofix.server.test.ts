// The fixes Mission Control starts by itself after the nightly Prime scan:
// which scan starts them, that a scan starts them once, which findings go
// and with which engine. Run against a fake Supabase that applies the
// queries' filters, with the dispatch itself (startRemediation) faked.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
  inserts: [] as Array<{ table: string; values: Row }>,
  /** What happened, in order: inserted events and dispatches. */
  log: [] as string[],
  startResults: {} as Record<string, { ok: false; error: string }>,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op = "select";
    let values: Row | undefined;
    let head = false;
    let limit = Number.POSITIVE_INFINITY;
    let order: { column: string; ascending: boolean } | null = null;
    const result = () => {
      if (h.failing.has(`${table}:${op}`)) {
        return { data: null, count: null, error: { message: `${table} ${op} failed` } };
      }
      if (op === "insert") {
        h.inserts.push({ table, values: values as Row });
        h.log.push(`insert ${table} ${String((values as Row).event_type ?? "")}`);
        return { data: null, error: null };
      }
      let rows = (h.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (order) {
        const { column, ascending } = order;
        rows = [...rows].sort(
          (a, b) =>
            String(a[column] ?? "").localeCompare(String(b[column] ?? "")) * (ascending ? 1 : -1),
        );
      }
      rows = rows.slice(0, limit);
      return head
        ? { data: null, count: rows.length, error: null }
        : { data: rows, count: rows.length, error: null };
    };
    const b: Record<string, unknown> = {
      select: (_columns?: string, opts?: { head?: boolean }) => {
        head = !!opts?.head;
        return b;
      },
      insert: (v: Row) => {
        op = "insert";
        values = v;
        return b;
      },
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      gte: (c: string, v: unknown) => (filters.push((r) => String(r[c] ?? "") >= String(v)), b),
      order: (column: string, o?: { ascending?: boolean }) => {
        order = { column, ascending: o?.ascending !== false };
        return b;
      },
      limit: (n: number) => ((limit = n), b),
      maybeSingle: async () => {
        const r = result();
        return { ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data };
      },
      then: (ok: (r: unknown) => unknown, bad: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(ok, bad),
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});

vi.mock("@/server/codex-remediation-start.server", () => ({
  IN_FLIGHT_REMEDIATION_STATUSES: [
    "queued",
    "dispatched",
    "pr_opened",
    "pr_updated",
    "approved",
    "changes_requested",
  ],
  startRemediation: vi.fn(
    async (input: { findingId: string; engine: string; requestedBy: string | null }) => {
      h.log.push(`start ${input.findingId} ${input.engine}`);
      return (
        h.startResults[input.findingId] ?? {
          ok: true,
          remediationId: `rem-${input.findingId}`,
          reused: false,
          engine: input.engine,
        }
      );
    },
  ),
}));

import { dispatchAutomaticFixes } from "./codex-autofix.server";
import { startRemediation } from "@/server/codex-remediation-start.server";

const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
const finding = (id: string, severity: string, extra: Row = {}): Row => ({
  id,
  severity,
  state: "open",
  scanner: "semgrep",
  clone_id: null,
  pr_number: null,
  first_seen_at: hoursAgo(100),
  ...extra,
});

beforeEach(() => {
  h.failing = new Set();
  h.inserts = [];
  h.log = [];
  h.startResults = {};
  vi.mocked(startRemediation).mockClear();
  h.tables = {
    prime_config: [{ codex_autofix_enabled: true, codex_autofix_max_per_night: 3 }],
    codex_scan_jobs: [
      {
        id: "job-1",
        target_kind: "prime",
        clone_id: null,
        status: "completed",
        kind: "nightly_full",
        completed_at: hoursAgo(1),
        path_globs: [],
        result_summary: { scope: { mode: "full" } },
      },
    ],
    codex_scan_events: [],
    codex_findings: [
      finding("low-1", "low"),
      finding("medium-1", "medium"),
      finding("high-new", "high", { first_seen_at: hoursAgo(5) }),
      finding("high-old", "high", { first_seen_at: hoursAgo(50) }),
      finding("critical-1", "critical"),
      finding("info-1", "info"),
      finding("secret-1", "critical", { scanner: "gitleaks" }),
      finding("tried-twice", "high"),
      finding("in-flight", "high"),
      finding("triaging", "critical", { state: "triaging" }),
      finding("clone-1", "critical", { clone_id: "c-1" }),
    ],
    codex_remediations: [
      { finding_id: "tried-twice", status: "closed", requested_by: null, created_at: hoursAgo(30) },
      { finding_id: "tried-twice", status: "failed", requested_by: null, created_at: hoursAgo(10) },
      { finding_id: "in-flight", status: "pr_opened", requested_by: null, created_at: hoursAgo(2) },
    ],
  };
});

describe("dispatchAutomaticFixes", () => {
  it("starts tonight's fixes worst first, Claude for P0/P1 and Codex below, within the limit", async () => {
    const res = await dispatchAutomaticFixes();
    expect(res).toMatchObject({ ran: true, jobId: "job-1", failed: [] });
    if (!res.ran) throw new Error("did not run");
    expect(res.dispatched.map((d) => [d.findingId, d.engine])).toEqual([
      ["critical-1", "claude_code"],
      ["high-old", "claude_code"],
      ["high-new", "claude_code"],
    ]);
    for (const [input] of vi.mocked(startRemediation).mock.calls) {
      expect(input).toMatchObject({ requestedBy: null, source: "autofix" });
    }
  });

  it("gives P2 and below to Codex", async () => {
    h.tables.prime_config = [{ codex_autofix_max_per_night: 10 }];
    const res = await dispatchAutomaticFixes();
    if (!res.ran) throw new Error("did not run");
    const engines = Object.fromEntries(res.dispatched.map((d) => [d.findingId, d.engine]));
    expect(engines).toMatchObject({ "medium-1": "codex_cli", "low-1": "codex_cli" });
  });

  it("never starts a credential, an info finding, a clone's, one being triaged, one in flight or one tried twice", async () => {
    h.tables.prime_config = [{ codex_autofix_max_per_night: 50 }];
    await dispatchAutomaticFixes();
    const started = vi.mocked(startRemediation).mock.calls.map(([i]) => i.findingId);
    for (const id of ["secret-1", "info-1", "clone-1", "triaging", "in-flight", "tried-twice"]) {
      expect(started).not.toContain(id);
    }
  });

  it("claims the scan before dispatching and records the outcome after", async () => {
    await dispatchAutomaticFixes();
    expect(h.log[0]).toBe("insert codex_scan_events autofix.dispatched");
    expect(h.log.at(-1)).toBe("insert codex_scan_events autofix.summary");
    const summary = h.inserts.find((i) => i.values.event_type === "autofix.summary")?.values;
    expect(summary).toMatchObject({
      job_id: "job-1",
      payload: { dispatched: 3, by_engine: { claude_code: 3 }, limit: 3 },
    });
  });

  it("starts a scan's fixes once", async () => {
    h.tables.codex_scan_events = [{ id: "e-1", job_id: "job-1", event_type: "autofix.dispatched" }];
    expect(await dispatchAutomaticFixes()).toMatchObject({ ran: false });
    expect(startRemediation).not.toHaveBeenCalled();
  });

  it("starts nothing when it cannot tell whether the scan's fixes went out", async () => {
    h.failing.add("codex_scan_events:select");
    expect(await dispatchAutomaticFixes()).toMatchObject({
      ran: false,
      reason: expect.stringMatching(/already dispatched/),
    });
    expect(startRemediation).not.toHaveBeenCalled();
  });

  it("starts nothing when the claim cannot be recorded", async () => {
    h.failing.add("codex_scan_events:insert");
    expect(await dispatchAutomaticFixes()).toMatchObject({ ran: false });
    expect(startRemediation).not.toHaveBeenCalled();
  });

  it("keeps going past a fix that cannot be started", async () => {
    h.startResults["critical-1"] = { ok: false, error: "workflow missing" };
    const res = await dispatchAutomaticFixes();
    if (!res.ran) throw new Error("did not run");
    expect(res.failed).toEqual([{ findingId: "critical-1", error: "workflow missing" }]);
    expect(res.dispatched.map((d) => d.findingId)).toEqual(["high-old", "high-new"]);
  });

  it.each([
    ["switched off", () => (h.tables.prime_config = [{ codex_autofix_enabled: false }])],
    ["limited to none", () => (h.tables.prime_config = [{ codex_autofix_max_per_night: 0 }])],
    ["given only an old scan", () => (h.tables.codex_scan_jobs[0].completed_at = hoursAgo(72))],
    [
      "given only a scan of some paths",
      () => (h.tables.codex_scan_jobs[0].path_globs = ["src/**"]),
    ],
    ["given only a clone's scan", () => (h.tables.codex_scan_jobs[0].target_kind = "clone")],
  ])("starts nothing when %s", async (_why, arrange) => {
    arrange();
    expect(await dispatchAutomaticFixes()).toMatchObject({ ran: false });
    expect(startRemediation).not.toHaveBeenCalled();
  });
});
