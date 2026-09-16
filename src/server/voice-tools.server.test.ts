// Tests for the pure halves of the inbound tools: envelope shape, tool-call
// extraction across VAPI's three spellings, the deterministic booking-intent
// classifier, availability slot generation and handoff classification.
import { describe, expect, it } from "vitest";
import {
  candidateSlots,
  classifyBookingIntent,
  classifyHandoffIntent,
  extractToolCalls,
  orderSlotsByPreference,
  parseContactEmail,
  parseSlotPreference,
  slotMatchesPreference,
  toolEnvelope,
} from "./voice-tools.server";

describe("toolEnvelope", () => {
  it("stringifies the result — VAPI ignores structured bodies", () => {
    const env = toolEnvelope("tc_1", { success: true });
    expect(env.results).toHaveLength(1);
    expect(env.results[0].toolCallId).toBe("tc_1");
    expect(JSON.parse(env.results[0].result)).toEqual({ success: true });
  });
});

describe("extractToolCalls", () => {
  it("reads toolCallList with function.arguments as a JSON string", () => {
    const calls = extractToolCalls({
      toolCallList: [
        { id: "a", function: { name: "resolve_contact", arguments: '{"full_name":"Jo"}' } },
      ],
    });
    expect(calls).toEqual([{ id: "a", name: "resolve_contact", args: { full_name: "Jo" } }]);
  });

  it("falls back to toolCalls and toolWithToolCallList", () => {
    expect(
      extractToolCalls({
        toolCalls: [{ id: "b", function: { name: "get_call_context", arguments: {} } }],
      })[0].name,
    ).toBe("get_call_context");
    expect(
      extractToolCalls({
        toolWithToolCallList: [
          { toolCall: { id: "c", function: { name: "book_appointment", arguments: {} } } },
        ],
      })[0].name,
    ).toBe("book_appointment");
  });

  it("ignores malformed entries instead of throwing mid-call", () => {
    expect(extractToolCalls({ toolCallList: [{ function: {} }, null] })).toEqual([]);
  });
});

describe("classifyBookingIntent", () => {
  it("maps the Aurixa session vocabulary", () => {
    expect(classifyBookingIntent("book my strategic review").kind).toBe("strategic_review");
    expect(classifyBookingIntent("platform discovery session").kind).toBe("discovery_session");
    expect(classifyBookingIntent("a guided demonstration of the platform").kind).toBe(
      "guided_demo",
    );
    expect(classifyBookingIntent("enterprise requirements consultation").kind).toBe(
      "enterprise_consultation",
    );
    expect(classifyBookingIntent("our onboarding kickoff call").kind).toBe("kickoff");
  });

  it("lands plain review/application language on the strategic review", () => {
    expect(classifyBookingIntent("the review for my application").kind).toBe("strategic_review");
  });

  it("asks for clarification instead of guessing", () => {
    const r = classifyBookingIntent("just wanted to chat");
    expect(r.kind).toBeNull();
    expect(r.clarificationQuestion).toBeTruthy();
  });
});

describe("candidateSlots", () => {
  // 2026-08-26T00:00Z is Wednesday 10:00 AEST.
  const now = new Date("2026-08-26T00:00:00Z");
  const slots = candidateSlots(now);

  it("honours 24h minimum notice and the Mon–Fri 9:00–16:30 Sydney window", () => {
    expect(slots.length).toBeGreaterThan(0);
    const minStart = now.getTime() + 24 * 60 * 60_000;
    const fmt = new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    for (const s of slots) {
      expect(s.getTime()).toBeGreaterThanOrEqual(minStart);
      const parts = fmt.formatToParts(s);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
      expect(["Sat", "Sun"]).not.toContain(get("weekday").slice(0, 3));
      const minutes = (Number(get("hour")) % 24) * 60 + Number(get("minute"));
      expect(minutes).toBeGreaterThanOrEqual(9 * 60);
      // A 30-minute slot must end by 4:30 p.m., so the last start is 4:00 p.m.
      expect(minutes).toBeLessThanOrEqual(16 * 60);
    }
  });

  it("covers the 45-day booking horizon", () => {
    const last = slots[slots.length - 1];
    expect(last.getTime()).toBeGreaterThan(now.getTime() + 40 * 24 * 60 * 60_000);
  });

  it("starts every slot on a half hour", () => {
    for (const s of slots) expect(s.getTime() % (30 * 60_000)).toBe(0);
  });
});

/*
 * The caller's email address. The VAPI tool has declared this parameter since
 * the org tools were created and the handler read it nowhere, so
 * `crm_contacts.email` is null on every voice-created contact — and it is the
 * only channel a booking confirmation can travel down.
 *
 * What arrives is transcription, so the rule these pin is that an address
 * which does not parse is DROPPED. A plausible-looking wrong address is worse
 * than none: every later confirmation goes to it and nothing here reads a
 * bounce.
 */
describe("parseContactEmail", () => {
  it("takes an ordinary address, trimmed and lower-cased", () => {
    expect(parseContactEmail("  Jane.Citizen@Example.COM ")).toBe("jane.citizen@example.com");
    expect(parseContactEmail("a@b.co")).toBe("a@b.co");
    expect(parseContactEmail("first+tag@sub.domain.com.au")).toBe("first+tag@sub.domain.com.au");
  });

  it("drops what a phone line mis-hears rather than storing it", () => {
    expect(parseContactEmail("jane dot citizen at example dot com")).toBeNull();
    expect(parseContactEmail("jane@example")).toBeNull(); // no dotted domain
    expect(parseContactEmail("jane@@example.com")).toBeNull();
    expect(parseContactEmail("jane @example.com")).toBeNull();
    expect(parseContactEmail("@example.com")).toBeNull();
    expect(parseContactEmail("jane@.com")).toBeNull();
  });

  it("treats an absent or non-string value as no address", () => {
    expect(parseContactEmail(undefined)).toBeNull();
    expect(parseContactEmail(null)).toBeNull();
    expect(parseContactEmail("")).toBeNull();
    expect(parseContactEmail("   ")).toBeNull();
    expect(parseContactEmail(42)).toBeNull();
    expect(parseContactEmail({ address: "jane@example.com" })).toBeNull();
  });

  it("refuses a value too long for the column's purpose", () => {
    expect(parseContactEmail(`${"a".repeat(250)}@example.com`)).toBeNull();
  });
});

describe("classifyHandoffIntent", () => {
  it("routes support and product language to the specialists", () => {
    expect(classifyHandoffIntent("something is broken and I need support with an error")).toBe(
      "support",
    );
    expect(classifyHandoffIntent("what does the platform cost and which modules exist")).toBe(
      "solutions",
    );
    expect(classifyHandoffIntent("I want to book my review time slot")).toBe("review");
  });

  it("defaults to the solutions advisor when nothing scores", () => {
    expect(classifyHandoffIntent("hello there")).toBe("solutions");
  });
});

/*
 * The caller's preferred day. `check_availability` accepted
 * `preferred_date_text` from the day it was registered and threw it away, so
 * "Thursday afternoon would suit" was answered with the first eight
 * chronological slots. These pin the two halves that matter: what is
 * understood, and that understanding it REORDERS rather than removes.
 *
 * September 2026 is AEST (UTC+10) — DST starts on the first Sunday in
 * October — so the instants below are unambiguous.
 */
const FRI_0900 = new Date("2026-09-17T23:00:00Z"); // Fri 18 Sep 09:00 Sydney
const FRI_1300 = new Date("2026-09-18T03:00:00Z"); // Fri 18 Sep 13:00 Sydney
const MON_0900 = new Date("2026-09-20T23:00:00Z"); // Mon 21 Sep 09:00 Sydney

describe("parseSlotPreference", () => {
  it("reads a weekday, however the caller abbreviates it", () => {
    expect(parseSlotPreference("thursday would suit").weekday).toBe(4);
    expect(parseSlotPreference("how about thurs?").weekday).toBe(4);
    expect(parseSlotPreference("tues is better for me").weekday).toBe(2);
  });

  it("reads the part of the day", () => {
    expect(parseSlotPreference("some time in the morning").partOfDay).toBe("morning");
    expect(parseSlotPreference("afternoon please").partOfDay).toBe("afternoon");
  });

  it("resolves a relative day against Sydney, not the server clock", () => {
    // 15:00 UTC on the 17th is already 01:00 on the 18th in Sydney, so
    // "tomorrow" is the 19th. A UTC-based reading would answer the 18th —
    // which is the whole reason this goes through sydneyParts.
    const pref = parseSlotPreference("tomorrow", new Date("2026-09-17T15:00:00Z"));
    expect(pref.dayOfMonth).toBe(19);
    expect(pref.month).toBe(9);
  });

  it("stays unrecognised rather than guessing", () => {
    expect(parseSlotPreference("").recognised).toBe(false);
    expect(parseSlotPreference("whenever you like").recognised).toBe(false);
    expect(parseSlotPreference(null).recognised).toBe(false);
  });

  it("does not read a clock time as a day of the month", () => {
    expect(parseSlotPreference("around 10 am").dayOfMonth).toBeNull();
  });
});

describe("slotMatchesPreference", () => {
  it("tests every stated constraint and ignores the unstated ones", () => {
    const fridayAfternoon = parseSlotPreference("friday afternoon");
    expect(slotMatchesPreference(FRI_1300, fridayAfternoon)).toBe(true);
    expect(slotMatchesPreference(FRI_0900, fridayAfternoon)).toBe(false);
    expect(slotMatchesPreference(MON_0900, fridayAfternoon)).toBe(false);

    const anyMorning = parseSlotPreference("morning");
    expect(slotMatchesPreference(FRI_0900, anyMorning)).toBe(true);
    expect(slotMatchesPreference(MON_0900, anyMorning)).toBe(true);
  });
});

describe("orderSlotsByPreference", () => {
  const slots = [FRI_0900, FRI_1300, MON_0900];

  it("is a sort, never a filter — nothing is dropped", () => {
    const ordered = orderSlotsByPreference(slots, parseSlotPreference("monday"));
    expect(ordered).toHaveLength(3);
    expect(new Set(ordered.map((d) => d.getTime()))).toEqual(
      new Set(slots.map((d) => d.getTime())),
    );
  });

  it("puts the preferred slots first and keeps each half in time order", () => {
    const ordered = orderSlotsByPreference(slots, parseSlotPreference("monday"));
    expect(ordered[0]).toBe(MON_0900);
    expect(ordered[1]).toBe(FRI_0900);
    expect(ordered[2]).toBe(FRI_1300);
  });

  it("leaves the list untouched when nothing was understood", () => {
    const pref = parseSlotPreference("whenever suits you");
    expect(orderSlotsByPreference(slots, pref)).toBe(slots);
  });

  it("still offers everything when the preference cannot be met", () => {
    const ordered = orderSlotsByPreference([FRI_0900, FRI_1300], parseSlotPreference("sunday"));
    expect(ordered).toHaveLength(2);
  });
});
