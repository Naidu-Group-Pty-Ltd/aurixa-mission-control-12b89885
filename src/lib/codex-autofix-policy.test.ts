import { describe, expect, it } from "vitest";
import {
  AUTOFIX_MAX_ATTEMPTS,
  autofixIneligibility,
  fixEngineFor,
  parseAutofixLimit,
  selectAutofixCandidates,
  type AutofixFinding,
} from "./codex-autofix-policy";

const f = (over: Partial<AutofixFinding> & { id: string }): AutofixFinding => ({
  severity: "medium",
  state: "open",
  scanner: "semgrep",
  first_seen_at: "2026-10-01T00:00:00Z",
  clone_id: null,
  pr_number: null,
  ...over,
});

describe("fixEngineFor", () => {
  it("gives P0 and P1 to Claude, and P2, P3 and info to Codex", () => {
    expect(fixEngineFor("critical")).toBe("claude_code");
    expect(fixEngineFor("high")).toBe("claude_code");
    expect(fixEngineFor("medium")).toBe("codex_cli");
    expect(fixEngineFor("low")).toBe("codex_cli");
    expect(fixEngineFor("info")).toBe("codex_cli");
  });

  it("fixes nothing it cannot place on the scale", () => {
    expect(fixEngineFor("urgent")).toBeNull();
    expect(fixEngineFor("")).toBeNull();
    expect(fixEngineFor(null)).toBeNull();
  });
});

describe("autofixIneligibility", () => {
  it("leaves credentials, clone and PR findings, and decided findings alone", () => {
    expect(autofixIneligibility(f({ id: "a", scanner: "gitleaks", severity: "critical" }))).toMatch(
      /rotate/,
    );
    expect(autofixIneligibility(f({ id: "b", scanner: "gitleaks-history" }))).toMatch(/rotate/);
    expect(autofixIneligibility(f({ id: "c", clone_id: "x" }))).toMatch(/cascade/);
    expect(autofixIneligibility(f({ id: "d", pr_number: 4 }))).toMatch(/pull request/);
    for (const state of ["triaging", "dismissed", "false_positive", "resolved", "fix_drafted"]) {
      expect(autofixIneligibility(f({ id: "e", state }))).toMatch(state);
    }
    expect(autofixIneligibility(f({ id: "g", severity: "info" }))).toBeNull();
    // gitleaks at info is a public value the app needs, not a finding to fix.
    expect(autofixIneligibility(f({ id: "i", scanner: "gitleaks", severity: "info" }))).toMatch(
      /not secret/,
    );
    expect(
      autofixIneligibility(f({ id: "h", scanner: "osv-scanner", severity: "high" })),
    ).toBeNull();
  });
});

describe("selectAutofixCandidates", () => {
  const findings = [
    f({ id: "low-old", severity: "low", first_seen_at: "2026-01-01T00:00:00Z" }),
    f({ id: "crit", severity: "critical", scanner: "osv-scanner" }),
    f({ id: "high-new", severity: "high", first_seen_at: "2026-10-10T00:00:00Z" }),
    f({ id: "high-old", severity: "high", first_seen_at: "2026-09-01T00:00:00Z" }),
    f({ id: "med", severity: "medium" }),
    f({ id: "info-old", severity: "info", first_seen_at: "2025-01-01T00:00:00Z" }),
    f({ id: "secret", severity: "critical", scanner: "gitleaks" }),
  ];

  it("takes the worst and then the oldest first, each with its engine", () => {
    const { picks } = selectAutofixCandidates({
      findings,
      limit: 10,
      inFlight: new Set(),
      failedAttempts: new Map(),
    });
    expect(picks.map((p) => [p.id, p.engine, p.priority])).toEqual([
      ["crit", "claude_code", "P0"],
      ["high-old", "claude_code", "P1"],
      ["high-new", "claude_code", "P1"],
      ["med", "codex_cli", "P2"],
      ["low-old", "codex_cli", "P3"],
      // Last, however old: info uses what the limit leaves.
      ["info-old", "codex_cli", "P4"],
    ]);
  });

  it("stops at tonight's limit and says what it left", () => {
    const { picks, skipped } = selectAutofixCandidates({
      findings,
      limit: 2,
      inFlight: new Set(),
      failedAttempts: new Map(),
    });
    expect(picks.map((p) => p.id)).toEqual(["crit", "high-old"]);
    expect(skipped.filter((s) => s.reason === "over tonight's limit").map((s) => s.id)).toEqual([
      "high-new",
      "med",
      "low-old",
      "info-old",
    ]);
  });

  it("skips a finding with a fix in flight or too many failed attempts", () => {
    const { picks, skipped } = selectAutofixCandidates({
      findings,
      limit: 10,
      inFlight: new Set(["crit"]),
      failedAttempts: new Map([
        ["high-old", AUTOFIX_MAX_ATTEMPTS],
        ["high-new", AUTOFIX_MAX_ATTEMPTS - 1],
      ]),
    });
    expect(picks.map((p) => p.id)).toEqual(["high-new", "med", "low-old", "info-old"]);
    expect(skipped.find((s) => s.id === "crit")?.reason).toMatch(/in flight/);
    expect(skipped.find((s) => s.id === "high-old")?.reason).toMatch(/did not merge/);
  });
});

describe("parseAutofixLimit", () => {
  it("clamps to a sane range and defaults when unset", () => {
    expect(parseAutofixLimit(undefined)).toBe(10);
    expect(parseAutofixLimit("7")).toBe(7);
    expect(parseAutofixLimit(-3)).toBe(0);
    expect(parseAutofixLimit(1000)).toBe(50);
  });
});
