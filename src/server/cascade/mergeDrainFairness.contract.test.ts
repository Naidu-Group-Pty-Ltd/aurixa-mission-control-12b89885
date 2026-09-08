/**
 * The merge drain fits an invocation, and serves the fleet in turn.
 *
 * Structural — a budget, an ordering, a stamp and a concurrency bound — so
 * asserted against the source. Exercising it for real needs a token that can
 * push to production repositories, which is exactly what a test must not hold.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const drain = read("src/server/cascadeMergeDrain.server.ts");
const hook = read("src/routes/hooks.cascade-merge-drain.tsx");

describe("a run fits inside the invocation it is given", () => {
  it("carries a wall-clock budget under the pg_net ceiling", () => {
    /*
      pg_net cuts an invocation off at 60,000 ms by killing the request, so a
      run that overruns leaves its work unrecorded and the operator with no
      report at all. `executeSqlMigration` and the edge deploy lane both carry
      a budget for exactly this; this one did not, and grep for `Date.now`,
      `deadline` or `budget` in it returned nothing at all.
    */
    const budget = Number(
      /const MERGE_DRAIN_BUDGET_MS = ([\d_]+);/.exec(drain)?.[1]?.replace(/_/g, ""),
    );
    expect(budget).toBeGreaterThan(0);
    // Under the ceiling, with room for the derived passes that must always run.
    expect(budget).toBeLessThan(60_000);
    expect(budget).toBeLessThanOrEqual(50_000);
  });

  it("asks the deadline before each clone AND before each pull request", () => {
    // One clone holding 25 proposals could otherwise spend the whole run on
    // its own — the same starvation the rotation ends, one level down.
    expect(drain).toMatch(/const isPastDeadline = \(\) => Date\.now\(\) >= deadlineAt;/);
    expect(drain).toMatch(/if \(isPastDeadline\(\)\) break;/);
    expect(drain).toMatch(/mapWithConcurrencyUntil\([\s\S]{0,200}isPastDeadline,?\s*\)/);
  });

  it("runs the derived passes after the pool, so a truncated run still records what it did", () => {
    // `recountEvent`, `advanceClone` and `tidyLandedSummaries` are the
    // "everything this pass did is complete and recorded" half of the
    // contract. Putting them inside the budgeted region would make a
    // truncated run leave the ledger disagreeing with GitHub.
    const poolAt = drain.indexOf("const pass = await mapWithConcurrencyUntil(");
    expect(poolAt).toBeGreaterThan(-1);
    expect(drain.indexOf("if (await recountEvent(supabase, eventId))")).toBeGreaterThan(poolAt);
    expect(drain.indexOf("if (await advanceClone(supabase, cloneId))")).toBeGreaterThan(poolAt);
    expect(drain.indexOf("report.tidied = await tidyLandedSummaries(supabase)")).toBeGreaterThan(
      poolAt,
    );
  });
});

describe("the fleet is served in turn", () => {
  it("orders clones by when they were last visited, nulls first", () => {
    // Unordered plus unbudgeted is what starved the tail: a run cut off by the
    // ceiling served whatever prefix the planner returned, and the next run
    // started from the same prefix.
    expect(drain).toMatch(/\.order\("merge_drain_at", \{ ascending: true, nullsFirst: true \}\)/);
  });

  it("stamps the visit unconditionally — a clone that merged nothing still had its turn", () => {
    /*
      If the stamp depended on a merge, a clone that never merges would sort
      first for ever and starve everything behind it. The stamp is a VISIT.
    */
    const worker = drain.slice(drain.indexOf("const perClone ="), drain.indexOf("const pass ="));
    expect(worker).toMatch(/merge_drain_at: new Date\(\)\.toISOString\(\)/);
    // Not inside a merged/held/failed branch: it is the last thing the worker
    // does, after the pull-request loop closes.
    const stampAt = worker.indexOf("merge_drain_at:");
    const loopEndAt = worker.lastIndexOf("report.detail.push({ clone: label, pr: number");
    expect(stampAt).toBeGreaterThan(loopEndAt);
  });

  it("a stamp that could not be written never fails the run", () => {
    // A rotation cursor is a fairness problem next tick, not a reason to
    // discard work already done.
    const worker = drain.slice(drain.indexOf("const perClone ="), drain.indexOf("const pass ="));
    const after = worker.slice(worker.indexOf("merge_drain_at:"));
    expect(after).toMatch(/console\.error/);
    expect(after).not.toMatch(/throw new Error/);
  });
});

describe("concurrency is across clones, never within one", () => {
  it("bounds the pool and keeps the pull-request loop serial", () => {
    const limit = Number(/const MERGE_DRAIN_CLONE_CONCURRENCY = (\d+);/.exec(drain)?.[1]);
    expect(limit).toBeGreaterThan(1);
    // Well inside GitHub's secondary-rate-limit guidance.
    expect(limit).toBeLessThanOrEqual(12);

    /*
      The pull requests of ONE clone carry overlapping trees and must land
      oldest first, and GitHub asks for no more than one mutating request per
      second against a single repository. So the inner loop stays a plain
      `for … of` with an `await` in it — never a `Promise.all` or a second
      pool.
    */
    const worker = drain.slice(drain.indexOf("const perClone ="), drain.indexOf("const pass ="));
    expect(worker).toMatch(/for \(const number of numbers\) \{/);
    expect(worker).not.toMatch(/mapWithConcurrency/);
    expect(worker).not.toMatch(/Promise\.all\(\s*numbers/);
  });

  it("still merges oldest-first within a clone", () => {
    // The cap is applied to the NEWEST and the survivors sorted back into
    // merge order. Concurrency must not have quietly reordered that.
    expect(drain).toMatch(
      /\.sort\(\(a, b\) => b - a\)\s*\.slice\(0, MAX_PRS_PER_RUN\)\s*\.sort\(\(a, b\) => a - b\)/,
    );
  });
});

describe("a truncated run says so", () => {
  it("reports what it did not reach", () => {
    expect(drain).toMatch(/report\.truncated = pass\.stopped;/);
    expect(drain).toMatch(/report\.clonesRemaining = eligible\.length - pass\.processed;/);
  });

  it("files an audit row on truncation even when nothing else changed", () => {
    /*
      THE RULE THAT MAKES THE REST VISIBLE.

      The route writes a breadcrumb only when something CHANGED — correct, and
      the reason a starved tail went unnoticed: it produces exactly the same
      silence as a quiet fleet. Running out of budget IS something that
      happened, and unlike `foreignRepo` it is bounded — it appears only while
      there is more work than a run can hold.
    */
    const guard = hook.slice(hook.indexOf("if ("), hook.indexOf('action: "cascade_merge_drain"'));
    expect(guard).toMatch(/report\.truncated/);
  });
});
