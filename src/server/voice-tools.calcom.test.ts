// The voice fleet's check_availability and book_appointment, end to end over
// the Cal.com calendar: the tool call as VAPI sends it, the reply the agent
// reads back, the Cal.com requests made and the CRM rows written.
//
// Both sides are doubles that EVALUATE (see `testing/bookingFakes.ts`): the
// database applies every filter, and Cal.com refuses a time it no longer has.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calcomFetch,
  createFakeCalcom,
  createFakeDb,
  type FakeCalcom,
  jsonOf,
  type FakeDb,
  type Row,
} from "./testing/bookingFakes";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  scheduled: [] as string[],
  rescheduled: [] as Array<{ id: string; previous: string; via: string }>,
  failConsequences: false,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => h.db.from(table) },
}));

vi.mock("@/server/crm-journey.server", () => ({
  onAppointmentScheduled: async (id: string) => {
    if (h.failConsequences) throw new Error("journey advance failed");
    h.scheduled.push(id);
  },
  onAppointmentRescheduled: async (id: string, previous: string, via: string) => {
    h.rescheduled.push({ id, previous, via });
  },
  onAppointmentChangedInCalendar: async () => {},
}));

import { handleToolCalls } from "./voice-tools.server";

// Tuesday 29 September 2026, 8:00 am in Sydney (UTC+10 until 4 October).
const NOW = "2026-09-28T22:00:00.000Z";
const THU_0900 = "2026-09-30T23:00:00.000Z";
const THU_0930 = "2026-09-30T23:30:00.000Z";
const THU_1000 = "2026-10-01T00:00:00.000Z";
const THU_1300 = "2026-10-01T03:00:00.000Z";
const FRI_0900 = "2026-10-01T23:00:00.000Z";

const CALLER = "+61400111222";

let db: FakeDb;
let cal: FakeCalcom;

function seed(extra: Record<string, Row[]> = {}): void {
  db = createFakeDb({
    voice_call_context: [
      {
        vapi_call_id: "call_1",
        caller_phone: CALLER,
        normalized_phone: CALLER,
        contact_id: "contact_1",
        account_id: "account_1",
        full_name: "Jane Citizen",
        first_name: "Jane",
      },
    ],
    crm_contacts: [
      { id: "contact_1", first_name: "Jane", last_name: "Citizen", email: null, phone: CALLER },
    ],
    crm_client_journeys: [
      { id: "journey_1", contact_id: "contact_1", created_at: "2026-09-01T00:00:00.000Z" },
    ],
    voice_calls: [{ id: "voice_call_row_1", vapi_call_id: "call_1" }],
    crm_appointments: [],
    notifications: [],
    ...extra,
  });
  h.db = db;
}

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    toolCallList: [{ id: "tc_1", function: { name, arguments: JSON.stringify(args) } }],
    call: { id: "call_1", customer: { number: CALLER } },
  };
}

// A tool reply is JSON the agent reads; the assertions index into it freely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Record<string, any>;

async function run(name: string, args: Record<string, unknown>): Promise<Reply> {
  const out = await handleToolCalls(toolCall(name, args));
  expect(out.results).toHaveLength(1);
  expect(out.results[0].toolCallId).toBe("tc_1");
  return JSON.parse(out.results[0].result);
}

const posts = () => cal.requests.filter((r) => r.method === "POST");
const appointments = () => db.tables.crm_appointments ?? [];
const notices = () => db.tables.notifications ?? [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  process.env.CALCOM_API_KEY = "cal_test_key";
  delete process.env.CALCOM_USERNAME;
  delete process.env.CALCOM_API_URL;
  cal = createFakeCalcom({ slots: [THU_0900, THU_0930, THU_1000, THU_1300, FRI_0900] });
  vi.stubGlobal("fetch", calcomFetch(cal));
  h.scheduled = [];
  h.rescheduled = [];
  h.failConsequences = false;
  seed();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CALCOM_API_KEY;
});

describe("get_call_context", () => {
  it("hands a booking specialist the address on file for the invitation", async () => {
    db.tables.crm_contacts[0].email = "Jane@Citizen.com.au";
    const reply = await run("get_call_context", {});
    expect(reply).toMatchObject({
      contextFound: true,
      contactId: "contact_1",
      email: "jane@citizen.com.au",
    });
  });

  it("says null rather than guessing when there is none, or it cannot be read", async () => {
    expect((await run("get_call_context", {})).email).toBeNull();
    db.failReads.add("crm_contacts");
    const reply = await run("get_call_context", {});
    expect(reply).toMatchObject({ contextFound: true, email: null });
  });
});

describe("check_availability on Cal.com", () => {
  it("offers Cal.com's times, less the CRM bookings Cal.com cannot see", async () => {
    seed({
      crm_appointments: [
        // Booked by hand in the tracker: Cal.com has never heard of it.
        { id: "manual", status: "scheduled", starts_at: THU_0930, ends_at: THU_1000, metadata: {} },
        // A mirror of a Cal.com booking: Cal.com already answers for it.
        {
          id: "mirror",
          status: "scheduled",
          starts_at: THU_1300,
          ends_at: "2026-10-01T03:30:00.000Z",
          metadata: { calcom: { uid: "bk_elsewhere" } },
        },
        // Cancelled: blocks nothing.
        { id: "gone", status: "canceled", starts_at: THU_1000, ends_at: null, metadata: {} },
      ],
    });
    const reply = await run("check_availability", { booking_intent_text: "my strategic review" });

    expect(reply.success).toBe(true);
    expect(reply.calendar).toBe("calcom");
    expect(reply.kind).toBe("strategic_review");
    expect(reply.availability.map((s: { startIso: string }) => s.startIso)).toEqual([
      THU_0900,
      THU_1000,
      THU_1300,
      FRI_0900,
    ]);
    expect(reply.availability[0].spoken).toMatch(/Thursday 1 October.*9:00/);

    const [slots] = cal.requests;
    expect(slots.path).toBe("/slots");
    expect(slots.version).toBe("2024-09-04");
    expect(slots.query).toMatchObject({
      eventTypeSlug: "strategic-review",
      username: "aurixasystems",
      start: NOW,
      format: "range",
    });
  });

  it("asks the event type of the session the caller wants", async () => {
    await run("check_availability", { booking_intent_text: "a guided demonstration" });
    expect(cal.requests[0].query.eventTypeSlug).toBe("guided-demonstration");
  });

  it("puts the caller's stated preference first without dropping the rest", async () => {
    const reply = await run("check_availability", {
      booking_intent_text: "strategic review",
      preferred_date_text: "Friday morning",
    });
    expect(reply.preference_understood).toBe(true);
    expect(reply.preference_met).toBe(true);
    expect(reply.availability[0].startIso).toBe(FRI_0900);
    expect(reply.availability).toHaveLength(5);
  });

  it("names no time when Cal.com cannot be read, and pages nobody for an outage", async () => {
    cal.answers.slots = { status: 503, body: "upstream unavailable" };
    const reply = await run("check_availability", { booking_intent_text: "strategic review" });
    expect(reply).toMatchObject({
      success: false,
      calendar_unavailable: true,
      fault: "unreachable",
      availability: [],
    });
    expect(reply.message).toMatch(/NO times are known/);
    expect(notices()).toHaveLength(0);
  });

  it("raises a notice when Cal.com refuses the key — that does not clear itself", async () => {
    cal.answers.slots = {
      status: 401,
      body: { status: "error", error: { message: "Invalid API key" } },
    };
    const reply = await run("check_availability", { booking_intent_text: "strategic review" });
    expect(reply).toMatchObject({
      success: false,
      calendar_unavailable: true,
      fault: "misconfigured",
    });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ kind: "calendar_booking_failed", severity: "error" });
    expect(String(notices()[0].title)).toMatch(/could not be read/);
  });

  it("says the window is empty, rather than inventing a time, when nothing is free", async () => {
    cal.slots = [];
    const reply = await run("check_availability", { booking_intent_text: "strategic review" });
    expect(reply.success).toBe(true);
    expect(reply.availability).toEqual([]);
    expect(reply.message).toMatch(/Nothing is free/);
  });
});

describe("book_appointment on Cal.com", () => {
  const book = (args: Record<string, unknown> = {}) =>
    run("book_appointment", {
      booking_intent_text: "strategic review",
      startTime: THU_0900,
      email: "Jane@Citizen.com.au",
      ...args,
    });

  it("asks for an email before touching the calendar when none is known", async () => {
    const reply = await run("book_appointment", {
      booking_intent_text: "strategic review",
      startTime: THU_0900,
    });
    expect(reply).toMatchObject({ success: false, appointment_created: false, needs_email: true });
    expect(posts()).toHaveLength(0);
    expect(appointments()).toHaveLength(0);
  });

  it("books in Cal.com, mirrors it in the CRM and runs the booking's consequences", async () => {
    const reply = await book({ timezone: "Australia/Perth", notes: "Wants to cover AML" });

    expect(reply).toMatchObject({
      success: true,
      appointment_created: true,
      already_confirmed: false,
      calendar: "calcom",
      booking_type: "Strategic Review",
      startTime: THU_0900,
      invite_email: "jane@citizen.com.au",
    });
    expect(reply.message).toMatch(/with the video link/);

    const [create] = posts();
    expect(create.path).toBe("/bookings");
    expect(create.version).toBe("2026-02-25");
    expect(create.body).toMatchObject({
      start: THU_0900,
      eventTypeSlug: "strategic-review",
      username: "aurixasystems",
      attendee: { name: "Jane Citizen", email: "jane@citizen.com.au", timeZone: "Australia/Perth" },
      bookingFieldsResponses: { notes: "Wants to cover AML" },
      metadata: {
        source: "voice_agent",
        kind: "strategic_review",
        contactId: "contact_1",
        vapiCallId: "call_1",
      },
    });

    expect(appointments()).toHaveLength(1);
    const row = appointments()[0];
    expect(row).toMatchObject({
      account_id: "account_1",
      contact_id: "contact_1",
      journey_id: "journey_1",
      booked_by_call_id: "voice_call_row_1",
      kind: "strategic_review",
      status: "scheduled",
      source: "voice_agent",
      starts_at: THU_0900,
    });
    expect(jsonOf(row.metadata).calcom).toMatchObject({
      uid: reply.booking_uid,
      meetingUrl: `https://app.cal.com/video/${reply.booking_uid}`,
      attendeeEmail: "jane@citizen.com.au",
      previousUids: [],
    });
    expect(reply.appointmentId).toBe(row.id);
    expect(h.scheduled).toEqual([row.id]);

    // The spoken address fills the blank on the contact — and only a blank.
    expect(db.tables.crm_contacts[0].email).toBe("jane@citizen.com.au");
    expect(cal.bookings.filter((b) => b.status === "accepted")).toHaveLength(1);
  });

  it("never overwrites the address on file with one heard over the phone", async () => {
    db.tables.crm_contacts[0].email = "jane@onfile.com.au";
    const reply = await book({ email: "jayne@citizen.com.au" });
    expect(reply.invite_email).toBe("jayne@citizen.com.au");
    expect(db.tables.crm_contacts[0].email).toBe("jane@onfile.com.au");
  });

  it("uses the address on file when the caller gives none", async () => {
    db.tables.crm_contacts[0].email = "jane@onfile.com.au";
    const reply = await run("book_appointment", {
      booking_intent_text: "strategic review",
      startTime: THU_0900,
    });
    expect(reply).toMatchObject({ success: true, invite_email: "jane@onfile.com.au" });
  });

  it("offers the nearest free times when the slot was taken in the meantime", async () => {
    cal.bookings.push({
      uid: "bk_someone",
      id: 1,
      status: "accepted",
      start: THU_0900,
      end: THU_0930,
      meetingUrl: "https://app.cal.com/video/bk_someone",
      eventType: { id: 1, slug: "strategic-review" },
      attendees: [{ name: "Someone", email: "someone@else.com", timeZone: "Australia/Sydney" }],
      metadata: {},
    });
    cal.slots = cal.slots.filter((s) => s !== THU_0900);

    const reply = await book();
    expect(reply).toMatchObject({ success: false, appointment_created: false, slot_taken: true });
    expect(reply.message).toMatch(/nothing was booked/);
    expect(reply.alternatives.map((s: { startIso: string }) => s.startIso)).toEqual([
      THU_0930,
      THU_1000,
      THU_1300,
    ]);
    expect(appointments()).toHaveLength(0);
    expect(notices()).toHaveLength(0);
  });

  it("reports a booking whose answer was lost as booked, exactly once", async () => {
    cal.answers.create = "timeout";
    cal.timeoutStillBooks = true;

    const reply = await book();
    expect(reply).toMatchObject({
      success: true,
      appointment_created: true,
      already_confirmed: true,
    });
    expect(appointments()).toHaveLength(1);
    expect(cal.bookings.filter((b) => b.status === "accepted")).toHaveLength(1);
    // The held-booking read, the create whose answer was lost, and the read
    // that found what the create had done.
    expect(cal.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /bookings",
      "POST /bookings",
      "GET /bookings",
    ]);
  });

  it("says plainly that nothing was booked when Cal.com does not answer, and alerts the team", async () => {
    cal.answers.create = { status: 502, body: "bad gateway" };

    const reply = await book();
    expect(reply).toMatchObject({
      success: false,
      appointment_created: false,
      calendar_unavailable: true,
      operators_alerted: true,
    });
    expect(reply.message).toMatch(/NOT made/);
    expect(appointments()).toHaveLength(0);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({ kind: "calendar_booking_failed", severity: "warning" });
    expect(String(notices()[0].title)).toMatch(/Booking NOT made: Jane Citizen/);
  });

  it("does not promise a call back the team was never told about", async () => {
    cal.answers.create = { status: 502, body: "bad gateway" };
    db.failWrites.add("notifications");
    const reply = await book();
    expect(reply.operators_alerted).toBe(false);
    expect(reply.message).not.toMatch(/has been alerted/);
  });

  it("treats a refused key as a fault of ours, without a recovery read", async () => {
    cal.answers.create = {
      status: 403,
      body: { status: "error", error: { message: "Forbidden" } },
    };
    const reply = await book();
    expect(reply).toMatchObject({ success: false, calendar_unavailable: true });
    expect(cal.requests.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(notices()[0]).toMatchObject({ severity: "error" });
  });

  it("answers a retried call for the time already held as booked, without booking again", async () => {
    const first = await book();
    const second = await book();
    expect(second).toMatchObject({
      success: true,
      appointment_created: true,
      already_confirmed: true,
      booking_uid: first.booking_uid,
      appointmentId: first.appointmentId,
    });
    expect(posts()).toHaveLength(1);
    expect(appointments()).toHaveLength(1);
  });

  it("will not book the same session twice — it asks whether to move it", async () => {
    await book();
    const reply = await book({ startTime: FRI_0900 });
    expect(reply).toMatchObject({
      success: false,
      appointment_created: false,
      already_booked: true,
    });
    expect(reply.existing_booking.startIso).toBe(THU_0900);
    expect(reply.message).toMatch(/reschedule_existing/);
    expect(posts()).toHaveLength(1);
  });

  it("moves the booking when asked, and moves the CRM row and its reminders with it", async () => {
    const first = await book();
    const reply = await book({ startTime: FRI_0900, reschedule_existing: "true" });

    expect(reply).toMatchObject({
      success: true,
      appointment_rescheduled: true,
      appointmentId: first.appointmentId,
      startTime: FRI_0900,
    });
    expect(reply.booking_uid).not.toBe(first.booking_uid);
    expect(reply.previous_spoken).toMatch(/Thursday 1 October/);

    const move = posts()[1];
    expect(move.path).toBe(`/bookings/${first.booking_uid}/reschedule`);

    expect(appointments()).toHaveLength(1);
    const row = appointments()[0];
    expect(row.starts_at).toBe(FRI_0900);
    expect(jsonOf(row.metadata).calcom).toMatchObject({
      uid: reply.booking_uid,
      previousUids: [first.booking_uid],
    });
    expect(h.rescheduled).toEqual([
      { id: first.appointmentId, previous: THU_0900, via: "voice_agent" },
    ]);
  });

  it("keeps the existing booking and says so when the new time is taken", async () => {
    await book();
    cal.slots = cal.slots.filter((s) => s !== FRI_0900);
    const reply = await book({ startTime: FRI_0900, reschedule_existing: true });
    expect(reply).toMatchObject({ success: false, slot_taken: true });
    expect(reply.message).toMatch(/has NOT changed/);
    expect(appointments()[0].starts_at).toBe(THU_0900);
    expect(h.rescheduled).toEqual([]);
  });

  it("does not report a booking that succeeded as a failure when its consequences throw", async () => {
    h.failConsequences = true;
    const reply = await book();
    expect(reply).toMatchObject({ success: true, appointment_created: true });
    expect(appointments()).toHaveLength(1);
  });

  it("still tells the caller they are booked when only the CRM record fails", async () => {
    db.failWrites.add("crm_appointments");
    const reply = await book();
    expect(reply).toMatchObject({ success: true, appointment_created: true, appointmentId: null });
    expect(notices()).toHaveLength(1);
    expect(String(notices()[0].title)).toMatch(/booked in Cal\.com but not in the CRM/);
  });

  it("asks for resolve_contact first when the caller is not yet a contact", async () => {
    db.tables.voice_call_context = [];
    const reply = await book();
    expect(reply).toMatchObject({ success: false, appointment_created: false });
    expect(reply.message).toMatch(/resolve_contact/);
    expect(cal.requests).toHaveLength(0);
  });
});

describe("a session booked outside the voice path", () => {
  // Booked on the Stage 3 page: Cal.com holds it, the CRM never has.
  const stageThree = (email = "jane@citizen.com.au") => {
    cal.slots = cal.slots.filter((s) => s !== THU_0900);
    cal.bookings.push({
      uid: "bk_stage3",
      id: 42,
      status: "accepted",
      start: THU_0900,
      end: THU_0930,
      meetingUrl: "https://app.cal.com/video/bk_stage3",
      eventType: { id: 7209268, slug: "strategic-review" },
      attendees: [{ name: "Jane Citizen", email, timeZone: "Australia/Sydney" }],
      metadata: { source: "stage3_waitlist", applicationId: "AX-7Q2M4L9XZ1" },
    });
  };
  const book = (args: Record<string, unknown> = {}) =>
    run("book_appointment", {
      booking_intent_text: "strategic review",
      startTime: FRI_0900,
      email: "jane@citizen.com.au",
      ...args,
    });

  it("is not booked a second time — the caller is asked whether to move it", async () => {
    stageThree();
    const reply = await book();
    expect(reply).toMatchObject({
      success: false,
      appointment_created: false,
      already_booked: true,
    });
    expect(reply.existing_booking.startIso).toBe(THU_0900);
    expect(posts()).toHaveLength(0);
    expect(appointments()).toHaveLength(0);
  });

  it("is found under the address on file when the caller gives another", async () => {
    stageThree("jane@onfile.com.au");
    db.tables.crm_contacts[0].email = "jane@onfile.com.au";
    const reply = await book({ email: "jane.personal@example.com" });
    expect(reply).toMatchObject({ already_booked: true });
    expect(
      cal.requests
        .filter((r) => r.method === "GET")
        .map((r) => r.query.attendeeEmail)
        .sort(),
    ).toEqual(["jane.personal@example.com", "jane@onfile.com.au"]);
  });

  it("is confirmed as booked when the caller asks for the time they hold", async () => {
    stageThree();
    const reply = await book({ startTime: THU_0900 });
    expect(reply).toMatchObject({
      success: true,
      appointment_created: true,
      already_confirmed: true,
      booking_uid: "bk_stage3",
      appointmentId: null,
      invite_email: "jane@citizen.com.au",
    });
    expect(reply.message).toMatch(/already booked for them/);
    expect(posts()).toHaveLength(0);
  });

  it("is moved in Cal.com when asked, and left out of the CRM as it was", async () => {
    stageThree();
    const reply = await book({ reschedule_existing: true });
    expect(reply).toMatchObject({
      success: true,
      appointment_rescheduled: true,
      appointmentId: null,
      startTime: FRI_0900,
    });
    expect(reply.previous_spoken).toMatch(/Thursday 1 October/);
    expect(posts().map((r) => r.path)).toEqual(["/bookings/bk_stage3/reschedule"]);
    expect(appointments()).toHaveLength(0);
    expect(h.rescheduled).toEqual([]);
    expect(cal.bookings.filter((b) => b.status === "accepted").map((b) => b.start)).toEqual([
      FRI_0900,
    ]);
  });

  it("is kept, and the caller told so, when the move cannot be made", async () => {
    stageThree();
    cal.answers.reschedule = { status: 500, body: "internal error" };
    const reply = await book({ reschedule_existing: true });
    expect(reply).toMatchObject({
      success: false,
      calendar_unavailable: true,
      operators_alerted: true,
    });
    expect(reply.message).toMatch(/still stands/);
    expect(String(notices()[0].body)).toMatch(/They asked to move their/);
  });

  it("does not stop a booking when the calendar cannot be asked about it", async () => {
    cal.answers.list = { status: 503, body: "unavailable" };
    const reply = await book();
    expect(reply).toMatchObject({ success: true, appointment_created: true });
  });
});

describe("without CALCOM_API_KEY", () => {
  it("keeps the local calendar, so deploying ahead of the key changes nothing", async () => {
    delete process.env.CALCOM_API_KEY;
    const availability = await run("check_availability", {
      booking_intent_text: "strategic review",
    });
    expect(availability).toMatchObject({ success: true, calendar: "local" });
    expect(availability.availability.length).toBeGreaterThan(0);

    const slot = availability.availability[3].startIso;
    const reply = await run("book_appointment", {
      booking_intent_text: "strategic review",
      startTime: slot,
    });
    expect(reply).toMatchObject({ success: true, appointment_created: true, calendar: "local" });
    expect(cal.requests).toHaveLength(0);
    expect(appointments()).toHaveLength(1);
  });

  it("can book a slot past the first page of the window", async () => {
    // The local path used to check a booking against only the first 200
    // candidate slots, so any time more than about a fortnight out was
    // refused as "taken" though it had just been offered.
    delete process.env.CALCOM_API_KEY;
    const late = "2026-11-06T02:00:00.000Z"; // Friday 6 November, 1:00 pm Sydney.
    const reply = await run("book_appointment", {
      booking_intent_text: "strategic review",
      startTime: late,
    });
    expect(reply).toMatchObject({ success: true, appointment_created: true });
  });
});
