/**
 * A bridge is judged over the FINISHED delivery and carried by the machinery
 * every other carried file goes through.
 *
 * `reExportBridges.pure.ts` decides which bridges are owed; this file asserts
 * the three things only the engine can get wrong: that the question is asked
 * of the delivery as it stands each round (a module held back is not landed,
 * and a bridge onto it would re-export a file the clone lacks), that an owed
 * bridge enters `planSubjectCarry` rather than being written directly (so the
 * exclusions and `prepareOne` see it), and that the loop cannot stop while a
 * bridge is still owed.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const engine = readFileSync(join(process.cwd(), "src/server/cascade-engine.server.ts"), "utf8");

const loopStart = engine.indexOf("for (let round = 0; ; round += 1) {");
const loopEnd = engine.indexOf("if (round >= maxCarryRounds) carryingAllowed = false;");
const loop = engine.slice(loopStart, loopEnd);

describe("the pool is read once, before the carry loop", () => {
  it("is decided by path and size, on a module-scoped clone only, and prefetched in one batch", () => {
    const pool = engine.indexOf("const bridgePool: string[] =");
    expect(pool).toBeGreaterThan(-1);
    expect(pool).toBeLessThan(loopStart);
    const block = engine.slice(pool, loopStart);
    expect(block).toMatch(/widenedScope !== null &&/);
    expect(block).toContain("bridgeCandidates({");
    // Paced on the pass's clock: an unread bridge is merely not owed this pass.
    expect(block).toMatch(
      /if \(bridgePool\.length > 0\) \{\s*await prefetchPrimeText\(\s*bridgePool,\s*resume\?\.budget \? \(reserveMs\) => resume\.budget!\.isPastDeadline\(reserveMs\) : undefined,\s*\);\s*\}/,
    );
  });
});

describe("inside the loop", () => {
  it("finds the loop", () => {
    expect(loopStart).toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(loopStart);
  });

  it("asks what is owed of THIS round's delivery, and skips what was attempted", () => {
    expect(loop).toMatch(
      /bridgesOwedNow =[\s\S]*?bridgesOwed\(\{[\s\S]*?delivered: deliveredPaths,[\s\S]*?\}\)\.filter\(\(b\) => !attemptedSubjects\.has\(b\.path\)\)/,
    );
    // Asked after this round's delivered set is built.
    expect(loop.indexOf("const deliveredPaths = new Set(")).toBeLessThan(
      loop.indexOf("bridgesOwedNow ="),
    );
  });

  it("reads bridge text only from the exact-blob cache — never a guess", () => {
    expect(loop).toContain("readPrime: (path) => exactPrimeText.get(path)?.text,");
  });

  it("cannot stop while a bridge is owed", () => {
    expect(loop).toMatch(
      /importsOwed\.size === 0 && owedSpecs\.length === 0 && bridgesOwedNow\.length === 0/,
    );
  });

  it("carries an owed bridge through planSubjectCarry, so the exclusions and prepareOne judge it", () => {
    expect(loop).toMatch(
      /planSubjectCarry\(\{\s*stranded: \[[\s\S]*?\.\.\.bridgesOwedNow\.map\(\(b\) => b\.path\),[\s\S]*?\]/,
    );
  });

  it("records a bridge as carried only once the absorber wrote it", () => {
    expect(loop).toMatch(
      /const written = absorbPrepared\(carried\);[\s\S]*?for \(const path of written\) \{\s*const bridge = bridgesOwedNow\.find\(\(b\) => b\.path === path\);\s*if \(bridge\) bridgesCarried\.set\(path, bridge\);/,
    );
  });
});

describe("what is reported is what landed", () => {
  it("reports only bridges the finished delivery writes", () => {
    expect(engine).toMatch(
      /const bridgesReported = \[\.\.\.bridgesCarried\.values\(\)\]\.filter\(\(b\) => landedWrites\.has\(b\.path\)\);/,
    );
    expect(engine).toContain("bridgeSuffixFor(bridgesReported)");
    expect(engine).toContain("describeBridges(bridgesReported)");
  });
});
