/**
 * A membrane nothing consults is a membrane that does not exist.
 *
 * This repository has shipped that defect twice in the surfaces this module
 * sits beside — three builder-portal components with zero call sites, and a
 * `securityInventoryHold` that was reached on every pass and, because it read
 * the wrong evidence, had never once fired. Both typechecked, linted and
 * built. So the wiring is asserted as SOURCE, and every assertion below was
 * proven non-vacuous by planting the defect it describes.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DECLARATION_PATHS,
  SECURITY_BASELINE_PATH,
} from "./ionSpecies.pure";
import { SECURITY_INVENTORY_PATH } from "@/server/cascade/securityInventoryHold.pure";
import { SECURITY_REGISTRY_PATH } from "@/server/cascade/securityRegistryReconcile.pure";
import { CONFIG_TOML_PATH } from "@/server/cascade/configTomlReconcile.pure";
import { stripComments } from "@/server/sourceComments.pure";

const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));
const dryrun = stripComments(readFileSync("src/server/cascade-dryrun.server.ts", "utf8"));

describe("the engine asks the membrane", () => {
  it("keys the membrane on the DESTINATION, not on whatever ref a caller holds", () => {
    // `processClone` has three callers and only one of them resolves lineage.
    // The live cascade passes `primeRef: readRef` — already the PARENT'S
    // repository for a routed child — while `cascade-dryrun.server.ts` and
    // `regenerateCloneProposal` both build it straight from `prime.github_*`.
    // Asking the destination takes the question away from the caller.
    expect(engine).toContain("membraneInto(clone.github_repo, primeRef.repo)");
    expect(engine).not.toContain("resolveMembrane(primeRef.repo");
  });

  it("the live path still hands it the parent's ref as the fallback", () => {
    // The fallback only matters for a repository the registry does not
    // describe, and there it should read the caller's own upstream rather
    // than prime unconditionally.
    expect(engine).toContain("primeRef: readRef");
  });

  it("the two callers that resolve no lineage are still correct through it", () => {
    // Asserted as the property rather than trusted: neither mentions lineage,
    // and that is exactly why the membrane may not be keyed on their ref.
    for (const src of [dryrun, engine.slice(engine.indexOf("regenerateCloneProposal"))]) {
      expect(src).toContain("repo: prime.github_repo");
    }
    expect(dryrun).not.toContain("readRef");
  });

  it("consults it per file, with the text it is about to write", () => {
    // Whitespace-tolerant on purpose. Pinning the exact characters made this
    // file fail on a Prettier reflow of the same call — and Prettier accepts
    // BOTH forms, so `npm run lint` would have been green while this was red,
    // which teaches the next person to edit the assertion rather than read
    // it. The claim is about the arguments, not the line breaks.
    expect(engine).toMatch(
      /permeate\(\s*membrane\s*,\s*\{\s*path\s*,\s*text:\s*primeFile\.content\s*,?\s*\}\s*\)/,
    );
  });

  it("acts on a refusal rather than only recording it", () => {
    const at = engine.indexOf("permeate(membrane,");
    const block = engine.slice(at, at + 400);
    expect(block).toMatch(/verdict\.kind === "blocked"/);
    expect(block).toMatch(/return\s*\{\s*kind:\s*"held"\s*,\s*held:\s*verdict\.held\s*,?\s*\}/);
  });

  it("asks the spec channel with BOTH trees", () => {
    const at = engine.indexOf("strandedSubjects({");
    expect(at).toBeGreaterThan(-1);
    const block = engine.slice(at, at + 400);
    expect(block).toMatch(/primeSha:\s*primeShaByPath/);
    expect(block).toMatch(/cloneSha:\s*cloneShaByPath/);
  });

  it("judges a spec against what this pass WRITES, never against the candidates", () => {
    // `partition.write` is the candidate set and a candidate can still be
    // held — by the oversize rule, the workflow rule, the backend-identity
    // rule or the membrane's own per-file channels. A spec judged against it
    // crosses beside a subject that was held three lines later, which is the
    // exact shape this channel exists to refuse.
    //
    // Read through whatever the local is CALLED. Pinning the name `deliveredPaths`
    // made this assertion fail on a rename to `crossingPaths` — a two-use local
    // const, clean under prettier, clean under eslint, clean under tsc, and
    // behaviourally identical. An assertion that red-lights a rename is one
    // people learn to edit.
    const at = engine.indexOf("strandedSubjects({");
    const block = engine.slice(at, at + 400);

    const passed = block.match(/crossing:\s*([A-Za-z_$][\w$]*)/);
    expect(passed).not.toBeNull();
    const name = passed![1];

    // Whatever it is called, it is the set of paths this pass is WRITING.
    expect(engine).toMatch(
      new RegExp(`const ${name} = new Set\\(\\s*treeEntries\\.map\\(`),
    );
    // And never the candidate set, which is the distinction the channel exists for.
    expect(block).not.toMatch(/crossing:\s*partition\.write/);
    expect(engine).not.toContain("new Set(primeFiles)");
  });

  it("asks it AFTER every write is decided, including the three reconciles", () => {
    const stranded = engine.indexOf("strandedSubjects({");
    const configReconcile = engine.indexOf("reconcileConfigToml(");
    const deployReconcile = engine.indexOf("reconcileDeployWorkflow(");
    expect(configReconcile).toBeGreaterThan(-1);
    expect(deployReconcile).toBeGreaterThan(-1);
    expect(stranded).toBeGreaterThan(configReconcile);
    expect(stranded).toBeGreaterThan(deployReconcile);
    expect(
      engine.indexOf("treeEntries.length === 0 && pendingDeletes.length === 0"),
    ).toBeGreaterThan(stranded);
  });

  it("tries to CARRY the subject before it condemns the spec", () => {
    // The gate has two lawful resolutions and this is the order between
    // them: bring both, or leave both. Holding first and carrying never was
    // the behaviour that left the fleet's 176-file split standing.
    const carry = engine.indexOf("planSubjectCarry({");
    const hold = engine.indexOf("orphanSpecHoldAfterCarry({");
    expect(carry).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(carry);
  });

  it("puts a carried subject through the SAME judgement as every other write", () => {
    // The whole safety argument. A subject carried in because a spec names it
    // must meet the oversize ceiling, the workflow rule, the backend-identity
    // rule and this edge's channels on identical terms — which it does by
    // being the same function, not by a second implementation agreeing.
    const at = engine.indexOf("planSubjectCarry({");
    const block = engine.slice(at, at + 1400);
    expect(block).toMatch(/mapWithConcurrencyUntil<[\s\S]{0,120}>\(\s*gated\.write\s*,\s*8\s*,\s*prepareOne/);
    // And there is exactly one such judgement to be the same as.
    expect(engine.match(/const prepareOne = async/g) ?? []).toHaveLength(1);
  });

  it("absorbs a carried subject the way the main pass absorbs its own", () => {
    // Two copies of "what a prepared entry becomes" is how one of them comes
    // to forget `deliveredSource` — the map the spec channel reads — and a
    // carried spec would then cross having stranded something.
    const at = engine.indexOf("planSubjectCarry({");
    const block = engine.slice(at, at + 1400);
    expect(block).toContain("absorbPrepared(carried)");
    expect(engine.match(/const absorbPrepared =/g) ?? []).toHaveLength(1);
    expect(engine).toContain("absorbPrepared(prepared)");
  });

  it("puts a carried subject through the PATH rules, not only the content rules", () => {
    // The hole this closes: `planSubjectCarry` refuses what `partition.held`
    // holds, and on a MIRROR that is sufficient — every differing path was
    // partitioned. On a MODULE-SCOPED clone `candidatePaths` is the installed
    // globs plus the repository invariants, so a subject outside that scope
    // was never put through `partitionCascadePaths` at all, has no hold for
    // the plan to see, and would have been carried with its exclusions never
    // asked. `backendIdentityHold` would have caught the worst of it, which is
    // a different rule catching it by luck.
    const at = engine.indexOf("planSubjectCarry({");
    const block = engine.slice(at, at + 1800);
    expect(block).toMatch(/partitionCascadePaths\(\s*plan\.carry\s*,\s*exclusions\s*\)/);
    // And what it carries is the WRITE half, never the whole plan.
    expect(block).toMatch(/mapWithConcurrencyUntil<[\s\S]{0,120}>\(\s*gated\.write\s*,/);
    // The same exclusions the first partition used, not a second list.
    expect(engine).toMatch(/partitionCascadePaths\(candidatePaths,\s*exclusions\)/);
  });

  it("reports what the path rules refused, and stops re-planning it", () => {
    const at = engine.indexOf("planSubjectCarry({");
    const block = engine.slice(at, at + 1800);
    expect(block).toContain("partition.held.push(h)");
    expect(block).toContain("attemptedSubjects.add(h.path)");
  });

  it("never releases a subject an existing rule already holds", () => {
    // `planSubjectCarry` is handed the live partition, and what it refuses it
    // returns rather than drops, so the spec is held WITH its refusals.
    const at = engine.indexOf("planSubjectCarry({");
    const block = engine.slice(at, at + 400);
    expect(block).toMatch(/held:\s*partition\.held/);
  });

  it("records what the carry paid for, not only what the main loop did", () => {
    // `finalProgress` is the blob ledger the NEXT pass reuses. Its condition
    // was evaluated above the carry, so a pass whose main loop prepared
    // nothing and whose carry prepared several recorded none of them and
    // bought them again next tick.
    const carry = engine.indexOf("planSubjectCarry({");
    const ledger = engine.indexOf("const finalProgress:");
    expect(carry).toBeGreaterThan(-1);
    expect(ledger).toBeGreaterThan(carry);
  });

  it("answers to the pass's own clock, so carrying cannot overrun a budget", () => {
    const at = engine.indexOf("planSubjectCarry({");
    const block = engine.slice(at, at + 1400);
    expect(block).toContain("shouldStop");
  });

  it("holds the spec rather than dropping it silently", () => {
    const at = engine.indexOf("strandedSubjects({");
    const block = engine.slice(at, at + 3000);
    expect(block).toContain("stranded.length > 0");
    expect(block).toMatch(/orphanSpecHoldAfterCarry\(\{\s*membrane,\s*specPath,\s*stranded,\s*refused,/);
    expect(block).toContain("partition.held.push(held)");
    expect(block).toContain("needsReconcile.push(held)");
  });

  it("takes the held spec back OUT of the delivery it was already in", () => {
    // It was prepared and pushed before this ran. A hold that only records
    // itself would report the file as withheld and ship it anyway.
    const at = engine.indexOf("strandedSubjects({");
    const block = engine.slice(at, at + 3000);
    expect(block).toContain("treeEntries.splice(i, 1)");
    expect(block).toContain("delete deliveredSource[specPath]");
  });

  it("is refused by a content rule that no approval can release, like its two precedents", () => {
    // `cascade_path_approvals` is read and applied BEFORE the prepare loop,
    // deliberately: a released path then flows through that loop and its
    // content holds still run on it. So an `overwrite` approval releases a
    // PATH rule and a rule about what a file SAYS still gets to refuse —
    // which is exactly how `backendIdentityHold` and `judgingWorkflowHold`
    // have behaved since they were written. Pinned because the membrane's
    // holds name remedies on the strength of it.
    const release = engine.indexOf("approvableHeld(partition.held)");
    const prepare = engine.indexOf("const primeFiles = partition.write;");
    const backend = engine.indexOf("backendIdentityHold({");
    const membrane = engine.indexOf("permeate(membrane,");
    expect(release).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(release);
    expect(backend).toBeGreaterThan(prepare);
    expect(membrane).toBeGreaterThan(prepare);
  });

  it("asks nothing of a binary file", () => {
    // Every species is a statement about source. `primeFile.content` is a
    // lossy reading of bytes that were never text.
    const at = engine.indexOf("permeate(membrane,");
    const guard = engine.lastIndexOf("if (!primeFile.binary) {", at);
    expect(guard).toBeGreaterThan(-1);
    expect(at - guard).toBeLessThan(400);
  });

  it("sits after the backend-identity hold, which is its precedent", () => {
    const backend = engine.indexOf("backendIdentityHold({");
    const membrane = engine.indexOf("permeate(membrane,");
    expect(backend).toBeGreaterThan(-1);
    expect(membrane).toBeGreaterThan(backend);
  });

  it("is resolved once per clone, not once per file", () => {
    // Inside the per-file callback it would recompute for all ~830 files of a
    // backfill, and the answer cannot change between them.
    //
    // Counting the call sites does NOT assert this — a review agent moved the
    // declaration into the per-file callback and the count stayed at one, so
    // the assertion that carried this name passed over the exact edit it is
    // named for. `tsc` caught that particular move, because the post-pass
    // then referenced an out-of-scope name; but an edit that took the
    // post-pass down with it would satisfy the compiler and still resolve the
    // membrane ~830 times a backfill.
    //
    // What is actually being claimed is a POSITION: the declaration sits in
    // the body of `processClone`, which in this file is two spaces of
    // indentation, and both readers sit below it. Indentation is a weak
    // signal in general and an exact one here — this file is Prettier-formatted
    // at two spaces, so a statement nested inside anything at all is indented
    // further, and `npm run lint` is in the gate chain ahead of this test.
    const matches = engine.match(/membraneInto\(/g) ?? [];
    expect(matches).toHaveLength(1);

    const declaration = engine.match(/^([ \t]*)const membrane = membraneInto\(/m);
    expect(declaration).not.toBeNull();
    expect(declaration![1]).toBe("  ");

    // And it precedes every reader, so no reader can be reading a stale one.
    const declaredAt = engine.indexOf("const membrane = membraneInto(");
    expect(engine.indexOf("permeate(membrane,")).toBeGreaterThan(declaredAt);
    expect(engine.indexOf("orphanSpecHoldAfterCarry({")).toBeGreaterThan(declaredAt);
  });
});

/**
 * THE PATHS THIS MODULE RESTATES.
 *
 * `ionSpecies.pure.ts` is reached by a route, so it may not import a VALUE
 * from `src/server/**` — the import-protection plugin refuses it and `tsc`
 * cannot see the rule, which is how a working commit came to be one `vite
 * build` refused. The three path constants there are therefore SECOND COPIES
 * of shipped rules, and the copy is forced rather than chosen.
 *
 * What is not forced is the silence. A review agent set `SECURITY_BASELINE_PATH`
 * to `docs/security/WRONG_NAME.json` and the whole suite passed — 193 of 193 —
 * because a path constant naming a file that does not exist is invisible in
 * exactly the way this repository's own rules keep warning about: the channel
 * would simply never match, a changed security inventory would cross a
 * membrane that declares itself closed to it, and nothing anywhere would say
 * so.
 *
 * A test may import from both sides. So the copies are pinned to their
 * originals here, which is the only place that can hold both.
 */
describe("the species paths agree with the rules they restate", () => {
  it("names the security baseline the hold names", () => {
    expect(SECURITY_BASELINE_PATH).toBe(SECURITY_INVENTORY_PATH);
  });

  it("names the declaration files the two reconcile pumps name", () => {
    // Order is the module's own; membership is what the classifier reads.
    expect([...DECLARATION_PATHS].sort()).toEqual(
      [CONFIG_TOML_PATH, SECURITY_REGISTRY_PATH].sort(),
    );
  });
});
