/**
 * Three calls to `stop` cost what one costs.
 *
 * I claimed twice — in a code comment and on the review thread — that a second
 * `stop()` was free because `clearInterval` and `abort` are no-ops once the
 * timer is down. That is true of the EFFECT and false of the COST. A beat
 * still unsettled after `CLAIM_DRAIN_MS` stays in `outstanding`, so the next
 * call started a fresh race over the same promise: with a stop before the
 * result write, another before the catch's release and the `finally` behind
 * both, an exit could spend twice the drain the constant names — at the end of
 * a 45-second pass, out of the margin left for the audit write and the
 * response. Raised by review.
 *
 * Asserted by RUNNING it rather than by reading the source, because the defect
 * was never visible in the text: every call site looked correct, and what was
 * wrong was how long the second one took. A source scan would have agreed with
 * the bug.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { beatWhileClaimHeld } from "./fleet-migration.server";

/**
 * A client whose heartbeat RPC never settles, which is the case the drain
 * exists for and the only one where a second drain can cost anything.
 */
function neverSettles() {
  return {
    rpc: () => ({
      abortSignal: () => new Promise(() => {}),
    }),
  } as unknown as Parameters<typeof beatWhileClaimHeld>[0];
}

afterEach(() => {
  vi.useRealTimers();
});

describe("beatWhileClaimHeld().stop", () => {
  it("drains once however many times it is called", async () => {
    vi.useFakeTimers();
    const beat = beatWhileClaimHeld(neverSettles(), "clone-1", "2026-09-19T00:00:00.000Z");

    // Put a beat in flight that will never settle, so the drain must time out.
    await vi.advanceTimersByTimeAsync(30_000);

    const first = beat.stop();
    const second = beat.stop();
    const third = beat.stop();

    /*
      The same promise, which is the property. Two promises here means two
      races, and the second one's clock starts when the first has already
      spent the budget.
    */
    expect(second, "a second stop starts its own drain").toBe(first);
    expect(third, "a third stop starts its own drain").toBe(first);

    let settled = false;
    void Promise.all([first, second, third]).then(() => {
      settled = true;
    });

    // One drain's worth of time, and all three are done.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled, "the drain took longer than one CLAIM_DRAIN_MS").toBe(true);
  });

  it("returns at once when called again after it has already drained", async () => {
    vi.useFakeTimers();
    const beat = beatWhileClaimHeld(neverSettles(), "clone-1", "2026-09-19T00:00:00.000Z");
    await vi.advanceTimersByTimeAsync(30_000);

    await Promise.all([beat.stop(), vi.advanceTimersByTimeAsync(2_000)]);

    // No timers left to advance: a later call must not create one.
    let again = false;
    void beat.stop().then(() => {
      again = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(again, "a stop after the drain waited for something").toBe(true);
  });

  it("stops the timer, so no beat is dispatched after it", async () => {
    vi.useFakeTimers();
    let dispatched = 0;
    const counting = {
      rpc: () => {
        dispatched += 1;
        return { abortSignal: () => Promise.resolve({ data: true, error: null }) };
      },
    } as unknown as Parameters<typeof beatWhileClaimHeld>[0];

    const beat = beatWhileClaimHeld(counting, "clone-1", "2026-09-19T00:00:00.000Z");
    await vi.advanceTimersByTimeAsync(60_000);
    const before = dispatched;
    expect(before, "no beat was dispatched at all").toBeGreaterThan(0);

    await beat.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(dispatched, "a beat was dispatched after the pass stopped").toBe(before);

    /*
      AND THE INTERVAL IS DEREGISTERED, NOT MERELY IGNORED.

      The `stopped` flag alone already prevents a dispatch, so a mutation that
      deletes `clearInterval` survives every assertion above — correctly, since
      the property they state still holds. What `clearInterval` carries is
      this: the timer stops existing. Left registered it fires every thirty
      seconds for the life of the isolate, once per clone the pass touched,
      keeping the event loop alive for work that can never happen again.

      Recorded because the mutation survived and I would rather assert the
      property the line is actually for than pretend it was covered.
    */
    expect(vi.getTimerCount(), "the heartbeat interval is still registered").toBe(0);
  });
});
