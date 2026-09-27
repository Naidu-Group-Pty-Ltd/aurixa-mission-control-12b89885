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

  it("skips only a hold nothing can release, and keeps a releasable one for the hold releases", () => {
    // A `protected` or `oversize` hold is never written, so its history is
    // never walked. A `manual_reconcile` hold is NOT dropped here: a file it
    // names is refreshed like any other, the partition holds it, and
    // `decideHoldRelease` releases it on the evidence or an operator's
    // approval — exactly as it would a path inside a module. Dropping every
    // excluded path here is how an approval came to have no effect on a
    // stranded file (Codex, PR #295).
    expect(block).toContain("partitionCascadePaths(");
    expect(block).toContain(
      "const releasable = new Set(approvableHeld(holds).map((h) => h.path));",
    );
    expect(block).toMatch(/holds\.filter\(\(h\) => !releasable\.has\(h\.path\)\)/);
    expect(block).toMatch(/behind\.filter\(\(f\) => !neverWritten\.has\(f\.path\)\)/);
    expect(block).not.toMatch(/!excluded\.has\(/);
  });

  it("walks prime's history at most MAX_STRANDED_PROBES times, skipping what is settled", () => {
    expect(block).toContain("max: MAX_STRANDED_PROBES,");
    expect(block).toMatch(
      /overwriteApproved\.has\(f\.path\) \|\| knownHeldEvidence\.has\(f\.path\)/,
    );
  });

  it("records every settled answer in the held-evidence ledger, keyed by the clone's blob", () => {
    expect(block).toMatch(
      /if \(answer\.kind === "unsettled"\) continue;\s*strandedEvidence\.set\(path, answer\);\s*const clone = cloneShaByPath\.get\(path\);\s*if \(clone\) heldLedger\[path\] = \{ clone, evidence: answer \};/,
    );
  });

  it("adds only what the verdicts refresh to the candidates", () => {
    expect(block).toMatch(
      /const refreshed = strandedRefreshPaths\(strandedVerdicts\);\s*if \(refreshed\.length > 0\) \{\s*candidatePaths = \[\.\.\.candidatePaths, \.\.\.refreshed\];/,
    );
  });
});

describe("a stranded file a manual_reconcile exclusion names meets the hold releases", () => {
  const releases = engine.slice(
    engine.indexOf("const holdReleases: HoldRelease[] = [];"),
    engine.indexOf("const primeFiles = partition.write;"),
  );

  it("finds the hold-release block", () => {
    expect(releases.length).toBeGreaterThan(500);
  });

  it("does not walk again what the refresh walked in this pass", () => {
    expect(releases).toMatch(
      /!overwriteApproved\.has\(h\.path\) &&\s*!knownHeldEvidence\.has\(h\.path\) &&\s*!strandedEvidence\.has\(h\.path\)/,
    );
  });

  it("releases on that same answer", () => {
    expect(releases).toMatch(
      /knownHeldEvidence\.get\(held\.path\) \?\?\s*strandedEvidence\.get\(held\.path\) \?\?\s*evidence\.get\(held\.path\) \?\?\s*null/,
    );
  });
});

describe("what is reported is what landed", () => {
  it("filters refresh verdicts to the writes the delivery carries, reporting a released hold once", () => {
    expect(engine).toMatch(
      /const releasedHolds = new Set\(\s*holdReleases\.filter\(\(r\) => r\.act === "release"\)\.map\(\(r\) => r\.path\),?\s*\);/,
    );
    expect(engine).toMatch(
      /const strandedReported = strandedVerdicts\.filter\(\s*\(v\) => v\.act !== "refresh" \|\| \(landedWrites\.has\(v\.path\) && !releasedHolds\.has\(v\.path\)\),?\s*\);/,
    );
    expect(engine).toContain("strandedSuffixFor(strandedReported)");
    expect(engine).toContain("describeStrandedFunctions(strandedReported)");
  });
});
