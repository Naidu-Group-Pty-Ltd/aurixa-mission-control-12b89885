import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checksUnreadable,
  decideCascadeMerge,
  REQUIRED_CHECKS,
  type CheckRun,
} from "./autoMergeGate.pure";

const ok = (name: string): CheckRun => ({ name, status: "completed", conclusion: "success" });
/** The required jobs, all green — the baseline every case below starts from. */
const required = () => REQUIRED_CHECKS.map((n) => ok(n));
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
    const v = decideCascadeMerge([ok("verify"), red("security")]);
    expect(v.why).toContain("security");
  });

  it("treats neutral, skipped and stale as not blocking", () => {
    const v = decideCascadeMerge([
      ...required(),
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
      expect(decideCascadeMerge([...required(), red("x", conclusion)])).toMatchObject({
        merge: false,
        reason: "failing",
      });
    },
  );

  it("treats a null conclusion on a completed run as blocking", () => {
    expect(
      decideCascadeMerge([...required(), { name: "x", status: "completed", conclusion: null }]),
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

  it("never squashes", () => {
    // A squash rewrites the cascade commit naming the prime SHA it came from,
    // which is the one durable record of what a clone has received. The merge
    // itself now happens in the drain — see its own tests — because the engine
    // cannot wait seventeen minutes for `verify` inside one request.
    expect(autoMergeBlock).not.toContain("SQUASH");
  });
});

describe("the asynchronous-check race", () => {
  // The hole this closes. Check runs appear over time: `Vercel Preview
  // Comments` completes in the same second the pull request opens, and
  // `verify` — install, typecheck, build, ~19,000 tests — takes about
  // seventeen minutes to report at all. A gate that asked "has every check I
  // can SEE passed?" answered yes to a single fast check and merged before the
  // job that matters had started.

  it("refuses when only the instant check has reported", () => {
    const v = decideCascadeMerge([ok("Vercel Preview Comments")]);
    expect(v).toMatchObject({ merge: false, reason: "awaiting_required" });
  });

  it("names what it is waiting for", () => {
    const v = decideCascadeMerge([ok("Vercel Preview Comments")]);
    expect(v.why).toContain("verify");
  });

  it("refuses while a required check is merely absent, not pending", () => {
    // `security` green, `verify` not created yet — nothing is "pending",
    // which is exactly why counting could not see the problem.
    expect(decideCascadeMerge([ok("security"), ok("supply-chain")])).toMatchObject({
      merge: false,
      reason: "awaiting_required",
    });
  });

  it("merges once every required check has reported green", () => {
    expect(decideCascadeMerge([...required(), ok("supply-chain")]).merge).toBe(true);
  });

  it("still refuses a required check that reported and FAILED", () => {
    const checks = [ok("security"), red("verify")];
    expect(decideCascadeMerge(checks)).toMatchObject({ merge: false, reason: "failing" });
  });

  it("still refuses a required check that is running", () => {
    expect(decideCascadeMerge([ok("security"), running("verify")])).toMatchObject({
      merge: false,
      reason: "pending",
    });
  });

  it("requires verify — the job that builds and tests", () => {
    // Pinned by name rather than by count, because the whole defect was that
    // a count cannot tell which check it counted.
    expect(REQUIRED_CHECKS).toContain("verify");
  });
});

describe("the merge drain", () => {
  const src = readFileSync(join(process.cwd(), "src/server/cascadeMergeDrain.server.ts"), "utf8");

  it("touches only branches this engine names", () => {
    expect(src).toContain('CASCADE_BRANCH_PREFIX = "aurixa/cascade-"');
    expect(src).toContain("p.head.ref.startsWith(CASCADE_BRANCH_PREFIX)");
  });

  it("decides with the SAME rule the engine uses", () => {
    // Two definitions of "green" is one definition of green and one bug.
    expect(src).toContain("decideCascadeMerge(");
    expect(src).toContain("REQUIRED_CHECKS");
  });

  it("reads checks on the pull request's current head", () => {
    expect(src).toContain("ref: pr.head.sha");
  });

  it("merges with MERGE, never SQUASH", () => {
    expect(src).toContain('merge_method: "merge"');
    expect(src).not.toContain('merge_method: "squash"');
  });

  it("throws rather than reporting an empty fleet when the clone list fails", () => {
    expect(src).toMatch(/Could not list clones/);
  });
});

describe("when the App cannot read check runs", () => {
  // `checks: read` is a separate GitHub App permission from `pull_requests`.
  // Without it the check-runs endpoint answers "Resource not accessible by
  // integration" — which is not a red check and not a green one, but no
  // signal at all. Measured on the live fleet the first time the drain ran.

  it("recognises the permission refusal", () => {
    expect(
      checksUnreadable(
        new Error(
          "Resource not accessible by integration - https://docs.github.com/rest/checks/runs#list-check-runs-for-a-git-reference",
        ),
      ),
    ).toBe(true);
  });

  it("does not mistake an ordinary failure for it", () => {
    expect(checksUnreadable(new Error("Bad credentials"))).toBe(false);
    expect(checksUnreadable(new Error("Not Found"))).toBe(false);
  });

  it("is never treated as permission to merge", () => {
    // The whole risk of this state is that an unreadable signal reads as a
    // clear one. There is no code path from `checksUnreadable` to a merge:
    // both callers hold, and the gate itself never sees the error.
    const drain = readFileSync(
      join(process.cwd(), "src/server/cascadeMergeDrain.server.ts"),
      "utf8",
    );
    const held = drain.slice(drain.indexOf("if (checksUnreadable(e))"));
    expect(held.slice(0, 400)).toContain('outcome: "held"');
    expect(held.slice(0, 400)).not.toContain("pulls.merge");
  });

  it("does NOT fall back to mergeable_state", () => {
    // `clean` is what a pull request with NO checks reports, so falling back
    // would reintroduce the `no_checks` hole precisely on the deployments
    // where the permission is missing — the ones nobody is watching.
    const drain = readFileSync(
      join(process.cwd(), "src/server/cascadeMergeDrain.server.ts"),
      "utf8",
    );
    expect(drain).not.toContain("mergeable_state");
  });
});
