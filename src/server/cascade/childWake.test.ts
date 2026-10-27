/**
 * A parent's merge wakes the children waiting on it — and only waits shaped
 * like the lineage pace, never somebody else's longer clock.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shouldWakeHeldEvent, WAKE_SLACK_MS } from "./childWake.pure";
import { LINEAGE_HOLD_RETRY_MS } from "./cloneCascadeSource.pure";

const NOW = Date.parse("2026-10-27T09:00:00.000Z");
const at = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

describe("shouldWakeHeldEvent", () => {
  it("wakes an event paced on the lineage cadence", () => {
    expect(shouldWakeHeldEvent(at(LINEAGE_HOLD_RETRY_MS), NOW)).toBe(true);
    expect(shouldWakeHeldEvent(at(60_000), NOW)).toBe(true);
    // A pace written a moment ago by a clock a little ahead of this one.
    expect(shouldWakeHeldEvent(at(LINEAGE_HOLD_RETRY_MS + WAKE_SLACK_MS), NOW)).toBe(true);
  });

  it("leaves a longer wait alone — a rate-limit window is GitHub's clock", () => {
    expect(shouldWakeHeldEvent(at(LINEAGE_HOLD_RETRY_MS + WAKE_SLACK_MS + 1), NOW)).toBe(false);
    expect(shouldWakeHeldEvent(at(45 * 60_000), NOW)).toBe(false);
  });

  it("leaves an event that is already due, and anything unreadable", () => {
    expect(shouldWakeHeldEvent(at(0), NOW)).toBe(false);
    expect(shouldWakeHeldEvent(at(-60_000), NOW)).toBe(false);
    expect(shouldWakeHeldEvent(null, NOW)).toBe(false);
    expect(shouldWakeHeldEvent("not a date", NOW)).toBe(false);
  });
});

describe("the merge drain wakes the children when it advances a parent", () => {
  const drain = readFileSync("src/server/cascadeMergeDrain.server.ts", "utf8");
  const advance = drain.slice(
    drain.indexOf("async function advanceClone"),
    drain.indexOf("async function wakeChildrenOf"),
  );
  const wake = drain.slice(drain.indexOf("async function wakeChildrenOf"));

  it("asks after the pointer has moved, and never lets the wake fail the advance", () => {
    expect(advance.indexOf("await wakeChildrenOf(supabase, cloneId)")).toBeGreaterThan(
      advance.indexOf("last_synced_sha: advance.sha"),
    );
    expect(advance).toMatch(/try \{\s*await wakeChildrenOf\(supabase, cloneId\);\s*\} catch/);
  });

  it("moves only pending, unclaimed events, re-checked at the write", () => {
    const update = wake.slice(wake.indexOf(".update({ next_attempt_at: nowIso })"));
    expect(update).toContain('.eq("status", "pending")');
    expect(update).toContain('.is("worker_started_at", null)');
    expect(update).toContain('.gt("next_attempt_at", nowIso)');
    expect(wake).toContain("shouldWakeHeldEvent(");
  });
});
