/**
 * A KEPT SPEC A CROSSING FILE LEAVES BEHIND IS JUDGED, OR LISTED — NEVER SILENT.
 *
 * Cascade PR #160 to `npc-crm-independent-6505dc` (30 Oct 2026): two specs the
 * independent line keeps whole stayed at their older text while the files they
 * test crossed, `verify` failed three assertions, and the proposal said nothing,
 * because the left-behind half passed over every spec a rule already held. The
 * rule now lives in `keptSpecRelease.pure.ts`; what keeps it is the wiring in
 * `processClone`, so it is asserted as source, like `carryGate.contract.test.ts`:
 * a fake Octokit would pass while a rearranged engine lost it again. Each
 * assertion was proven non-vacuous by planting the defect it names.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../sourceComments.pure";

const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

/** The left-behind half's judging block, from its held set to the subject carry. */
function judging(): string {
  const from = engine.indexOf("const leftBehindNow = keptLeftBehind();");
  const to = engine.indexOf("const gated = partitionCascadePaths(", from);
  expect(from, "left-behind judging not found").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return engine.slice(from, to);
}

/** The pass's last sweep over kept specs left behind, to its end. */
function finalSweep(): string {
  const from = engine.indexOf(
    "if (keptSpecSubjects.size > 0) {\n    const keptHolds = keptHoldsNow();",
  );
  const to = engine.indexOf("reverseHolds.set(lb.spec, {", from);
  expect(from, "final sweep not found").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return engine.slice(from, to);
}

describe("a kept spec prime's copy can run on is judged like any other", () => {
  it("is judgeable only where prime's copy lacks nothing", () => {
    expect(judging()).toContain(
      "if (lacks !== null && lacks.length === 0) keptJudgeable.add(lb.spec);",
    );
  });

  it("is not passed over for being held, in either loop", () => {
    const block = judging();
    expect(block).toMatch(
      /const passedOver = \(spec: string\) =>\s*\(heldNow\.has\(spec\) && !keptJudgeable\.has\(spec\)\) \|\| attemptedSubjects\.has\(spec\);/,
    );
    expect(block.match(/if \(passedOver\(lb\.spec\)\) continue;/g)).toHaveLength(2);
    expect(block).not.toContain(
      "if (heldNow.has(lb.spec) || attemptedSubjects.has(lb.spec)) continue;",
    );
  });

  it("is never variant-merged: the verdict was of prime's copy, not of a merge", () => {
    expect(judging()).toContain(
      'carryingAllowed && keptHold === undefined ? await tryVariantMerge(lb.spec) : "hold"',
    );
  });

  it("travels past the kept rule once owed, and past nothing else", () => {
    // The hold comes off where the spec is owed, not where it is released: a
    // released spec cut short by the files outside the roots keeps it.
    expect(judging()).toMatch(
      /const keptHold = keptHolds\.get\(spec\);\s*if \(keptHold\) \{\s*replaceHold\(keptHold, null\);\s*keptTravelling\.add\(spec\);\s*\}\s*owedSpecs\.push\(spec\);/,
    );
    expect(engine).toMatch(
      /const gated = partitionCascadePaths\(plan\.carry, exclusions, \{\s*\.\.\.lineOpts,\s*travelsPastKept: keptTravelling,\s*\}\);/,
    );
  });

  it("is held once when a person must decide: in place of the kept hold", () => {
    expect(judging()).toMatch(
      /if \(keptHold\) replaceHold\(keptHold, held\);\s*else partition\.held\.push\(held\);/,
    );
  });
});

describe("a kept spec prime's copy cannot run on stays the line's, and is said", () => {
  it("is listed, and never queued for an approval that would ship a spec that cannot load", () => {
    const sweep = finalSweep();
    const listed = sweep.search(
      /if \(lacks\.length > 0\) \{\s*keptStaying\.push\(\{ spec: lb\.spec, touchedBy: lb\.touchedBy, lacks \}\);\s*continue;\s*\}/,
    );
    expect(listed).toBeGreaterThan(-1);
    // Its `continue` comes before the hold that would reach the human queue.
    expect(sweep.indexOf("needsReconcile.push(held);")).toBeGreaterThan(listed);
  });

  it("is no reason for the last sweep to stand down: only another rule's hold is", () => {
    const sweep = finalSweep();
    expect(sweep).toContain(
      "const heldNow = new Set(partition.held.filter((h) => !isCrmLineKeptHold(h)).map((h) => h.path));",
    );
    expect(sweep.indexOf("if (heldNow.has(lb.spec)) continue;")).toBeGreaterThan(
      sweep.indexOf("keptStaying.push("),
    );
  });

  it("is left as it was where its question could not be asked", () => {
    expect(finalSweep()).toMatch(
      /const lacks = keptSpecLacks\(lb\.spec, present\);\s*if \(lacks === null\) continue;/,
    );
  });

  it("has its own section in the proposal, and is not counted as withheld without comment", () => {
    expect(engine).toContain("describeKeptSpecsLeftBehind(keptStaying)");
    expect(engine).toContain(
      "partition.held.length - needsReconcile.length - keptStaying.length > 0",
    );
  });
});

describe("what a kept spec lacks is asked of the tree the delivery leaves", () => {
  it("reads the clone's tree with what the delivery writes and removes", () => {
    expect(engine).toMatch(
      /treeAfterDelivery\(\{\s*clone: cloneShaByPath,\s*writes: changedOnClone\(\),\s*removes: deletesCrossing,\s*\}\)/,
    );
  });

  it("builds that tree once per question, not once per spec", () => {
    expect(judging()).toContain("const present = keptAsking.length > 0 ? keptPresentNow() : null;");
    expect(finalSweep()).toContain("const present = keptHolds.size > 0 ? keptPresentNow() : null;");
    expect(engine.match(/keptSpecLacks\(lb\.spec, present\)/g)).toHaveLength(2);
  });
});

describe("a kept spec whose note is dropped is held as it was", () => {
  it("gets its kept hold back, so the held record stays full", () => {
    // `partition.held` is the full record (`carryGate.contract.test.ts`); a
    // note with nothing left to say is dropped, and the spec it replaced the
    // kept hold of stays the line's.
    expect(engine.match(/kept: keptHold,/g)).toHaveLength(2);
    expect(engine).toMatch(
      /else \{\s*reverseHolds\.delete\(spec\);\s*if \(entry\.kept\) partition\.held\.push\(entry\.kept\);\s*\}/,
    );
  });
});
