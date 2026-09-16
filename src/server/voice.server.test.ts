// Tests for the scheduling brain: phone normalisation, quiet hours and the
// trigger-to-dial-time computation. All pure — no Supabase, no VAPI.
import { describe, expect, it } from "vitest";
import {
  applyQuietHours,
  buildDedupeKey,
  buildVariableValues,
  computeScheduledAt,
  normalizePhone,
  toE164AU,
  phonesMatch,
} from "./voice.server";

describe("normalizePhone", () => {
  it("keeps a leading plus and strips everything else", () => {
    expect(normalizePhone("+61 412 345 678")).toBe("+61412345678");
    expect(normalizePhone("(02) 8609-3299")).toBe("0286093299");
    expect(normalizePhone(null)).toBe("");
  });
});

describe("toE164AU", () => {
  it("gives a national number its country code", () => {
    // `(02) 8609-3299` normalises to `0286093299`, which has no country code
    // and is what the dispatcher used to hand VAPI verbatim.
    expect(toE164AU("(02) 8609-3299")).toBe("+61286093299");
    expect(toE164AU("0412 345 678")).toBe("+61412345678");
  });

  it("restores a plus that was lost in storage", () => {
    expect(toE164AU("61412345678")).toBe("+61412345678");
  });

  it("leaves an already-qualified number alone, whatever the country", () => {
    expect(toE164AU("+61412345678")).toBe("+61412345678");
    expect(toE164AU("+12184132393")).toBe("+12184132393");
    expect(toE164AU("+60182548567")).toBe("+60182548567");
  });

  it("passes an unrecognised shape through untouched rather than guessing", () => {
    // Guessing a country code here would dial a stranger. Letting the
    // provider refuse it keeps the failure honest and attributable.
    expect(toE164AU("12345")).toBe("12345");
    expect(toE164AU("0412345")).toBe("0412345");
    expect(toE164AU("041234567890")).toBe("041234567890");
    expect(toE164AU("")).toBe("");
    expect(toE164AU(null)).toBe("");
  });

  it("does not change what matching sees", () => {
    // The whole reason this is separate from normalizePhone.
    expect(normalizePhone("(02) 8609-3299")).toBe("0286093299");
    expect(phonesMatch("(02) 8609-3299", toE164AU("(02) 8609-3299"))).toBe(true);
  });
});

describe("phonesMatch", () => {
  it("matches national and international spellings of one number", () => {
    expect(phonesMatch("+61412345678", "0412 345 678")).toBe(true);
    expect(phonesMatch("+61412345678", "+61498765432")).toBe(false);
  });

  it("refuses to match short fragments", () => {
    expect(phonesMatch("1234", "1234")).toBe(false);
  });
});

const SYDNEY_QUIET = {
  timezone: "Australia/Sydney",
  start: "08:00",
  end: "20:00",
  days: [1, 2, 3, 4, 5, 6],
};

describe("applyQuietHours", () => {
  it("leaves a time inside the window alone", () => {
    // 2026-08-26 is a Wednesday; 04:00 UTC = 14:00 AEST.
    const inside = new Date("2026-08-26T04:00:00Z");
    expect(applyQuietHours(inside, SYDNEY_QUIET).toISOString()).toBe(inside.toISOString());
  });

  it("shifts a middle-of-the-night dial to the morning window", () => {
    // 16:00 UTC = 02:00 AEST Thursday. Must land at/after 08:00 AEST Thursday
    // (22:00 UTC Wednesday).
    const night = new Date("2026-08-26T16:00:00Z");
    const shifted = applyQuietHours(night, SYDNEY_QUIET);
    expect(shifted.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-08-26T22:00:00Z"));
    expect(shifted.getTime()).toBeLessThanOrEqual(Date.parse("2026-08-26T22:05:00Z"));
  });

  it("skips a disallowed day entirely", () => {
    // 2026-08-30 02:00 UTC = Sunday 12:00 AEST; Sunday is not a calling day,
    // so the dial moves to Monday 08:00 AEST (Sunday 22:00 UTC).
    const sunday = new Date("2026-08-30T02:00:00Z");
    const shifted = applyQuietHours(sunday, SYDNEY_QUIET);
    expect(shifted.getTime()).toBeGreaterThanOrEqual(Date.parse("2026-08-30T22:00:00Z"));
  });

  it("returns the input untouched on a nonsense timezone", () => {
    const d = new Date("2026-08-26T16:00:00Z");
    expect(applyQuietHours(d, { ...SYDNEY_QUIET, timezone: "Not/AZone" }).toISOString()).toBe(
      d.toISOString(),
    );
  });
});

describe("computeScheduledAt", () => {
  const baseRule = {
    schedule_anchor: "event",
    delay_seconds: 120,
    anchor_offset_seconds: 0,
    expiry_seconds: 420,
    quiet_hours: SYDNEY_QUIET,
  };

  it("dials delay_seconds after the trigger event, with expiry from the shifted time", () => {
    const now = new Date("2026-08-26T04:00:00Z"); // 14:00 AEST Wednesday
    const { scheduledAt, expiresAt } = computeScheduledAt(baseRule as any, { now });
    expect(scheduledAt.toISOString()).toBe("2026-08-26T04:02:00.000Z");
    expect(expiresAt?.toISOString()).toBe("2026-08-26T04:09:00.000Z");
  });

  it("anchors a reminder on the appointment, offset backwards", () => {
    const now = new Date("2026-08-26T04:00:00Z");
    const appointmentAt = new Date("2026-08-27T05:00:00Z"); // Thu 15:00 AEST
    const rule = {
      ...baseRule,
      schedule_anchor: "appointment",
      anchor_offset_seconds: -7200,
      expiry_seconds: null,
    };
    const { scheduledAt, expiresAt } = computeScheduledAt(rule as any, { now, appointmentAt });
    expect(scheduledAt.toISOString()).toBe("2026-08-27T03:00:00.000Z");
    expect(expiresAt).toBeNull();
  });

  it("never schedules in the past when the anchor already went by", () => {
    const now = new Date("2026-08-26T04:00:00Z");
    const appointmentAt = new Date("2026-08-26T03:00:00Z");
    const rule = { ...baseRule, schedule_anchor: "appointment", anchor_offset_seconds: -7200 };
    const { scheduledAt } = computeScheduledAt(rule as any, { now, appointmentAt });
    expect(scheduledAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });
});

describe("buildDedupeKey", () => {
  it("keys on trigger, subject and anchor", () => {
    expect(buildDedupeKey("discovery_no_show", "j1", "2026-08-27T05:00:00Z")).toBe(
      "discovery_no_show:j1:2026-08-27T05:00:00Z",
    );
    expect(buildDedupeKey("nurture", "j1")).toBe("nurture:j1");
  });
});

describe("buildVariableValues", () => {
  it("carries the canonical set and fills template placeholders", () => {
    const v = buildVariableValues({
      fullName: "Jane Citizen",
      phone: "+61412345678",
      contactId: "c1",
      defaults: { callTitle: "Discovery Call with Rugesh from NPC Services | {fullName}" },
      extras: { quizSummary: "wants a duplex" },
      now: new Date("2026-08-26T04:00:00Z"),
    });
    expect(v.firstName).toBe("Jane");
    expect(v.callTitle).toBe("Discovery Call with Rugesh from NPC Services | Jane Citizen");
    expect(v.quizSummary).toBe("wants a duplex");
    expect(v.currentDateUnix).toBe(Math.floor(Date.parse("2026-08-26T04:00:00Z") / 1000));
  });
});
