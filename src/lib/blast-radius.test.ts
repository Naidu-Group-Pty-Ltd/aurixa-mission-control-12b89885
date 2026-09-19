import { describe, it, expect } from "vitest";
import { assessBlastRadius, AUTO_MERGE_THRESHOLD, HIGH_RISK_CLONE_COUNT } from "./blast-radius";

describe("assessBlastRadius", () => {
  it("does not require approval for auto_merge at or below the threshold", () => {
    const r = assessBlastRadius("auto_merge", AUTO_MERGE_THRESHOLD);
    expect(r.requiresApproval).toBe(false);
    expect(r.reason).toBeNull();
  });

  it("requires approval for auto_merge above the threshold", () => {
    const r = assessBlastRadius("auto_merge", AUTO_MERGE_THRESHOLD + 1);
    expect(r.requiresApproval).toBe(true);
    expect(r.reason).toContain("second operator");
  });

  it("does not gate small non-auto_merge cascades", () => {
    expect(assessBlastRadius("pr", AUTO_MERGE_THRESHOLD + 1).requiresApproval).toBe(false);
    expect(assessBlastRadius("notify", HIGH_RISK_CLONE_COUNT).requiresApproval).toBe(false);
  });

  it("requires approval for any mode above the high-risk clone count", () => {
    expect(assessBlastRadius("pr", HIGH_RISK_CLONE_COUNT + 1).requiresApproval).toBe(true);
    expect(assessBlastRadius("notify", HIGH_RISK_CLONE_COUNT + 1).requiresApproval).toBe(true);
  });

  it("echoes the clone count back", () => {
    expect(assessBlastRadius("pr", 7).cloneCount).toBe(7);
  });

  it("defaults to an operator's cascade, so a call site that says nothing keeps the gate", () => {
    expect(assessBlastRadius("auto_merge", AUTO_MERGE_THRESHOLD + 1).requiresApproval).toBe(true);
  });

  it("never gates an automatic cascade on a fleet count, at any size", () => {
    // The 19 Sep 2026 stall: four clones, auto_merge, every prime commit gated.
    expect(assessBlastRadius("auto_merge", 4, "automatic")).toEqual({
      cloneCount: 4,
      requiresApproval: false,
      reason: null,
    });
    // And it must not merely move the cliff — a fleet of a hundred is the
    // scale this rule exists to survive.
    expect(assessBlastRadius("auto_merge", 100, "automatic").requiresApproval).toBe(false);
    expect(assessBlastRadius("pr", HIGH_RISK_CLONE_COUNT + 1, "automatic").requiresApproval).toBe(
      false,
    );
  });

  it("assesses an operator's cascade exactly as it did before the origin existed", () => {
    for (const count of [1, AUTO_MERGE_THRESHOLD, AUTO_MERGE_THRESHOLD + 1, HIGH_RISK_CLONE_COUNT + 1])
      for (const mode of ["auto_merge", "pr", "notify"] as const)
        expect(assessBlastRadius(mode, count, "operator")).toEqual(assessBlastRadius(mode, count));
  });
});
