import { describe, expect, it } from "vitest";
import {
  REVIEWED_REMEDIATION_MERGE_TITLE,
  SELF_HEALING_MERGE_TITLE,
  parseCascadeSecurityGate,
  securityGateDecision,
} from "./cascade-security-gate";

describe("parseCascadeSecurityGate", () => {
  it("reads unknown values as off", () => {
    expect(parseCascadeSecurityGate("high")).toBe("high");
    expect(parseCascadeSecurityGate("critical")).toBe("critical");
    expect(parseCascadeSecurityGate(undefined)).toBe("off");
    expect(parseCascadeSecurityGate("everything")).toBe("off");
  });
});

describe("securityGateDecision", () => {
  it("never holds while off", () => {
    expect(securityGateDecision("off", { critical: 9, high: 9 })).toEqual({
      hold: false,
      reason: null,
    });
  });

  it("holds on criticals only at the critical setting", () => {
    expect(securityGateDecision("critical", { critical: 0, high: 4 }).hold).toBe(false);
    const d = securityGateDecision("critical", { critical: 1, high: 4 });
    expect(d.hold).toBe(true);
    expect(d.reason).toContain("1 critical open finding.");
  });

  it("counts high and critical at the high setting", () => {
    const d = securityGateDecision("high", { critical: 1, high: 2 });
    expect(d.hold).toBe(true);
    expect(d.reason).toContain("1 critical and 2 high open findings");
    expect(d.reason).toContain("approve this cascade");
  });

  it("treats missing or negative counts as zero", () => {
    expect(securityGateDecision("high", { critical: null, high: -3 }).hold).toBe(false);
  });
});

describe("merge commit titles", () => {
  it("tell an unattended self-healing merge from a reviewed one", () => {
    expect(SELF_HEALING_MERGE_TITLE.test("Self-healing: codex remediation PR #42 (fix eval)")).toBe(
      true,
    );
    expect(REVIEWED_REMEDIATION_MERGE_TITLE.test("Codex remediation #42")).toBe(true);
    expect(SELF_HEALING_MERGE_TITLE.test("Codex remediation #42")).toBe(false);
    expect(REVIEWED_REMEDIATION_MERGE_TITLE.test("fix: Codex remediation #42")).toBe(false);
  });
});
