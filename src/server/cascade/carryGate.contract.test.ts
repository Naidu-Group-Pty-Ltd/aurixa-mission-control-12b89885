/**
 * WHAT THE SUBJECT CARRY MAY DO, AND WHAT IT MAY NOT UNDO.
 *
 * The carry gate resolves a stranded spec by bringing its subject across
 * rather than holding both. It runs last, over the finished delivery, and
 * that position is what makes it powerful and what makes these six defects
 * possible: everything else has already decided by the time it reads the
 * tree, so anything it adds is added over a decision.
 *
 * All six were found by an adversarial review on 21 Sep 2026 and confirmed by
 * execution before any of them was fixed. They are asserted as SOURCE,
 * because the property is in the shape of the code — which push happens
 * before which filter, which set the loop reads — and a behavioural test with
 * a fake Octokit would pass while a rearranged engine lost it again. Every
 * assertion below was proven non-vacuous by planting the defect it names.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../sourceComments.pure";
import { reportableHeld } from "./syncExclusions.pure";

const raw = readFileSync("src/server/cascade-engine.server.ts", "utf8");
const engine = stripComments(raw);

/**
 * The carry loop, from its own `for` to the statement after it — the Edge
 * Function type baseline's reconcile, which has to read what the loop
 * decided (`edgeTypecheckBaselineReconcile.contract.test.ts`).
 */
function carryLoop(): string {
  const from = engine.indexOf("for (let round = 0; ; round += 1) {");
  const to = engine.indexOf("let edgeBaselineNote: string | null = null;");
  expect(from, "carry loop not found").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return engine.slice(from, to);
}

describe("a protected refusal never reaches the human queue", () => {
  it("is the rule `reportableHeld` states, and it has not moved", () => {
    const protectedRow = {
      path: "supabase/config.toml",
      pattern: "supabase/config.toml",
      reason: "protected" as const,
      note: "",
    };
    expect(reportableHeld([protectedRow])).toHaveLength(0);
  });

  it("filters the carry's own refusals through it, like every other producer", () => {
    // `needsReconcile` is `reportableHeld(partition.held)` everywhere else.
    // The carry pushed `gated.held` raw, and `partitionCascadePaths` emits
    // the exclusion row's OWN reason — so a carried subject matching a
    // protected pattern drew an "Approve prime's copy" button that
    // `decideHoldRelease` refuses outright. An approval that reports success
    // and releases nothing, for ever.
    const loop = carryLoop();
    expect(loop).toContain("needsReconcile.push(...reportableHeld(gated.held))");
    expect(loop).not.toMatch(
      /for \(const h of gated\.held\) \{\s*partition\.held\.push\(h\);\s*needsReconcile\.push\(h\);/,
    );
  });

  it("still records every refusal on the partition, which is not filtered", () => {
    // `partition.held` is the full record and stays full: the PR body's
    // "owned by this clone" line counts the difference between the two.
    expect(carryLoop()).toContain("for (const h of gated.held) partition.held.push(h)");
  });
});

describe("a carried subject is a delivered module, so it meets the import closure", () => {
  it("makes the closure a function rather than a block that ran once", () => {
    expect(engine).toContain("let importClosure:");
    expect(engine).toContain("importClosure = closeOver;");
  });

  it("asks it of what the carry wrote", () => {
    // Its own comment calls its placement "the whole safety argument", and it
    // ran ~1,100 lines above this loop over `candidatePaths` alone. A subject
    // the carry brought in behind a spec never met it, so it arrived without
    // its imports and no later round could notice.
    const loop = carryLoop();
    expect(loop).toContain("await importClosure(written, have)");
    expect(loop).toContain("importsOwed.add(owed)");
  });

  it("owes the imports rather than writing them", () => {
    // Fed back as stranded paths, so they meet `planSubjectCarry`, the
    // exclusions, the ceiling and `prepareOne` on the terms every other
    // candidate does. Nothing crosses for having been IMPORTED any more than
    // for having been mentioned.
    const loop = carryLoop();
    expect(loop).toMatch(
      /stranded: \[\s*\.\.\.\[\.\.\.strandedBySpec\.values\(\)\]\.flat\(\),\s*\.\.\.importsOwed,?\s*\]/,
    );
  });

  it("drops an owed import once it is delivered or settled, so the loop ends", () => {
    const loop = carryLoop();
    expect(loop).toMatch(
      /if \(deliveredPaths\.has\(owed\) \|\| attemptedSubjects\.has\(owed\)\) importsOwed\.delete\(owed\)/,
    );
  });
});

describe("the budget is measured in what costs the window", () => {
  it("counts files read, not blobs uploaded", () => {
    // `freshlyPrepared` is the resume LEDGER's counter and only a binary file
    // buys a blob — text travels inline in the chunked `createTree` chain. So
    // on an all-text delivery it stayed 0 and `shouldStop` could never return
    // true. A carry is all text by construction, which made its budget bound
    // the one bound it could never reach, and `cutShort: "budget"`
    // unreachable with it.
    expect(engine).toMatch(
      /const shouldStop = \(\) =>\s*resume\?\.budget !== undefined && filesRead > 0 &&/,
    );
    expect(engine).not.toMatch(/const shouldStop[\s\S]{0,120}freshlyPrepared > 0/);
  });

  it("increments it once, where the read is attempted", () => {
    // Four exits sit below that line and a counter each of them has to
    // remember to touch is one a fifth exit will not.
    expect((engine.match(/filesRead \+= 1;/g) ?? []).length).toBe(1);
    const prepare = engine.slice(engine.indexOf("const prepareOne = async"));
    const inc = prepare.indexOf("filesRead += 1;");
    const read = prepare.indexOf("await getFileContent(octokit, primeRef, path");
    expect(inc).toBeGreaterThan(-1);
    expect(inc).toBeLessThan(read);
  });

  it("keeps the forward-progress guarantee it always had", () => {
    // `> 0` means a pass already past its deadline still prepares one file
    // rather than looping having done nothing.
    expect(engine).toContain("filesRead > 0 &&");
  });
});

describe("the belt stops the carry, not the loop", () => {
  it("turns carrying off instead of breaking", () => {
    // Holding a spec takes it out of the delivery, and another spec may name
    // it as a subject — so the round that holds can strand one it did not
    // see, and a bare `break` shipped that spec without its subject: the one
    // thing this channel exists to prevent.
    const loop = carryLoop();
    expect(loop).toContain("if (round >= maxCarryRounds) carryingAllowed = false;");
    expect(loop).not.toContain("if (round >= maxCarryRounds) break;");
  });

  it("gates the carry attempt on it", () => {
    expect(carryLoop()).toContain("if (carryingAllowed && gated.write.length > 0");
  });

  it("stops carrying the moment nothing more can be carried", () => {
    // `importsOwed` is cleared only of what was delivered or ATTEMPTED, and a
    // round that plans nothing attempts nothing — so a set of owed imports
    // that no plan can reach would spin the loop until the belt fired,
    // thousands of rounds later, each re-scanning the whole delivery.
    const loop = carryLoop();
    expect(loop).toContain("if (plan.carry.length === 0) carryingAllowed = false;");
    expect(loop).toMatch(
      /if \(stopped\) \{\s*carryStoppedOnBudget = true;\s*carryingAllowed = false;\s*\}/,
    );
  });

  it("still ends, because with carrying off every round holds a spec", () => {
    const loop = carryLoop();
    expect(loop).toMatch(
      /if \(strandedBySpec\.size === 0 && \(!carryingAllowed \|\| importsOwed\.size === 0\)\) break;/,
    );
  });

  it("bounds the loop above its own worst case, both halves", () => {
    // Carry rounds are bounded by the 200-subject cap and hold rounds by the
    // number of specs — and a CARRIED subject can itself be a spec, so that
    // set grows by up to the same cap while the loop runs. Counting only the
    // specs present at the start bounded the loop BELOW its worst case.
    expect(engine).toMatch(
      /const maxCarryRounds =\s*MAX_SUBJECTS_CARRIED \* 2 \+ Object\.keys\(deliveredSource\)\.length \+ 1;/,
    );
  });
});

describe("a reconcile pump's decision is not reopened by the carry", () => {
  const PUMPS = [
    ["CONFIG_TOML_PATH", "reconcileConfigToml"],
    ["SECURITY_REGISTRY_PATH", "reconcileSecurityRegistry"],
    ["DEPLOY_WORKFLOW_PATH", "reconcileDeployWorkflow"],
  ] as const;

  it.each(PUMPS)("records that it decided %s", (constant) => {
    expect(engine).toContain(`reconciledPaths.add(${constant})`);
  });

  it("records the two security baselines through their own settle", () => {
    expect(engine).toContain("reconciledPaths.add(held.path)");
  });

  it("reads the record as part of the delivery", () => {
    // A pump drops prime's copy and then either writes a merged file or
    // leaves the clone's standing — the second writes nothing, because the
    // merged result IS the clone's file, and a dry run writes nothing for a
    // different reason. A path in neither the tree nor `partition.held` reads
    // here as stranded, and the carry answers a stranded subject by
    // delivering prime's RAW copy: the reconcile undone inside its own pass.
    expect(carryLoop()).toMatch(
      /const deliveredPaths = new Set\(\[\.\.\.treeEntries\.map\(\(t\) => t\.path\), \.\.\.reconciledPaths\]\)/,
    );
  });

  it("records a decision and never a refusal", () => {
    // A held path is one a spec naming it should still strand on.
    for (const [, pump] of PUMPS) {
      const at = engine.indexOf(`${pump}({`);
      expect(at, `${pump} not found`).toBeGreaterThan(-1);
      const block = engine.slice(at, at + 900);
      expect(block).toMatch(
        /if \(verdict\.ok\) reconciledPaths\.add|\} else \{\s*reconciledPaths\.add/,
      );
    }
  });
});

describe("a spec is told which of the two things happened to it", () => {
  it("decides `cutShort` per spec, from what refused ITS subjects", () => {
    // `carryStoppedOnBudget` and `carryHitCeiling` are set once for the whole
    // pass and were stamped on every spec held in every later round — so a
    // spec whose subjects were each permanently refused by a rule got a note
    // saying "we ran out of time" over a list of reasons we did not, and an
    // operator waited for a next tick to finish something no tick can.
    expect(carryLoop()).toMatch(
      /cutShort:\s*refused\.length === stranded\.length\s*\?\s*null\s*:\s*carryStoppedOnBudget/,
    );
  });

  it("keeps both words available for the specs that earned them", () => {
    const loop = carryLoop();
    expect(loop).toContain('"budget"');
    expect(loop).toContain('"ceiling"');
  });
});
