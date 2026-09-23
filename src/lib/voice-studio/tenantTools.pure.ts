// The tools a tenant's deployed fleet calls mid-conversation, answered from
// that tenant's own records. The Aurixa handlers (voice-tools.server.ts) are
// the proven behaviour; this is the same contract - the same tool names, the
// same argument spellings, the same `nextAction` / `message` guidance the
// recipe book's prompts are written against - over a store scoped to one
// tenant, so nothing here can read or write another tenant's rows.
//
// Every reply is VAPI's tool-result envelope, matched to the call by id; a
// bare JSON body is silently ignored by VAPI.
import { DEFAULT_TOOL_NAMES, type ToolKey } from "../voice-recipe/types.pure.ts";
import {
  candidateSlotsIn,
  classifyBookingType,
  freeOf,
  orderSlotsByPreference,
  parseSlotPreference,
  slotMatchesPreference,
  slotSpoken,
  type BookingTypeDef,
  type TenantWindow,
} from "./tenantBooking.pure.ts";

type Rec = Record<string, any>;
const asRecord = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});

export interface TenantContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string;
}

export interface TenantCallContext {
  vapiCallId: string;
  callerPhone: string | null;
  contactId: string | null;
  firstName: string | null;
  fullName: string | null;
  contactState: string | null;
  contactFound: boolean | null;
  contactCreated: boolean | null;
  confirmedIntent: string | null;
  callerReason: string | null;
  handoffReady: boolean;
}

export interface TenantStore {
  findContactByPhone(phone: string): Promise<TenantContact | null>;
  createContact(c: {
    phone: string;
    firstName: string;
    lastName: string | null;
    email: string | null;
  }): Promise<TenantContact>;
  getContact(id: string): Promise<TenantContact | null>;
  /** Fill a blank email; never overwrite one. */
  fillContactEmail(id: string, email: string): Promise<void>;
  readContext(vapiCallId: string, phoneKey: string): Promise<TenantCallContext | null>;
  upsertContext(
    vapiCallId: string,
    fields: Partial<TenantCallContext> & { callerPhone: string | null; phoneKey: string | null },
  ): Promise<void>;
  bookedIntervals(fromIso: string, toIso: string): Promise<Array<{ start: number; end: number }>>;
  /** Returns null when the slot was taken between the check and the write. */
  createAppointment(a: {
    contactId: string;
    bookingType: string;
    startsAt: string;
    endsAt: string;
    vapiCallId: string | null;
    notes: string | null;
  }): Promise<{ id: string; startsAt: string } | null>;
  createTicket(t: {
    contactId: string | null;
    summary: string;
    detail: string | null;
    email: string;
    vapiCallId: string | null;
  }): Promise<{ reference: string }>;
}

export interface TenantToolContext {
  businessName: string;
  timezone: string;
  window: TenantWindow | null;
  bookingTypes: BookingTypeDef[];
  store: TenantStore;
  now: () => Date;
}

/** The last nine digits: the same person whether dialled 0412... or +61412... */
export function phoneKey(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits.slice(-9) : "";
}

export function normalisedPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const kept = raw.replace(/[^\d+]/g, "");
  return kept.startsWith("+") ? "+" + kept.slice(1).replace(/\D/g, "") : kept.replace(/\D/g, "");
}

/** Only an address that parses is kept: a mis-heard address is worse than none. */
export function heardEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  if (!t || t.length > 254) return null;
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(t) ? t : null;
}

type ToolCall = { id: string; name: string; args: Rec };

/** VAPI spells the tool-call list at least three ways; accept all of them. */
export function extractToolCalls(message: Rec): ToolCall[] {
  const out: ToolCall[] = [];
  const push = (id: unknown, name: unknown, rawArgs: unknown) => {
    if (typeof id !== "string" || typeof name !== "string") return;
    let args: Rec = {};
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs);
      } catch {
        args = {};
      }
    } else args = asRecord(rawArgs);
    out.push({ id, name, args });
  };
  for (const raw of Array.isArray(message.toolCallList) ? message.toolCallList : []) {
    const tc = asRecord(raw);
    const fn = asRecord(tc.function);
    push(tc.id, fn.name ?? tc.name, fn.arguments ?? tc.arguments);
  }
  if (!out.length) {
    for (const raw of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const tc = asRecord(raw);
      const fn = asRecord(tc.function);
      push(tc.id, fn.name, fn.arguments);
    }
  }
  if (!out.length) {
    for (const raw of Array.isArray(message.toolWithToolCallList)
      ? message.toolWithToolCallList
      : []) {
      const tc = asRecord(asRecord(raw).toolCall);
      const fn = asRecord(tc.function);
      push(tc.id, fn.name, fn.arguments);
    }
  }
  return out;
}

const TOOL_BY_NAME = new Map<string, ToolKey>(
  (Object.entries(DEFAULT_TOOL_NAMES) as Array<[ToolKey, string]>).map(([k, n]) => [n, k]),
);
TOOL_BY_NAME.set("phone_number_inject", "phone_number_inject");

function identityFrom(message: Rec, args: Rec): { vapiCallId: string; callerPhone: string } {
  const call = asRecord(message.call);
  return {
    vapiCallId: String(args.vapiCallId ?? call.id ?? message.callId ?? ""),
    callerPhone: String(
      args.callerPhone ??
        args.phone ??
        asRecord(message.customer).number ??
        asRecord(call.customer).number ??
        "",
    ),
  };
}

async function resolveContact(tc: ToolCall, message: Rec, ctx: TenantToolContext): Promise<Rec> {
  const id = identityFrom(message, tc.args);
  const key = phoneKey(id.callerPhone);
  const email = heardEmail(tc.args.email);
  const fullName = String(tc.args.full_name ?? tc.args.fullName ?? "").trim();
  const firstArg = String(tc.args.first_name ?? tc.args.firstName ?? "").trim();
  const lastArg = String(tc.args.last_name ?? tc.args.lastName ?? "").trim();
  const ctxFields = { callerPhone: id.callerPhone || null, phoneKey: key || null };

  const matched = key ? await ctx.store.findContactByPhone(id.callerPhone) : null;
  if (matched) {
    if (email && !matched.email) await ctx.store.fillContactEmail(matched.id, email);
    const first = matched.firstName ?? "";
    const full = [matched.firstName, matched.lastName].filter(Boolean).join(" ");
    await ctx.store.upsertContext(id.vapiCallId, {
      ...ctxFields,
      contactId: matched.id,
      firstName: first,
      fullName: full,
      contactState: "RESOLVED",
      contactFound: true,
      contactCreated: false,
    });
    return {
      success: true,
      contactId: matched.id,
      firstName: first,
      fullName: full,
      phone: id.callerPhone,
      email: matched.email ?? email ?? null,
      contactState: "RESOLVED",
      contactFound: true,
      contactCreated: false,
      nextAction: "continueConversation",
      message: `Existing contact resolved successfully. The caller's first name is ${first}. Use this first name naturally in the next spoken response.`,
    };
  }

  if (!fullName && !firstArg && !lastArg) {
    await ctx.store.upsertContext(id.vapiCallId, {
      ...ctxFields,
      contactState: "NEEDS_NAME",
      contactFound: false,
      contactCreated: false,
    });
    return {
      success: true,
      contactState: "NEEDS_NAME",
      requiresName: true,
      nextAction: "askForFullName",
      message: `No contact matches this number. Ask the caller for their full name once, then call ${DEFAULT_TOOL_NAMES.resolve_contact} again with the name fields.`,
    };
  }

  if (!key) {
    return {
      success: false,
      contactState: "UNRESOLVED",
      nextAction: "continueConversation",
      message:
        "The caller's number is withheld, so no contact can be created. Continue the conversation without one.",
    };
  }

  const firstName = firstArg || fullName.split(/\s+/)[0];
  const lastName = lastArg || fullName.split(/\s+/).slice(1).join(" ") || null;
  const contact = await ctx.store.createContact({
    phone: normalisedPhone(id.callerPhone),
    firstName,
    lastName,
    email,
  });
  const display = [firstName, lastName].filter(Boolean).join(" ");
  await ctx.store.upsertContext(id.vapiCallId, {
    ...ctxFields,
    contactId: contact.id,
    firstName,
    fullName: display,
    contactState: "RESOLVED",
    contactFound: false,
    contactCreated: true,
  });
  return {
    success: true,
    contactId: contact.id,
    firstName,
    fullName: display,
    phone: id.callerPhone,
    email: email ?? null,
    contactState: "RESOLVED",
    contactFound: false,
    contactCreated: true,
    nextAction: "continueConversation",
    message: `New contact created. The caller's first name is ${firstName}. Use this first name naturally in the next spoken response.`,
  };
}

async function getCallContext(tc: ToolCall, message: Rec, ctx: TenantToolContext): Promise<Rec> {
  const id = identityFrom(message, tc.args);
  const stored = await ctx.store.readContext(id.vapiCallId, phoneKey(id.callerPhone));
  if (!stored?.contactId) {
    return {
      success: true,
      contextFound: false,
      vapiCallId: id.vapiCallId,
      callerPhone: id.callerPhone,
      contactState: "UNRESOLVED",
      handoffReady: false,
      nextAction: "continueWithoutStoredContext",
      message: "No stored caller context found. Continue the conversation and resolve the contact.",
    };
  }
  return {
    success: true,
    contextFound: true,
    vapiCallId: stored.vapiCallId,
    callerPhone: stored.callerPhone,
    contactId: stored.contactId,
    firstName: stored.firstName,
    fullName: stored.fullName,
    phone: stored.callerPhone,
    contactState: stored.contactState,
    contactFound: stored.contactFound,
    contactCreated: stored.contactCreated,
    confirmedIntent: stored.confirmedIntent,
    callerReason: stored.callerReason,
    handoffReady: stored.handoffReady,
    nextAction: "continueConversation",
    message: `Stored caller context found. The caller's first name is ${stored.firstName ?? "unknown"}. Use this first name naturally in the next spoken response.`,
  };
}

async function phoneNumberInject(tc: ToolCall, message: Rec, ctx: TenantToolContext): Promise<Rec> {
  const id = identityFrom(message, tc.args);
  const stored = await ctx.store.readContext(id.vapiCallId, phoneKey(id.callerPhone));
  const confirmedIntent =
    tc.args.confirmedIntent ?? tc.args.confirmed_intent ?? stored?.confirmedIntent ?? null;
  const callerReason =
    tc.args.callerReason ?? tc.args.caller_reason ?? stored?.callerReason ?? null;
  await ctx.store.upsertContext(id.vapiCallId, {
    callerPhone: id.callerPhone || null,
    phoneKey: phoneKey(id.callerPhone) || null,
    confirmedIntent,
    callerReason,
    handoffReady: true,
  });
  return {
    success: true,
    contactId: stored?.contactId ?? null,
    firstName: stored?.firstName ?? null,
    fullName: stored?.fullName ?? null,
    phone: id.callerPhone,
    contactState: stored?.contactState ?? "UNRESOLVED",
    confirmedIntent,
    callerReason,
    handoffReady: true,
    vapiCallId: id.vapiCallId,
    nextAction: "handoff_to_assistant",
  };
}

async function freeSlots(ctx: TenantToolContext, minutes: number): Promise<Date[]> {
  if (!ctx.window) return [];
  const now = ctx.now();
  const candidates = candidateSlotsIn(now, ctx.window);
  if (!candidates.length) return [];
  const booked = await ctx.store.bookedIntervals(
    now.toISOString(),
    new Date(candidates[candidates.length - 1].getTime() + 86_400_000).toISOString(),
  );
  return freeOf(candidates, booked, minutes);
}

const noWindow = {
  success: false,
  nextAction: "offerCallback",
  message:
    "Online booking is not set up for this business yet. Do not offer times. Take the caller's details and tell them the team will call to arrange a time.",
};

async function checkAvailability(tc: ToolCall, ctx: TenantToolContext): Promise<Rec> {
  if (!ctx.window) return noWindow;
  const intent = classifyBookingType(
    tc.args.booking_intent_text ?? tc.args.booking_type ?? "",
    ctx.bookingTypes,
  );
  if (!intent.type) {
    return {
      success: false,
      needs_clarification: true,
      clarification_question: intent.clarificationQuestion,
      allowed_booking_types: ctx.bookingTypes.map((t) => t.label),
    };
  }
  const pref = parseSlotPreference(
    tc.args.preferred_date_text ?? tc.args.preferredDateText ?? "",
    ctx.now(),
    ctx.timezone,
  );
  const all = await freeSlots(ctx, intent.type.durationMinutes);
  const slots = orderSlotsByPreference(all, pref, ctx.timezone).slice(0, 8);
  const preferenceMet =
    pref.recognised && slots.some((s) => slotMatchesPreference(s, pref, ctx.timezone));
  return {
    success: true,
    booking_type: intent.type.label,
    kind: intent.type.key,
    timezone: ctx.timezone,
    duration_minutes: intent.type.durationMinutes,
    preference_understood: pref.recognised,
    preference_met: pref.recognised ? preferenceMet : null,
    availability: slots.map((s) => ({
      startIso: s.toISOString(),
      endIso: new Date(s.getTime() + intent.type!.durationMinutes * 60_000).toISOString(),
      spoken: slotSpoken(s, ctx.timezone),
      matches_preference: pref.recognised ? slotMatchesPreference(s, pref, ctx.timezone) : null,
    })),
    message:
      slots.length === 0
        ? "No slots are free in the booking window. Offer to have the team call the caller back instead."
        : pref.recognised && !preferenceMet
          ? "Availability returned, but nothing free matches what the caller asked for. Say so plainly, then offer the nearest alternatives from the availability list. Do not create a booking from this tool."
          : "Availability returned. Offer only slots from the availability list. Do not create a booking from this tool.",
  };
}

async function bookAppointment(tc: ToolCall, message: Rec, ctx: TenantToolContext): Promise<Rec> {
  if (!ctx.window) return noWindow;
  const id = identityFrom(message, tc.args);
  const intent = classifyBookingType(
    tc.args.booking_intent_text ?? tc.args.booking_type ?? "",
    ctx.bookingTypes,
  );
  if (!intent.type) {
    return {
      success: false,
      needs_clarification: true,
      clarification_question: intent.clarificationQuestion,
    };
  }
  const startMs = Date.parse(
    String(tc.args.startTime ?? tc.args.start_time ?? tc.args.startIso ?? ""),
  );
  if (Number.isNaN(startMs)) {
    return {
      success: false,
      needs_clarification: true,
      clarification_question: `Which exact slot should be booked? Pass the startIso value from ${DEFAULT_TOOL_NAMES.check_availability}.`,
    };
  }
  const minutes = intent.type.durationMinutes;
  const stillFree = (await freeSlots(ctx, minutes)).some(
    (s) => Math.abs(s.getTime() - startMs) < 60_000,
  );
  if (!stillFree) {
    return {
      success: false,
      appointment_created: false,
      slot_taken: true,
      message: `That slot is no longer available. Call ${DEFAULT_TOOL_NAMES.check_availability} again and offer a fresh slot.`,
    };
  }
  const stored = await ctx.store.readContext(id.vapiCallId, phoneKey(id.callerPhone));
  if (!stored?.contactId) {
    return {
      success: false,
      appointment_created: false,
      message: `The caller is not resolved to a contact yet. Call ${DEFAULT_TOOL_NAMES.resolve_contact} first, then book again.`,
    };
  }
  const start = new Date(startMs);
  const booked = await ctx.store.createAppointment({
    contactId: stored.contactId,
    bookingType: intent.type.key,
    startsAt: start.toISOString(),
    endsAt: new Date(startMs + minutes * 60_000).toISOString(),
    vapiCallId: id.vapiCallId || null,
    notes: typeof tc.args.notes === "string" ? tc.args.notes.slice(0, 2000) : null,
  });
  if (!booked) {
    return {
      success: false,
      appointment_created: false,
      slot_taken: true,
      message: `That slot was taken a moment ago. Call ${DEFAULT_TOOL_NAMES.check_availability} again and offer a fresh slot.`,
    };
  }
  await ctx.store.upsertContext(id.vapiCallId, {
    callerPhone: id.callerPhone || null,
    phoneKey: phoneKey(id.callerPhone) || null,
    confirmedIntent: intent.type.key,
  });
  return {
    success: true,
    appointment_created: true,
    appointmentId: booked.id,
    booking_type: intent.type.label,
    startTime: booked.startsAt,
    timezone: ctx.timezone,
    spoken: slotSpoken(new Date(booked.startsAt), ctx.timezone),
    message: "Booking confirmed. Confirm the day and time back to the caller in natural speech.",
  };
}

async function raiseSupportTicket(
  tc: ToolCall,
  message: Rec,
  ctx: TenantToolContext,
): Promise<Rec> {
  const id = identityFrom(message, tc.args);
  const summary = String(tc.args.summary ?? "")
    .trim()
    .slice(0, 300);
  if (!summary) {
    return {
      success: false,
      ticket_created: false,
      message: "Ask the caller what the problem is in a sentence, then call this again.",
    };
  }
  const stored = await ctx.store.readContext(id.vapiCallId, phoneKey(id.callerPhone));
  let email = heardEmail(tc.args.email);
  if (!email && stored?.contactId)
    email = heardEmail((await ctx.store.getContact(stored.contactId))?.email);
  if (!email) {
    return {
      success: false,
      ticket_created: false,
      needs_email: true,
      clarification_question:
        "What is the best email address for the team to reply to? Ask the caller to say it, then repeat it back to them before calling this tool again.",
      message: "No email address on file for this caller and none was supplied.",
    };
  }
  const detail = [
    tc.args.detail,
    tc.args.what_is_broken && `Affected: ${tc.args.what_is_broken}`,
    tc.args.since_when && `Since: ${tc.args.since_when}`,
  ]
    .filter((x) => typeof x === "string" && x.trim())
    .join("\n")
    .slice(0, 8000);
  const { reference } = await ctx.store.createTicket({
    contactId: stored?.contactId ?? null,
    summary,
    detail: detail || null,
    email,
    vapiCallId: id.vapiCallId || null,
  });
  return {
    success: true,
    ticket_created: true,
    reference,
    message: `Ticket ${reference} has been raised. Read the reference back to the caller, letting them know the ${ctx.businessName} team will reply to ${email}.`,
  };
}

/** Answer a VAPI tool-calls message with one result per call, in order. */
export async function handleTenantToolCalls(
  message: Rec,
  ctx: TenantToolContext,
): Promise<{ results: Array<{ toolCallId: string; result: string }> }> {
  const results: Array<{ toolCallId: string; result: string }> = [];
  for (const tc of extractToolCalls(message)) {
    let result: Rec;
    try {
      switch (TOOL_BY_NAME.get(tc.name)) {
        case "resolve_contact":
          result = await resolveContact(tc, message, ctx);
          break;
        case "get_call_context":
          result = await getCallContext(tc, message, ctx);
          break;
        case "phone_number_inject":
          result = await phoneNumberInject(tc, message, ctx);
          break;
        case "check_availability":
          result = await checkAvailability(tc, ctx);
          break;
        case "book_appointment":
          result = await bookAppointment(tc, message, ctx);
          break;
        case "raise_support_ticket":
          result = await raiseSupportTicket(tc, message, ctx);
          break;
        default:
          result = { success: false, error: `unknown_tool_${tc.name}` };
      }
    } catch (err) {
      console.error(`[voice-tenant] ${tc.name} failed:`, err instanceof Error ? err.message : err);
      result = {
        success: false,
        error: "tool_failed",
        message: "The tool hit an internal error. Apologise briefly and continue the conversation.",
      };
    }
    results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
  }
  return { results };
}

/** A human-readable ticket reference: short, unambiguous letters and digits. */
export function ticketReference(random: () => number = Math.random): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(random() * alphabet.length)];
  return `VT-${s}`;
}
