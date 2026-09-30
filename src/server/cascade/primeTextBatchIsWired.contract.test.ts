/**
 * Prime's text is read once per pass, a batch at a time, by both readers.
 *
 * Structural — which reads draw from the batched cache and which still go per
 * file — so asserted against the source. What the cache may hold is tested in
 * `primeTextBatch.test.ts`, and the request itself in
 * `readBlobTextsBatched.test.ts`.
 *
 * The defect these pins stand in front of: at prime@ded5d92 the pass to
 * `npc-crm-independent-6505dc` made 836 per-file contents reads out of 884
 * calls — 351 by the import closure before any file was prepared, 408 by the
 * prepare loop after it. In production every tick paused with no file
 * prepared, nothing a tick read was ledgered, and the drain retired the event
 * after three. Each pin below names the half of that it would let back in.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const engine = stripComments(read("src/server/cascade-engine.server.ts"));

const prefetchStart = engine.indexOf("const prefetchPrimeText = async (");
const prefetchEnd = engine.indexOf("let importClosure:", prefetchStart);
const prefetch = engine.slice(prefetchStart, prefetchEnd);

const readIntoStart = engine.indexOf("const readInto = async (paths: readonly string[])");
const readIntoEnd = engine.indexOf("const closeOver = async (", readIntoStart);
const readInto = engine.slice(readIntoStart, readIntoEnd);

const prepareStart = engine.indexOf("const prepareOne = async (path: string)");
const mainPool = engine.indexOf(">(primeFiles, 8, prepareOne, shouldStop);", prepareStart);
const prepare = engine.slice(prepareStart, mainPool);

const carryPool = engine.indexOf("gated.write,\n        8,\n        prepareOne,");

describe("the slices this file reads exist", () => {
  it("finds the cache, the closure's reader, the prepare step and both pools", () => {
    expect(prefetchStart).toBeGreaterThan(-1);
    expect(prefetchEnd).toBeGreaterThan(prefetchStart);
    expect(readIntoStart).toBeGreaterThan(-1);
    expect(readIntoEnd).toBeGreaterThan(readIntoStart);
    expect(prepareStart).toBeGreaterThan(-1);
    expect(mainPool).toBeGreaterThan(prepareStart);
    expect(carryPool).toBeGreaterThan(mainPool);
  });
});

describe("the cache is filled only with what the listing vouches for", () => {
  it("asks by the listing's own blob id, size and mode, through the batch reader", () => {
    expect(prefetch).toMatch(/const sha = shas\.get\(path\)/);
    expect(prefetch).toMatch(/isBatchableTextMode\(modes\.get\(path\)\)/);
    expect(prefetch).toMatch(/size: sizes\.get\(path\)/);
    expect(prefetch).toMatch(/readBlobTextsBatched\(octokit, primeRef, wants/);
  });

  it("stands down wherever the listing is not complete", () => {
    // A truncated listing leaves these null, and every read goes per file.
    expect(prefetch).toMatch(
      /if \(shas === null \|\| sizes === null \|\| modes === null\) return;/,
    );
  });

  it("stores each text with the id it was proved against", () => {
    expect(prefetch).toMatch(/exactPrimeText\.set\(path, \{ sha, text \}\)/);
  });

  it("is given the size and mode in both listing branches", () => {
    // The mirror branch and the module-scoped branch each set the three maps
    // together. A branch that set only the ids would silently batch nothing.
    const sets = engine.match(
      /primeSizeByPath = primeTree\.sizes;\s*primeModeByPath = primeTree\.modes;/g,
    );
    expect(sets).toHaveLength(2);
  });
});

describe("the import closure reads through the cache", () => {
  it("fills it for every module it is about to walk, and never on a budget", () => {
    // A closure cut short lets a module cross without what it imports, so it
    // must finish — which is why its prefetch takes no deadline.
    expect(readInto).toMatch(/await prefetchPrimeText\(walkable\);/);
    expect(readInto).not.toMatch(/prefetchPrimeText\(walkable,/);
  });

  it("takes a proved text before asking the contents API", () => {
    const cacheAt = readInto.indexOf("exactPrimeText.get(path)");
    const perFileAt = readInto.indexOf("getFileContent(octokit, primeRef, path");
    expect(cacheAt).toBeGreaterThan(-1);
    expect(perFileAt).toBeGreaterThan(cacheAt);
  });
});

describe("the prepare step reads through the cache", () => {
  it("takes a proved text before the per-file read, and keeps the ceiling on that read", () => {
    const cacheAt = prepare.indexOf("exactPrimeText.get(path)");
    const perFileAt = prepare.indexOf("getFileContent(octokit, primeRef, path, {");
    expect(cacheAt).toBeGreaterThan(-1);
    expect(perFileAt).toBeGreaterThan(cacheAt);
    expect(prepare).toMatch(/repoFileFromExactText\(batched\.sha, batched\.text\)/);
    expect(prepare).toMatch(/maxBytes: CASCADE_MAX_FILE_BYTES/);
  });

  it("still counts a cached file as read, so the forward-progress guarantee is unchanged", () => {
    // `shouldStop` refuses to stop a pass that has read nothing. A cache hit
    // left uncounted would let a pass whose every file was cached stop only
    // on the per-file reads, and one with no per-file read never at all.
    const countAt = prepare.indexOf("filesRead += 1;");
    const cacheAt = prepare.indexOf("exactPrimeText.get(path)");
    expect(countAt).toBeGreaterThan(-1);
    expect(countAt).toBeLessThan(cacheAt);
  });

  it("still sends an oversize refusal to the stream lane", () => {
    expect(prepare).toMatch(
      /if \(e instanceof OversizeFileError\) \{\s*return await carryOversizeByStream\(e, path, fileStartedAt\);/,
    );
  });
});

describe("both preparation pools are prefetched, and paced on the budget", () => {
  const beforeMain = engine.slice(mainPool - 900, mainPool);
  const beforeCarry = engine.slice(carryPool - 900, carryPool);

  it("prefetches what the main pool will read, skipping blobs the ledger reuses", () => {
    expect(beforeMain).toMatch(
      /await prefetchPrimeText\(\s*primeFiles\.filter\(\(path\) => isSpecPath\(path\) \|\| !known\.has\(path\)\),/,
    );
    expect(beforeMain).toMatch(/resume\.budget!\.isPastDeadline\(reserveMs\)/);
  });

  it("prefetches what the carry will read, the same way", () => {
    expect(beforeCarry).toMatch(
      /await prefetchPrimeText\(\s*gated\.write\.filter\(\(path\) => isSpecPath\(path\) \|\| !known\.has\(path\)\),/,
    );
    expect(beforeCarry).toMatch(/resume\.budget!\.isPastDeadline\(reserveMs\)/);
  });
});
