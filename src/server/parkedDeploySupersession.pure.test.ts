import { describe, expect, it } from "vitest";
import {
  MAX_CONSECUTIVE_SUPERSESSIONS,
  slugsOwedAfterSupersession,
  supersededChain,
  supersessionVerdict,
} from "./parkedDeploySupersession.pure";

/** The two runs measured on 26 Sep 2026, as the table holds them. */
const stalledRun = {
  id: "09857881-0000-4000-8000-000000000000",
  status: "awaiting_validation",
  last_error: "stalled after 30 attempt(s)",
  policy: { reasons: ['run stalled in "executing" for over 20 minutes — its pass did not finish'] },
  result: { failed: [] },
  plan: { slugs: null, source: "cascade" },
};
const exhaustedRun = {
  id: "45045984-0000-4000-8000-000000000000",
  status: "awaiting_validation",
  last_error: null,
  policy: { reasons: ["207 bundle(s) deployed over 30 passes and more remain"] },
  result: { failed: [] },
  plan: { slugs: null, source: "cascade" },
};

describe("supersessionVerdict", () => {
  it("retires a run parked only for running out of attempts to killed passes", () => {
    const verdict = supersessionVerdict(stalledRun);
    expect(verdict).toMatchObject({ supersede: true, chain: [stalledRun.id] });
  });

  it("retires a run parked for running out of passes with bundles still owed", () => {
    expect(supersessionVerdict(exhaustedRun)).toMatchObject({
      supersede: true,
      chain: [exhaustedRun.id],
    });
  });

  it("keeps a run whose last pass failed a bundle — a fresh run would fail it again", () => {
    const verdict = supersessionVerdict({
      ...stalledRun,
      result: { failed: [{ slug: "send-email", error: "400 bundle too large" }] },
    });
    expect(verdict.supersede).toBe(false);
    expect(verdict.why).toContain("could not deploy 1 bundle(s)");
  });

  it("keeps a run whose record of failed bundles cannot be read", () => {
    expect(supersessionVerdict({ ...stalledRun, result: { failed: "some" } }).supersede).toBe(
      false,
    );
  });

  it("keeps a run parked for anything but exhaustion", () => {
    for (const run of [
      {
        ...stalledRun,
        last_error: null,
        policy: { reasons: ["no clone scope — prime functions are not self-deployed"] },
      },
      { ...stalledRun, last_error: "stalled after thirty attempts", policy: null },
      { ...stalledRun, last_error: null, policy: { reasons: ["Needs a person: P1"] } },
      { ...stalledRun, last_error: "prefix: stalled after 3 attempt(s)", policy: {} },
    ]) {
      expect(supersessionVerdict(run)).toMatchObject({ supersede: false });
    }
  });

  it("only ever considers a parked run", () => {
    for (const status of ["planned", "approved", "executing", "succeeded", "failed", "skipped"]) {
      const verdict = supersessionVerdict({ ...stalledRun, status });
      expect(verdict.supersede).toBe(false);
      expect(verdict.why).toContain(status);
    }
  });

  it("stops retiring a chain that keeps parking the same way — a person should look", () => {
    const prior = Array.from({ length: MAX_CONSECUTIVE_SUPERSESSIONS }, (_, i) => `run-${i}`);
    const verdict = supersessionVerdict({
      ...stalledRun,
      plan: { slugs: null, supersedes: prior },
    });
    expect(verdict.supersede).toBe(false);
    expect(verdict.why).toContain("a person should look");
  });

  it("carries the chain forward, oldest first, this run last", () => {
    const verdict = supersessionVerdict({
      ...stalledRun,
      plan: { slugs: null, supersedes: ["first"] },
    });
    expect(verdict).toMatchObject({ supersede: true, chain: ["first", stalledRun.id] });
  });
});

describe("supersededChain", () => {
  it("reads only string ids, and nothing from a plan that has none", () => {
    expect(supersededChain({ supersedes: ["a", 1, null, "b"] })).toEqual(["a", "b"]);
    expect(supersededChain({ supersedes: "a" })).toEqual([]);
    expect(supersededChain(null)).toEqual([]);
    expect(supersededChain([])).toEqual([]);
  });
});

describe("slugsOwedAfterSupersession", () => {
  it("owes the whole fleet where either side did", () => {
    expect(slugsOwedAfterSupersession(null, ["a"])).toBeNull();
    expect(slugsOwedAfterSupersession(["a"], null)).toBeNull();
    expect(slugsOwedAfterSupersession(null, null)).toBeNull();
  });

  it("owes the union of two named lists, once each, in order", () => {
    expect(slugsOwedAfterSupersession(["c", "a"], ["b", "a"])).toEqual(["a", "b", "c"]);
  });
});
