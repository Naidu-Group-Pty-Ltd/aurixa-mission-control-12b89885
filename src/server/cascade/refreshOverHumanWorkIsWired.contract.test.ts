/**
 * A refresh over somebody's commits reads what both sides changed a path TO,
 * and the engine acts on that reading before it writes anything.
 *
 * ## Why this is a SOURCE contract
 *
 * `refreshOverHumanWork.test.ts` proves the judgement. What no behavioural
 * test can see is whether the engine ASKS it: a three-way merge the planner
 * requests and the engine never performs would leave every candidate unsettled,
 * and `completeRefreshPlan` would defer the refresh exactly as the old rule
 * did — the deadlock on npc-client-dashboard #379 (19 Oct 2026) back, with
 * every test green. So the assertions below are pinned on the data flow and
 * on position.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "../sourceComments.pure";

const ENGINE = "src/server/cascade-engine.server.ts";
const code = stripComments(readFileSync(ENGINE, "utf8"));

const at = (needle: string | RegExp): number => {
  const i = typeof needle === "string" ? code.indexOf(needle) : code.search(needle);
  expect(i).toBeGreaterThan(-1);
  return i;
};

describe("the engine settles the merges the planner asks for", () => {
  it("reads all three texts from the clone and merges them with the planner's own rule", () => {
    expect(code).toMatch(/readMergedVariant\(octokit, cloneRef, candidate\.base\)/);
    expect(code).toMatch(/readMergedVariant\(octokit, cloneRef, candidate\.ours\)/);
    expect(code).toMatch(/readMergedVariant\(octokit, cloneRef, candidate\.theirs\)/);
    expect(code).toMatch(/decideRefreshTextMerge\(candidate, \{ base, ours, theirs \}\)/);
  });

  it("stores a merge before it is overlaid, and completes the plan from what was stored", () => {
    expect(code).toMatch(/storeMergedVariant\(octokit, cloneRef, verdict\.text\)/);
    expect(code).toMatch(/plan = completeRefreshPlan\(plan, settled\)/);
  });

  it("does all of it before the plan is acted on", () => {
    const planned = at("let plan = planRefreshOverHumanWork(");
    const completed = at("plan = completeRefreshPlan(plan, settled)");
    const deferred = at('if (plan.kind === "defer") return deferred(plan.why)');
    const preservingMerge = at("`${PRESERVING_MERGE_PREFIX} (");
    expect(planned).toBeLessThan(completed);
    expect(completed).toBeLessThan(deferred);
    expect(deferred).toBeLessThan(preservingMerge);
  });

  it("uses the new statement's own tree when nothing needs overlaying", () => {
    expect(code).toMatch(/plan\.overlay\.length === 0\s*\?\s*newTree\.sha/);
  });
});
