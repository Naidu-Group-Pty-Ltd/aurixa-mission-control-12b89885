/**
 * The backend provisioning drain's budget is derived from the patience its cron
 * job actually has, and a live pass can never be judged dead.
 *
 * Structural, reading the source and the migration, in the pattern of
 * `fleetPassIsBudgeted.contract.test.ts`: what is asserted is the relation
 * between three numbers written in three files, and a double would agree with
 * any of them.
 *
 * ## What was measured
 *
 * The job waited 60 s and the drain worked for 50 s from after its reclaim,
 * checking the budget only between units. A unit that crossed the sixty-second
 * line was killed rather than paused: on `tutorial-demo-orrimere-c158c7`, 30 Oct
 * 2026, two passes in a row died re-pointing the clone's repository, each
 * death a stall of minutes, and the job finished only after a hand re-queue.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./sourceComments.pure";
import { DEAD_PASS_MAX_MINUTES, DEAD_PASS_SILENT_MINUTES } from "./provisioningStall.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** SQL with its comment lines removed — a header quoting the statement is not the statement. */
const sqlCode = (src: string): string => src.replace(/^[ \t]*--.*$/gm, "");

const drain = stripComments(read("src/routes/hooks.backend-provisioning-drain.tsx"));

const constant = (name: string): number => {
  const m = new RegExp(`const ${name} = ([\\d_]+);`).exec(drain);
  expect(m, `could not read ${name} from the drain`).not.toBeNull();
  return Number(m![1].replace(/_/g, ""));
};

const PATIENCE_MS = constant("BACKEND_DRAIN_PATIENCE_MS");
const HEADROOM_MS = constant("BACKEND_DRAIN_HEADROOM_MS");
const BUDGET_MS = PATIENCE_MS - HEADROOM_MS;

/**
 * The patience the job is given, read from the NEWEST migration that names the
 * job — the one whose rewrite is the stored command today.
 */
const SCHEDULED_PATIENCE_MS = (() => {
  const dir = "supabase/migrations";
  const naming = readdirSync(join(process.cwd(), dir))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => sqlCode(read(join(dir, f))).includes("backend-provisioning-drain-1min"));
  expect(naming.length, "no migration names backend-provisioning-drain-1min").toBeGreaterThan(0);
  const newest = sqlCode(read(join(dir, naming[naming.length - 1])));
  const m = /'timeout_milliseconds := 60000',\s*'timeout_milliseconds := (\d+)'/.exec(newest);
  expect(m, "the newest migration naming the job does not rewrite its timeout").not.toBeNull();
  return Number(m![1]);
})();

describe("the backend drain is budgeted against the patience its job has", () => {
  it("the patience is the one the newest migration schedules", () => {
    expect(PATIENCE_MS).toBe(SCHEDULED_PATIENCE_MS);
  });

  it("the budget is derived from the patience, never written beside it", () => {
    expect(drain).toMatch(
      /const INVOCATION_BUDGET_MS = BACKEND_DRAIN_PATIENCE_MS - BACKEND_DRAIN_HEADROOM_MS;/,
    );
    // One deadline for the invocation, taken from that budget.
    expect(drain).toMatch(/const deadlineAt = Date\.now\(\) \+ INVOCATION_BUDGET_MS;/);
  });

  it("leaves room for the unit a pass is inside when the budget runs out", () => {
    // A run of repository commits or a function-source snapshot takes tens of
    // seconds; the old ten seconds of headroom is what killed passes.
    expect(HEADROOM_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("works a little longer than it did, and not long enough to hold every other hook", () => {
    // pg_net starts its next batch only when every request in this one has
    // answered, so a long pass every minute would delay every one-minute hook.
    expect(BUDGET_MS).toBeGreaterThanOrEqual(50_000);
    expect(BUDGET_MS).toBeLessThanOrEqual(75_000);
  });

  it("a pass that is still running can never be judged dead", () => {
    // A pass cannot outlive its request, so the silence rule must be longer
    // than the patience, and the backstop longer still.
    expect(DEAD_PASS_SILENT_MINUTES * 60_000).toBeGreaterThan(PATIENCE_MS);
    expect(DEAD_PASS_MAX_MINUTES * 60_000).toBeGreaterThan(PATIENCE_MS);
  });
});
