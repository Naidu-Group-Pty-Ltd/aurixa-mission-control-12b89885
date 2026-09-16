/**
 * The beacon fires once per missed delivery, and never because a read failed.
 *
 * The failure it exists for: a lost `push` webhook creates no event, and
 * every other cascade mechanism — fold, claim, defer, reclaim — operates on
 * events that exist. The failure it must never create: a database blip read
 * as "no event", firing a fleet-wide cascade off a query error.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { beaconSummary, decideDriftBeacon } from "./driftBeacon.pure";

const HEAD = "7674f46d3f5f103af453bbe1a2f4a491056c6109";

describe("decideDriftBeacon", () => {
  it("fires only when the queue is idle, the head is known, and no event exists for it", () => {
    expect(
      decideDriftBeacon({ claimableCommitEvents: 0, headSha: HEAD, headEventExists: false }),
    ).toEqual({ fire: true });
  });

  it("stands down for a claimable carrier — it delivers prime's head whatever SHA created it", () => {
    const v = decideDriftBeacon({
      claimableCommitEvents: 1,
      headSha: HEAD,
      headEventExists: false,
    });
    expect(v.fire).toBe(false);
  });

  it("a deferred carrier is a carrier — waiting out a rate-limit window is not drift", () => {
    /* The queue count deliberately ignores `next_attempt_at`: an event parked
       until GitHub's reset is claimed-later, and a beacon that fired past it
       would duplicate the very work the deferral is pacing. */
    const v = decideDriftBeacon({
      claimableCommitEvents: 1,
      headSha: HEAD,
      headEventExists: null,
    });
    expect(v.fire).toBe(false);
  });

  it("never fires on a failed read, of the queue or of the ledger", () => {
    expect(
      decideDriftBeacon({ claimableCommitEvents: null, headSha: HEAD, headEventExists: false })
        .fire,
    ).toBe(false);
    expect(
      decideDriftBeacon({ claimableCommitEvents: 0, headSha: HEAD, headEventExists: null }).fire,
    ).toBe(false);
  });

  it("never fires blind — an unreadable head is silence, not a guess", () => {
    expect(
      decideDriftBeacon({ claimableCommitEvents: 0, headSha: null, headEventExists: null }).fire,
    ).toBe(false);
  });

  it("stands down when the head already has an event, whatever became of it", () => {
    /* A completed event means the fleet followed this push; a failed one
       means a person is owed a look — re-firing would retry a refusal. */
    const v = decideDriftBeacon({
      claimableCommitEvents: 0,
      headSha: HEAD,
      headEventExists: true,
    });
    expect(v.fire).toBe(false);
  });

  it("every refusal says why", () => {
    const refusals = [
      decideDriftBeacon({ claimableCommitEvents: null, headSha: null, headEventExists: null }),
      decideDriftBeacon({ claimableCommitEvents: 1, headSha: null, headEventExists: null }),
      decideDriftBeacon({ claimableCommitEvents: 0, headSha: null, headEventExists: null }),
      decideDriftBeacon({ claimableCommitEvents: 0, headSha: HEAD, headEventExists: null }),
      decideDriftBeacon({ claimableCommitEvents: 0, headSha: HEAD, headEventExists: true }),
    ];
    for (const v of refusals) {
      expect(v.fire).toBe(false);
      if (!v.fire) expect(v.why.length).toBeGreaterThan(10);
    }
  });

  it("the summary names the SHA and the cause", () => {
    expect(beaconSummary(HEAD)).toContain("prime@7674f46");
    expect(beaconSummary(HEAD)).toMatch(/missed or lost/);
  });
});

describe("the drain wires the beacon as insurance, not as a second engine", () => {
  const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");

  it("asks only on an idle tick", () => {
    expect(drain).toContain(
      "const beacon = results.length === 0 ? await raiseDriftBeacon() : null;",
    );
  });

  it("counts only carriers a claim could ever take", () => {
    const fn = drain.slice(drain.indexOf("async function raiseDriftBeacon"));
    expect(fn).toContain('.lt("attempts", MAX_ATTEMPTS)');
    // And deliberately NOT next_attempt_at: a deferred carrier stands it down.
    const queue = fn.slice(0, fn.indexOf("prime_config"));
    expect(queue).not.toContain("next_attempt_at");
  });

  it("synthesizes through the trigger, so the SHA dedupe and the race backstop apply", () => {
    const fn = drain.slice(drain.indexOf("async function raiseDriftBeacon"));
    expect(fn).toContain("createCascadeForAllClones({");
    expect(fn).toContain("findCommitCascadeForSha(admin, headSha)");
    expect(fn).toContain("summary: beaconSummary(headSha),");
    expect(fn).toContain('trigger: "commit",');
  });

  it("cannot take down the tick it protects", () => {
    const fn = drain.slice(
      drain.indexOf("async function raiseDriftBeacon"),
      drain.indexOf("async function drainOne"),
    );
    expect(fn).toMatch(
      /catch \(e\) \{\s*console\.error\(\s*"\[cascade-drain\] drift beacon failed/,
    );
    expect(fn).toContain("return null;");
  });
});
