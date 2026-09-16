import { describe, it, expect } from "vitest";
import { judge, summariseDrift, type Probe, type CheckResult } from "./migrationDrift.pure";
import type { Assertion } from "./migrationAssertions.pure";

const TABLE: Assertion = { kind: "table", table: "clone_reference_syncs" };
const COLUMN: Assertion = { kind: "column", table: "clone_backends", column: "worker_started_at" };
const RPC: Assertion = { kind: "rpc", fn: "cron_delivery_health" };
const ROWS: Assertion = { kind: "rows", table: "mirror_exclusions", atLeast: 17 };
const CRON: Assertion = { kind: "cron", jobname: "reference-data-sync-hourly" };
const ENUM: Assertion = { kind: "enum", type: "clone_backend_status" };
const NONE: Assertion = { kind: "none", reason: "comment only, creates no object" };

describe("judge", () => {
  it("passes a claim the database confirms", () => {
    expect(judge(TABLE, { kind: "exists", exists: true }).status).toBe("satisfied");
    expect(judge(COLUMN, { kind: "exists", exists: true }).status).toBe("satisfied");
    expect(judge(RPC, { kind: "exists", exists: true }).status).toBe("satisfied");
    expect(judge(ROWS, { kind: "count", count: 17 }).status).toBe("satisfied");
    expect(judge(CRON, { kind: "cron", scheduled: true, active: true }).status).toBe("satisfied");
  });

  it("fails a claim the database contradicts", () => {
    expect(judge(TABLE, { kind: "exists", exists: false }).status).toBe("unsatisfied");
    expect(judge(COLUMN, { kind: "exists", exists: false }).status).toBe("unsatisfied");
    expect(judge(RPC, { kind: "exists", exists: false }).status).toBe("unsatisfied");
    expect(judge(ROWS, { kind: "count", count: 16 }).status).toBe("unsatisfied");
  });

  /**
   * The distinction this whole module exists for. `aml.cases` cost twelve
   * handlers reporting "Case not found" about a case the operator had open,
   * because a failed read was read as an absent row. The same confusion here
   * sends somebody to re-apply a migration because of a 502.
   */
  it("never reports a failed probe as an unsatisfied claim", () => {
    const failed: Probe = { kind: "failed", message: "fetch failed: ECONNRESET" };
    for (const a of [TABLE, COLUMN, RPC, ROWS, CRON]) {
      const r = judge(a, failed);
      expect(r.status).toBe("error");
      expect(r.status).not.toBe("unsatisfied");
      expect(r.detail).toContain("ECONNRESET");
    }
  });

  it("reports an unprobed claim as unassertable, never as satisfied", () => {
    for (const a of [TABLE, COLUMN, RPC, ROWS, CRON]) {
      expect(judge(a, null).status).toBe("unassertable");
    }
  });

  it("marks an enum unassertable and says why", () => {
    const r = judge(ENUM, null);
    expect(r.status).toBe("unassertable");
    expect(r.detail).toContain("PGRST106");
  });

  it("marks `none` not_applicable and carries its reason forward", () => {
    const r = judge(NONE, null);
    expect(r.status).toBe("not_applicable");
    expect(r.detail).toBe("comment only, creates no object");
  });

  /**
   * A job that exists and does not run has not made its claim true. Six workers
   * shipped in exactly that state: the migration recorded as applied,
   * `cron.schedule` never reached, a RAISE NOTICE nobody reads as the trace.
   */
  it("treats a scheduled-but-inactive job as drift", () => {
    const r = judge(CRON, { kind: "cron", scheduled: true, active: false });
    expect(r.status).toBe("unsatisfied");
    expect(r.detail).toContain("inactive");
  });

  it("treats a probe of the wrong shape as a checker fault, not a database fact", () => {
    const r = judge(TABLE, { kind: "count", count: 3 });
    expect(r.status).toBe("error");
    expect(r.detail).toContain("internal");
  });
});

describe("summariseDrift", () => {
  const at = (migration: string, result: CheckResult) => ({ migration, result });

  it("counts only answered claims as checked", () => {
    // Coverage must not be inflatable by adding claims nothing can see.
    const s = summariseDrift([
      at("a.sql", judge(TABLE, { kind: "exists", exists: true })),
      at("b.sql", judge(TABLE, { kind: "exists", exists: false })),
      at("c.sql", judge(ENUM, null)),
      at("d.sql", judge(NONE, null)),
      at("e.sql", judge(RPC, { kind: "failed", message: "boom" })),
    ]);
    expect(s).toMatchObject({
      checked: 2,
      satisfied: 1,
      unsatisfied: 1,
      unassertable: 1,
      notApplicable: 1,
      errors: 1,
    });
  });

  it("lists only unsatisfied claims as drift", () => {
    const s = summariseDrift([
      at("a.sql", judge(TABLE, { kind: "exists", exists: false })),
      at("b.sql", judge(RPC, { kind: "failed", message: "boom" })),
      at("c.sql", judge(ENUM, null)),
    ]);
    expect(s.drifted).toHaveLength(1);
    expect(s.drifted[0]).toContain("a.sql");
  });

  it("reports no drift when nothing could be checked at all", () => {
    // An alarm that also fires for "could not reach the database" is one people
    // mute, and then it is not an alarm for anything.
    const s = summariseDrift([
      at("a.sql", judge(TABLE, { kind: "failed", message: "503" })),
      at("b.sql", judge(COLUMN, { kind: "failed", message: "503" })),
    ]);
    expect(s.unsatisfied).toBe(0);
    expect(s.drifted).toEqual([]);
    expect(s.errors).toBe(2);
  });
});

describe("summariseDrift with retired claims", () => {
  it("counts superseded on its own and never as drift", async () => {
    const { summariseDrift } = await import("./migrationDrift.pure");
    const s = summariseDrift([
      {
        migration: "a.sql",
        result: {
          assertion: { kind: "rows", table: "t", atLeast: 45 },
          status: "superseded",
          detail: "retired by b.sql",
        },
      },
      {
        migration: "b.sql",
        result: {
          assertion: { kind: "rows", table: "t", atLeast: 44 },
          status: "satisfied",
          detail: "t holds 44 row(s), claim is >= 44",
        },
      },
    ]);
    expect(s.superseded).toBe(1);
    expect(s.unsatisfied).toBe(0);
    expect(s.drifted).toHaveLength(0);
    // A retired claim is not a checked one: counting it either way would let
    // coverage move without anything being observed.
    expect(s.checked).toBe(1);
  });
});
