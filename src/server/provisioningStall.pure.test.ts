import { describe, expect, it } from "vitest";
import {
  CLAIMED_DETAIL,
  DEAD_PASS_MAX_MINUTES,
  DEAD_PASS_SILENT_MINUTES,
  MAX_PROGRESS_HANDBACKS,
  deathPointOf,
  exhaustedMessage,
  isDeadPass,
  judgeDeadPass,
  passDeathsFrom,
  requeueDetail,
  type PassDeath,
} from "./provisioningStall.pure";

const NOW = Date.parse("2026-10-30T01:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

describe("a claim is dead once nothing can still be running it", () => {
  it("leaves a young claim alone, however quiet its row", () => {
    expect(isDeadPass({ workerStartedAt: ago(2), updatedAt: ago(2), now: NOW })).toBe(false);
  });

  it("takes a claim back after five silent minutes, not fifteen", () => {
    /* The 29–30 Oct kills each cost a quarter of an hour before the next
       claim, against a pass that cannot live past its 60-second request. */
    expect(
      isDeadPass({
        workerStartedAt: ago(DEAD_PASS_SILENT_MINUTES),
        updatedAt: ago(DEAD_PASS_SILENT_MINUTES),
        now: NOW,
      }),
    ).toBe(true);
  });

  it("never takes a claim whose row is still being written, until the backstop", () => {
    expect(isDeadPass({ workerStartedAt: ago(8), updatedAt: ago(1), now: NOW })).toBe(false);
    expect(
      isDeadPass({ workerStartedAt: ago(DEAD_PASS_MAX_MINUTES), updatedAt: ago(0), now: NOW }),
    ).toBe(true);
  });

  it("reads an unreadable heartbeat as alive until the backstop", () => {
    expect(isDeadPass({ workerStartedAt: ago(8), updatedAt: null, now: NOW })).toBe(false);
    expect(isDeadPass({ workerStartedAt: ago(16), updatedAt: null, now: NOW })).toBe(true);
    expect(isDeadPass({ workerStartedAt: "not a time", updatedAt: null, now: NOW })).toBe(false);
  });
});

describe("where a dead pass stopped", () => {
  it("is the last stage it reported", () => {
    expect(deathPointOf("Replicating realtime publication from prime...")).toBe(
      "Replicating realtime publication from prime...",
    );
    expect(deathPointOf("  Replicating   pg_cron schedule\nfrom prime... ")).toBe(
      "Replicating pg_cron schedule from prime...",
    );
  });

  it("is nowhere when it reported nothing of its own", () => {
    expect(deathPointOf(null)).toBeNull();
    expect(deathPointOf("   ")).toBeNull();
    expect(deathPointOf(CLAIMED_DETAIL)).toBeNull();
    expect(deathPointOf("Worker stalled — requeued")).toBeNull();
    expect(
      deathPointOf(requeueDetail("Replicating realtime publication from prime...")),
    ).toBeNull();
  });

  it("is bounded, so one long sentence cannot fill the audit row", () => {
    expect(deathPointOf("x".repeat(1000))).toHaveLength(300);
  });
});

describe("a death costs an attempt only where the job has died before", () => {
  const CRON = "Replicating pg_cron schedule from prime...";
  const REALTIME = "Replicating realtime publication from prime...";

  it("hands back a death at a point the job had not reached", () => {
    /* 00:35 on 30 Oct: the pass finished the cron stage the earlier passes
       died in and died at the realtime publication. It was counted. */
    const history: PassDeath[] = [
      { point: CRON, handedBack: true },
      { point: CRON, handedBack: false },
    ];
    expect(judgeDeadPass({ point: REALTIME, history }).handBack).toBe(true);
  });

  it("counts a death where the job has died before", () => {
    expect(
      judgeDeadPass({ point: REALTIME, history: [{ point: REALTIME, handedBack: true }] }).handBack,
    ).toBe(false);
  });

  it("counts a pass that died before its first stage", () => {
    expect(judgeDeadPass({ point: null, history: [] }).handBack).toBe(false);
  });

  it("counts a death when the history could not be read: unknown is not new", () => {
    expect(judgeDeadPass({ point: REALTIME, history: null }).handBack).toBe(false);
  });

  it("stops handing back once the cap is spent, so new points alone cannot recycle for ever", () => {
    const history: PassDeath[] = Array.from({ length: MAX_PROGRESS_HANDBACKS }, (_, i) => ({
      point: `stage ${i}`,
      handedBack: true,
    }));
    expect(judgeDeadPass({ point: "a stage never seen", history }).handBack).toBe(false);
    expect(judgeDeadPass({ point: "a stage never seen", history: history.slice(1) }).handBack).toBe(
      true,
    );
  });

  it("fails a job once three of its deaths got nowhere new", () => {
    /* Replays the drain: each death is judged against the ones recorded
       before it, and attempts follow the claim (+1) and the hand-back (-1). */
    const points = [CRON, CRON, REALTIME, REALTIME, REALTIME];
    const history: PassDeath[] = [];
    let attempts = 0;
    for (const point of points) {
      attempts += 1;
      const { handBack } = judgeDeadPass({ point, history });
      history.push({ point, handedBack: handBack });
      if (handBack) attempts -= 1;
    }
    expect(attempts).toBe(3);
  });
});

describe("what the operator reads", () => {
  it("the requeue names where the pass died", () => {
    expect(requeueDetail("Replicating realtime publication from prime...")).toBe(
      "Worker stalled during “Replicating realtime publication from prime...” — requeued",
    );
    expect(requeueDetail(null)).toBe("Worker stalled before its first stage — requeued");
  });

  it("the failure names where the last pass died", () => {
    const msg = exhaustedMessage("Replicating realtime publication from prime...", 3);
    expect(msg).toContain("stalled 3 times");
    expect(msg).toContain(
      "The last one died during “Replicating realtime publication from prime...”.",
    );
    expect(msg).toContain("retry from the clone page");
    expect(exhaustedMessage(null, 3)).toContain("before reporting a stage");
  });
});

describe("the recorded deaths", () => {
  it("are read back from audit metadata, skipping rows that are not deaths", () => {
    expect(
      passDeathsFrom([
        { metadata: { point: "a", handed_back: true } },
        { metadata: { point: null, handed_back: false } },
        { metadata: null },
        { metadata: ["not", "an", "object"] },
        { metadata: { point: "b" } },
      ]),
    ).toEqual([
      { point: "a", handedBack: true },
      { point: null, handedBack: false },
      { point: "b", handedBack: false },
    ]);
  });
});
