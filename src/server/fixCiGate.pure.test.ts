import { describe, expect, it } from "vitest";
import { FIX_CI_WAIT_MS, decideFixCi, fixCiSpec, type FixCiRun } from "./fixCiGate.pure";

const CI = { workflow: ".github/workflows/ci.yml", dispatchable: true };
const T0 = Date.parse("2026-10-18T02:00:00Z");

function decide(over: Partial<Parameters<typeof decideFixCi>[0]> = {}) {
  return decideFixCi({
    spec: CI,
    runs: [],
    dispatched: false,
    firstLookAt: T0,
    now: T0 + 60_000,
    ...over,
  });
}

const run = (
  id: number,
  status: string,
  conclusion: string | null,
  path = CI.workflow,
): FixCiRun => ({
  id,
  path,
  status,
  conclusion,
});

describe("fixCiSpec", () => {
  it("reads the CI a version-4 workflow named", () => {
    expect(fixCiSpec({ ok: true, ci: CI })).toEqual(CI);
    expect(fixCiSpec({ ci: { workflow: null, dispatchable: false } })).toEqual({
      workflow: null,
      dispatchable: false,
    });
  });

  it("is null for a workflow that named none", () => {
    expect(fixCiSpec({ ok: true, checks: [] })).toBeNull();
    expect(fixCiSpec(null)).toBeNull();
    expect(fixCiSpec([])).toBeNull();
  });

  it("never treats a malformed path as a workflow to dispatch", () => {
    for (const workflow of ["../ci.yml", ".github/workflows/../../x.yml", "ci.yml", 7]) {
      expect(fixCiSpec({ ci: { workflow, dispatchable: true } })?.workflow).toBeNull();
    }
    expect(fixCiSpec({ ci: { workflow: CI.workflow, dispatchable: "yes" } })?.dispatchable).toBe(
      false,
    );
  });
});

describe("decideFixCi", () => {
  it("merges on the workflow's own checks when no CI is named", () => {
    expect(decide({ spec: null }).kind).toBe("merge");
    expect(decide({ spec: { workflow: null, dispatchable: false } }).kind).toBe("merge");
  });

  it("refuses a CI that cannot be started on a fix", () => {
    const v = decide({ spec: { ...CI, dispatchable: false } });
    expect(v.kind).toBe("refuse");
    expect(v.why).toMatch(/workflow_dispatch/);
  });

  it("dispatches the CI once, then waits for it", () => {
    expect(decide().kind).toBe("dispatch");
    expect(decide({ dispatched: true }).kind).toBe("wait");
  });

  it("waits while the run is queued or running", () => {
    expect(decide({ dispatched: true, runs: [run(1, "queued", null)] })).toMatchObject({
      kind: "wait",
      why: expect.stringMatching(/queued/),
    });
    expect(decide({ dispatched: true, runs: [run(1, "in_progress", null)] }).kind).toBe("wait");
  });

  it("merges only on a passing run of the named workflow", () => {
    expect(decide({ runs: [run(1, "completed", "success")] }).kind).toBe("merge");
    // Another workflow passing says nothing about this one.
    expect(
      decide({ runs: [run(1, "completed", "success", ".github/workflows/other.yml")] }).kind,
    ).toBe("dispatch");
    // GitHub sometimes reports the path with the ref it ran from.
    expect(
      decide({ runs: [run(1, "completed", "success", `${CI.workflow}@refs/heads/codex/fix-x`)] })
        .kind,
    ).toBe("merge");
  });

  it("refuses a run that finished any other way", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", null]) {
      const v = decide({ runs: [run(1, "completed", conclusion)] });
      expect(v.kind, String(conclusion)).toBe("refuse");
    }
  });

  it("reads the newest run: a re-run that passed supersedes the failure it repeats", () => {
    const runs = [run(5, "completed", "failure"), run(9, "completed", "success")];
    expect(decide({ runs }).kind).toBe("merge");
    expect(decide({ runs: [...runs, run(12, "in_progress", null)] }).kind).toBe("wait");
  });

  it("stops waiting after the limit", () => {
    const late = T0 + FIX_CI_WAIT_MS + 1;
    expect(decide({ dispatched: true, now: late })).toMatchObject({
      kind: "refuse",
      why: expect.stringMatching(/never started/),
    });
    expect(decide({ runs: [run(1, "in_progress", null)], now: late })).toMatchObject({
      kind: "refuse",
      why: expect.stringMatching(/did not finish/),
    });
    // A run that finished green after the limit still merges.
    expect(decide({ runs: [run(1, "completed", "success")], now: late }).kind).toBe("merge");
  });
});
