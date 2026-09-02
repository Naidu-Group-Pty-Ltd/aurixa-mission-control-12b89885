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
    const resumeBlock = lane.slice(lane.indexOf("if (pass.moreRemain)"));
    expect(resumeBlock).toContain("max_attempts");
    expect(resumeBlock).toContain("parkRun(");
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
    const resumeBlock = lane.slice(
      lane.indexOf("if (pass.moreRemain)"),
      lane.lastIndexOf("return succeedRun(run, {"),
    );
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
