// Cal.com is the one calendar every Aurixa booking path shares: the voice
// fleet's `check_availability` / `book_appointment` tools and the Stage 3
// strategic-review scheduler on the waitlist site.
//
// Before this, those were two private calendars that could not see each
// other. The voice tools computed slots from a hard-coded weekly window and
// checked them against `crm_appointments`; the website computed its own slots
// from its own copy of the window and posted the chosen time to a Make
// scenario that wrote Airtable. Neither read the other's store, so the same
// half-hour could be promised to a caller and an applicant, and neither path
// ever produced a meeting link. Cal.com answers availability against real
// bookings from every source, holds the booking, and issues the video link and
// the calendar invitation.
//
// This module is the half that needs no network: which event type a kind of
// appointment is, how a slots answer is read, how a booking request is
// composed, how a booking answer is read, how a refusal is classified, and how
// a webhook is verified and read. `calcom.server.ts` does the fetching.
//
// Wire facts, pinned against the live account on 24 Sep 2026 rather than
// assumed:
//
//  - `GET /v2/slots` (cal-api-version 2024-09-04) takes `start`/`end` in UTC
//    and answers `{ status: "success", data: { "YYYY-MM-DD": [{ start, end }] } }`,
//    keyed by day IN THE REQUESTED `timeZone`, each instant ISO-8601 WITH its
//    offset (`2026-09-28T09:00:00.000+10:00`). An empty `data` is a real
//    answer — nothing free — and is not the same thing as an unreadable one.
//  - The account's schedule (Mon–Fri 09:00–17:00 Australia/Sydney) with a
//    30-minute event gives starts 09:00 … 16:30. Minimum notice (24 h) and the
//    booking window (45 calendar days) are enforced by Cal.com on the event
//    types themselves, so nothing here re-implements them.
//  - `POST /v2/bookings` (cal-api-version 2026-02-25) takes `start` in UTC and
//    an `attendee` with `name` and `timeZone` required. Availability and the
//    booking window are enforced server-side unless explicitly bypassed, and
//    nothing here ever bypasses them. `metadata` is at most 50 keys, keys at
//    most 40 characters, string values at most 500.
import { createHmac, timingSafeEqual } from "node:crypto";

export const CALCOM_API_BASE = "https://api.cal.com/v2";
/** The version `GET /v2/slots` was pinned against. */
export const CALCOM_SLOTS_API_VERSION = "2024-09-04";
/** The version `POST /v2/bookings`, cancel and list were pinned against. */
export const CALCOM_BOOKINGS_API_VERSION = "2026-02-25";
/** The Cal.com user every Aurixa event type belongs to. */
export const CALCOM_DEFAULT_USERNAME = "aurixasystems";
/** Where the host works. A booking's wall-clock times are spoken in this zone. */
export const CALCOM_HOST_TIME_ZONE = "Australia/Sydney";
/** Every Aurixa event type is thirty minutes; used only when an answer omits `end`. */
export const CALCOM_DEFAULT_DURATION_MINUTES = 30;

export type CalcomKind =
  | "strategic_review"
  | "discovery_session"
  | "guided_demo"
  | "enterprise_consultation"
  | "kickoff";

/**
 * Appointment kind → the Cal.com event type that books it.
 *
 * Slugs rather than numeric ids: an event type that is deleted and recreated
 * keeps its slug and gets a new id, and a slug says what it is in a log line.
 * The five types were created on the `aurixasystems` account on 24 Sep 2026,
 * all hidden from the public profile, 30 minutes, cal-video.
 */
export const CALCOM_EVENT_TYPE_SLUGS: Record<CalcomKind, string> = {
  strategic_review: "strategic-review",
  discovery_session: "platform-discovery-session",
  guided_demo: "guided-demonstration",
  enterprise_consultation: "enterprise-requirements-consultation",
  kickoff: "onboarding-kickoff",
};

/** Each session as a sentence names it: "moved their strategic review". */
export const CALCOM_SESSION_LABEL: Record<CalcomKind, string> = {
  strategic_review: "strategic review",
  discovery_session: "platform discovery session",
  guided_demo: "guided demonstration",
  enterprise_consultation: "enterprise requirements consultation",
  kickoff: "onboarding kickoff call",
};

/** The reverse lookup, for a webhook that names the event type by slug. */
export function kindForEventTypeSlug(slug: unknown): CalcomKind | null {
  if (typeof slug !== "string") return null;
  const entry = (Object.entries(CALCOM_EVENT_TYPE_SLUGS) as Array<[CalcomKind, string]>).find(
    ([, s]) => s === slug.trim(),
  );
  return entry ? entry[0] : null;
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/* --------------------------------- slots ---------------------------------- */

export type CalcomSlot = { start: Date; end: Date };

/**
 * Reads a `GET /v2/slots` answer into ascending, de-duplicated slots.
 *
 * Returns `null` for an answer that cannot be read — not an object, not a
 * success, no day map — and `[]` for a readable answer with nothing free. The
 * two send the caller to different sentences ("the calendar could not be
 * reached" against "nothing is free"), so they must never collapse.
 *
 * Tolerates the older spellings of the same answer (`data.slots`, entries with
 * `time` rather than `start`, bare strings) because the cost of reading them is
 * one line each and the cost of not reading them is an empty calendar.
 */
export function parseSlotsResponse(
  body: unknown,
  fallbackMinutes: number = CALCOM_DEFAULT_DURATION_MINUTES,
): CalcomSlot[] | null {
  const root = asRecord(body);
  if (!root || root.status !== "success") return null;
  const data = asRecord(root.data);
  if (!data) return null;
  const days = asRecord(data.slots) ?? data;

  const seen = new Set<number>();
  const out: CalcomSlot[] = [];
  for (const entries of Object.values(days)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const rec = asRecord(entry);
      const start = parseInstant(rec ? (rec.start ?? rec.time) : entry);
      if (!start) continue;
      const ms = start.getTime();
      if (seen.has(ms)) continue;
      seen.add(ms);
      const end = (rec && parseInstant(rec.end)) || new Date(ms + fallbackMinutes * 60_000);
      out.push({ start, end: end.getTime() > ms ? end : new Date(ms + fallbackMinutes * 60_000) });
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** The slot starting at `start`, within a minute either way, or null. */
export function findSlot(
  slots: CalcomSlot[],
  start: Date,
  toleranceMs = 60_000,
): CalcomSlot | null {
  const target = start.getTime();
  return slots.find((s) => Math.abs(s.start.getTime() - target) < toleranceMs) ?? null;
}

/* ------------------------------ booking request ---------------------------- */

/** An IANA zone `Intl` accepts, or the host's zone. Never throws. */
export function resolveTimeZone(value: unknown): string {
  const zone = text(value);
  if (!zone) return CALCOM_HOST_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: zone });
    return zone;
  } catch {
    return CALCOM_HOST_TIME_ZONE;
  }
}

/**
 * A phone number Cal.com will accept, or null.
 *
 * Cal.com validates `attendee.phoneNumber` as international format. A local
 * Australian number is lifted to +61 (the same two shapes `toE164AU` lifts at
 * the dial boundary); anything else unrecognised is DROPPED rather than sent,
 * because a phone the API refuses fails the whole booking over a field the
 * booking does not need.
 */
export function bookingPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const kept = raw.replace(/[^\d+]/g, "");
  let n = kept.startsWith("+") ? "+" + kept.slice(1).replace(/\D/g, "") : kept.replace(/\D/g, "");
  if (/^0\d{9}$/.test(n)) n = "+61" + n.slice(1);
  else if (/^61\d{9}$/.test(n)) n = "+" + n;
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : null;
}

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** A lower-cased address that parses, or null. The same rule the voice tools apply. */
export function bookingEmail(raw: unknown): string | null {
  const trimmed = text(raw).toLowerCase();
  if (!trimmed || trimmed.length > 254 || !EMAIL.test(trimmed)) return null;
  return trimmed;
}

/**
 * Metadata Cal.com will store: at most 50 keys, keys at most 40 characters,
 * values strings of at most 500. Absent values are dropped rather than sent as
 * the string "null", and an over-long key is dropped rather than truncated —
 * two keys truncated to the same prefix would silently overwrite each other.
 */
export function sanitizeCalcomMetadata(
  input: Record<string, string | number | boolean | null | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(out).length >= 50) break;
    if (!key || key.length > 40) continue;
    if (value === null || value === undefined) continue;
    const str = String(value).trim();
    if (!str) continue;
    out[key] = str.slice(0, 500);
  }
  return out;
}

export type BookingRequestInput = {
  kind: CalcomKind;
  username: string;
  start: Date;
  attendee: {
    name: string;
    email: string;
    timeZone?: string | null;
    phone?: string | null;
  };
  /** The attendee's own words about what to cover. Shown to the host. */
  notes?: string | null;
  organisation?: string | null;
  /** The Stage 1 reference. Only the strategic-review event type carries the field. */
  applicationReference?: string | null;
  metadata: Record<string, string | number | boolean | null | undefined>;
};

export type BookingRequestRefusal = "invalid_name" | "invalid_email" | "invalid_start";

export type BookingRequest =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: BookingRequestRefusal };

/**
 * Composes the `POST /v2/bookings` body, or says which input made that
 * impossible.
 *
 * `location` is deliberately omitted: Cal.com then uses the event type's own,
 * so an operator who moves the reviews from Cal Video to Teams changes it in
 * Cal.com and nothing here has to follow.
 */
export function buildBookingRequest(input: BookingRequestInput): BookingRequest {
  const name = text(input.attendee.name).replace(/\s+/g, " ").slice(0, 100);
  if (!name) return { ok: false, reason: "invalid_name" };
  const email = bookingEmail(input.attendee.email);
  if (!email) return { ok: false, reason: "invalid_email" };
  if (!(input.start instanceof Date) || Number.isNaN(input.start.getTime())) {
    return { ok: false, reason: "invalid_start" };
  }

  const attendee: Rec = {
    name,
    email,
    timeZone: resolveTimeZone(input.attendee.timeZone),
    language: "en",
  };
  const phone = bookingPhone(input.attendee.phone);
  if (phone) attendee.phoneNumber = phone;

  const responses: Rec = {};
  const notes = text(input.notes).slice(0, 1000);
  if (notes) responses.notes = notes;
  const organisation = text(input.organisation).slice(0, 200);
  if (organisation) responses.organisation = organisation;
  const reference = text(input.applicationReference).slice(0, 64);
  if (reference && input.kind === "strategic_review")
    responses["application-reference"] = reference;

  const body: Rec = {
    start: new Date(input.start.getTime()).toISOString(),
    eventTypeSlug: CALCOM_EVENT_TYPE_SLUGS[input.kind],
    username: input.username,
    attendee,
    metadata: sanitizeCalcomMetadata(input.metadata),
  };
  if (Object.keys(responses).length > 0) body.bookingFieldsResponses = responses;
  return { ok: true, body };
}

/* ------------------------------ booking answer ----------------------------- */

export type CalcomBooking = {
  uid: string;
  id: number | null;
  /** `accepted` | `pending` | `cancelled` | `rejected` as Cal.com spells them. */
  status: string;
  start: string;
  end: string;
  /** The join link, where the location is a video call. */
  meetingUrl: string | null;
  title: string | null;
  eventTypeId: number | null;
  eventTypeSlug: string | null;
  attendeeEmails: string[];
  metadata: Record<string, string>;
};

function httpUrl(value: unknown): string | null {
  const s = text(value);
  return /^https?:\/\//i.test(s) ? s : null;
}

/** Reads one booking object. Null when it has no uid or no readable times. */
export function readBooking(value: unknown): CalcomBooking | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const uid = text(rec.uid);
  const start = parseInstant(rec.start ?? rec.startTime);
  const end = parseInstant(rec.end ?? rec.endTime);
  if (!uid || !start) return null;

  const metadataRec = asRecord(rec.metadata) ?? {};
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadataRec)) {
    if (typeof v === "string") metadata[k] = v;
  }
  const eventType = asRecord(rec.eventType);
  const attendees = Array.isArray(rec.attendees) ? rec.attendees : [];

  return {
    uid,
    id: typeof rec.id === "number" ? rec.id : null,
    status: text(rec.status).toLowerCase() || "accepted",
    start: start.toISOString(),
    end: (
      end ?? new Date(start.getTime() + CALCOM_DEFAULT_DURATION_MINUTES * 60_000)
    ).toISOString(),
    meetingUrl:
      httpUrl(rec.meetingUrl) ?? httpUrl(rec.location) ?? httpUrl(metadataRec.videoCallUrl) ?? null,
    title: text(rec.title) || null,
    eventTypeId:
      typeof rec.eventTypeId === "number"
        ? rec.eventTypeId
        : typeof eventType?.id === "number"
          ? (eventType.id as number)
          : null,
    eventTypeSlug: text(eventType?.slug) || null,
    attendeeEmails: attendees
      .map((a) => bookingEmail(asRecord(a)?.email))
      .filter((e): e is string => Boolean(e)),
    metadata,
  };
}

/**
 * Reads a create / get answer. A create against a recurring or seated event
 * type answers with an array; the first occurrence is the booking.
 */
export function parseBookingResponse(body: unknown): CalcomBooking | null {
  const root = asRecord(body);
  if (!root || root.status !== "success") return null;
  const data = Array.isArray(root.data) ? root.data[0] : root.data;
  return readBooking(data);
}

/** Reads a `GET /v2/bookings` answer. Null when unreadable, `[]` when empty. */
export function parseBookingsListResponse(body: unknown): CalcomBooking[] | null {
  const root = asRecord(body);
  if (!root || root.status !== "success") return null;
  const data = Array.isArray(root.data)
    ? root.data
    : Array.isArray(asRecord(root.data)?.bookings)
      ? (asRecord(root.data)!.bookings as unknown[])
      : null;
  if (!data) return null;
  return data.map(readBooking).filter((b): b is CalcomBooking => b !== null);
}

/** A booking that still holds its time: neither cancelled nor rejected. */
export function isLiveBooking(booking: CalcomBooking): boolean {
  return !/cancel|reject/.test(booking.status);
}

/* -------------------------------- refusals --------------------------------- */

export type CalcomFailure =
  /** The time is not bookable: taken, inside the notice period, or outside the window. */
  | "slot_unavailable"
  /** Cal.com refused the request as malformed. A defect here, or bad input. */
  | "invalid_request"
  /** The event type or booking does not exist. A configuration fault. */
  | "not_found"
  /** The API key is missing, wrong or lacks the scope. A configuration fault. */
  | "auth"
  | "rate_limited"
  /** No answer, a timeout, or a 5xx. Nothing is known about the booking. */
  | "unavailable";

/** The message Cal.com gave, however it nested it. */
export function calcomErrorMessage(body: unknown): string {
  const root = asRecord(body);
  if (!root) return typeof body === "string" ? body.slice(0, 300) : "";
  const error = asRecord(root.error);
  const message =
    text(error?.message) || text(root.message) || text(error?.code) || text(root.error);
  const details = error?.details;
  const detail = typeof details === "string" ? details : "";
  return [message, detail].filter(Boolean).join(" — ").slice(0, 300);
}

const SLOT_REFUSAL =
  /not available|no[_ ]?available|already has booking|already booked|booking[_ ]?time[_ ]?out[_ ]?of[_ ]?bounds|out of bounds|minimum booking notice|notice|in the past|too far|booking window|slot|conflict|busy|unavailable/i;

/**
 * Sorts a refusal into the few kinds a caller can act on differently.
 *
 * `status` 0 means no HTTP answer at all (timeout, DNS, reset). Only a 4xx whose
 * message names availability becomes `slot_unavailable`; any other 4xx is a
 * request this code composed wrongly and must not be reported to a caller as
 * "that time has gone".
 */
export function classifyCalcomFailure(status: number, body: unknown): CalcomFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 0 || status >= 500) return "unavailable";
  if (status >= 400)
    return SLOT_REFUSAL.test(calcomErrorMessage(body)) ? "slot_unavailable" : "invalid_request";
  return "unavailable";
}

/* --------------------------------- webhooks -------------------------------- */

/**
 * Whether `signature` is Cal.com's HMAC-SHA256 of the raw body under `secret`.
 *
 * Cal.com sends it hex-encoded in `x-cal-signature-256`. The comparison is
 * constant-time and length-checked first, because `timingSafeEqual` throws on
 * unequal lengths and a thrown verifier is a 500 an attacker can provoke.
 */
export function verifyCalcomSignature(
  rawBody: string,
  secret: string,
  signature: string | null,
): boolean {
  if (!secret || !signature) return false;
  const provided = signature
    .trim()
    .toLowerCase()
    .replace(/^sha256=/, "");
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const given = Buffer.from(provided, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type CalcomWebhookTrigger =
  | "BOOKING_CREATED"
  | "BOOKING_RESCHEDULED"
  | "BOOKING_CANCELLED"
  | "BOOKING_REJECTED"
  | "BOOKING_NO_SHOW_UPDATED"
  | "OTHER";

export type CalcomWebhookEvent = {
  trigger: CalcomWebhookTrigger;
  /** The trigger exactly as sent, for the log line when it is `OTHER`. */
  rawTrigger: string;
  uid: string | null;
  /** On a reschedule, the uid of the booking that was moved. */
  previousUid: string | null;
  start: string | null;
  end: string | null;
  eventTypeSlug: string | null;
  metadata: Record<string, string>;
  attendeeEmails: string[];
  cancellationReason: string | null;
  /** On a no-show update: true when any attendee is now marked absent. */
  attendeeNoShow: boolean | null;
  /** The first attendee's name, for a notice about a booking the CRM does not hold. */
  attendeeName: string | null;
  /**
   * True on a cancellation that is really the old half of a reschedule — the
   * booking was replaced, not dropped, and a "cancelled" notice would be false.
   */
  supersededByReschedule: boolean;
  /** On a reschedule, where the moved booking used to start, when Cal.com says. */
  previousStart: string | null;
};

const KNOWN_TRIGGERS: CalcomWebhookTrigger[] = [
  "BOOKING_CREATED",
  "BOOKING_RESCHEDULED",
  "BOOKING_CANCELLED",
  "BOOKING_REJECTED",
  "BOOKING_NO_SHOW_UPDATED",
];

/**
 * Reads a webhook delivery. Null for a body that is not a Cal.com webhook.
 *
 * A reschedule carries the NEW booking's uid in `uid` and the moved booking's
 * in `rescheduleUid` (older payloads: `fromReschedule`), because Cal.com
 * implements a reschedule as a new booking that replaces the old one.
 */
export function parseCalcomWebhook(rawBody: string): CalcomWebhookEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root) return null;
  const rawTrigger = text(root.triggerEvent);
  if (!rawTrigger) return null;
  const payload = asRecord(root.payload) ?? {};

  const metadataRec = asRecord(payload.metadata) ?? {};
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(metadataRec)) {
    if (typeof v === "string") metadata[k] = v;
  }
  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const noShowFlags = attendees
    .map((a) => asRecord(a)?.noShow)
    .filter((v): v is boolean => typeof v === "boolean");

  const start = parseInstant(payload.startTime ?? payload.start);
  const end = parseInstant(payload.endTime ?? payload.end);
  const previousStart = parseInstant(payload.rescheduleStartTime);
  const firstAttendee = asRecord(attendees[0]);

  return {
    trigger: (KNOWN_TRIGGERS as string[]).includes(rawTrigger)
      ? (rawTrigger as CalcomWebhookTrigger)
      : "OTHER",
    rawTrigger,
    // A no-show update is a compact payload naming the booking `bookingUid`;
    // every other trigger carries the full booking under `uid`.
    uid: text(payload.uid) || text(payload.bookingUid) || null,
    previousUid: text(payload.rescheduleUid) || text(payload.fromReschedule) || null,
    start: start ? start.toISOString() : null,
    end: end ? end.toISOString() : null,
    eventTypeSlug: text(payload.type) || text(asRecord(payload.eventType)?.slug) || null,
    metadata,
    attendeeEmails: attendees
      .map((a) => bookingEmail(asRecord(a)?.email))
      .filter((e): e is string => Boolean(e)),
    cancellationReason: text(payload.cancellationReason) || null,
    attendeeNoShow: noShowFlags.length > 0 ? noShowFlags.some(Boolean) : null,
    attendeeName: text(firstAttendee?.name) || null,
    supersededByReschedule: payload.rescheduled === true,
    previousStart: previousStart ? previousStart.toISOString() : null,
  };
}

/* --------------------------------- speech ---------------------------------- */

/** How a slot is said aloud in the host's zone: "Monday 28 September at 9:00 am". */
export function spokenSlot(start: Date, timeZone: string = CALCOM_HOST_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: resolveTimeZone(timeZone),
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(start);
}

/* -------------------------------- CRM mirror ------------------------------- */

/**
 * What a `crm_appointments` row remembers about the Cal.com booking behind it,
 * under `metadata.calcom`.
 *
 * The row is a MIRROR: Cal.com holds the booking, sends the invitation and owns
 * the time. The row exists because the journey, the reminder calls and the
 * tracker all key on `crm_appointments`, and they must go on working. The uid
 * is what joins the two — a webhook names a booking by uid, and a reschedule
 * mints a new one, so the old uids are kept to recognise a late delivery about
 * a booking this row has already moved past.
 */
export type CalcomMirror = {
  uid: string;
  id: number | null;
  eventTypeSlug: string | null;
  status: string;
  meetingUrl: string | null;
  attendeeEmail: string | null;
  previousUids: string[];
};

/** The mirror on a row's metadata, or null for a row Cal.com knows nothing of. */
export function readCalcomMirror(metadata: unknown): CalcomMirror | null {
  const calcom = asRecord(asRecord(metadata)?.calcom);
  if (!calcom) return null;
  const uid = text(calcom.uid);
  if (!uid) return null;
  return {
    uid,
    id: typeof calcom.id === "number" ? calcom.id : null,
    eventTypeSlug: text(calcom.eventTypeSlug) || null,
    status: text(calcom.status) || "accepted",
    meetingUrl: httpUrl(calcom.meetingUrl),
    attendeeEmail: bookingEmail(calcom.attendeeEmail),
    previousUids: Array.isArray(calcom.previousUids)
      ? calcom.previousUids.filter((u): u is string => typeof u === "string" && u.length > 0)
      : [],
  };
}

/**
 * The mirror for a booking. Given the mirror it replaces (a reschedule), the
 * old uid joins `previousUids` and the attendee is carried over when the new
 * answer does not name one.
 */
export function mirrorFromBooking(
  booking: CalcomBooking,
  attendeeEmail: string | null,
  previous: CalcomMirror | null = null,
): CalcomMirror {
  const previousUids = previous
    ? [...previous.previousUids, ...(previous.uid !== booking.uid ? [previous.uid] : [])]
    : [];
  return {
    uid: booking.uid,
    id: booking.id,
    eventTypeSlug: booking.eventTypeSlug ?? previous?.eventTypeSlug ?? null,
    status: booking.status,
    meetingUrl: booking.meetingUrl ?? previous?.meetingUrl ?? null,
    attendeeEmail:
      bookingEmail(attendeeEmail) ?? booking.attendeeEmails[0] ?? previous?.attendeeEmail ?? null,
    previousUids: [...new Set(previousUids)].slice(-10),
  };
}
