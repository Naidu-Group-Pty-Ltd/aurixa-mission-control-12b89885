import { describe, expect, it } from "vitest";
import {
  MAX_ANNOTATIONS,
  buildPrCheckReport,
  isBlocking,
  type PrCheckFinding,
} from "./codex-pr-check";

const finding = (over: Partial<PrCheckFinding> = {}): PrCheckFinding => ({
  title: "Use of eval",
  severity: "medium",
  affected_file: "src/app.ts",
  affected_line: 3,
  scanner: "semgrep",
  rule_id: "detect-eval",
  ...over,
});

describe("isBlocking", () => {
  it("blocks at and above the threshold", () => {
    expect(isBlocking("critical", "high")).toBe(true);
    expect(isBlocking("high", "high")).toBe(true);
    expect(isBlocking("medium", "high")).toBe(false);
    expect(isBlocking("info", "low")).toBe(false);
  });

  it("blocks nothing when set to never", () => {
    expect(isBlocking("critical", "never")).toBe(false);
  });
});

describe("buildPrCheckReport", () => {
  it("fails a change that adds a finding at the threshold", () => {
    const r = buildPrCheckReport({
      findings: [finding({ severity: "high" }), finding({ severity: "low", affected_line: 9 })],
      failOn: "high",
      degraded: [],
      incomplete: false,
    });
    expect(r.conclusion).toBe("failure");
    expect(r.title).toBe("1 finding at or above high");
    expect(r.annotations.map((a) => a.annotation_level)).toEqual(["failure", "notice"]);
  });

  it("passes a clean change", () => {
    const r = buildPrCheckReport({ findings: [], failOn: "high", degraded: [], incomplete: false });
    expect(r.conclusion).toBe("success");
    expect(r.title).toBe("No security findings in this change");
  });

  it("never passes a change a scanner could not vouch for", () => {
    const degraded = buildPrCheckReport({
      findings: [],
      failOn: "high",
      degraded: [{ name: "semgrep", reason: "semgrep exited 2" }],
      incomplete: false,
    });
    expect(degraded.conclusion).toBe("neutral");
    expect(degraded.summary).toContain("semgrep exited 2");

    const incomplete = buildPrCheckReport({
      findings: [],
      failOn: "high",
      degraded: [],
      incomplete: true,
    });
    expect(incomplete.conclusion).toBe("neutral");
  });

  it("still fails on a blocking finding even when degraded", () => {
    const r = buildPrCheckReport({
      findings: [finding({ severity: "critical" })],
      failOn: "high",
      degraded: [{ name: "codex", reason: "timed out" }],
      incomplete: true,
    });
    expect(r.conclusion).toBe("failure");
  });

  it("caps annotations at GitHub's limit and skips findings with no line", () => {
    const many = Array.from({ length: MAX_ANNOTATIONS + 20 }, (_, i) =>
      finding({ affected_line: i + 1 }),
    );
    const r = buildPrCheckReport({
      findings: [...many, finding({ affected_line: null })],
      failOn: "never",
      degraded: [],
      incomplete: false,
    });
    expect(r.annotations).toHaveLength(MAX_ANNOTATIONS);
    expect(r.conclusion).toBe("success");
    expect(r.summary).toContain("never to fail");
  });

  it("links back to the scan and the run", () => {
    const r = buildPrCheckReport({
      findings: [],
      failOn: "high",
      degraded: [],
      incomplete: false,
      scanUrl: "https://mc.example/security/scans?job=1",
      runUrl: "https://github.com/a/b/actions/runs/1",
    });
    expect(r.summary).toContain(
      "[Open in Mission Control](https://mc.example/security/scans?job=1)",
    );
    expect(r.summary).toContain("[Scan run log](https://github.com/a/b/actions/runs/1)");
  });
});
