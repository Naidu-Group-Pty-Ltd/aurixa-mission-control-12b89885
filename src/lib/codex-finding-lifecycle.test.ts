import { describe, expect, it } from "vitest";
import {
  absenceThreshold,
  degradedScanners,
  eligibleScanners,
  isScanComplete,
  onAbsent,
  onReported,
  targetKeyFor,
  validateTriage,
} from "./codex-finding-lifecycle";

describe("targetKeyFor", () => {
  it("names Prime, a clone, and either's pull requests", () => {
    expect(targetKeyFor(null)).toBe("prime");
    expect(targetKeyFor("c1")).toBe("c1");
    expect(targetKeyFor(null, 12)).toBe("prime:pr:12");
    expect(targetKeyFor("c1", 7)).toBe("c1:pr:7");
  });
});

describe("onReported", () => {
  it("opens a finding seen for the first time", () => {
    expect(onReported(undefined)).toEqual({ state: "open", event: "first_seen" });
  });

  it("reopens a resolved finding as a regression", () => {
    expect(onReported("resolved", { resolution: "absent" })).toEqual({
      state: "open",
      event: "regression",
    });
  });

  it("leaves a rotated credential resolved — history reports it for ever", () => {
    expect(onReported("resolved", { resolution: "rotated" })).toEqual({
      state: "resolved",
      event: null,
    });
  });

  it("reopens a merged fix the scan still sees, but only after the merge", () => {
    expect(onReported("fix_merged", { mergedBeforeScan: true })).toEqual({
      state: "open",
      event: "fix_ineffective",
    });
    expect(onReported("fix_merged", { mergedBeforeScan: false }).state).toBe("fix_merged");
  });

  it("never overrides a person's verdict", () => {
    expect(onReported("dismissed").state).toBe("dismissed");
    expect(onReported("false_positive").state).toBe("false_positive");
    expect(onReported("triaging").state).toBe("triaging");
  });
});

describe("absence", () => {
  it("never resolves a credential by absence, except on a pull request", () => {
    expect(absenceThreshold("gitleaks")).toBe(Number.POSITIVE_INFINITY);
    expect(absenceThreshold("gitleaks-history")).toBe(Number.POSITIVE_INFINITY);
    expect(absenceThreshold("gitleaks", true)).toBe(1);
  });

  it("needs three clean misses for the AI review, one for deterministic scanners", () => {
    expect(absenceThreshold("codex")).toBe(3);
    expect(absenceThreshold("semgrep")).toBe(1);
    expect(absenceThreshold("osv-scanner")).toBe(1);
  });

  it("records a credential's disappearance without resolving it", () => {
    expect(onAbsent("open", { scanner: "gitleaks", missedScans: 1, firstMiss: true })).toEqual({
      state: "open",
      resolution: null,
      event: "absent_from_tree",
    });
    // Only the first miss is an event.
    expect(
      onAbsent("open", { scanner: "gitleaks", missedScans: 2, firstMiss: false }).event,
    ).toBeNull();
  });

  it("waits out the AI review's threshold", () => {
    expect(onAbsent("open", { scanner: "codex", missedScans: 2 }).state).toBe("open");
    expect(onAbsent("open", { scanner: "codex", missedScans: 3 })).toEqual({
      state: "resolved",
      resolution: "absent",
      event: "auto_resolved",
    });
  });

  it("confirms a merged fix only when the merge preceded the scan", () => {
    expect(
      onAbsent("fix_merged", { scanner: "semgrep", missedScans: 1, mergedBeforeScan: true }),
    ).toEqual({
      state: "resolved",
      resolution: "fixed",
      event: "fix_confirmed",
    });
    expect(
      onAbsent("fix_merged", {
        scanner: "semgrep",
        missedScans: 1,
        mergedBeforeScan: true,
        sameRuleStillInFile: true,
      }).event,
    ).toBe("fix_unconfirmed");
  });

  it("keeps verdicts through absence", () => {
    expect(onAbsent("dismissed", { scanner: "semgrep", missedScans: 5 }).state).toBe("dismissed");
    expect(onAbsent("false_positive", { scanner: "semgrep", missedScans: 5 }).state).toBe(
      "false_positive",
    );
  });
});

describe("which scanners may vouch for an absence", () => {
  it("trusts only a reported status of ok from the current workflow", () => {
    expect(
      eligibleScanners({
        workflow_version: 2,
        scanners: {
          semgrep: { status: "ok" },
          gitleaks: { status: "ok" },
          "osv-scanner": { status: "failed", reason: "the OSV API could not be reached" },
          codex: { status: "skipped" },
        },
      }),
    ).toEqual(["gitleaks", "semgrep"]);
  });

  it("never trusts the legacy ok flag for osv-scanner or the AI pass", () => {
    expect(
      eligibleScanners({
        scanners: {
          semgrep: { ok: true },
          "osv-scanner": { ok: true },
          codex: { ok: true },
          gitleaks: { ok: false },
        },
      }),
    ).toEqual(["semgrep"]);
  });

  it("names degraded scanners with their reason", () => {
    expect(
      degradedScanners({
        workflow_version: 2,
        scanners: {
          semgrep: { status: "ok" },
          "osv-scanner": { status: "failed", reason: "the OSV API could not be reached" },
          codex: { status: "skipped", reason: "not requested" },
        },
      }),
    ).toEqual([{ name: "osv-scanner", reason: "the OSV API could not be reached" }]);
  });

  it("calls a scan complete only when every finding and batch arrived", () => {
    expect(isScanComplete({ expected: 3, observed: 3, callbackFailures: 0 })).toBe(true);
    expect(isScanComplete({ expected: 3, observed: 2, callbackFailures: 0 })).toBe(false);
    expect(isScanComplete({ expected: 3, observed: 3, callbackFailures: 1 })).toBe(false);
    expect(isScanComplete({ expected: null, observed: 0 })).toBe(true);
  });
});

describe("validateTriage", () => {
  it("demands a reason for a verdict", () => {
    expect(validateTriage({ from: "open", to: "dismissed" })).toEqual({
      ok: false,
      error: expect.stringContaining("reason"),
    });
    expect(validateTriage({ from: "open", to: "dismissed", reason: "public anon key" })).toEqual({
      ok: true,
      resolution: null,
    });
  });

  it("resolves a credential only as rotated", () => {
    expect(
      validateTriage({
        from: "open",
        to: "resolved",
        reason: "rotated today",
        scanner: "gitleaks",
      }),
    ).toEqual({
      ok: true,
      resolution: "rotated",
    });
    expect(
      validateTriage({
        from: "open",
        to: "resolved",
        reason: "deleted it",
        scanner: "gitleaks",
        resolution: "manual",
      }).ok,
    ).toBe(false);
  });

  it("refuses resolutions that only scans may set", () => {
    expect(
      validateTriage({
        from: "open",
        to: "resolved",
        reason: "gone",
        scanner: "semgrep",
        resolution: "absent",
      }).ok,
    ).toBe(false);
  });

  it("refuses moves that would orphan a fix in flight", () => {
    expect(validateTriage({ from: "pr_open", to: "resolved", reason: "done" }).ok).toBe(false);
    expect(validateTriage({ from: "pr_open", to: "open" }).ok).toBe(true);
  });

  it("refuses a no-op", () => {
    expect(validateTriage({ from: "triaging", to: "triaging" }).ok).toBe(false);
  });
});
