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
// The branch's own listing. `scopeLabel` became a template literal when
// repository invariants were added to the candidate set, so the anchor is the
// read the candidates are BUILT from rather than the label describing them —
// one listing of each tree since 20 Oct 2026, the widened set selected from
// prime's (`pathsMatchingGlobs`).
const start = engine.indexOf("const [primeRead, cloneRead] = await Promise.allSettled([");
const end = engine.indexOf("const partition = partitionCascadePaths(candidatePaths, exclusions");
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
      /const \[primeRead, cloneRead\] = await Promise\.allSettled\(\[\s*listTreeEntries\(octokit, primeRef\),\s*listTreeEntries\(octokit, cloneRef\),/,
    );
    // And prime's ONCE: the widened candidates are selected from that listing.
    expect(branch).toMatch(
      /candidatePaths = await pathsMatchingGlobs\(\s*primeTree\.entries\.keys\(\),/,
    );
    expect(branch.match(/listTreeEntries\(octokit, primeRef\)/g) ?? []).toHaveLength(1);
  });

  it("narrows the candidates to paths whose blob SHA differs, before anything is read", () => {
    // Or whose executable bit does: `differsFromPrime` asks both, from the
    // listings alone (`treeDelivery.test.ts` pins what it answers).
    const narrowed = branch.indexOf("differsFromPrime(path, primeTree, cloneTree)");
    expect(narrowed).toBeGreaterThan(-1);
    // Before the first content read: the import closure reads prime's text
    // of the candidates, so the candidates are narrowed before it runs.
    const narrowAt = branch.indexOf("candidatePaths = candidatePaths.filter(");
    const firstRead = Math.min(
      ...["await prefetchPrimeText(", "getFileContent("]
        .map((read) => branch.indexOf(read))
        .filter((at) => at > -1),
    );
    expect(narrowAt).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(narrowAt);
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
      branch.indexOf("const { valid } = validateModuleGlobs(installedGlobs);"),
      branch.indexOf("candidatePaths = candidatePaths.filter("),
    );
    expect(decl).toContain("const inInstalledGlobs = globsMatcher(valid);");
    expect(decl).toContain(
      "const primeInScope = new Set(candidatePaths.filter(inInstalledGlobs));",
    );
    expect(decl).not.toMatch(/const primeInScope = new Set\(candidatePaths\);/);
    // And the deletion matcher itself is the same narrow set, never the widened one.
    expect(branch).toMatch(/if \(!inInstalledGlobs\(path\)\) continue;/);
    expect(branch).not.toMatch(/globsMatcher\(\s*globsForModuleScopedClone/);
  });
});
