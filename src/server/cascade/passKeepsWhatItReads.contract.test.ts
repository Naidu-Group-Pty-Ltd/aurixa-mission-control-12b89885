import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripNonCode } from "./heldFileStaleness.pure";

/**
 * F21's remedy 1, from F27's second reading (20 Oct 2026).
 *
 * The CRM line's traced pass entered `specs` at 40.8 s, spent 27.9 s there,
 * and was ended after entering `recount` — every pass, so the line received
 * nothing. Replayed against the same two trees (prime@adb6bc5, the line at
 * `2a26ddc`), a whole pass was 361 GitHub requests and 22 s of the engine's
 * own CPU, and three things kept it from ever finishing:
 *
 *  - what the spec channel paid for (99 of its 111 requests) was written to
 *    the ledger only by the tree's pause, which a pass ended before the tree
 *    never reached, so each pass asked the same questions again;
 *  - the clock decided what the channel delivered, so passes reaching it a
 *    moment apart wrote different trees and a kept tree chain restarted;
 *  - reads the listings already answered, and texts re-read on every round.
 *
 * These pin the wiring of each answer. The pure halves are tested beside
 * their modules (`memoSourceReadings`, `globsMatcher`).
 */
const engine = stripNonCode(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

function between(from: string, to: string, after = 0): string {
  const a = engine.indexOf(from, after);
  expect(a, `not found: ${from}`).toBeGreaterThan(-1);
  const b = engine.indexOf(to, a);
  expect(b, `not found after ${from}: ${to}`).toBeGreaterThan(a);
  return engine.slice(a, b);
}

describe("prime's tree is listed once on a module-scoped clone", () => {
  const scoped = () =>
    between(
      "const { REPOSITORY_INVARIANTS, globsForModuleScopedClone } =",
      "const overwriteApproved = new Set<string>();",
    );

  it("selects the widened set from the listing it diffs against", () => {
    // `listFilesMatchingGlobs` read the branch and the same recursive tree a
    // second time: two requests and 11,712 entries, about three seconds.
    expect(engine).not.toContain("listFilesMatchingGlobs(");
    expect(scoped()).toMatch(
      /candidatePaths = await pathsMatchingGlobs\(\s*primeTree\.entries\.keys\(\),\s*globsForModuleScopedClone\(installedGlobs\),?\s*\)/,
    );
    expect(scoped().match(/listTreeEntries\(octokit, primeRef\)/g) ?? []).toHaveLength(1);
  });

  it("raises a failed prime listing as that call raised it, so a rate limit keeps its headers", () => {
    expect(scoped()).toContain('if (primeRead.status === "rejected") throw primeRead.reason;');
    expect(scoped()).toMatch(
      /if \(cloneRead\.status === "rejected"\) \{[\s\S]{0,200}Cannot read the prime or clone tree/,
    );
  });

  it("asks the installed globs as one matcher, of the section and of the deletions alike", () => {
    expect(scoped()).toContain("const inInstalledGlobs = globsMatcher(valid);");
    expect(scoped()).toContain("new Set(candidatePaths.filter(inInstalledGlobs))");
    expect(scoped()).toContain("if (!inInstalledGlobs(path)) continue;");
    expect(scoped()).not.toContain("matchers.some(");
  });

  it("keeps the clone's sizes and modes with its blob ids, in both scopes", () => {
    expect(engine.match(/cloneSizeByPath = cloneTree\.sizes;/g) ?? []).toHaveLength(2);
    expect(engine.match(/cloneModeByPath = cloneTree\.modes;/g) ?? []).toHaveLength(2);
  });
});

describe("the clone is asked only what its listing cannot answer", () => {
  it("answers a path the complete listing does not hold, before any request", () => {
    const reader = between("const readCloneText = async", "const deletionSurvivors = async");
    const listing = reader.indexOf("if (cloneShaByPath !== null && !cloneShaByPath.has(path)) {");
    const request = reader.indexOf("await getFileContent(octokit, cloneRef, path)");
    expect(listing).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(listing);
  });

  it("reads ahead by blob id, and leaves anything a batch does not answer to the per-file read", () => {
    const ahead = between("const prefetchCloneText = async", "const readCloneText = async");
    expect(ahead).toContain("const sha = cloneShaByPath.get(path);");
    expect(ahead).toMatch(/if \(sha === undefined\) \{\s*cloneTexts\.set\(path, null\);/);
    expect(ahead).toContain("if (!isBatchableTextMode(cloneModeByPath.get(path))) continue;");
    expect(ahead).toContain("await readBlobTextsBatched(octokit, cloneRef, wants)");
    // An unanswered path is simply not set, so `readCloneText` reads it.
    expect(ahead).not.toContain("getFileContent(");
  });

  it("reads the survivors ahead before asking them one at a time", () => {
    const survivors = between("const deletionSurvivors = async", "const withholdStillReferenced");
    const ahead = survivors.indexOf("await prefetchCloneText(reading);");
    const each = survivors.indexOf("reading.map(async (path) => {");
    expect(ahead).toBeGreaterThan(-1);
    expect(each).toBeGreaterThan(ahead);
  });

  it("reads each round's newly kept survivors ahead too", () => {
    const loop = between("const withholdStillReferenced = async", "if (pendingDeletes.length > 0)");
    const ahead = loop.indexOf("await prefetchCloneText(unread);");
    const each = loop.indexOf("unread.map(async (path) => {");
    expect(ahead).toBeGreaterThan(-1);
    expect(each).toBeGreaterThan(ahead);
  });
});

describe("the reference check reads both sides' held copies by blob id first", () => {
  const block = () => between('markPhase("references");', "const missingSuffix =");

  it("reads both sides ahead before the per-file reads", () => {
    const ahead = block().indexOf(
      "await Promise.all([prefetchCloneText(heldSourcePaths), prefetchPrimeText(heldSourcePaths)]);",
    );
    const perFile = block().indexOf("await getFileContent(octokit, primeRef, path)");
    expect(ahead).toBeGreaterThan(-1);
    expect(perFile).toBeGreaterThan(ahead);
  });

  it("takes prime's proved text, and never asks for a path prime's listing does not hold", () => {
    const b = block();
    const cached = b.indexOf("const batched = exactPrimeText.get(path);");
    const absent = b.indexOf("if (!primeHolds(path)) return;");
    const perFile = b.indexOf("await getFileContent(octokit, primeRef, path)");
    expect(cached).toBeGreaterThan(-1);
    expect(absent).toBeGreaterThan(cached);
    expect(perFile).toBeGreaterThan(absent);
    expect(b).toContain(
      "const primeHolds = (path: string) => primeShaByPath === null || primeShaByPath.has(path);",
    );
  });
});

describe("the spec channel keeps what it paid for", () => {
  const channel = () => between('markPhase("specs");', 'markPhase("recount");');

  it("writes the ledger only where it holds something the last write did not", () => {
    const keep = between(
      "const keepLedger = async",
      "const attemptedSubjects = new Set<string>();",
    );
    const grew = keep.indexOf("if (!ledgerGrew(ledgerKept, progress)) return;");
    const write = keep.indexOf("await resume.onProgress(progress);");
    const record = keep.indexOf("ledgerKept = JSON.parse(JSON.stringify(progress))");
    expect(grew).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(grew);
    expect(record).toBeGreaterThan(write);
    // Past its window a pass may be ended at any moment; before it, the one
    // write at the channel's end is enough.
    expect(keep).toContain(
      'if (only === "past the window" && !resume.budget?.isPastDeadline(0)) return;',
    );
  });

  it("keeps the ledger once the channel is done, before the stages after it", () => {
    const c = channel();
    const last = c.lastIndexOf("await keepLedger();");
    expect(last).toBeGreaterThan(c.lastIndexOf("needsReconcile.push(held);"));
    // Nothing but the channel's own end lies between the write and `recount`.
    expect(c.slice(last + "await keepLedger();".length).trim()).toBe("");
  });

  it("keeps each paid answer at once on a pass past its window", () => {
    const c = channel();
    const kept = (after: string) => {
      const at = c.indexOf(after);
      expect(at, after).toBeGreaterThan(-1);
      return c.indexOf('await keepLedger("past the window");', at) - at;
    };
    // The outside-root probe, the left-behind probe and each variant merge.
    const judge = between("const judgeOutsideRoot = async", "const leftBehind = new Map");
    expect(judge.indexOf('await keepLedger("past the window");')).toBeGreaterThan(
      judge.indexOf("await probeHeldPaths({"),
    );
    expect(kept("evidence = await probeHeldPaths({")).toBeLessThan(800);
    expect(kept("await tryVariantMerge(lb.spec)")).toBeLessThan(120);
  });
});

describe("the budget never decides what the spec channel delivers", () => {
  it("leaves the clock out of every decision in the channel", () => {
    const c = between('markPhase("specs");', 'markPhase("recount");');
    expect(c).not.toContain("shouldStop");
    expect(c).not.toContain("carryStoppedOnBudget");
    expect(c).not.toContain("mapWithConcurrencyUntil");
    // One reading of the clock remains, and it does not shape the delivery:
    // whether a pass already past its window writes each answer at once.
    expect(c.match(/isPastDeadline/g) ?? []).toHaveLength(1);
    expect(c).toMatch(/if \(bridgePool\.length > 0\) await prefetchPrimeText\(bridgePool\);/);
  });

  it("reads a spec's imports for specs alone, through the pass's kept readings", () => {
    const loop = between("for (let round = 0; ; round += 1) {", "if (outsideNamedBy.size > 0) {");
    expect(loop).toMatch(
      /primeShaByPath && isSpecPath\(specPath\)\s*\?\s*subjectsImportedBy\(specText, specPath, primeShaByPath, readings\.importsOf\)/,
    );
    expect(loop).toContain("readNamed: readings.namedOutsideRoots,");
    expect(engine.match(/const readings = memoSourceReadings\(\);/g) ?? []).toHaveLength(1);
    const hops = between(
      "for (let hop = 0; hop <= MAX_SHIM_HOPS; hop += 1) {",
      "if (unread.prime.size === 0",
    );
    expect(hops).toMatch(/subjectsOfKeptSpec\(\{[\s\S]*?readings,\s*\}\);/);
    expect(engine).toContain(
      "subjectsOfKeptSpec({ specPath: spec, sides: sidesOf(spec), readings })",
    );
  });
});
