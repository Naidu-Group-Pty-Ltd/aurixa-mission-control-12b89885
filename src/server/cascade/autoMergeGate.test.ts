import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideCascadeMerge, type CheckRun } from "./autoMergeGate.pure";

const ok = (name: string): CheckRun => ({ name, status: "completed", conclusion: "success" });
const red = (name: string, c = "failure"): CheckRun => ({
  name,
  status: "completed",
  conclusion: c,
});
const running = (name: string): CheckRun => ({ name, status: "in_progress", conclusion: null });

describe("decideCascadeMerge", () => {
  it("merges when every check has passed", () => {
    const v = decideCascadeMerge([ok("verify"), ok("security")]);
    expect(v.merge).toBe(true);
  });

  it("refuses when nothing has reported — no checks is not all-clear", () => {
    // This is the exact condition that put a clone's `main` in a state that
    // could not `npm ci`: a tree nothing had built, merged because nothing
    // objected.
    const v = decideCascadeMerge([]);
    expect(v).toMatchObject({ merge: false, reason: "no_checks" });
  });

  it("refuses while a check is still running", () => {
    expect(decideCascadeMerge([ok("verify"), running("security")])).toMatchObject({
      merge: false,
      reason: "pending",
    });
  });

  it("refuses on a failing check", () => {
    expect(decideCascadeMerge([ok("verify"), red("security")])).toMatchObject({
      merge: false,
      reason: "failing",
    });
  });

  it("reports failure rather than pending when both are true", () => {
    // Waiting for the rest changes nothing once something is red, and
    // "still running" would send an operator back to read the same answer.
    const v = decideCascadeMerge([red("security"), running("verify")]);
    expect(v).toMatchObject({ merge: false, reason: "failing" });
  });

  it("names the failing checks so the reason is actionable", () => {
    const v = decideCascadeMerge([red("security")]);
    expect(v.why).toContain("security");
  });

  it("treats neutral, skipped and stale as not blocking", () => {
    const v = decideCascadeMerge([
      ok("verify"),
      red("a", "neutral"),
      red("b", "skipped"),
      red("c", "stale"),
    ]);
    expect(v.merge).toBe(true);
  });

  it.each(["cancelled", "timed_out", "action_required", "failure", "startup_failure", "weird"])(
    "treats a completed `%s` as blocking",
    (conclusion) => {
      // None of these is evidence the tree is good, and treating an
      // unfamiliar conclusion as passing is how a gate stops being one.
      expect(decideCascadeMerge([ok("verify"), red("x", conclusion)])).toMatchObject({
        merge: false,
        reason: "failing",
      });
    },
  );

  it("treats a null conclusion on a completed run as blocking", () => {
    expect(
      decideCascadeMerge([{ name: "x", status: "completed", conclusion: null }]),
    ).toMatchObject({ merge: false, reason: "failing" });
  });
});

describe("an auto_merge cascade cannot reach a default branch except through a PR", () => {
  // Asserted against the source: exercising it would need a token that can push
  // to production repositories, which is what a test must not hold.
  const src = readFileSync(join(process.cwd(), "src/server/cascade-engine.server.ts"), "utf8");

  // Sliced from the ORIGINAL source between the two mode markers, then stripped
  // of line comments inside that slice only. A whole-file block-comment regex
  // over-consumes here — this module's prose contains sequences that open a
  // comment the pattern never closes — and an empty slice makes every
  // `not.toContain` below pass vacuously, which is worse than no test.
  const blockStart = src.indexOf('if (mode === "auto_merge")');
  const blockEnd = src.indexOf("=== pr mode:", blockStart);
  const autoMergeBlock = src
    .slice(blockStart, blockEnd)
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
    .join("\n");

  it("finds the block at all — an empty slice would pass every check below", () => {
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    expect(autoMergeBlock).toContain("pulls.create(");
  });

  it("never pushes straight to the clone's default branch", () => {
    // The old first move was `git.updateRef` on `heads/${cloneRef.branch}`,
    // which succeeds on every unprotected branch — which is every clone here.
    expect(autoMergeBlock).not.toMatch(/updateRef\([^)]*cloneRef\.branch/s);
    expect(autoMergeBlock).not.toContain("heads/${cloneRef.branch}");
  });

  it("consults the checks before every merge on this path", () => {
    const mergeAt = autoMergeBlock.indexOf("pulls.merge(");
    const decideAt = autoMergeBlock.indexOf("decideCascadeMerge(");
    expect(decideAt).toBeGreaterThan(-1);
    expect(mergeAt).toBeGreaterThan(decideAt);
    // And exactly one merge call, so a second path cannot skip the gate.
    expect(autoMergeBlock.match(/pulls\.merge\(/g) ?? []).toHaveLength(1);
  });

  it("merges with MERGE, never SQUASH", () => {
    // A squash rewrites the cascade commit naming the prime SHA it came from,
    // which is the one durable record of what a clone has received.
    expect(autoMergeBlock).not.toContain("SQUASH");
    expect(autoMergeBlock).toContain('merge_method: "merge"');
  });
});
