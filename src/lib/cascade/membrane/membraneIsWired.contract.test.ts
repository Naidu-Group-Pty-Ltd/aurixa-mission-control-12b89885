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
    expect(engine).toContain("permeate(membrane, { path, text: primeFile.content })");
  });

  it("acts on a refusal rather than only recording it", () => {
    const at = engine.indexOf("permeate(membrane,");
    const block = engine.slice(at, at + 400);
    expect(block).toContain('verdict.kind === "blocked"');
    expect(block).toContain('return { kind: "held", held: verdict.held }');
  });

  it("asks the spec channel with BOTH trees", () => {
    const at = engine.indexOf("strandedSubjects({");
    expect(at).toBeGreaterThan(-1);
    const block = engine.slice(at, at + 400);
    expect(block).toContain("primeSha: primeShaByPath");
    expect(block).toContain("cloneSha: cloneShaByPath");
  });

  it("judges a spec against what this pass WRITES, never against the candidates", () => {
    // `partition.write` is the candidate set and a candidate can still be
    // held — by the oversize rule, the workflow rule, the backend-identity
    // rule or the membrane's own per-file channels. A spec judged against it
    // crosses beside a subject that was held three lines later, which is the
    // exact shape this channel exists to refuse.
    const at = engine.indexOf("strandedSubjects({");
    const block = engine.slice(at, at + 400);
    expect(block).toContain("crossing: deliveredPaths");
    expect(engine).toContain("const deliveredPaths = new Set(treeEntries.map((t) => t.path))");
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

  it("holds the spec rather than dropping it silently", () => {
    const at = engine.indexOf("strandedSubjects({");
    const block = engine.slice(at, at + 1200);
    expect(block).toContain("stranded.length === 0) continue");
    expect(block).toContain("orphanSpecHold({ membrane, specPath, stranded })");
    expect(block).toContain("partition.held.push(held)");
    expect(block).toContain("needsReconcile.push(held)");
  });

  it("takes the held spec back OUT of the delivery it was already in", () => {
    // It was prepared and pushed before this ran. A hold that only records
    // itself would report the file as withheld and ship it anyway.
    const at = engine.indexOf("strandedSubjects({");
    const block = engine.slice(at, at + 1400);
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
    const matches = engine.match(/membraneInto\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
