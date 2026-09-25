// The Stage 3 scheduler's calendar: the free review times, and the booking.
//
// The waitlist site shows these times and books them through
// `/api/public/storefront/strategic-review`. Cal.com holds the booking, sends
// the invitation with the video link, and — because the voice fleet reads the
// same calendar through `calendar.server.ts` — a time an applicant takes here
// can no longer be offered to a caller, and the reverse.
//
// The site still sends the booked time down its Make scenario afterwards, as
// it always has: that is what writes the Strategic Review Bookings record in
// Airtable and sends the branded confirmation. What changed is that the time
// is a real booking before that happens, rather than a request somebody has to
// reconcile against a calendar nothing here could see.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { queryAirtableTable } from "@/server/airtable-sync.server";
import { notifyOperators } from "@/server/audit.server";
import {
  CALCOM_DEFAULT_DURATION_MINUTES,
  CALCOM_HOST_TIME_ZONE,
  bookingEmail,
  spokenSlot,
  type CalcomBooking,
  type CalcomFailure,
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
import { normaliseApplicationId } from "@/server/lead-capture.server";
import {
  REVIEW_REFUSAL_STATUS,
  STAGE3_ACCESS_TABLES,
  STAGE3_BOOKING_SOURCE,
  accessFromAirtable,
  accessFromMirror,
  applicantsReview,
  bookingView,
  stageThreeAccessFormulas,
  type AccessVerdict,
  type ReviewRefusal,
} from "@/server/strategicReview.pure";
import { calendarFaultOf } from "@/server/voiceBooking.pure";

export type ReviewResponse = { status: number; body: Record<string, unknown> };

function refuse(reason: ReviewRefusal, extra: Record<string, unknown> = {}): ReviewResponse {
  return { status: REVIEW_REFUSAL_STATUS[reason], body: { ok: false, reason, ...extra } };
}

/* ---------------------------------- slots ---------------------------------- */

/**
 * The free strategic-review starts, ascending, as UTC instants.
 *
 * Public on purpose: it says when the host is free for a hidden event type,
 * which Cal.com's own booking page says to anybody holding the link. No
 * operator notice on a failure here — a page load is not a booking, and a
 * refused key would raise one per visitor; the booking attempt raises it.
 */
export async function strategicReviewSlots(now: Date = new Date()): Promise<ReviewResponse> {
  const config = calcomConfig();
  if (!config) return refuse("not_configured");
  const read = await calcomFreeSlots(config, "strategic_review", now);
  if (!read.ok) return refuse("calendar_unavailable", { fault: calendarFaultOf(read.failure) });
  return {
    status: 200,
    body: {
      ok: true,
      provider: "calcom",
      timeZone: CALCOM_HOST_TIME_ZONE,
      durationMinutes: CALCOM_DEFAULT_DURATION_MINUTES,
      generatedAt: now.toISOString(),
      slots: read.slots.map((start) => ({
        start: start.toISOString(),
        end: new Date(start.getTime() + CALCOM_DEFAULT_DURATION_MINUTES * 60_000).toISOString(),
      })),
    },
  };
}

/* --------------------------------- access ---------------------------------- */

type AccessCheck = { decided: true; verdict: AccessVerdict } | { decided: false };

/**
 * Asks Airtable the live gate's question; failing that, the mirror.
 *
 * "Airtable said no" is final and never overruled by the mirror. Only
 * "Airtable could not be asked" falls through to it, and a mirror read that
 * fails too is `decided: false` — the page is told access could not be checked,
 * never that it was refused.
 */
export async function verifyStageThreeAccess(reference: string): Promise<AccessCheck> {
  const formulas = stageThreeAccessFormulas(reference);
  try {
    const [waitlist, readiness] = await Promise.all([
      queryAirtableTable(STAGE3_ACCESS_TABLES.waitlist, { filterByFormula: formulas.waitlist }),
      queryAirtableTable(STAGE3_ACCESS_TABLES.readiness, { filterByFormula: formulas.readiness }),
    ]);
    return { decided: true, verdict: accessFromAirtable(reference, waitlist, readiness) };
  } catch (err) {
    console.error(
      `[strategic-review] live access check failed for ${reference}; reading the mirror: ${(err as Error).message}`,
    );
  }
  const { data, error } = await supabaseAdmin
    .from("waitlist_leads")
    .select(
      "application_id, first_name, last_name, email, entity_name, stage3_access_state, stage2_completed_at, stage2_airtable_record_id",
    )
    .eq("application_id", reference)
    .limit(5);
  if (error) {
    console.error(
      `[strategic-review] mirror access check failed for ${reference}: ${error.message}`,
    );
    return { decided: false };
  }
  return { decided: true, verdict: accessFromMirror(reference, data ?? []) };
}

/* --------------------------------- booking --------------------------------- */

export type ReviewBookingInput = {
  applicationId: string;
  start: Date;
  timeZone?: string | null;
  name?: string | null;
  email?: string | null;
  organisation?: string | null;
  phone?: string | null;
  notes?: string | null;
  rescheduleExisting?: boolean;
};

/**
 * The applicant's live review, if they hold one. `null` when they hold none;
 * `undefined` when Cal.com could not be asked, which proceeds to booking —
 * refusing the applicant over our own read would cost them the review, and a
 * clash with a time they already hold is still refused by Cal.com itself.
 */
async function existingReview(
  config: CalcomConfig,
  reference: string,
  emails: string[],
): Promise<CalcomBooking | null | undefined> {
  let failed = false;
  const found: CalcomBooking[] = [];
  for (const email of emails) {
    const listed = await listUpcomingCalcomBookings(config, { attendeeEmail: email });
    if (!listed.ok) {
      failed = true;
      continue;
    }
    found.push(...listed.value);
  }
  const review = applicantsReview(found, reference, emails);
  if (review) return review;
  return failed ? undefined : null;
}

async function alertReviewFailure(input: {
  failure: CalcomFailure;
  message: string;
  reference: string;
  name: string;
  email: string;
  start: Date;
  moving: CalcomBooking | null;
}): Promise<void> {
  const fault = calendarFaultOf(input.failure);
  const when = spokenSlot(input.start);
  await notifyOperators({
    kind: "calendar_booking_failed",
    severity: fault === "misconfigured" ? "error" : "warning",
    title: `Strategic review NOT booked: ${input.name} (${input.reference}) wanted ${when}`,
    body:
      (fault === "misconfigured"
        ? `Cal.com refused Mission Control (${input.failure}: ${input.message}). Every Stage 3 ` +
          "booking will fail until CALCOM_API_KEY or the strategic-review event type is fixed. "
        : `Cal.com did not answer (${input.failure}: ${input.message}). `) +
      (input.moving
        ? `They were moving their review from ${spokenSlot(new Date(input.moving.start))}. `
        : "") +
      `The applicant was told it did not go through. Contact: ${input.email}.`,
    url: "/leads",
    metadata: {
      failure: input.failure,
      fault,
      application_id: input.reference,
      requested_start: input.start.toISOString(),
    },
  });
}

/**
 * Books — or, asked to, moves — an applicant's strategic review.
 *
 * Every refusal is one of `ReviewRefusal`, and nothing here reports a booking
 * that Cal.com did not confirm: an ambiguous failure is resolved by asking
 * Cal.com what the applicant now holds, and only a booking it names is
 * reported as one.
 */
export async function bookStrategicReview(input: ReviewBookingInput): Promise<ReviewResponse> {
  const config = calcomConfig();
  if (!config) return refuse("not_configured");

  const reference = normaliseApplicationId(input.applicationId);
  if (!reference) return refuse("invalid_reference");
  if (!(input.start instanceof Date) || Number.isNaN(input.start.getTime())) {
    return refuse("invalid_request", { field: "start" });
  }

  const access = await verifyStageThreeAccess(reference);
  if (!access.decided) return refuse("access_unverifiable");
  if (!access.verdict.granted) return refuse("access_denied");
  const applicant = access.verdict.applicant;

  // The applicant may send the invitation somewhere other than the address on
  // their record — it is their review — but both addresses are theirs when it
  // comes to finding a review they already hold.
  const email = bookingEmail(input.email) ?? applicant.email;
  if (!email) return refuse("invalid_request", { field: "email" });
  const name =
    (input.name ?? "").trim().replace(/\s+/g, " ").slice(0, 100) ||
    [applicant.firstName, applicant.lastName].filter(Boolean).join(" ").trim();
  if (!name) return refuse("invalid_request", { field: "name" });
  const emails = [...new Set([email, applicant.email].filter((e): e is string => Boolean(e)))];

  const existing = await existingReview(config, reference, emails);
  if (existing) {
    const existingStart = new Date(existing.start);
    if (Math.abs(existingStart.getTime() - input.start.getTime()) < 60_000) {
      // The time they already hold: a double click, or a retry whose answer
      // was lost. It is booked.
      return {
        status: 200,
        body: { ok: true, status: "already_booked", booking: bookingView(existing) },
      };
    }
    if (!input.rescheduleExisting) {
      return refuse("already_booked", { existing: bookingView(existing) });
    }
    const moved = await rescheduleCalcomBooking(
      config,
      existing.uid,
      input.start,
      "Moved by the applicant on the Stage 3 scheduler.",
    );
    if (moved.ok) {
      return {
        status: 200,
        body: {
          ok: true,
          status: "rescheduled",
          booking: bookingView(moved.value),
          previous: bookingView(existing),
        },
      };
    }
    if (moved.failure === "slot_unavailable") {
      return refuse("slot_unavailable", { existing: bookingView(existing) });
    }
    await alertReviewFailure({
      failure: moved.failure,
      message: moved.message,
      reference,
      name,
      email,
      start: input.start,
      moving: existing,
    });
    return refuse("calendar_unavailable", { existing: bookingView(existing) });
  }

  const created = await createCalcomBooking(config, {
    kind: "strategic_review",
    start: input.start,
    attendee: { name, email, timeZone: input.timeZone ?? null, phone: input.phone ?? null },
    notes: input.notes ?? null,
    organisation: input.organisation?.trim() || applicant.organisation,
    applicationReference: reference,
    metadata: {
      source: STAGE3_BOOKING_SOURCE,
      kind: "strategic_review",
      applicationId: reference,
      accessVerifiedBy: access.verdict.source,
    },
  });
  if (created.ok) {
    return {
      status: 200,
      body: { ok: true, status: "booked", booking: bookingView(created.value) },
    };
  }

  // A timeout may have written the booking, and "not available" may be the
  // applicant's OWN booking from an attempt whose answer never arrived.
  if (created.failure !== "auth" && created.failure !== "not_found") {
    const held = await findLiveCalcomBooking(config, email, input.start);
    if (held) {
      return {
        status: 200,
        body: { ok: true, status: "already_booked", booking: bookingView(held) },
      };
    }
  }
  if (created.failure === "slot_unavailable") return refuse("slot_unavailable");
  await alertReviewFailure({
    failure: created.failure,
    message: created.message,
    reference,
    name,
    email,
    start: input.start,
    moving: null,
  });
  return refuse("calendar_unavailable");
}
