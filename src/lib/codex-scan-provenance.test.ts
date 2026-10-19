import { describe, expect, it } from "vitest";
import {
  compareRulesets,
  normalizeRuleset,
  readScannerCounts,
  readSemgrepRuleset,
  readSuppressionChanges,
} from "./codex-scan-provenance";

const ruleset = (digest: string, files: Array<[string, string]>, source = "registry") => ({
  source,
  digest,
  files: files.map(([name, sha256]) => ({ name, sha256 })),
});

describe("readSuppressionChanges", () => {
  it("reads a pull request's edits and the suppressions it adds", () => {
    expect(
      readSuppressionChanges({
        suppressions: {
          files: [],
          changed: [
            { path: ".gitleaksignore", change: "modified" },
            { path: ".semgrepignore", change: "added" },
            { path: "osv-scanner.toml", change: "removed" },
            { path: "", change: "added" },
            { change: "added" },
            "nonsense",
          ],
          nosemgrep_added: 3,
          gitleaks_allow_added: 1,
        },
      }),
    ).toEqual({
      changed: [
        { path: ".gitleaksignore", change: "modified" },
        { path: ".semgrepignore", change: "added" },
        { path: "osv-scanner.toml", change: "removed" },
      ],
      semgrepIgnoresAdded: 3,
      gitleaksAllowsAdded: 1,
    });
  });

  it("is null when nothing changed, for full scans, and for older workflows", () => {
    expect(
      readSuppressionChanges({ suppressions: { changed: [], nosemgrep_added: 0 } }),
    ).toBeNull();
    expect(readSuppressionChanges({ suppressions: { files: [], nosemgrep: 4 } })).toBeNull();
    expect(readSuppressionChanges({})).toBeNull();
    expect(readSuppressionChanges(null)).toBeNull();
    expect(readSuppressionChanges({ suppressions: { nosemgrep_added: "lots" } })).toBeNull();
  });

  it("treats an unknown change kind as a modification", () => {
    expect(
      readSuppressionChanges({
        suppressions: { changed: [{ path: "a/.semgrepignore", change: "T" }] },
      })?.changed,
    ).toEqual([{ path: "a/.semgrepignore", change: "modified" }]);
  });
});

describe("rulesets", () => {
  it("reads what the workflow recorded and rejects a record with no digest", () => {
    const r = ruleset("abc", [["p.yml", "11"]]);
    expect(readSemgrepRuleset({ rulesets: { semgrep: { ...r, ref: "deadbeef" } } })).toEqual({
      ...r,
      ref: "deadbeef",
    });
    expect(readSemgrepRuleset({ rulesets: null })).toBeNull();
    expect(normalizeRuleset({ source: "registry", files: [] })).toBeNull();
  });

  it("tells same rules from changed ones, file by file", () => {
    const before = normalizeRuleset(
      ruleset("d1", [
        ["a.yml", "1"],
        ["b.yml", "2"],
      ]),
    );
    const same = normalizeRuleset(
      ruleset("d1", [
        ["a.yml", "1"],
        ["b.yml", "2"],
      ]),
    );
    const after = normalizeRuleset(
      ruleset("d2", [
        ["a.yml", "9"],
        ["c.yml", "3"],
      ]),
    );
    expect(compareRulesets(same, before)).toEqual({ status: "same" });
    expect(compareRulesets(after, before)).toEqual({
      status: "changed",
      added: ["c.yml"],
      removed: ["b.yml"],
      modified: ["a.yml"],
      sourceChanged: false,
    });
  });

  it("will not compare what was not fully hashed", () => {
    const hashed = normalizeRuleset(ruleset("d1", [["a.yml", "1"]]));
    const partial = normalizeRuleset(ruleset("d2", [], "registry-unrecorded"));
    expect(compareRulesets(partial, hashed).status).toBe("unknown");
    expect(compareRulesets(hashed, null).status).toBe("unknown");
    expect(compareRulesets(null, hashed).status).toBe("unknown");
  });
});

describe("readScannerCounts", () => {
  it("orders scanners by findings and ignores junk", () => {
    expect(
      readScannerCounts({
        by_scanner: {
          semgrep: { critical: 0, high: 2, medium: 1, low: 0, info: 0 },
          gitleaks: { critical: 1, high: 3, medium: 0, low: 0, info: 5 },
          bogus: "x",
          odd: { high: -4, medium: "2" },
        },
      }),
    ).toEqual([
      {
        scanner: "gitleaks",
        counts: { critical: 1, high: 3, medium: 0, low: 0, info: 5 },
        total: 9,
      },
      {
        scanner: "semgrep",
        counts: { critical: 0, high: 2, medium: 1, low: 0, info: 0 },
        total: 3,
      },
      { scanner: "odd", counts: { critical: 0, high: 0, medium: 2, low: 0, info: 0 }, total: 2 },
    ]);
    expect(readScannerCounts({})).toEqual([]);
  });
});
