// When a running campaign stops itself to protect its domain.
import { describe, expect, it } from "vitest";
import {
  BOUNCE_MIN_SAMPLE,
  bounceVerdict,
  unwatchedSenderAdvice,
  warmupGuardVerdict,
} from "./senderProtection.pure";

describe("the bounce circuit breaker", () => {
  it("says nothing while nothing has bounced", () => {
    expect(bounceVerdict({ sent: 0, bounced: 0, pausePercent: 5 })).toMatchObject({
      action: "ok",
      rate: null,
    });
    expect(bounceVerdict({ sent: 350, bounced: 0, pausePercent: 5 })).toMatchObject({
      action: "ok",
      rate: 0,
    });
  });

  it("pauses at the limit, and says what to do", () => {
    const verdict = bounceVerdict({ sent: 350, bounced: 21, pausePercent: 5 });
    expect(verdict).toMatchObject({ action: "pause", rate: 6 });
    expect(verdict.detail).toMatch(/21 of the 350 contacts .* \(6%\), at or past its 5% limit/);
    expect(verdict.detail).toMatch(/resuming starts a fresh count/);
  });

  it("warns between 2% and the limit", () => {
    expect(bounceVerdict({ sent: 700, bounced: 21, pausePercent: 5 })).toMatchObject({
      action: "warn",
      rate: 3,
    });
  });

  it(`judges an early handful against at least ${BOUNCE_MIN_SAMPLE} sends`, () => {
    // Two bounces in the first ten is not yet 20%.
    expect(bounceVerdict({ sent: 10, bounced: 2, pausePercent: 5 }).action).toBe("warn");
    // But ten bounces in the first ten is past 5% of fifty too.
    expect(bounceVerdict({ sent: 10, bounced: 10, pausePercent: 5 }).action).toBe("pause");
  });

  it("only warns when automatic pausing is off", () => {
    const verdict = bounceVerdict({ sent: 100, bounced: 40, pausePercent: null });
    expect(verdict.action).toBe("warn");
    expect(verdict.detail).toMatch(/automatic pausing is off/);
  });
});

describe("the warmup guard", () => {
  const counts = (inbox: number, junk: number, missing = 0) => ({ inbox, junk, other: 0, missing });

  it("never pauses without evidence", () => {
    expect(warmupGuardVerdict({ address: "a@x.com", counts: null }).pause).toBe(false);
    // Too few settled messages to judge, however bad they look.
    expect(warmupGuardVerdict({ address: "a@x.com", counts: counts(1, 8) }).pause).toBe(false);
  });

  it("pauses when the mailbox's warmup mail is landing in spam", () => {
    const verdict = warmupGuardVerdict({ address: "rugesh@npc.test", counts: counts(6, 6, 2) });
    expect(verdict).toMatchObject({ pause: true, score: 43 });
    expect(verdict.detail).toMatch(/rugesh@npc\.test's own warmup mail is landing in spam \(43%/);
  });

  it("lets a healthy mailbox send", () => {
    expect(warmupGuardVerdict({ address: "a@x.com", counts: counts(18, 2) })).toMatchObject({
      pause: false,
      score: 90,
    });
  });
});

describe("a sender outside the warmup pool", () => {
  it("says nothing is watching it, and how much it is about to send", () => {
    expect(unwatchedSenderAdvice({ address: "rugesh@npc.test", contactsPerDay: 1050 })).toBe(
      "rugesh@npc.test is not in the warmup pool, so nothing measures whether its mail reaches inboxes and the warmup guard cannot pause this campaign if it starts landing in spam — enrol it on the Warmup page. At full pace this campaign addresses 1,050 contacts a day from it.",
    );
    expect(unwatchedSenderAdvice({ address: "a@x.com", contactsPerDay: null })).toMatch(
      /Warmup page\.$/,
    );
  });
});
