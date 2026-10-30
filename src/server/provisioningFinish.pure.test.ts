import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "./sourceComments.pure";
import {
  FINISHING_STEP_NEEDS_MS,
  PARITY_DEFERRED_REASON,
  deferredLine,
  finishingStepFits,
  type FinishingStep,
} from "./provisioningFinish.pure";

const NOW = Date.parse("2026-10-30T01:33:37Z");
const STEPS: FinishingStep[] = ["cloneOwnedFunctions", "anthropicWorkspace", "llmKeys", "parity"];

describe("a finishing step starts only when it fits", () => {
  it("fits with its need left before the deadline, and not a millisecond less", () => {
    for (const step of STEPS) {
      const need = FINISHING_STEP_NEEDS_MS[step];
      expect(finishingStepFits(step, NOW + need, NOW)).toBe(true);
      expect(finishingStepFits(step, NOW + need - 1, NOW)).toBe(false);
    }
  });

  it("never fits once the deadline has passed", () => {
    for (const step of STEPS) expect(finishingStepFits(step, NOW - 1, NOW)).toBe(false);
  });

  it("always fits for a caller with no budget, which is how every step ran before", () => {
    for (const step of STEPS) {
      expect(finishingStepFits(step, null, NOW)).toBe(true);
      expect(finishingStepFits(step, undefined, NOW)).toBe(true);
    }
  });

  it("left the demo's pass no room for the clone-owned deploy", () => {
    /* 30 Oct 2026: the pipeline returned 32 s into a 50 s budget and the
       re-point took about 16 s more, leaving two. The deploy began anyway and
       the pass was killed before `ready`. */
    const deadline = NOW - 32_000 + 50_000;
    expect(finishingStepFits("cloneOwnedFunctions", deadline, NOW + 16_000)).toBe(false);
  });
});

describe("a deferred step says who finishes it", () => {
  it("names the lane that will", () => {
    expect(deferredLine("cloneOwnedFunctions")).toMatch(/half-hourly backend catch-up/);
    expect(deferredLine("anthropicWorkspace")).toMatch(/secrets reconcile/);
    expect(deferredLine("llmKeys")).toMatch(/secrets reconcile/);
    expect(deferredLine("parity")).toMatch(/without the comparison/);
    for (const step of STEPS) expect(deferredLine(step)).toMatch(/no time left/);
  });
});

describe("the runner budgets its finishing steps", () => {
  const runner = stripComments(readFileSync("src/lib/backend-provisioning.functions.ts", "utf8"));

  it("hands the re-point the deadline, and pauses outside its catch when it stopped", () => {
    const call = runner.indexOf("await retargetCloneRepo(");
    expect(runner.slice(call, call + 900)).toMatch(
      /shouldStop: \(\) => pastDeadline\(input\.deadlineAt\)/,
    );
    const pause = runner.indexOf("if (repoRetarget?.stoppedEarly)");
    expect(pause).toBeGreaterThan(call);
    expect(runner.slice(pause, pause + 200)).toMatch(/throw new FinishPause\(/);
    // Outside the step's own catch: the catch records a failure and runs on.
    const catchAt = runner.indexOf("Repository re-target failed:");
    expect(catchAt).toBeGreaterThan(call);
    expect(pause).toBeGreaterThan(catchAt);
    // And before anything that would go on to `ready`.
    expect(pause).toBeLessThan(runner.indexOf("await deployCloneOwnedFunctions("));
  });

  it("starts each step another lane also performs only when it fits", () => {
    for (const [step, call] of [
      ["cloneOwnedFunctions", "await deployCloneOwnedFunctions("],
      ["anthropicWorkspace", "await provisionAnthropicWorkspace("],
      ["llmKeys", "await provisionLlmKeys("],
      ["parity", "await computeParity("],
    ] as const) {
      const gate = runner.indexOf(`finishingStepFits("${step}", input.deadlineAt, Date.now())`);
      const at = runner.indexOf(call);
      expect(gate, step).toBeGreaterThan(-1);
      expect(at, step).toBeGreaterThan(gate);
      expect(runner.indexOf(`deferredLine("${step}")`), step).toBeGreaterThan(at);
    }
  });

  it("marks the backend ready whatever was deferred, and says when parity was", () => {
    const ready = runner.indexOf('status: "ready" as const');
    expect(ready).toBeGreaterThan(runner.indexOf('deferredLine("parity")'));
    expect(runner).toMatch(/parityError = PARITY_DEFERRED_REASON;/);
    expect(runner.slice(0, ready)).not.toMatch(/finishingStepFits\("ready"/);
    expect(PARITY_DEFERRED_REASON).toMatch(/no time left/);
  });
});
