/**
 * The attempt ceiling measures futility, not platform kills.
 *
 * A tick the platform cuts spends an attempt and returns nothing, so the
 * refund in `drainOne` — which needs a clean return — never sees it. These
 * pin the judgement that stops three kills from stranding a converging
 * event as a silent zombie, and stops a genuinely dead one from sitting
 * `pending` for ever with nothing reporting it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXHAUSTED_PROGRESS_WINDOW_MS,
  decideExhaustedEvent,
  retirementSummary,
} from "./exhaustedEvents.pure";

const NOW = Date.parse("2026-09-16T09:30:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("decideExhaustedEvent", () => {
  it("leaves an event under the ceiling to the ordinary claim path", () => {
    const v = decideExhaustedEvent({
      attempts: 2,
      maxAttempts: 3,
      lastResultWriteAt: minutesAgo(60),
      nowMs: NOW,
    });
    expect(v.act).toBe("leave");
  });

  it("refunds when the last pass grew the ledger before it was cut", () => {
    const v = decideExhaustedEvent({
      attempts: 3,
      maxAttempts: 3,
      lastResultWriteAt: minutesAgo(11),
      nowMs: NOW,
    });
    expect(v.act).toBe("refund");
  });

  it("the window is wider than the stall reclaim, or every kill would retire", () => {
    /* A killed tick's last flush is at least STALL_MINUTES old by the time
       the reclaim releases the claim and this judgement can see the event. */
    expect(EXHAUSTED_PROGRESS_WINDOW_MS).toBeGreaterThan(10 * 60_000);
  });

  it("retires when the ledger has stopped moving", () => {
    const v = decideExhaustedEvent({
      attempts: 3,
      maxAttempts: 3,
      lastResultWriteAt: minutesAgo(45),
      nowMs: NOW,
    });
    expect(v.act).toBe("retire");
  });

  it("never judges on a failed or unreadable read", () => {
    expect(
      decideExhaustedEvent({ attempts: 3, maxAttempts: 3, lastResultWriteAt: null, nowMs: NOW })
        .act,
    ).toBe("leave");
    expect(
      decideExhaustedEvent({
        attempts: 3,
        maxAttempts: 3,
        lastResultWriteAt: "not-a-timestamp",
        nowMs: NOW,
      }).act,
    ).toBe("leave");
  });

  it("the retirement names the lever, not just the mystery", () => {
    expect(retirementSummary(3)).toContain("Cascade now");
    expect(retirementSummary(3)).toContain("3 attempts");
  });
});

describe("the drain wires the judgement with guarded writes", () => {
  const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");
  const fn = drain.slice(
    drain.indexOf("async function judgeExhaustedEvents"),
    drain.indexOf("async function raiseDriftBeacon"),
  );

  it("runs after the reclaim, so a just-released kill is judged this tick", () => {
    expect(drain.indexOf("await reclaimStalled();")).toBeLessThan(
      drain.indexOf("await judgeExhaustedEvents();"),
    );
  });

  it("every write re-checks pending + unclaimed, so a racing claim wins", () => {
    const guards = fn.match(/\.eq\("status", "pending"\)\s*\.is\("worker_started_at", null\)/g);
    expect(guards?.length).toBeGreaterThanOrEqual(2);
  });

  it("a refund goes back to one under the ceiling, never to zero", () => {
    expect(fn).toContain(".update({ attempts: MAX_ATTEMPTS - 1 })");
  });

  it("a retirement is visible: failed status and a notification with the event's link", () => {
    expect(fn).toContain('status: "failed"');
    expect(fn).toContain('kind: "cascade_failed"');
    expect(fn).toContain("url: `/cascades/${event.id}`");
  });

  it("read failures throw — a silent judgement is the zombie with extra steps", () => {
    expect(fn).toMatch(/could not read exhausted events/);
  });
});
