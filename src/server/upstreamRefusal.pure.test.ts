import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deferralsSoFar,
  MAX_UPSTREAM_DEFERRALS,
  planUpstreamDeferral,
  UPSTREAM_DEFERRAL_KEY,
} from "@/server/upstreamRefusal.pure";

/** The error the whole fleet's backend catch-up actually stalled on, 7 Sep 2026. */
const quotaError = () =>
  new Error(
    "API rate limit exceeded for installation ID 157200201. If you reach out to GitHub " +
      "Support for help, please include the request ID 93C3:2E1AD8:C5CDD2:CF32E7:6A9EB7AA and " +
      "timestamp 2026-09-07 13:10:03 UTC.",
  );

describe("deferralsSoFar", () => {
  it("answers zero for every shape that carries no count", () => {
    for (const result of [null, undefined, {}, [], "nope", 7, { [UPSTREAM_DEFERRAL_KEY]: "x" }]) {
      expect(deferralsSoFar(result)).toBe(0);
    }
  });

  it("reads a recorded count", () => {
    expect(deferralsSoFar({ [UPSTREAM_DEFERRAL_KEY]: 3, deployed: 6 })).toBe(3);
  });
});

describe("planUpstreamDeferral", () => {
  it("defers the refusal that stalled the fleet, and counts it", () => {
    expect(planUpstreamDeferral({ error: quotaError(), result: null })).toMatchObject({
      kind: "defer",
      deferrals: 1,
    });
  });

  it("keeps counting consecutive refusals", () => {
    expect(
      planUpstreamDeferral({ error: quotaError(), result: { [UPSTREAM_DEFERRAL_KEY]: 12 } }),
    ).toMatchObject({ kind: "defer", deferrals: 13 });
  });

  it("charges past the ceiling, so a permanent refusal still reaches a human", () => {
    expect(
      planUpstreamDeferral({
        error: quotaError(),
        result: { [UPSTREAM_DEFERRAL_KEY]: MAX_UPSTREAM_DEFERRALS },
      }).kind,
    ).toBe("charge");
  });

  it("charges a failure of the run's own work, whatever the streak", () => {
    for (const error of [
      new Error("all 60 function deploys failed: 413 request entity too large"),
      new Error("Blob not found for supabase/functions/_shared/x.ts"),
      new Error("prime source repo is not configured"),
      Object.assign(new Error("Not Found"), { status: 404 }),
      // A 403 is NOT enough on its own — that is how a permission fault would
      // hide behind a quota. The classifier this defers to says so; assert it
      // from here too, because this is the path that would hide it.
      Object.assign(new Error("Resource not accessible by integration"), { status: 403 }),
    ]) {
      expect(
        planUpstreamDeferral({ error, result: { [UPSTREAM_DEFERRAL_KEY]: 1 } }).kind,
        String((error as Error).message),
      ).toBe("charge");
    }
  });

  it("lets a pass that did work reset the streak, because lanes replace result", () => {
    // A lane's successful pass writes a fresh result with no count in it,
    // which is what makes 'consecutive' the thing that is bounded.
    const afterProgress = { resuming: true, deployed: 154, last_batch: 4 };
    expect(planUpstreamDeferral({ error: quotaError(), result: afterProgress })).toMatchObject({
      kind: "defer",
      deferrals: 1,
    });
  });

  it("recognises a 429 from any provider, not only GitHub", () => {
    expect(
      planUpstreamDeferral({
        error: Object.assign(new Error("Too Many Requests"), { status: 429 }),
        result: null,
      }).kind,
    ).toBe("defer");
  });
});

describe("the run lane spends the deferral rather than an attempt", () => {
  const lane = readFileSync(new URL("./self-healing.server.ts", import.meta.url), "utf8");

  it("writes back the pre-increment attempts, so a deferral is free", () => {
    const at = lane.indexOf('if (deferral.kind === "defer")');
    expect(at, "the deferral branch").toBeGreaterThan(-1);
    const branch = lane.slice(at, at + 1_400);
    expect(branch).toContain("attempts: run.attempts ?? 0,");
    expect(branch).toContain(`[UPSTREAM_DEFERRAL_KEY]: deferral.deferrals,`);
  });

  it("decides before the attempt is charged, never after", () => {
    // `exhausted` is what turns a run `failed` and pages somebody. A deferral
    // decided after it would be a run that had already been condemned.
    expect(lane.indexOf("planUpstreamDeferral(")).toBeLessThan(lane.indexOf("const exhausted ="));
  });
});

describe("the drain shares its invocation between the runs that are due", () => {
  const lane = readFileSync(new URL("./self-healing.server.ts", import.meta.url), "utf8");

  it("takes the least recently served run first, not the oldest", () => {
    // Each lane hands its run a 45s budget of its own while the whole sweep
    // runs inside one pg_net request that stops being waited on at sixty, so
    // a FIXED order gives the invocation to the first run and starves the
    // last. Three catch-up runs created seven seconds apart: 154, 131 and 6.
    const at = lane.indexOf('.in("status", ["planned", "approved"])');
    expect(at, "the due-runs query").toBeGreaterThan(-1);
    const query = lane.slice(at, at + 400);
    expect(query).toContain('.order("updated_at", { ascending: true })');
    // created_at breaks the tie, so a set of fresh runs is still FIFO.
    expect(query).toContain('.order("created_at", { ascending: true })');
  });
});
