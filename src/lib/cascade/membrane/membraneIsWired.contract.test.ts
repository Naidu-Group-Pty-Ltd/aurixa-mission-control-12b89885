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
import { DECLARATION_PATHS, SECURITY_BASELINE_PATH } from "./ionSpecies.pure";
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

  it("reads project refs only in their anchored shapes, as it always has", () => {
    // `knownRefs` widens `backend_ref` to the fleet's own refs written bare.
    // That reading is the LATERAL lane's: across that boundary a project named
    // anywhere is another tenant's database. Vertically a prime file naming
    // the prime's own project is ordinary — the pumps rewrite those refs per
    // clone and `backendIdentityHold` judges the rest — and no vertical
    // membrane was written expecting the wider reading. So the lateral work
    // changed nothing the prime's cascade reads, and `docs/LATERAL_MEMBRANE.md`
    // says so; this is where that is held rather than assumed.
    expect(engine).not.toMatch(/knownRefs/);
    expect(dryrun).not.toMatch(/knownRefs/);
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

  /**
   * The subject-carry loop, from its own `for` to the statement after it.
   *
   * Both anchors are CODE. `engine` is comment-stripped, so a comment makes a
   * fine landmark for a reader and none at all for this.
   *
   * Every assertion below that used to slice a fixed 400/1400/1800/3000
   * characters after `planSubjectCarry({` reads this instead. Those windows
   * were statements about a number: each one had to be widened every time a
   * comment landed inside the loop, and an assertion people learn to edit is
   * one that stops asserting. The scope they all meant is "inside the carry
   * loop", so that is what they say.
   */
  const carryLoop = () => {
    const from = engine.indexOf("for (let round = 0; ; round += 1) {");
    const to = engine.indexOf("const finalProgress: Partial<CascadeResultUpdate>");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return engine.slice(from, to);
  };

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

    // Whatever it is called, it is the set of paths this pass is WRITING —
    // plus the ones a reconcile pump DECIDED without writing, which is the
    // same claim. A pump drops prime's copy and then either writes a merged
    // file or leaves the clone's standing; the second case writes nothing,
    // and a path in neither the tree nor `partition.held` reads here as
    // stranded, so the carry answered it by delivering prime's RAW copy and
    // undid the reconcile inside its own pass.
    expect(engine).toMatch(
      new RegExp(`const ${name} = new Set\\(\\[\\.\\.\\.treeEntries\\.map\\(`),
    );
    expect(engine).toMatch(new RegExp(`const ${name} = new Set\\(\\[[^\\]]*reconciledPaths`));
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
    const block = carryLoop();
    expect(block).toMatch(
      /mapWithConcurrencyUntil<[\s\S]{0,120}>\(\s*gated\.write\s*,\s*8\s*,\s*prepareOne/,
    );
    // And there is exactly one such judgement to be the same as.
    expect(engine.match(/const prepareOne = async/g) ?? []).toHaveLength(1);
  });

  it("absorbs a carried subject the way the main pass absorbs its own", () => {
    // Two copies of "what a prepared entry becomes" is how one of them comes
    // to forget `deliveredSource` — the map the spec channel reads — and a
    // carried spec would then cross having stranded something.
    const block = carryLoop();
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
    const block = carryLoop();
    expect(block).toMatch(/partitionCascadePaths\(\s*plan\.carry\s*,\s*exclusions\s*\)/);
    // And what it carries is the WRITE half, never the whole plan.
    expect(block).toMatch(/mapWithConcurrencyUntil<[\s\S]{0,120}>\(\s*gated\.write\s*,/);
    // The same exclusions the first partition used, not a second list.
    expect(engine).toMatch(/partitionCascadePaths\(candidatePaths,\s*exclusions\)/);
  });

  it("reports what the path rules refused, and stops re-planning it", () => {
    const block = carryLoop();
    expect(block).toContain("partition.held.push(h)");
    expect(block).toContain("attemptedSubjects.add(h.path)");
  });

  it("never releases a subject an existing rule already holds", () => {
    // `planSubjectCarry` is handed the live partition, and what it refuses it
    // returns rather than drops, so the spec is held WITH its refusals.
    const block = carryLoop();
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
    const block = carryLoop();
    expect(block).toContain("shouldStop");
  });

  it("holds the spec rather than dropping it silently", () => {
    // Scoped to the carry loop rather than to a fixed window after
    // `strandedSubjects({`. A window that has to be widened every time a
    // comment lands between the two is an assertion people learn to edit.
    const block = carryLoop();
    expect(block).toContain("stranded.length > 0");
    expect(block).toMatch(
      /orphanSpecHoldAfterCarry\(\{\s*membrane,\s*specPath,\s*stranded,\s*refused,/,
    );
    expect(block).toContain("partition.held.push(held)");
    expect(block).toContain("needsReconcile.push(held)");
  });

  it("takes the held spec back OUT of the delivery it was already in", () => {
    // It was prepared and pushed before this ran. A hold that only records
    // itself would report the file as withheld and ship it anyway.
    const block = carryLoop();
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
 * THE OTHER HALF OF THE SPEC CHANNEL — a spec this clone keeps, left behind.
 *
 * The forward half judges a spec the delivery carries. This half judges the
 * converse — a subject the delivery carries, asserted about by a spec it does
 * NOT carry — which is what failed `verify` on cascade PR #26 to the CRM
 * clone. Its safety rests on three positions, each asserted as source: it
 * reads the SAME crossing set the forward half reads, it carries nothing the
 * evidence rule has not cleared, and nothing it finds is shipped past.
 */
describe("the engine looks for the specs a delivery leaves behind", () => {
  /** From the kept-spec read to the statement after the carry loop. */
  const reverseHalf = () => {
    const from = engine.indexOf("const keptSpecSubjects = new Map<string, string[]>();");
    const to = engine.indexOf("const finalProgress: Partial<CascadeResultUpdate>");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return engine.slice(from, to);
  };

  it("reads the kept specs once, before the loop, from BOTH sides and only with both trees", () => {
    const read = engine.indexOf("const keptSpecSubjects = new Map<string, string[]>();");
    const loop = engine.indexOf("for (let round = 0; ; round += 1) {");
    expect(read).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(read);
    const block = engine.slice(read, loop);
    expect(block).toMatch(/if \(primeShaByPath !== null && cloneShaByPath !== null\)/);
    expect(block).toContain("specsBothSidesHoldDifferently({");
    // Prime's copy and the clone's: either may name what the other does not,
    // and the clone's is the one CI runs.
    expect(block).toMatch(/readTexts\(primeRef,\s*primeTree,\s*kept\)/);
    expect(block).toMatch(/readTexts\(cloneRef,\s*cloneTree,\s*kept\)/);
    expect(block).toContain("fetchBlobTextsBatched(octokit, ref, entries)");
  });

  it("reads each copy against its OWN tree, and its modules from its own side", () => {
    // Resolved against prime's tree, the clone's copy importing a module only
    // the clone holds named nothing — so removing that module looked like no
    // change to the spec that imports it, and nothing else in the delivery
    // holds such a spec: it is neither clone-only nor held.
    const read = engine.indexOf("const keptSpecSubjects = new Map<string, string[]>();");
    const loop = engine.indexOf("for (let round = 0; ; round += 1) {");
    const block = engine.slice(read, loop);
    expect(block).toContain("const treeOf = { prime: primeTree, clone: cloneTree } as const;");
    expect(block).toContain("const refOf = { prime: primeRef, clone: cloneRef } as const;");
    expect(block).toMatch(/text: specsOf\[side\]\.get\(spec\),\s*tree: treeOf\[side\],/);
    // Both sides are read in one round (keptSpecReadsBothSides.contract.test.ts
    // pins the round); each is still read from its own repository and tree.
    expect(block).toContain("readTexts(refOf[side], treeOf[side], asking[side])");
    expect(block).toContain("subjectsOfKeptSpec({");
    // The one-tree reading is gone, not merely unused.
    expect(engine).not.toContain("specSubjects({");
  });

  it("defers on a rate limit rather than skipping this half on the window's say-so", () => {
    const read = engine.indexOf("const keptSpecSubjects = new Map<string, string[]>();");
    const loop = engine.indexOf("for (let round = 0; ; round += 1) {");
    const block = engine.slice(read, loop);
    expect(block).toMatch(
      /catch \(e\) \{\s*if \(classifyGitHubFailure\(e\)\.kind === "rate_limited"\) throw e;/,
    );
  });

  it("judges a spec left behind by what the delivery CHANGES, never by what a pump merely decided", () => {
    // Prime's files written verbatim, a pump's merge where it differs from the
    // clone's file, and the removals the finished plan makes. A pump's steady
    // state writes nothing — the merged file IS the clone's — and the first
    // replay held the clone's own spec under "this delivery updates
    // supabase/config.toml" on a delivery that wrote no config.toml. Leaving
    // every pumped path out was wrong the other way: a pump that DOES change
    // config.toml changed it, and a spec asserting about it went unjudged.
    expect(engine).toMatch(
      /const changedOnClone = \(\) =>\s*pathsTheDeliveryChanges\(\{\s*entries: treeEntries,\s*reconciled: reconciledPaths,\s*reconcileWrites,\s*rehearsed: rehearsedWrites,\s*removing: deletesCrossing,?\s*\}\);/,
    );
    const block = reverseHalf();
    // Every question this half asks about crossing is ONE question, asked of
    // the changed set and the finished removals, so no site can ask another.
    const calls = engine.match(/specsLeftBehind\(\{[^}]*\}\)/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("crossing: changedOnClone()");
    expect(calls[0]).toContain("removing: deletesCrossing");
    expect((block.match(/\bkeptLeftBehind\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(block).toContain("const changedAtStart = changedOnClone();");
    // A pumped path is the pump's: never a kept spec carried in over it.
    expect(block).toMatch(
      /\.filter\(\s*\(path\) => !changedAtStart\.has\(path\) && !reconciledPaths\.has\(path\),?\s*\)/,
    );
    // The forward half keeps the pumps' decisions as delivered: a spec naming
    // a reconciled path is judged by the merge, not stranded on it.
    const at = engine.indexOf("strandedSubjects({");
    expect(engine.slice(at, at + 400)).toContain("crossing: deliveredPaths");
    expect(engine).toMatch(
      /const deliveredPaths = new Set\(\[\.\.\.treeEntries\.map\(\(t\) => t\.path\), \.\.\.reconciledPaths\]\);/,
    );
  });

  it("counts a pump's merge as a change exactly where it changes the clone's file", () => {
    // Each pump's `changed` is `merged !== clone`, and a rehearsal composes no
    // entry for these three, so what they would write is recorded apart.
    const between = (from: string, to: string) => {
      const a = engine.indexOf(from);
      const b = engine.indexOf(to, a);
      expect(a, from).toBeGreaterThan(-1);
      expect(b, to).toBeGreaterThan(a);
      return engine.slice(a, b);
    };
    const pumps = [
      [between("reconcileConfigToml({", "reconcileSecurityRegistry({"), "CONFIG_TOML_PATH"],
      [
        between("reconcileSecurityRegistry({", "cloneOnlyEdgeFunctions({"),
        "SECURITY_REGISTRY_PATH",
      ],
      [
        between("reconcileDeployWorkflow({", "const changedOnClone = () =>"),
        "DEPLOY_WORKFLOW_PATH",
      ],
    ] as const;
    for (const [block, path] of pumps) {
      const changed = block.indexOf("if (verdict.changed");
      const write = block.indexOf(`reconcileWrites.add(${path});`);
      expect(changed, path).toBeGreaterThan(-1);
      expect(write, path).toBeGreaterThan(changed);
      expect(block, path).toContain(`if (dryRun) rehearsedWrites.add(${path});`);
    }
    // The two baselines carry no `changed`; the clone's blob id answers it.
    const settle = between("const settleBaseline = async (", "if (inventoryHold) {");
    expect(settle).toMatch(
      /if \(cloneShaByPath\?\.get\(held\.path\) !== gitBlobSha\(outcome\.merged\)\) \{\s*reconcileWrites\.add\(held\.path\);/,
    );
  });

  it("counts as removed only what the finished deletion plan removes", () => {
    // A deletion verdict is provisional until the reference check and the
    // bulk cap have spoken, and either can withhold it. Judged against the
    // provisional list, a kept spec was replaced for a file that then stayed
    // exactly as it was.
    const withhold = engine.indexOf(
      "if (pendingDeletes.length > 0) await withholdStillReferenced(await deletionSurvivors(new Map()));",
    );
    const plan = engine.indexOf(
      "let deletionPlan = planDeletions(deletionVerdicts, MAX_DELETIONS_PER_CASCADE, deletionApproved);",
    );
    const read = engine.indexOf("const keptSpecSubjects = new Map<string, string[]>();");
    expect(withhold).toBeGreaterThan(engine.indexOf("reconcileDeployWorkflow({"));
    expect(plan).toBeGreaterThan(withhold);
    expect(read).toBeGreaterThan(plan);
    // The removals the channel reads are only ever the plan's.
    const assigns = engine.match(/\bdeletesCrossing(?::[^=]+)? = [^;]+;/g) ?? [];
    expect(assigns).toHaveLength(2);
    for (const assign of assigns) expect(assign).toMatch(/= new Set\(deletionPlan\.deletes\);$/);
    // And never the provisional list, anywhere in this half.
    expect(reverseHalf()).not.toContain("pendingDeletes");
  });

  it("narrows the removals once the specs that stay are known, and never widens them", () => {
    // A kept spec the channel did not bring across stays as it is, and a file
    // it imports cannot be removed beneath it. Counted before the channel, it
    // would withhold every removal it asserts about for ever — a spec is never
    // brought across for a removal that does not happen — so it is asked here.
    const sweep = engine.indexOf("for (const lb of keptLeftBehind()) {");
    const at = engine.indexOf("if (deletesCrossing.size > 0 && deletionPlan.refusal === null) {");
    const baseline = engine.indexOf("reconcileEdgeTypecheckBaseline({");
    expect(sweep).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(sweep);
    expect(baseline).toBeGreaterThan(at);
    const branch = engine.slice(at, baseline);
    // What stays is the clone's copy of every kept spec that did not land.
    expect(branch).toContain("[...cloneKeptText].filter(([spec]) => !landedNow.has(spec))");
    expect(branch).toContain("await withholdStillReferenced(await deletionSurvivors(staying));");
    // Re-planned from verdicts that only ever lost a delete, and only where the
    // first plan was accepted: a refused set is never trimmed to fit the cap.
    expect(branch).toContain(
      "deletionPlan = planDeletions(deletionVerdicts, MAX_DELETIONS_PER_CASCADE, deletionApproved);",
    );
    // Before the channel, the kept specs are not survivors.
    const preLoop = engine.slice(
      engine.indexOf("const deletionSurvivors = async ("),
      engine.indexOf("let deletionPlan = planDeletions("),
    );
    expect(preLoop).not.toContain("cloneKeptText");
    expect(preLoop).toContain("deletionSurvivors(new Map())");
  });

  it("carries a left-behind spec only where the evidence rule released it", () => {
    const block = reverseHalf();
    expect(block).toContain("decideHoldRelease({");
    expect(block).toMatch(/if \(verdict\.act === "release"\) releasing\.push\(lb\.spec\);/);
    // `owedSpecs` gains a spec in exactly one place, and only from `releasing`.
    const pushes = block.match(/owedSpecs\.push\(/g) ?? [];
    expect(pushes).toHaveLength(1);
    expect(block).toMatch(/for \(const spec of releasing\) \{[\s\S]*?owedSpecs\.push\(spec\);/);
    // And what is owed meets the plan — the exclusions, the ceiling, `prepareOne`.
    expect(block).toMatch(/stranded:\s*\[.*\.\.\.importsOwed,\s*\.\.\.owedSpecs\]/);
  });

  it("asks what prime's copy would need outside the content roots BEFORE the spec moves", () => {
    const block = reverseHalf();
    const release = block.indexOf("if (releasing.length > 0) {");
    expect(release).toBeGreaterThan(-1);
    const branch = block.slice(release, block.indexOf("owedSpecs.push(spec);", release) + 30);
    // Read from PRIME's copy, the one that would land.
    expect(branch).toContain("const text = primeKeptText.get(spec);");
    expect(branch).toContain("outsideRootCandidates({");
    expect(branch).toContain("specText: text,");
    // Asked before the push, and a spec whose question went unasked stays put.
    const ask = branch.indexOf("await judgeOutsideRoot(");
    const unasked = branch.indexOf("!outsideVerdicts.has(path)");
    const push = branch.indexOf("owedSpecs.push(spec);");
    expect(ask).toBeGreaterThan(-1);
    expect(unasked).toBeGreaterThan(ask);
    expect(push).toBeGreaterThan(unasked);
    expect(branch).toMatch(
      /\.some\(\(path\) => !outsideVerdicts\.has\(path\)\)\) \{\s*leftBehindCut\.set\(spec, shouldStop\(\) \? "budget" : "outside_probes"\);\s*continue;/,
    );
  });

  it("asks prime's history within a ceiling and never past the pass's own clock", () => {
    const block = reverseHalf();
    // The spec's own question, not the one about files outside the roots.
    const from = block.indexOf("if (carryingAllowed && unjudged.length > 0) {");
    expect(from).toBeGreaterThan(-1);
    const branch = block.slice(from, block.indexOf("const releasing: string[] = [];", from));
    expect(branch).toContain("MAX_LEFT_BEHIND_PROBES - leftBehindProbes");
    const clock = branch.indexOf("if (shouldStop()) {");
    const probe = branch.indexOf("await probeHeldPaths({");
    expect(clock).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(clock);
  });

  it("holds a spec the evidence refused, for a person, rather than dropping it", () => {
    const block = reverseHalf();
    expect(block).toMatch(
      /if \(verdict\.act === "hold"\) \{\s*const held = leftBehindSpecHold\(\{/,
    );
    const at = block.indexOf('if (verdict.act === "hold") {');
    const branch = block.slice(at, at + 500);
    expect(branch).toContain("partition.held.push(held)");
    expect(branch).toContain("needsReconcile.push(held)");
    expect(branch).toContain("attemptedSubjects.add(lb.spec)");
  });

  it("holds every spec still left behind once the delivery is final — none is shipped past", () => {
    const loopEnd = engine.indexOf("if (round >= maxCarryRounds) carryingAllowed = false;");
    const sweep = engine.indexOf("for (const lb of keptLeftBehind()) {", loopEnd);
    const baseline = engine.indexOf("reconcileEdgeTypecheckBaseline({");
    expect(loopEnd).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(loopEnd);
    // Before the baseline reconcile, which reads the final crossing set too.
    expect(baseline).toBeGreaterThan(sweep);
    const block = engine.slice(sweep, sweep + 900);
    expect(block).toContain("if (heldNow.has(lb.spec)) continue;");
    expect(block).toMatch(/leftBehindSpecHold\(\{[^}]*\bcutShort\b[^}]*\}\)/);
    expect(block).toContain("needsReconcile.push(held)");
  });

  it("says, on a forward hold, when the spec was only in play because it was left behind", () => {
    const block = reverseHalf();
    expect(block).toMatch(/const hold = lb \? withLeftBehindNote\(held, lb\) : held;/);
  });

  it("writes every note again from the finished delivery, naming a withheld removal", () => {
    // A note is written when its spec is judged, and a subject can be held
    // later in the pass or a removal withheld by the narrowing. So every hold
    // this half makes is registered, then rewritten — or dropped where nothing
    // is left to say — once the delivery is final.
    const block = reverseHalf();
    expect(block.match(/reverseHolds\.set\(/g) ?? []).toHaveLength(3);
    const at = engine.indexOf("if (reverseHolds.size > 0) {");
    const baseline = engine.indexOf("reconcileEdgeTypecheckBaseline({");
    const narrowing = engine.indexOf(
      "if (deletesCrossing.size > 0 && deletionPlan.refusal === null) {",
    );
    const note = engine.indexOf("const specsBroughtAcrossNote = describeSpecsBroughtAcross({");
    expect(at).toBeGreaterThan(baseline);
    expect(at).toBeGreaterThan(narrowing);
    expect(note).toBeGreaterThan(at);
    const refresh = engine.slice(at, note);
    expect(refresh).toContain("keptLeftBehind()");
    expect(refresh).toContain(
      "[...plannedBeforeTheChannel].filter((p) => !deletesCrossing.has(p))",
    );
    expect(refresh).toContain("replaceHold(entry.current, next);");
    // Replaced or dropped in BOTH lists, by identity.
    const replace = engine.slice(engine.indexOf("const replaceHold = ("), at);
    expect(replace).toContain("for (const list of [partition.held, needsReconcile]) {");
    expect(replace).toContain("const at = list.indexOf(prev);");
  });

  it("names what it brought across in the pull request — only what landed", () => {
    expect(engine).toContain("const specsBroughtAcrossNote = describeSpecsBroughtAcross({");
    expect(engine).toMatch(
      /const landed = new Set\(treeEntries\.filter\(\(t\) => t\.sha !== null\)\.map\(\(t\) => t\.path\)\);/,
    );
    const at = engine.indexOf("const specsBroughtAcrossNote = describeSpecsBroughtAcross({");
    const composed = engine.slice(at, at + 900);
    expect(composed).toMatch(/verdict\.act === "release" && landed\.has\(spec\)/);
    expect(composed).toContain(".filter(([path]) => landed.has(path))");
    // Named for what the delivery FINALLY changes, and what it was brought
    // across for that the delivery no longer changes is said to be unchanged.
    const finalAt = engine.indexOf("const finalChanged = changedOnClone();");
    expect(finalAt).toBeGreaterThan(engine.indexOf("reconcileEdgeTypecheckBaseline({"));
    expect(at).toBeGreaterThan(finalAt);
    expect(composed).toContain(
      "unchanged: (leftBehind.get(spec)?.touchedBy ?? []).filter((s) => !finalChanged.has(s))",
    );
    expect(engine).toContain("### Brought across beside the files they test");
  });
});

describe("a spec's subject outside the content roots travels only on evidence", () => {
  /** The forward loop's first statements: where a round decides what is stranded. */
  const roundTop = () => {
    const from = engine.indexOf("for (let round = 0; ; round += 1) {");
    const to = engine.indexOf("for (const owed of [...importsOwed]) {", from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return engine.slice(from, to);
  };
  /** The one place such a file is put to prime's history. */
  const judge = () => {
    const from = engine.indexOf("const judgeOutsideRoot = async");
    const to = engine.indexOf("\n  };", from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return engine.slice(from, to);
  };

  it("reads every delivered spec against the forward half's own crossing set", () => {
    const top = roundTop();
    expect(top).toContain("outsideRootCandidates({");
    const at = top.indexOf("outsideRootCandidates({");
    expect(top.slice(at, at + 250)).toContain("crossing: deliveredPaths");
  });

  it("joins a spec's stranded subjects only on a release verdict, and is then carried or holds the spec", () => {
    const top = roundTop();
    expect(top).toMatch(/if \(carryingAllowed\) \{\s*await judgeOutsideRoot\(/);
    expect(top).toContain('outsideVerdicts.get(path)?.act === "release"');
    expect(top).toContain(
      "strandedBySpec.set(specPath, [...(strandedBySpec.get(specPath) ?? []), ...travelling]);",
    );
  });

  it("asks within its own ceiling, never past the clock, and never takes a failed read for a verdict", () => {
    const block = judge();
    expect(block).toContain("MAX_OUTSIDE_ROOT_PROBES - outsideProbes");
    const clock = block.indexOf("shouldStop()");
    const probe = block.indexOf("await probeHeldPaths({");
    expect(clock).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(clock);
    expect(block).toMatch(/if \(answer\.kind === "unsettled"\) continue;/);
    // The verdict is the held-path rule's, word for word: nothing of the
    // clone's may be lost, or a person approved losing it.
    expect(block).toContain("decideHoldRelease({");
    expect(block).toContain("overwriteApproved.has(path)");
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
