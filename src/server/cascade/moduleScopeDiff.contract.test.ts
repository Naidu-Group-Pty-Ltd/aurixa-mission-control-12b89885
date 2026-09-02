/**
 * A module-scoped cascade reads content only for what changed.
 *
 * Structural — which trees are read, what narrows the candidate list, and
 * what the deletion pass compares against — so asserted against the source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// Read RAW. The usual comment-stripping regex eats from the first `/*` it
// meets, and this file's module globs (`src/**`) carry one inside a string —
// a stripped copy loses the whole branch and every anchor below with it.
const engine = read("src/server/cascade-engine.server.ts");
const start = engine.indexOf('scopeLabel = "installed modules";');
const end = engine.indexOf("const partition = partitionCascadePaths(candidatePaths, exclusions);");
const branch = engine.slice(start, end);

describe("the slice this file reads exists", () => {
  it("finds the module-scope branch", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(branch.length).toBeGreaterThan(300);
  });
});

describe("both trees are read once, and the SHAs decide what is read", () => {
  it("lists the prime tree as well as the clone's", () => {
    /*
      Measured 2 Sep 2026 on `preflight-property-group`: 7,923 files, two
      content reads for every file inside the installed modules, and a pass
      that died every time before a result row started. The mirror branch
      already diffs the trees; this one now does too.
    */
    expect(branch).toMatch(
      /\[primeTree, cloneTree\] = await Promise\.all\(\[\s*listTreeEntries\(octokit, primeRef\),\s*listTreeEntries\(octokit, cloneRef\),/,
    );
  });

  it("narrows the candidates to paths whose blob SHA differs, before anything is read", () => {
    const narrowed = branch.indexOf("cloneTree.entries.get(path) !== primeTree.entries.get(path)");
    expect(narrowed).toBeGreaterThan(-1);
    // Before the partition, which is the last thing before content is read.
    expect(branch.indexOf("candidatePaths = candidatePaths.filter(")).toBeLessThan(
      branch.indexOf("validateModuleGlobs(installedGlobs)"),
    );
  });

  it("does not narrow on a truncated tree — a file not listed is not a file unchanged", () => {
    expect(branch).toMatch(
      /if \(!primeTree\.truncated && !cloneTree\.truncated\) \{\s*candidatePaths = candidatePaths\.filter\(/,
    );
  });
});

describe("the deletion pass still sees the module's whole section on prime", () => {
  it("compares clone paths against every prime path in scope, not the narrowed list", () => {
    /*
      Narrowing the candidate list and then asking "which clone paths are not
      candidates?" would call every UNCHANGED prime file a deletion — the one
      direction that destroys something.
    */
    expect(branch).toContain("const primeInScope = new Set(candidatePaths);");
    const setAt = branch.indexOf("const primeInScope = new Set(candidatePaths);");
    const narrowAt = branch.indexOf("candidatePaths = candidatePaths.filter(");
    expect(setAt).toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(narrowAt);
    expect(branch).toMatch(/if \(primeInScope\.has\(path\)\) continue;/);
    expect(branch).not.toMatch(/const inScope = new Set\(candidatePaths\)/);
  });
});
