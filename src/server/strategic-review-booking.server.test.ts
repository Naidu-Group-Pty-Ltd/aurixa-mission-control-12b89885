// The Stage 3 scheduler's server half, end to end: the access re-check against
// the live gate's two Airtable tables (and the mirror when Airtable cannot be
// asked), the booking in Cal.com, the move, and every refusal the page is
// built to tell apart.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  calcomFetch,
  createFakeCalcom,
  createFakeDb,
  type FakeCalcom,
  type FakeDb,
} from "./testing/bookingFakes";

type AirtableRow = { id: string; createdTime: string; fields: Record<string, unknown> };

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  airtable: {
    waitlist: [] as AirtableRow[],
    readiness: [] as AirtableRow[],
    fail: false,
    formulas: [] as string[],
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => h.db.from(table) },
}));

// Airtable, answering the gate's two formulas the way Airtable would — by the
// reference quoted in them — rather than handing back whatever is seeded.
vi.mock("@/server/airtable-sync.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/airtable-sync.server")>()),
  queryAirtableTable: async (table: string, query: { filterByFormula: string }) => {
    h.airtable.formulas.push(query.filterByFormula);
    if (h.airtable.fail) throw new Error("Airtable gateway timed out");
    const reference = /'([^']*)'/.exec(query.filterByFormula)?.[1] ?? "";
    if (table === "tblHzGiB591W3GpoZ") {
      return h.airtable.waitlist.filter(
        (r) =>
          r.fields["Application ID Key"] === reference &&
          r.fields["Stage 3 Access (Application)"] === "GRANT",
      );
    }
    if (table === "tblB1t18q6aUTNI0g") {
      return h.airtable.readiness.filter(
        (r) =>
          String(r.fields["Application ID"] ?? "")
            .trim()
            .toUpperCase() === reference,
      );
    }
    throw new Error(`unexpected table ${table}`);
  },
}));

import { bookStrategicReview, strategicReviewSlots } from "./strategic-review-booking.server";

const NOW = new Date("2026-09-28T22:00:00.000Z");
const THU_0900 = "2026-09-30T23:00:00.000Z";
const THU_0930 = "2026-09-30T23:30:00.000Z";
const THU_1000 = "2026-10-01T00:00:00.000Z";
const FRI_0900 = "2026-10-01T23:00:00.000Z";

const REF = "AX-7Q2M4L9XZ1";

const WAITLIST: AirtableRow = {
  id: "recWaitlist",
  createdTime: "2026-09-01T00:00:00.000Z",
  fields: {
    "Application ID Key": REF,
    "Stage 3 Access (Application)": "GRANT",
    "First Name": "Jane",
    "Last Name": "Citizen",
    "Corporate Email": "Jane@Citizen.com.au",
    "Entity Name": "Citizen Property Group",
  },
};
const READINESS: AirtableRow = {
  id: "recReadiness",
  createdTime: "2026-09-02T00:00:00.000Z",
  fields: { "Application ID": ` ${REF.toLowerCase()} ` },
};

let db: FakeDb;
let cal: FakeCalcom;

const posts = () => cal.requests.filter((r) => r.method === "POST");
const notices = () => db.tables.notifications ?? [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  process.env.CALCOM_API_KEY = "cal_test_key";
  cal = createFakeCalcom({ slots: [THU_0900, THU_0930, THU_1000, FRI_0900] });
  vi.stubGlobal("fetch", calcomFetch(cal));
  db = createFakeDb({ waitlist_leads: [], notifications: [], crm_appointments: [] });
  h.db = db;
  h.airtable.waitlist = [WAITLIST];
  h.airtable.readiness = [READINESS];
  h.airtable.fail = false;
  h.airtable.formulas = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CALCOM_API_KEY;
});

const book = (over: Partial<Parameters<typeof bookStrategicReview>[0]> = {}) =>
  bookStrategicReview({
    applicationId: "ax 7q2m4l9xz1",
    start: new Date(THU_0900),
    timeZone: "Australia/Brisbane",
    ...over,
  });

describe("the free review times", () => {
  it("are Cal.com's, less the CRM bookings Cal.com cannot see", async () => {
    db.tables.crm_appointments = [
      { id: "manual", status: "confirmed", starts_at: THU_0930, ends_at: null, metadata: {} },
    ];
    const result = await strategicReviewSlots(NOW);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      provider: "calcom",
      timeZone: "Australia/Sydney",
      durationMinutes: 30,
      generatedAt: NOW.toISOString(),
    });
    expect(result.body.slots).toEqual([
      { start: THU_0900, end: THU_0930 },
      { start: THU_1000, end: "2026-10-01T00:30:00.000Z" },
      { start: FRI_0900, end: "2026-10-01T23:30:00.000Z" },
    ]);
    expect(cal.requests[0].query.eventTypeSlug).toBe("strategic-review");
  });

  it("say the deployment has no calendar when there is no key, so the page falls back", async () => {
    delete process.env.CALCOM_API_KEY;
    expect(await strategicReviewSlots(NOW)).toEqual({
      status: 503,
      body: { ok: false, reason: "not_configured" },
    });
    expect(cal.requests).toHaveLength(0);
  });

  it("say the calendar is unavailable, and page nobody, when Cal.com is down", async () => {
    cal.answers.slots = { status: 500, body: "internal error" };
    const result = await strategicReviewSlots(NOW);
    expect(result).toEqual({
      status: 503,
      body: { ok: false, reason: "calendar_unavailable", fault: "unreachable" },
    });
    expect(notices()).toHaveLength(0);
  });
});

describe("who may book", () => {
  it("re-checks the live gate's two tables for the cleaned reference", async () => {
    const result = await book();
    expect(result.status).toBe(200);
    expect(h.airtable.formulas).toEqual([
      `AND({Application ID Key} = '${REF}', {Stage 3 Access (Application)} = 'GRANT')`,
      `UPPER(TRIM({Application ID})) = '${REF}'`,
    ]);
  });

  it("refuses a reference that cannot be one, before asking anybody", async () => {
    const result = await book({ applicationId: "hello" });
    expect(result).toEqual({ status: 400, body: { ok: false, reason: "invalid_reference" } });
    expect(h.airtable.formulas).toHaveLength(0);
    expect(cal.requests).toHaveLength(0);
  });

  it("refuses an applicant the gate has not granted, and books nothing", async () => {
    h.airtable.waitlist = [
      { ...WAITLIST, fields: { ...WAITLIST.fields, "Stage 3 Access (Application)": "HOLD" } },
    ];
    const result = await book();
    expect(result).toEqual({ status: 403, body: { ok: false, reason: "access_denied" } });
    expect(cal.requests).toHaveLength(0);
  });

  it("refuses an applicant with no readiness record, as the gate does", async () => {
    h.airtable.readiness = [];
    expect((await book()).status).toBe(403);
  });

  it("never lets the mirror overrule an Airtable refusal", async () => {
    h.airtable.readiness = [];
    db.tables.waitlist_leads = [
      {
        application_id: REF,
        first_name: "Jane",
        last_name: "Citizen",
        email: "jane@citizen.com.au",
        entity_name: null,
        stage3_access_state: "GRANT",
        stage2_completed_at: "2026-09-02T00:00:00.000Z",
        stage2_airtable_record_id: null,
      },
    ];
    expect((await book()).status).toBe(403);
  });

  it("reads the mirror when Airtable cannot be asked, and says so to Cal.com", async () => {
    h.airtable.fail = true;
    db.tables.waitlist_leads = [
      {
        application_id: REF,
        first_name: "Jane",
        last_name: "Citizen",
        email: "jane@citizen.com.au",
        entity_name: "Citizen Property Group",
        stage3_access_state: "GRANT",
        stage2_completed_at: "2026-09-02T00:00:00.000Z",
        stage2_airtable_record_id: null,
      },
    ];
    const result = await book();
    expect(result.status).toBe(200);
    expect(posts()[0].body).toMatchObject({ metadata: { accessVerifiedBy: "mirror" } });
  });

  it("says access could not be checked — never that it was refused — when neither can be read", async () => {
    h.airtable.fail = true;
    db.failReads.add("waitlist_leads");
    expect(await book()).toEqual({
      status: 503,
      body: { ok: false, reason: "access_unverifiable" },
    });
    expect(cal.requests).toHaveLength(0);
  });
});

describe("booking a review", () => {
  it("books it in Cal.com with the applicant's reference, and hands the page the booking", async () => {
    const result = await book({ phone: "0400 111 222", notes: "Two funds, one trust" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, status: "booked" });
    const booking = result.body.booking as Record<string, string>;
    expect(booking).toEqual({
      uid: expect.stringMatching(/^bk_/),
      start: THU_0900,
      end: THU_0930,
      meetingUrl: `https://app.cal.com/video/${booking.uid}`,
    });

    const [create] = posts();
    expect(create.body).toMatchObject({
      start: THU_0900,
      eventTypeSlug: "strategic-review",
      attendee: {
        name: "Jane Citizen",
        email: "jane@citizen.com.au",
        timeZone: "Australia/Brisbane",
        phoneNumber: "+61400111222",
      },
      bookingFieldsResponses: {
        "application-reference": REF,
        organisation: "Citizen Property Group",
        notes: "Two funds, one trust",
      },
      metadata: {
        source: "stage3_waitlist",
        kind: "strategic_review",
        applicationId: REF,
        accessVerifiedBy: "airtable",
      },
    });
    expect(notices()).toHaveLength(0);
  });

  it("sends the invitation where the applicant asked, and uses the name they gave", async () => {
    await book({
      email: "jane.personal@example.com",
      name: "  Dr   Jane Citizen ",
      organisation: "Citizen Holdings",
    });
    expect(posts()[0].body).toMatchObject({
      attendee: { name: "Dr Jane Citizen", email: "jane.personal@example.com" },
      bookingFieldsResponses: { organisation: "Citizen Holdings" },
    });
  });

  it("refuses a time Cal.com no longer has, and pages nobody — that is not a fault", async () => {
    cal.slots = cal.slots.filter((s) => s !== THU_0900);
    expect(await book()).toEqual({ status: 409, body: { ok: false, reason: "slot_unavailable" } });
    expect(notices()).toHaveLength(0);
  });

  it("does not say booked when Cal.com does not answer, and tells the team", async () => {
    cal.answers.create = { status: 503, body: "unavailable" };
    expect(await book()).toEqual({
      status: 503,
      body: { ok: false, reason: "calendar_unavailable" },
    });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      kind: "calendar_booking_failed",
      severity: "warning",
      url: "/leads",
    });
    expect(String(notices()[0].title)).toContain(
      `Strategic review NOT booked: Jane Citizen (${REF})`,
    );
  });

  it("marks a refused key as a configuration fault", async () => {
    cal.answers.create = {
      status: 401,
      body: { status: "error", error: { message: "Invalid API key" } },
    };
    await book();
    expect(notices()[0]).toMatchObject({ severity: "error" });
    expect(String(notices()[0].body)).toMatch(/Every Stage 3 booking will fail/);
  });

  it("reports a booking whose answer was lost as the booking it is", async () => {
    cal.answers.create = "timeout";
    cal.timeoutStillBooks = true;
    const result = await book();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      status: "already_booked",
      booking: { start: THU_0900 },
    });
    expect(cal.bookings.filter((b) => b.status === "accepted")).toHaveLength(1);
    expect(notices()).toHaveLength(0);
  });

  it("books anyway when the existing-booking read fails — Cal.com still refuses a clash", async () => {
    cal.answers.list = { status: 500, body: "internal error" };
    const result = await book();
    expect(result.body).toMatchObject({ ok: true, status: "booked" });
  });
});

describe("an applicant who already holds a review", () => {
  it("is told it is booked when they ask for the same time again", async () => {
    const first = await book();
    const second = await book();
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, status: "already_booked" });
    expect((second.body.booking as { uid: string }).uid).toBe(
      (first.body.booking as { uid: string }).uid,
    );
    expect(posts()).toHaveLength(1);
  });

  it("is asked before a second time replaces the first", async () => {
    await book();
    const result = await book({ start: new Date(FRI_0900) });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      ok: false,
      reason: "already_booked",
      existing: { start: THU_0900 },
    });
    expect(posts()).toHaveLength(1);
  });

  it("counts a review the voice agent booked under their address", async () => {
    cal.bookings.push({
      uid: "bk_voice",
      id: 7,
      status: "accepted",
      start: THU_1000,
      end: "2026-10-01T00:30:00.000Z",
      meetingUrl: "https://app.cal.com/video/bk_voice",
      eventType: { id: 7209268, slug: "strategic-review" },
      attendees: [
        { name: "Jane Citizen", email: "jane@citizen.com.au", timeZone: "Australia/Sydney" },
      ],
      metadata: { source: "voice_agent", kind: "strategic_review" },
    });
    const result = await book({ email: "jane.personal@example.com" });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ reason: "already_booked", existing: { uid: "bk_voice" } });
  });

  it("moves it when asked", async () => {
    const first = await book();
    const result = await book({ start: new Date(FRI_0900), rescheduleExisting: true });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      status: "rescheduled",
      booking: { start: FRI_0900 },
      previous: { start: THU_0900, uid: (first.body.booking as { uid: string }).uid },
    });
    expect(posts()[1].path).toBe(
      `/bookings/${(first.body.booking as { uid: string }).uid}/reschedule`,
    );
    expect(cal.bookings.filter((b) => b.status === "accepted").map((b) => b.start)).toEqual([
      FRI_0900,
    ]);
  });

  it("keeps it, and says so, when the new time is taken", async () => {
    await book();
    cal.slots = cal.slots.filter((s) => s !== FRI_0900);
    const result = await book({ start: new Date(FRI_0900), rescheduleExisting: true });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      reason: "slot_unavailable",
      existing: { start: THU_0900 },
    });
  });

  it("keeps it, and tells the team, when the move cannot be made", async () => {
    await book();
    cal.answers.reschedule = { status: 502, body: "bad gateway" };
    const result = await book({ start: new Date(FRI_0900), rescheduleExisting: true });
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({
      reason: "calendar_unavailable",
      existing: { start: THU_0900 },
    });
    expect(String(notices()[0].body)).toMatch(/They were moving their review from/);
  });
});

describe("without CALCOM_API_KEY", () => {
  it("books nothing and says the calendar is not configured", async () => {
    delete process.env.CALCOM_API_KEY;
    expect(await book()).toEqual({ status: 503, body: { ok: false, reason: "not_configured" } });
    expect(h.airtable.formulas).toHaveLength(0);
  });
});
