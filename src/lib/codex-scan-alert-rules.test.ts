import { describe, expect, it } from "vitest";
import {
  consecutiveFailureStreak,
  newFindingAlert,
  type AlertFinding,
} from "./codex-scan-alert-rules";

const f = (over: Partial<AlertFinding> = {}): AlertFinding => ({
  event: "first_seen",
  title: "Use of eval",
  severity: "medium",
  secret: false,
  ...over,
});

describe("newFindingAlert", () => {
  it("stays quiet for what can wait for the explorer", () => {
    expect(newFindingAlert("Prime", [])).toBeNull();
    expect(
      newFindingAlert("Prime", [
        f({ severity: "high" }),
        f({ severity: "medium" }),
        f({ secret: true, severity: "medium" }),
        f({ event: "regression", severity: "medium" }),
      ]),
    ).toBeNull();
  });

  it("raises an error for a new critical or a newly exposed credential", () => {
    const a = newFindingAlert("Prime", [
      f({ severity: "critical", title: "SQL injection" }),
      f({ secret: true, severity: "high", title: "Stripe key" }),
    ]);
    expect(a?.severity).toBe("error");
    expect(a?.title).toBe("Prime: 1 new critical finding, 1 newly exposed secret");
    expect(a?.counts).toEqual({ new_critical: 1, new_secrets: 1, regressions: 0, ineffective: 0 });
    // The credential first, and what to do about it.
    expect(a?.body.split("\n")[0]).toContain("Stripe key");
    expect(a?.body).toMatch(/rotate it/);
  });

  it("warns for regressions and fixes that did not work", () => {
    const a = newFindingAlert("acme-clone", [
      f({ event: "regression", severity: "high", title: "XSS" }),
      f({ event: "fix_ineffective", severity: "low", title: "Weak hash" }),
    ]);
    expect(a?.severity).toBe("warning");
    expect(a?.title).toBe("acme-clone: 1 regression, 1 merged fix that did not work");
    expect(a?.body).toContain("XSS (came back)");
    expect(a?.body).toContain("Weak hash (fix did not work)");
  });

  it("lists at most five and says how many more", () => {
    const many = Array.from({ length: 7 }, (_, i) => f({ severity: "critical", title: `C${i}` }));
    const a = newFindingAlert("Prime", many);
    expect(a?.title).toBe("Prime: 7 new critical findings");
    expect(a?.body.split("\n")).toHaveLength(6);
    expect(a?.body).toContain("…and 2 more");
  });
});

describe("consecutiveFailureStreak", () => {
  it("counts the leading run of failures, newest first", () => {
    expect(consecutiveFailureStreak([true, true, true, false, true])).toBe(3);
    expect(consecutiveFailureStreak([false, true, true])).toBe(0);
    expect(consecutiveFailureStreak([])).toBe(0);
  });

  it("ends the streak at anything unknown", () => {
    expect(consecutiveFailureStreak([true, null, true])).toBe(1);
    expect(consecutiveFailureStreak([true, true, undefined])).toBe(2);
  });
});
