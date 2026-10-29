// Pure helpers for the waitlist lead-capture ingest endpoint
// (/api/public/leads/capture). Kept free of I/O so they're unit-testable.
//
// Three different submissions arrive here, all from the Aurixa Systems site
// and all describing the same applicant at a different point in the funnel:
//
//   Stage 1  Priority Access Application      → creates the lead
//   Stage 2  Business Readiness Questionnaire → updates it
//   Stage 3  Strategic Review booking         → updates it
//
// They are told apart by `submissionType`, and tied together by the public
// application reference (`AX-XXXXXXXXXX`) issued at Stage 1. That reference is
// the only key shared with the Airtable operations record, so it is parsed and
// stored first-class rather than left buried in the raw metadata blob.
import { normaliseOfferCode } from "@/lib/trialOffers.pure";
import crypto from "crypto";

export const LEAD_MAX_FIELD_LENGTH = 300;
export const LEAD_MAX_TEXT_LENGTH = 4000;

/** Stage 1 caps "Primary Areas to Improve" at three selections. */
const MAX_PRIMARY_AREAS = 3;

/**
 * The Stage 2 questionnaire summary is a full narrative of the applicant's
 * operation, so it gets far more room than an ordinary field.
 */
const STAGE_SUMMARY_MAX_LENGTH = 20_000;

const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/** The canonical application reference form, shared with the website. */
const APPLICATION_REFERENCE_PATTERN = /^AX-[A-Z0-9]{10}$/;

// Strip control characters, collapse whitespace, cap length.
export function cleanLeadText(value: unknown, max = LEAD_MAX_FIELD_LENGTH): string {
  if (typeof value !== "string") return "";
  return (
    value
      // eslint-disable-next-line no-control-regex -- stripping control chars is the point
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
  );
}

// Accept both the landing page's camelCase field names and generic
// snake_case/plain aliases so a Make.com HTTP module can map fields loosely.
function pick(payload: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const v = payload[key];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** `null` when absent, so a missing consent is never recorded as a refusal. */
function pickBoolean(payload: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return null;
}

/** A list of short slugs, however the sender chose to encode it. */
function pickStringList(payload: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const v = payload[key];
    const raw = Array.isArray(v) ? v : typeof v === "string" && v ? v.split(",") : null;
    if (!raw) continue;
    const cleaned = raw.map((item) => cleanLeadText(item, 80)).filter(Boolean);
    if (cleaned.length) return cleaned.slice(0, MAX_PRIMARY_AREAS);
  }
  return [];
}

/** An ISO instant, or null when the value is absent or unparseable. */
function pickTimestamp(payload: Record<string, unknown>, ...keys: string[]): string | null {
  const raw = cleanLeadText(pick(payload, ...keys));
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Normalises the public application reference.
 *
 * People retype it off a screen, so it arrives lower-cased, spaced, or without
 * the `AX-` prefix. Anything that does not resolve to the issued format is
 * dropped rather than stored — a half-parsed join key is worse than none.
 */
export function normaliseApplicationId(value: unknown): string | null {
  const cleaned = cleanLeadText(value, 40)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const body = cleaned.startsWith("AX") ? cleaned.slice(2) : cleaned;
  const reference = `AX-${body}`;
  return APPLICATION_REFERENCE_PATTERN.test(reference) ? reference : null;
}

/**
 * Splits a single display name into parts.
 *
 * Stage 3 collects one "full name" field rather than the two Stage 1 asks for,
 * and its payload carried no first/last name at all — so every booking
 * mirrored to Mission Control was rejected as `missing_name` and then silently
 * discarded by the fire-and-forget caller. Splitting on the last space is a
 * guess, but a visible and recoverable one, and it is only reached when the
 * sender has not given us the parts directly.
 */
export function splitFullName(value: unknown): { first: string; last: string } {
  const name = cleanLeadText(value, 200);
  if (!name) return { first: "", last: "" };
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/** Which point in the funnel a payload describes. */
export type LeadStage = 1 | 2 | 3;

export const STAGE_TWO_SUBMISSION_TYPE = "business_readiness_questionnaire";
export const STAGE_THREE_SUBMISSION_TYPE = "strategic_review_booking";

export function detectStage(payload: Record<string, unknown>): LeadStage {
  const type = cleanLeadText(pick(payload, "submissionType", "submission_type")).toLowerCase();
  if (type === STAGE_THREE_SUBMISSION_TYPE) return 3;
  if (type === STAGE_TWO_SUBMISSION_TYPE) return 2;
  return 1;
}

/** The Stage 1 lead row — every column the website can populate. */
export type ParsedLead = {
  application_id: string | null;
  first_name: string;
  last_name: string;
  email: string;
  mobile_number: string | null;
  entity_name: string | null;
  entity_classification: string | null;
  transaction_volume: string | null;
  tech_stack_bottlenecks: string | null;
  role: string | null;
  primary_areas: string[];
  additional_notes: string | null;
  form_version: string | null;
  privacy_acknowledged: boolean | null;
  privacy_notice_version: string | null;
  marketing_consent: boolean | null;
  landing_page: string | null;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  source: string;
  page: string | null;
  submitted_at: string | null;
};

/** What a Stage 2 or Stage 3 submission changes about an existing applicant. */
export type ParsedStageUpdate = {
  application_id: string | null;
  email: string;
  first_name: string;
  last_name: string;
  stage: 2 | 3;
  source: string;
  page: string | null;
  submitted_at: string | null;
  /** The `stage2_*` / `stage3_*` columns to write. */
  columns: Record<string, unknown>;
};

export type ParsedSubmission =
  | { stage: 1; lead: ParsedLead }
  | { stage: 2 | 3; update: ParsedStageUpdate };

function parseIdentity(payload: Record<string, unknown>) {
  let first_name = cleanLeadText(pick(payload, "directiveFirstName", "firstName", "first_name"));
  let last_name = cleanLeadText(pick(payload, "directiveLastName", "lastName", "last_name"));

  // Stage 3 (and any sender mapping loosely) gives one combined name.
  if (!first_name || !last_name) {
    const split = splitFullName(pick(payload, "fullName", "full_name", "name"));
    first_name = first_name || split.first;
    last_name = last_name || split.last;
  }

  const email = cleanLeadText(
    pick(payload, "corporateEmail", "email", "corporate_email", "workEmail", "work_email"),
  ).toLowerCase();

  return { first_name, last_name, email };
}

export function parseLead(payload: Record<string, unknown>): ParsedLead | { error: string } {
  const { first_name, last_name, email } = parseIdentity(payload);

  if (!first_name || !last_name) return { error: "missing_name" };
  if (!email || !isValidEmail(email)) return { error: "invalid_email" };

  return {
    application_id: normaliseApplicationId(pick(payload, "applicationId", "application_id")),
    first_name,
    last_name,
    email,
    mobile_number: cleanLeadText(pick(payload, "mobileNumber", "mobile_number", "phone")) || null,
    entity_name: cleanLeadText(pick(payload, "entityName", "entity_name", "company")) || null,
    entity_classification:
      cleanLeadText(
        pick(payload, "entityClassification", "entity_classification", "organisationType"),
      ) || null,
    transaction_volume:
      cleanLeadText(
        pick(
          payload,
          "annualOriginationTransactionVolume",
          "annualVolume",
          "transactionVolume",
          "transaction_volume",
        ),
      ) || null,
    tech_stack_bottlenecks:
      cleanLeadText(
        pick(payload, "currentTechStackBottlenecks", "techStackBottlenecks", "bottlenecks"),
        LEAD_MAX_TEXT_LENGTH,
      ) || null,
    role: cleanLeadText(pick(payload, "role")) || null,
    primary_areas: pickStringList(
      payload,
      "primaryAreasToImprove",
      "primary_areas_to_improve",
      "improvementAreas",
    ),
    additional_notes:
      cleanLeadText(pick(payload, "additionalNotes", "additional_notes"), LEAD_MAX_TEXT_LENGTH) ||
      null,
    form_version: cleanLeadText(pick(payload, "formVersion", "form_version")) || null,
    privacy_acknowledged: pickBoolean(payload, "privacyAcknowledged", "privacy_acknowledged"),
    privacy_notice_version:
      cleanLeadText(pick(payload, "privacyNoticeVersion", "privacy_notice_version")) || null,
    marketing_consent: pickBoolean(payload, "marketingConsent", "marketing_consent"),
    landing_page: cleanLeadText(pick(payload, "landingPage", "landing_page"), 500) || null,
    referrer: cleanLeadText(pick(payload, "referrer"), 500) || null,
    utm_source: cleanLeadText(pick(payload, "utmSource", "utm_source")) || null,
    utm_medium: cleanLeadText(pick(payload, "utmMedium", "utm_medium")) || null,
    utm_campaign: cleanLeadText(pick(payload, "utmCampaign", "utm_campaign")) || null,
    utm_term: cleanLeadText(pick(payload, "utmTerm", "utm_term")) || null,
    utm_content: cleanLeadText(pick(payload, "utmContent", "utm_content")) || null,
    source: cleanLeadText(pick(payload, "source")) || "unknown",
    page: cleanLeadText(pick(payload, "page")) || null,
    submitted_at: pickTimestamp(payload, "submittedAt", "submitted_at"),
  };
}

/** A session length in whole minutes, or null for anything that is not one. */
function durationMinutes(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isInteger(n) && n > 0 && n <= 480 ? n : null;
}

/** A video link the confirmation email may carry: https only, or nothing. */
function meetingUrl(value: unknown): string | null {
  const url = cleanLeadText(value, 1000);
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

function presentOnly(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null));
}

/**
 * Parses a Stage 2 or Stage 3 submission.
 *
 * These describe an applicant who already exists, so the bar is lower than
 * Stage 1's: a valid email is enough, and a name is welcome but not required.
 * Refusing a booking because the applicant typed one word into the name field
 * would lose the very signal the CRM most wants to see.
 */
export function parseStageUpdate(
  payload: Record<string, unknown>,
  stage: 2 | 3,
): ParsedStageUpdate | { error: string } {
  const { first_name, last_name, email } = parseIdentity(payload);
  if (!email || !isValidEmail(email)) return { error: "invalid_email" };

  const application_id = normaliseApplicationId(
    pick(
      payload,
      "applicationId",
      "application_id",
      "applicationReference",
      "application_reference",
    ),
  );
  const submitted_at = pickTimestamp(payload, "submittedAt", "submitted_at");

  const columns: Record<string, unknown> =
    stage === 2
      ? {
          stage2_status: cleanLeadText(pick(payload, "completionStatus", "status")) || "Completed",
          stage2_completed_at:
            pickTimestamp(payload, "completedAt", "completed_at") ?? submitted_at,
          stage2_access_mode: cleanLeadText(pick(payload, "accessMode", "access_mode")) || null,
          stage2_next_step:
            cleanLeadText(pick(payload, "nextStep", "next_step", "preferredNextStep")) || null,
          stage2_investment:
            cleanLeadText(pick(payload, "investmentRange", "investment_range", "budgetRange")) ||
            null,
          stage2_timeline: cleanLeadText(pick(payload, "timing", "implementationTimeline")) || null,
        }
      : {
          stage3_status:
            cleanLeadText(pick(payload, "bookingStatus", "booking_status")) || "Requested",
          stage3_booked_at: submitted_at,
          stage3_session_start: pickTimestamp(payload, "requestedStartUtc", "requested_start_utc"),
          stage3_session_end: pickTimestamp(payload, "requestedEndUtc", "requested_end_utc"),
          stage3_access_mode: cleanLeadText(pick(payload, "accessMode", "access_mode")) || null,
          stage3_time_zone:
            cleanLeadText(pick(payload, "applicantTimeZone", "applicant_time_zone")) || null,
          // What the confirmation email states, as the scheduler showed it to
          // the applicant: their own clock, Sydney's, the session length and
          // the video link. Only what the payload carries: the Airtable mirror
          // writes these too, and a booking reported without them must not
          // blank what it wrote.
          ...presentOnly({
            stage3_local_time:
              cleanLeadText(pick(payload, "applicantLocalTime", "applicant_local_time")) || null,
            stage3_host_local_time:
              cleanLeadText(pick(payload, "hostLocalTime", "host_local_time")) || null,
            stage3_duration_minutes: durationMinutes(
              pick(payload, "durationMinutes", "duration_minutes"),
            ),
            stage3_booking_reference:
              cleanLeadText(pick(payload, "calBookingUid", "cal_booking_uid")) || null,
            stage3_meeting_url: meetingUrl(pick(payload, "meetingUrl", "meeting_url")),
          }),
        };

  // Stage 2's `fields` block carries the answers under their own names; read
  // the buying-signal ones from there when the top level did not supply them.
  const fields = payload.fields;
  if (stage === 2 && fields && typeof fields === "object" && !Array.isArray(fields)) {
    const f = fields as Record<string, unknown>;
    columns.stage2_next_step ??= cleanLeadText(pick(f, "nextStep")) || null;
    columns.stage2_investment ??= cleanLeadText(pick(f, "investmentRange")) || null;
    columns.stage2_timeline ??= cleanLeadText(pick(f, "timing")) || null;
    // Keep the whole answer set. It is the most substantial account a prospect
    // ever gives of their own operation — systems, integrations, migration
    // scope, security posture, budget — and the client-fit engine reads it.
    columns.stage2_answers = f;
    columns.stage2_summary =
      cleanLeadText(pick(payload, "summaryText", "summary_text"), STAGE_SUMMARY_MAX_LENGTH) || null;
  }

  return {
    application_id,
    email,
    first_name,
    last_name,
    stage,
    source: cleanLeadText(pick(payload, "source")) || "unknown",
    page: cleanLeadText(pick(payload, "page")) || null,
    submitted_at,
    columns,
  };
}

/** Routes a payload to the right parser based on its declared submission type. */
/**
 * The trial offer a Stage 1 application was made under, when the visitor
 * arrived on a `?trial=CODE` link. The website asked Mission Control about
 * the code before showing it, so this only normalises it: a code the offers
 * table does not know is still worth keeping on the lead, as what the visitor
 * was shown. Anything that is not a code shape is dropped.
 */
export function trialOfferCodeFrom(payload: Record<string, unknown>): string | null {
  const raw = payload.trialOfferCode ?? payload.trial_offer_code;
  if (typeof raw !== "string") return null;
  const code = normaliseOfferCode(raw);
  return code.ok ? code.code : null;
}

export function parseSubmission(
  payload: Record<string, unknown>,
): ParsedSubmission | { error: string } {
  const stage = detectStage(payload);
  if (stage === 1) {
    const lead = parseLead(payload);
    return "error" in lead ? lead : { stage: 1, lead };
  }
  const update = parseStageUpdate(payload, stage);
  return "error" in update ? update : { stage, update };
}

/**
 * Same submission delivered via the browser dual-write AND the Make.com
 * forward hashes to the same key, so it lands exactly once.
 *
 * Stage is part of the key from Stage 2 onward: a booking made in the same
 * second as another event for the same applicant is a different fact, not a
 * duplicate. Stage 1 keeps its original `email|submittedAt` shape so keys
 * already stored still match the deliveries that produced them.
 */
export function dedupeKeyFor(
  lead: { email: string; submitted_at: string | null },
  stage: LeadStage = 1,
): string | null {
  if (!lead.submitted_at) return null;
  const material =
    stage === 1
      ? `${lead.email}|${lead.submitted_at}`
      : `stage${stage}|${lead.email}|${lead.submitted_at}`;
  return crypto.createHash("sha256").update(material).digest("hex");
}
