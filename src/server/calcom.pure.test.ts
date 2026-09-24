// The Cal.com wire, pinned without a network. Every shape below is the one the
// live `aurixasystems` account answered with on 24 Sep 2026 (slots keyed by
// day with offset instants; a booking object with `uid`, `start`, `end`,
// `meetingUrl`, `attendees`), plus the older spellings the parsers tolerate.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CALCOM_EVENT_TYPE_SLUGS,
  CALCOM_HOST_TIME_ZONE,
  bookingEmail,
  bookingPhone,
  buildBookingRequest,
  calcomErrorMessage,
  classifyCalcomFailure,
  findSlot,
  isLiveBooking,
  kindForEventTypeSlug,
  mirrorFromBooking,
  parseBookingResponse,
  parseBookingsListResponse,
  parseCalcomWebhook,
  parseSlotsResponse,
  readBooking,
  readCalcomMirror,
  resolveTimeZone,
  sanitizeCalcomMetadata,
  spokenSlot,
  verifyCalcomSignature,
  type BookingRequestInput,
  type CalcomKind,
} from "./calcom.pure";

describe("event type slugs", () => {
  it("round-trips every kind through its slug", () => {
    for (const [kind, slug] of Object.entries(CALCOM_EVENT_TYPE_SLUGS)) {
      expect(kindForEventTypeSlug(slug)).toBe(kind);
      expect(kindForEventTypeSlug(`  ${slug} `)).toBe(kind);
    }
  });

  it("names nothing it does not know", () => {
    expect(kindForEventTypeSlug("30min")).toBeNull();
    expect(kindForEventTypeSlug(null)).toBeNull();
    expect(kindForEventTypeSlug(42)).toBeNull();
  });

  it("keeps the slugs the account was configured with", () => {
    // Renaming one here without renaming the event type in Cal.com turns every
    // booking of that kind into a `not_found`.
    expect(CALCOM_EVENT_TYPE_SLUGS).toEqual({
      strategic_review: "strategic-review",
      discovery_session: "platform-discovery-session",
      guided_demo: "guided-demonstration",
      enterprise_consultation: "enterprise-requirements-consultation",
      kickoff: "onboarding-kickoff",
    });
  });
});

describe("parseSlotsResponse", () => {
  const live = {
    status: "success",
    data: {
      "2026-09-29": [
        { start: "2026-09-29T09:30:00.000+10:00", end: "2026-09-29T10:00:00.000+10:00" },
        { start: "2026-09-29T09:00:00.000+10:00", end: "2026-09-29T09:30:00.000+10:00" },
      ],
      "2026-09-28": [
        { start: "2026-09-28T16:30:00.000+10:00", end: "2026-09-28T17:00:00.000+10:00" },
      ],
    },
  };

  it("reads the live shape into ascending UTC instants", () => {
    const slots = parseSlotsResponse(live);
    expect(slots?.map((s) => s.start.toISOString())).toEqual([
      "2026-09-28T06:30:00.000Z",
      "2026-09-28T23:00:00.000Z",
      "2026-09-28T23:30:00.000Z",
    ]);
    expect(slots?.[0].end.toISOString()).toBe("2026-09-28T07:00:00.000Z");
  });

  it("keeps an empty answer apart from an unreadable one", () => {
    // "Nothing is free" and "the calendar could not be read" send the caller
    // to different sentences, so they must never collapse.
    expect(parseSlotsResponse({ status: "success", data: {} })).toEqual([]);
    expect(parseSlotsResponse({ status: "error", error: { message: "x" } })).toBeNull();
    expect(parseSlotsResponse({ status: "success" })).toBeNull();
    expect(parseSlotsResponse("<html>502</html>")).toBeNull();
    expect(parseSlotsResponse(null)).toBeNull();
  });

  it("tolerates the older spellings of the same answer", () => {
    const older = {
      status: "success",
      data: {
        slots: {
          "2026-09-28": [{ time: "2026-09-28T00:00:00.000Z" }, "2026-09-28T00:30:00.000Z"],
        },
      },
    };
    const slots = parseSlotsResponse(older, 30);
    expect(slots?.map((s) => s.start.toISOString())).toEqual([
      "2026-09-28T00:00:00.000Z",
      "2026-09-28T00:30:00.000Z",
    ]);
    // No `end` given: the event's own length is assumed.
    expect(slots?.[0].end.toISOString()).toBe("2026-09-28T00:30:00.000Z");
  });

  it("drops duplicates, junk, and an end that does not follow its start", () => {
    const slots = parseSlotsResponse({
      status: "success",
      data: {
        a: [
          { start: "2026-09-28T00:00:00.000Z", end: "2026-09-27T00:00:00.000Z" },
          { start: "2026-09-28T00:00:00.000Z" },
          { start: "not a date" },
          42,
        ],
        b: "not a list",
      },
    });
    expect(slots).toHaveLength(1);
    expect(slots?.[0].end.toISOString()).toBe("2026-09-28T00:30:00.000Z");
  });
});

describe("findSlot", () => {
  const slots = parseSlotsResponse({
    status: "success",
    data: { d: [{ start: "2026-09-28T00:00:00.000Z" }] },
  })!;

  it("matches within a minute either way", () => {
    expect(findSlot(slots, new Date("2026-09-28T00:00:30.000Z"))).not.toBeNull();
    expect(findSlot(slots, new Date("2026-09-27T23:59:31.000Z"))).not.toBeNull();
    expect(findSlot(slots, new Date("2026-09-28T00:01:00.000Z"))).toBeNull();
  });
});

describe("booking request inputs", () => {
  it("accepts a real IANA zone and falls back to the host's otherwise", () => {
    expect(resolveTimeZone("Australia/Perth")).toBe("Australia/Perth");
    expect(resolveTimeZone("Mars/Olympus")).toBe(CALCOM_HOST_TIME_ZONE);
    expect(resolveTimeZone("")).toBe(CALCOM_HOST_TIME_ZONE);
    expect(resolveTimeZone(undefined)).toBe(CALCOM_HOST_TIME_ZONE);
  });

  it("lifts an Australian number to international format", () => {
    expect(bookingPhone("0412 345 678")).toBe("+61412345678");
    expect(bookingPhone("(02) 9876 5432")).toBe("+61298765432");
    expect(bookingPhone("61412345678")).toBe("+61412345678");
    expect(bookingPhone("+61 412 345 678")).toBe("+61412345678");
    expect(bookingPhone("+1 (415) 555-0100")).toBe("+14155550100");
  });

  it("drops a phone the API would refuse rather than failing the booking over it", () => {
    expect(bookingPhone("12345")).toBeNull();
    expect(bookingPhone("")).toBeNull();
    expect(bookingPhone("anonymous")).toBeNull();
    expect(bookingPhone(null)).toBeNull();
    expect(bookingPhone(412345678)).toBeNull();
  });

  it("reads an email the way the voice tools do", () => {
    expect(bookingEmail("  Jane@Example.COM ")).toBe("jane@example.com");
    expect(bookingEmail("jane at example dot com")).toBeNull();
    expect(bookingEmail("jane@localhost")).toBeNull();
    expect(bookingEmail(undefined)).toBeNull();
  });
});

describe("sanitizeCalcomMetadata", () => {
  it("keeps what Cal.com will store and drops what it would refuse", () => {
    const out = sanitizeCalcomMetadata({
      source: "voice_agent",
      attempt: 2,
      urgent: false,
      absent: null,
      missing: undefined,
      blank: "   ",
      ["k".repeat(41)]: "too long a key",
      long: "x".repeat(600),
    });
    expect(out).toEqual({
      source: "voice_agent",
      attempt: "2",
      urgent: "false",
      long: "x".repeat(500),
    });
  });

  it("stops at fifty keys", () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < 60; i++) input[`k${i}`] = "v";
    expect(Object.keys(sanitizeCalcomMetadata(input))).toHaveLength(50);
  });
});

describe("buildBookingRequest", () => {
  const input: BookingRequestInput = {
    kind: "strategic_review",
    username: "aurixasystems",
    start: new Date("2026-09-28T23:00:00.000Z"),
    attendee: { name: "  Jane   Citizen ", email: "Jane@Example.com", phone: "0412 345 678" },
    notes: "Wants to cover AML onboarding.",
    organisation: "Citizen Property Group",
    applicationReference: "AUR-2026-0042",
    metadata: { source: "stage3_waitlist", applicationId: "AUR-2026-0042", empty: null },
  };

  it("composes the v2 body the account accepts", () => {
    const req = buildBookingRequest(input);
    expect(req.ok).toBe(true);
    if (!req.ok) throw new Error("unreachable");
    expect(req.body).toEqual({
      start: "2026-09-28T23:00:00.000Z",
      eventTypeSlug: "strategic-review",
      username: "aurixasystems",
      attendee: {
        name: "Jane Citizen",
        email: "jane@example.com",
        timeZone: CALCOM_HOST_TIME_ZONE,
        language: "en",
        phoneNumber: "+61412345678",
      },
      metadata: { source: "stage3_waitlist", applicationId: "AUR-2026-0042" },
      bookingFieldsResponses: {
        notes: "Wants to cover AML onboarding.",
        organisation: "Citizen Property Group",
        "application-reference": "AUR-2026-0042",
      },
    });
  });

  it("leaves the location to the event type", () => {
    const req = buildBookingRequest(input);
    if (!req.ok) throw new Error("unreachable");
    expect(req.body).not.toHaveProperty("location");
  });

  it("sends the application reference only where the event type has the field", () => {
    const kinds: CalcomKind[] = [
      "discovery_session",
      "guided_demo",
      "enterprise_consultation",
      "kickoff",
    ];
    for (const kind of kinds) {
      const req = buildBookingRequest({ ...input, kind });
      if (!req.ok) throw new Error("unreachable");
      const responses = req.body.bookingFieldsResponses as Record<string, unknown>;
      expect(responses).not.toHaveProperty("application-reference");
      expect(req.body.eventTypeSlug).toBe(CALCOM_EVENT_TYPE_SLUGS[kind]);
    }
  });

  it("omits the optional fields rather than sending them empty", () => {
    const req = buildBookingRequest({
      ...input,
      attendee: {
        name: "Jane",
        email: "jane@example.com",
        phone: "n/a",
        timeZone: "Australia/Perth",
      },
      notes: " ",
      organisation: null,
      applicationReference: null,
    });
    if (!req.ok) throw new Error("unreachable");
    expect(req.body).not.toHaveProperty("bookingFieldsResponses");
    const attendee = req.body.attendee as Record<string, unknown>;
    expect(attendee).not.toHaveProperty("phoneNumber");
    expect(attendee.timeZone).toBe("Australia/Perth");
  });

  it("says which input made a booking impossible", () => {
    expect(buildBookingRequest({ ...input, attendee: { ...input.attendee, name: "  " } })).toEqual({
      ok: false,
      reason: "invalid_name",
    });
    expect(
      buildBookingRequest({ ...input, attendee: { ...input.attendee, email: "not an email" } }),
    ).toEqual({ ok: false, reason: "invalid_email" });
    expect(buildBookingRequest({ ...input, start: new Date("nope") })).toEqual({
      ok: false,
      reason: "invalid_start",
    });
  });
});

const LIVE_BOOKING = {
  id: 11223344,
  uid: "bk_7Hq2",
  title: "Aurixa Strategic Review — Jane Citizen",
  status: "accepted",
  start: "2026-09-28T23:00:00.000Z",
  end: "2026-09-28T23:30:00.000Z",
  meetingUrl: "https://app.cal.com/video/bk_7Hq2",
  location: "integrations:daily",
  eventTypeId: 7209268,
  eventType: { id: 7209268, slug: "strategic-review" },
  attendees: [{ name: "Jane Citizen", email: "Jane@Example.com", timeZone: "Australia/Sydney" }],
  metadata: { source: "voice_agent", attempt: 2 },
};

describe("reading a booking", () => {
  it("reads the live shape", () => {
    expect(parseBookingResponse({ status: "success", data: LIVE_BOOKING })).toEqual({
      uid: "bk_7Hq2",
      id: 11223344,
      status: "accepted",
      start: "2026-09-28T23:00:00.000Z",
      end: "2026-09-28T23:30:00.000Z",
      meetingUrl: "https://app.cal.com/video/bk_7Hq2",
      title: "Aurixa Strategic Review — Jane Citizen",
      eventTypeId: 7209268,
      eventTypeSlug: "strategic-review",
      attendeeEmails: ["jane@example.com"],
      // Only string values survive: the mirror is text, and a number here is
      // not something this code wrote.
      metadata: { source: "voice_agent" },
    });
  });

  it("takes the first occurrence of an array answer", () => {
    const booking = parseBookingResponse({ status: "success", data: [LIVE_BOOKING, { uid: "x" }] });
    expect(booking?.uid).toBe("bk_7Hq2");
  });

  it("refuses a booking it cannot identify or place", () => {
    expect(readBooking({ ...LIVE_BOOKING, uid: "" })).toBeNull();
    expect(readBooking({ ...LIVE_BOOKING, start: "soon" })).toBeNull();
    expect(parseBookingResponse({ status: "error", data: LIVE_BOOKING })).toBeNull();
  });

  it("finds the video link wherever the version put it, and only an http one", () => {
    expect(readBooking({ ...LIVE_BOOKING, meetingUrl: undefined })?.meetingUrl).toBeNull();
    expect(
      readBooking({ ...LIVE_BOOKING, meetingUrl: undefined, location: "https://meet.example/x" })
        ?.meetingUrl,
    ).toBe("https://meet.example/x");
    expect(
      readBooking({
        ...LIVE_BOOKING,
        meetingUrl: undefined,
        metadata: { videoCallUrl: "https://app.cal.com/video/y" },
      })?.meetingUrl,
    ).toBe("https://app.cal.com/video/y");
  });

  it("reads the older startTime/endTime spelling and fills a missing end", () => {
    const booking = readBooking({ uid: "u", startTime: "2026-09-28T23:00:00.000Z" });
    expect(booking?.start).toBe("2026-09-28T23:00:00.000Z");
    expect(booking?.end).toBe("2026-09-28T23:30:00.000Z");
    expect(booking?.status).toBe("accepted");
  });

  it("reads a list, and knows a live booking from a dead one", () => {
    const list = parseBookingsListResponse({
      status: "success",
      data: [LIVE_BOOKING, { ...LIVE_BOOKING, uid: "c", status: "CANCELLED" }, { junk: true }],
      pagination: { totalItems: 3 },
    });
    expect(list?.map((b) => b.uid)).toEqual(["bk_7Hq2", "c"]);
    expect(list?.filter(isLiveBooking).map((b) => b.uid)).toEqual(["bk_7Hq2"]);
    expect(
      parseBookingsListResponse({ status: "success", data: { bookings: [LIVE_BOOKING] } })?.length,
    ).toBe(1);
    expect(parseBookingsListResponse({ status: "success", data: {} })).toBeNull();
    expect(parseBookingsListResponse({ status: "error" })).toBeNull();
  });
});

describe("refusals", () => {
  const refusal = (message: string) => ({
    status: "error",
    error: { code: "BadRequestException", message },
  });

  it("reads Cal.com's message however it nested it", () => {
    expect(calcomErrorMessage(refusal("No available users found."))).toBe(
      "No available users found.",
    );
    expect(calcomErrorMessage({ message: "Unauthorized" })).toBe("Unauthorized");
    expect(
      calcomErrorMessage({
        status: "error",
        error: { message: "Bad", details: "start is required" },
      }),
    ).toBe("Bad — start is required");
    expect(calcomErrorMessage("<html>gateway</html>")).toBe("<html>gateway</html>");
    expect(calcomErrorMessage(null)).toBe("");
  });

  it("sorts a refusal by what the caller can do about it", () => {
    expect(classifyCalcomFailure(401, refusal("Invalid API key"))).toBe("auth");
    expect(classifyCalcomFailure(403, null)).toBe("auth");
    expect(classifyCalcomFailure(404, refusal("Event type not found"))).toBe("not_found");
    expect(classifyCalcomFailure(429, null)).toBe("rate_limited");
    expect(classifyCalcomFailure(0, "timed out after 8000 ms")).toBe("unavailable");
    expect(classifyCalcomFailure(503, null)).toBe("unavailable");
  });

  it("reports a taken time as taken, and nothing else as taken", () => {
    for (const message of [
      "User either already has booking at this time or is not available",
      "no_available_users_found_error",
      "booking_time_out_of_bounds_error",
      "Attempting to book a meeting in the past.",
      "Booking does not meet minimum booking notice",
    ]) {
      expect(classifyCalcomFailure(400, refusal(message))).toBe("slot_unavailable");
    }
    // A 4xx this code composed wrongly must never reach a caller as "that time
    // has gone" — they would pick another and hit the same wall.
    expect(classifyCalcomFailure(400, refusal("attendee.email must be an email"))).toBe(
      "invalid_request",
    );
    expect(classifyCalcomFailure(422, null)).toBe("invalid_request");
  });
});

describe("verifyCalcomSignature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ triggerEvent: "BOOKING_CREATED", payload: { uid: "u" } });
  const good = createHmac("sha256", secret).update(body, "utf8").digest("hex");

  it("accepts Cal.com's hex HMAC of the raw body", () => {
    expect(verifyCalcomSignature(body, secret, good)).toBe(true);
    expect(verifyCalcomSignature(body, secret, good.toUpperCase())).toBe(true);
    expect(verifyCalcomSignature(body, secret, `sha256=${good}`)).toBe(true);
  });

  it("refuses anything else without throwing", () => {
    expect(verifyCalcomSignature(body, "other", good)).toBe(false);
    expect(verifyCalcomSignature(`${body} `, secret, good)).toBe(false);
    expect(verifyCalcomSignature(body, secret, "abc")).toBe(false);
    expect(verifyCalcomSignature(body, secret, null)).toBe(false);
    expect(verifyCalcomSignature(body, "", good)).toBe(false);
    expect(verifyCalcomSignature(body, secret, "z".repeat(64))).toBe(false);
  });
});

describe("parseCalcomWebhook", () => {
  const delivery = (triggerEvent: string, payload: Record<string, unknown>) =>
    JSON.stringify({ triggerEvent, createdAt: "2026-09-24T01:00:00.000Z", payload });

  it("reads a reschedule as the new booking replacing the old", () => {
    const event = parseCalcomWebhook(
      delivery("BOOKING_RESCHEDULED", {
        uid: "new_uid",
        rescheduleUid: "old_uid",
        type: "strategic-review",
        startTime: "2026-09-29T09:00:00+10:00",
        endTime: "2026-09-29T09:30:00+10:00",
        attendees: [{ email: "JANE@example.com" }],
        metadata: { source: "stage3_waitlist", applicationId: "AUR-2026-0042" },
      }),
    );
    expect(event).toMatchObject({
      trigger: "BOOKING_RESCHEDULED",
      uid: "new_uid",
      previousUid: "old_uid",
      start: "2026-09-28T23:00:00.000Z",
      end: "2026-09-28T23:30:00.000Z",
      eventTypeSlug: "strategic-review",
      attendeeEmails: ["jane@example.com"],
      metadata: { source: "stage3_waitlist", applicationId: "AUR-2026-0042" },
    });
  });

  it("carries the attendee's name and the time a reschedule moved from", () => {
    const event = parseCalcomWebhook(
      delivery("BOOKING_RESCHEDULED", {
        uid: "n",
        rescheduleUid: "o",
        startTime: "2026-09-30T00:00:00Z",
        rescheduleStartTime: "2026-09-29T00:00:00Z",
        attendees: [{ name: " Jane Citizen ", email: "jane@example.com" }],
      }),
    );
    expect(event?.attendeeName).toBe("Jane Citizen");
    expect(event?.previousStart).toBe("2026-09-29T00:00:00.000Z");
    expect(event?.supersededByReschedule).toBe(false);
  });

  it("knows the cancelled half of a reschedule from a real cancellation", () => {
    expect(
      parseCalcomWebhook(delivery("BOOKING_CANCELLED", { uid: "o", rescheduled: true }))
        ?.supersededByReschedule,
    ).toBe(true);
    expect(
      parseCalcomWebhook(delivery("BOOKING_CANCELLED", { uid: "o" }))?.supersededByReschedule,
    ).toBe(false);
  });

  it("reads the older fromReschedule spelling", () => {
    const event = parseCalcomWebhook(
      delivery("BOOKING_RESCHEDULED", {
        uid: "n",
        fromReschedule: "o",
        startTime: "2026-09-29T00:00:00Z",
      }),
    );
    expect(event?.previousUid).toBe("o");
  });

  it("carries a cancellation's reason and a no-show's mark", () => {
    expect(
      parseCalcomWebhook(delivery("BOOKING_CANCELLED", { uid: "u", cancellationReason: " Clash " }))
        ?.cancellationReason,
    ).toBe("Clash");
    expect(
      parseCalcomWebhook(
        delivery("BOOKING_NO_SHOW_UPDATED", {
          uid: "u",
          attendees: [{ email: "a@b.co", noShow: true }],
        }),
      )?.attendeeNoShow,
    ).toBe(true);
    expect(
      parseCalcomWebhook(delivery("BOOKING_CREATED", { uid: "u" }))?.attendeeNoShow,
    ).toBeNull();
  });

  it("reads the compact no-show payload, which names the booking bookingUid", () => {
    // Cal.com's own example: no full booking, only the marked attendee.
    const event = parseCalcomWebhook(
      delivery("BOOKING_NO_SHOW_UPDATED", {
        message: "test@example.com marked as no-show",
        attendees: [{ email: "test@example.com", noShow: true }],
        bookingUid: "5vQFqxDFMjdgKGMijqtqRw",
        bookingId: 112,
      }),
    );
    expect(event).toMatchObject({
      trigger: "BOOKING_NO_SHOW_UPDATED",
      uid: "5vQFqxDFMjdgKGMijqtqRw",
      attendeeNoShow: true,
      attendeeEmails: ["test@example.com"],
    });
  });

  it("keeps a trigger it does not handle, and refuses what is not a webhook", () => {
    expect(parseCalcomWebhook(delivery("MEETING_ENDED", { uid: "u" }))).toMatchObject({
      trigger: "OTHER",
      rawTrigger: "MEETING_ENDED",
    });
    expect(parseCalcomWebhook("{not json")).toBeNull();
    expect(parseCalcomWebhook(JSON.stringify({ payload: {} }))).toBeNull();
    expect(parseCalcomWebhook(JSON.stringify([1, 2]))).toBeNull();
  });
});

describe("spokenSlot", () => {
  it("says the time as somebody in Sydney would", () => {
    // 2026-09-28T23:00Z is Tuesday 29 September, 9:00 am AEST (DST starts 4 Oct).
    const spoken = spokenSlot(new Date("2026-09-28T23:00:00.000Z"));
    expect(spoken).toContain("Tuesday");
    expect(spoken).toContain("29 September");
    expect(spoken).toContain("9:00");
  });
});

describe("the CRM mirror", () => {
  const booking = readBooking(LIVE_BOOKING)!;

  it("round-trips through a row's metadata", () => {
    const mirror = mirrorFromBooking(booking, "jane@example.com");
    expect(mirror).toEqual({
      uid: "bk_7Hq2",
      id: 11223344,
      eventTypeSlug: "strategic-review",
      status: "accepted",
      meetingUrl: "https://app.cal.com/video/bk_7Hq2",
      attendeeEmail: "jane@example.com",
      previousUids: [],
    });
    expect(readCalcomMirror({ confirmation_email: { status: "sent" }, calcom: mirror })).toEqual(
      mirror,
    );
  });

  it("remembers the uids a reschedule replaced", () => {
    const first = mirrorFromBooking(booking, "jane@example.com");
    const moved = mirrorFromBooking(
      { ...booking, uid: "bk_second", meetingUrl: null, attendeeEmails: [] },
      null,
      first,
    );
    expect(moved.uid).toBe("bk_second");
    expect(moved.previousUids).toEqual(["bk_7Hq2"]);
    // Carried over when the new answer omits them.
    expect(moved.meetingUrl).toBe("https://app.cal.com/video/bk_7Hq2");
    expect(moved.attendeeEmail).toBe("jane@example.com");
  });

  it("reads a row Cal.com knows nothing of as no mirror", () => {
    expect(readCalcomMirror({})).toBeNull();
    expect(readCalcomMirror({ calcom: { uid: "" } })).toBeNull();
    expect(readCalcomMirror(null)).toBeNull();
    expect(readCalcomMirror("text")).toBeNull();
  });
});
