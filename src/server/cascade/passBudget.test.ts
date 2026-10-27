/**
 * How much of a tick a clone's pass needs. Every reading this cannot make
 * must answer the old behaviour — no reservation — so a missing trace costs
 * what it always cost.
 */
import { describe, expect, it } from "vitest";
import {
  CLAIM_HEADROOM_MS,
  INVOCATION_BUDGET_MS,
  PAST_BUDGET_SLACK_MS,
  claimHasHeadroom,
  clonePassBudgets,
  ownPassReserveMs,
  readPassTrace,
  tailReserveMs,
} from "./passBudget.pure";

const trace = (over: Record<string, unknown> = {}) => ({
  v: 1,
  started_at: "2026-10-26T06:20:00.000Z",
  phases: [
    ["listing", 0],
    ["closure", 4_000],
    ["prepare", 18_000],
    ["deliver", 21_000],
    ["proposal", 36_000],
  ],
  outcome: "finished",
  ended_ms: 40_000,
  ...over,
});

describe("ownPassReserveMs — how long the clone's next pass should be assumed to take", () => {
  it("is what its last pass took, however that pass ended", () => {
    expect(ownPassReserveMs(trace())).toBe(40_000);
    expect(ownPassReserveMs(trace({ outcome: "paused", ended_ms: 31_000 }))).toBe(31_000);
    expect(ownPassReserveMs(trace({ outcome: "deferred", ended_ms: 2_000 }))).toBe(2_000);
  });

  it("is the whole budget for a pass the platform ended, so it only ever starts first", () => {
    // 48 of the CRM's 67 traced passes, 20–27 Oct 2026: no outcome.
    expect(ownPassReserveMs(trace({ outcome: undefined, ended_ms: undefined }))).toBe(
      INVOCATION_BUDGET_MS,
    );
  });

  it("is null — no reservation, the old behaviour — for anything it cannot read", () => {
    for (const raw of [
      null,
      undefined,
      "trace",
      {},
      { v: 2, phases: [] },
      trace({ phases: [] }),
      trace({ phases: "listing" }),
    ]) {
      expect(ownPassReserveMs(raw)).toBeNull();
    }
  });
});

describe("tailReserveMs — what the prepare loop leaves for the unchecked stages after it", () => {
  it("is the clone's tail less the slack the platform allows past the budget", () => {
    // The CRM at p90: entered `deliver` at 21 s and finished at 58.8 s — a
    // 37.8 s tail, 22.8 s more than the 15 s of slack.
    expect(tailReserveMs(trace({ ended_ms: 58_800 }))).toBe(37_800 - PAST_BUDGET_SLACK_MS);
  });

  it("is zero for a mirror, whose tail fits in the slack — preparation unchanged", () => {
    // A mirror at p90: 17.6 s from `deliver` to the end.
    expect(tailReserveMs(trace({ ended_ms: 21_000 + 14_000 }))).toBe(0);
  });

  it("is zero for anything but a finished pass that entered `deliver`", () => {
    expect(tailReserveMs(trace({ outcome: "paused" }))).toBe(0);
    expect(tailReserveMs(trace({ outcome: undefined, ended_ms: undefined }))).toBe(0);
    expect(tailReserveMs(trace({ phases: [["listing", 0]] }))).toBe(0);
    expect(tailReserveMs(null)).toBe(0);
  });
});

describe("clonePassBudgets — newest trace per clone, and newest finished one for the tail", () => {
  it("reads the pass reserve from the latest trace and the tail from the latest finished", () => {
    const budgets = clonePassBudgets([
      // Newest first: a pass the platform ended, then a finished one.
      { clone_id: "crm", pass_trace: trace({ outcome: undefined, ended_ms: undefined }) },
      { clone_id: "crm", pass_trace: trace({ ended_ms: 58_800 }) },
      { clone_id: "cd", pass_trace: trace({ ended_ms: 22_000 }) },
      { clone_id: "cd", pass_trace: trace({ ended_ms: 59_000 }) },
    ]);
    expect(budgets.get("crm")).toEqual({
      passMs: INVOCATION_BUDGET_MS,
      tailMs: 37_800 - PAST_BUDGET_SLACK_MS,
    });
    // The older, slower dashboard pass is not the latest: 22 s, tail 1 s.
    expect(budgets.get("cd")).toEqual({ passMs: 22_000, tailMs: 0 });
  });

  it("leaves out a clone with no readable trace, and ignores rows with no clone", () => {
    const budgets = clonePassBudgets([
      { clone_id: "x", pass_trace: null },
      { clone_id: null, pass_trace: trace() },
    ]);
    expect(budgets.size).toBe(0);
  });
});

describe("claimHasHeadroom — no claim the pass cannot finish", () => {
  const deadline = 1_000_000;
  it("takes a claim with the headroom left", () => {
    expect(claimHasHeadroom(deadline - CLAIM_HEADROOM_MS, deadline)).toBe(true);
    expect(claimHasHeadroom(deadline - INVOCATION_BUDGET_MS, deadline)).toBe(true);
  });
  it("refuses one taken late in the tick", () => {
    // The shape measured: a third claim at second 44 of a 45-second budget.
    expect(claimHasHeadroom(deadline - 1_000, deadline)).toBe(false);
    expect(claimHasHeadroom(deadline - CLAIM_HEADROOM_MS + 1, deadline)).toBe(false);
  });
});

describe("readPassTrace", () => {
  it("drops phases it does not know and an outcome with no time", () => {
    const t = readPassTrace(
      trace({
        phases: [
          ["listing", 0],
          ["nonsense", 3],
          ["prepare", -1],
        ],
        ended_ms: undefined,
      }),
    );
    expect(t?.phases).toEqual([["listing", 0]]);
    expect(t?.outcome).toBeUndefined();
  });
});
