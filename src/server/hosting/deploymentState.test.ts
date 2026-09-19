import { describe, expect, it } from "vitest";
import {
  ADVANCE,
  CLAIMABLE,
  DEPLOYMENT_STATUSES,
  backoffSeconds,
  isDormant,
  isRetryable,
  judgeWait,
  isTerminal,
  reading,
  wakesWhenProviderConfigured,
} from "./deploymentState.pure";

describe("the four readings", () => {
  it("never paraphrases 'not requested' as a failure", () => {
    // The whole reason this function returns a reading rather than a boolean.
    const notRequested = reading("not_requested");
    const failed = reading("failed");
    expect(notRequested.reading).toBe("absent");
    expect(failed.reading).toBe("broken");
    expect(notRequested.tone).not.toBe(failed.tone);
    expect(notRequested.label).not.toContain("fail");
    expect(notRequested.detail.toLowerCase()).toContain("not a failure");
  });

  it("keeps 'never asked', 'in flight' and 'broke' apart", () => {
    expect(reading(null).reading).toBe("absent");
    expect(reading("deploying").reading).toBe("working");
    expect(reading("failed").reading).toBe("broken");
    expect(reading("live").reading).toBe("live");
  });

  it("says nothing has been attempted when no provider token exists", () => {
    const dormant = reading("pending_platform", { providerConfigured: false });
    expect(dormant.detail).toContain("Nothing has been attempted");
  });

  it("covers every declared status", () => {
    for (const status of DEPLOYMENT_STATUSES) {
      const r = reading(status);
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });
});

describe("the state machine", () => {
  it("reaches live from pending with no orphaned step", () => {
    let s: string | undefined = "pending";
    const seen: string[] = [];
    while (s && ADVANCE[s as keyof typeof ADVANCE]) {
      seen.push(s);
      s = ADVANCE[s as keyof typeof ADVANCE];
    }
    expect(s).toBe("live");
    expect(seen).toEqual([
      "pending",
      "creating_project",
      "linking_repo",
      "syncing_env",
      "deploying",
      "attaching_domain",
      "verifying_domain",
    ]);
  });

  it("claims exactly the non-terminal, non-dormant states", () => {
    const expected = DEPLOYMENT_STATUSES.filter((s) => !isTerminal(s) && !isDormant(s));
    expect([...CLAIMABLE].sort()).toEqual([...expected].sort());
  });

  it("treats dormant and terminal as different things", () => {
    // A dormant row resumes when the platform is configured; a terminal one
    // does not resume on its own. Collapsing them strands one or spins the other.
    expect(isDormant("pending_platform")).toBe(true);
    expect(isTerminal("pending_platform")).toBe(false);
    expect(isTerminal("failed")).toBe(true);
    expect(isDormant("failed")).toBe(false);
  });
});

describe("retry policy", () => {
  it("does not retry a request that was wrong", () => {
    // Repeating a 400 five times arrives at the same answer an hour later.
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 403 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
  });

  it("retries rate limits and server faults", () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  it("retries an error with no status — a network failure is not a verdict", () => {
    expect(isRetryable(null)).toBe(true);
    expect(isRetryable({})).toBe(true);
  });

  it("backs off exponentially and caps at an hour", () => {
    expect(backoffSeconds(0)).toBe(15);
    expect(backoffSeconds(3)).toBe(120);
    expect(backoffSeconds(99)).toBe(3600);
  });
});

/**
 * The bug these pin: the worker measured `now - created_at` — the age of the
 * deployment ROW — while reporting "Stuck in <status> for more than 6h". A row
 * advances through eight statuses over its life, so on any row older than the
 * budget the first wait of any kind resolved to stuck.
 */
describe("judgeWait", () => {
  const HOUR = 3_600_000;
  const now = Date.parse("2026-08-28T02:37:01Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("waits while the row has been in this status for less than the budget", () => {
    expect(judgeWait({ statusSince: iso(60_000), now, stuckHours: 6 })).toEqual({
      kind: "waiting",
    });
  });

  /**
   * The exact production shape. The row was created the previous day and
   * entered `syncing_env` sixty seconds before this tick; measuring the row's
   * age called that "stuck for more than 6h" and failed a healthy deployment.
   */
  it("does not call a 60-second wait stuck just because the row is a day old", () => {
    const enteredStatus = iso(60_000);
    const rowCreated = iso(20 * HOUR);
    expect(judgeWait({ statusSince: enteredStatus, now, stuckHours: 6 })).toEqual({
      kind: "waiting",
    });
    // What the old code did, kept here so the difference is the assertion.
    expect((now - Date.parse(rowCreated)) / HOUR).toBeGreaterThan(6);
  });

  it("still reports a genuine stall — the bound has to keep existing", () => {
    const verdict = judgeWait({ statusSince: iso(7 * HOUR), now, stuckHours: 6 });
    expect(verdict.kind).toBe("stuck");
    if (verdict.kind === "stuck") expect(verdict.hoursInStatus).toBeCloseTo(7, 5);
  });

  it("treats exactly the budget as still waiting, not yet stuck", () => {
    expect(judgeWait({ statusSince: iso(6 * HOUR), now, stuckHours: 6 })).toEqual({
      kind: "waiting",
    });
  });

  /**
   * An unreadable stamp is not a finding. The failure direction here is
   * destructive — it marks a live deployment failed — so an absent, empty or
   * unparseable value reads as waiting, the same discipline `ok: null` carries
   * everywhere else in this codebase.
   */
  it.each([null, undefined, "", "not-a-date"])("reads %p as waiting, never as stuck", (v) => {
    expect(judgeWait({ statusSince: v as string | null, now, stuckHours: 6 })).toEqual({
      kind: "waiting",
    });
  });

  it("does not read clock skew into the future as a stall", () => {
    expect(judgeWait({ statusSince: iso(-3 * HOUR), now, stuckHours: 6 })).toEqual({
      kind: "waiting",
    });
  });
});

/**
 * The pure function above cannot catch the actual defect coming back: both
 * `row.status_since` and `row.created_at` are strings, so feeding the wrong one
 * to `judgeWait` type-checks and every test here still passes. The wrong
 * quantity was the entire bug, so the call site is asserted directly.
 */
describe("the drain measures the wait from the status stamp", () => {
  it("passes status_since to judgeWait, never created_at", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/routes/hooks.deployment-drain.tsx", "utf8");
    const call = src.slice(src.indexOf("judgeWait({"));
    const args = call.slice(0, call.indexOf("})"));
    expect(args).toContain("statusSince: row.status_since");
    expect(args).not.toContain("created_at");
  });
});

/**
 * Waking a dormant row is narrower than reading one as dormant.
 *
 * `isDormant` groups `not_requested` with `pending_platform` because they draw
 * the same way — nothing is wrong, nothing is happening. Acting on them is the
 * opposite: one is a decision and the other is a wait.
 */
describe("wakesWhenProviderConfigured", () => {
  it("wakes the row that was asked for and could not be attempted", () => {
    expect(wakesWhenProviderConfigured("pending_platform")).toBe(true);
  });

  it("never wakes a deployment somebody declined", () => {
    // `not_requested` is an operator's decision. Deploying it because a token
    // appeared is a worse failure than the dormancy this fixes.
    expect(wakesWhenProviderConfigured("not_requested")).toBe(false);
    expect(isDormant("not_requested")).toBe(true);
  });

  it("wakes nothing that is already moving, terminal, or detached", () => {
    for (const status of DEPLOYMENT_STATUSES) {
      if (status === "pending_platform") continue;
      expect(wakesWhenProviderConfigured(status)).toBe(false);
    }
  });

  it("is a strict subset of dormant, and not equal to it", () => {
    const wakeable = DEPLOYMENT_STATUSES.filter(wakesWhenProviderConfigured);
    const dormant = DEPLOYMENT_STATUSES.filter(isDormant);
    expect(wakeable.every((s) => dormant.includes(s))).toBe(true);
    expect(wakeable.length).toBeLessThan(dormant.length);
  });

  it("the reading no longer sends an operator to a button", () => {
    const r = reading("pending_platform", { providerConfigured: true });
    expect(r.detail).not.toMatch(/reconcile action/i);
    expect(r.detail).toMatch(/drain pass/i);
  });
});

/**
 * A wait that knows WHAT it is waiting on.
 *
 * Elapsed time was the only signal, and it is a poor proxy for a stall in both
 * directions. `syncing_env` waits on the clone's own Supabase project, and a
 * backend provisioning run is measured in hours — so six hours there is a
 * healthy clone being built, and failing it turns a wait into a terminal state
 * nothing retries. The opposite case is worse: a backend that has already
 * given up cannot produce the URL and key this step wants, whatever the clock
 * says, so six more hours of silence is six hours of a deployment that could
 * not possibly proceed reading as though it might.
 */
describe("judgeWait, when the step can name its dependency", () => {
  const HOUR = 3_600_000;
  const now = Date.parse("2026-09-19T04:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("waits on a progressing dependency however long it has been", () => {
    // Nine times the budget. The clock says stuck; the dependency says the
    // thing this step needs is still being built.
    const verdict = judgeWait({
      statusSince: iso(54 * HOUR),
      now,
      stuckHours: 6,
      dependency: { name: "the clone's Supabase backend", state: "progressing" },
    });
    expect(verdict).toEqual({ kind: "waiting" });
  });

  it("is stuck the moment a dependency gives up, with no elapsed time at all", () => {
    const verdict = judgeWait({
      statusSince: iso(0),
      now,
      stuckHours: 6,
      dependency: { name: "the clone's Supabase backend", state: "terminal" },
    });
    expect(verdict.kind).toBe("stuck");
  });

  it("reports the hours it has actually been waiting on a terminal dependency", () => {
    const verdict = judgeWait({
      statusSince: iso(2 * HOUR),
      now,
      stuckHours: 6,
      dependency: { name: "the clone's Supabase backend", state: "terminal" },
    });
    // Two hours, not zero and not the six-hour budget it never reached.
    expect(verdict).toEqual({ kind: "stuck", hoursInStatus: 2 });
  });

  it("still reports a number when the stamp is unreadable", () => {
    // The stamp is the only thing that could be unreadable here; the verdict
    // is decided by the dependency, so an unparseable value must not become
    // NaN in the sentence an operator reads.
    for (const stamp of [null, undefined, "", "not-a-date"]) {
      const verdict = judgeWait({
        statusSince: stamp as string | null,
        now,
        stuckHours: 6,
        dependency: { name: "x", state: "terminal" },
      });
      expect(verdict.kind).toBe("stuck");
      expect(Number.isFinite((verdict as { hoursInStatus: number }).hoursInStatus)).toBe(true);
    }
  });

  it("never reports negative hours when the clock is skewed forward", () => {
    const verdict = judgeWait({
      statusSince: iso(-3 * HOUR),
      now,
      stuckHours: 6,
      dependency: { name: "x", state: "terminal" },
    });
    expect(verdict).toEqual({ kind: "stuck", hoursInStatus: 0 });
  });

  it("leaves the elapsed-time reading exactly as it was when nothing is named", () => {
    // The whole point of the parameter being optional: every existing caller
    // keeps the behaviour it had, so this change can only affect the one step
    // that opted in.
    for (const dependency of [undefined, null]) {
      expect(judgeWait({ statusSince: iso(3 * HOUR), now, stuckHours: 6, dependency })).toEqual({
        kind: "waiting",
      });
      expect(judgeWait({ statusSince: iso(7 * HOUR), now, stuckHours: 6, dependency })).toEqual({
        kind: "stuck",
        hoursInStatus: 7,
      });
    }
  });
});
