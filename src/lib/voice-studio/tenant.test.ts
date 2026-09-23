import { describe, expect, it } from "vitest";
import {
  candidateSlotsIn,
  classifyBookingType,
  parseSlotPreference,
  tenantWindow,
  zoneParts,
  type BookingTypeDef,
} from "./tenantBooking.pure";
import {
  handleTenantToolCalls,
  phoneKey,
  ticketReference,
  type TenantCallContext,
  type TenantContact,
  type TenantStore,
  type TenantToolContext,
} from "./tenantTools.pure";

const TYPES: BookingTypeDef[] = [
  {
    key: "check_up",
    label: "check-up and clean",
    synonyms: ["check up", "clean"],
    durationMinutes: 30,
  },
  { key: "consult", label: "new patient consult", synonyms: ["consultation"], durationMinutes: 60 },
];

const WINDOW = tenantWindow(
  {
    days: [1, 2, 3, 4, 5],
    startTime: "08:00",
    endTime: "16:30",
    slotMinutes: 30,
    minNoticeHours: 24,
    horizonDays: 14,
  },
  "Australia/Perth",
)!;

// Monday 2 Nov 2026, 09:00 in Perth (UTC+8, no daylight saving).
const NOW = new Date("2026-11-02T01:00:00Z");

describe("tenantBooking", () => {
  it("builds a window and refuses an unusable one", () => {
    expect(WINDOW.firstStartMinutes).toBe(480);
    expect(
      tenantWindow(
        {
          days: [],
          startTime: "08:00",
          endTime: "09:00",
          slotMinutes: 30,
          minNoticeHours: 0,
          horizonDays: 5,
        },
        "UTC",
      ),
    ).toBeNull();
    expect(
      tenantWindow(
        {
          days: [1],
          startTime: "17:00",
          endTime: "09:00",
          slotMinutes: 30,
          minNoticeHours: 0,
          horizonDays: 5,
        },
        "UTC",
      ),
    ).toBeNull();
    expect(tenantWindow(null, "UTC")).toBeNull();
  });

  it("offers only weekday slots inside the window, after the notice period, in the business's own timezone", () => {
    const slots = candidateSlotsIn(NOW, WINDOW);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const p = zoneParts(s, "Australia/Perth");
      expect([1, 2, 3, 4, 5]).toContain(p.day);
      expect(p.minutes).toBeGreaterThanOrEqual(480);
      expect(p.minutes).toBeLessThanOrEqual(990);
      expect((p.minutes - 480) % 30).toBe(0);
      expect(s.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 24 * 3_600_000);
    }
    // The first one is Tuesday 09:00 Perth - 24 hours after "now".
    expect(zoneParts(slots[0], "Australia/Perth")).toMatchObject({ day: 2, minutes: 540 });
  });

  it("lands on a half-hour-offset zone's real starts", () => {
    const w = tenantWindow(
      {
        days: [1, 2, 3, 4, 5],
        startTime: "09:00",
        endTime: "10:00",
        slotMinutes: 30,
        minNoticeHours: 0,
        horizonDays: 3,
      },
      "Australia/Adelaide",
    )!;
    const slots = candidateSlotsIn(NOW, w);
    expect(
      slots
        .map((s) => zoneParts(s, "Australia/Adelaide").minutes)
        .every((m) => [540, 570, 600].includes(m)),
    ).toBe(true);
  });

  it("classifies the booking type, and asks when it cannot tell", () => {
    expect(classifyBookingType("I need a clean please", TYPES).type?.key).toBe("check_up");
    expect(classifyBookingType("a new patient consult", TYPES).type?.key).toBe("consult");
    const ask = classifyBookingType("something", TYPES);
    expect(ask.type).toBeNull();
    expect(ask.clarificationQuestion).toBe(
      "Is this for a check-up and clean or new patient consult?",
    );
    expect(classifyBookingType("anything", [TYPES[0]]).type?.key).toBe("check_up");
  });

  it("resolves tomorrow in the business's timezone", () => {
    const pref = parseSlotPreference("tomorrow afternoon", NOW, "Australia/Perth");
    expect(pref).toMatchObject({
      dayOfMonth: 3,
      month: 11,
      partOfDay: "afternoon",
      recognised: true,
    });
  });
});

function memoryStore() {
  const contacts: TenantContact[] = [];
  const contexts = new Map<string, TenantCallContext & { phoneKey: string | null }>();
  const appointments: Array<{
    id: string;
    startsAt: string;
    endsAt: string;
    contactId: string;
    bookingType: string;
  }> = [];
  const tickets: Array<{ reference: string; email: string; summary: string }> = [];
  let n = 0;
  const store: TenantStore = {
    async findContactByPhone(phone) {
      return contacts.find((c) => phoneKey(c.phone) === phoneKey(phone)) ?? null;
    },
    async createContact(c) {
      const row = {
        id: `c${++n}`,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
      };
      contacts.push(row);
      return row;
    },
    async getContact(id) {
      return contacts.find((c) => c.id === id) ?? null;
    },
    async fillContactEmail(id, email) {
      const c = contacts.find((x) => x.id === id);
      if (c && !c.email) c.email = email;
    },
    async readContext(callId, key) {
      return (
        contexts.get(callId) ??
        [...contexts.values()].find((c) => key && c.phoneKey === key) ??
        null
      );
    },
    async upsertContext(callId, fields) {
      const prev = contexts.get(callId) ?? {
        vapiCallId: callId,
        callerPhone: null,
        contactId: null,
        firstName: null,
        fullName: null,
        contactState: null,
        contactFound: null,
        contactCreated: null,
        confirmedIntent: null,
        callerReason: null,
        handoffReady: false,
        phoneKey: null,
      };
      contexts.set(callId, { ...prev, ...fields });
    },
    async bookedIntervals() {
      return appointments.map((a) => ({
        start: Date.parse(a.startsAt),
        end: Date.parse(a.endsAt),
      }));
    },
    async createAppointment(a) {
      if (appointments.some((x) => x.startsAt === a.startsAt)) return null;
      const row = { id: `a${++n}`, ...a };
      appointments.push(row);
      return { id: row.id, startsAt: row.startsAt };
    },
    async createTicket(t) {
      const reference = `VT-${++n}`;
      tickets.push({ reference, email: t.email, summary: t.summary });
      return { reference };
    },
  };
  return { store, contacts, appointments, tickets };
}

const call = (name: string, args: Record<string, unknown>, id = "t1") => ({
  type: "tool-calls",
  call: { id: "call-1", customer: { number: "+61 412 345 678" } },
  toolCallList: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});

const parse = (r: { results: Array<{ result: string }> }) => JSON.parse(r.results[0].result);

describe("handleTenantToolCalls", () => {
  const ctx = (store: TenantStore, over: Partial<TenantToolContext> = {}): TenantToolContext => ({
    businessName: "Harbourside Dental",
    timezone: "Australia/Perth",
    window: WINDOW,
    bookingTypes: TYPES,
    store,
    now: () => NOW,
    ...over,
  });

  it("asks for a name, creates the contact, then resolves it by number", async () => {
    const { store, contacts } = memoryStore();
    expect(
      parse(await handleTenantToolCalls(call("resolve_contact", {}), ctx(store))).contactState,
    ).toBe("NEEDS_NAME");
    const created = parse(
      await handleTenantToolCalls(
        call("resolve_contact", { full_name: "Jo Bloggs", email: "JO@example.com " }),
        ctx(store),
      ),
    );
    expect(created).toMatchObject({ contactCreated: true, firstName: "Jo" });
    expect(contacts[0]).toMatchObject({ lastName: "Bloggs", email: "jo@example.com" });
    const again = parse(await handleTenantToolCalls(call("resolve_contact", {}), ctx(store)));
    expect(again).toMatchObject({ contactFound: true, contactId: contacts[0].id });
  });

  it("offers real slots and books one; a taken slot is refused", async () => {
    const { store, appointments } = memoryStore();
    await handleTenantToolCalls(call("resolve_contact", { full_name: "Jo Bloggs" }), ctx(store));
    const avail = parse(
      await handleTenantToolCalls(
        call("check_availability", {
          booking_intent_text: "a clean",
          preferred_date_text: "wednesday morning",
        }),
        ctx(store),
      ),
    );
    expect(avail.success).toBe(true);
    expect(avail.preference_met).toBe(true);
    const slot = avail.availability[0].startIso;
    const booked = parse(
      await handleTenantToolCalls(
        call("book_appointment", { booking_intent_text: "clean", startTime: slot }),
        ctx(store),
      ),
    );
    expect(booked.appointment_created).toBe(true);
    expect(appointments).toHaveLength(1);
    const again = parse(
      await handleTenantToolCalls(
        call("book_appointment", { booking_intent_text: "clean", startTime: slot }),
        ctx(store),
      ),
    );
    expect(again.slot_taken).toBe(true);
  });

  it("refuses to book a time it would not have offered", async () => {
    const { store } = memoryStore();
    await handleTenantToolCalls(call("resolve_contact", { full_name: "Jo Bloggs" }), ctx(store));
    // Sunday - outside the window.
    const r = parse(
      await handleTenantToolCalls(
        call("book_appointment", {
          booking_intent_text: "clean",
          startTime: "2026-11-08T02:00:00Z",
        }),
        ctx(store),
      ),
    );
    expect(r.slot_taken).toBe(true);
  });

  it("says booking is not set up rather than offering times with no window", async () => {
    const { store } = memoryStore();
    const r = parse(
      await handleTenantToolCalls(
        call("check_availability", { booking_intent_text: "clean" }),
        ctx(store, { window: null }),
      ),
    );
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Do not offer times/);
  });

  it("raises a ticket once it has an email", async () => {
    const { store, tickets } = memoryStore();
    const first = parse(
      await handleTenantToolCalls(
        call("raise_support_ticket", { summary: "Cannot log in", detail: "error 5" }),
        ctx(store),
      ),
    );
    expect(first.needs_email).toBe(true);
    const r = parse(
      await handleTenantToolCalls(
        call("raise_support_ticket", {
          summary: "Cannot log in",
          detail: "error 5",
          email: "a@b.co",
        }),
        ctx(store),
      ),
    );
    expect(r.ticket_created).toBe(true);
    expect(tickets[0].email).toBe("a@b.co");
  });

  it("answers an unknown tool without throwing, and keeps the call id", async () => {
    const { store } = memoryStore();
    const r = await handleTenantToolCalls(call("delete_everything", {}, "abc"), ctx(store));
    expect(r.results[0].toolCallId).toBe("abc");
    expect(JSON.parse(r.results[0].result).error).toBe("unknown_tool_delete_everything");
  });

  it("mints unambiguous ticket references", () => {
    expect(ticketReference(() => 0)).toBe("VT-AAAAAA");
    expect(ticketReference()).toMatch(/^VT-[A-HJ-NP-Z2-9]{6}$/);
  });
});
