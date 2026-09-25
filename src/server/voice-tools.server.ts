// The tools an inbound VAPI assistant can call mid-conversation, answered
// synchronously from our own CRM — the re-homing of everything GoHighLevel
// used to do for the squad: contact resolution, the call-context store,
// calendar availability, booking, the context bridge and handoff routing.
//
// Every reply is the VAPI tool-result envelope:
//   { results: [{ toolCallId, result: "<stringified JSON>" }] }
// VAPI matches results to calls by id; a bare JSON body is silently ignored.
//
// Availability is deterministic, not model-resolved, so a promise like "we can
// do Tuesday at 3" never depends on a model's date arithmetic. Where
// `CALCOM_API_KEY` is set the calendar is Cal.com (`calcom.server.ts`): it
// answers availability against every booking from every path — this fleet,
// the Stage 3 scheduler on the waitlist site, anything booked in Cal.com
// itself — holds the booking, and sends the invitation with the video link.
// Without the key, BOOKING_WINDOW below is the calendar (Mon–Fri, 30-minute
// slots ending by 16:30 Australia/Sydney, 24 hours' notice, 45 days ahead)
// checked against `crm_appointments` alone. That constant is the authority on
// the legacy path; this comment used to quote the NPC window it replaced,
// which is how a reader comes to trust the wrong hours.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { notifyOperators } from "@/server/audit.server";
import {
  CALCOM_EVENT_TYPE_SLUGS,
  mirrorFromBooking,
  readCalcomMirror,
  type CalcomBooking,
  type CalcomFailure,
  type CalcomMirror,
} from "@/server/calcom.pure";
import {
  calcomConfig,
  createCalcomBooking,
  findLiveCalcomBooking,
  listUpcomingCalcomBookings,
  rescheduleCalcomBooking,
  type CalcomConfig,
} from "@/server/calcom.server";
import { calcomFreeSlots } from "@/server/calendar.server";
import {
  alreadyBookedReply,
  availabilityUnavailableReply,
  bookedReply,
  bookingNotConfirmedReply,
  calendarFaultOf,
  heldBookingOfKind,
  nearestAlternatives,
  needsEmailReply,
  rescheduledReply,
  slotTakenReply,
  type SpokenSlot,
} from "@/server/voiceBooking.pure";
import { normalizePhone, phonesMatch } from "@/server/voice.server";
import { SUPPORT_SOURCE_SLUG, ingestSupportTicket } from "@/server/support-tickets.server";
import { draftTicketFromSpeech, usableEmail } from "@/server/voiceTicketDraft.pure";
import {
  orderSlotsByPreference as sharedOrderSlotsByPreference,
  parseSlotPreference as sharedParseSlotPreference,
  slotMatchesPreference as sharedSlotMatchesPreference,
  type SlotPreference as SharedSlotPreference,
} from "@/lib/voice-studio/tenantBooking.pure";

type Rec = Record<string, any>;

function asRecord(v: unknown): Rec {
  return v && typeof v === "object" ? (v as Rec) : {};
}

/* ------------------------------ envelope ---------------------------------- */

export function toolEnvelope(toolCallId: string, result: Record<string, unknown>): Rec {
  return { results: [{ toolCallId, result: JSON.stringify(result) }] };
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
    } else {
      args = asRecord(rawArgs);
    }
    out.push({ id, name, args });
  };

  for (const raw of Array.isArray(message.toolCallList) ? message.toolCallList : []) {
    const tc = asRecord(raw);
    const fn = asRecord(tc.function);
    push(tc.id, fn.name ?? tc.name, fn.arguments ?? tc.arguments);
  }
  if (out.length === 0) {
    for (const raw of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const tc = asRecord(raw);
      const fn = asRecord(tc.function);
      push(tc.id, fn.name, fn.arguments);
    }
  }
  if (out.length === 0) {
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

/* ------------------------- availability (pure) ----------------------------- */

// The strategic-review rules from the Aurixa scheduling page: Mon–Fri
// 9:00 a.m.–4:30 p.m. Sydney, 30-minute slots, minimum 24 hours' notice,
// bookable 45 days ahead.
export const BOOKING_WINDOW = {
  timezone: "Australia/Sydney",
  startMinutes: 9 * 60,
  endMinutes: 16 * 60 + 30,
  slotMinutes: 30,
  searchDays: 45,
  minNoticeHours: 24,
} as const;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function sydneyParts(date: Date): {
  y: number;
  m: number;
  d: number;
  day: number;
  minutes: number;
} {
  const fmt = new Intl.DateTimeFormat("en-AU", {
    timeZone: BOOKING_WINDOW.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    day: WEEKDAYS.indexOf(get("weekday").slice(0, 3)),
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

/**
 * Candidate 30-minute slot starts over the booking horizon, skipping
 * weekends and anything inside the minimum-notice window, expressed as UTC
 * instants. Built by scanning forward in 30-minute steps from the next UTC
 * half-hour — the same DST-proof trick the quiet-hours shift uses.
 */
export function candidateSlots(now: Date): Date[] {
  const slots: Date[] = [];
  const earliest = now.getTime() + BOOKING_WINDOW.minNoticeHours * 60 * 60_000;
  const start = new Date(Math.ceil(earliest / (30 * 60_000)) * 30 * 60_000);
  const horizonMs = BOOKING_WINDOW.searchDays * 24 * 60 * 60_000;
  for (let t = start.getTime(); t < now.getTime() + horizonMs; t += 30 * 60_000) {
    const d = new Date(t);
    const p = sydneyParts(d);
    if (p.day === 0 || p.day === 6) continue;
    if (p.minutes < BOOKING_WINDOW.startMinutes) continue;
    if (p.minutes + BOOKING_WINDOW.slotMinutes > BOOKING_WINDOW.endMinutes) continue;
    slots.push(d);
  }
  return slots;
}

export type AppointmentKind =
  | "strategic_review"
  | "discovery_session"
  | "guided_demo"
  | "enterprise_consultation"
  | "kickoff";

/**
 * Deterministic session-intent classifier for the Aurixa funnel. Keyword
 * based; anything ambiguous asks for clarification instead of guessing.
 * The strategic review is the default sales conversation, so plain "review"
 * or "session" language lands there.
 */
export function classifyBookingIntent(text: string | null | undefined): {
  kind: AppointmentKind | null;
  clarificationQuestion: string | null;
} {
  const t = (text ?? "").toLowerCase();
  if (/kick.?off|onboard/.test(t)) return { kind: "kickoff", clarificationQuestion: null };
  if (/enterprise|procurement|security review|requirements consult/.test(t)) {
    return { kind: "enterprise_consultation", clarificationQuestion: null };
  }
  if (/demo(nstration)?\b/.test(t)) return { kind: "guided_demo", clarificationQuestion: null };
  if (/discovery/.test(t)) return { kind: "discovery_session", clarificationQuestion: null };
  if (/strategic|review|strategy|assessment|application/.test(t)) {
    return { kind: "strategic_review", clarificationQuestion: null };
  }
  return {
    kind: null,
    clarificationQuestion:
      "Is this for your strategic review, a platform discovery session, a guided demonstration, or an enterprise requirements consultation?",
  };
}

/**
 * What the caller said about WHEN, reduced to constraints a slot can be
 * tested against. `check_availability` has always accepted
 * `preferred_date_text` and always thrown it away — so a caller who said
 * "Thursday afternoon would suit" was read the first eight chronological
 * slots regardless, which is worse than never asking.
 *
 * The parsing and matching live once, parameterised by timezone, in
 * `tenantBooking.pure.ts` — the Voice Cloning Studio's tenant fleets use the
 * same rules in their own timezone. These wrappers pin Aurixa's.
 */
export type SlotPreference = SharedSlotPreference;

export function parseSlotPreference(
  text: string | null | undefined,
  now: Date = new Date(),
): SlotPreference {
  return sharedParseSlotPreference(text, now, BOOKING_WINDOW.timezone);
}

/** Does this slot satisfy every constraint the caller actually stated? */
export function slotMatchesPreference(slot: Date, pref: SlotPreference): boolean {
  return sharedSlotMatchesPreference(slot, pref, BOOKING_WINDOW.timezone);
}

/**
 * Preferred slots first, everything else after, each half still in time order.
 * A SORT, never a filter — see `tenantBooking.pure.ts`. An unrecognised
 * preference returns the input untouched, so the no-preference path is
 * byte-identical to what it was.
 */
export function orderSlotsByPreference(slots: Date[], pref: SlotPreference): Date[] {
  return sharedOrderSlotsByPreference(slots, pref, BOOKING_WINDOW.timezone);
}

const KIND_LABEL: Record<AppointmentKind, string> = {
  strategic_review: "Strategic Review",
  discovery_session: "Platform Discovery Session",
  guided_demo: "Guided Demonstration",
  enterprise_consultation: "Enterprise Requirements Consultation",
  kickoff: "Onboarding Kickoff Call",
};

async function freeSlots(now: Date, limit = 8): Promise<Date[]> {
  const candidates = candidateSlots(now);
  if (candidates.length === 0) return [];
  const horizonEnd = candidates[candidates.length - 1];
  // One human hosts every appointment type, so any booked slot blocks all kinds.
  const { data: booked, error } = await supabaseAdmin
    .from("crm_appointments")
    .select("starts_at, ends_at")
    .in("status", ["scheduled", "confirmed"])
    .gte("starts_at", now.toISOString())
    .lte("starts_at", new Date(horizonEnd.getTime() + 60 * 60_000).toISOString());
  if (error) {
    console.error("[voice-tools] booked slot read failed:", error.message);
    return [];
  }
  const taken = (booked ?? []).map((b) => ({
    start: Date.parse(b.starts_at),
    end: b.ends_at ? Date.parse(b.ends_at) : Date.parse(b.starts_at) + 30 * 60_000,
  }));
  return candidates
    .filter((slot) => {
      const s = slot.getTime();
      const e = s + BOOKING_WINDOW.slotMinutes * 60_000;
      return !taken.some((t) => s < t.end && e > t.start);
    })
    .slice(0, limit);
}

function slotLabel(d: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: BOOKING_WINDOW.timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

/* ------------------------------ tool handlers ------------------------------ */

type CallIdentity = { vapiCallId: string; callerPhone: string };

function identityFrom(message: Rec, args: Rec): CallIdentity {
  const call = asRecord(message.call);
  const vapiCallId: string =
    args.vapiCallId ?? args.vapi_call_id ?? call.id ?? message.callId ?? "";
  const callerPhone: string =
    args.callerPhone ??
    args.customer_number ??
    args.phone ??
    asRecord(message.customer).number ??
    asRecord(call.customer).number ??
    "";
  return { vapiCallId, callerPhone };
}

async function upsertContext(
  identity: CallIdentity,
  fields: Record<string, unknown>,
): Promise<void> {
  if (!identity.vapiCallId) return;
  const { error } = await supabaseAdmin.from("voice_call_context").upsert(
    {
      vapi_call_id: identity.vapiCallId,
      caller_phone: identity.callerPhone || null,
      normalized_phone: normalizePhone(identity.callerPhone) || null,
      ...fields,
    },
    { onConflict: "vapi_call_id" },
  );
  if (error) console.error("[voice-tools] context upsert failed:", error.message);
}

async function readContext(identity: CallIdentity): Promise<Rec | null> {
  if (identity.vapiCallId) {
    const { data } = await supabaseAdmin
      .from("voice_call_context")
      .select("*")
      .eq("vapi_call_id", identity.vapiCallId)
      .maybeSingle();
    if (data) return data;
  }
  // Fallback for a tool invoked with only the caller's number (a squad member
  // that lost the call id across a transfer): most recent context for the phone.
  const normalized = normalizePhone(identity.callerPhone);
  if (!normalized) return null;
  const { data } = await supabaseAdmin
    .from("voice_call_context")
    .select("*")
    .eq("normalized_phone", normalized)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/**
 * The caller's email address as the CRM may store it, or null.
 *
 * The VAPI tool has declared an `email` parameter since the org tools were
 * created (`scripts/voice/create-vapi-org-tools.py`), and this handler read it
 * nowhere — so every address a caller spelled out was discarded, and
 * `crm_contacts.email` is null on every voice-created row. It is the only
 * channel a booking confirmation can travel down.
 *
 * What arrives is TRANSCRIPTION, not a typed field: the agent writes down what
 * it heard. So an address that does not parse is **dropped rather than
 * stored** — a plausible-looking wrong address is worse than none, because
 * every later confirmation goes to it and nothing here reads a bounce
 * (`email-bounces.server.ts` scans a mailbox the voice path never touches).
 */
export function parseContactEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254) return null;
  // Deliberately not RFC 5322. One `@`, no whitespace, and a dotted domain is
  // what separates an address from a mis-heard sentence; the rest of RFC 5322
  // admits shapes no caller ever says out loud.
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(trimmed)) return null;
  return trimmed;
}

async function handleResolveContact(tc: ToolCall, message: Rec): Promise<Record<string, unknown>> {
  const identity = identityFrom(message, tc.args);
  const fullName: string = tc.args.full_name ?? tc.args.fullName ?? "";
  const firstNameArg: string = tc.args.first_name ?? tc.args.firstName ?? "";
  const lastNameArg: string = tc.args.last_name ?? tc.args.lastName ?? "";
  const email = parseContactEmail(tc.args.email);
  const normalized = normalizePhone(identity.callerPhone);

  // 1) Search our CRM by phone.
  let matched: Rec | null = null;
  if (normalized.replace(/\D/g, "").length >= 8) {
    const last9 = normalized.replace(/\D/g, "").slice(-9);
    const { data, error } = await supabaseAdmin
      .from("crm_contacts")
      .select("id, account_id, first_name, last_name, phone, email")
      .not("phone", "is", null)
      .ilike("phone", `%${last9}`)
      .limit(5);
    if (error) console.error("[voice-tools] contact search failed:", error.message);
    matched = (data ?? []).find((c) => phonesMatch(c.phone, identity.callerPhone)) ?? null;
  }

  if (matched) {
    const first = matched.first_name ?? "";
    const full = [matched.first_name, matched.last_name].filter(Boolean).join(" ");
    /*
     * Fill a blank, never overwrite. A stored address was typed by an operator
     * or given in writing; this one was heard over a phone line, so it is the
     * weaker evidence of the two and must not win. The existing value is left
     * exactly as it is even when the caller says something different — that
     * disagreement is for a person to resolve, not for a transcript.
     */
    if (email && !matched.email) {
      const { error: emailError } = await supabaseAdmin
        .from("crm_contacts")
        .update({ email })
        .eq("id", matched.id)
        .is("email", null);
      if (emailError) {
        console.error("[voice-tools] contact email backfill failed:", emailError.message);
      }
    }
    await upsertContext(identity, {
      contact_id: matched.id,
      account_id: matched.account_id,
      first_name: first,
      full_name: full,
      contact_state: "RESOLVED",
      contact_found: true,
      contact_created: false,
      source: "resolve_contact",
    });
    return {
      success: true,
      contactId: matched.id,
      firstName: first,
      fullName: full,
      phone: identity.callerPhone,
      email: matched.email ?? email ?? null,
      contactState: "RESOLVED",
      contactFound: true,
      contactCreated: false,
      nextAction: "continueConversation",
      message: `Existing contact resolved successfully. The caller's first name is ${first}. Use this first name naturally in the next spoken response.`,
    };
  }

  // 2) Unknown caller with no name yet: ask once, then call again with names.
  const anyName = fullName || firstNameArg || lastNameArg;
  if (!anyName) {
    await upsertContext(identity, {
      contact_state: "NEEDS_NAME",
      contact_found: false,
      contact_created: false,
      source: "resolve_contact",
    });
    return {
      success: true,
      contactState: "NEEDS_NAME",
      requiresName: true,
      nextAction: "askForFullName",
      message:
        "No contact matches this number. Ask the caller for their full name once, then call resolve_contact again with the name fields.",
    };
  }

  // 3) Create the contact — an account (lifecycle: lead) plus its person.
  const firstName = firstNameArg || fullName.split(/\s+/)[0];
  const lastName = lastNameArg || fullName.split(/\s+/).slice(1).join(" ") || null;
  const displayName = [firstName, lastName].filter(Boolean).join(" ");

  const { data: account, error: accountError } = await supabaseAdmin
    .from("crm_accounts")
    .insert({
      name: displayName || identity.callerPhone,
      lifecycle_stage: "lead",
      source: "voice_inbound",
      notes: "Created by the inbound voice agent from an unrecognised caller.",
    })
    .select("id")
    .single();
  if (accountError) throw accountError;

  const { data: contact, error: contactError } = await supabaseAdmin
    .from("crm_contacts")
    .insert({
      account_id: account.id,
      first_name: firstName,
      last_name: lastName,
      phone: normalized || identity.callerPhone,
      // Omitted rather than written null when nothing parsed, so the column
      // keeps its own default and a later operator edit is the first writer.
      ...(email ? { email } : {}),
      is_primary: true,
    })
    .select("id")
    .single();
  if (contactError) throw contactError;

  const { data: journey, error: journeyError } = await supabaseAdmin
    .from("crm_client_journeys")
    .insert({
      contact_id: contact.id,
      account_id: account.id,
      stage_key: "applied",
      metadata: { created_by: "voice_inbound" } as Json,
    })
    .select("id")
    .single();
  if (journeyError) console.error("[voice-tools] journey create failed:", journeyError.message);

  // Entering `applied` queues the stage-guarded questionnaire chaser, the
  // same as a board transition would; if the caller completes the BRQ before
  // it dials, the guard cancels it.
  if (journey) {
    try {
      const { fireStageEntryChaser } = await import("@/server/crm-journey.server");
      await fireStageEntryChaser(journey.id, "applied");
    } catch (err) {
      console.error("[voice-tools] stage-entry chaser failed:", (err as Error).message);
    }
  }

  await upsertContext(identity, {
    contact_id: contact.id,
    account_id: account.id,
    first_name: firstName,
    full_name: displayName,
    contact_state: "RESOLVED",
    contact_found: false,
    contact_created: true,
    source: "resolve_contact",
  });

  return {
    success: true,
    contactId: contact.id,
    firstName,
    fullName: displayName,
    phone: identity.callerPhone,
    email: email ?? null,
    contactState: "RESOLVED",
    contactFound: false,
    contactCreated: true,
    nextAction: "continueConversation",
    message: `New contact created. The caller's first name is ${firstName}. Use this first name naturally in the next spoken response.`,
  };
}

async function handleGetCallContext(tc: ToolCall, message: Rec): Promise<Record<string, unknown>> {
  const identity = identityFrom(message, tc.args);
  const ctx = await readContext(identity);
  if (!ctx || !ctx.contact_id) {
    return {
      success: true,
      contextFound: false,
      vapiCallId: identity.vapiCallId,
      callerPhone: identity.callerPhone,
      contactState: "UNRESOLVED",
      handoffReady: false,
      nextAction: "continueWithoutStoredContext",
      message: "No stored caller context found. Continue the conversation and resolve the contact.",
    };
  }
  // The address on file, so a booking specialist handed this caller can check
  // where the calendar invitation will go instead of asking for it cold —
  // `resolve_contact` returns it, and a transfer used to lose it here.
  const { data: contact, error: contactError } = await supabaseAdmin
    .from("crm_contacts")
    .select("email")
    .eq("id", ctx.contact_id)
    .maybeSingle();
  if (contactError) {
    console.error("[voice-tools] get_call_context contact read failed:", contactError.message);
  }
  return {
    success: true,
    contextFound: true,
    vapiCallId: ctx.vapi_call_id,
    callerPhone: ctx.caller_phone,
    contactId: ctx.contact_id,
    firstName: ctx.first_name,
    fullName: ctx.full_name,
    phone: ctx.caller_phone,
    email: parseContactEmail(contact?.email),
    contactState: ctx.contact_state,
    contactFound: ctx.contact_found,
    contactCreated: ctx.contact_created,
    confirmedIntent: ctx.confirmed_intent,
    callerReason: ctx.caller_reason,
    handoffReady: ctx.handoff_ready,
    nextAction: "continueConversation",
    message: `Stored caller context found. The caller's first name is ${ctx.first_name ?? "unknown"}. Use this first name naturally in the next spoken response.`,
  };
}

async function handlePhoneNumberInject(
  tc: ToolCall,
  message: Rec,
): Promise<Record<string, unknown>> {
  const identity = identityFrom(message, tc.args);
  const ctx = await readContext(identity);
  const confirmedIntent =
    tc.args.confirmedIntent ?? tc.args.confirmed_intent ?? ctx?.confirmed_intent ?? null;
  const callerReason = tc.args.callerReason ?? tc.args.caller_reason ?? ctx?.caller_reason ?? null;
  await upsertContext(identity, {
    confirmed_intent: confirmedIntent,
    caller_reason: callerReason,
    handoff_ready: true,
    source: ctx?.source ?? "phone_number_inject",
  });
  return {
    success: true,
    contactId: ctx?.contact_id ?? tc.args.contactId ?? null,
    firstName: ctx?.first_name ?? tc.args.firstName ?? null,
    fullName: ctx?.full_name ?? tc.args.fullName ?? null,
    phone: identity.callerPhone,
    contactState: ctx?.contact_state ?? "UNRESOLVED",
    confirmedIntent,
    callerReason,
    handoffReady: true,
    vapiCallId: identity.vapiCallId,
    nextAction: "handoff_to_assistant",
  };
}

/* ------------------------------ the calendar ------------------------------- */

function spokenSlotOf(start: Date): SpokenSlot {
  return {
    startIso: start.toISOString(),
    endIso: new Date(start.getTime() + BOOKING_WINDOW.slotMinutes * 60_000).toISOString(),
    spoken: slotLabel(start),
  };
}

/** VAPI hands a boolean argument over as JSON `true` or, from some models, as text. */
function argTrue(value: unknown): boolean {
  return value === true || (typeof value === "string" && /^(true|yes|1)$/i.test(value.trim()));
}

type SlotRead =
  | { ok: true; calendar: "calcom" | "local"; slots: Date[] }
  | { ok: false; failure: CalcomFailure };

/**
 * Free slots for one kind of session, soonest first, from whichever calendar
 * this deployment runs on.
 *
 * With `CALCOM_API_KEY` set that is Cal.com, read through `calendar.server.ts`
 * exactly as the Stage 3 scheduler reads it. Without it, the legacy local
 * window checked against `crm_appointments` — unchanged, so deploying this
 * before the key is set changes nothing a caller hears.
 */
async function readFreeSlots(
  kind: AppointmentKind,
  now: Date,
  config: CalcomConfig | null,
): Promise<SlotRead> {
  if (!config) return { ok: true, calendar: "local", slots: await freeSlots(now, 1_000) };
  const read = await calcomFreeSlots(config, kind, now);
  return read.ok ? { ok: true, calendar: "calcom", slots: read.slots } : read;
}

/**
 * Tells the operators that somebody asked for a time and did not get it for a
 * reason that was ours. Returns whether the notice landed, because the agent
 * may only promise "the team has been alerted" when it has been.
 */
async function alertBookingFailure(input: {
  failure: CalcomFailure;
  message: string;
  kind: AppointmentKind;
  who: string;
  requested: SpokenSlot | null;
  phone: string;
  email: string | null;
  vapiCallId: string;
  moving?: string | null;
}): Promise<boolean> {
  const fault = calendarFaultOf(input.failure);
  const label = KIND_LABEL[input.kind];
  const wanted = input.requested ? `${label} at ${input.requested.spoken}` : `a ${label}`;
  const contact = [input.phone, input.email].filter(Boolean).join(" · ") || "no contact details";
  const cause =
    fault === "misconfigured"
      ? `Cal.com refused Mission Control (${input.failure}: ${input.message}). Every booking will ` +
        `fail until CALCOM_API_KEY or the ${label} event type is fixed.`
      : `Cal.com did not answer (${input.failure}: ${input.message}).`;
  return notifyOperators({
    kind: "calendar_booking_failed",
    severity: fault === "misconfigured" ? "error" : "warning",
    title: input.requested
      ? `Booking NOT made: ${input.who} wanted ${wanted}`
      : `The booking calendar could not be read for ${input.who}`,
    body:
      `${cause} ${input.moving ? `They asked to move their ${input.moving} booking. ` : ""}` +
      (input.requested
        ? "The caller was told nothing was booked and that the team would call back."
        : "The caller was told the calendar could not be read, and was offered a call back.") +
      ` Contact: ${contact}.`,
    url: "/voice/calls",
    metadata: {
      failure: input.failure,
      fault,
      kind: input.kind,
      requested_start: input.requested?.startIso ?? null,
      vapi_call_id: input.vapiCallId || null,
    },
  });
}

async function handleCheckAvailability(
  tc: ToolCall,
  message: Rec,
): Promise<Record<string, unknown>> {
  const intent = classifyBookingIntent(
    tc.args.booking_intent_text ?? tc.args.bookingIntentText ?? tc.args.search_reason ?? "",
  );
  if (!intent.kind) {
    return {
      success: false,
      needs_clarification: true,
      clarification_question: intent.clarificationQuestion,
      allowed_booking_types: Object.values(KIND_LABEL),
    };
  }
  const now = new Date();
  const pref = parseSlotPreference(
    tc.args.preferred_date_text ?? tc.args.preferredDateText ?? tc.args.preferred_date ?? "",
    now,
  );
  const read = await readFreeSlots(intent.kind, now, calcomConfig());
  if (!read.ok) {
    // An outage clears itself and would page somebody for every caller; a
    // refused key or a missing event type does not, and nothing else says so.
    if (calendarFaultOf(read.failure) === "misconfigured") {
      const identity = identityFrom(message, tc.args);
      await alertBookingFailure({
        failure: read.failure,
        message: "availability check refused",
        kind: intent.kind,
        who: identity.callerPhone || "A caller",
        requested: null,
        phone: identity.callerPhone,
        email: null,
        vapiCallId: identity.vapiCallId,
      });
    }
    return availabilityUnavailableReply({
      bookingType: KIND_LABEL[intent.kind],
      kind: intent.kind,
      failure: read.failure,
    });
  }
  // Look past the first handful before ordering: the caller's Thursday is
  // often outside the eight soonest slots, and slicing first is what made the
  // preference unhonourable rather than merely unhonoured.
  const ordered = orderSlotsByPreference(read.slots, pref);
  const slots = ordered.slice(0, 8);
  const preferenceMet = pref.recognised && slots.some((s) => slotMatchesPreference(s, pref));
  return {
    success: true,
    calendar: read.calendar,
    booking_type: KIND_LABEL[intent.kind],
    kind: intent.kind,
    timezone: BOOKING_WINDOW.timezone,
    duration_minutes: BOOKING_WINDOW.slotMinutes,
    preference_understood: pref.recognised,
    preference_met: pref.recognised ? preferenceMet : null,
    availability: slots.map((s) => ({
      ...spokenSlotOf(s),
      matches_preference: pref.recognised ? slotMatchesPreference(s, pref) : null,
    })),
    message:
      slots.length === 0
        ? "Nothing is free in the booking window (the next 45 days). Offer to have the team call the customer back instead."
        : pref.recognised && preferenceMet
          ? "Availability returned, preferred times first (Sydney time). Offer only slots from the availability list. Do not create a booking from this tool."
          : pref.recognised
            ? "Availability returned, but nothing free matches what the caller asked for. Say so plainly, then offer the nearest alternatives from the availability list (Sydney time). Do not create a booking from this tool."
            : "Availability returned (Sydney time). Offer only slots from the availability list. Do not create a booking from this tool.",
  };
}

async function handleBookAppointment(tc: ToolCall, message: Rec): Promise<Record<string, unknown>> {
  const identity = identityFrom(message, tc.args);
  const intent = classifyBookingIntent(
    tc.args.booking_intent_text ?? tc.args.bookingIntentText ?? tc.args.booking_type ?? "",
  );
  if (!intent.kind) {
    return {
      success: false,
      needs_clarification: true,
      clarification_question: intent.clarificationQuestion,
      allowed_booking_types: Object.values(KIND_LABEL),
    };
  }
  const startRaw: string = tc.args.startTime ?? tc.args.start_time ?? tc.args.startIso ?? "";
  const startMs = Date.parse(startRaw);
  if (!startRaw || Number.isNaN(startMs)) {
    return {
      success: false,
      needs_clarification: true,
      clarification_question:
        "Which exact time slot should be booked? Pass the startTime from the availability list.",
    };
  }
  const start = new Date(startMs);

  const config = calcomConfig();
  if (config) return bookThroughCalcom({ tc, identity, kind: intent.kind, start, config });

  const stillFree = (await freeSlots(new Date(), 1_000)).some(
    (s) => Math.abs(s.getTime() - start.getTime()) < 60_000,
  );
  if (!stillFree) {
    return {
      success: false,
      appointment_created: false,
      slot_taken: true,
      message:
        "That slot is no longer available. Call check_availability again and offer a fresh slot.",
    };
  }

  const ctx = await readContext(identity);
  if (!ctx?.contact_id || !ctx.account_id) {
    return {
      success: false,
      appointment_created: false,
      message:
        "The caller is not resolved to a contact yet. Call resolve_contact first, then book again.",
    };
  }

  const journeyId = await latestJourneyId(ctx.contact_id);
  const bookedByCallId = await callRowId(identity.vapiCallId);

  const ends = new Date(start.getTime() + BOOKING_WINDOW.slotMinutes * 60_000);
  const { data: appointment, error } = await supabaseAdmin
    .from("crm_appointments")
    .insert({
      account_id: ctx.account_id,
      contact_id: ctx.contact_id,
      journey_id: journeyId,
      kind: intent.kind,
      title: `${KIND_LABEL[intent.kind]} — ${ctx.full_name ?? identity.callerPhone}`,
      starts_at: start.toISOString(),
      ends_at: ends.toISOString(),
      status: "scheduled",
      source: "voice_agent",
      booked_by_call_id: bookedByCallId,
      notes: tc.args.notes ?? null,
    })
    .select("id, starts_at")
    .single();
  if (error) throw error;

  await upsertContext(identity, { confirmed_intent: intent.kind });
  await runBookingConsequences(appointment.id);

  return {
    success: true,
    appointment_created: true,
    appointmentId: appointment.id,
    calendar: "local",
    booking_type: KIND_LABEL[intent.kind],
    startTime: appointment.starts_at,
    timezone: BOOKING_WINDOW.timezone,
    spoken: slotLabel(new Date(appointment.starts_at)),
    message:
      "Booking confirmed in the calendar. Confirm the day and time back to the caller in natural speech.",
  };
}

/**
 * The contact's newest journey, or null.
 *
 * A contact may hold more than one journey, and `.maybeSingle()` ERRORS on
 * that rather than returning a row. The error used to be discarded, so the
 * appointment was written with `journey_id: null` and `onAppointmentScheduled`
 * bailed on exactly that — no stage advance, no confirmation call, no
 * reminder, and no line in the log saying why. Ordering and taking one makes
 * the multi-journey case deterministic instead of fatal, and a read that
 * FAILED is logged rather than mistaken for a contact with no journey.
 */
async function latestJourneyId(contactId: string): Promise<string | null> {
  const { data: journey, error } = await supabaseAdmin
    .from("crm_client_journeys")
    .select("id")
    .eq("contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(
      `[voice-tools] journey read failed for contact ${contactId}: ${error.message} — ` +
        `the booking will be written without a journey, so no confirmation call or reminder is queued`,
    );
  }
  return journey?.id ?? null;
}

async function callRowId(vapiCallId: string): Promise<string | null> {
  if (!vapiCallId) return null;
  const { data, error } = await supabaseAdmin
    .from("voice_calls")
    .select("id")
    .eq("vapi_call_id", vapiCallId)
    .maybeSingle();
  if (error) console.error("[voice-tools] voice call read failed:", error.message);
  return data?.id ?? null;
}

/**
 * Booking consequences (reminder and confirmation calls, the journey advance,
 * the confirmation email and the operator notice) are one code path, shared
 * with manual bookings from the tracker UI.
 *
 * It runs AFTER the booking exists, so it must never throw back into the tool:
 * an exception here used to become `tool_failed`, and the agent then told a
 * caller whose booking had succeeded that it had not — which is how a caller
 * books the same session twice.
 */
async function runBookingConsequences(appointmentId: string): Promise<void> {
  try {
    const { onAppointmentScheduled } = await import("@/server/crm-journey.server");
    await onAppointmentScheduled(appointmentId);
  } catch (err) {
    console.error(
      `[voice-tools] booking consequences failed for appointment ${appointmentId}: ${(err as Error).message}`,
    );
  }
}

type MirroredAppointment = { id: string; starts_at: string; metadata: Json; mirror: CalcomMirror };

/** The contact's next live Cal.com-backed appointment of this kind, or null. */
async function liveCalcomAppointment(
  contactId: string,
  kind: AppointmentKind,
  now: Date,
): Promise<MirroredAppointment | null> {
  const { data, error } = await supabaseAdmin
    .from("crm_appointments")
    .select("id, starts_at, metadata")
    .eq("contact_id", contactId)
    .eq("kind", kind)
    .in("status", ["scheduled", "confirmed"])
    .gte("starts_at", now.toISOString())
    .order("starts_at", { ascending: true })
    .limit(10);
  if (error) {
    // Unknown is not "none", but refusing to book over our own read failure
    // would cost the caller the booking; Cal.com still refuses a clash.
    console.error("[voice-tools] existing-booking read failed:", error.message);
    return null;
  }
  for (const row of data ?? []) {
    const mirror = readCalcomMirror(row.metadata);
    if (mirror) return { id: row.id, starts_at: row.starts_at, metadata: row.metadata, mirror };
  }
  return null;
}

/** The row already mirroring this Cal.com booking, if an earlier attempt wrote one. */
async function appointmentForBookingUid(uid: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("crm_appointments")
    .select("id")
    .eq("metadata->calcom->>uid", uid)
    .limit(1)
    .maybeSingle();
  if (error) console.error("[voice-tools] mirror lookup failed:", error.message);
  return data?.id ?? null;
}

/**
 * The caller's live booking of this kind that Cal.com holds and the CRM does
 * not — one made on the Stage 3 page, or on the event type's own Cal.com
 * link — or null. The addresses are asked in parallel, because this sits on
 * a live call. A read that fails answers null: refusing the booking over our
 * own read would cost the caller it, and Cal.com still refuses a clash.
 */
async function heldInCalendar(
  config: CalcomConfig,
  kind: AppointmentKind,
  candidates: Array<string | null>,
): Promise<{ booking: CalcomBooking; attendeeEmail: string } | null> {
  const emails = [...new Set(candidates.filter((e): e is string => Boolean(e)))];
  const lists = await Promise.all(
    emails.map((attendeeEmail) => listUpcomingCalcomBookings(config, { attendeeEmail })),
  );
  const found = lists.flatMap((listed) => (listed.ok ? listed.value : []));
  const booking = heldBookingOfKind(
    found,
    { slug: CALCOM_EVENT_TYPE_SLUGS[kind], kind },
    emails,
    new Date(),
  );
  if (!booking) return null;
  const attendeeEmail = booking.attendeeEmails.find((e) => emails.includes(e)) ?? emails[0];
  return { booking, attendeeEmail };
}

type CalcomBookingArgs = {
  tc: ToolCall;
  identity: CallIdentity;
  kind: AppointmentKind;
  start: Date;
  config: CalcomConfig;
};

const MOVE_REASON = "Moved by the caller on a call with the Aurixa voice assistant.";

/**
 * `book_appointment` on Cal.com.
 *
 * Cal.com holds the booking and sends the invitation with the video link, so
 * it needs an email address — the one the caller just spelled out, or the one
 * on file. The CRM row it then writes is a mirror (see `CalcomMirror`) that
 * keeps the journey, the reminder calls and the tracker working.
 *
 * A caller who already holds this kind of session is not booked twice —
 * whether the CRM holds it (booked on a call) or only Cal.com does (booked on
 * the Stage 3 page, or on Cal.com's own link). They are asked whether to MOVE
 * it, and a second call with `reschedule_existing` moves it in Cal.com, which
 * issues the updated invitation.
 */
async function bookThroughCalcom(args: CalcomBookingArgs): Promise<Record<string, unknown>> {
  const { tc, identity, kind, start, config } = args;
  const label = KIND_LABEL[kind];
  const requested = spokenSlotOf(start);

  const ctx = await readContext(identity);
  if (!ctx?.contact_id || !ctx.account_id) {
    return {
      success: false,
      appointment_created: false,
      message:
        "The caller is not resolved to a contact yet. Call resolve_contact first, then book again.",
    };
  }
  const contactId: string = ctx.contact_id;
  const accountId: string = ctx.account_id;

  const { data: contact, error: contactError } = await supabaseAdmin
    .from("crm_contacts")
    .select("first_name, last_name, email, phone")
    .eq("id", contactId)
    .maybeSingle();
  if (contactError) {
    console.error("[voice-tools] book_appointment contact read failed:", contactError.message);
  }

  // The address the caller just gave wins for THIS invitation — they asked
  // for it to go there — but it never overwrites the one on file; it only
  // fills a blank, the same rule `resolve_contact` keeps.
  const spokenEmail = parseContactEmail(tc.args.email);
  const email = spokenEmail ?? parseContactEmail(contact?.email);
  if (!email) return needsEmailReply(label);
  if (spokenEmail && contact && !contact.email) {
    const { error: emailError } = await supabaseAdmin
      .from("crm_contacts")
      .update({ email: spokenEmail })
      .eq("id", contactId)
      .is("email", null);
    if (emailError) {
      console.error("[voice-tools] contact email backfill failed:", emailError.message);
    }
  }

  const name =
    [contact?.first_name, contact?.last_name].filter(Boolean).join(" ").trim() ||
    (typeof ctx.full_name === "string" ? ctx.full_name.trim() : "") ||
    (typeof ctx.first_name === "string" ? ctx.first_name.trim() : "") ||
    "Aurixa caller";

  const existing = await liveCalcomAppointment(contactId, kind, new Date());
  if (existing) {
    const existingStart = new Date(existing.starts_at);
    if (Math.abs(existingStart.getTime() - start.getTime()) < 60_000) {
      // Asked for the time they already hold — a retried tool call, or a
      // caller confirming. It IS booked; say so rather than "slot taken".
      await upsertContext(identity, { confirmed_intent: kind });
      return bookedReply({
        appointmentId: existing.id,
        bookingType: label,
        bookingUid: existing.mirror.uid,
        startIso: existingStart.toISOString(),
        timezone: BOOKING_WINDOW.timezone,
        spoken: slotLabel(existingStart),
        email: existing.mirror.attendeeEmail ?? email,
        meetingLink: Boolean(existing.mirror.meetingUrl),
        alreadyConfirmed: true,
      });
    }
    if (!argTrue(tc.args.reschedule_existing ?? tc.args.rescheduleExisting)) {
      return alreadyBookedReply({
        bookingType: label,
        existing: spokenSlotOf(existingStart),
        requestedSpoken: requested.spoken,
      });
    }
    return moveThroughCalcom({ ...args, existing, requested, name, email });
  }

  // Not in the CRM is not the same as not booked. The Stage 3 page already
  // refuses to book a second review over one made on a call; this is the
  // other half of that rule.
  const held = await heldInCalendar(config, kind, [email, parseContactEmail(contact?.email)]);
  if (held) {
    const heldStart = new Date(held.booking.start);
    if (Math.abs(heldStart.getTime() - start.getTime()) < 60_000) {
      await upsertContext(identity, { confirmed_intent: kind });
      return bookedReply({
        appointmentId: await appointmentForBookingUid(held.booking.uid),
        bookingType: label,
        bookingUid: held.booking.uid,
        startIso: heldStart.toISOString(),
        timezone: BOOKING_WINDOW.timezone,
        spoken: slotLabel(heldStart),
        email: held.attendeeEmail,
        meetingLink: Boolean(held.booking.meetingUrl),
        alreadyConfirmed: true,
      });
    }
    if (!argTrue(tc.args.reschedule_existing ?? tc.args.rescheduleExisting)) {
      return alreadyBookedReply({
        bookingType: label,
        existing: spokenSlotOf(heldStart),
        requestedSpoken: requested.spoken,
      });
    }
    return moveCalendarOnlyBooking({ ...args, held, requested, name });
  }

  const created = await createCalcomBooking(config, {
    kind,
    start,
    attendee: {
      name,
      email,
      timeZone: tc.args.timezone ?? tc.args.time_zone ?? tc.args.timeZone ?? null,
      phone: identity.callerPhone || contact?.phone || null,
    },
    notes: typeof tc.args.notes === "string" ? tc.args.notes : null,
    metadata: {
      source: "voice_agent",
      kind,
      contactId,
      accountId,
      vapiCallId: identity.vapiCallId || null,
    },
  });

  let booking: CalcomBooking | null = created.ok ? created.value : null;
  let recovered = false;
  if (!created.ok && created.failure !== "auth" && created.failure !== "not_found") {
    // A timeout may have written the booking, and a "not available" may be
    // the caller's OWN booking from an attempt whose answer was lost. Either
    // way the honest reply depends on what Cal.com now holds for them.
    booking = await findLiveCalcomBooking(config, email, start);
    recovered = booking !== null;
  }

  if (!booking) {
    const failure: CalcomFailure = created.ok ? "unavailable" : created.failure;
    if (failure === "slot_unavailable") {
      const fresh = await readFreeSlots(kind, new Date(), config);
      return slotTakenReply({
        requestedSpoken: requested.spoken,
        alternatives: fresh.ok ? nearestAlternatives(fresh.slots, start).map(spokenSlotOf) : [],
      });
    }
    const alerted = await alertBookingFailure({
      failure,
      message: created.ok ? "" : created.message,
      kind,
      who: name,
      requested,
      phone: identity.callerPhone,
      email,
      vapiCallId: identity.vapiCallId,
    });
    return bookingNotConfirmedReply({
      requestedSpoken: requested.spoken,
      operatorsAlerted: alerted,
    });
  }

  // The booking exists in Cal.com and the invitation has gone. Everything
  // below is bookkeeping, and none of it may turn a real booking into a
  // reported failure.
  const bookedStart = new Date(booking.start);
  let appointmentId = recovered ? await appointmentForBookingUid(booking.uid) : null;
  if (!appointmentId) {
    const journeyId = await latestJourneyId(contactId);
    const bookedByCallId = await callRowId(identity.vapiCallId);
    const { data: appointment, error: insertError } = await supabaseAdmin
      .from("crm_appointments")
      .insert({
        account_id: accountId,
        contact_id: contactId,
        journey_id: journeyId,
        kind,
        title: `${label} — ${name}`,
        starts_at: booking.start,
        ends_at: booking.end,
        status: "scheduled",
        source: "voice_agent",
        booked_by_call_id: bookedByCallId,
        notes: typeof tc.args.notes === "string" ? tc.args.notes : null,
        metadata: { calcom: mirrorFromBooking(booking, email) } as unknown as Json,
      })
      .select("id")
      .single();
    if (insertError) {
      console.error(
        `[voice-tools] Cal.com booking ${booking.uid} made but its CRM record failed: ${insertError.message}`,
      );
      await notifyOperators({
        kind: "calendar_booking_failed",
        severity: "warning",
        title: `${name} is booked in Cal.com but not in the CRM`,
        body:
          `${label}, ${slotLabel(bookedStart)} (Sydney time). The Cal.com booking and its ` +
          `invitation stand, but the CRM record failed (${insertError.message}), so no reminder ` +
          `or confirmation call is queued. Add it in the tracker.`,
        url: "/crm",
        metadata: { calcom_uid: booking.uid, contact_id: contactId },
      });
    } else {
      appointmentId = appointment.id;
      await runBookingConsequences(appointment.id);
    }
  }

  await upsertContext(identity, { confirmed_intent: kind });
  return bookedReply({
    appointmentId,
    bookingType: label,
    bookingUid: booking.uid,
    startIso: bookedStart.toISOString(),
    timezone: BOOKING_WINDOW.timezone,
    spoken: slotLabel(bookedStart),
    email,
    meetingLink: Boolean(booking.meetingUrl),
    alreadyConfirmed: recovered,
  });
}

/** Moves the caller's existing Cal.com booking to the requested start. */
async function moveThroughCalcom(
  args: CalcomBookingArgs & {
    existing: MirroredAppointment;
    requested: SpokenSlot;
    name: string;
    email: string;
  },
): Promise<Record<string, unknown>> {
  const { identity, kind, start, config, existing, email } = args;
  const label = KIND_LABEL[kind];
  const previousStart = new Date(existing.starts_at);
  const previousSpoken = slotLabel(previousStart);

  const moved = await rescheduleCalcomBooking(config, existing.mirror.uid, start, MOVE_REASON);
  if (!moved.ok) {
    return moveRefused({ ...args, failure: moved.failure, message: moved.message, previousSpoken });
  }

  const booking = moved.value;
  const metadata =
    existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {};
  // Compare-and-set on the old start: the Cal.com webhook reports the same
  // move and may land first. Whichever writes second changes nothing, so the
  // reminder is moved and the operators are told exactly once.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("crm_appointments")
    .update({
      starts_at: booking.start,
      ends_at: booking.end,
      status: "scheduled",
      metadata: {
        ...metadata,
        calcom: mirrorFromBooking(booking, email, existing.mirror),
      } as unknown as Json,
    })
    .eq("id", existing.id)
    .eq("starts_at", existing.starts_at)
    .select("id");
  if (updateError) {
    console.error(
      `[voice-tools] Cal.com booking moved to ${booking.uid} but the CRM record did not follow: ${updateError.message}`,
    );
  } else if ((updated ?? []).length > 0) {
    try {
      const { onAppointmentRescheduled } = await import("@/server/crm-journey.server");
      await onAppointmentRescheduled(existing.id, previousStart.toISOString(), "voice_agent");
    } catch (err) {
      console.error(
        `[voice-tools] reschedule consequences failed for ${existing.id}: ${(err as Error).message}`,
      );
    }
  }

  await upsertContext(identity, { confirmed_intent: kind });
  const newStart = new Date(booking.start);
  return rescheduledReply({
    appointmentId: existing.id,
    bookingType: label,
    bookingUid: booking.uid,
    startIso: newStart.toISOString(),
    timezone: BOOKING_WINDOW.timezone,
    spoken: slotLabel(newStart),
    previousSpoken,
    email: existing.mirror.attendeeEmail ?? email,
  });
}

/**
 * What the caller hears when a move did not happen. Their existing booking
 * stands either way, and every reply says so.
 */
async function moveRefused(
  args: CalcomBookingArgs & {
    failure: CalcomFailure;
    message: string;
    requested: SpokenSlot;
    previousSpoken: string;
    name: string;
    email: string;
  },
): Promise<Record<string, unknown>> {
  const { identity, kind, start, config, failure, requested, previousSpoken, name, email } = args;
  if (failure === "slot_unavailable") {
    const fresh = await readFreeSlots(kind, new Date(), config);
    return slotTakenReply({
      requestedSpoken: requested.spoken,
      alternatives: fresh.ok ? nearestAlternatives(fresh.slots, start).map(spokenSlotOf) : [],
      existingKept: previousSpoken,
    });
  }
  const alerted = await alertBookingFailure({
    failure,
    message: args.message,
    kind,
    who: name,
    requested,
    phone: identity.callerPhone,
    email,
    vapiCallId: identity.vapiCallId,
    moving: previousSpoken,
  });
  return bookingNotConfirmedReply({
    requestedSpoken: requested.spoken,
    operatorsAlerted: alerted,
    existingKept: previousSpoken,
  });
}

/**
 * Moves a booking the CRM has never held — made on the Stage 3 page, or on
 * the event type's own Cal.com link. Cal.com sends the updated invitation.
 * Nothing is written here: the booking stays where it was made, and the
 * Cal.com webhook tells the operators about the move, as it does for every
 * change to a booking outside the CRM.
 */
async function moveCalendarOnlyBooking(
  args: CalcomBookingArgs & {
    held: { booking: CalcomBooking; attendeeEmail: string };
    requested: SpokenSlot;
    name: string;
  },
): Promise<Record<string, unknown>> {
  const { identity, kind, start, config, held } = args;
  const previousSpoken = slotLabel(new Date(held.booking.start));
  const moved = await rescheduleCalcomBooking(config, held.booking.uid, start, MOVE_REASON);
  if (!moved.ok) {
    return moveRefused({
      ...args,
      failure: moved.failure,
      message: moved.message,
      previousSpoken,
      email: held.attendeeEmail,
    });
  }
  await upsertContext(identity, { confirmed_intent: kind });
  const newStart = new Date(moved.value.start);
  return rescheduledReply({
    appointmentId: null,
    bookingType: KIND_LABEL[kind],
    bookingUid: moved.value.uid,
    startIso: newStart.toISOString(),
    timezone: BOOKING_WINDOW.timezone,
    spoken: slotLabel(newStart),
    previousSpoken,
    email: held.attendeeEmail,
  });
}

/* ------------------------------ entry points ------------------------------- */

// ── Support tickets ─────────────────────────────────────────────────────
//
// The Support assistant used to have no way to raise one. It was bound to
// `resolve_contact` and `get_call_context` and its prompt told it to point the
// caller at the portal, so a call could describe a production problem in full
// and leave no record anywhere.
//
// The ticket pipeline is in this same app, so this calls it IN PROCESS rather
// than over HTTP: `ingestSupportTicket` owns validation, the rate limit, the
// P0-P4 classification, the audit events, the operator notification and the
// self-healing planner, and none of that is re-implemented here. What this
// adds is the translation from what a person says to what the schema demands.

/**
 * Where a voice-raised ticket is filed. `resolveWorkspace` tolerates a slug it
 * does not know and files it at prime scope, which is the right home for calls
 * to Aurixa's own reception line: the caller is phoning Aurixa, not logging in
 * to a tenant workspace.
 */
const VOICE_TICKET_WORKSPACE = "aurixa-voice";

/**
 * Walk the same authentication ladder `verifySupportAuth` walks, from the
 * inside. This is the same process holding the same database credential, so
 * signing is not a bypass — it means a ticket raised by phone is recorded
 * `verified` exactly like one raised through the portal, rather than being
 * marked unverified for the sole reason that it did not arrive over the wire.
 */
async function supportIntakeAuthHeaders(rawBody: string): Promise<Record<string, string>> {
  const { data: source } = await supabaseAdmin
    .from("security_intake_sources")
    .select("hmac_secret")
    .eq("slug", SUPPORT_SOURCE_SLUG)
    .maybeSingle();
  if (source?.hmac_secret) {
    const { intakeSignatureHeader } = await import("@/server/security-intake/signature");
    return { "x-support-signature": await intakeSignatureHeader(rawBody, source.hmac_secret) };
  }
  const shared = process.env.SUPPORT_INGEST_SECRET;
  return shared ? { "x-aurixa-support-secret": shared } : {};
}

async function handleRaiseSupportTicket(tc: ToolCall, message: Rec): Promise<Record<string, unknown>> {
  const identity = identityFrom(message, tc.args);
  const ctx = await readContext(identity);

  // The caller's own words, mapped to the contract by one pure module. It is
  // total: an unrecognised report becomes other/none rather than an error,
  // because a miscategorised ticket is recoverable and a lost one is not.
  const draft = draftTicketFromSpeech({
    summary: tc.args.summary,
    detail: tc.args.detail,
    what_is_broken: tc.args.what_is_broken ?? tc.args.whatIsBroken,
    since_when: tc.args.since_when ?? tc.args.sinceWhen,
  });

  // An address the caller spelled out is only used when it parses; otherwise
  // the contact record is the better source. Reading an email back over the
  // phone is the most fragile step in this flow, so it is the fallback rather
  // than the first resort.
  let email = usableEmail(tc.args.email);
  let reporterName: string | null =
    (typeof ctx?.full_name === "string" ? ctx.full_name : null) ??
    (typeof ctx?.first_name === "string" ? ctx.first_name : null);

  if (ctx?.contact_id) {
    const { data: contact, error } = await supabaseAdmin
      .from("crm_contacts")
      .select("email, first_name, last_name")
      .eq("id", ctx.contact_id)
      .maybeSingle();
    if (error) {
      // A read that FAILED is not a contact without an email. Say so rather
      // than sending the caller down the spell-it-out path for our fault.
      console.error("[voice-tools] raise_support_ticket contact read failed:", error.message);
    }
    if (!email) email = usableEmail(contact?.email as string | undefined);
    if (!reporterName && contact) {
      const joined = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
      reporterName = joined || null;
    }
  }

  if (!email) {
    return {
      success: false,
      ticket_created: false,
      needs_email: true,
      clarification_question:
        "What is the best email address for the team to reply to? Ask the caller to say it, " +
        "then repeat it back to them before calling this tool again.",
      message: "No email address on file for this caller and none was supplied.",
    };
  }

  const payload = {
    version: 1 as const,
    workspace_id: VOICE_TICKET_WORKSPACE,
    reporter_email: email,
    reporter_name: reporterName,
    category: draft.category,
    breakage_vector: draft.breakage_vector,
    subject: draft.subject,
    description: draft.description,
    client_meta: {
      source: "voice",
      url: `vapi:call/${identity.vapiCallId ?? "unknown"}`,
      user_agent: `aurixa-voice/${typeof message.call?.assistantId === "string" ? message.call.assistantId : "assistant"}`,
    },
  };

  const rawBody = JSON.stringify(payload);
  let outcome: { status: number; body: Record<string, unknown> };
  try {
    outcome = await ingestSupportTicket(
      new Request("https://mission-control.aurixasystems.com.au/api/public/support/tickets", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(await supportIntakeAuthHeaders(rawBody)),
        },
        body: rawBody,
      }),
    );
  } catch (err) {
    console.error("[voice-tools] raise_support_ticket ingest threw:", (err as Error).message);
    return {
      success: false,
      ticket_created: false,
      message:
        "The ticket could not be lodged. Tell the caller it has NOT been logged and that they " +
        "can raise it on the support portal, and do not give them a reference.",
    };
  }

  const reference = typeof outcome.body?.reference === "string" ? outcome.body.reference : null;
  if (outcome.status >= 200 && outcome.status < 300 && reference) {
    return {
      success: true,
      ticket_created: true,
      reference,
      priority: outcome.body?.priority ?? null,
      category: draft.category,
      message:
        `Ticket ${reference} has been raised. Read the reference back to the caller, letting ` +
        `them know the team will reply to ${email}.`,
    };
  }

  // Anything else is a refusal, and the caller must not be told otherwise.
  // A rate limit and a validation failure send an operator to different
  // remedies, so the status is carried back rather than flattened.
  console.error(
    `[voice-tools] raise_support_ticket refused: ${outcome.status} ${JSON.stringify(outcome.body).slice(0, 300)}`,
  );
  return {
    success: false,
    ticket_created: false,
    status: outcome.status,
    message:
      "The ticket was NOT lodged. Apologise, tell the caller it has not been logged, and offer " +
      "to put them through to the team or point them at the support portal. Do not invent a reference.",
  };
}

export async function handleToolCalls(message: Rec): Promise<Rec> {
  const calls = extractToolCalls(message);
  const results: Array<{ toolCallId: string; result: string }> = [];
  for (const tc of calls) {
    let result: Record<string, unknown>;
    try {
      switch (tc.name) {
        case "resolve_contact":
        case "ghl_resolve_contact":
          result = await handleResolveContact(tc, message);
          break;
        case "get_call_context":
          result = await handleGetCallContext(tc, message);
          break;
        case "phoneNumber_inject":
        case "phone_number_inject":
          result = await handlePhoneNumberInject(tc, message);
          break;
        case "check_availability":
          result = await handleCheckAvailability(tc, message);
          break;
        case "book_appointment":
          result = await handleBookAppointment(tc, message);
          break;
        case "raise_support_ticket":
          result = await handleRaiseSupportTicket(tc, message);
          break;
        default:
          result = { success: false, error: `unknown_tool_${tc.name}` };
      }
    } catch (err) {
      console.error(`[voice-tools] ${tc.name} failed:`, (err as Error).message);
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

/* ------------------------------ handoff router ----------------------------- */

export type HandoffIntent = "review" | "solutions" | "support";

/** Deterministic transcript classifier for squad handoffs. */
export function classifyHandoffIntent(transcriptText: string): HandoffIntent {
  const t = transcriptText.toLowerCase();
  const scores: Record<HandoffIntent, number> = { review: 0, solutions: 0, support: 0 };
  for (const m of t.matchAll(
    /support|broken|error|not working|issue|ticket|outage|bug|help with my account/g,
  )) {
    void m;
    scores.support += 1;
  }
  for (const m of t.matchAll(
    /pricing|price|cost|module|capabilit|feature|integrat|platform|demo|how does|what does/g,
  )) {
    void m;
    scores.solutions += 1;
  }
  for (const m of t.matchAll(
    /book|schedule|review|appointment|reschedul|time slot|calendar|application/g,
  )) {
    void m;
    scores.review += 1;
  }
  const best = (Object.entries(scores) as Array<[HandoffIntent, number]>).sort(
    (a, b) => b[1] - a[1],
  )[0];
  return best[1] > 0 ? best[0] : "solutions";
}

const HANDOFF_ROLE: Record<HandoffIntent, string> = {
  review: "handoff_review",
  solutions: "handoff_solutions",
  support: "handoff_support",
};

/**
 * Answer an assistant-request / transfer webhook: pick the specialist
 * assistant and re-inject the stored context as variableValues.
 *
 * **The two message kinds want different bodies, and this answered only one.**
 * `voice-webhook.server.ts` routes `assistant-request` AND
 * `transfer-destination-request` here and returns whatever comes back as the
 * whole HTTP body. An `assistant-request` is answered with the assistant to
 * run — `{ assistantId, assistantOverrides }`. A `transfer-destination-request`
 * is answered with where to send the call — `{ destination: { type, ... } }` —
 * and VAPI cannot read the first shape as the second. Both branches used to
 * return the first, so the transfer path would have failed on a body that
 * looked healthy from this end.
 *
 * Neither kind is reachable today: VAPI sends them only when they are listed
 * in an assistant's `serverMessages`, and nothing in this repository sets that
 * (the Front Desk prompt transfers by squad-member name, which VAPI resolves
 * locally without asking anyone). This is a correctness fix for the day that
 * changes, not a switch. Turning it on additionally needs `serverMessages` on
 * the assistants and a prompt that stops the silent by-name transfer — which
 * would replace a path that is proven working, so it is a separate decision.
 */
export async function routeHandoff(message: Rec): Promise<Rec | null> {
  const call = asRecord(message.call);
  const identity: CallIdentity = {
    vapiCallId: call.id ?? "",
    callerPhone: asRecord(message.customer).number ?? asRecord(call.customer).number ?? "",
  };
  const ctx = await readContext(identity);

  const artifact = asRecord(message.artifact);
  const transcriptText: string = Array.isArray(artifact.messagesOpenAIFormatted)
    ? artifact.messagesOpenAIFormatted
        .map((m: Rec) => (typeof m.content === "string" ? m.content : ""))
        .join("\n")
    : (artifact.transcript ?? message.transcript ?? "");

  const bookingIntents = new Set([
    "strategic_review",
    "discovery_session",
    "guided_demo",
    "enterprise_consultation",
    "kickoff",
  ]);
  const intent: HandoffIntent =
    ctx?.confirmed_intent && bookingIntents.has(ctx.confirmed_intent)
      ? "review"
      : ctx?.confirmed_intent === "support"
        ? "support"
        : classifyHandoffIntent(transcriptText);

  const { data: agent, error } = await supabaseAdmin
    .from("voice_agents")
    .select("vapi_assistant_id, name")
    .eq("role", HANDOFF_ROLE[intent])
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.error("[voice-tools] handoff agent read failed:", error.message);
    return null;
  }
  if (!agent) return null;

  const now = new Date();
  const variableValues = {
    firstName: ctx?.first_name ?? "",
    fullName: ctx?.full_name ?? "",
    contactId: ctx?.contact_id ?? "",
    callerPhone: identity.callerPhone,
    currentDate: now.toISOString(),
    currentDateUnix: Math.floor(now.getTime() / 1000),
  };

  if (message.type === "transfer-destination-request") {
    /*
     * A transfer destination names a squad member BY NAME — the assistant id
     * is not the key here, which is why `name` is selected above. An agent row
     * with no name cannot be transferred to, and answering with a nameless
     * destination would be a body VAPI rejects, so this refuses instead and
     * the webhook reports `no_handoff_destination_configured`.
     */
    const assistantName: string = agent.name ?? "";
    if (!assistantName) {
      console.error(
        `[voice-tools] handoff agent ${agent.vapi_assistant_id} has no name, ` +
          "so there is no destination to transfer to",
      );
      return null;
    }
    return {
      destination: {
        type: "assistant",
        assistantName,
        description: `Handoff to the ${intent} specialist.`,
      },
      // The overrides ride along so the specialist opens holding the same
      // context the caller already gave, exactly as on the other branch.
      assistantOverrides: { variableValues },
    };
  }

  return {
    assistantId: agent.vapi_assistant_id,
    assistantOverrides: { variableValues },
  };
}
