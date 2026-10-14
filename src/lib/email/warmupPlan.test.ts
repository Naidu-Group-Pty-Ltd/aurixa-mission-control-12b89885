// The warmup's rules: how much a mailbox sends on each day of its ramp, when,
// to whom, what happens to what it receives, and what counts as healthy.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEDULE,
  MAX_THREAD_DEPTH,
  MIN_SEND_GAP_MINUTES,
  campaignWarmupAdvice,
  checkDelayMinutes,
  dailySeries,
  daysBefore,
  describeRamp,
  totalsBetween,
  choosePartner,
  dailyTarget,
  engagementPlan,
  healthScore,
  healthTone,
  localDate,
  nextSendAt,
  rampDay,
  rampEvidence,
  rampGate,
  receiveCap,
  scheduleProblems,
  windowCloses,
  type PoolMember,
  type WarmupSchedule,
} from "./warmupPlan.pure";
import { seededRandom } from "./warmupContent.pure";

const schedule: WarmupSchedule = { ...DEFAULT_SCHEDULE, timezone: "Australia/Sydney" };
const fixed = (value: number) => () => value;
const MIN = 60_000;
// Monday 12 Oct 2026, 09:00 in Sydney (AEDT, UTC+11).
const MONDAY_9AM = new Date("2026-10-11T22:00:00Z");

describe("scheduleProblems", () => {
  it("accepts the defaults", () => {
    expect(scheduleProblems(DEFAULT_SCHEDULE)).toEqual([]);
  });

  it("says what to fix", () => {
    const problems = scheduleProblems({
      startPerDay: 40,
      maxPerDay: 10,
      replyRate: 120,
      timezone: "Mars/Olympus",
      windowStart: "8am",
    }).join("; ");
    expect(problems).toMatch(/starting volume cannot be more than the daily maximum/);
    expect(problems).toMatch(/reply rate must be a whole number from 0 to 100/);
    expect(problems).toMatch(/time zone/);
    expect(problems).toMatch(/window's start must be a time/);
  });
});

describe("the ramp", () => {
  it("climbs by the daily increase to the ceiling", () => {
    expect([1, 2, 3, 10, 15, 16, 40].map((day) => dailyTarget(schedule, day))).toEqual([
      2, 4, 6, 20, 30, 30, 30,
    ]);
  });

  it("counts only the days a mailbox actually warmed", () => {
    // Three days of sending, the last of them a week ago: today is day four.
    expect(rampDay({ activeDays: 3, lastActiveOn: "2026-10-05", today: "2026-10-12" })).toBe(4);
    // Already sent today: still day three.
    expect(rampDay({ activeDays: 3, lastActiveOn: "2026-10-12", today: "2026-10-12" })).toBe(3);
    expect(rampDay({ activeDays: 0, lastActiveOn: null, today: "2026-10-12" })).toBe(1);
  });

  it("never asks for less than one, nor more than the ceiling when the start is above it", () => {
    expect(dailyTarget({ ...schedule, startPerDay: 5, maxPerDay: 3 }, 1)).toBe(3);
  });

  it("lets a mailbox receive about half as much again as it sends", () => {
    expect(receiveCap(2)).toBe(4);
    expect(receiveCap(30)).toBe(45);
  });

  it("names the day in the mailbox's own zone", () => {
    // 23:30 UTC on the 11th is the morning of the 12th in Sydney.
    expect(localDate(new Date("2026-10-11T23:30:00Z"), "Australia/Sydney")).toBe("2026-10-12");
    expect(localDate(new Date("2026-10-11T23:30:00Z"), "UTC")).toBe("2026-10-11");
  });
});

describe("windowCloses", () => {
  it("is the end of today's window while it is open", () => {
    expect(windowCloses(schedule, MONDAY_9AM)?.toISOString()).toBe("2026-10-12T07:00:00.000Z");
  });

  it("is null outside the window", () => {
    expect(windowCloses(schedule, new Date("2026-10-12T08:00:00Z"))).toBeNull(); // 19:00
  });

  it("handles a window that wraps past midnight, and an all-day one", () => {
    const night = { ...schedule, windowStart: "22:00", windowEnd: "02:00" };
    // 23:00 Monday in Sydney closes at 02:00 Tuesday.
    expect(windowCloses(night, new Date("2026-10-12T12:00:00Z"))?.toISOString()).toBe(
      "2026-10-12T15:00:00.000Z",
    );
    const allDay = { ...schedule, windowStart: "00:00", windowEnd: "00:00" };
    expect(windowCloses(allDay, MONDAY_9AM)?.toISOString()).toBe("2026-10-12T13:00:00.000Z");
  });
});

describe("nextSendAt", () => {
  it("spreads the day's remaining sends across the rest of the window", () => {
    // Nine hours left, ten to send: a gap of about 9h/11, ±40%.
    const at = nextSendAt({
      schedule,
      now: MONDAY_9AM,
      sentToday: 0,
      target: 10,
      random: fixed(0.5),
    })!;
    expect((at.getTime() - MONDAY_9AM.getTime()) / MIN).toBeCloseTo((9 * 60) / 11, 0);

    const soonest = nextSendAt({
      schedule,
      now: MONDAY_9AM,
      sentToday: 0,
      target: 10,
      random: fixed(0),
    })!;
    const latest = nextSendAt({
      schedule,
      now: MONDAY_9AM,
      sentToday: 0,
      target: 10,
      random: fixed(0.999),
    })!;
    expect((soonest.getTime() - MONDAY_9AM.getTime()) / MIN).toBeCloseTo(0.6 * ((9 * 60) / 11), 0);
    expect((latest.getTime() - MONDAY_9AM.getTime()) / MIN).toBeCloseTo(1.4 * ((9 * 60) / 11), 0);
  });

  it("never sends closer together than the minimum gap", () => {
    const at = nextSendAt({
      schedule,
      now: MONDAY_9AM,
      sentToday: 0,
      target: 100,
      random: fixed(0),
    })!;
    expect(at.getTime() - MONDAY_9AM.getTime()).toBe(MIN_SEND_GAP_MINUTES * MIN);
  });

  it("waits for tomorrow's window once today's quota is spent", () => {
    const at = nextSendAt({
      schedule,
      now: MONDAY_9AM,
      sentToday: 4,
      target: 4,
      random: fixed(0),
    })!;
    expect(at.toISOString()).toBe("2026-10-12T21:00:00.000Z"); // Tue 08:00 Sydney
  });

  it("waits for the window to open, a little after it does", () => {
    const early = new Date("2026-10-11T19:00:00Z"); // Mon 06:00 Sydney
    const at = nextSendAt({ schedule, now: early, sentToday: 0, target: 4, random: fixed(0.5) })!;
    const opening = Date.parse("2026-10-11T21:00:00Z"); // Mon 08:00
    expect(at.getTime()).toBeGreaterThanOrEqual(opening);
    expect(at.getTime()).toBeLessThan(opening + 25 * MIN);
  });

  it("skips the weekend when told to", () => {
    const saturday = new Date("2026-10-16T23:00:00Z"); // Sat 17 Oct, 10:00 Sydney
    const at = nextSendAt({
      schedule: { ...schedule, weekdaysOnly: true },
      now: saturday,
      sentToday: 0,
      target: 4,
      random: fixed(0),
    })!;
    expect(at.toISOString()).toBe("2026-10-18T21:00:00.000Z"); // Mon 19 Oct 08:00
  });

  it("fits one more in near the end of the window, or else waits for tomorrow", () => {
    const nearEnd = new Date("2026-10-12T06:45:00Z"); // 17:45, fifteen minutes left
    const one = nextSendAt({ schedule, now: nearEnd, sentToday: 1, target: 6, random: fixed(0) })!;
    expect(one.getTime() - nearEnd.getTime()).toBe(MIN_SEND_GAP_MINUTES * MIN);

    const lastMinutes = new Date("2026-10-12T06:57:00Z"); // 17:57, less than one gap left
    const tomorrow = nextSendAt({
      schedule,
      now: lastMinutes,
      sentToday: 1,
      target: 6,
      random: fixed(0),
    })!;
    expect(tomorrow.toISOString()).toBe("2026-10-12T21:00:00.000Z");
  });
});

describe("choosePartner", () => {
  const member = (
    id: string,
    organisationId: string,
    over: Partial<PoolMember> = {},
  ): PoolMember => ({
    id,
    address: `${id}@${organisationId}.test`,
    organisationId,
    eligible: true,
    receivedRecent: 0,
    receiveCap: 10,
    ...over,
  });
  const base = {
    senderId: "a1",
    senderOrganisationId: "org-a",
    recentPartnerIds: [] as string[],
    allowSameOrganisation: false,
    random: fixed(0),
  };

  it("only pairs across organisations", () => {
    const choice = choosePartner({
      ...base,
      members: [member("a1", "org-a"), member("a2", "org-a"), member("b1", "org-b")],
    });
    expect(choice.partner?.id).toBe("b1");
  });

  it("says why there is nobody to write to", () => {
    expect(choosePartner({ ...base, members: [member("a1", "org-a")] }).reason).toMatch(
      /no other mailbox/,
    );
    expect(
      choosePartner({ ...base, members: [member("a1", "org-a"), member("a2", "org-a")] }).reason,
    ).toMatch(/another organisation/);
    expect(
      choosePartner({
        ...base,
        members: [member("a1", "org-a"), member("b1", "org-b", { receivedRecent: 10 })],
      }).reason,
    ).toMatch(/received its share/);
    expect(
      choosePartner({
        ...base,
        members: [member("a1", "org-a"), member("b1", "org-b", { eligible: false })],
      }).reason,
    ).toMatch(/no other mailbox/);
  });

  it("prefers the least loaded partner, and not the one it wrote to last", () => {
    const members = [
      member("a1", "org-a"),
      member("b1", "org-b", { receivedRecent: 6 }),
      member("b2", "org-b", { receivedRecent: 2 }),
      member("c1", "org-c", { receivedRecent: 3 }),
    ];
    expect(choosePartner({ ...base, members }).partner?.id).toBe("b2");
    expect(choosePartner({ ...base, members, recentPartnerIds: ["b2"] }).partner?.id).toBe("c1");
  });

  it("in test mode allows its own organisation, but still prefers another", () => {
    const members = [
      member("a1", "org-a"),
      member("a2", "org-a"),
      member("b1", "org-b", { receivedRecent: 5 }),
    ];
    expect(choosePartner({ ...base, members, allowSameOrganisation: true }).partner?.id).toBe("b1");
    expect(
      choosePartner({
        ...base,
        members: [member("a1", "org-a"), member("a2", "org-a")],
        allowSameOrganisation: true,
      }).partner?.id,
    ).toBe("a2");
  });
});

describe("engagementPlan", () => {
  it("replies at about the reply rate, and half as often further down a thread", () => {
    const random = seededRandom("plan");
    const draws = 20_000;
    let first = 0;
    let second = 0;
    let flagged = 0;
    for (let i = 0; i < draws; i++) {
      const a = engagementPlan({ replyRate: 30, importantRate: 15, depth: 0, random });
      const b = engagementPlan({ replyRate: 30, importantRate: 15, depth: 1, random });
      if (a.willReply) first++;
      if (b.willReply) second++;
      if (a.willFlag) flagged++;
    }
    expect(first / draws).toBeCloseTo(0.3, 1);
    expect(second / draws).toBeCloseTo(0.15, 1);
    expect(flagged / draws).toBeCloseTo(0.15, 1);
  });

  it("ends a thread at its maximum depth, and never replies at a rate of zero", () => {
    expect(
      engagementPlan({
        replyRate: 100,
        importantRate: 0,
        depth: MAX_THREAD_DEPTH,
        random: fixed(0),
      }).willReply,
    ).toBe(false);
    expect(engagementPlan({ replyRate: 0, importantRate: 0, depth: 0, random: fixed(0) })).toEqual({
      willReply: false,
      willFlag: false,
    });
  });
});

describe("checkDelayMinutes", () => {
  it("looks again soon, then less often", () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 20].map(checkDelayMinutes);
    expect(delays).toEqual([3, 5, 10, 15, 30, 30, 60, 60]);
  });
});

describe("health", () => {
  it("is inbox placement over what has settled, with missing mail counted against", () => {
    expect(healthScore({ inbox: 2, junk: 1, other: 0, missing: 0 })).toBeNull();
    expect(healthScore({ inbox: 18, junk: 1, other: 1, missing: 0 })).toBe(95);
    expect(healthScore({ inbox: 6, junk: 2, other: 0, missing: 2 })).toBe(60);
  });

  it("has a tone", () => {
    expect([null, 95, 80, 60].map((score) => healthTone(score))).toEqual([
      null,
      "good",
      "fair",
      "poor",
    ]);
  });
});

describe("campaignWarmupAdvice", () => {
  it("speaks up for a young or unhealthy warmup, and is quiet otherwise", () => {
    expect(
      campaignWarmupAdvice({ address: "a@x.test", status: "active", rampDay: 4, health: null }),
    ).toMatch(/day 4 of its warmup/);
    expect(
      campaignWarmupAdvice({ address: "a@x.test", status: "active", rampDay: 30, health: 60 }),
    ).toMatch(/landing in spam \(60%/);
    expect(
      campaignWarmupAdvice({ address: "a@x.test", status: "active", rampDay: 30, health: 97 }),
    ).toBeNull();
    expect(
      campaignWarmupAdvice({ address: "a@x.test", status: "removed", rampDay: 1, health: 10 }),
    ).toBeNull();
  });
});

describe("reading the daily figures", () => {
  const days = [
    {
      day: "2026-10-10",
      sent: 6,
      replies_sent: 2,
      inbox: 5,
      junk: 1,
      other: 0,
      missing: 0,
      received: 4,
      rescued: 1,
      replied: 1,
    },
    {
      day: "2026-10-12",
      sent: 8,
      replies_sent: 1,
      inbox: 8,
      junk: 0,
      other: 0,
      missing: 0,
      received: 7,
      rescued: 0,
      replied: 2,
    },
    {
      day: "2026-09-30",
      sent: 99,
      replies_sent: 0,
      inbox: 0,
      junk: 99,
      other: 0,
      missing: 0,
      received: 0,
      rescued: 0,
      replied: 0,
    },
  ];

  it("counts back across month ends", () => {
    expect(daysBefore("2026-10-03", 6)).toBe("2026-09-27");
  });

  it("sums only the days asked for", () => {
    expect(totalsBetween(days, daysBefore("2026-10-12", 6), "2026-10-12")).toMatchObject({
      sent: 14,
      replies_sent: 3,
      inbox: 13,
      junk: 1,
      received: 11,
      rescued: 1,
      replied: 3,
    });
  });

  it("fills quiet days with zeros, oldest first", () => {
    const series = dailySeries(days, "2026-10-12", 4);
    expect(series.map((d) => [d.day, d.sent])).toEqual([
      ["2026-10-09", 0],
      ["2026-10-10", 6],
      ["2026-10-11", 0],
      ["2026-10-12", 8],
    ]);
  });

  it("describes a ramp in words", () => {
    expect(describeRamp(DEFAULT_SCHEDULE)).toBe(
      "2 a day to start, rising by 2 each day it warms, to 30 a day from day 15",
    );
    expect(describeRamp({ ...DEFAULT_SCHEDULE, increasePerDay: 0, startPerDay: 5 })).toBe(
      "5 new conversations a day, every day",
    );
  });
});

describe("the brake", () => {
  const dayTen = (evidence: { health: number | null; recentMissing: number }) =>
    rampGate({ schedule, day: 10, evidence });

  it("climbs while the mail is landing, or while there is too little to judge", () => {
    expect(dayTen({ health: 96, recentMissing: 0 })).toEqual({
      state: "climbing",
      planned: 20,
      target: 20,
      advances: true,
      reason: null,
    });
    expect(dayTen({ health: null, recentMissing: 0 }).state).toBe("climbing");
    // The fair band is not yet a reason to stop.
    expect(dayTen({ health: 80, recentMissing: 2 }).state).toBe("climbing");
  });

  it("slows to half, earning no ramp, while placement is poor", () => {
    expect(dayTen({ health: 60, recentMissing: 0 })).toMatchObject({
      state: "slowed",
      target: 10,
      advances: false,
    });
  });

  it("holds at the start while mail goes missing or mostly lands in spam", () => {
    const missing = dayTen({ health: 95, recentMissing: 3 });
    expect(missing).toMatchObject({ state: "held", target: 2, advances: false });
    expect(missing.reason).toMatch(/3 of its messages went missing since yesterday/);
    expect(dayTen({ health: 40, recentMissing: 0 })).toMatchObject({ state: "held", target: 2 });
  });

  it("never holds a mailbox above what its ramp planned", () => {
    expect(
      rampGate({
        schedule: { ...schedule, startPerDay: 5, maxPerDay: 3 },
        day: 1,
        evidence: { health: 10, recentMissing: 0 },
      }).target,
    ).toBe(3);
  });

  it("reads its evidence from the daily figures, in the mailbox's own days", () => {
    const days = [
      { day: "2026-10-04", inbox: 50, junk: 0 }, // outside the week
      { day: "2026-10-08", inbox: 6, junk: 2 },
      { day: "2026-10-11", inbox: 1, missing: 1 },
      { day: "2026-10-12", inbox: 1, junk: 1, missing: 2 },
    ];
    expect(rampEvidence(days, "2026-10-12")).toEqual({ health: 57, recentMissing: 3 });
  });
});
