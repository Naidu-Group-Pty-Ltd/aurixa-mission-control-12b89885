/**
 * The properties that stop a bounded deploy from lying, and stop a dead pass
 * from stranding its row.
 *
 * Structural — where a call sits, what it is handed, and what state it leaves
 * behind — so they are asserted against the source. A Supabase double would
 * agree with wrong code here; ordering in the file cannot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Source with comments removed — a comment quoting code is not code. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const healing = stripComments(read("src/server/self-healing.server.ts"));
const provisioning = stripComments(read("src/server/backend-provisioning.server.ts"));
const drainHook = stripComments(read("src/routes/hooks.support-remediation-drain.tsx"));

const lane = healing.slice(
  healing.indexOf("async function executeEdgeFunctionDeploy"),
  healing.indexOf("async function executeMonitorRecovery"),
);

/** The budgeted deploy loop, which sits above the lane it serves. */
const budgetedLoop = healing.slice(
  healing.indexOf("async function deployWithinBudget"),
  healing.indexOf("async function executeEdgeFunctionDeploy"),
);

/** What the lane does with the run once its pass has finished deploying. */
const resumeBlock = lane.slice(
  lane.indexOf("planEdgeDeployResume({"),
  lane.lastIndexOf("return succeedRun(run, {"),
);

describe("a pass is bounded", () => {
  it("caps the fetch and skips what is already on the clone", () => {
    /*
      Measured 2 Sep 2026: the first live run of this lane asked for all 423
      bundles, ran thirty minutes and deployed nothing before its invocation
      was killed. Both options already existed on the snapshot; the lane had
      simply never used either.
    */
    expect(lane).toContain("skipFunctionSlugs: refreshed");
    expect(lane).toContain("functionLimit: EDGE_DEPLOY_BATCH");
  });

  it("caps only for the whole fleet", () => {
    // Against a named list the cap measures truncation over the UNFILTERED
    // set, which is how a pass comes to succeed on a deployment it never
    // performed. The conditional spread is the guard.
    expect(lane).toMatch(/wanted === null \? \{ functionLimit: EDGE_DEPLOY_BATCH \} : \{\}/);
  });

  it("decides the batch through the pure module rather than inline", () => {
    // The completion rule is the delicate part and belongs where it can be
    // unit-tested against the trap. Inline, it is one edit from wrong.
    expect(lane).toContain("planEdgeDeployPass(");
    expect(lane).toContain("pass.moreRemain");
  });
});

describe("progress is read off the target", () => {
  it("asks the clone what it holds before snapshotting the prime", () => {
    /*
      A `result` column the dying pass never reached is not progress. The
      clone is: a pass that deployed sixty bundles and then lost its
      invocation still counts on the next pass.
    */
    const askAt = lane.indexOf("listProjectEdgeFunctionFreshness(");
    const snapAt = lane.indexOf("fetchPrimeBackendSnapshot(");
    expect(askAt).toBeGreaterThan(-1);
    expect(snapAt).toBeGreaterThan(-1);
    expect(askAt).toBeLessThan(snapAt);
  });

  it("never reads its own result row as the progress source", () => {
    expect(lane).not.toMatch(/run\.result/);
  });

  it("a failed freshness read presumes nothing fresh", () => {
    // Empty redeploys more than necessary; a full answer would skip bundles
    // that were never deployed, silently. Same asymmetry as the provisioning
    // reader's own `.catch(() => [])`.
    const fn = provisioning.slice(
      provisioning.indexOf("export async function listProjectEdgeFunctionFreshness"),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("if (!res.ok) return fresh;");
    expect(body).toMatch(/catch \{\s*return fresh;/);
  });
});

describe("a partial deployment may not call itself complete", () => {
  it("hands the run back to the queue instead of succeeding", () => {
    const resumeAt = lane.indexOf('status: "planned"');
    const succeedAt = lane.lastIndexOf("return succeedRun(run, {");
    expect(resumeAt).toBeGreaterThan(-1);
    expect(resumeAt).toBeLessThan(succeedAt);
  });

  it("bounds the resuming so a bundle that always fails cannot loop for ever", () => {
    // A bundle that fails every pass never becomes `refreshed`. Without a
    // bound the run resumes until the end of time; `monitor_recovery` bounds
    // itself the same way.
    expect(resumeBlock).toContain("max_attempts");
    expect(resumeBlock).toContain("parkRun(");
  });

  it("anchors that block on something the source actually contains", () => {
    /*
      This file slices the source by string, so an anchor that stops matching
      does not fail — `indexOf` answers -1, `slice(-1, n)` answers "", and
      every `not.toContain` in the block passes over nothing. Two assertions
      here were reading an empty string before this was checked.
    */
    expect(lane.indexOf("planEdgeDeployResume({")).toBeGreaterThan(-1);
    expect(resumeBlock.length).toBeGreaterThan(200);
  });
});

describe("a pass stops at the budget instead of being killed by it", () => {
  it("the lane sets a deadline and hands it to the deploy loop", () => {
    /*
      The batch cap bounds what a pass FETCHES, not how long deploying it
      takes. Measured 2 Sep 2026: ~18 bundles landed in about a minute and
      the invocation was then killed mid-batch, leaving the row in
      `executing` where no work list selects it — so the fleet advanced ~18
      bundles per TWENTY minutes, the reaper's cycle, spending an attempt on
      each.
    */
    expect(lane).toContain("EDGE_DEPLOY_BUDGET_MS");
    expect(lane).toMatch(/deployWithinBudget\([\s\S]{0,120}deadlineAt/);
  });

  it("measures the budget from lane entry, not from the first deploy", () => {
    // The snapshot read spends the same invocation. Budgeting only the deploy
    // loop lets one pass overrun the ceiling the budget exists to respect.
    const beforeBackendRead = lane.slice(0, lane.indexOf('.from("clone_backends")'));
    expect(beforeBackendRead).toContain("Date.now() + EDGE_DEPLOY_BUDGET_MS");
  });

  it("the budget leaves the invocation room to finish its sweep", () => {
    // pg_net stops waiting at 60s, and five more sweep steps follow this lane.
    const declared = healing.match(/EDGE_DEPLOY_BUDGET_MS = ([\d_]+);/);
    expect(declared).not.toBeNull();
    const ms = Number((declared as RegExpMatchArray)[1].replace(/_/g, ""));
    expect(ms).toBeGreaterThan(10_000);
    expect(ms).toBeLessThan(60_000);
  });

  it("keeps the results of a pass it cut short", () => {
    /*
      `deployEdgeFunctions` has its own `deadlineAt`, and it signals the budget
      by throwing `BudgetPause` and DISCARDING the pass's results — right for
      provisioning, which re-derives everything from the target, and wrong
      here: this lane has to know whether the pass it is about to requeue
      landed anything, because that is what decides whether the pass is
      charged an attempt.
    */
    expect(budgetedLoop).toContain("runWithinBudget");
    expect(budgetedLoop).not.toContain("BudgetPause");
    expect(lane).toContain("const { results, stoppedEarly }");
  });

  it("the stopping rule lives where a test can hold it to its properties", () => {
    /*
      What the loop must do — always attempt the first item, keep the results
      of the items it reached — cannot be asserted by reading the source, and
      both failures are silent: a pass that deploys nothing every time, and a
      pass that lands bundles while reporting none. `runWithinBudget` takes
      the deploy and the clock as arguments so those are ordinary assertions,
      and this file only checks the lane still goes through it.
    */
    expect(budgetedLoop).toMatch(/runWithinBudget[\s\S]{0,200}isPastDeadline/);
    // The reserve is the loop's own measurement of its slowest item, so a
    // deploy is not STARTED with less time left than the last one took.
    expect(budgetedLoop).toMatch(/Date\.now\(\) \+ reserveMs >= deadlineAt/);
    // The loop itself, not a second copy of it living in the lane.
    expect(budgetedLoop).not.toMatch(/for \(let i = 0/);
  });

  it("a budget stop requeues like any other unfinished batch", () => {
    /*
      The bundles the pass did not reach were never deployed and never became
      `refreshed`, so a run that called itself complete would lose them
      silently — the class this whole file exists for. It is the LOOP's answer
      that has to reach the decision: passing a literal here, or the wrong
      variable, resolves every budget stop to "complete".
    */
    expect(resumeBlock).toMatch(/planEdgeDeployResume\(\{[\s\S]{0,240}\bstoppedEarly,/);
    expect(resumeBlock).not.toMatch(/stoppedEarly: (?:true|false)/);
    expect(resumeBlock).toContain('status: "planned"');
  });
});

describe("forward progress does not spend an attempt", () => {
  it("the decision is the pure module's, not three lines in the lane", () => {
    /*
      It fails in BOTH directions. Charge every requeue and a lane pausing
      every 45 seconds onto a two-minute tick burns all thirty attempts in an
      hour, on a run that is working. Charge none and a batch whose every
      deploy fails requeues for ever.
    */
    expect(lane).toContain("planEdgeDeployResume({");
    expect(resumeBlock).toContain("resume.attemptNeutral");
  });

  it("undoes this pass's increment rather than resetting the counter", () => {
    /*
      `executeRemediationRun` increments before dispatch, so the lane's `run`
      holds the count from BEFORE this pass. Writing it back undoes exactly
      one attempt; resetting to zero would forgive a genuine earlier failure.
    */
    expect(resumeBlock).toMatch(/attempts: run\.attempts \?\? 0/);
    expect(resumeBlock).not.toMatch(/attempts: 0/);
  });

  it("parks only on the pure module's say-so", () => {
    // The bound still exists; it is now asked about a run that has stopped
    // getting anywhere rather than about one that has taken many passes.
    expect(resumeBlock).toContain('resume.kind === "park"');
    expect(resumeBlock).toContain("parkRun(");
  });

  it("counts what landed from the results, never from the batch it sent", () => {
    /*
      Two different numbers, and the gap between them is the 413 that started
      all of this: a bundle can be refused while the fifty beside it land.
      Counting the batch would credit the clone with functions it rejected AND
      make a pass that failed at every one of them look like forward progress
      — which is the one thing that must spend an attempt, because it is the
      only route this lane has to a person.
    */
    expect(lane).toContain("countLanded(results");
    expect(lane).not.toMatch(/landed = batch/);
  });

  it("records that the budget was what stopped it", () => {
    // A run resuming for an hour looks identical to a wedged one unless the
    // reason is on the row.
    expect(resumeBlock).toContain("paused_at_budget: stoppedEarly");
  });
});

describe("a dead invocation does not strand its row", () => {
  it("the sweep reclaims stalled runs before it selects work", () => {
    /*
      `executeRemediationRun` accepts only `planned` and `approved`, so a row
      left in `executing` is on no work list and read by no lane. Reclaiming
      after the selection would cost a whole pass every time.
    */
    const sweep = healing.slice(healing.indexOf("export async function sweepSupportRemediations"));
    const reclaimAt = sweep.indexOf("reclaimStalledRuns()");
    const selectAt = sweep.indexOf('.in("status", ["planned", "approved"])');
    expect(reclaimAt).toBeGreaterThan(-1);
    expect(selectAt).toBeGreaterThan(-1);
    expect(reclaimAt).toBeLessThan(selectAt);
  });

  it("reclaims only runs that are actually stuck", () => {
    const reaper = healing.slice(
      healing.indexOf("async function reclaimStalledRuns"),
      healing.indexOf("export type SweepResult") >
        healing.indexOf("async function reclaimStalledRuns")
        ? healing.indexOf("export type SweepResult")
        : healing.length,
    );
    expect(reaper).toContain('.eq("status", "executing")');
    expect(reaper).toContain("RUN_STALL_MINUTES");
  });

  it("measures the stall on THIS pass, never on the run's lifetime", () => {
    /*
      `started_at` is the moment the run FIRST executed and is kept across
      passes on purpose — the deploy lane measures "what have I already put on
      the clone" from it. A run resuming through eight passes therefore carries
      a `started_at` older than the threshold long before anything is wrong, so
      reclaiming on it would seize a run mid-pass and set two passes executing
      the same row, racing each other through its attempt budget.

      `updated_at` is trigger-maintained (trg_remediation_runs_updated, BEFORE
      UPDATE) so it marks when this pass claimed the row.
    */
    const reaper = healing.slice(healing.indexOf("async function reclaimStalledRuns"));
    const query = reaper.slice(0, reaper.indexOf(".limit(DRAIN_BATCH)"));
    expect(query).toContain('.lt("updated_at", stalledBefore)');
    expect(query).not.toContain('.lt("started_at"');
  });

  it("the deploy lane keeps started_at across a resume, which is why", () => {
    // If a resume reset `started_at`, `refreshedSince` would forget every
    // bundle already deployed and the run would restart from nothing.
    expect(resumeBlock).not.toContain("started_at");
  });

  it("sends a run past its budget to a human rather than round again", () => {
    const reaper = healing.slice(healing.indexOf("async function reclaimStalledRuns"));
    const block = reaper.slice(0, reaper.indexOf("\n  return reclaimed;"));
    expect(block).toContain("max_attempts");
    expect(block).toContain('status: "awaiting_validation"');
    expect(block).toContain("requires_human: true");
  });

  it("reports what it reclaimed rather than doing it silently", () => {
    expect(healing).toContain("runsReclaimed");
    expect(drainHook).toContain("runsReclaimed: result.runsReclaimed");
  });
});

describe("what this change must not have disturbed", () => {
  it("the lane still refuses a run with no clone and skips one with no backend", () => {
    expect(lane).toContain("no clone scope — prime functions are not self-deployed");
    expect(lane).toContain("clone has no provisioned backend");
  });

  it("the lane still fails loudly when every deploy in a batch fails", () => {
    // Not a partial-success path: a batch in which nothing landed is an
    // error, and the run retries rather than recording progress it made none of.
    expect(lane).toMatch(/all \$\{failures\.length\} function deploys failed/);
  });

  it("provisioning's deploy loop keeps its own budget pause", () => {
    /*
      This lane stopped using `deployEdgeFunctions`' `deadlineAt`, which is not
      a reason to remove it: provisioning depends on that pause to survive its
      own invocation ceiling, and it re-derives its progress from the target
      rather than from returned results, so discarding them is correct there.
    */
    const fn = provisioning.slice(
      provisioning.indexOf("export async function deployEdgeFunctions"),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("pastDeadline(deadlineAt)");
    expect(body).toContain("throw new BudgetPause(");
  });

  it("provisioning's own slug reader is untouched", () => {
    /*
      Two questions, two readers. Provisioning asks "which does the target
      have" on every pass; widening that return type would edit the one path
      already known to work, for the benefit of a different caller.
    */
    expect(provisioning).toContain("export async function listProjectEdgeFunctionSlugs");
    const slugFn = provisioning.slice(
      provisioning.indexOf("export async function listProjectEdgeFunctionSlugs"),
    );
    expect(slugFn.slice(0, slugFn.indexOf("\n}\n"))).toContain("Promise<string[]>");
  });

  it("the other four lanes still dispatch", () => {
    for (const lane of [
      "pr_merge",
      "sql_migration",
      "edge_function_deploy",
      "monitor_recovery",
      "rescan",
    ]) {
      expect(healing).toContain(`case "${lane}":`);
    }
  });
});
