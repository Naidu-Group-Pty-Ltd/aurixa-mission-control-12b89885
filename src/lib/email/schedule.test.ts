// "Running, and nothing is happening" must always come with a reason and the
// time it ends. These are the sums behind that sentence: when the campaign's
// own calendar next opens, and when its next message may go once the gap and
// the daily caps are counted too. The case that prompted them is the first
// one below — a campaign started at 16:57 in Sydney with a 09:00–17:00
// window, which sent one message and then, correctly, waited until morning
// while the page said only "running".
import { describe, expect, it } from "vitest";
import {
  currentSlot,
  describeSchedule,
  describeSendDays,
  formatInZone,
  nextSendTime,
  nextWindowOpening,
  normaliseSendTimes,
  planTick,
  slotOccurrences,
  windowState,
  type CampaignRules,
} from "./campaignRules.pure";

const SYDNEY: CampaignRules = {
  timezone: "Australia/Sydney",
  sendDays: [1, 2, 3, 4, 5],
  windowStart: "09:00:00",
  windowEnd: "17:00:00",
  sendTimes: [],
  slotGraceMinutes: 30,
  maxMessagesPerSlot: null,
  maxMessagesPerDay: null,
  maxRecipientsPerDay: null,
  recipientsPerMessage: 1,
  minGapSeconds: 60,
  maxMessagesPerRun: 20,
  startsAt: null,
  endsAt: null,
};

const iso = (date: Date | null) => date?.toISOString() ?? null;

describe("nextWindowOpening", () => {
  it("is the next morning when started a few minutes before the window closes", () => {
    // Monday 12 Oct 2026, 19:03 in Sydney (daylight saving: UTC+11).
    const opening = nextWindowOpening(SYDNEY, new Date("2026-10-12T08:03:00Z"));
    // Tuesday 13 Oct, 09:00 Sydney = 22:00 UTC on the 12th.
    expect(iso(opening)).toBe("2026-10-12T22:00:00.000Z");
  });

  it("is now when the window is open", () => {
    const now = new Date("2026-10-12T00:00:00Z"); // Monday 11:00 Sydney
    expect(iso(nextWindowOpening(SYDNEY, now))).toBe(now.toISOString());
  });

  it("steps over the weekend", () => {
    // Friday 16 Oct 2026, 18:00 Sydney → Monday 19 Oct 09:00 Sydney.
    expect(iso(nextWindowOpening(SYDNEY, new Date("2026-10-16T07:00:00Z")))).toBe(
      "2026-10-18T22:00:00.000Z",
    );
  });

  it("follows the zone across the night daylight saving starts", () => {
    // Sydney moves from UTC+10 to UTC+11 at 02:00 on Sunday 4 Oct 2026.
    const daily = { ...SYDNEY, sendDays: [1, 2, 3, 4, 5, 6, 7] };
    // Saturday 3 Oct, 18:00 AEST (08:00 UTC) → Sunday 4 Oct 09:00 AEDT.
    expect(iso(nextWindowOpening(daily, new Date("2026-10-03T08:00:00Z")))).toBe(
      "2026-10-03T22:00:00.000Z",
    );
    // …and the morning before it was still +10: Saturday 09:00 AEST = 23:00 UTC Friday.
    expect(iso(nextWindowOpening(daily, new Date("2026-10-02T08:00:00Z")))).toBe(
      "2026-10-02T23:00:00.000Z",
    );
  });

  it("follows the zone across the night daylight saving ends", () => {
    // Sydney moves from UTC+11 back to UTC+10 at 03:00 on Sunday 5 Apr 2026.
    const daily = { ...SYDNEY, sendDays: [1, 2, 3, 4, 5, 6, 7] };
    // Saturday 4 Apr, 18:00 AEDT (07:00 UTC) → Sunday 5 Apr 09:00 AEST = 23:00 UTC.
    expect(iso(nextWindowOpening(daily, new Date("2026-04-04T07:00:00Z")))).toBe(
      "2026-04-04T23:00:00.000Z",
    );
  });

  it("opens at midnight for a window that wraps past it, on a selected day", () => {
    const overnight = { ...SYDNEY, windowStart: "22:00", windowEnd: "02:00", sendDays: [2] };
    // Monday 20:00 Sydney → Tuesday 00:00 (Tuesday is selected; Monday's 22:00 is not).
    expect(iso(nextWindowOpening(overnight, new Date("2026-10-12T09:00:00Z")))).toBe(
      "2026-10-12T13:00:00.000Z",
    );
  });

  it("waits for the campaign's own start, and never opens after its end", () => {
    const scheduled = { ...SYDNEY, startsAt: "2026-10-14T03:00:00Z" }; // Wed 14:00 Sydney
    expect(iso(nextWindowOpening(scheduled, new Date("2026-10-12T00:00:00Z")))).toBe(
      "2026-10-14T03:00:00.000Z",
    );
    const ended = { ...SYDNEY, endsAt: "2026-10-12T06:30:00Z" }; // Mon 17:30 Sydney
    expect(nextWindowOpening(ended, new Date("2026-10-12T08:03:00Z"))).toBeNull();
    const endsTonight = { ...SYDNEY, endsAt: "2026-10-12T20:00:00Z" }; // before Tue 09:00
    expect(nextWindowOpening(endsTonight, new Date("2026-10-12T08:03:00Z"))).toBeNull();
  });

  it("never opens with no day selected", () => {
    expect(nextWindowOpening({ ...SYDNEY, sendDays: [] as number[] }, new Date())).not.toBeNull();
    // An empty list means every day, as everywhere else in the rules; a list
    // naming no real weekday means none.
    expect(
      nextWindowOpening({ ...SYDNEY, sendDays: [9] }, new Date("2026-10-12T08:03:00Z")),
    ).toBeNull();
  });
});

describe("an equal start and end is the whole day", () => {
  it("is open at any hour on a selected day, rather than never", () => {
    const allDay = { ...SYDNEY, windowStart: "00:00", windowEnd: "00:00" };
    expect(windowState(allDay, new Date("2026-10-12T15:30:00Z"))).toEqual({ open: true }); // Tue 02:30
    expect(windowState(allDay, new Date("2026-10-17T03:00:00Z"))).toMatchObject({
      open: false,
      reason: "day_not_selected",
    }); // Saturday
  });
});

describe("nextSendTime", () => {
  const monday11 = new Date("2026-10-12T00:00:00Z"); // Monday 11:00 Sydney

  it("is now when nothing holds it", () => {
    expect(
      iso(
        nextSendTime({
          rules: SYDNEY,
          now: monday11,
          lastMessageAt: null,
          messagesToday: 0,
          recipientsToday: 0,
        }),
      ),
    ).toBe(monday11.toISOString());
  });

  it("waits out the gap since the last message", () => {
    expect(
      iso(
        nextSendTime({
          rules: SYDNEY,
          now: monday11,
          lastMessageAt: "2026-10-11T23:59:30Z",
          messagesToday: 1,
          recipientsToday: 1,
        }),
      ),
    ).toBe("2026-10-12T00:00:30.000Z");
  });

  it("moves to the next window when the gap runs past the close", () => {
    // Last message 16:59:30 Sydney; a 60 s gap ends after 17:00.
    expect(
      iso(
        nextSendTime({
          rules: SYDNEY,
          now: new Date("2026-10-12T05:59:45Z"),
          lastMessageAt: "2026-10-12T05:59:30Z",
          messagesToday: 1,
          recipientsToday: 1,
        }),
      ),
    ).toBe("2026-10-12T22:00:00.000Z");
  });

  it("waits for tomorrow's window once today's cap is spent", () => {
    expect(
      iso(
        nextSendTime({
          rules: { ...SYDNEY, maxMessagesPerDay: 5 },
          now: monday11,
          lastMessageAt: null,
          messagesToday: 5,
          recipientsToday: 5,
        }),
      ),
    ).toBe("2026-10-12T22:00:00.000Z");
  });
});

describe("saying it", () => {
  it("names the days the way a person would", () => {
    expect(describeSendDays([1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(describeSendDays([1, 2, 3, 4, 5, 6, 7])).toBe("every day");
    expect(describeSendDays([])).toBe("every day");
    expect(describeSendDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(describeSendDays([6, 7])).toBe("Sat, Sun");
  });

  it("puts the calendar in one line", () => {
    expect(describeSchedule(SYDNEY)).toBe("Mon–Fri, 09:00–17:00 Australia/Sydney");
    expect(describeSchedule({ ...SYDNEY, windowStart: "00:00", windowEnd: "00:00" })).toBe(
      "Mon–Fri, all day Australia/Sydney",
    );
  });

  it("reads an instant on the campaign's clock", () => {
    expect(formatInZone(new Date("2026-10-12T22:00:00Z"), "Australia/Sydney")).toMatch(
      /Tue.*13.*Oct.*09:00/,
    );
  });
});

// The calendar a state-by-state list needs: a batch at four set times, Monday
// to Saturday, in Sydney — and nothing in between. A window cannot say this:
// there is no 09:00–17:00 window that excludes 11:00, and a half-open one
// excludes 17:00 itself.
describe("sending times", () => {
  const FOUR_A_DAY: CampaignRules = {
    ...SYDNEY,
    sendDays: [1, 2, 3, 4, 5, 6],
    sendTimes: ["09:00", "13:00", "15:00", "17:00"],
    slotGraceMinutes: 30,
  };
  // Monday 12 Oct 2026; Sydney is on daylight time (UTC+11).
  const mon0900 = "2026-10-11T22:00:00.000Z";
  const mon1300 = "2026-10-12T02:00:00.000Z";

  it("reads the times as one list, earliest first, and drops what is not a clock", () => {
    expect(normaliseSendTimes(["17:00", "09:00:00", "9:00", "13:00", "", "soon"])).toEqual([
      "09:00",
      "13:00",
      "17:00",
    ]);
    expect(normaliseSendTimes(null)).toEqual([]);
  });

  it("is open from each time for its grace, and names the time it belongs to", () => {
    const slot = currentSlot(FOUR_A_DAY, new Date("2026-10-11T22:10:00Z")); // Mon 09:10
    expect(slot).toMatchObject({ clock: "09:00" });
    expect(iso(slot!.at)).toBe(mon0900);
    expect(iso(slot!.closesAt)).toBe("2026-10-11T22:30:00.000Z");
    expect(windowState(FOUR_A_DAY, new Date("2026-10-11T22:10:00Z"))).toEqual({ open: true });
  });

  it("is closed between the times, and says so in words", () => {
    expect(windowState(FOUR_A_DAY, new Date("2026-10-11T22:31:00Z"))).toMatchObject({
      open: false,
      reason: "between_slots",
      detail: "between sending times (09:00, 13:00, 15:00 and 17:00 Australia/Sydney)",
    });
  });

  it("sends at 17:00 itself, which a 09:00–17:00 window never does", () => {
    const five = new Date("2026-10-12T06:05:00Z"); // Mon 17:05
    expect(windowState(FOUR_A_DAY, five)).toEqual({ open: true });
    expect(windowState(SYDNEY, five).open).toBe(false);
  });

  it("opens next at the following time, and steps over Sunday", () => {
    expect(iso(nextWindowOpening(FOUR_A_DAY, new Date("2026-10-11T23:00:00Z")))).toBe(mon1300);
    // Saturday 17 Oct, 17:45 → Monday 19 Oct, 09:00.
    expect(iso(nextWindowOpening(FOUR_A_DAY, new Date("2026-10-17T06:45:00Z")))).toBe(
      "2026-10-18T22:00:00.000Z",
    );
    expect(windowState(FOUR_A_DAY, new Date("2026-10-17T22:00:00Z"))).toMatchObject({
      reason: "day_not_selected",
    }); // Sunday 09:00
  });

  it("holds 09:00 in Sydney across the night daylight saving starts", () => {
    const daily = { ...FOUR_A_DAY, sendDays: [1, 2, 3, 4, 5, 6, 7], sendTimes: ["09:00"] };
    // Saturday 3 Oct 09:00 is AEST (+10); Sunday 4 Oct 09:00 is AEDT (+11).
    const slots = slotOccurrences(daily, new Date("2026-10-03T00:00:00Z"), 1).map((s) => iso(s.at));
    expect(slots).toContain("2026-10-02T23:00:00.000Z");
    expect(slots).toContain("2026-10-03T22:00:00.000Z");
  });

  it("never stays open past the next time, so a late tick loses a batch rather than doubling one", () => {
    const close = { ...FOUR_A_DAY, sendTimes: ["09:00", "09:20"] };
    const first = currentSlot(close, new Date("2026-10-11T22:05:00Z"));
    expect(iso(first!.closesAt)).toBe("2026-10-11T22:20:00.000Z");
    expect(currentSlot(close, new Date("2026-10-11T22:21:00Z"))).toMatchObject({ clock: "09:20" });
  });

  it("keeps a late time open past midnight into a day the campaign does not use", () => {
    const late = { ...FOUR_A_DAY, sendDays: [6], sendTimes: ["23:50"] };
    // Saturday 17 Oct 23:50 Sydney; checked at Sunday 00:10.
    const sunday = new Date("2026-10-17T13:10:00Z");
    expect(windowState(late, sunday)).toEqual({ open: true });
    expect(iso(currentSlot(late, sunday)!.at)).toBe("2026-10-17T12:50:00.000Z");
  });

  it("waits for the next time once this one has sent everything it may", () => {
    const at = new Date("2026-10-11T22:05:00Z"); // Mon 09:05
    const base = {
      rules: FOUR_A_DAY,
      now: at,
      lastMessageAt: null,
      messagesToday: 6,
      recipientsToday: 300,
    };
    expect(iso(nextSendTime(base))).toBe(at.toISOString());
    expect(iso(nextSendTime({ ...base, slotSpent: true }))).toBe(mon1300);
  });

  it("caps the messages one sending time may carry", () => {
    const capped = { ...FOUR_A_DAY, maxMessagesPerSlot: 6 };
    const input = {
      rules: capped,
      now: new Date("2026-10-11T22:05:00Z"),
      lastMessageAt: null,
      messagesToday: 4,
      recipientsToday: 200,
      pendingCount: 1000,
    };
    expect(planTick({ ...input, messagesThisSlot: 4 })).toMatchObject({
      canSend: true,
      messageAllowance: 2,
    });
    expect(planTick({ ...input, messagesThisSlot: 6 })).toMatchObject({
      canSend: false,
      blockedBy: "this sending time's messages have all gone",
    });
  });

  it("opens at the campaign's own start when that falls inside a sending time", () => {
    const started = { ...FOUR_A_DAY, startsAt: "2026-10-11T22:12:00Z" };
    expect(iso(nextWindowOpening(started, new Date("2026-10-11T20:00:00Z")))).toBe(
      "2026-10-11T22:12:00.000Z",
    );
  });

  it("puts the calendar in one line", () => {
    expect(describeSchedule(FOUR_A_DAY)).toBe(
      "Mon–Sat at 09:00, 13:00, 15:00 and 17:00 Australia/Sydney",
    );
  });
});
