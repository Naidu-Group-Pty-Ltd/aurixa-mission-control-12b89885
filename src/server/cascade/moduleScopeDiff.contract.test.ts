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
// The branch's own opening line. `scopeLabel` became a template literal when
// repository invariants were added to the candidate set, so the anchor is the
// call that BUILDS the candidates rather than the label describing them.
const start = engine.indexOf("candidatePaths = await listFilesMatchingGlobs(");
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
  it("captures the in-scope set BEFORE the SHA narrowing", () => {
    /*
      Narrowing the candidate list and then asking "which clone paths are not
      candidates?" would call every UNCHANGED prime file a deletion — the one
      direction that destroys something.
    */
    const setAt = branch.indexOf("const primeInScope");
    const narrowAt = branch.indexOf("candidatePaths = candidatePaths.filter(");
    expect(setAt).toBeGreaterThan(-1);
    expect(narrowAt).toBeGreaterThan(-1);
    expect(setAt).toBeLessThan(narrowAt);
    expect(branch).toMatch(/if \(primeInScope\.has\(path\)\) continue;/);
  });

  it("scopes it to the INSTALLED globs, never to the widened candidate list", () => {
    /*
      Repository invariants (`scripts/**`, `.github/workflows/**`,
      `package-lock.json`) widen what a module-scoped clone is SENT, because a
      clone runs the prime's CI and CI reads the whole repository. They must
      never widen what is REMOVED: a `scripts/**` entry inside the destructive
      half would put the clone's own tooling in scope for a pass that was only
      ever asked to add.

      So `primeInScope` is the narrow-glob subset of the widened candidates,
      and taking it wholesale would be the bug.
    */
    const decl = branch.slice(
      branch.indexOf("const primeInScope"),
      branch.indexOf("candidatePaths = candidatePaths.filter("),
    );
    expect(decl).toContain("installedGlobs");
    expect(decl).not.toMatch(/const primeInScope = new Set\(candidatePaths\);/);
    // And the deletion matchers themselves are still built from the narrow set.
    expect(branch).toMatch(/validateModuleGlobs\(installedGlobs\)/);
  });
});
