/**
 * WHERE THE EDGE FUNCTION TYPE BASELINE IS RECONCILED, AND WHY THERE.
 *
 * The reconcile keeps the clone's count for a file the clone keeps its own
 * version of, and "keeps" is decided by what the delivery writes. So its
 * position is the property: read before the subject carry, it would keep the
 * clone's count for a file the carry then replaced with prime's, and prime's
 * version can carry MORE errors than the count kept — the gate fails exactly
 * as it did on cascade #23, from the other side.
 *
 * Asserted as SOURCE, like `carryGate.contract.test.ts`, because the
 * property is in the order of the code and a behavioural test with a fake
 * Octokit would pass while a rearranged engine lost it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../sourceComments.pure";

const engine = stripComments(readFileSync("src/server/cascade-engine.server.ts", "utf8"));

/** The reconcile step, from its note to the statement after it. */
function reconcileStep(): string {
  const from = engine.indexOf("let edgeBaselineNote: string | null = null;");
  const to = engine.indexOf("const finalProgress: Partial<CascadeResultUpdate>");
  expect(from, "reconcile step not found").toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return engine.slice(from, to);
}

describe("the baseline is reconciled over the finished delivery", () => {
  it("runs after the subject carry", () => {
    const loopEnd = engine.indexOf("if (round >= maxCarryRounds) carryingAllowed = false;");
    const step = engine.indexOf("reconcileEdgeTypecheckBaseline({");
    expect(loopEnd).toBeGreaterThan(-1);
    expect(step).toBeGreaterThan(loopEnd);
  });

  it("runs before the delivery is judged empty", () => {
    // A pass whose only difference was a baseline the clone already agrees
    // with writes nothing, and must be reported as in sync rather than as a
    // one-file cascade.
    const step = engine.indexOf("reconcileEdgeTypecheckBaseline({");
    const emptyCheck = engine.indexOf(
      "if (treeEntries.length === 0 && pendingDeletes.length === 0) {",
    );
    expect(emptyCheck).toBeGreaterThan(step);
  });

  it("counts a delete as crossing — the deletes the finished plan makes", () => {
    // A file this pass deletes does not survive on the clone, so the clone's
    // count for it describes nothing. A deletion the reference check or the
    // bulk cap withheld DOES survive, and the clone's count still describes
    // it — so the set is the finished plan's, never the provisional
    // `pendingDeletes`.
    expect(reconcileStep()).toMatch(
      /const crossing = new Set<string>\(\[\s*\.\.\.treeEntries\.filter\(\(t\) => t\.sha !== null\)\.map\(\(t\) => t\.path\),\s*\.\.\.deletesCrossing,?\s*\]\)/,
    );
    expect(reconcileStep()).not.toContain("pendingDeletes");
  });

  it("acts only where prime's baseline is in the delivery", () => {
    expect(reconcileStep()).toMatch(
      /treeEntries\.some\(\(t\) => t\.path === EDGE_TYPECHECK_BASELINE_PATH && t\.sha !== null\)/,
    );
  });
});

describe("a refusal changes nothing", () => {
  it("drops prime's copy only when a count was kept", () => {
    // Declining leaves prime's copy standing — what every pass did before
    // this existed — rather than withholding the file.
    const step = reconcileStep();
    const keep = step.indexOf("} else if (verdict.keptFromClone.length > 0) {");
    const drop = step.indexOf("dropFromTree(EDGE_TYPECHECK_BASELINE_PATH)");
    expect(keep).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(keep);
    expect(step.match(/dropFromTree\(/g) ?? []).toHaveLength(1);
  });

  it("never fails the pass", () => {
    const step = reconcileStep();
    expect(step.indexOf("try {")).toBeGreaterThan(-1);
    expect(step.indexOf("try {")).toBeLessThan(step.indexOf("getFileContent("));
    expect(step).toContain("} catch (e) {");
  });

  it("is skipped on a notification-only pass", () => {
    expect(reconcileStep()).toContain('mode !== "notify"');
  });
});
