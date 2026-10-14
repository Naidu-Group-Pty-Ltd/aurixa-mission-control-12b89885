// Segments and the plan they make. The case these were written against: a list
// with a State column, fifty contacts to a message, one message per state at
// 09:00, 13:00, 15:00 and 17:00 Sydney, Monday to Saturday — six messages and
// 300 contacts at each time, 1,200 a day, 7,200 a week.
import { describe, expect, it } from "vitest";
import type { CampaignRules } from "./campaignRules.pure";
import { perRecipientFields } from "./mergeTemplate.pure";
import {
  forecastSlots,
  importedDimensions,
  messagesPerSlot,
  overlappingValues,
  segmentCovers,
  segmentTurns,
  slotCapacity,
  suggestSegments,
  type ForecastSegment,
  type Segment,
} from "./segments.pure";

const FOUR_A_DAY: CampaignRules = {
  timezone: "Australia/Sydney",
  sendDays: [1, 2, 3, 4, 5, 6],
  windowStart: "09:00",
  windowEnd: "17:00",
  sendTimes: ["09:00", "13:00", "15:00", "17:00"],
  slotGraceMinutes: 30,
  maxMessagesPerSlot: null,
  maxMessagesPerDay: null,
  maxRecipientsPerDay: null,
  recipientsPerMessage: 50,
  minGapSeconds: 60,
  maxMessagesPerRun: 20,
  startsAt: null,
  endsAt: null,
};

const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS"];

const segment = (label: string, position: number, over: Partial<Segment> = {}): Segment => ({
  id: label.toLowerCase(),
  label,
  matchValues: [label.toLowerCase()],
  position,
  enabled: true,
  ...over,
});

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

// Wednesday 14 Oct 2026, 08:00 in Sydney (UTC+11).
const WED_0800 = new Date("2026-10-13T21:00:00Z");

describe("segment membership", () => {
  it("covers a contact on any of its values, and never a blank one", () => {
    const nsw = segment("NSW", 0, { matchValues: ["nsw", "new south wales"] });
    expect(segmentCovers(nsw, "state", { state: "new south wales" })).toBe(true);
    expect(segmentCovers(nsw, "state", { state: "vic" })).toBe(false);
    expect(segmentCovers(nsw, "state", { state: "" })).toBe(false);
    expect(segmentCovers(nsw, "state", {})).toBe(false);
  });

  it("names a value two segments both claim", () => {
    expect(
      overlappingValues([
        { id: "a", matchValues: ["nsw"] },
        { id: "b", matchValues: ["vic", "nsw"] },
      ]),
    ).toEqual(["nsw"]);
    expect(
      overlappingValues([
        { id: "a", matchValues: ["nsw"] },
        { id: "b", matchValues: ["vic"] },
      ]),
    ).toEqual([]);
  });
});

describe("suggesting segments from a column", () => {
  it("gathers every spelling of a state into one segment, in map order", () => {
    const suggestions = suggestSegments({
      values: [
        { value: "nsw", label: "NSW", count: 300 },
        { value: "vic", label: "VIC", count: 200 },
        { value: "qld", label: "Qld", count: 150 },
        { value: "new south wales", label: "New South Wales", count: 20 },
        { value: "tas", label: "Tas", count: 40 },
        { value: "sa", label: "SA", count: 60 },
        { value: "wa", label: "WA", count: 90 },
        { value: "act", label: "ACT", count: 10 },
        { value: "unknown", label: "Unknown", count: 5 },
      ],
    });
    expect(suggestions.map((s) => s.label)).toEqual([...STATES, "ACT", "Unknown"]);
    expect(suggestions[0]).toEqual({
      label: "NSW",
      matchValues: ["nsw", "new south wales"],
      contacts: 320,
    });
  });

  it("offers one segment per value for a column that is not states", () => {
    expect(
      suggestSegments({
        values: [
          { value: "retail", label: "Retail", count: 30 },
          { value: "trade", label: "Trade", count: 12 },
        ],
      }).map((s) => [s.label, s.matchValues]),
    ).toEqual([
      ["Retail", ["retail"]],
      ["Trade", ["trade"]],
    ]);
  });

  it("does not group a column that only happens to contain a state code", () => {
    const suggestions = suggestSegments({
      values: [
        { value: "wa", label: "WA", count: 5 },
        { value: "warehouse", label: "Warehouse", count: 5 },
      ],
    });
    expect(suggestions.map((s) => s.label)).toEqual(["WA", "Warehouse"]);
    expect(suggestions[0].matchValues).toEqual(["wa"]);
  });
});

describe("the columns a campaign can split by", () => {
  it("merges the same column across two lists and leaves out what is not a parameter", () => {
    const state = (values: [string, number][]) => ({
      key: "state",
      header: "State",
      isDimension: true,
      values: values.map(([value, count]) => ({ value, label: value.toUpperCase(), count })),
    });
    const merged = importedDimensions([
      {
        columns: [
          state([
            ["nsw", 3],
            ["vic", 1],
          ]),
          { key: "email", isDimension: false },
        ],
      },
      { columns: [state([["vic", 4]])] },
      { columns: null },
    ]);
    expect(merged.map((c) => c.key)).toEqual(["state"]);
    expect(merged[0].values.map((v) => [v.value, v.count])).toEqual([
      ["vic", 5],
      ["nsw", 3],
    ]);
    expect(merged[0].distinct).toBe(2);
  });
});

describe("whose turn it is", () => {
  const six = STATES.map((label, index) => segment(label, index));

  it("serves the least recently served first, then the operator's order", () => {
    const turns = segmentTurns({
      segments: six,
      perSlot: 1,
      sentThisSlot: new Map(),
      lastServedAt: new Map([
        ["nsw", 300],
        ["vic", 100],
      ]),
    });
    expect(turns.map((t) => t.segment.label)).toEqual(["QLD", "WA", "SA", "TAS", "VIC", "NSW"]);
  });

  it("gives each segment what is left of its share of this sending time", () => {
    const turns = segmentTurns({
      segments: six,
      perSlot: 1,
      sentThisSlot: new Map([["nsw", 1]]),
      lastServedAt: new Map(),
    });
    expect(turns.find((t) => t.segment.label === "NSW")?.remaining).toBe(0);
    expect(turns.find((t) => t.segment.label === "VIC")?.remaining).toBe(1);
  });

  it("leaves a disabled segment out, and puts no share on a window", () => {
    const turns = segmentTurns({
      segments: [segment("NSW", 0, { enabled: false }), segment("VIC", 1)],
      perSlot: null,
      sentThisSlot: new Map(),
      lastServedAt: new Map(),
    });
    expect(turns.map((t) => [t.segment.label, t.remaining])).toEqual([["VIC", Infinity]]);
  });
});

describe("a segment's own column is the same for everyone in its message", () => {
  it("does not force one contact per message, where any other column still does", () => {
    expect(perRecipientFields(["News for {{state}}", "<p>For {{state}}</p>"], ["state"])).toEqual(
      [],
    );
    expect(perRecipientFields(["News for {{state}}", "Hi {{first_name}}"], ["state"])).toEqual([
      "first_name",
    ]);
    expect(perRecipientFields(["News for {{state}}"])).toEqual(["state"]);
  });
});

describe("what the calendar carries", () => {
  it("is 300 contacts at each time, 1,200 a day and 7,200 a week for six states", () => {
    expect(
      slotCapacity({ rules: FOUR_A_DAY, perMessage: 50, segments: 6, segmentMessagesPerSlot: 1 }),
    ).toEqual({
      slotsPerDay: 4,
      sendDaysPerWeek: 6,
      perSlot: { messages: 6, contacts: 300 },
      perDay: { messages: 24, contacts: 1200 },
      perWeek: { messages: 144, contacts: 7200 },
    });
  });

  it("fits only as many gaps as the sending time stays open", () => {
    // Ten minutes between messages and thirty minutes open: four, not six.
    expect(
      messagesPerSlot({
        rules: { ...FOUR_A_DAY, minGapSeconds: 600 },
        segments: 6,
        segmentMessagesPerSlot: 1,
      }),
    ).toBe(4);
  });

  it("lets a daily contact cap bind below what the times could carry", () => {
    const capped = slotCapacity({
      rules: { ...FOUR_A_DAY, maxRecipientsPerDay: 1000 },
      perMessage: 50,
      segments: 6,
      segmentMessagesPerSlot: 1,
    });
    expect(capped.perDay).toEqual({ messages: 24, contacts: 1000 });
    expect(capped.perWeek.contacts).toBe(6000);
  });

  it("says nothing limits a sending time when nothing does", () => {
    expect(
      messagesPerSlot({
        rules: { ...FOUR_A_DAY, minGapSeconds: 0 },
        segments: null,
        segmentMessagesPerSlot: 1,
      }),
    ).toBeNull();
  });
});

describe("when the list runs out", () => {
  const waiting: ForecastSegment[] = [
    { id: "nsw", label: "NSW", pending: 1000 }, // 20 messages
    { id: "vic", label: "VIC", pending: 500 }, // 10
    { id: "qld", label: "QLD", pending: 260 }, // 6, the last one of 10
    { id: "wa", label: "WA", pending: 50 }, // 1
    { id: "sa", label: "SA", pending: 0 },
    { id: "tas", label: "TAS", pending: 49 }, // 1
  ];
  const base = {
    rules: FOUR_A_DAY,
    from: WED_0800,
    perMessage: 50,
    segments: waiting,
    pending: 0,
    segmentMessagesPerSlot: 1,
    messagesToday: 0,
    recipientsToday: 0,
    messagesThisSlot: 0,
  };

  it("finishes each state on the sending time its last message goes in", () => {
    const forecast = forecastSlots(base);
    expect(forecast.outcome).toBe("finishes");
    const by = Object.fromEntries(forecast.segments.map((s) => [s.label, s]));
    // WA and TAS are one message each: Wednesday 09:00.
    expect(iso(by.WA.finishesAt)).toBe("2026-10-13T22:00:00.000Z");
    expect(iso(by.TAS.finishesAt)).toBe("2026-10-13T22:00:00.000Z");
    // QLD's sixth message: Thursday 13:00.
    expect(iso(by.QLD.finishesAt)).toBe("2026-10-15T02:00:00.000Z");
    // VIC's tenth: Friday 13:00.
    expect(iso(by.VIC.finishesAt)).toBe("2026-10-16T02:00:00.000Z");
    // NSW's twentieth: Wed, Thu, Fri, Sat, no Sunday, Monday 17:00.
    expect(iso(by.NSW.finishesAt)).toBe("2026-10-19T06:00:00.000Z");
    expect(iso(forecast.finishesAt)).toBe("2026-10-19T06:00:00.000Z");
    expect(by.SA).toMatchObject({ messages: 0, finishesAt: null });
  });

  it("lists what each upcoming sending time should carry", () => {
    const [first, second] = forecastSlots(base).upcoming;
    expect(first).toMatchObject({
      clock: "09:00",
      messages: 5,
      contacts: 50 + 50 + 50 + 50 + 49,
      segments: ["NSW", "VIC", "QLD", "WA", "TAS"],
    });
    expect(iso(first.at)).toBe("2026-10-13T22:00:00.000Z");
    expect(second).toMatchObject({ clock: "13:00", segments: ["NSW", "VIC", "QLD"] });
  });

  it("rotates when a sending time cannot fit every state", () => {
    const thousandEach = STATES.map((label) => ({
      id: label.toLowerCase(),
      label,
      pending: 1000,
    }));
    const forecast = forecastSlots({
      ...base,
      rules: { ...FOUR_A_DAY, minGapSeconds: 600 },
      segments: thousandEach,
    });
    expect(forecast.upcoming[0].segments).toEqual(["NSW", "VIC", "QLD", "WA"]);
    // SA and TAS were left out at 09:00, so they go first at 13:00.
    expect(forecast.upcoming[1].segments).toEqual(["SA", "TAS", "NSW", "VIC"]);
  });

  it("picks up the sending time already open, after what it has sent", () => {
    const forecast = forecastSlots({
      ...base,
      from: new Date("2026-10-13T22:10:00Z"), // Wed 09:10
      segments: waiting.map((s) => ({ ...s, sentThisSlot: s.label === "NSW" ? 1 : 0 })),
      messagesThisSlot: 1,
      messagesToday: 1,
      recipientsToday: 50,
    });
    expect(forecast.upcoming[0]).toMatchObject({
      clock: "09:00",
      segments: ["VIC", "QLD", "WA", "TAS"],
    });
  });

  it("paces a list with no segments by the sending time's own limit", () => {
    const forecast = forecastSlots({
      ...base,
      rules: { ...FOUR_A_DAY, maxMessagesPerSlot: 6 },
      segments: null,
      pending: 1000,
    });
    // Twenty messages, six at a time: all four of Wednesday's times, the last
    // carrying two.
    expect(forecast.upcoming.map((slot) => slot.messages)).toEqual([6, 6, 6, 2]);
    expect(iso(forecast.finishesAt)).toBe("2026-10-14T06:00:00.000Z"); // Wed 17:00
  });

  it("says when the campaign's end date comes first", () => {
    const forecast = forecastSlots({
      ...base,
      rules: { ...FOUR_A_DAY, endsAt: "2026-10-14T23:00:00Z" }, // Thursday 10:00
    });
    expect(forecast.outcome).toBe("calendar_ends");
    expect(forecast.finishesAt).toBeNull();
  });

  it("has nothing to plan with nothing waiting", () => {
    expect(
      forecastSlots({ ...base, segments: waiting.map((s) => ({ ...s, pending: 0 })) }).outcome,
    ).toBe("nothing_waiting");
  });
});
