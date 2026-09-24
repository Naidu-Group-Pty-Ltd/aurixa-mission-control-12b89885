// Changes made in Cal.com, carried back to Mission Control: a signed delivery
// in, the CRM row and the operators' notices out. Every write is a
// compare-and-set, so a change Mission Control made itself and Cal.com then
// reports is applied — and its consequences run — exactly once.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, jsonOf, type FakeDb, type Row } from "./testing/bookingFakes";

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  changed: [] as Array<{ id: string; status: string; reason?: string | null }>,
  rescheduled: [] as Array<{ id: string; previous: string; via: string }>,
  failConsequences: false,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: (table: string) => h.db.from(table) },
}));

vi.mock("@/server/crm-journey.server", () => ({
  onAppointmentScheduled: async () => {},
  onAppointmentRescheduled: async (id: string, previous: string, via: string) => {
    if (h.failConsequences) throw new Error("requeue failed");
    h.rescheduled.push({ id, previous, via });
  },
  onAppointmentChangedInCalendar: async (
    id: string,
    change: { status: string; reason?: string | null },
  ) => {
    if (h.failConsequences) throw new Error("status change failed");
    h.changed.push({ id, ...change });
  },
}));

import { handleCalcomWebhook } from "./calcom-webhook.server";

const SECRET = "whsec_test";
const THU_0900 = "2026-09-30T23:00:00.000Z";
const THU_0930 = "2026-09-30T23:30:00.000Z";
const FRI_0900 = "2026-10-01T23:00:00.000Z";
const FRI_0930 = "2026-10-01T23:30:00.000Z";

let db: FakeDb;

const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("hex");

function delivery(triggerEvent: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ triggerEvent, createdAt: "2026-09-29T01:00:00.000Z", payload });
}

async function deliver(triggerEvent: string, payload: Record<string, unknown>) {
  const body = delivery(triggerEvent, payload);
  return handleCalcomWebhook(body, sign(body));
}

function mirroredRow(over: Row = {}): Row {
  return {
    id: "appt_1",
    status: "scheduled",
    starts_at: THU_0900,
    ends_at: THU_0930,
    contact_id: "contact_1",
    metadata: {
      calcom: {
        uid: "bk_1",
        id: 1001,
        eventTypeSlug: "strategic-review",
        status: "accepted",
        meetingUrl: "https://app.cal.com/video/bk_1",
        attendeeEmail: "jane@citizen.com.au",
        previousUids: [],
      },
    },
    ...over,
  };
}

const row = () => db.tables.crm_appointments[0];
const notices = () => db.tables.notifications ?? [];

beforeEach(() => {
  process.env.CALCOM_WEBHOOK_SECRET = SECRET;
  db = createFakeDb({ crm_appointments: [mirroredRow()], notifications: [] });
  h.db = db;
  h.changed = [];
  h.rescheduled = [];
  h.failConsequences = false;
});

afterEach(() => {
  delete process.env.CALCOM_WEBHOOK_SECRET;
});

describe("the receiver", () => {
  it("refuses every delivery until a secret is configured — never an open door", async () => {
    delete process.env.CALCOM_WEBHOOK_SECRET;
    const body = delivery("BOOKING_CANCELLED", { uid: "bk_1" });
    expect(await handleCalcomWebhook(body, sign(body))).toEqual({
      status: 503,
      body: { ok: false, error: "webhook_not_configured" },
    });
    expect(row().status).toBe("scheduled");
  });

  it("refuses a forged or unsigned delivery", async () => {
    const body = delivery("BOOKING_CANCELLED", { uid: "bk_1" });
    expect((await handleCalcomWebhook(body, sign(body, "not_the_secret"))).status).toBe(401);
    expect((await handleCalcomWebhook(body, null)).status).toBe(401);
    expect((await handleCalcomWebhook(body, "zz")).status).toBe(401);
    expect(row().status).toBe("scheduled");
  });

  it("refuses a signed body that is not a delivery", async () => {
    const body = JSON.stringify({ hello: "world" });
    expect((await handleCalcomWebhook(body, sign(body))).status).toBe(400);
  });

  it("answers a trigger it does not act on without touching anything", async () => {
    const result = await deliver("MEETING_ENDED", { uid: "bk_1" });
    expect(result).toEqual({ status: 200, body: { ok: true, ignored: "MEETING_ENDED" } });
  });

  it("answers 500 when the row cannot be read, so Cal.com retries", async () => {
    db.failReads.add("crm_appointments");
    const result = await deliver("BOOKING_CANCELLED", { uid: "bk_1" });
    expect(result.status).toBe(500);
  });
});

describe("a cancellation", () => {
  it("cancels the mirror row once, and runs its consequences once", async () => {
    const first = await deliver("BOOKING_CANCELLED", {
      uid: "bk_1",
      type: "strategic-review",
      startTime: THU_0900,
      cancellationReason: "Something came up",
    });
    expect(first.body).toMatchObject({
      ok: true,
      appointment_id: "appt_1",
      applied: "canceled",
      consequences: true,
    });
    expect(row().status).toBe("canceled");
    expect(jsonOf(jsonOf(row().metadata).calcom).status).toBe("cancelled");
    expect(jsonOf(row().metadata).cancellation_reason).toBe("Something came up");
    expect(h.changed).toEqual([{ id: "appt_1", status: "canceled", reason: "Something came up" }]);

    // Cal.com retries a delivery it thinks failed.
    const again = await deliver("BOOKING_CANCELLED", { uid: "bk_1" });
    expect(again.body).toMatchObject({ ok: true, already: "canceled" });
    expect(h.changed).toHaveLength(1);
  });

  it("treats a rejection as a cancellation", async () => {
    await deliver("BOOKING_REJECTED", { uid: "bk_1" });
    expect(row().status).toBe("canceled");
  });

  it("ignores the old half of a reschedule — the move arrives on its own", async () => {
    const result = await deliver("BOOKING_CANCELLED", { uid: "bk_1", rescheduled: true });
    expect(result.body).toMatchObject({ ignored: "superseded_by_reschedule" });
    expect(row().status).toBe("scheduled");
  });

  it("does not cancel a session that has already happened", async () => {
    db.tables.crm_appointments = [mirroredRow({ status: "completed" })];
    const result = await deliver("BOOKING_CANCELLED", { uid: "bk_1" });
    expect(result.body).toMatchObject({ already: "completed" });
    expect(row().status).toBe("completed");
  });

  it("tells the team about a Stage 3 review that has no CRM row", async () => {
    db.tables.crm_appointments = [];
    const result = await deliver("BOOKING_CANCELLED", {
      uid: "bk_stage3",
      type: "strategic-review",
      startTime: THU_0900,
      attendees: [{ name: "Jane Citizen", email: "jane@citizen.com.au" }],
      metadata: { source: "stage3_waitlist", applicationId: "AX-7Q2M4L9XZ1" },
      cancellationReason: "Booked the wrong day",
    });
    expect(result.body).toMatchObject({ applied: "stage3_notice" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toMatchObject({
      kind: "lead_stage_three",
      severity: "warning",
      url: "/leads",
    });
    expect(String(notices()[0].title)).toBe(
      "Jane Citizen (AX-7Q2M4L9XZ1) cancelled their strategic review",
    );
    expect(String(notices()[0].body)).toMatch(/Booked the wrong day/);
  });

  it("names a cancelled session that was booked outside the CRM", async () => {
    db.tables.crm_appointments = [];
    const result = await deliver("BOOKING_CANCELLED", {
      uid: "bk_direct",
      type: "strategic-review",
      startTime: THU_0900,
      attendees: [{ name: "Sam Lee", email: "sam@lee.com.au" }],
      metadata: {},
    });
    expect(result.body).toMatchObject({ applied: "notice" });
    expect(notices()[0]).toMatchObject({ kind: "crm_appointment_changed", severity: "warning" });
    expect(String(notices()[0].title)).toBe("Sam Lee cancelled their strategic review");
    // Booked on Cal.com's own link, so there is no Airtable record to mention.
    expect(String(notices()[0].body)).not.toMatch(/Airtable/);
    expect(String(notices()[0].body)).toMatch(/no CRM record/);
  });

  it("answers 200 for a booking nothing here knows about", async () => {
    db.tables.crm_appointments = [];
    const result = await deliver("BOOKING_CANCELLED", {
      uid: "bk_other",
      type: "some-other-event",
    });
    expect(result).toEqual({ status: 200, body: { ok: true, unmatched: true } });
    expect(notices()).toHaveLength(0);
  });

  it("still answers 200 when the row changed but a consequence failed — a retry would find nothing to do", async () => {
    h.failConsequences = true;
    const result = await deliver("BOOKING_CANCELLED", { uid: "bk_1" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ applied: "canceled", consequences: false });
    expect(row().status).toBe("canceled");
  });
});

describe("a reschedule", () => {
  const moved = {
    uid: "bk_2",
    rescheduleUid: "bk_1",
    rescheduleStartTime: THU_0900,
    type: "strategic-review",
    startTime: FRI_0900,
    endTime: FRI_0930,
  };

  it("moves the mirror row to the new time and the new uid, and requeues its reminders", async () => {
    const result = await deliver("BOOKING_RESCHEDULED", moved);
    expect(result.body).toMatchObject({
      appointment_id: "appt_1",
      applied: "rescheduled",
      consequences: true,
    });
    expect(row()).toMatchObject({ starts_at: FRI_0900, ends_at: FRI_0930 });
    expect(jsonOf(row().metadata).calcom).toMatchObject({
      uid: "bk_2",
      previousUids: ["bk_1"],
      status: "accepted",
    });
    expect(h.rescheduled).toEqual([{ id: "appt_1", previous: THU_0900, via: "calcom" }]);
  });

  it("applies a move once however many times it is delivered", async () => {
    await deliver("BOOKING_RESCHEDULED", moved);
    const again = await deliver("BOOKING_RESCHEDULED", moved);
    expect(again.body).toMatchObject({ already: "applied", appointment_id: "appt_1" });
    expect(h.rescheduled).toHaveLength(1);
  });

  it("does nothing for a move Mission Control made itself and has already written", async () => {
    // The voice agent moved it: the row already carries the new uid and time.
    db.tables.crm_appointments = [
      mirroredRow({
        starts_at: FRI_0900,
        metadata: { calcom: { uid: "bk_2", previousUids: ["bk_1"], status: "accepted" } },
      }),
    ];
    const result = await deliver("BOOKING_RESCHEDULED", moved);
    expect(result.body).toMatchObject({ already: "applied" });
    expect(h.rescheduled).toHaveLength(0);
  });

  it("loses a race with the voice agent's own write without moving the row twice", async () => {
    // The row was read at 09:00; by the time the write lands it is somewhere else.
    const original = db.from;
    let reads = 0;
    db.from = (table: string) => {
      const b = original(table);
      if (table !== "crm_appointments") return b;
      const maybeSingle = b.maybeSingle;
      b.maybeSingle = async () => {
        const answer = await maybeSingle();
        reads += 1;
        if (reads === 2) db.tables.crm_appointments[0].starts_at = FRI_0930;
        return answer;
      };
      return b;
    };
    const result = await deliver("BOOKING_RESCHEDULED", moved);
    expect(result.body).toEqual({
      ok: true,
      appointment_id: "appt_1",
      already: "changed_concurrently",
    });
    expect(row().starts_at).toBe(FRI_0930);
    expect(h.rescheduled).toHaveLength(0);
  });

  it("tells the team about a moved Stage 3 review that has no CRM row", async () => {
    db.tables.crm_appointments = [];
    const result = await deliver("BOOKING_RESCHEDULED", {
      ...moved,
      metadata: { source: "stage3_waitlist", applicationId: "AX-7Q2M4L9XZ1" },
      attendees: [{ name: "Jane Citizen", email: "jane@citizen.com.au" }],
    });
    expect(result.body).toMatchObject({ applied: "stage3_notice" });
    expect(notices()[0]).toMatchObject({ kind: "lead_stage_three", severity: "info" });
    expect(String(notices()[0].body)).toMatch(
      /^Moved from Thursday 1 October.* to Friday 2 October/,
    );
  });

  it("names a moved session that was booked outside the CRM", async () => {
    db.tables.crm_appointments = [];
    const result = await deliver("BOOKING_RESCHEDULED", {
      ...moved,
      type: "guided-demonstration",
      attendees: [{ name: "Sam Lee", email: "sam@lee.com.au" }],
      metadata: {},
    });
    expect(result.body).toMatchObject({ applied: "notice" });
    expect(notices()[0]).toMatchObject({ kind: "crm_appointment_changed", severity: "info" });
    expect(String(notices()[0].title)).toBe("Sam Lee moved their guided demonstration");
    expect(String(notices()[0].body)).toMatch(
      /^Moved from Thursday 1 October.* to Friday 2 October/,
    );
  });

  it("ignores a delivery with no new time rather than guessing one", async () => {
    const result = await deliver("BOOKING_RESCHEDULED", { uid: "bk_2", rescheduleUid: "bk_1" });
    expect(result.body).toMatchObject({ ignored: "incomplete" });
    expect(row().starts_at).toBe(THU_0900);
  });
});

describe("a no-show", () => {
  it("marks the session missed from Cal.com's compact payload", async () => {
    const result = await deliver("BOOKING_NO_SHOW_UPDATED", {
      message: "jane@citizen.com.au marked as no-show",
      attendees: [{ email: "jane@citizen.com.au", noShow: true }],
      bookingUid: "bk_1",
      bookingId: 1001,
    });
    expect(result.body).toMatchObject({ applied: "no_show", appointment_id: "appt_1" });
    expect(row().status).toBe("no_show");
    expect(h.changed).toEqual([{ id: "appt_1", status: "no_show" }]);
  });

  it("does not undo anything when the mark is cleared", async () => {
    const result = await deliver("BOOKING_NO_SHOW_UPDATED", {
      attendees: [{ email: "jane@citizen.com.au", noShow: false }],
      bookingUid: "bk_1",
    });
    expect(result.body).toMatchObject({ ignored: "not_absent" });
    expect(row().status).toBe("scheduled");
  });
});

describe("a booking made directly in Cal.com", () => {
  it("is announced, because the CRM does not hold it", async () => {
    const result = await deliver("BOOKING_CREATED", {
      uid: "bk_direct",
      type: "guided-demonstration",
      startTime: FRI_0900,
      attendees: [{ name: "Sam Lee", email: "sam@lee.com.au" }],
      metadata: {},
    });
    expect(result.body).toMatchObject({ applied: "notice" });
    expect(notices()[0]).toMatchObject({ kind: "crm_appointment_booked", url: "/crm" });
    expect(String(notices()[0].title)).toBe("Sam Lee booked directly in Cal.com");
  });

  it("is not announced when it was ours", async () => {
    for (const source of ["voice_agent", "stage3_waitlist"]) {
      const result = await deliver("BOOKING_CREATED", {
        uid: `bk_${source}`,
        type: "strategic-review",
        metadata: { source },
      });
      expect(result.body).toMatchObject({ ignored: "ours" });
    }
    expect(notices()).toHaveLength(0);
  });

  it("is not announced when it is not one of the Aurixa sessions", async () => {
    const result = await deliver("BOOKING_CREATED", { uid: "bk_x", type: "coffee-chat" });
    expect(result.body).toMatchObject({ ignored: "not_an_aurixa_event_type" });
  });
});
