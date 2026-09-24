// Stage 3 of the priority-access funnel — the strategic review — booked in
// Cal.com from the waitlist site's scheduler.
//
// The site already decides who reaches the scheduler: a Make scenario reads
// Airtable and answers yes only when the applicant's waitlist record carries
// `Stage 3 Access (Application) = GRANT` AND a Business Readiness response
// exists for the same reference. That answer is a claim by the time it
// reaches Mission Control, so the booking endpoint asks the same question of
// the same records again, with the same formula, before it spends a slot in
// the host's calendar. This module is the half of that which needs no
// network: the formulas, how an answer is read, which of an applicant's
// bookings is their review, and the shape of each reply to the page.
import type { AirtableRecord } from "@/server/airtableLeadMapping.pure";
import {
  CALCOM_EVENT_TYPE_SLUGS,
  bookingEmail,
  isLiveBooking,
  type CalcomBooking,
} from "@/server/calcom.pure";

/**
 * The two tables the live access gate reads — Make scenario "Aurixa Stage 3
 * Access" (9602082) — by id, as that scenario names them, so a renamed table
 * cannot quietly point this check somewhere else.
 */
export const STAGE3_ACCESS_TABLES = {
  /** "Aurixa Waitlist": carries `Application ID Key` and the access decision. */
  waitlist: "tblHzGiB591W3GpoZ",
  /** The Business Readiness responses: one per completed Stage 2. */
  readiness: "tblB1t18q6aUTNI0g",
} as const;

/** The value the waitlist record's access field holds when Stage 3 is open. */
export const STAGE3_ACCESS_GRANTED = "GRANT";

/** Cal.com metadata `source` for a booking this path made. */
export const STAGE3_BOOKING_SOURCE = "stage3_waitlist";

/**
 * A reference as it may appear inside an Airtable formula: upper case, and
 * nothing but letters, digits and hyphens — the same cleaning the Make
 * scenario applies, which is also what makes a quote, and so an injected
 * clause, impossible.
 */
export function formulaSafeReference(reference: string): string {
  return String(reference ?? "")
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9-]/g, "");
}

/** The two `filterByFormula` expressions, character for character the live gate's. */
export function stageThreeAccessFormulas(reference: string): {
  waitlist: string;
  readiness: string;
} {
  const ref = formulaSafeReference(reference);
  return {
    waitlist: `AND({Application ID Key} = '${ref}', {Stage 3 Access (Application)} = '${STAGE3_ACCESS_GRANTED}')`,
    readiness: `UPPER(TRIM({Application ID})) = '${ref}'`,
  };
}

export type StageThreeApplicant = {
  applicationId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  organisation: string | null;
};

export type AccessVerdict =
  | { granted: true; applicant: StageThreeApplicant; source: "airtable" | "mirror" }
  | { granted: false; source: "airtable" | "mirror" };

function field(record: AirtableRecord | undefined, name: string): string {
  const value = record?.fields?.[name];
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") return value[0].trim();
  return "";
}

/**
 * The live gate's verdict from its two answers: granted only when both found
 * a record. The applicant's details come from the waitlist record, exactly the
 * fields the Make scenario hands the site.
 */
export function accessFromAirtable(
  reference: string,
  waitlist: AirtableRecord[],
  readiness: AirtableRecord[],
): AccessVerdict {
  if (waitlist.length === 0 || readiness.length === 0)
    return { granted: false, source: "airtable" };
  const record = waitlist[0];
  return {
    granted: true,
    source: "airtable",
    applicant: {
      applicationId: field(record, "Application ID Key") || reference,
      firstName: field(record, "First Name"),
      lastName: field(record, "Last Name"),
      email: bookingEmail(field(record, "Corporate Email")),
      organisation: field(record, "Entity Name") || null,
    },
  };
}

export type MirroredLead = {
  application_id: string | null;
  first_name: string;
  last_name: string;
  email: string;
  entity_name: string | null;
  stage3_access_state: string | null;
  stage2_completed_at: string | null;
  stage2_airtable_record_id: string | null;
};

/**
 * The same verdict from Mission Control's mirror of those tables, for when
 * Airtable cannot be asked. The mirror is up to one sync tick behind — ten
 * minutes — so it can refuse somebody granted a moment ago, but it can never
 * admit somebody Airtable never granted.
 */
export function accessFromMirror(reference: string, rows: MirroredLead[]): AccessVerdict {
  const match = rows.find(
    (row) =>
      (row.application_id ?? "").toUpperCase() === reference.toUpperCase() &&
      (row.stage3_access_state ?? "").trim().toUpperCase() === STAGE3_ACCESS_GRANTED &&
      Boolean(row.stage2_completed_at || row.stage2_airtable_record_id),
  );
  if (!match) return { granted: false, source: "mirror" };
  return {
    granted: true,
    source: "mirror",
    applicant: {
      applicationId: reference,
      firstName: match.first_name,
      lastName: match.last_name,
      email: bookingEmail(match.email),
      organisation: match.entity_name,
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
