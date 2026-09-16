// The tools an inbound VAPI assistant can call mid-conversation, answered
// synchronously from our own CRM — the re-homing of everything GoHighLevel
// used to do for the squad: contact resolution, the call-context store,
// calendar availability, booking, the context bridge and handoff routing.
//
// Every reply is the VAPI tool-result envelope:
//   { results: [{ toolCallId, result: "<stringified JSON>" }] }
// VAPI matches results to calls by id; a bare JSON body is silently ignored.
//
// Availability is deterministic, not model-resolved: the strategic-review
// booking rules are code here (see BOOKING_WINDOW — Mon–Fri 09:00–16:30
// Australia/Sydney, 30-minute slots, 24 hours' notice, 45 days ahead), so a
// promise like "we can do Tuesday at 3" never depends on a model's date
// arithmetic. That constant is the authority; this comment used to quote the
// NPC window it replaced, which is how a reader comes to trust the wrong hours.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { normalizePhone, phonesMatch } from "@/server/voice.server";

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
 * Every field is independently optional and a slot must satisfy all the ones
 * that are set. `recognised` is false when nothing was understood, and that
 * is the signal to leave the ordering exactly as it was.
 */
export type SlotPreference = {
  weekday: number | null;
  dayOfMonth: number | null;
  month: number | null;
  partOfDay: "morning" | "afternoon" | null;
  recognised: boolean;
};

const WEEKDAY_WORDS: Array<[RegExp, number]> = [
  [/\bsun(day)?\b/, 0],
  [/\bmon(day)?\b/, 1],
  [/\btue(s|sday)?\b/, 2],
  [/\bwed(s|nesday)?\b/, 3],
  [/\bthu(r|rs|rsday)?\b/, 4],
  [/\bfri(day)?\b/, 5],
  [/\bsat(urday)?\b/, 6],
];

const MONTH_WORDS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * Parse the caller's day preference. Deliberately narrow: a weekday name, a
 * relative day, a day-of-month with an optional month, and morning/afternoon.
 * Anything else is left unrecognised rather than guessed — an invented
 * preference silently reorders what the caller is offered.
 */
export function parseSlotPreference(
  text: string | null | undefined,
  now: Date = new Date(),
): SlotPreference {
  const pref: SlotPreference = {
    weekday: null,
    dayOfMonth: null,
    month: null,
    partOfDay: null,
    recognised: false,
  };
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return pref;

  // Relative days resolve to an absolute Sydney date, because "tomorrow" said
  // at 11pm Sydney is a different date from "tomorrow" said at 9am UTC.
  const relativeDays = /\bday after tomorrow\b/.test(t)
    ? 2
    : /\btomorrow\b/.test(t)
      ? 1
      : /\btoday\b/.test(t)
        ? 0
        : null;
  if (relativeDays !== null) {
    const p = sydneyParts(new Date(now.getTime() + relativeDays * 24 * 60 * 60_000));
    pref.dayOfMonth = p.d;
    pref.month = p.m;
    pref.recognised = true;
  } else {
    for (const [re, day] of WEEKDAY_WORDS) {
      if (re.test(t)) {
        pref.weekday = day;
        pref.recognised = true;
        break;
      }
    }
    // "the 18th", "18 September", "18/9"
    const dom = /\b(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:am|pm|:|o'?clock))/.exec(t);
    // The full name or its three-letter form, both whole words — `\bmay` alone
    // reads "maybe" as May.
    const monthIndex = MONTH_WORDS.findIndex((m) =>
      new RegExp(`\\b(${m}|${m.slice(0, 3)})\\b`).test(t),
    );
    if (dom) {
      const n = Number(dom[1]);
      if (n >= 1 && n <= 31) {
        pref.dayOfMonth = n;
        pref.recognised = true;
        if (monthIndex >= 0) pref.month = monthIndex + 1;
      }
    }
  }

  if (/\bmorning\b|\bbefore lunch\b|\bam\b/.test(t)) {
    pref.partOfDay = "morning";
    pref.recognised = true;
  } else if (/\bafternoon\b|\bafter lunch\b|\bpm\b|\blate in the day\b/.test(t)) {
    pref.partOfDay = "afternoon";
    pref.recognised = true;
  }

  return pref;
}

/** Does this slot satisfy every constraint the caller actually stated? */
export function slotMatchesPreference(slot: Date, pref: SlotPreference): boolean {
  if (!pref.recognised) return false;
  const p = sydneyParts(slot);
  if (pref.weekday !== null && p.day !== pref.weekday) return false;
  if (pref.dayOfMonth !== null && p.d !== pref.dayOfMonth) return false;
  if (pref.month !== null && p.m !== pref.month) return false;
  if (pref.partOfDay === "morning" && p.minutes >= 12 * 60) return false;
  if (pref.partOfDay === "afternoon" && p.minutes < 12 * 60) return false;
  return true;
}

/**
 * Preferred slots first, everything else after, each half still in time order.
 *
 * A SORT, never a filter — the same rule the prime repo's image ordering
 * answers to. A caller who asks for Thursday and has no Thursday free must
 * still be offered something, and an agent that goes quiet because the
 * preference could not be met is worse than one that says "Thursday is full,
 * but I have Wednesday at two".
 *
 * An unrecognised preference returns the input untouched, so the no-preference
 * path is byte-identical to what it was.
 */
export function orderSlotsByPreference(slots: Date[], pref: SlotPreference): Date[] {
  if (!pref.recognised) return slots;
  const preferred: Date[] = [];
  const rest: Date[] = [];
  for (const s of slots) (slotMatchesPreference(s, pref) ? preferred : rest).push(s);
  return [...preferred, ...rest];
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
  return {
    success: true,
    contextFound: true,
    vapiCallId: ctx.vapi_call_id,
    callerPhone: ctx.caller_phone,
    contactId: ctx.contact_id,
    firstName: ctx.first_name,
    fullName: ctx.full_name,
    phone: ctx.caller_phone,
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

async function handleCheckAvailability(tc: ToolCall): Promise<Record<string, unknown>> {
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
  // Look past the first handful before ordering: the caller's Thursday is
  // often outside the eight soonest slots, and slicing first is what made the
  // preference unhonourable rather than merely unhonoured.
  const all = await freeSlots(now, 200);
  const ordered = orderSlotsByPreference(all, pref);
  const slots = ordered.slice(0, 8);
  const preferenceMet = pref.recognised && slots.some((s) => slotMatchesPreference(s, pref));
  return {
    success: true,
    booking_type: KIND_LABEL[intent.kind],
    kind: intent.kind,
    timezone: BOOKING_WINDOW.timezone,
    duration_minutes: BOOKING_WINDOW.slotMinutes,
    preference_understood: pref.recognised,
    preference_met: pref.recognised ? preferenceMet : null,
    availability: slots.map((s) => ({
      startIso: s.toISOString(),
      endIso: new Date(s.getTime() + BOOKING_WINDOW.slotMinutes * 60_000).toISOString(),
      spoken: slotLabel(s),
      matches_preference: pref.recognised ? slotMatchesPreference(s, pref) : null,
    })),
    message:
      slots.length === 0
        ? "No slots are free in the next week. Offer to have the team call the customer back instead."
        : pref.recognised && preferenceMet
          ? "Availability returned, preferred times first. Offer only slots from the availability list. Do not create a booking from this tool."
          : pref.recognised
            ? "Availability returned, but nothing free matches what the caller asked for. Say so plainly, then offer the nearest alternatives from the availability list. Do not create a booking from this tool."
            : "Availability returned. Offer only slots from the availability list. Do not create a booking from this tool.",
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
  const stillFree = (await freeSlots(new Date(), 200)).some(
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

  // A contact may hold more than one journey, and `.maybeSingle()` ERRORS on
  // that rather than returning a row. The error used to be discarded, so
  // `journey` came back null, the appointment was written with
  // `journey_id: null`, and `onAppointmentScheduled` bailed on exactly that —
  // no stage advance, no confirmation call, no reminder, and no line in the
  // log saying why. The booking still appeared in the calendar, so the whole
  // cadence failed invisibly.
  //
  // Ordering and taking one makes the multi-journey case deterministic
  // instead of fatal, and the error is now read rather than dropped: a read
  // that FAILED is not a row that is ABSENT.
  const { data: journey, error: journeyError } = await supabaseAdmin
    .from("crm_client_journeys")
    .select("id")
    .eq("contact_id", ctx.contact_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (journeyError) {
    console.error(
      `[voice-tools] journey read failed for contact ${ctx.contact_id}: ${journeyError.message} — ` +
        `the booking will be written without a journey, so no confirmation call or reminder is queued`,
    );
  }

  const { data: callRow } = await supabaseAdmin
    .from("voice_calls")
    .select("id")
    .eq("vapi_call_id", identity.vapiCallId)
    .maybeSingle();

  const ends = new Date(start.getTime() + BOOKING_WINDOW.slotMinutes * 60_000);
  const { data: appointment, error } = await supabaseAdmin
    .from("crm_appointments")
    .insert({
      account_id: ctx.account_id,
      contact_id: ctx.contact_id,
      journey_id: journey?.id ?? null,
      kind: intent.kind,
      title: `${KIND_LABEL[intent.kind]} — ${ctx.full_name ?? identity.callerPhone}`,
      starts_at: start.toISOString(),
      ends_at: ends.toISOString(),
      status: "scheduled",
      source: "voice_agent",
      booked_by_call_id: callRow?.id ?? null,
      notes: tc.args.notes ?? null,
    })
    .select("id, starts_at")
    .single();
  if (error) throw error;

  await upsertContext(identity, { confirmed_intent: intent.kind });

  // Booking consequences (reminder / confirmation calls, journey advance) are
  // one code path, shared with manual bookings from the tracker UI.
  const { onAppointmentScheduled } = await import("@/server/crm-journey.server");
  await onAppointmentScheduled(appointment.id);

  return {
    success: true,
    appointment_created: true,
    appointmentId: appointment.id,
    booking_type: KIND_LABEL[intent.kind],
    startTime: appointment.starts_at,
    timezone: BOOKING_WINDOW.timezone,
    spoken: slotLabel(new Date(appointment.starts_at)),
    message:
      "Booking confirmed in the calendar. Confirm the day and time back to the caller in natural speech.",
  };
}

/* ------------------------------ entry points ------------------------------- */

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
          result = await handleCheckAvailability(tc);
          break;
        case "book_appointment":
          result = await handleBookAppointment(tc, message);
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
