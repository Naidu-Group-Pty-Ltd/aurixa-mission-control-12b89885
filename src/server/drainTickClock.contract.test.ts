/**
 * One drain tick, one clock.
 *
 * ## What this is here to make impossible
 *
 * The remediation drain runs its due runs one after another inside ONE pg_net
 * request that stops being waited on at sixty seconds. Each lane took a
 * budget of its own — forty-five seconds, measured from its own entry — so a
 * tick with two long runs due gave the first its forty-five seconds and then
 * started the second at ~46 s with a fresh forty-five: work the invocation
 * could not live to finish. That pass was killed mid-batch, sat in
 * `executing` until the stall reclaim twenty minutes later, and was charged an
 * attempt for it. Measured 26 Sep 2026: the fleet's routine full redeploys ran
 * 11–14 attempts and five to seven hours for ~414 bundles, and on 19 Sep two
 * of them ran out of attempts and parked with no bundle ever having failed.
 *
 * So the tick has one deadline, every lane runs to the SOONER of its own
 * budget and the tick's, and a run the tick has no room left for is not
 * started at all.
 *
 * Structural — where the clock is taken, what is handed down, and what a
 * deferred run is spared — so it is asserted against the source, in the
 * pattern of `sqlMigrationLane.contract.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
/** Source with comments removed — a comment quoting code is not code. */
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const healing = stripComments(read("src/server/self-healing.server.ts"));
const schedule = read("supabase/migrations/20260826000000_schedule_the_engine.sql");
const approve = stripComments(read("src/lib/support-tickets.functions.ts"));

const constant = (name: string): number => {
  const m = new RegExp(`const ${name} = ([\\d_]+);`).exec(healing);
  expect(m, `${name} is declared as a literal`).not.toBeNull();
  return Number((m as RegExpExecArray)[1].replace(/_/g, ""));
};

const sweepStart = healing.indexOf("export async function sweepSupportRemediations");
const sweepEnd = healing.indexOf("async function planScanAutoMerges");
const sweep = healing.slice(sweepStart, sweepEnd);

const dispatchStart = healing.indexOf("export async function executeRemediationRun");
const dispatch = healing.slice(
  dispatchStart,
  healing.indexOf("switch (run.action_type)", dispatchStart) + 900,
);

const sqlLane = healing.slice(
  healing.indexOf("async function executeSqlMigration"),
  healing.indexOf("async function deployWithinBudget"),
);
const deployLane = healing.slice(
  healing.indexOf("async function executeEdgeFunctionDeploy"),
  healing.indexOf("async function executeMonitorRecovery"),
);

/** The drain's cron job, from its schedule call to the end of its command. */
const drainJob = (() => {
  const at = schedule.indexOf("'support-remediation-drain',\n      '*/2 * * * *'");
  return schedule.slice(at, schedule.indexOf("/hooks/support-remediation-drain'", at));
})();

describe("the slices this file reads exist", () => {
  it("finds the sweep, the dispatcher, both lanes and the drain's schedule", () => {
    expect(sweepStart).toBeGreaterThan(-1);
    expect(sweepEnd).toBeGreaterThan(sweepStart);
    expect(dispatchStart).toBeGreaterThan(-1);
    expect(sqlLane.length).toBeGreaterThan(1000);
    expect(deployLane.length).toBeGreaterThan(1000);
    expect(drainJob.length).toBeGreaterThan(100);
  });
});

describe("the tick's budget fits the request that carries it", () => {
  it("stays inside the patience pg_net gives the drain, with room for the steps after the loop", () => {
    const patience = /timeout_milliseconds := (\d+)/.exec(drainJob);
    expect(patience).not.toBeNull();
    const patienceMs = Number((patience as RegExpExecArray)[1]);
    const tick = constant("DRAIN_TICK_BUDGET_MS");
    // Four more sweep steps follow the run loop inside the same request.
    expect(tick).toBeLessThanOrEqual(patienceMs - 10_000);
  });

  it("still gives the first run the whole budget it always had", () => {
    // The reclaim and the due-run read before the loop take about a second;
    // the first run must not be squeezed by the tick that exists to protect
    // the second.
    const tick = constant("DRAIN_TICK_BUDGET_MS");
    expect(constant("SQL_MIGRATION_BUDGET_MS")).toBeLessThan(tick);
    expect(constant("EDGE_DEPLOY_BUDGET_MS")).toBeLessThan(tick);
  });

  it("will not start a run with less than a working pass left", () => {
    const floor = constant("MIN_RUN_WINDOW_MS");
    expect(floor).toBeGreaterThanOrEqual(10_000);
    expect(floor).toBeLessThan(constant("DRAIN_TICK_BUDGET_MS"));
  });
});

describe("the sweep keeps one clock for the whole tick", () => {
  it("takes it before anything else the tick does", () => {
    const clock = sweep.indexOf("const tickDeadlineAt = Date.now() + DRAIN_TICK_BUDGET_MS;");
    expect(clock).toBeGreaterThan(-1);
    // Before the reclaim and before the due-run read: both spend the tick.
    expect(clock).toBeLessThan(sweep.indexOf("reclaimStalledRuns()"));
    expect(clock).toBeLessThan(sweep.indexOf('.from("remediation_runs")'));
  });

  it("defers a run it has no room for BEFORE starting it, and hands the clock to the rest", () => {
    const defer = sweep.indexOf("if (Date.now() + MIN_RUN_WINDOW_MS >= tickDeadlineAt)");
    const run = sweep.indexOf("executeRemediationRun(due.id, { tickDeadlineAt })");
    expect(defer).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(defer);
    // The loop's only call: a second, clockless call would be the old defect.
    expect(sweep.match(/executeRemediationRun\(/g) ?? []).toHaveLength(1);
  });

  it("a deferred run is left exactly as it was — not started, not charged", () => {
    /*
      Not started rather than started and killed. A deferral that marked the
      run `executing`, or charged it an attempt, would be the very thing it
      exists to prevent, one step earlier. Left `planned`, the
      least-recently-served order puts it first on the next tick.
    */
    const defer = sweep.indexOf("if (Date.now() + MIN_RUN_WINDOW_MS >= tickDeadlineAt)");
    const branch = sweep.slice(defer, sweep.indexOf("continue;", defer) + "continue;".length);
    expect(branch).toContain('status: "deferred_to_next_tick"');
    expect(branch).not.toMatch(/markRun\(|\.update\(|executeRemediationRun\(/);
  });

  it("serves the least recently served run first, so a deferred run leads next time", () => {
    const read = sweep.slice(sweep.indexOf('.from("remediation_runs")'));
    expect(read.indexOf('.order("updated_at", { ascending: true })')).toBeGreaterThan(-1);
    expect(read.indexOf('.order("updated_at", { ascending: true })')).toBeLessThan(
      read.indexOf('.order("created_at", { ascending: true })'),
    );
  });
});

describe("every long lane answers to the sooner of its own budget and the tick's", () => {
  it("the dispatcher hands the tick's deadline to both long lanes", () => {
    expect(dispatch).toContain("tickDeadlineAt?: number;");
    expect(dispatch).toContain("executeSqlMigration(run, approvedByHuman, opts?.tickDeadlineAt)");
    expect(dispatch).toContain("executeEdgeFunctionDeploy(run, opts?.tickDeadlineAt)");
  });

  it("each lane clamps its own budget to the tick, before its first read", () => {
    for (const [lane, budget] of [
      [sqlLane, "SQL_MIGRATION_BUDGET_MS"],
      [deployLane, "EDGE_DEPLOY_BUDGET_MS"],
    ] as const) {
      const at = lane.indexOf("const deadlineAt = Math.min(");
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(lane.indexOf("await admin"));
      const taken = lane.slice(at, lane.indexOf(");", at));
      expect(taken).toContain(`Date.now() + ${budget}`);
      // A person's approval passes no tick: the lane keeps its own budget.
      expect(taken).toContain("tickDeadlineAt ?? Number.POSITIVE_INFINITY");
    }
  });

  it("a person's approval is not bound by a drain tick it is not part of", () => {
    // The approve button runs one run in its own request; clamping it to a
    // tick that does not exist would only shorten a pass for nothing.
    expect(approve).toMatch(/executeRemediationRun\(run\.id\)/);
  });
});
