// Airtable → `waitlist_leads` field mapping. Pure: no I/O, no clients.
//
// Split out of `airtable-sync.server.ts` when the mirror stopped being one
// table. The Aurixa priority-access funnel writes FOUR Airtable tables and
// this module knows how to read all of them:
//
//   `Aurixa Waitlist`                Stage 1 + the rollups + the invite ledger
//   `BRQ Detailed Responses`         Stage 2, in full (40+ columns)
//   `Business Readiness Responses`   Stage 2, the older shorter shape
//   `Strategic Review Bookings`      Stage 3
//
// ## Column names are data, not code
//
// Every Airtable column this reads is named ONCE, here, in `FIELDS`. Airtable
// returns `undefined` for a column that does not exist exactly as it does for
// one that is empty, so a mistyped name is invisible — the same trap
// `airtableIntakeFields.pure.ts` was created for in the property dashboard.
// Naming them in one place is what makes a rename a one-line diff and a typo
// something a test can see.
//
// ## Slug or label
//
// Airtable stores what Make wrote, and Make writes the READABLE label for some
// columns (`Your Role` ← `roleLabel`) and the SLUG for others
// (`Entity Classification` ← `entityClassification`). Nothing here converts
// between them: a mapper that guessed would produce a value neither the form
// nor the console has a label for. The console renders a slug it does not
// recognise by un-underscoring it, which is honest about not knowing.

/**
 * A JSON value, structurally identical to what the database column accepts.
 *
 * Declared here rather than imported from the generated Supabase types so this
 * module stays pure — it is the answer set's type, and the answer set is the
 * thing a test drives. It is narrower than the generated `Json` (no `undefined`
 * in the index signature), so it assigns into a `jsonb` column and the column's
 * type never assigns back into it, which is the direction that matters.
 */
// The questionnaire's own vocabulary lives in `lib` so the console can read it
// too; re-exported here because this module is where the mapper composes the
// summary, and a second list is how the email and the page come to disagree.
export { summariseStage2 } from "@/lib/leadQuestionnaire.pure";
import { summariseStage2 } from "@/lib/leadQuestionnaire.pure";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** One Airtable record as the connector gateway returns it. */
export type AirtableRecord = {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
};

/**
 * The Airtable column names, verbatim. Arrays are read in order and the first
 * non-empty one wins, which is how a column renamed in the live base stays
 * readable while the rebuild still carries the old spelling.
 */
export const FIELDS = {
  waitlist: {
    firstName: ["First Name"],
    lastName: ["Last Name"],
    email: ["Corporate Email"],
    phone: ["Phone", "Phone Number", "Mobile Number", "Mobile"],
    entityName: ["Entity Name"],
    entityClassification: ["Entity Classification"],
    volume: ["Annual Transactional Value", "Annual Origination Volume"],
    bottlenecks: ["Current Bottlenecks"],
    notes: ["Notes"],
    role: ["Your Role"],
    primaryAreas: ["Primary Areas to Improve"],
    additionalNotes: ["Additional Notes"],
    applicationId: ["Application ID"],
    formVersion: ["Form Version"],
    privacyAcknowledged: ["Privacy Acknowledged"],
    privacyNoticeVersion: ["Privacy Notice Version"],
    marketingConsent: ["Marketing Consent"],
    status: ["Status"],
    dateAdded: ["Date Added"],
    landingPage: ["Landing Page"],
    referrer: ["Referrer"],
    utmSource: ["UTM Source"],
    utmMedium: ["UTM Medium"],
    utmCampaign: ["UTM Campaign"],
    utmTerm: ["UTM Term"],
    utmContent: ["UTM Content"],
    // The invitation and access lifecycle — none of which was ever read.
    emailMessageId: ["Email Message ID"],
    stage2InviteSentAt: ["Stage 2 Invite Sent At"],
    stage2InviteCount: ["Stage 2 Invite Count"],
    stage3InviteSentAt: ["Stage 3 Invite Sent At"],
    stage3InviteCount: ["Stage 3 Invite Count"],
    tokenStatus: ["Token Status"],
    tokenExpiresAt: ["Token Expires At"],
    stage3Access: ["Stage 3 Access (Application)"],
    stage3AccessDenied: ["Stage 3 Access Denied Reason (Application)"],
    stage3BookingUrl: ["Stage 3 Booking URL"],
    // Rollups from the child tables.
    stage2Reached: ["Stage 2 Reached"],
    stage3Reached: ["Stage 3 Reached"],
    stage2CompletionStatus: ["Stage 2 Completion Status"],
    stage2StartedAt: ["Stage 2 Started At"],
    stage3BookingStatus: ["Stage 3 Booking Status"],
    stage3BookedAt: ["Stage 3 Booked At"],
    stage3SessionStart: ["Stage 3 Session Start"],
  },
  /** `BRQ Detailed Responses` — the full Stage 2 questionnaire. */
  brq: {
    applicationId: ["Application ID"],
    email: ["Applicant Email"],
    submittedAt: ["Submitted At"],
    accessMethod: ["Stage 2 Access Method"],
    role: ["Role (Corrected)"],
    roleOther: ["Role Description (if Other)"],
    authority: ["Technology Purchase Authority"],
    authorityOther: ["Authority Description (if Other)"],
    userCount: ["Expected User Count"],
    entityStructure: ["Office/Entity Structure"],
    regions: ["Operating Locations"],
    systems: ["Current Systems Used"],
    systemProductNames: ["System Product Names (optional)"],
    systemsOther: ["Other System Description (if Other)"],
    infoManagement: ["Current Info Management Methods (if No Central System)"],
    infoManagementOther: ["Other Info Management Description (if Other)"],
    problems: ["Top Operational Problems"],
    problemsOther: ["Other Operational Problem Description (if Other)"],
    adminTime: ["Weekly Admin Time"],
    difficultWorkflow: ["Workflow Causing Greatest Difficulty"],
    capabilities: ["Aurixa Capabilities Ranked (Top 5)"],
    integrations: ["Systems to Integrate"],
    voipDetails: ["VoIP System Details"],
    customSystemName: ["Custom System Name"],
    customSystemApi: ["Custom System API Available"],
    customSystemOwner: ["Custom System Business Owner"],
    customSystemWorkflow: ["Custom Integration Workflow"],
    migration: ["Data Migration Needed"],
    migrationSources: ["Data Migration Sources"],
    migrationRecords: ["Approximate Records Migrated"],
    migrationRecordsUnknown: ["Records Count Not Yet Known"],
    migrationDocuments: ["Approximate Documents Migrated"],
    migrationDocumentsUnknown: ["Documents Count Not Yet Known"],
    migrationQuality: ["Known Data-Quality Concerns"],
    migrationTiming: ["Preferred Migration Timing"],
    timing: ["Implementation Start Preference"],
    security: ["Security & Procurement Requirements"],
    securityContext: ["Security/Policy Context (if Required)"],
    enterpriseSso: ["Enterprise SSO Required"],
    enterpriseBoundaries: ["Entity-level Boundaries Required"],
    enterpriseProcurement: ["Procurement Process Expected"],
    nextStep: ["Next Step Preference"],
    investment: ["Approved Investment Range"],
    projectSponsor: ["Internal Project Sponsor Identified"],
  },
  /**
   * `Business Readiness Responses` — the earlier, shorter Stage 2 table.
   * Read only where the detailed table has no row for an application, so a
   * response recorded before the detailed table existed still reaches the
   * console instead of reading as "reached Stage 2, said nothing".
   */
  legacyBrq: {
    applicationId: ["Application ID"],
    email: ["Applicant Email"],
    submittedAt: ["Submission Date"],
    accessMethod: ["Stage 2 Access Method"],
    role: ["Role"],
    authority: ["Decision Authority"],
    userCount: ["User Count"],
    entityStructure: ["Office Structure"],
    regions: ["Operating Locations"],
    systems: ["Current Systems Used"],
    systemsOther: ["Other Current Systems (if applicable)"],
    problems: ["Top Operational Problems"],
    problemsOther: ["Other Operational Problem (if applicable)"],
    adminTime: ["Admin Time Spent (hrs/week)"],
    difficultWorkflow: ["Workflow Description"],
    capabilities: ["Required Aurixa Capabilities (Ranked)"],
    integrations: ["Integration Needs"],
    customSystemWorkflow: ["Custom Integration Details (if applicable)"],
    migration: ["Data Migration Requirements"],
    migrationSources: ["Data Migration Details"],
    timing: ["Implementation Timeline"],
    security: ["Security Requirements"],
    securityContext: ["Security Policies or Certifications (if applicable)"],
    nextStep: ["Preferred Next Step"],
    investment: ["Budget Range"],
    completionStatus: ["Completion Status"],
    reviewerNotes: ["Reviewer Notes"],
  },
  booking: {
    applicationId: ["Application ID"],
    email: ["Applicant Email"],
    reference: ["Booking Reference"],
    fullName: ["Full Name"],
    organisation: ["Organisation"],
    phone: ["Phone"],
    startUtc: ["Requested Start (UTC)"],
    endUtc: ["Requested End (UTC)"],
    durationMinutes: ["Duration (Minutes)"],
    timeZone: ["Applicant Time Zone"],
    localTime: ["Applicant Local Time"],
    hostLocalTime: ["Aurixa Local Time"],
    notes: ["Context Notes"],
    summary: ["Summary"],
    status: ["Booking Status"],
    accessMethod: ["Stage 3 Access Method"],
    submittedAt: ["Submitted At"],
    confirmationMessageId: ["Confirmation Message ID"],
    confirmationSentAt: ["Confirmation Sent At"],
  },
} as const;

// ── Readers ────────────────────────────────────────────────────────────────
//
// Airtable's shapes, and a gateway's variations on them, in one place:
// single selects arrive as `{id, name}` through some gateways and as a bare
// string through others; multi-selects are arrays of either; formulas answer
// numbers; checkboxes answer `true` or are simply absent.

export function rawField(fields: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const value = fields[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function unwrapChoice(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (value as { name?: unknown }).name;
  }
  return value;
}

/** A single select, a formula's string, or a plain text cell. */
export function textField(
  fields: Record<string, unknown>,
  names: readonly string[],
  clean: (value: unknown, max?: number) => string,
  max?: number,
): string {
  return clean(unwrapChoice(rawField(fields, names)), max);
}

/** A multi-select, reduced to the plain list the lead row stores. */
export function listField(
  fields: Record<string, unknown>,
  names: readonly string[],
  clean: (value: unknown, max?: number) => string,
): string[] {
  const raw = rawField(fields, names);
  if (raw === undefined) return [];
  // A single select used where a list is expected still reads as one item
  // rather than as nothing — the failure direction that loses an answer.
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item) => clean(unwrapChoice(item), 120)).filter(Boolean);
}

export function booleanField(
  fields: Record<string, unknown>,
  names: readonly string[],
): boolean | null {
  const raw = rawField(fields, names);
  if (typeof raw === "boolean") return raw;
  // An Airtable checkbox is absent when unticked, so `undefined` is a real
  // "no" — but only where the caller asked for a checkbox. Everything else
  // stays null so a missing consent is never recorded as a refusal.
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export function numberField(
  fields: Record<string, unknown>,
  names: readonly string[],
): number | null {
  const raw = unwrapChoice(rawField(fields, names));
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function timestampField(
  fields: Record<string, unknown>,
  names: readonly string[],
  clean: (value: unknown, max?: number) => string,
): string | null {
  const raw = textField(fields, names, clean);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Airtable's "Stage N Reached" formulas answer 1 or 0. */
export function reachedField(fields: Record<string, unknown>, names: readonly string[]): boolean {
  return Number(rawField(fields, names)) > 0;
}

// ── The Stage 2 answer set ─────────────────────────────────────────────────

export type Stage2Enrichment = {
  /** Columns the console filters and sorts on. */
  stage2_authority: string | null;
  stage2_user_count: string | null;
  stage2_entity_structure: string | null;
  stage2_admin_time: string | null;
  stage2_migration: string | null;
  stage2_regions: string[];
  stage2_systems: string[];
  stage2_problems: string[];
  stage2_capabilities: string[];
  stage2_integrations: string[];
  stage2_security: string[];
  stage2_difficult_workflow: string | null;
  stage2_next_step: string | null;
  stage2_investment: string | null;
  stage2_timeline: string | null;
  stage2_access_mode: string | null;
  stage2_status: string | null;
  stage2_completed_at: string | null;
  stage2_airtable_record_id: string;
  /** The whole answer set, which is what the fit engine reads. */
  stage2_answers: JsonObject;
  stage2_summary: string | null;
};

/**
 * The BRQ answer set, in the SAME key vocabulary the website's own Stage 2
 * payload uses (`ReadinessSubmissionFields` in `aurixa-systems`).
 *
 * That agreement is the point. `stage2_answers` is read by the fit engine and
 * rendered by the console, and both paths — the browser dual-write and this
 * mirror — have to fill it with one shape or the same applicant reads as two
 * different people depending on which delivery arrived.
 */
const BRQ_ANSWER_KEYS = [
  ["role", "role"],
  ["roleOther", "roleOther"],
  ["authority", "authority"],
  ["authorityOther", "authorityOther"],
  ["userCount", "userCount"],
  ["entityStructure", "entityStructure"],
  ["systemsOther", "systemsOther"],
  ["infoManagementOther", "informationManagementOther"],
  ["problemsOther", "problemsOther"],
  ["adminTime", "adminTime"],
  ["difficultWorkflow", "difficultWorkflow"],
  ["voipDetails", "phoneSystem"],
  ["customSystemName", "customSystemName"],
  ["customSystemApi", "customSystemApi"],
  ["customSystemOwner", "customSystemOwner"],
  ["customSystemWorkflow", "customSystemWorkflow"],
  ["migration", "migration"],
  ["migrationSources", "migrationSources"],
  ["migrationQuality", "migrationQuality"],
  ["migrationTiming", "migrationTiming"],
  ["timing", "timing"],
  ["securityContext", "securityContext"],
  ["enterpriseSso", "enterpriseSso"],
  ["enterpriseBoundaries", "enterpriseBoundaries"],
  ["enterpriseProcurement", "enterpriseProcurement"],
  ["nextStep", "nextStep"],
  ["investment", "investmentRange"],
  ["projectSponsor", "projectSponsor"],
  ["systemProductNames", "systemProductNames"],
] as const;

const BRQ_LIST_KEYS = [
  ["regions", "regions"],
  ["systems", "systems"],
  ["infoManagement", "informationManagement"],
  ["problems", "problems"],
  ["capabilities", "capabilities"],
  ["integrations", "integrations"],
  ["security", "security"],
] as const;

type FieldMap = Record<string, readonly string[]>;

/**
 * Reads one Stage 2 record — from either Stage 2 table — into the enrichment.
 *
 * `spec` decides which table's column names are used, so the detailed and the
 * legacy shape share one reader rather than two that drift. A key the spec
 * does not carry simply does not appear: absent is absent, and writing `""`
 * for a question the older table never asked would claim an empty answer.
 */
export function readStage2(
  record: AirtableRecord,
  spec: FieldMap,
  clean: (value: unknown, max?: number) => string,
  longMax: number,
): Stage2Enrichment {
  const f = record.fields;
  const text = (key: string, max?: number) =>
    spec[key] ? textField(f, spec[key], clean, max) : "";
  const list = (key: string) => (spec[key] ? listField(f, spec[key], clean) : []);

  const answers: JsonObject = {};
  for (const [specKey, answerKey] of BRQ_ANSWER_KEYS) {
    const value = text(specKey, longMax);
    if (value) answers[answerKey] = value;
  }
  for (const [specKey, answerKey] of BRQ_LIST_KEYS) {
    const value = list(specKey);
    if (value.length) answers[answerKey] = value;
  }
  // Numbers and checkboxes carry meaning at zero and at false, so they are
  // written whenever the column exists rather than only when truthy.
  for (const [specKey, answerKey] of [
    ["migrationRecords", "migrationRecords"],
    ["migrationDocuments", "migrationDocuments"],
  ] as const) {
    if (!spec[specKey]) continue;
    const value = numberField(f, spec[specKey]);
    if (value !== null) answers[answerKey] = value;
  }
  for (const [specKey, answerKey] of [
    ["migrationRecordsUnknown", "migrationRecordsNotKnown"],
    ["migrationDocumentsUnknown", "migrationDocumentsNotKnown"],
  ] as const) {
    if (!spec[specKey]) continue;
    const value = booleanField(f, spec[specKey]);
    if (value !== null) answers[answerKey] = value;
  }

  return {
    stage2_authority: text("authority") || null,
    stage2_user_count: text("userCount") || null,
    stage2_entity_structure: text("entityStructure") || null,
    stage2_admin_time: text("adminTime") || null,
    stage2_migration: text("migration") || null,
    stage2_regions: list("regions"),
    stage2_systems: list("systems"),
    stage2_problems: list("problems"),
    stage2_capabilities: list("capabilities"),
    stage2_integrations: list("integrations"),
    stage2_security: list("security"),
    stage2_difficult_workflow: text("difficultWorkflow", longMax) || null,
    stage2_next_step: text("nextStep") || null,
    stage2_investment: text("investment") || null,
    stage2_timeline: text("timing") || null,
    stage2_access_mode: text("accessMethod") || null,
    stage2_status: text("completionStatus") || "Completed",
    stage2_completed_at: spec.submittedAt ? timestampField(f, spec.submittedAt, clean) : null,
    stage2_airtable_record_id: record.id,
    stage2_answers: answers,
    stage2_summary: summariseStage2(answers),
  };
}

/** The section order the console and the internal email both read in. */
// ── The Stage 3 booking ────────────────────────────────────────────────────

export type Stage3Enrichment = {
  stage3_status: string | null;
  stage3_booked_at: string | null;
  stage3_session_start: string | null;
  stage3_session_end: string | null;
  stage3_time_zone: string | null;
  stage3_access_mode: string | null;
  stage3_notes: string | null;
  stage3_local_time: string | null;
  stage3_host_local_time: string | null;
  stage3_duration_minutes: number | null;
  stage3_booking_reference: string | null;
  stage3_confirmation_sent_at: string | null;
  stage3_airtable_record_id: string;
};

export function readStage3(
  record: AirtableRecord,
  clean: (value: unknown, max?: number) => string,
  longMax: number,
): Stage3Enrichment {
  const f = record.fields;
  const spec = FIELDS.booking;
  return {
    stage3_status: textField(f, spec.status, clean) || "Requested",
    stage3_booked_at: timestampField(f, spec.submittedAt, clean),
    stage3_session_start: timestampField(f, spec.startUtc, clean),
    stage3_session_end: timestampField(f, spec.endUtc, clean),
    stage3_time_zone: textField(f, spec.timeZone, clean) || null,
    stage3_access_mode: textField(f, spec.accessMethod, clean) || null,
    stage3_notes: textField(f, spec.notes, clean, longMax) || null,
    stage3_local_time: textField(f, spec.localTime, clean) || null,
    stage3_host_local_time: textField(f, spec.hostLocalTime, clean) || null,
    stage3_duration_minutes: numberField(f, spec.durationMinutes),
    stage3_booking_reference: textField(f, spec.reference, clean) || null,
    stage3_confirmation_sent_at: timestampField(f, spec.confirmationSentAt, clean),
    stage3_airtable_record_id: record.id,
  };
}

/**
 * Which of several bookings for one applicant the lead row should describe.
 *
 * An applicant who reschedules has more than one row, and a cancelled one is
 * still a row. The console has space for exactly one, so this picks the one an
 * operator would want to see: a live booking over a cancelled one, and the
 * LATEST session among the live ones — because "when am I seeing them" is the
 * question the field answers, and a superseded time answers it wrongly.
 */
export function preferredBooking(bookings: Stage3Enrichment[]): Stage3Enrichment | null {
  if (bookings.length === 0) return null;
  const isDead = (b: Stage3Enrichment) => /cancel|withdraw|declin/i.test(b.stage3_status ?? "");
  const live = bookings.filter((b) => !isDead(b));
  const pool = live.length ? live : bookings;
  return [...pool].sort((a, b) => {
    const at = Date.parse(a.stage3_session_start ?? a.stage3_booked_at ?? "") || 0;
    const bt = Date.parse(b.stage3_session_start ?? b.stage3_booked_at ?? "") || 0;
    return bt - at;
  })[0];
}
