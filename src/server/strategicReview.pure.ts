// Stage 3 of the priority-access funnel — the strategic review — booked in
// Cal.com from the waitlist site's scheduler.
//
// Who may book was Airtable's to say: the Make scenario "Aurixa Stage 3
// Access" (9602082) answered yes only when the applicant's waitlist record
// carried `Stage 3 Access (Application) = GRANT` and a Business Readiness
// response existed for the same reference. That scenario lived in the EU Make
// account, which is deprecated, and Airtable no longer receives applications,
// so the rule is recreated here over Mission Control's own record — the same
// conditions, read from the columns that hold them — and the site asks it
// (`/api/public/storefront/strategic-review-access`) before it shows the
// scheduler. The booking endpoint asks it again before it spends a slot in
// the host's calendar. This module is the half of that which needs no
// network: the rule, which of an applicant's bookings is their review, and
// the shape of each reply to the page.
import { hasReachedStage2, isDeclined } from "@/lib/leadEmailGates.pure";
import {
  CALCOM_EVENT_TYPE_SLUGS,
  bookingEmail,
  isLiveBooking,
  type CalcomBooking,
} from "@/server/calcom.pure";

/** Cal.com metadata `source` for a booking this path made. */
export const STAGE3_BOOKING_SOURCE = "stage3_waitlist";

export type StageThreeApplicant = {
  applicationId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  organisation: string | null;
};

export type AccessVerdict =
  | { granted: true; applicant: StageThreeApplicant; source: "mission_control" }
  | { granted: false; source: "mission_control" };

/** The lead columns the rule reads. */
export type AccessLead = {
  application_id: string | null;
  first_name: string;
  last_name: string;
  email: string;
  entity_name: string | null;
  status: string | null;
  airtable_status: string | null;
  stage2_completed_at: string | null;
  stage2_airtable_record_id: string | null;
};

/**
 * Airtable's gate, over Mission Control's record. Granted only when all three
 * of its conditions hold:
 *
 *   `{Application ID}` is not blank   the lead carries this reference
 *   `{Status}` is not "Declined"      `isDeclined`, as the send gates read it
 *   a Business Readiness response     `hasReachedStage2`, or a questionnaire
 *   exists for the reference          the mirror read from Airtable
 *
 * The applicant's details are the ones they gave at Stage 1, as the Make
 * scenario handed them to the site. `rows` newest first: a reference names
 * one application, and if it ever named two the latest is the live one.
 */
export function accessFromLead(reference: string, rows: AccessLead[]): AccessVerdict {
  const lead = rows.find(
    (row) => (row.application_id ?? "").trim().toUpperCase() === reference.toUpperCase(),
  );
  if (!lead || isDeclined(lead)) return { granted: false, source: "mission_control" };
  if (!hasReachedStage2(lead) && !lead.stage2_airtable_record_id) {
    return { granted: false, source: "mission_control" };
  }
  return {
    granted: true,
    source: "mission_control",
    applicant: {
      applicationId: reference,
      firstName: lead.first_name,
      lastName: lead.last_name,
      email: bookingEmail(lead.email),
      organisation: lead.entity_name,
    },
  };
}

/**
 * Whether a booking is this applicant's strategic review.
 *
 * Their reference in the booking's metadata is proof — this path writes it.
 * Otherwise a strategic review booked under one of their addresses counts,
 * which is how a review the voice agent booked for them on a call is found
 * too: one person, one review.
 */
export function isApplicantsReview(
  booking: CalcomBooking,
  reference: string,
  emails: string[],
): boolean {
  if (!isLiveBooking(booking)) return false;
  if ((booking.metadata.applicationId ?? "").toUpperCase() === reference.toUpperCase()) return true;
  const isReview =
    booking.eventTypeSlug === CALCOM_EVENT_TYPE_SLUGS.strategic_review ||
    booking.metadata.kind === "strategic_review" ||
    booking.metadata.source === STAGE3_BOOKING_SOURCE;
  return isReview && booking.attendeeEmails.some((e) => emails.includes(e));
}

/** The earliest of an applicant's live reviews, or null. */
export function applicantsReview(
  bookings: CalcomBooking[],
  reference: string,
  emails: string[],
): CalcomBooking | null {
  const wanted = emails.map((e) => e.toLowerCase());
  return (
    bookings
      .filter((b) => isApplicantsReview(b, reference, wanted))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0] ?? null
  );
}

/** What the page is told about a booking: enough to show it, nothing more. */
export function bookingView(booking: CalcomBooking): {
  uid: string;
  start: string;
  end: string;
  meetingUrl: string | null;
} {
  return {
    uid: booking.uid,
    start: booking.start,
    end: booking.end,
    meetingUrl: booking.meetingUrl,
  };
}

/**
 * Why a booking attempt did not happen, in the page's vocabulary. Each sends
 * the applicant somewhere different: choose again, confirm a move, fix a
 * field, or wait and retry — and "not configured" sends the page back to the
 * request form it used before Cal.com.
 */
export type ReviewRefusal =
  | "invalid_request"
  | "invalid_reference"
  | "access_denied"
  | "access_unverifiable"
  | "already_booked"
  | "slot_unavailable"
  | "calendar_unavailable"
  | "not_configured";

export const REVIEW_REFUSAL_STATUS: Record<ReviewRefusal, number> = {
  invalid_request: 400,
  invalid_reference: 400,
  access_denied: 403,
  access_unverifiable: 503,
  already_booked: 409,
  slot_unavailable: 409,
  calendar_unavailable: 503,
  not_configured: 503,
};
