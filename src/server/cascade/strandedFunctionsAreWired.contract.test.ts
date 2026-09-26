/**
 * The stranded-function refresh is WIRED, and wired where its safety argument
 * says it must be.
 *
 * `strandedFunctions.pure.ts` decides; the engine places. The placement is the
 * argument — above the import closure so a refreshed handler brings what it
 * imports, above `partitionCascadePaths` so the exclusions hold it as they
 * would inside a module, below the ledger so a settled answer is never asked
 * twice — and none of that is visible to a unit test of the pure module, so it
 * is asserted against the source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Read RAW: the engine's globs carry a `/*` inside a string, and a naive
// comment strip would eat everything after it.
const engine = readFileSync(join(process.cwd(), "src/server/cascade-engine.server.ts"), "utf8");

const at = (needle: string) => {
  const i = engine.indexOf(needle);
  expect(i, `missing anchor: ${needle}`).toBeGreaterThan(-1);
  return i;
};

describe("the widened scope is what a function is stranded FROM", () => {
  it("is captured from the widened listing, before the tree narrowing", () => {
    const listed = at("globsForModuleScopedClone(installedGlobs),");
    const captured = at("widenedScope = new Set(candidatePaths);");
    const narrowed = at(
      "candidatePaths = candidatePaths.filter(\n        (path) => cloneTree.entries.get(path) !== primeTree.entries.get(path),",
    );
    expect(captured).toBeGreaterThan(listed);
    expect(captured).toBeLessThan(narrowed);
  });

  it("is null on a mirror, whose scope is the whole tree", () => {
    expect(engine).toMatch(/let widenedScope: ReadonlySet<string> \| null = null;/);
    // Only the module-scoped branch assigns it.
    expect(engine.match(/widenedScope = new Set\(/g)).toHaveLength(1);
  });
});

describe("the refresh runs where its safety argument says", () => {
  const ledger = () => at("const knownHeldEvidence = resume");
  const approvals = () => at('.from("cascade_path_approvals")');
  const refresh = () => at("const strandedVerdicts: StrandedVerdict[] = [];");
  const closure = () =>
    at("const closureAdded = await closeOver(candidatePaths, new Set(candidatePaths));");
  const partition = () =>
    at("const partition = partitionCascadePaths(candidatePaths, exclusions);");

  it("after the ledger and the approvals it reads", () => {
    expect(refresh()).toBeGreaterThan(ledger());
    expect(refresh()).toBeGreaterThan(approvals());
  });

  it("before the import closure, so a refreshed handler brings what it imports", () => {
    expect(refresh()).toBeLessThan(closure());
  });

  it("before the partition, so the exclusions hold a refreshed file as they would any other", () => {
    expect(refresh()).toBeLessThan(partition());
  });

  it("before the hold releases, which read the same ledger", () => {
    expect(refresh()).toBeLessThan(at("const holdReleases: HoldRelease[] = [];"));
  });
});

describe("what the refresh block does", () => {
  const block = engine.slice(
    engine.indexOf("const strandedVerdicts: StrandedVerdict[] = [];"),
    engine.indexOf("PRIME'S TEXT, READ ONCE AND EIGHTY AT A TIME."),
  );

  it("exists", () => {
    expect(block.length).toBeGreaterThan(500);
  });

  it("runs only on a module-scoped clone with both trees listed complete", () => {
    expect(block).toMatch(
      /if \(widenedScope !== null && primeShaByPath !== null && cloneShaByPath !== null\)/,
    );
  });

  it("leaves a file an exclusion names to that exclusion", () => {
    expect(block).toContain("partitionCascadePaths(");
    expect(block).toMatch(/behind\.filter\(\(f\) => !excluded\.has\(f\.path\)\)/);
  });

  it("walks prime's history at most MAX_STRANDED_PROBES times, skipping what is settled", () => {
    expect(block).toContain("max: MAX_STRANDED_PROBES,");
    expect(block).toMatch(
      /overwriteApproved\.has\(f\.path\) \|\| knownHeldEvidence\.has\(f\.path\)/,
    );
  });

  it("records every settled answer in the held-evidence ledger, keyed by the clone's blob", () => {
    expect(block).toMatch(
      /if \(answer\.kind === "unsettled"\) continue;\s*const clone = cloneShaByPath\.get\(path\);\s*if \(clone\) heldLedger\[path\] = \{ clone, evidence: answer \};/,
    );
  });

  it("adds only what the verdicts refresh to the candidates", () => {
    expect(block).toMatch(
      /const refreshed = strandedRefreshPaths\(strandedVerdicts\);\s*if \(refreshed\.length > 0\) \{\s*candidatePaths = \[\.\.\.candidatePaths, \.\.\.refreshed\];/,
    );
  });
});

describe("what is reported is what landed", () => {
  it("filters refresh verdicts to the writes the delivery carries", () => {
    expect(engine).toMatch(
      /const strandedReported = strandedVerdicts\.filter\(\s*\(v\) => v\.act !== "refresh" \|\| landedWrites\.has\(v\.path\),\s*\);/,
    );
    expect(engine).toContain("strandedSuffixFor(strandedReported)");
    expect(engine).toContain("describeStrandedFunctions(strandedReported)");
  });
});
