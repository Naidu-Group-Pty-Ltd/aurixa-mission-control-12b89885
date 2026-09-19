import { describe, it, expect } from "vitest";
import {
  reassessGate,
  planGateReassessment,
  originForTrigger,
  dischargeSummary,
  type RecordedGate,
} from "./gateReassessment.pure";
import { AUTO_MERGE_THRESHOLD, HIGH_RISK_CLONE_COUNT } from "@/lib/blast-radius";

function gate(over: Partial<RecordedGate> = {}): RecordedGate {
  return {
    id: "06b76567-ed13-4391-ad41-e931846c0e27",
    trigger: "commit",
    mode: "auto_merge",
    requires_approval: true,
    approved_at: null,
    ...over,
  };
}

describe("originForTrigger", () => {
  it("reads a commit trigger as automatic and every other word as an operator's", () => {
    expect(originForTrigger("commit")).toBe("automatic");
    expect(originForTrigger("manual")).toBe("operator");
    expect(originForTrigger("scheduled")).toBe("operator");
    // A trigger word this build has never heard of is an operator's: the
    // conservative side, because it keeps the gate rather than clearing one.
    expect(originForTrigger("something_new")).toBe("operator");
  });
});

describe("reassessGate", () => {
  it("has nothing to ask of an event that was never gated", () => {
    expect(reassessGate(gate({ requires_approval: false }), 4)).toEqual({ act: "ungated" });
  });

  it("never re-derives over a person's approval", () => {
    const approved = gate({ approved_at: "2026-09-19T07:00:00.000Z" });
    expect(reassessGate(approved, 4)).toEqual({ act: "approved" });
    // Even where the current rule would discharge it anyway, the human act is
    // what the row records — this must not rewrite its story.
    expect(reassessGate(approved, 1)).toEqual({ act: "approved" });
  });

  it("discharges the eight stuck commit cascades measured on 19 Sep 2026", () => {
    const verdict = reassessGate(gate(), 4);
    expect(verdict.act).toBe("discharge");
    if (verdict.act !== "discharge") throw new Error("unreachable");
    expect(verdict.summary).toContain("4 clone(s)");
    expect(verdict.summary).toContain("automatic");
    expect(verdict.summary).toContain("No approval was recorded and none was owed");
  });

  it("leaves an operator's wide auto-merge gated", () => {
    const verdict = reassessGate(
      gate({ trigger: "manual" }),
      AUTO_MERGE_THRESHOLD + 1,
    );
    expect(verdict.act).toBe("stands");
    if (verdict.act !== "stands") throw new Error("unreachable");
    expect(verdict.reason).toContain("second operator");
  });

  it("leaves a scheduled cascade above the high-risk count gated", () => {
    expect(
      reassessGate(gate({ trigger: "scheduled", mode: "pr" }), HIGH_RISK_CLONE_COUNT + 1).act,
    ).toBe("stands");
  });

  it("discharges an operator's cascade once the fleet has shrunk below the threshold", () => {
    // The relaxing direction only: the count is what the rule reads, and a
    // fleet of two does not need two operators by the rule's own terms.
    expect(reassessGate(gate({ trigger: "manual" }), 2).act).toBe("discharge");
  });

  it("never adds a gate to an event that did not carry one", () => {
    // A hundred clones is far past both thresholds. An ungated row stays ungated:
    // re-gating mid-queue stops work somebody is waiting on at a moment nobody chose.
    expect(reassessGate(gate({ requires_approval: false, trigger: "manual" }), 100)).toEqual({
      act: "ungated",
    });
  });
});

describe("planGateReassessment", () => {
  it("separates what it clears from what it leaves standing", () => {
    const plan = planGateReassessment(
      [
        gate({ id: "a" }),
        gate({ id: "b", trigger: "manual" }),
        gate({ id: "c", requires_approval: false }),
        gate({ id: "d", approved_at: "2026-09-19T07:00:00.000Z" }),
      ],
      4,
    );
    expect(plan.discharge.map((d) => d.id)).toEqual(["a"]);
    expect(plan.stood).toBe(1);
  });

  it("carries one summary per discharged event", () => {
    const plan = planGateReassessment([gate({ id: "a" }), gate({ id: "b" })], 4);
    expect(plan.discharge).toHaveLength(2);
    for (const d of plan.discharge) expect(d.summary).toBe(dischargeSummary(4, "automatic"));
  });

  it("is empty on an empty queue rather than throwing", () => {
    expect(planGateReassessment([], 4)).toEqual({ discharge: [], stood: 0 });
  });
});
