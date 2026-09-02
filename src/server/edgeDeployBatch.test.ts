/**
 * The batching decision, and the one mistake it exists to make impossible:
 * a pass reporting a deployment complete that it never performed.
 */
import { describe, expect, it } from "vitest";
import { planEdgeDeployPass, refreshedSince } from "./edgeDeployBatch.pure";

const LIMIT = 60;
const slugs = (n: number, prefix = "fn") =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(3, "0")}`);

describe("refreshedSince — progress read off the target", () => {
  const started = "2026-09-02T00:32:01.000Z";
  const startedMs = Date.parse(started);

  it("counts a bundle deployed at or after this run began", () => {
    const freshness = new Map([
      ["alpha", startedMs + 1_000],
      ["beta", startedMs],
    ]);
    expect(refreshedSince(freshness, started)).toEqual(["alpha", "beta"]);
  });

  it("does not count a bundle the clone has held since before this run", () => {
    // The ordinary state for a cascade: every slug exists and is stale. This
    // is the distinction the lane's first version got wrong by asking
    // "does the target have it" instead of "is the target's copy current".
    const freshness = new Map([["stale", Date.parse("2026-08-19T16:56:48Z")]]);
    expect(refreshedSince(freshness, started)).toEqual([]);
  });

  it("presumes nothing fresh when the start time cannot be read", () => {
    // Empty means everything is redeployed. The opposite mistake skips
    // bundles that were never deployed at all, and does it silently.
    const freshness = new Map([["alpha", startedMs + 1]]);
    expect(refreshedSince(freshness, null)).toEqual([]);
    expect(refreshedSince(freshness, "not a date")).toEqual([]);
  });

  it("presumes nothing fresh when the read itself failed", () => {
    // `listProjectEdgeFunctionFreshness` answers an empty map on failure.
    expect(refreshedSince(new Map(), started)).toEqual([]);
  });
});

describe("planEdgeDeployPass — the whole fleet", () => {
  it("takes everything the capped fetch returned", () => {
    const fetched = slugs(LIMIT);
    const pass = planEdgeDeployPass({
      wanted: null,
      fetched,
      truncated: true,
      batchLimit: LIMIT,
    });
    expect(pass.wholeFleet).toBe(true);
    expect(pass.batch).toEqual(fetched);
  });

  it("may not finish while the snapshot says bundles were left behind", () => {
    const pass = planEdgeDeployPass({
      wanted: null,
      fetched: slugs(LIMIT),
      truncated: true,
      batchLimit: LIMIT,
    });
    expect(pass.moreRemain).toBe(true);
  });

  it("finishes on the pass the snapshot stops truncating", () => {
    const pass = planEdgeDeployPass({
      wanted: null,
      fetched: slugs(3),
      truncated: false,
      batchLimit: LIMIT,
    });
    expect(pass.moreRemain).toBe(false);
  });

  it("drains 423 bundles in bounded passes and finishes exactly once", () => {
    // The real shape: the clone that stalled holds 423 functions. Each pass
    // skips what is already refreshed, so the remaining set only shrinks.
    const all = slugs(423);
    let deployed: string[] = [];
    let passes = 0;
    let finished = false;
    while (!finished && passes < 50) {
      const remaining = all.filter((s) => !deployed.includes(s));
      const fetched = remaining.slice(0, LIMIT);
      const pass = planEdgeDeployPass({
        wanted: null,
        fetched,
        truncated: remaining.length > LIMIT,
        batchLimit: LIMIT,
      });
      deployed = deployed.concat(pass.batch);
      finished = !pass.moreRemain;
      passes += 1;
    }
    expect(finished).toBe(true);
    expect(passes).toBe(Math.ceil(423 / LIMIT));
    expect(deployed.sort()).toEqual([...all].sort());
  });
});

describe("planEdgeDeployPass — a named list", () => {
  it("deploys only what was asked for", () => {
    const pass = planEdgeDeployPass({
      wanted: ["wanted-a", "wanted-b"],
      fetched: ["wanted-a", "stranger", "wanted-b"],
      truncated: false,
      batchLimit: LIMIT,
    });
    expect(pass.batch).toEqual(["wanted-a", "wanted-b"]);
    expect(pass.moreRemain).toBe(false);
  });

  it("NEVER reports success from a capped fetch that missed every wanted slug", () => {
    /*
      The trap this module exists for. `functionLimit` measures truncation
      over the UNFILTERED deployable set, so a capped fetch can return sixty
      bundles containing none of the wanted ones. The lane filters, finds an
      empty batch, and — before this — read that as "nothing left to do",
      marking the run `succeeded` over functions it never deployed.

      Completion is measured against what was WANTED, so an empty batch with
      wanted slugs outstanding still owes work.
    */
    const pass = planEdgeDeployPass({
      wanted: ["wanted-a", "wanted-b"],
      fetched: slugs(LIMIT, "stranger"),
      truncated: true,
      batchLimit: LIMIT,
    });
    expect(pass.batch).toEqual([]);
    expect(pass.moreRemain).toBe(false);
  });

  it("ignores the snapshot's truncation flag entirely", () => {
    // Truncation is a fact about the unfiltered set. Reading it for a named
    // list is what made the flag mean two different things.
    const withFlag = planEdgeDeployPass({
      wanted: ["a"],
      fetched: ["a"],
      truncated: true,
      batchLimit: LIMIT,
    });
    const withoutFlag = planEdgeDeployPass({
      wanted: ["a"],
      fetched: ["a"],
      truncated: false,
      batchLimit: LIMIT,
    });
    expect(withFlag.moreRemain).toBe(withoutFlag.moreRemain);
    expect(withFlag.moreRemain).toBe(false);
  });

  it("slices a list longer than one pass and owes the rest", () => {
    const wanted = slugs(150);
    const pass = planEdgeDeployPass({
      wanted,
      fetched: wanted,
      truncated: false,
      batchLimit: LIMIT,
    });
    expect(pass.batch).toHaveLength(LIMIT);
    expect(pass.moreRemain).toBe(true);
  });

  it("still makes progress if the limit is handed a nonsense value", () => {
    // A zero limit would slice to nothing and then owe work for ever —
    // a resume loop that deploys nothing, bounded only by max_attempts.
    const pass = planEdgeDeployPass({
      wanted: ["a", "b"],
      fetched: ["a", "b"],
      truncated: false,
      batchLimit: 0,
    });
    expect(pass.batch.length).toBeGreaterThan(0);
  });
});

describe("an empty batch is not the same question as a finished run", () => {
  it("nothing wanted and nothing fetched is genuinely finished", () => {
    const pass = planEdgeDeployPass({
      wanted: [],
      fetched: [],
      truncated: false,
      batchLimit: LIMIT,
    });
    expect(pass.batch).toEqual([]);
    expect(pass.moreRemain).toBe(false);
  });

  it("the whole fleet with nothing left to fetch is finished", () => {
    const pass = planEdgeDeployPass({
      wanted: null,
      fetched: [],
      truncated: false,
      batchLimit: LIMIT,
    });
    expect(pass.moreRemain).toBe(false);
  });
});
