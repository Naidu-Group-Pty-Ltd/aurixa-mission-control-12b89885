import { describe, expect, it } from "vitest";
import { assessSqlDestructiveness } from "./destructive-sql";
import {
  AUTO_MERGE_MAX_FILES,
  AUTO_MERGE_MAX_LINES,
  decideFixMerge,
  decideRemediation,
} from "./remediation-policy";

const verifiedSmallPatch = {
  verified: true,
  secretsClean: true,
  filesChanged: 2,
  linesChanged: 40,
} as const;

describe("decideRemediation", () => {
  it("never auto-executes a P0 or P1 action other than a security fix, even a perfect one", () => {
    for (const priority of ["P0", "P1"] as const) {
      for (const actionType of ["sql_migration", "edge_function_deploy"] as const) {
        const d = decideRemediation({ actionType, priority, sqlAssessedByLane: true });
        expect(d.autoExecute).toBe(false);
        expect(d.requiresHuman).toBe(true);
      }
    }
  });

  it("auto-merges a verified, bounded security fix at every priority", () => {
    for (const priority of ["P0", "P1", "P2", "P3", "P4"] as const) {
      const d = decideRemediation({ actionType: "pr_merge", priority, ...verifiedSmallPatch });
      expect(d.autoExecute).toBe(true);
    }
  });

  it("does not merge an unverified patch", () => {
    const d = decideRemediation({
      actionType: "pr_merge",
      priority: "P3",
      ...verifiedSmallPatch,
      verified: false,
    });
    expect(d.autoExecute).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/own checks/);
  });

  it("parks a patch whose secret scan failed", () => {
    const d = decideRemediation({
      actionType: "pr_merge",
      priority: "P3",
      ...verifiedSmallPatch,
      secretsClean: false,
    });
    expect(d.autoExecute).toBe(false);
  });

  it("parks a patch of unknown size", () => {
    const d = decideRemediation({
      actionType: "pr_merge",
      priority: "P2",
      verified: true,
      secretsClean: true,
      filesChanged: null,
      linesChanged: null,
    });
    expect(d.autoExecute).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/unknown/);
  });

  it("enforces the diff ceilings exactly", () => {
    const atCeiling = decideRemediation({
      actionType: "pr_merge",
      priority: "P2",
      verified: true,
      secretsClean: true,
      filesChanged: AUTO_MERGE_MAX_FILES,
      linesChanged: AUTO_MERGE_MAX_LINES,
    });
    expect(atCeiling.autoExecute).toBe(true);

    const tooManyFiles = decideRemediation({
      actionType: "pr_merge",
      priority: "P2",
      verified: true,
      secretsClean: true,
      filesChanged: AUTO_MERGE_MAX_FILES + 1,
      linesChanged: 10,
    });
    expect(tooManyFiles.autoExecute).toBe(false);

    const tooManyLines = decideRemediation({
      actionType: "pr_merge",
      priority: "P2",
      verified: true,
      secretsClean: true,
      filesChanged: 1,
      linesChanged: AUTO_MERGE_MAX_LINES + 1,
    });
    expect(tooManyLines.autoExecute).toBe(false);
  });

  it("auto-applies clean SQL and parks destructive SQL with the offending reasons", () => {
    const clean = decideRemediation({
      actionType: "sql_migration",
      priority: "P2",
      sqlAssessment: assessSqlDestructiveness(
        "ALTER TABLE public.t ADD COLUMN IF NOT EXISTS x TEXT;",
      ),
    });
    expect(clean.autoExecute).toBe(true);

    const dirty = decideRemediation({
      actionType: "sql_migration",
      priority: "P2",
      sqlAssessment: assessSqlDestructiveness("DROP TABLE public.t;"),
    });
    expect(dirty.autoExecute).toBe(false);
    expect(dirty.reasons.join(" ")).toMatch(/drops a table/);
  });

  it("parks SQL that was never assessed", () => {
    const d = decideRemediation({ actionType: "sql_migration", priority: "P3" });
    expect(d.autoExecute).toBe(false);
  });

  it("lets the lane hold the assessment when the caller says so", () => {
    // The lane loads every pending body immediately before applying it, which
    // is a stronger check than one taken at plan time: the prime moves between
    // planning and executing, and the SQL that runs is the SQL that matters.
    const d = decideRemediation({
      actionType: "sql_migration",
      priority: "P3",
      sqlAssessedByLane: true,
    });
    expect(d.autoExecute).toBe(true);
    expect(d.reasons.join(" ")).toMatch(/before it applies/);
  });

  it("still refuses destructive SQL that was already assessed, deferral or not", () => {
    // Order matters. Reading the deferral first would let a caller that has
    // ALREADY been told the batch is destructive hand it to the lane anyway.
    const d = decideRemediation({
      actionType: "sql_migration",
      priority: "P2",
      sqlAssessedByLane: true,
      sqlAssessment: assessSqlDestructiveness("DROP TABLE public.t;"),
    });
    expect(d.autoExecute).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/drops a table/);
  });

  it("never lets the deferral outrank the priority line", () => {
    const d = decideRemediation({
      actionType: "sql_migration",
      priority: "P0",
      sqlAssessedByLane: true,
    });
    expect(d.autoExecute).toBe(false);
  });

  it("treats monitoring and rescans as always safe, even at P0", () => {
    expect(decideRemediation({ actionType: "monitor_recovery", priority: "P0" }).autoExecute).toBe(
      true,
    );
    expect(decideRemediation({ actionType: "rescan", priority: "P1" }).autoExecute).toBe(true);
  });

  it("auto-deploys function bundles at P2 and below only", () => {
    expect(
      decideRemediation({ actionType: "edge_function_deploy", priority: "P2" }).autoExecute,
    ).toBe(true);
    expect(
      decideRemediation({ actionType: "edge_function_deploy", priority: "P1" }).autoExecute,
    ).toBe(false);
  });

  it("never marks manual actions as auto", () => {
    const d = decideRemediation({ actionType: "manual", priority: "P4" });
    expect(d.autoExecute).toBe(false);
  });
});

describe("decideFixMerge", () => {
  it("merges a verified, clean, bounded fix", () => {
    expect(decideFixMerge(verifiedSmallPatch)).toEqual({
      merge: true,
      reasons: ["verified patch within auto-merge bounds (2 files, 40 lines)"],
    });
  });

  it("says why an unverified fix does not merge", () => {
    expect(decideFixMerge({ ...verifiedSmallPatch, verified: false }).reasons[0]).toMatch(
      /failed the repository's own checks/,
    );
    expect(decideFixMerge({ ...verifiedSmallPatch, verified: null }).reasons[0]).toMatch(
      /no passing verification/,
    );
  });

  it("never merges a fix that adds a secret, or one too large or of unknown size", () => {
    expect(decideFixMerge({ ...verifiedSmallPatch, secretsClean: false }).merge).toBe(false);
    expect(decideFixMerge({ ...verifiedSmallPatch, filesChanged: null }).merge).toBe(false);
    expect(
      decideFixMerge({ ...verifiedSmallPatch, linesChanged: AUTO_MERGE_MAX_LINES + 1 }).merge,
    ).toBe(false);
    expect(
      decideFixMerge({ ...verifiedSmallPatch, filesChanged: AUTO_MERGE_MAX_FILES + 1 }).merge,
    ).toBe(false);
  });
});
