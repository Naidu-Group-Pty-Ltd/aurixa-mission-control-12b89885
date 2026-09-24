// The decisions behind the voice fleet's Cal.com booking that need no network
// and no database: which slots survive a CRM appointment Cal.com cannot see,
// which alternatives to offer when a time has just gone, and above all what
// the agent is told to SAY on each outcome.
//
// The sentences are the product. A booking agent that tells a caller "you're
// booked" when the calendar never confirmed anything is worse than one that
// says nothing: the caller stops trying, and nobody else knows to ring them.
// So every reply that is not a confirmed booking says, in words a model cannot
// soften into a confirmation, that NOTHING was booked — and each is pinned by
// `voiceBooking.pure.test.ts` rather than left to a reading of the handler.
//
// Every reply is a plain object the VAPI envelope stringifies. `success` keeps
// the meaning it has always had across these tools — "the thing you asked for
// happened" — so a model that reads only that field is still told the truth.
import type { CalcomBooking, CalcomFailure } from "@/server/calcom.pure";
import { isLiveBooking, readCalcomMirror } from "@/server/calcom.pure";

export type SpokenSlot = { startIso: string; endIso: string; spoken: string };

/** An interval already spoken for, in epoch milliseconds. */
export type TimeBlock = { start: number; end: number };

/**
 * Drops every slot that overlaps a block. A filter, deliberately — a slot the
 * host is already committed to is not a lower-priority offer, it is not an
 * offer.
 */
export function removeBlockedSlots(
  slots: Date[],
  blocks: TimeBlock[],
  slotMinutes: number,
): Date[] {
  if (blocks.length === 0) return slots;
  return slots.filter((slot) => {
    const s = slot.getTime();
    const e = s + slotMinutes * 60_000;
    return !blocks.some((b) => s < b.end && e > b.start);
  });
}

/**
 * The CRM appointments Cal.com cannot see, as blocks.
 *
 * One person hosts every kind of session, so any live appointment holds the
 * host's time. A row that mirrors a Cal.com booking is already in Cal.com's
 * own answer and is skipped — counting it twice changes nothing, but reading
 * it as a block would hide the slot from the very person who holds it when
 * they ask to keep the same time. What is left are bookings made by hand in
 * the tracker and any made before Cal.com was the calendar.
 */
export function blocksFromAppointments(
  rows: Array<{ starts_at: string; ends_at: string | null; metadata: unknown }>,
  slotMinutes: number,
): TimeBlock[] {
  const blocks: TimeBlock[] = [];
  for (const row of rows) {
    if (readCalcomMirror(row.metadata)) continue;
    const start = Date.parse(row.starts_at);
    if (Number.isNaN(start)) continue;
    const endParsed = row.ends_at ? Date.parse(row.ends_at) : NaN;
    const end =
      Number.isNaN(endParsed) || endParsed <= start ? start + slotMinutes * 60_000 : endParsed;
    blocks.push({ start, end });
  }
  return blocks;
}

/**
 * Up to `count` free slots nearest to the time that has just gone, in time
 * order. Nearness is absolute, so the half hours either side of a taken 10:00
 * come before anything on another day — which is what a caller who chose
 * 10:00 is most likely to accept.
 */
export function nearestAlternatives(slots: Date[], target: Date, count = 3): Date[] {
  const t = target.getTime();
  return [...slots]
    .filter((s) => Math.abs(s.getTime() - t) >= 60_000)
    .sort(
      (a, b) => Math.abs(a.getTime() - t) - Math.abs(b.getTime() - t) || a.getTime() - b.getTime(),
    )
    .slice(0, count)
    .sort((a, b) => a.getTime() - b.getTime());
}

/**
 * The caller's next live booking of one kind, among the bookings Cal.com
 * lists for their addresses — or null.
 *
 * This is how a session booked OUTSIDE the voice path is recognised: on the
 * Stage 3 page, or on the event type's own Cal.com link. Neither writes a CRM
 * row, so the CRM alone would let the agent book the same person a second
 * review. A booking counts when its event type is this kind's (or, where the
 * list omits the event type, when this platform's own metadata names the kind)
 * and one of its attendees is the caller. Only a future start counts: a
 * session that has begun is not one to move.
 */
export function heldBookingOfKind(
  bookings: CalcomBooking[],
  wanted: { slug: string; kind: string },
  emails: string[],
  now: Date,
): CalcomBooking | null {
  const addresses = new Set(emails.map((e) => e.toLowerCase()));
  return (
    bookings
      .filter(
        (b) =>
          isLiveBooking(b) &&
          Date.parse(b.start) > now.getTime() &&
          (b.eventTypeSlug === wanted.slug ||
            (b.eventTypeSlug === null && b.metadata.kind === wanted.kind)) &&
          b.attendeeEmails.some((e) => addresses.has(e)),
      )
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0] ?? null
  );
}

/**
 * The two faults a caller must never be blamed for, kept apart because they
 * send an operator to different places: an outage clears itself; a refused
 * key or a missing event type stays broken until somebody fixes it.
 */
export type CalendarFault = "unreachable" | "misconfigured";

export function calendarFaultOf(failure: CalcomFailure): CalendarFault {
  return failure === "unavailable" || failure === "rate_limited" ? "unreachable" : "misconfigured";
}

/* --------------------------------- replies --------------------------------- */

export function availabilityUnavailableReply(input: {
  bookingType: string;
  kind: string;
  failure: CalcomFailure;
}): Record<string, unknown> {
  return {
    success: false,
    calendar: "calcom",
    calendar_unavailable: true,
    booking_type: input.bookingType,
    kind: input.kind,
    fault: calendarFaultOf(input.failure),
    availability: [],
    message:
      "The calendar could not be read just now, so NO times are known. Do not offer, guess or " +
      "promise any time. Tell the caller you can't see the calendar at this moment, then offer to " +
      "have the team call them back to lock a time in, or to try again in a few minutes.",
  };
}

export function needsEmailReply(bookingType: string): Record<string, unknown> {
  return {
    success: false,
    appointment_created: false,
    needs_email: true,
    booking_type: bookingType,
    clarification_question:
      "What email address should the calendar invitation go to? Ask the caller to say it, spell " +
      "it back to them, then call book_appointment again with the same startTime and the email.",
    message:
      "Nothing is booked yet. The calendar invitation and the video link are sent by email, so " +
      "the booking needs an address first.",
  };
}

export function slotTakenReply(input: {
  requestedSpoken: string;
  alternatives: SpokenSlot[];
  /** When a MOVE failed: the time the existing booking still stands at. */
  existingKept?: string | null;
}): Record<string, unknown> {
  const kept = input.existingKept
    ? ` Their existing booking for ${input.existingKept} has NOT changed.`
    : "";
  const next =
    input.alternatives.length > 0
      ? " Tell the caller, then offer only these nearest alternatives."
      : " Nothing else is free in the booking window, so offer to have the team call them back.";
  return {
    success: false,
    appointment_created: false,
    slot_taken: true,
    alternatives: input.alternatives,
    message: `${input.requestedSpoken} is no longer available — nothing was booked.${kept}${next}`,
  };
}

export function bookingNotConfirmedReply(input: {
  requestedSpoken: string;
  operatorsAlerted: boolean;
  existingKept?: string | null;
}): Record<string, unknown> {
  const kept = input.existingKept
    ? ` Their existing booking for ${input.existingKept} still stands.`
    : "";
  const followUp = input.operatorsAlerted
    ? `The team has been alerted and will call them back to lock in ${input.requestedSpoken}.`
    : `Offer to have the team call them back to lock in ${input.requestedSpoken}.`;
  return {
    success: false,
    appointment_created: false,
    calendar_unavailable: true,
    operators_alerted: input.operatorsAlerted,
    message:
      `The booking was NOT made — the calendar did not confirm it. Do not tell the caller they ` +
      `are booked.${kept} Apologise briefly, say the calendar didn't respond, and tell them ` +
      `plainly: ${followUp} You may offer to try once more.`,
  };
}

export function alreadyBookedReply(input: {
  bookingType: string;
  existing: SpokenSlot;
  requestedSpoken: string;
}): Record<string, unknown> {
  return {
    success: false,
    appointment_created: false,
    already_booked: true,
    booking_type: input.bookingType,
    existing_booking: input.existing,
    message:
      `The caller already has a ${input.bookingType} booked for ${input.existing.spoken} ` +
      `(Sydney time). Nothing new was booked. Ask whether they want to MOVE it to ` +
      `${input.requestedSpoken}. If yes, call book_appointment again with the same startTime and ` +
      `reschedule_existing set to true. Do not book a second ${input.bookingType}.`,
  };
}

export function bookedReply(input: {
  appointmentId: string | null;
  bookingType: string;
  bookingUid: string;
  startIso: string;
  timezone: string;
  spoken: string;
  email: string;
  meetingLink: boolean;
  /** True when this call found a booking that already existed — made by an earlier attempt, or before this call. */
  alreadyConfirmed?: boolean;
}): Record<string, unknown> {
  const link = input.meetingLink ? " with the video link" : "";
  // A booking that already existed had its invitation sent when it was made;
  // telling the caller one is "on its way" would send them looking for a new
  // email that never comes.
  const invitation = input.alreadyConfirmed
    ? `This time was already booked for them. Confirm it back to the caller in natural speech; ` +
      `the calendar invitation${link} went to ${input.email} when it was booked.`
    : `Confirm the day and time back to the caller in natural speech, and tell them the ` +
      `calendar invitation${link} is on its way to ${input.email}.`;
  return {
    success: true,
    appointment_created: true,
    already_confirmed: input.alreadyConfirmed === true,
    appointmentId: input.appointmentId,
    calendar: "calcom",
    booking_uid: input.bookingUid,
    booking_type: input.bookingType,
    startTime: input.startIso,
    timezone: input.timezone,
    spoken: input.spoken,
    invite_email: input.email,
    message:
      `Booked and confirmed in the calendar: ${input.bookingType}, ${input.spoken} (Sydney ` +
      `time). ${invitation}`,
  };
}

export function rescheduledReply(input: {
  /** Null where the booking has no CRM record — one made on the Stage 3 page, say. */
  appointmentId: string | null;
  bookingType: string;
  bookingUid: string;
  startIso: string;
  timezone: string;
  spoken: string;
  previousSpoken: string;
  email: string | null;
}): Record<string, unknown> {
  const where = input.email ? ` to ${input.email}` : "";
  return {
    success: true,
    appointment_created: false,
    appointment_rescheduled: true,
    appointmentId: input.appointmentId,
    calendar: "calcom",
    booking_uid: input.bookingUid,
    booking_type: input.bookingType,
    startTime: input.startIso,
    timezone: input.timezone,
    spoken: input.spoken,
    previous_spoken: input.previousSpoken,
    message:
      `Moved and confirmed: the ${input.bookingType} is now ${input.spoken} (Sydney time), ` +
      `replacing ${input.previousSpoken}. Confirm the new time back to the caller; the updated ` +
      `calendar invitation is on its way${where}.`,
  };
}
