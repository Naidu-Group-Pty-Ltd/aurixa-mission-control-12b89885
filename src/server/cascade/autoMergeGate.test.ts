import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkNeverStarted,
  checksUnreadable,
  decideCascadeMerge,
  NEVER_STARTED_CEILING_MS,
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

describe("a CI that never started", () => {
  // The shape every private clone repository showed from 05:35 UTC on
  // 4 September 2026: created, "failed" two to ten seconds later, no runner, no
  // step, no log. The public repositories beside them ran the same workflows.
  const at = (seconds: number) => new Date(Date.UTC(2026, 8, 6, 8, 17, 53 + seconds)).toISOString();
  const dead = (name: string, seconds = 2): CheckRun => ({
    name,
    status: "completed",
    conclusion: "failure",
    started_at: at(0),
    completed_at: at(seconds),
  });
  const ranAndFailed = (name: string, seconds = 480): CheckRun => dead(name, seconds);

  it("names the condition when every failed job ended within seconds of starting", () => {
    const v = decideCascadeMerge([dead("verify"), dead("security", 3)]);
    expect(v).toMatchObject({ merge: false, reason: "never_started" });
    expect(v.why).toContain("verify");
    expect(v.why).toContain("security");
    // Where it is fixed, because "failing" sent an operator to read a tree
    // nothing had built.
    expect(v.why).toContain("spending limit");
    expect(v.why).toContain("Billing");
  });

  it("still refuses — never started is not a pass", () => {
    expect(decideCascadeMerge([dead("verify"), dead("security")]).merge).toBe(false);
  });

  it("reads a job that ran for minutes and failed as a real failure", () => {
    expect(decideCascadeMerge([ok("verify"), ranAndFailed("security")])).toMatchObject({
      reason: "failing",
    });
  });

  it("reads a mix as a real failure — one job did run", () => {
    expect(decideCascadeMerge([ranAndFailed("verify"), dead("security")])).toMatchObject({
      reason: "failing",
    });
  });

  it("never guesses without timestamps", () => {
    expect(decideCascadeMerge([red("verify"), red("security")])).toMatchObject({
      reason: "failing",
    });
    expect(checkNeverStarted({ name: "verify", status: "completed", conclusion: "failure" })).toBe(
      false,
    );
    expect(
      checkNeverStarted({
        name: "verify",
        status: "completed",
        conclusion: "failure",
        started_at: "not a date",
        completed_at: at(1),
      }),
    ).toBe(false);
  });

  it("does not read a fast pass, or a running job, as never started", () => {
    const fast: CheckRun = {
      name: "Vercel Preview Comments",
      status: "completed",
      conclusion: "success",
      started_at: at(0),
      completed_at: at(0),
    };
    expect(checkNeverStarted(fast)).toBe(false);
    expect(decideCascadeMerge([...required(), fast]).merge).toBe(true);
    expect(checkNeverStarted({ ...dead("verify"), status: "in_progress", conclusion: null })).toBe(
      false,
    );
  });

  it("holds the ceiling where a genuine failure cannot reach", () => {
    // A runner, a checkout and one step take longer than this; the observed
    // never-started jobs took two to ten seconds.
    expect(NEVER_STARTED_CEILING_MS).toBeGreaterThanOrEqual(10_000);
    expect(NEVER_STARTED_CEILING_MS).toBeLessThanOrEqual(30_000);
    expect(checkNeverStarted(dead("verify", NEVER_STARTED_CEILING_MS / 1000 + 1))).toBe(false);
  });

  it("is a reading both callers can take — the timestamps travel", () => {
    // Without `started_at`/`completed_at` on the mapped check, the gate can
    // only ever say "failing"; the engine and the drain must both pass them.
    for (const file of [
      "src/server/cascade-engine.server.ts",
      "src/server/cascadeMergeDrain.server.ts",
    ]) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src, file).toContain("started_at: c.started_at");
      expect(src, file).toContain("completed_at: c.completed_at");
    }
  });
});

describe("an auto_merge cascade cannot reach a default branch except through a PR", () => {
  // Asserted against the source: exercising it would need a token that can push
  // to production repositories, which is what a test must not hold.
  const src = readFileSync(join(process.cwd(), "src/server/cascade-engine.server.ts"), "utf8");

  // Sliced from the ORIGINAL source, then stripped of line comments inside that
  // slice only. A whole-file block-comment regex over-consumes here — this
  // module's prose contains sequences that open a comment the pattern never
  // closes — and an empty slice makes every `not.toContain` below pass
  // vacuously, which is worse than no test.
  //
  // The slice is the whole tail that writes to the clone: proposal first, then
  // the auto_merge merge attempt. It used to stop at the `pr mode` marker,
  // which stopped existing when the two modes were given ONE proposal rule
  // between them — and the assertions below are about what this region may do
  // to a default branch, which is the same question either way.
  const blockStart = src.indexOf("// === One open cascade proposal per clone");
  const blockEnd = src.indexOf("async function findOpenCascadePr", blockStart);
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

  it("opens ONE proposal per clone, in auto_merge as well as pr", () => {
    // `pr` mode learned this after eight cascades opened eight pull requests
    // carrying the same 57 files. `auto_merge` did not, on the reasoning that
    // the first would win and the rest would skip — which is false, because
    // auto-merge waits about seventeen minutes for checks and prime moves
    // faster than that. Three prime commits in thirty-one minutes gave the
    // clone #67, #68 and #69 at once, overlapping, cut from a common ancestor.
    expect(autoMergeBlock.match(/pulls\.create\(/g) ?? []).toHaveLength(1);
    const findAt = autoMergeBlock.indexOf("findOpenCascadePr(");
    const createAt = autoMergeBlock.indexOf("pulls.create(");
    expect(findAt).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(findAt);
  });

  it("writes no reason into a summary the drain will have to correct", () => {
    // `diff_summary` is written once and read for as long as the row exists,
    // so it holds what stays true. Why a pull request has not merged YET is a
    // fact about this minute, and putting it here is what left rows reading
    // "No check has reported on this pull request" long after every check had.
    expect(autoMergeBlock).not.toContain("verdict.why");
    expect(autoMergeBlock).not.toContain("CHECKS_PERMISSION_REMEDY}");
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
    // From the point the unreadable-checks case is RECOGNISED to the end of
    // the statement that answers it. Sliced structurally rather than by a
    // character count, so reordering the handler cannot quietly widen it.
    const at = drain.indexOf("checksUnreadable(e)");
    expect(at).toBeGreaterThan(-1);
    const returnAt = drain.indexOf("return {", at);
    expect(returnAt).toBeGreaterThan(at);
    const handler = drain.slice(at, drain.indexOf(";", returnAt) + 1);
    expect(handler).toContain('outcome: "held"');
    expect(handler).not.toContain("pulls.merge");
  });

  it("reads mergeability only to REFUSE, never as permission", () => {
    // The drain does now look at `mergeable`, to hold a conflicted proposal
    // rather than retry a 405 every five minutes for ever. That direction is
    // safe — it can only ever decline.
    //
    // The other direction is the hole this rule was written for: `clean` is
    // also what a pull request with NO checks reports, so treating mergeability
    // as permission would merge an unbuilt tree precisely on the deployments
    // where the checks permission is missing — the ones nobody is watching.
    // So the assertion is about the RULE, not about one identifier: no
    // mergeability value may be a merge condition, and the gate stays the only
    // thing that authorises one.
    const drain = readFileSync(
      join(process.cwd(), "src/server/cascadeMergeDrain.server.ts"),
      "utf8",
    );
    expect(drain).not.toContain("mergeable_state");
    expect(drain).not.toMatch(/mergeable\s*===\s*true/);
    expect(drain).not.toContain('"clean"');
    expect(drain).not.toContain("'clean'");

    // Exactly one merge, and the gate is consulted before it.
    expect(drain.match(/pulls\.merge\(/g) ?? []).toHaveLength(1);
    const gateAt = drain.indexOf("decideCascadeMerge(");
    const mergeAt = drain.indexOf("pulls.merge(");
    expect(gateAt).toBeGreaterThan(-1);
    expect(mergeAt).toBeGreaterThan(gateAt);

    // And what it does on a conflict never ends in a merge. The whole handler
    // is checked rather than its first return: a conflicted proposal now has
    // more than one lawful exit — rebuilt on the clone's current head, or held
    // for a person — and neither may reach `pulls.merge`, because a retry
    // cannot change a conflict and 405 every five minutes is not a strategy.
    const at = drain.indexOf("pr.mergeable === false");
    expect(at).toBeGreaterThan(-1);
    const ordinaryPathAt = drain.indexOf('if (facts.state === "open") {', at);
    expect(ordinaryPathAt).toBeGreaterThan(at);
    const handler = drain.slice(at, ordinaryPathAt);
    expect(handler).not.toContain("pulls.merge");
    expect(handler).toContain('outcome: "held"');
    // Every exit from it is a hold or a rebuild — never a success, never a
    // failure, because a conflict is neither.
    expect(handler).not.toContain('outcome: "merged"');
    expect(handler).not.toContain('outcome: "failed"');
  });
});
