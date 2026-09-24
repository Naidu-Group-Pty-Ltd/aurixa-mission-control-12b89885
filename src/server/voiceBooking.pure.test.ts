// What the voice agent is told on each booking outcome. The rule every test
// here serves: a reply that is not a confirmed booking says NOTHING was booked,
// in words a model cannot read as a confirmation.
import { describe, expect, it } from "vitest";
import { readBooking, type CalcomBooking } from "./calcom.pure";
import {
  alreadyBookedReply,
  availabilityUnavailableReply,
  blocksFromAppointments,
  bookedReply,
  bookingNotConfirmedReply,
  calendarFaultOf,
  heldBookingOfKind,
  nearestAlternatives,
  needsEmailReply,
  removeBlockedSlots,
  rescheduledReply,
  slotTakenReply,
} from "./voiceBooking.pure";

const at = (iso: string) => new Date(iso);
const HALF_HOUR = 30;

describe("removeBlockedSlots", () => {
  const slots = [
    at("2026-09-29T00:00:00Z"),
    at("2026-09-29T00:30:00Z"),
    at("2026-09-29T01:00:00Z"),
  ];

  it("drops every slot that overlaps a block, and only those", () => {
    const blocks = [
      { start: Date.parse("2026-09-29T00:15:00Z"), end: Date.parse("2026-09-29T00:45:00Z") },
    ];
    expect(removeBlockedSlots(slots, blocks, HALF_HOUR).map((s) => s.toISOString())).toEqual([
      "2026-09-29T01:00:00.000Z",
    ]);
  });

  it("treats touching intervals as free", () => {
    const blocks = [
      { start: Date.parse("2026-09-29T00:30:00Z"), end: Date.parse("2026-09-29T01:00:00Z") },
    ];
    expect(removeBlockedSlots(slots, blocks, HALF_HOUR).map((s) => s.toISOString())).toEqual([
      "2026-09-29T00:00:00.000Z",
      "2026-09-29T01:00:00.000Z",
    ]);
  });

  it("returns the input untouched when nothing blocks", () => {
    expect(removeBlockedSlots(slots, [], HALF_HOUR)).toBe(slots);
  });
});

describe("blocksFromAppointments", () => {
  it("blocks what Cal.com cannot see and skips what it already can", () => {
    const blocks = blocksFromAppointments(
      [
        // Booked by hand in the tracker: Cal.com has never heard of it.
        { starts_at: "2026-09-29T00:00:00Z", ends_at: "2026-09-29T01:00:00Z", metadata: {} },
        // A mirror of a Cal.com booking: already in Cal.com's own answer.
        {
          starts_at: "2026-09-29T02:00:00Z",
          ends_at: "2026-09-29T02:30:00Z",
          metadata: { calcom: { uid: "bk_1" } },
        },
        // No end recorded: the session length is assumed.
        { starts_at: "2026-09-29T03:00:00Z", ends_at: null, metadata: null },
        { starts_at: "garbage", ends_at: null, metadata: {} },
      ],
      HALF_HOUR,
    );
    expect(blocks).toEqual([
      { start: Date.parse("2026-09-29T00:00:00Z"), end: Date.parse("2026-09-29T01:00:00Z") },
      { start: Date.parse("2026-09-29T03:00:00Z"), end: Date.parse("2026-09-29T03:30:00Z") },
    ]);
  });
});

describe("nearestAlternatives", () => {
  const free = [
    "2026-09-29T22:30:00Z",
    "2026-09-30T23:00:00Z",
    "2026-09-29T23:30:00Z",
    "2026-09-29T22:00:00Z",
    "2026-09-30T00:30:00Z",
  ].map(at);

  it("offers the neighbours of the time that went, in time order", () => {
    const target = at("2026-09-29T23:00:00Z");
    expect(nearestAlternatives(free, target).map((s) => s.toISOString())).toEqual(
      ["2026-09-29T22:30:00.000Z", "2026-09-29T23:30:00.000Z", "2026-09-29T22:00:00.000Z"].sort(),
    );
  });

  it("never offers the very time that was refused", () => {
    const target = at("2026-09-29T22:30:00Z");
    expect(nearestAlternatives(free, target).map((s) => s.toISOString())).not.toContain(
      "2026-09-29T22:30:00.000Z",
    );
  });

  it("offers nothing from nothing", () => {
    expect(nearestAlternatives([], at("2026-09-29T23:00:00Z"))).toEqual([]);
  });
});

describe("calendarFaultOf", () => {
  it("separates an outage from a fault somebody must fix", () => {
    expect(calendarFaultOf("unavailable")).toBe("unreachable");
    expect(calendarFaultOf("rate_limited")).toBe("unreachable");
    expect(calendarFaultOf("auth")).toBe("misconfigured");
    expect(calendarFaultOf("not_found")).toBe("misconfigured");
    expect(calendarFaultOf("invalid_request")).toBe("misconfigured");
  });
});

/** Every reply that is not a booking must say so, and must not read as one. */
function assertNothingBooked(reply: Record<string, unknown>) {
  expect(reply.success).toBe(false);
  expect(reply.appointment_created ?? false).toBe(false);
  const message = String(reply.message ?? "");
  expect(message).not.toMatch(/\bbooked and confirmed\b|\bis now\b|\byou'?re booked\b/i);
}

describe("replies that book nothing", () => {
  it("availability that could not be read offers no time at all", () => {
    const reply = availabilityUnavailableReply({
      bookingType: "Strategic Review",
      kind: "strategic_review",
      failure: "unavailable",
    });
    expect(reply.success).toBe(false);
    expect(reply.availability).toEqual([]);
    expect(reply.calendar_unavailable).toBe(true);
    expect(String(reply.message)).toMatch(/NO times are known/);
    expect(String(reply.message)).toMatch(/Do not offer, guess or promise any time/);
  });

  it("a booking with no address asks for one before anything is booked", () => {
    const reply = needsEmailReply("Strategic Review");
    assertNothingBooked(reply);
    expect(reply.needs_email).toBe(true);
    expect(String(reply.clarification_question)).toMatch(/spell it back/);
    expect(String(reply.message)).toMatch(/Nothing is booked yet/);
  });

  it("a taken time says nothing was booked and offers only the alternatives", () => {
    const alternatives = [
      { startIso: "a", endIso: "b", spoken: "Tuesday 29 September at 9:30 am" },
    ];
    const reply = slotTakenReply({
      requestedSpoken: "Tuesday 29 September at 9:00 am",
      alternatives,
    });
    assertNothingBooked(reply);
    expect(reply.slot_taken).toBe(true);
    expect(reply.alternatives).toBe(alternatives);
    expect(String(reply.message)).toMatch(/nothing was booked/);
    expect(String(reply.message)).toMatch(/offer only these nearest alternatives/);
  });

  it("a taken time with no alternatives offers a call back, not an empty list read aloud", () => {
    const reply = slotTakenReply({ requestedSpoken: "Tuesday at 9:00 am", alternatives: [] });
    expect(String(reply.message)).toMatch(/call them back/);
  });

  it("a failed move says the existing booking still stands", () => {
    const reply = slotTakenReply({
      requestedSpoken: "Tuesday at 9:00 am",
      alternatives: [],
      existingKept: "Monday at 2:00 pm",
    });
    expect(String(reply.message)).toMatch(/Monday at 2:00 pm has NOT changed/);
  });

  it("a calendar that did not confirm is never reported as a booking", () => {
    const reply = bookingNotConfirmedReply({
      requestedSpoken: "Tuesday at 9:00 am",
      operatorsAlerted: true,
    });
    assertNothingBooked(reply);
    expect(String(reply.message)).toMatch(/NOT made/);
    expect(String(reply.message)).toMatch(/Do not tell the caller they are booked/);
  });

  it("promises the team was alerted only when it was", () => {
    const alerted = bookingNotConfirmedReply({
      requestedSpoken: "Tuesday",
      operatorsAlerted: true,
    });
    const silent = bookingNotConfirmedReply({
      requestedSpoken: "Tuesday",
      operatorsAlerted: false,
    });
    expect(String(alerted.message)).toMatch(/has been alerted/);
    expect(String(silent.message)).not.toMatch(/alerted/);
    expect(String(silent.message)).toMatch(/Offer to have the team call them back/);
    expect(silent.operators_alerted).toBe(false);
  });

  it("a second booking of the same kind is offered as a move, not made", () => {
    const reply = alreadyBookedReply({
      bookingType: "Strategic Review",
      existing: { startIso: "s", endIso: "e", spoken: "Monday 28 September at 2:00 pm" },
      requestedSpoken: "Tuesday 29 September at 9:00 am",
    });
    assertNothingBooked(reply);
    expect(reply.already_booked).toBe(true);
    expect(String(reply.message)).toMatch(/Nothing new was booked/);
    expect(String(reply.message)).toMatch(/reschedule_existing set to true/);
  });
});

describe("replies that book", () => {
  it("a booking confirms the time and where the invitation went", () => {
    const reply = bookedReply({
      appointmentId: "appt_1",
      bookingType: "Strategic Review",
      bookingUid: "bk_1",
      startIso: "2026-09-28T23:00:00.000Z",
      timezone: "Australia/Sydney",
      spoken: "Tuesday 29 September at 9:00 am",
      email: "jane@example.com",
      meetingLink: true,
    });
    expect(reply).toMatchObject({
      success: true,
      appointment_created: true,
      already_confirmed: false,
      calendar: "calcom",
      booking_uid: "bk_1",
      invite_email: "jane@example.com",
    });
    expect(String(reply.message)).toMatch(/Booked and confirmed/);
    expect(String(reply.message)).toMatch(/with the video link is on its way to jane@example\.com/);
  });

  it("does not send the caller looking for a new invitation about a booking that already existed", () => {
    const reply = bookedReply({
      appointmentId: "appt_1",
      bookingType: "Strategic Review",
      bookingUid: "bk_1",
      startIso: "2026-09-28T23:00:00.000Z",
      timezone: "Australia/Sydney",
      spoken: "Tuesday 29 September at 9:00 am",
      email: "jane@example.com",
      meetingLink: true,
      alreadyConfirmed: true,
    });
    expect(reply).toMatchObject({
      success: true,
      appointment_created: true,
      already_confirmed: true,
    });
    expect(String(reply.message)).toMatch(/already booked for them/);
    expect(String(reply.message)).toMatch(/went to jane@example\.com when it was booked/);
    expect(String(reply.message)).not.toMatch(/on its way/);
  });

  it("does not promise a video link Cal.com did not issue", () => {
    const reply = bookedReply({
      appointmentId: null,
      bookingType: "Strategic Review",
      bookingUid: "bk_1",
      startIso: "x",
      timezone: "Australia/Sydney",
      spoken: "Tuesday",
      email: "jane@example.com",
      meetingLink: false,
    });
    expect(String(reply.message)).not.toMatch(/video link/);
    // A booking whose CRM record failed is still a booking.
    expect(reply.success).toBe(true);
  });

  it("a move names both times", () => {
    const reply = rescheduledReply({
      appointmentId: "appt_1",
      bookingType: "Strategic Review",
      bookingUid: "bk_2",
      startIso: "x",
      timezone: "Australia/Sydney",
      spoken: "Wednesday at 10:00 am",
      previousSpoken: "Tuesday at 9:00 am",
      email: null,
    });
    expect(reply).toMatchObject({
      success: true,
      appointment_rescheduled: true,
      appointment_created: false,
    });
    expect(String(reply.message)).toMatch(/now Wednesday at 10:00 am/);
    expect(String(reply.message)).toMatch(/replacing Tuesday at 9:00 am/);
    expect(String(reply.message)).not.toMatch(/ to null/);
  });
});

describe("heldBookingOfKind", () => {
  const now = new Date("2026-09-28T22:00:00.000Z");
  const review = { slug: "strategic-review", kind: "strategic_review" };
  const booking = (over: Record<string, unknown>): CalcomBooking =>
    readBooking({
      uid: "bk",
      status: "accepted",
      start: "2026-10-01T23:00:00.000Z",
      end: "2026-10-01T23:30:00.000Z",
      eventType: { id: 1, slug: "strategic-review" },
      attendees: [{ email: "jane@citizen.com.au" }],
      metadata: { source: "stage3_waitlist" },
      ...over,
    })!;

  it("finds a review booked on the Stage 3 page under the caller's address", () => {
    expect(heldBookingOfKind([booking({})], review, ["JANE@citizen.com.au"], now)?.uid).toBe("bk");
  });

  it("returns the soonest of several", () => {
    const later = booking({ uid: "later", start: "2026-10-08T23:00:00.000Z" });
    const sooner = booking({ uid: "sooner", start: "2026-10-02T23:00:00.000Z" });
    expect(heldBookingOfKind([later, sooner], review, ["jane@citizen.com.au"], now)?.uid).toBe(
      "sooner",
    );
  });

  it("reads this platform's own metadata only where the list omits the event type", () => {
    const untyped = booking({ eventType: null, metadata: { kind: "strategic_review" } });
    expect(heldBookingOfKind([untyped], review, ["jane@citizen.com.au"], now)).not.toBeNull();
    const otherType = booking({
      eventType: { id: 9, slug: "guided-demonstration" },
      metadata: { kind: "strategic_review" },
    });
    expect(heldBookingOfKind([otherType], review, ["jane@citizen.com.au"], now)).toBeNull();
  });

  it("ignores another person, another kind, a dead booking and one already under way", () => {
    const emails = ["jane@citizen.com.au"];
    expect(
      heldBookingOfKind([booking({ attendees: [{ email: "x@y.com" }] })], review, emails, now),
    ).toBeNull();
    expect(
      heldBookingOfKind(
        [booking({ eventType: { id: 2, slug: "platform-discovery-session" } })],
        review,
        emails,
        now,
      ),
    ).toBeNull();
    expect(heldBookingOfKind([booking({ status: "cancelled" })], review, emails, now)).toBeNull();
    expect(heldBookingOfKind([booking({ status: "rejected" })], review, emails, now)).toBeNull();
    expect(
      heldBookingOfKind([booking({ start: "2026-09-28T21:45:00.000Z" })], review, emails, now),
    ).toBeNull();
  });
});
