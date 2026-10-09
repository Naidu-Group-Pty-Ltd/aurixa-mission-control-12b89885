/**
 * The batching decision, and the one mistake it exists to make impossible:
 * a pass reporting a deployment complete that it never performed.
 */
import { describe, expect, it } from "vitest";
import {
  countLanded,
  inDeployOrder,
  planDeployGeneration,
  planEdgeDeployPass,
  planEdgeDeployResume,
  refreshedSince,
  runWithinBudget,
  stalestFirst,
} from "./edgeDeployBatch.pure";

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

describe("planEdgeDeployResume — what a bounded pass costs the run", () => {
  const resume = (over: Partial<Parameters<typeof planEdgeDeployResume>[0]> = {}) =>
    planEdgeDeployResume({
      landed: 15,
      moreRemain: false,
      stoppedEarly: true,
      attempts: 5,
      maxAttempts: 30,
      ...over,
    });

  it("finishes only when nothing is owed by either measure", () => {
    expect(resume({ moreRemain: false, stoppedEarly: false })).toEqual({ kind: "complete" });
  });

  it("a batch cut short by the budget is not a finished run", () => {
    // The whole point of the budget: the bundles it did not reach were never
    // deployed, and a pass that called itself complete would lose them.
    expect(resume({ moreRemain: false, stoppedEarly: true }).kind).toBe("requeue");
  });

  it("a pass that landed something is not charged for the invocation", () => {
    /*
      Requeuing onto a two-minute tick while charging every pass an attempt
      spends all thirty inside an hour — on a run that is working. Measured
      2 Sep 2026 at the twenty-minute cadence this replaces: 88 of 423
      bundles deployed, 14 of 30 attempts already gone, and the arithmetic
      exhausting the budget short of the last bundle.
    */
    expect(resume({ landed: 1, attempts: 29 })).toEqual({ kind: "requeue", attemptNeutral: true });
  });

  it("a pass that landed nothing keeps its attempt", () => {
    // A failed bundle never becomes `refreshed`, so the next pass fetches
    // exactly the same work. Attempt-neutral, that loops for ever.
    expect(resume({ landed: 0, attempts: 5 })).toEqual({
      kind: "requeue",
      attemptNeutral: false,
    });
  });

  it("stops asking once an unproductive run is out of attempts", () => {
    expect(resume({ landed: 0, attempts: 30, maxAttempts: 30 })).toEqual({ kind: "park" });
  });

  it("never parks a run that is still landing bundles, however many passes it took", () => {
    /*
      Termination is what makes this safe: each landed bundle becomes
      `refreshed` and is skipped next pass, so the remaining set strictly
      shrinks and the set is finite. Parking a progressing run would abandon
      a deployment mid-fleet for no reason but its pass count.
    */
    expect(resume({ landed: 1, attempts: 999, maxAttempts: 30 }).kind).toBe("requeue");
  });

  it("a completed run is complete whatever its attempt count", () => {
    expect(resume({ landed: 0, moreRemain: false, stoppedEarly: false, attempts: 99 })).toEqual({
      kind: "complete",
    });
  });
});

describe("runWithinBudget — stopping without losing what was done", () => {
  const ran = <T>(items: readonly T[], stopAfter: number) => {
    const seen: T[] = [];
    return {
      seen,
      run: () =>
        runWithinBudget<T, string>({
          items,
          runOne: async (item) => {
            seen.push(item);
            return [`did:${String(item)}`];
          },
          isPastDeadline: () => seen.length >= stopAfter,
        }),
    };
  };

  it("keeps the results of the items it did reach", async () => {
    /*
      The property the whole change rests on. `deployEdgeFunctions` signals
      its own budget by throwing and DISCARDING its partial results — correct
      for provisioning, which re-derives progress from the target, and fatal
      here: the lane charges an attempt exactly when a pass landed nothing, so
      a loop that dropped its results would report every budget stop as barren
      and burn the run's whole attempt budget while working perfectly.
    */
    const h = ran(["a", "b", "c", "d"], 2);
    const out = await h.run();
    expect(out.stoppedEarly).toBe(true);
    expect(out.results).toEqual(["did:a", "did:b"]);
  });

  it("says so when it got through everything", async () => {
    const out = await ran(["a", "b"], 99).run();
    expect(out.stoppedEarly).toBe(false);
    expect(out.results).toEqual(["did:a", "did:b"]);
  });

  it("always attempts the first item, even past the deadline", async () => {
    /*
      A budget already spent before the loop began — a slow snapshot read —
      would otherwise deploy nothing every pass, and every one of those passes
      is charged an attempt for landing nothing. One a pass is slow; zero is
      stuck.
    */
    const out = await runWithinBudget<string, string>({
      items: ["a", "b", "c"],
      runOne: async (i) => [`did:${i}`],
      isPastDeadline: () => true,
    });
    expect(out.results).toEqual(["did:a"]);
    expect(out.stoppedEarly).toBe(true);
  });

  it("an empty batch stops nowhere and reports nothing outstanding", async () => {
    const out = await runWithinBudget<string, string>({
      items: [],
      runOne: async () => ["never"],
      isPastDeadline: () => true,
    });
    expect(out).toEqual({ results: [], stoppedEarly: false });
  });

  it("does not run an item it has decided to stop before", async () => {
    const h = ran(["a", "b", "c"], 1);
    await h.run();
    expect(h.seen).toEqual(["a"]);
  });

  it("hands the deadline the slowest item so far, so it can refuse to start one it cannot finish", async () => {
    /*
      With a 45 s budget inside a 60 s invocation, a deploy begun at 44 s
      that takes twenty is killed at sixty — the requeue is never written
      and the run sits in `executing` for the stall reclaim's twenty minutes.
      Observed 2 Sep 2026 at 307 of 423 bundles. The slowest item this pass
      has seen is the estimate the caller reserves.
    */
    const durations: Record<string, number> = { a: 10, b: 3, c: 12, d: 1 };
    let clock = 0;
    const reserves: number[] = [];
    const out = await runWithinBudget<string, string>({
      items: ["a", "b", "c", "d"],
      runOne: async (item) => {
        clock += durations[item];
        return [`did:${item}`];
      },
      isPastDeadline: (reserveMs) => {
        reserves.push(reserveMs);
        return false;
      },
      now: () => clock,
    });
    expect(out.stoppedEarly).toBe(false);
    // Before b: a took 10. Before c: still 10 (b was quicker). Before d: c took 12.
    expect(reserves).toEqual([10, 10, 12]);
  });

  it("a reserve that overruns the deadline stops the pass with its results kept", async () => {
    let clock = 0;
    const deadlineAt = 20;
    const out = await runWithinBudget<string, string>({
      items: ["a", "b"],
      runOne: async (item) => {
        clock += 15;
        return [`did:${item}`];
      },
      // 15 elapsed + 15 reserved > 20: b would not finish inside the budget.
      isPastDeadline: (reserveMs) => clock + reserveMs >= deadlineAt,
      now: () => clock,
    });
    expect(out).toEqual({ results: ["did:a"], stoppedEarly: true });
  });
});

describe("countLanded — what the clone accepted, not what was sent", () => {
  it("counts only the deploys that succeeded", () => {
    expect(countLanded([{}, { error: "413" }, {}, { error: "boom" }])).toBe(2);
  });

  it("a batch in which everything failed landed nothing", () => {
    /*
      This is the number that decides whether a pass is charged an attempt.
      Counting the batch instead would make a pass that failed at all sixty
      bundles look like forward progress, and the run would requeue on the
      same failing work for ever without ever reaching a person.
    */
    expect(countLanded([{ error: "a" }, { error: "b" }])).toBe(0);
  });

  it("nothing attempted is nothing landed", () => {
    expect(countLanded([])).toBe(0);
  });
});

describe("planDeployGeneration — a bundle is delivered against a REVISION", () => {
  const runStartedAt = "2026-09-13T03:53:04.279Z";
  const now = "2026-09-13T05:40:00.000Z";
  const before = "1f2c54af3bf9f4f9a000401340cfdd8ff3c31b18";
  const after = "4f4759eb8495359cc2fcd8f3674ed19218fc1e67";

  const gen = (over: Partial<Parameters<typeof planDeployGeneration>[0]> = {}) =>
    planDeployGeneration({
      runStartedAt,
      lastGenerationAt: null,
      lastSourceSha: null,
      observedSourceSha: before,
      now,
      ...over,
    });

  it("the first pass of a run measures from the run's start", () => {
    // Nothing has been recorded yet, so there is no revision to compare
    // against and nothing to restart. The old behaviour exactly.
    expect(gen()).toEqual({ baselineAt: runStartedAt, sourceMoved: false });
  });

  it("a pass on the same revision keeps the baseline it had", () => {
    expect(gen({ lastSourceSha: before, observedSourceSha: before })).toEqual({
      baselineAt: runStartedAt,
      sourceMoved: false,
    });
  });

  it("the prime moving under the run restarts the generation HERE", () => {
    /*
      The measured case, 13 Sep 2026 on npc-client-dashboard. One run started
      03:53:04 deployed `email-sync-cron` at 05:16:38 from the tree before the
      05:38:21 merge and `outlook-email-sync` at 05:48:22 from the tree after
      it, then reported 435 deployed. Read back from the project, the first
      carried none of the merge's code and the second carried all of it.

      Restarting the baseline is what makes the next pass fetch the whole set
      again: every bundle's copy on the clone is now OLDER than the baseline,
      so `refreshedSince` skips none of them.
    */
    expect(gen({ lastSourceSha: before, observedSourceSha: after })).toEqual({
      baselineAt: now,
      sourceMoved: true,
    });
  });

  it("a restarted run measures from the restart, not from the run's start", () => {
    const restartedAt = "2026-09-13T05:40:00.000Z";
    expect(
      gen({
        lastGenerationAt: restartedAt,
        lastSourceSha: after,
        observedSourceSha: after,
        now: "2026-09-13T06:10:00.000Z",
      }),
    ).toEqual({ baselineAt: restartedAt, sourceMoved: false });
  });

  it("an unreadable revision never restarts a generation", () => {
    /*
      The asymmetry that keeps this terminating. A GitHub blip that answers no
      sha would otherwise buy a 435-bundle redeploy on every pass, for ever —
      so an absent reading keeps the baseline and lets the pass carry on. The
      cost is one pass that may skip a stale bundle; the alternative never
      finishes at all.
    */
    for (const unreadable of [null, undefined, "", "   "]) {
      expect(gen({ lastSourceSha: before, observedSourceSha: unreadable })).toEqual({
        baselineAt: runStartedAt,
        sourceMoved: false,
      });
    }
  });

  it("a revision recorded for the first time is not a move", () => {
    // A run whose earlier passes predate this bookkeeping has no recorded
    // sha. Treating that absence as movement would restart every in-flight
    // run in the fleet the moment this ships.
    expect(gen({ lastSourceSha: null, observedSourceSha: after })).toEqual({
      baselineAt: runStartedAt,
      sourceMoved: false,
    });
  });
});

describe("planEdgeDeployResume — a restarted generation outranks a finished pass", () => {
  const base = { landed: 60, moreRemain: false, stoppedEarly: false, attempts: 1, maxAttempts: 30 };

  it("a pass that would have completed is handed back when the source moved", () => {
    /*
      This is the case that turned a mixed tree into a `succeeded` run: the
      pass deployed the last outstanding bundle, saw nothing remaining, and
      pronounced the deployment complete — over bundles from two different
      revisions of the prime.
    */
    expect(planEdgeDeployResume({ ...base, sourceMoved: true })).toEqual({
      kind: "requeue",
      attemptNeutral: false,
    });
  });

  it("a restart is charged an attempt even though the pass landed bundles", () => {
    // Forward progress is attempt-neutral because it strictly SHRINKS the
    // remaining set. A restart grows it back to the whole fleet, so that
    // argument does not hold and `maxAttempts` is what bounds a prime
    // merging faster than a pass can complete.
    expect(planEdgeDeployResume({ ...base, landed: 200, sourceMoved: true })).toEqual({
      kind: "requeue",
      attemptNeutral: false,
    });
  });

  it("restarts are bounded — a run that keeps being overtaken reaches a person", () => {
    expect(planEdgeDeployResume({ ...base, attempts: 30, sourceMoved: true })).toEqual({
      kind: "park",
    });
  });

  it("an absent flag is the old behaviour exactly", () => {
    expect(planEdgeDeployResume(base)).toEqual({ kind: "complete" });
    expect(planEdgeDeployResume({ ...base, sourceMoved: false })).toEqual({ kind: "complete" });
  });

  it("a still source still lets a budget pause requeue attempt-neutrally", () => {
    expect(
      planEdgeDeployResume({ ...base, stoppedEarly: true, sourceMoved: false }),
    ).toEqual({ kind: "requeue", attemptNeutral: true });
  });
});

describe("stalestFirst — the copy the clone has held longest goes first", () => {
  const order = (freshness: ReadonlyMap<string, number>, names: readonly string[]) =>
    inDeployOrder(
      names.map((slug) => ({ slug })),
      stalestFirst(freshness),
    ).map((b) => b.slug);

  it("puts the oldest copy first and the newest last", () => {
    const freshness = new Map([
      ["alpha", Date.parse("2026-10-08T12:00:00Z")],
      ["beta", Date.parse("2026-10-06T09:00:00Z")],
      ["gamma", Date.parse("2026-10-07T18:00:00Z")],
    ]);
    expect(order(freshness, ["alpha", "beta", "gamma"])).toEqual(["beta", "gamma", "alpha"]);
  });

  it("puts a bundle the clone does not hold before every copy it does", () => {
    // `property-team`: added to the prime on 8 Oct 2026, on no clone at all.
    const freshness = new Map([["abs-data-service", Date.parse("2026-09-01T00:00:00Z")]]);
    expect(order(freshness, ["abs-data-service", "property-team"])).toEqual([
      "property-team",
      "abs-data-service",
    ]);
  });

  it("reads an unusable stamp as a missing copy", () => {
    const freshness = new Map([
      ["alpha", Number.NaN],
      ["beta", Number.POSITIVE_INFINITY],
      ["gamma", 5],
    ]);
    expect(order(freshness, ["gamma", "alpha", "beta"])).toEqual(["alpha", "beta", "gamma"]);
  });

  it("keeps the snapshot's own order when the clone could not be read", () => {
    // `listProjectEdgeFunctionFreshness` answers an empty map on a failed
    // read, so every key is equal and the lane deploys as it did before.
    const names = slugs(12);
    expect(order(new Map(), names)).toEqual(names);
  });
});

describe("inDeployOrder — a reorder that cannot lose or invent a bundle", () => {
  const items = slugs(5).map((slug) => ({ slug }));
  const names = (out: readonly { slug: string }[]) => out.map((b) => b.slug);

  it("returns the given order, in a new array, when there is no deploy order", () => {
    const out = inDeployOrder(items);
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
  });

  it("sorts ascending by key and leaves its input alone", () => {
    const key = new Map([
      ["fn-000", 3],
      ["fn-001", 1],
      ["fn-002", 4],
      ["fn-003", 0],
      ["fn-004", 2],
    ]);
    const before = names(items);
    expect(names(inDeployOrder(items, (slug) => key.get(slug) ?? 0))).toEqual([
      "fn-003",
      "fn-001",
      "fn-004",
      "fn-000",
      "fn-002",
    ]);
    expect(names(items)).toEqual(before);
  });

  it("keeps the given order between equal keys, however many there are", () => {
    // Forty equal keys: the order between them is the old one by rule, not
    // whatever the engine's sort happens to do with them.
    const many = slugs(40).map((slug) => ({ slug }));
    const out = inDeployOrder(many, (slug) => (slug === "fn-020" ? 1 : 0));
    expect(names(out)).toEqual([...slugs(40).filter((s) => s !== "fn-020"), "fn-020"]);
  });

  it("sorts a key that is not a number first, as a missing copy", () => {
    const out = inDeployOrder(items, (slug) => (slug === "fn-003" ? Number.NaN : 1));
    expect(names(out)).toEqual(["fn-003", "fn-000", "fn-001", "fn-002", "fn-004"]);
  });

  it("ties two missing copies rather than comparing them to NaN", () => {
    const out = inDeployOrder(items, (slug) =>
      slug === "fn-001" || slug === "fn-004" ? Number.NEGATIVE_INFINITY : 0,
    );
    expect(names(out)).toEqual(["fn-001", "fn-004", "fn-000", "fn-002", "fn-003"]);
  });

  it("returns every bundle it was given, once, in ascending key order", () => {
    const fleet = slugs(395).map((slug) => ({ slug }));
    const key = (slug: string) => (Number(slug.slice(3)) * 37) % 395;
    const out = inDeployOrder(fleet, key);
    expect(out).toHaveLength(fleet.length);
    expect(new Set(names(out))).toEqual(new Set(names(fleet)));
    for (let i = 1; i < out.length; i++) {
      expect(key(out[i].slug)).toBeGreaterThan(key(out[i - 1].slug));
    }
  });
});

describe("the deploy order across a run's passes — the lane's decisions against a model clone", () => {
  /*
   * Every decision here is the lane's own, wired the way
   * `executeEdgeFunctionDeploy` wires it: `planDeployGeneration`,
   * `refreshedSince`, `inDeployOrder` over `stalestFirst`, the snapshot's cap,
   * `planEdgeDeployPass`, `runWithinBudget`, `countLanded` and
   * `planEdgeDeployResume`. What is modelled is only what the lane reads from
   * outside (the clone's stamps, the prime's HEAD, the clock) and the two
   * things it writes back:
   *
   * - a bundle that lands stamps the clone with the time it landed;
   * - a pass whose every deploy failed throws, and `executeRemediationRun`
   *   keeps that pass's attempt and writes no result, then marks the run
   *   `failed` once the attempt reaches `max_attempts`.
   *
   * `slots` is how many deploys a pass has time for. Measured 8 Oct 2026 on
   * NPC Test, the snapshot read left time for about two, a clone got a pass
   * every eight minutes, and the prime merged twenty times that day, about
   * once every nine passes.
   */
  const PASS_MS = 8 * 60_000;
  const MAX_ATTEMPTS = 30;
  const START_MS = Date.parse("2026-10-08T00:00:00.000Z");
  const FLEET = slugs(395);

  type Outcome = { readonly kind: "complete" | "park" | "failed"; readonly pass: number };

  /** Stamps on which the alphabet and staleness disagree: fn-i is (37i mod n) minutes older. */
  const scrambled = (bundles: readonly string[] = FLEET) =>
    new Map(
      bundles.map((slug, i) => [
        slug,
        START_MS - 86_400_000 - ((i * 37) % bundles.length) * 60_000,
      ]),
    );

  /** Stamps on which the alphabet and staleness agree: fn-000 is the oldest copy. */
  const alphabetical = (bundles: readonly string[] = FLEET) =>
    new Map(bundles.map((slug, i) => [slug, START_MS - 86_400_000 + i * 60_000]));

  /** `stamps` with `slug` made the oldest copy the clone holds. */
  const withStalest = (stamps: Map<string, number>, slug: string) =>
    stamps.set(slug, START_MS - 30 * 86_400_000);

  async function simulate(input: {
    readonly ordered: boolean;
    readonly passes: number;
    readonly slots: number | ((pass: number) => number);
    /** A prime merge every this many passes; 0 holds the prime still. */
    readonly mergeEvery: number;
    /** The clone's stamps, updated in place, so a later run sees what this one left. */
    readonly freshness: Map<string, number>;
    readonly startMs?: number;
    /** Bundles the clone refuses on every deploy. */
    readonly refused?: ReadonlySet<string>;
    /** A function the prime adds, by the pass it first appears on. */
    readonly addedAt?: ReadonlyMap<number, string>;
  }) {
    const startMs = input.startMs ?? START_MS;
    const runStartedAt = new Date(startMs).toISOString();
    const prime = [...FLEET];
    const firstLanded = new Map<string, number>();
    let lastGenerationAt: string | null = null;
    let lastSourceSha: string | null = null;
    let attempts = 0;
    let restarts = 0;
    const end = (outcome: Outcome | null, passes: number) => ({
      firstLanded,
      outcome,
      restarts,
      endedMs: startMs + passes * PASS_MS,
    });

    for (let p = 0; p < input.passes; p++) {
      const nowMs = startMs + p * PASS_MS;
      const slots = typeof input.slots === "number" ? input.slots : input.slots(p);
      const added = input.addedAt?.get(p);
      if (added) {
        prime.push(added);
        prime.sort((a, b) => a.localeCompare(b));
      }

      const observedSourceSha = `sha-${input.mergeEvery > 0 ? Math.floor(p / input.mergeEvery) : 0}`;
      const generation = planDeployGeneration({
        runStartedAt,
        lastGenerationAt,
        lastSourceSha,
        observedSourceSha,
        now: new Date(nowMs).toISOString(),
      });
      if (generation.sourceMoved) restarts += 1;

      // The snapshot: skip what this generation delivered, order, then cap.
      const skip = new Set(refreshedSince(input.freshness, generation.baselineAt));
      const deployable = inDeployOrder(
        prime.filter((slug) => !skip.has(slug)).map((slug) => ({ slug })),
        input.ordered ? stalestFirst(input.freshness) : undefined,
      );
      const truncated = deployable.length > LIMIT;
      const pass = planEdgeDeployPass({
        wanted: null,
        fetched: (truncated ? deployable.slice(0, LIMIT) : deployable).map((b) => b.slug),
        truncated,
        batchLimit: LIMIT,
      });
      if (pass.batch.length === 0 && !generation.sourceMoved) {
        return end({ kind: "complete", pass: p }, p + 1);
      }

      let tried = 0;
      const { results, stoppedEarly } = await runWithinBudget<
        string,
        { slug: string; error?: string }
      >({
        items: pass.batch,
        runOne: async (slug) => {
          tried += 1;
          if (input.refused?.has(slug)) return [{ slug, error: "refused" }];
          input.freshness.set(slug, nowMs + tried * 1_000);
          if (!firstLanded.has(slug)) firstLanded.set(slug, p);
          return [{ slug }];
        },
        isPastDeadline: () => tried >= slots,
      });

      const failures = results.filter((r) => r.error);
      if (failures.length > 0 && failures.length === results.length) {
        // The lane throws. The attempt this pass took is kept, and nothing
        // is written to the result, so the next pass reads the same
        // generation this one did.
        if (attempts + 1 >= MAX_ATTEMPTS) return end({ kind: "failed", pass: p }, p + 1);
        attempts += 1;
        continue;
      }

      const resume = planEdgeDeployResume({
        landed: countLanded(results),
        moreRemain: pass.moreRemain,
        stoppedEarly,
        attempts,
        maxAttempts: MAX_ATTEMPTS,
        sourceMoved: generation.sourceMoved,
      });
      if (resume.kind !== "requeue") return end({ kind: resume.kind, pass: p }, p + 1);
      if (!resume.attemptNeutral) attempts += 1;
      lastGenerationAt = generation.baselineAt;
      lastSourceSha = observedSourceSha;
    }
    return end(null, input.passes);
  }

  it("reaches the end of the alphabet while the prime keeps merging", async () => {
    /*
      The measured shape: two deploys a pass, a merge every nine passes. By
      name, every merge sends the walk back to `fn-000`, so the same eighteen
      bundles are deployed over and over and the 220th never is. Stalest
      first, a merge changes only the skip list, and the walk goes on from
      the copy the clone has held longest.
    */
    const byName = await simulate({
      ordered: false,
      passes: 360,
      slots: 2,
      mergeEvery: 9,
      freshness: scrambled(),
    });
    expect([...byName.firstLanded.keys()].sort()).toEqual(slugs(18));
    expect(byName.firstLanded.has("fn-219")).toBe(false);

    const stalest = await simulate({
      ordered: true,
      passes: 360,
      slots: 2,
      mergeEvery: 9,
      freshness: scrambled(),
    });
    expect(stalest.firstLanded.size).toBe(FLEET.length);
    expect(Math.max(...stalest.firstLanded.values())).toBe(197);
    // The 192nd-oldest copy, at two deploys a pass.
    expect(stalest.firstLanded.get("fn-219")).toBe(95);
  });

  it("changes which bundles a pass carries, never when the run ends", async () => {
    for (const ordered of [false, true]) {
      // Merging: every restart is charged an attempt, so the thirty-first
      // parks the run whatever it deployed.
      const merging = await simulate({
        ordered,
        passes: 360,
        slots: 2,
        mergeEvery: 9,
        freshness: scrambled(),
      });
      expect(merging.outcome).toEqual({ kind: "park", pass: 279 });
      expect(merging.restarts).toBe(31);

      // Still: the whole fleet, two a pass, then complete.
      const still = await simulate({
        ordered,
        passes: 360,
        slots: 2,
        mergeEvery: 0,
        freshness: scrambled(),
      });
      expect(still.outcome).toEqual({ kind: "complete", pass: 197 });
      expect(still.firstLanded.size).toBe(FLEET.length);
    }
  });

  it("deploys a function the prime adds on the pass it appears", async () => {
    // A new function has no copy on the clone, so it is the stalest of all.
    const added = "fn-312b";
    const run = (ordered: boolean) =>
      simulate({
        ordered,
        passes: 360,
        slots: 2,
        mergeEvery: 9,
        freshness: scrambled(),
        addedAt: new Map([[54, added]]),
      });
    expect((await run(false)).firstLanded.has(added)).toBe(false);
    expect((await run(true)).firstLanded.get(added)).toBe(54);
  });

  describe("a bundle the clone refuses on every pass", () => {
    const alternating = (p: number) => (p % 2 === 0 ? 2 : 1);

    it("deploys exactly as before when the alphabet already put it first", async () => {
      const refused = new Set(["fn-000"]);
      for (const ordered of [false, true]) {
        const run = await simulate({
          ordered,
          passes: 500,
          slots: 2,
          mergeEvery: 0,
          freshness: alphabetical(),
          refused,
        });
        expect(run.outcome).toEqual({ kind: "complete", pass: 393 });
        expect(run.firstLanded.size).toBe(FLEET.length - 1);
      }
    });

    it("finishes the run the alphabet would have failed", async () => {
      /*
        Last by name, it is reached only when nothing else is left, and from
        then on every pass is that one deploy, refused: a pass that lands
        nothing throws, and thirty of them fail the run. First by staleness,
        it shares every pass with a bundle that lands, and the pass that
        lands the last of those completes the run with it recorded as failed.
      */
      const refused = new Set(["fn-394"]);
      const run = (ordered: boolean) =>
        simulate({
          ordered,
          passes: 500,
          slots: 2,
          mergeEvery: 0,
          freshness: withStalest(scrambled(), "fn-394"),
          refused,
        });
      const byName = await run(false);
      expect(byName.outcome).toEqual({ kind: "failed", pass: 226 });
      expect(byName.firstLanded.size).toBe(FLEET.length - 1);
      const stalest = await run(true);
      expect(stalest.outcome).toEqual({ kind: "complete", pass: 393 });
      expect(stalest.firstLanded.size).toBe(FLEET.length - 1);
    });

    it("costs a pass with time for one deploy the run's attempt", async () => {
      /*
        The trade this order makes, stated where it can be checked. Once the
        refused bundle is the stalest it takes the first deploy of every
        pass. A pass with time for one deploy then lands nothing, throws and
        is charged, so with every other pass that short the run fails after
        sixty passes, having landed thirty bundles. By name the refused
        bundle is last, so the same run lands everything else and completes.
      */
      const refused = new Set(["fn-394"]);
      const run = (ordered: boolean) =>
        simulate({
          ordered,
          passes: 500,
          slots: alternating,
          mergeEvery: 0,
          freshness: withStalest(scrambled(), "fn-394"),
          refused,
        });
      const byName = await run(false);
      expect(byName.outcome).toEqual({ kind: "complete", pass: 262 });
      expect(byName.firstLanded.size).toBe(FLEET.length - 1);
      const stalest = await run(true);
      expect(stalest.outcome).toEqual({ kind: "failed", pass: 59 });
      expect(stalest.firstLanded.size).toBe(30);
    });

    it("carries a failed run's progress into the next run, where the alphabet starts again", async () => {
      /*
        The same failure with the refused bundle first by name as well, so
        the first run is identical either way: thirty bundles, then failed.
        The catch-up sweep then plans a fresh run, whose generation begins
        after everything the first one deployed. By name it deploys the same
        thirty again and fails again, every run. Stalest first, the thirty it
        just deployed are now the clone's newest copies, so the next run
        deploys the next thirty, and the fourteenth reaches the last.
      */
      const refused = new Set(["fn-000"]);
      const runsUntilCovered = async (ordered: boolean) => {
        const freshness = alphabetical();
        const everLanded = new Set<string>();
        const perRun: string[][] = [];
        let startMs = START_MS;
        while (perRun.length < 20 && everLanded.size < FLEET.length - 1) {
          const run = await simulate({
            ordered,
            passes: 500,
            slots: alternating,
            mergeEvery: 0,
            freshness,
            refused,
            startMs,
          });
          expect(run.outcome).toEqual({ kind: "failed", pass: 59 });
          perRun.push([...run.firstLanded.keys()]);
          for (const slug of run.firstLanded.keys()) everLanded.add(slug);
          startMs = run.endedMs + 30 * 60_000;
        }
        return { perRun, everLanded: everLanded.size };
      };

      const byName = await runsUntilCovered(false);
      expect(byName.perRun).toHaveLength(20);
      expect(byName.everLanded).toBe(30);
      expect(byName.perRun[1]).toEqual(byName.perRun[0]);

      const stalest = await runsUntilCovered(true);
      expect(stalest.perRun[0]).toEqual(byName.perRun[0]);
      expect(stalest.perRun[1].filter((slug) => stalest.perRun[0].includes(slug))).toEqual([]);
      expect(stalest.perRun).toHaveLength(14);
      expect(stalest.everLanded).toBe(FLEET.length - 1);
    });
  });
});
