/**
 * The sql_migration lane: scoped like the fleet sync, bounded like the deploy
 * lane.
 *
 * Structural — which function the lane asks, what it hands the replay, and
 * what it writes back — so these read the source, in the pattern of
 * `edgeDeployResume.contract.test.ts`. A Supabase double would agree with
 * wrong code here; the order of calls in the file cannot.
 *
 * Found 2 Sep 2026 on `npc-client-dashboard`: the lane took the raw repository
 * listing and called 341 files "pending" on a clone the fleet sync reported
 * level — fifty-eight of them destructive — and every pass died fetching
 * bodies for the gate. Eleven passes over three and a half hours, and not one
 * migration landed.
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

const gateStart = healing.indexOf("async function assessPendingMigrations");
const laneStart = healing.indexOf("async function executeSqlMigration");
const laneEnd = healing.indexOf("async function deployWithinBudget");
const lane = healing.slice(laneStart, laneEnd);
const gate = healing.slice(gateStart, laneStart);

const replayStart = provisioning.indexOf("export async function applyPrimeMigrations");
const replayEnd = provisioning.indexOf("const MODULE_TRACKING_TABLE_SQL");
const replay = provisioning.slice(replayStart, replayEnd);

describe("the slices this file reads exist", () => {
  it("finds the gate, the lane and the replay", () => {
    // A slice from -1 is the whole file, and every assertion below would pass
    // over it — the trap this suite's siblings have been caught by.
    expect(gateStart).toBeGreaterThan(-1);
    expect(laneStart).toBeGreaterThan(gateStart);
    expect(laneEnd).toBeGreaterThan(laneStart);
    expect(replayStart).toBeGreaterThan(-1);
    expect(replayEnd).toBeGreaterThan(replayStart);
  });
});

describe("pending is what the fleet sync would send, never the raw corpus", () => {
  it("scopes through the one implementation the fleet sync and the button use", () => {
    expect(lane).toContain("openScopedPrimeCorpus(admin, source)");
    expect(lane).not.toContain("openPrimeMigrationCorpus(");
    // The old lane's definition of pending.
    expect(lane).not.toMatch(/migrations\.filter\(\s*\(m\)\s*=>\s*!applied\.has/);
  });

  it("sends only what is not behind a hole, and judges exactly that set", () => {
    const partition = lane.indexOf("partitionByDependency(");
    const judged = lane.indexOf("assessPendingMigrations(pending");
    expect(partition).toBeGreaterThan(-1);
    expect(judged).toBeGreaterThan(partition);
    expect(lane).toMatch(/const \{ send: pending, orphaned \} = partitionByDependency\(/);
  });

  it("hands the replay the runnable set and the scope, so it can refuse a hole", () => {
    expect(lane).toMatch(/applyPrimeMigrations\(\s*backend\.supabase_project_ref,\s*runnable,/);
    expect(lane).toContain("{ corpus: corpus.metas, runnableIds }");
  });

  it("a scope that could not be built is retried, not handed to a person", () => {
    const check = lane.indexOf("if (!scoped.ok)");
    expect(check).toBeGreaterThan(-1);
    const line = lane.slice(check, lane.indexOf("\n", check));
    expect(line).toContain("throw new Error(scoped.error)");
    expect(line).not.toContain("parkRun");
  });

  it("a level clone succeeds before any body is fetched", () => {
    const level = lane.indexOf("if (pending.length === 0)");
    const judged = lane.indexOf("assessPendingMigrations(pending");
    expect(level).toBeGreaterThan(-1);
    expect(level).toBeLessThan(judged);
  });
});

describe("a pass is bounded", () => {
  it("the deadline is taken at lane entry, before any read", () => {
    const deadline = lane.indexOf("const deadlineAt = Date.now() + SQL_MIGRATION_BUDGET_MS");
    const firstRead = lane.indexOf("await admin");
    expect(deadline).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(-1);
    expect(deadline).toBeLessThan(firstRead);
  });

  it("and is handed to the replay", () => {
    expect(lane).toContain("{ isPastDeadline: () => Date.now() >= deadlineAt }");
  });

  it("the replay asks between migrations, never before the first, and only before a send", () => {
    const skip = replay.indexOf("skipped: true });");
    const check = replay.indexOf("if (attempted > 0 && budget?.isPastDeadline())");
    const send = replay.indexOf("await runSqlOnProject(projectRef, sql);");
    expect(skip).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(skip);
    expect(send).toBeGreaterThan(check);
    expect(replay).toContain("attempted += 1;");
    expect(replay).toContain("return { results, latestApplied, stoppedEarly };");
  });

  it("the budget is the deploy lane's, for the deploy lane's reason", () => {
    expect(healing).toMatch(/const SQL_MIGRATION_BUDGET_MS = 45_000;/);
  });
});

describe("a pass that stopped at the budget hands the run back", () => {
  const decision = lane.indexOf("planEdgeDeployResume({");
  const resumeBlock = lane.slice(decision, lane.lastIndexOf("return succeedRun(run, {"));

  it("decides through the same module as the deploy lane", () => {
    expect(decision).toBeGreaterThan(-1);
    expect(resumeBlock.length).toBeGreaterThan(200);
    expect(resumeBlock).toContain("moreRemain: stoppedEarly");
    expect(resumeBlock).toMatch(/\blanded,/);
  });

  it("a requeue is attempt-neutral exactly when something landed", () => {
    expect(resumeBlock).toContain('status: "planned"');
    expect(resumeBlock).toMatch(
      /\.\.\.\(resume\.attemptNeutral \? \{ attempts: run\.attempts \?\? 0 \} : \{\}\)/,
    );
    expect(resumeBlock).toContain("next_attempt_at: new Date().toISOString()");
    expect(resumeBlock).toContain("paused_at_budget: stoppedEarly");
  });

  it("landed counts sent migrations only — not ones skipped as applied or held back", () => {
    expect(lane).toMatch(/const landed = .*filter\(\(r\) => r\.success && !r\.skipped\)\.length/);
  });

  it("a failed migration still fails the pass loudly", () => {
    expect(lane).toMatch(/if \(failed\.length > 0\) \{\s*throw new Error\(/);
  });
});

describe("the gate", () => {
  it("fetches bodies a few at a time", () => {
    expect(gate).toContain("SQL_GATE_FETCH_CONCURRENCY");
    expect(gate).toContain("Promise.all(");
  });

  it("an unreadable body offends rather than passing unexamined", () => {
    expect(gate).toMatch(/catch \(e\) \{\s*return \{\s*migration: m\.name/);
  });

  it("still parks the whole batch on the first destructive statement", () => {
    expect(lane).toMatch(/if \(offending\.length > 0\) \{\s*return parkRun\(/);
  });

  it("is skipped only for a run a person approved", () => {
    expect(lane).toMatch(/if \(!approvedByHuman\) \{\s*const offending = await assessPendingMigrations/);
  });
});
