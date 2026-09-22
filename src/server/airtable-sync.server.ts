// Airtable → waitlist_leads mirror sync.
//
// Backfill + safety-net + progress feed for the Aurixa Systems priority-access
// funnel. The website's Make.com scenarios are the primary source of truth
// (Airtable + realtime notification); this pulls the Airtable base directly so
// that:
//
//   * historical rows and any rows Make/webhook missed get mirrored, and
//   * Stage 2 / Stage 3 progress reaches Mission Control at all.
//
// That second job is the reason this is an upsert rather than an insert. The
// funnel's later stages are recorded on the Airtable waitlist row as rollups
// from the "BRQ Detailed Responses" and "Strategic Review Bookings" tables —
// they change *after* the lead first lands. A sync that only ever inserted saw
// each applicant once, at Stage 1, and never again.
//
// ## Why it now reads four tables instead of one
//
// The rollups say an applicant REACHED Stage 2. They do not say one word about
// what the applicant answered — and the answers are the entire point of asking
// sixteen questions. `BRQ Detailed Responses` carries 40+ columns of exactly
// the material an operator qualifies on (seats, systems, integrations,
// migration scope, security and procurement, approved budget, what they want
// to happen next) and nothing here had ever opened it. Same for the booking
// table, whose `Context Notes` is the applicant's own agenda for the call.
//
// So each tick walks the parent and its three children, indexes the children by
// the public application reference, and writes the merged applicant. The
// children are fetched WHOLE and indexed in memory rather than queried per
// lead: a per-record lookup would be one HTTP round trip per applicant per
// table, which is how a backfill of two hundred leads becomes six hundred
// requests against somebody else's rate limit.
//
// ## What it deliberately does NOT do
//
// It does not fan out notifications: only fresh browser/Make-forwarded
// submissions (/api/public/leads/capture) do that, so a backfill can never spam
// operators with a hundred stale alerts.
//
// It does not compute a score, a grade or a priority class. Airtable holds
// `Review Status` and `Needs Conditional Review`, which are an operator's own
// judgement and travel as facts; everything else on this page is the
// applicant's own words. The engine that reads them and forms an opinion is
// `crm.fit`, and it reads `stage2_answers` — which this now fills.
import crypto from "crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  cleanLeadText,
  normaliseApplicationId,
  LEAD_MAX_TEXT_LENGTH,
} from "@/server/lead-capture.server";
import {
  FIELDS,
  booleanField,
  listField,
  numberField,
  preferredBooking,
  readStage2,
  readStage3,
  reachedField,
  textField,
  timestampField,
  type AirtableRecord,
  type Stage2Enrichment,
  type Stage3Enrichment,
} from "@/server/airtableLeadMapping.pure";
import { enqueueStageEmails } from "@/server/lead-stage-emails.server";

const AIRTABLE_BASE_ID = "apptyShYE0yzL4IGB";
const GATEWAY_URL = "https://connector-gateway.lovable.dev/airtable";
const PAGE_SIZE = 100;

/**
 * A ceiling on how many pages one tick will walk per table, so a table that
 * grows unexpectedly (or a gateway that never stops answering an offset)
 * cannot spend the whole invocation. 200 pages is 20,000 records — two orders
 * of magnitude above the live funnel — and being short is reported rather than
 * silent, because a truncated walk that looks complete is how a backfill
 * quietly stops covering the tail.
 */
const MAX_PAGES = 200;

const TABLES = {
  waitlist: "Aurixa Waitlist",
  brq: "BRQ Detailed Responses",
  legacyBrq: "Business Readiness Responses",
  bookings: "Strategic Review Bookings",
} as const;

type AirtablePage = {
  records: AirtableRecord[];
  offset?: string;
};

function isEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function dedupeKeyFor(email: string, submittedAt: string | null): string | null {
  if (!submittedAt) return null;
  return crypto.createHash("sha256").update(`${email}|${submittedAt}`).digest("hex");
}

async function fetchAirtablePage(table: string, offset?: string): Promise<AirtablePage> {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const airtableKey = process.env.AIRTABLE_API_KEY;
  if (!lovableKey) throw new Error("LOVABLE_API_KEY not configured");
  if (!airtableKey) throw new Error("AIRTABLE_API_KEY not configured");

  const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
  if (offset) params.set("offset", offset);
  const url = `${GATEWAY_URL}/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?${params}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": airtableKey,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable gateway ${res.status} on ${table}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as AirtablePage;
}

type TableWalk = { records: AirtableRecord[]; pages: number; truncated: boolean };

/** Every record in one table, paged to the end (or to `MAX_PAGES`). */
async function walkTable(table: string): Promise<TableWalk> {
  const records: AirtableRecord[] = [];
  let offset: string | undefined;
  let pages = 0;
  do {
    const page = await fetchAirtablePage(table, offset);
    pages += 1;
    records.push(...page.records);
    offset = page.offset;
  } while (offset && pages < MAX_PAGES);
  return { records, pages, truncated: Boolean(offset) };
}

/**
 * A child table walked, or the reason it was not.
 *
 * A child table that cannot be read must not fail the whole sync: the parent
 * rows are still worth mirroring, and a Stage 1 backfill that refuses because
 * the questionnaire table 404s is a worse outcome than an enrichment that is
 * one tick stale. The failure is counted and returned, never swallowed.
 */
async function walkOptional(table: string): Promise<TableWalk & { error: string | null }> {
  try {
    const walk = await walkTable(table);
    return { ...walk, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`airtable sync: could not read "${table}"`, message);
    return { records: [], pages: 0, truncated: false, error: message.slice(0, 300) };
  }
}

/**
 * Indexes child records by the two keys that can identify an applicant.
 *
 * The application reference is the real key — the one Airtable's own link
 * automations match on. Email is the fallback for a response filed before the
 * reference existed, or one where the applicant mistyped it. Email can be
 * wrong (shared inboxes), so it is only ever consulted when the reference
 * missed, which is the same ordering `findLeadForStage` uses on the ingest.
 */
type ChildIndex<T> = { byApplication: Map<string, T[]>; byEmail: Map<string, T[]> };

function indexChildren<T>(
  records: AirtableRecord[],
  spec: { applicationId: readonly string[]; email: readonly string[] },
  read: (record: AirtableRecord) => T,
): ChildIndex<T> {
  const byApplication = new Map<string, T[]>();
  const byEmail = new Map<string, T[]>();
  for (const record of records) {
    const value = read(record);
    const reference = normaliseApplicationId(
      textField(record.fields, spec.applicationId, cleanLeadText),
    );
    const email = textField(record.fields, spec.email, cleanLeadText).toLowerCase();
    if (reference) {
      const bucket = byApplication.get(reference) ?? [];
      bucket.push(value);
      byApplication.set(reference, bucket);
    }
    if (email && isEmail(email)) {
      const bucket = byEmail.get(email) ?? [];
      bucket.push(value);
      byEmail.set(email, bucket);
    }
  }
  return { byApplication, byEmail };
}

function lookup<T>(index: ChildIndex<T>, reference: string | null, email: string): T[] {
  if (reference) {
    const hit = index.byApplication.get(reference);
    if (hit?.length) return hit;
  }
  return index.byEmail.get(email) ?? [];
}

/**
 * The parent row — Stage 1, the rollups, and the invite/access lifecycle.
 *
 * Exported because the test suite drives it directly: the mapping from
 * Airtable's shapes to the lead row is the part that breaks when somebody
 * renames a column, and it is worth asserting without a network.
 */
export function mapRecord(rec: AirtableRecord) {
  const f = rec.fields;
  const spec = FIELDS.waitlist;
  const text = (names: readonly string[], max?: number) => textField(f, names, cleanLeadText, max);

  const first_name = text(spec.firstName);
  const last_name = text(spec.lastName);
  const email = text(spec.email).toLowerCase();
  if (!first_name || !last_name || !email || !isEmail(email)) return null;

  const submittedRaw = text(spec.dateAdded);
  const submittedMs = submittedRaw ? Date.parse(submittedRaw) : NaN;
  const submitted_at = Number.isFinite(submittedMs)
    ? new Date(submittedMs).toISOString()
    : rec.createdTime;

  const stage2Reached = reachedField(f, spec.stage2Reached);
  const stage3Reached = reachedField(f, spec.stage3Reached);

  return {
    application_id: normaliseApplicationId(text(spec.applicationId)),
    first_name,
    last_name,
    email,
    mobile_number: text(spec.phone) || null,
    entity_name: text(spec.entityName) || null,
    entity_classification: text(spec.entityClassification) || null,
    transaction_volume: text(spec.volume) || null,
    tech_stack_bottlenecks: text(spec.bottlenecks, LEAD_MAX_TEXT_LENGTH) || null,
    notes: text(spec.notes, LEAD_MAX_TEXT_LENGTH) || null,

    // Stage 1 answers the previous mapping ignored entirely.
    role: text(spec.role) || null,
    primary_areas: listField(f, spec.primaryAreas, cleanLeadText),
    additional_notes: text(spec.additionalNotes, LEAD_MAX_TEXT_LENGTH) || null,
    form_version: text(spec.formVersion) || null,
    privacy_acknowledged: booleanField(f, spec.privacyAcknowledged),
    privacy_notice_version: text(spec.privacyNoticeVersion) || null,
    marketing_consent: booleanField(f, spec.marketingConsent),

    // Attribution, recorded silently at Stage 1.
    landing_page: text(spec.landingPage, 500) || null,
    referrer: text(spec.referrer, 500) || null,
    utm_source: text(spec.utmSource) || null,
    utm_medium: text(spec.utmMedium) || null,
    utm_campaign: text(spec.utmCampaign) || null,
    utm_term: text(spec.utmTerm) || null,
    utm_content: text(spec.utmContent) || null,

    // Journey — the whole point of syncing more than once.
    stage: stage3Reached ? 3 : stage2Reached ? 2 : 1,
    stage2_status: text(spec.stage2CompletionStatus) || (stage2Reached ? "Reached" : null),
    // Despite its name, "Stage 2 Started At" rolls up the BRQ response's
    // *submitted* time — the questionnaire is written once, on completion.
    stage2_completed_at: timestampField(f, spec.stage2StartedAt, cleanLeadText),
    stage3_status: text(spec.stage3BookingStatus) || (stage3Reached ? "Reached" : null),
    stage3_booked_at: timestampField(f, spec.stage3BookedAt, cleanLeadText),
    stage3_session_start: timestampField(f, spec.stage3SessionStart, cleanLeadText),

    // The invitation and access lifecycle. None of this was read before, and
    // it is what answers "has anybody actually contacted this applicant".
    stage1_email_message_id: text(spec.emailMessageId) || null,
    stage2_invite_sent_at: timestampField(f, spec.stage2InviteSentAt, cleanLeadText),
    stage2_invite_count: numberField(f, spec.stage2InviteCount),
    stage3_invite_sent_at: timestampField(f, spec.stage3InviteSentAt, cleanLeadText),
    stage3_invite_count: numberField(f, spec.stage3InviteCount),
    questionnaire_token_status: text(spec.tokenStatus) || null,
    questionnaire_token_expires_at: timestampField(f, spec.tokenExpiresAt, cleanLeadText),
    stage3_access_state: text(spec.stage3Access) || null,
    stage3_access_denied_reason: text(spec.stage3AccessDenied, LEAD_MAX_TEXT_LENGTH) || null,
    stage3_booking_url: text(spec.stage3BookingUrl, 1000) || null,

    submitted_at,
    airtable_record_id: rec.id,
    airtable_status: text(spec.status) || null,
    airtable_created_time: rec.createdTime,
  };
}

type MappedRecord = NonNullable<ReturnType<typeof mapRecord>>;

/** The columns the Airtable mirror owns, in the shape the table stores them. */
function rowFor(
  mapped: MappedRecord,
  stage2: Stage2Enrichment | null,
  stage3: Stage3Enrichment | null,
  childWalksAnswered: boolean,
) {
  const { airtable_created_time, ...row } = mapped;

  // The child tables are the fuller reading and win where they answered: the
  // rollup says "Completed", the response says WHAT. Where a child is absent
  // the parent's rollup stands, so an applicant whose questionnaire row was
  // deleted still reads as having reached Stage 2.
  // A child's NULL is not a statement about the parent.
  //
  // `Stage2Enrichment` and `Stage3Enrichment` carry every key they declare,
  // nulls included, so spreading one whole writes NULL over a parent rollup
  // that was read correctly whenever the child is present but one cell is
  // empty. `stage3_booked_at` is the one that bites: it exists on both, and
  // every stage-email decision turns on it — `stageOccurredAt` reads it,
  // `hasReachedStage` gates on it, so erasing it makes the obligation resolve
  // to "stage not reached" and vanish with nothing reporting it.
  //
  // The child still WINS where it answered. It is only silence that no longer
  // counts as an answer.
  const merged = {
    ...row,
    ...stated(stage2),
    ...stated(stage3),
  };

  // Never walk the journey backwards on the strength of a child that has not
  // been linked yet: a Stage 2 response present with no rollup is still Stage 2.
  merged.stage = Math.max(row.stage, stage2 ? 2 : 1, stage3 ? 3 : 1) as 1 | 2 | 3;

  return {
    ...merged,
    source: "airtable_mirror",
    page: null,
    metadata: {
      channel: "airtable_mirror",
      airtable_record_id: mapped.airtable_record_id,
      airtable_created_time,
      ...(mapped.airtable_status ? { airtable_status: mapped.airtable_status } : {}),
    },
    synced_at: new Date().toISOString(),
    // `enrichment_synced_at` records that we LOOKED at everything this row's
    // evidence comes from, and the applicant backstop reads it as exactly
    // that: an absent receipt counts as "the workflow did not send" only
    // where the mirror has read the record since. So a tick whose child walk
    // FAILED must not stamp it. `stage3_confirmation_sent_at` is mapped by
    // the bookings child and by nothing else, so a failed bookings read
    // leaves it null — and a stamp beside that null says "we looked and
    // there is no receipt", which sends a duplicate Stage 3 confirmation.
    //
    // Omitted rather than nulled: the previous stamp is the honest answer to
    // "when did we last read all of this", and keeping it holds the backstop
    // rather than resetting it.
    ...(childWalksAnswered ? { enrichment_synced_at: new Date().toISOString() } : {}),
  };
}

/**
 * A child enrichment with its unstated cells dropped.
 *
 * `undefined` is absent from a spread; `null` is an instruction to erase.
 * These objects declare every key, so only the first is ever meant.
 */
function stated<T extends Record<string, unknown>>(child: T | null): Partial<T> {
  if (!child) return {};
  return Object.fromEntries(
    Object.entries(child).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<T>;
}

/**
 * Finds the row this Airtable record already maps to, in key order:
 * the Airtable record id we stored last time, then the application reference,
 * then the Stage 1 dedupe hash (which is how a browser-captured lead and its
 * Airtable twin recognise each other).
 */
async function findExisting(mapped: MappedRecord, dedupeKey: string | null) {
  for (const [column, value] of [
    ["airtable_record_id", mapped.airtable_record_id],
    ["application_id", mapped.application_id],
    ["dedupe_key", dedupeKey],
  ] as const) {
    if (!value) continue;
    const { data } = await supabaseAdmin
      .from("waitlist_leads")
      .select("id, stage, status")
      .eq(column, value)
      .maybeSingle();
    if (data) return data;
  }
  return null;
}

export type AirtableSyncResult = {
  pages: number;
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped_invalid: number;
  errors: number;
  /** Child-table coverage, so a silent enrichment gap is a number on screen. */
  stage2_enriched: number;
  stage3_enriched: number;
  child_records: { brq: number; legacy_brq: number; bookings: number };
  child_errors: string[];
  truncated: string[];
  /** Stage emails this tick found were owed and queued. */
  emails_queued: number;
};

export async function syncAirtableWaitlist(): Promise<AirtableSyncResult> {
  const out: AirtableSyncResult = {
    pages: 0,
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped_invalid: 0,
    errors: 0,
    stage2_enriched: 0,
    stage3_enriched: 0,
    child_records: { brq: 0, legacy_brq: 0, bookings: 0 },
    child_errors: [],
    truncated: [],
    emails_queued: 0,
  };

  // The children first, so every parent row can be written complete in one
  // pass. Three independent reads, so they go together rather than in series.
  const [brq, legacyBrq, bookings] = await Promise.all([
    walkOptional(TABLES.brq),
    walkOptional(TABLES.legacyBrq),
    walkOptional(TABLES.bookings),
  ]);

  for (const [walk, table] of [
    [brq, TABLES.brq],
    [legacyBrq, TABLES.legacyBrq],
    [bookings, TABLES.bookings],
  ] as const) {
    if (walk.error) out.child_errors.push(`${table}: ${walk.error}`);
    if (walk.truncated) out.truncated.push(table);
    out.pages += walk.pages;
  }
  out.child_records = {
    brq: brq.records.length,
    legacy_brq: legacyBrq.records.length,
    bookings: bookings.records.length,
  };

  // Whether this tick READ everything a row's evidence comes from. Coarse on
  // purpose: a failed BRQ walk does not touch Stage 3's receipt, but the
  // conservative side of not knowing is the one that does not send, and one
  // boolean cannot drift from the three walks it summarises.
  const childWalksAnswered = !brq.error && !legacyBrq.error && !bookings.error;

  const brqIndex = indexChildren(brq.records, FIELDS.brq, (record) =>
    readStage2(record, FIELDS.brq as never, cleanLeadText, LEAD_MAX_TEXT_LENGTH),
  );
  const legacyIndex = indexChildren(legacyBrq.records, FIELDS.legacyBrq, (record) =>
    readStage2(record, FIELDS.legacyBrq as never, cleanLeadText, LEAD_MAX_TEXT_LENGTH),
  );
  const bookingIndex = indexChildren(bookings.records, FIELDS.booking, (record) =>
    readStage3(record, cleanLeadText, LEAD_MAX_TEXT_LENGTH),
  );

  let offset: string | undefined = undefined;
  let parentPages = 0;
  do {
    const page = await fetchAirtablePage(TABLES.waitlist, offset);
    out.pages += 1;
    parentPages += 1;
    for (const rec of page.records) {
      out.fetched += 1;
      const mapped = mapRecord(rec);
      if (!mapped) {
        out.skipped_invalid += 1;
        continue;
      }

      // The detailed table is the current one; the legacy table is read only
      // where it has no answer, so an old response still reaches the console.
      const stage2Candidates = lookup(brqIndex, mapped.application_id, mapped.email);
      const stage2 =
        (stage2Candidates.length
          ? latestStage2(stage2Candidates)
          : latestStage2(lookup(legacyIndex, mapped.application_id, mapped.email))) ?? null;
      const stage3 =
        preferredBooking(lookup(bookingIndex, mapped.application_id, mapped.email)) ?? null;

      if (stage2) out.stage2_enriched += 1;
      if (stage3) out.stage3_enriched += 1;

      const dedupe_key =
        dedupeKeyFor(mapped.email, mapped.submitted_at) ?? `airtable:${mapped.airtable_record_id}`;
      const row = rowFor(mapped, stage2, stage3, childWalksAnswered);

      try {
        const existing = await findExisting(mapped, dedupe_key);

        if (existing) {
          // The mirror owns the Airtable-derived columns only. `status` is the
          // operator's own triage decision and `source`/`page` describe how the
          // lead first reached us — neither is Airtable's to overwrite.
          const { source: _source, page: _page, ...mirrored } = row;
          const { error } = await supabaseAdmin
            .from("waitlist_leads")
            // Never walk the journey backwards: a rollup that has not caught
            // up yet must not un-book a review we already recorded.
            .update({ ...mirrored, stage: Math.max(Number(existing.stage ?? 1), row.stage) })
            .eq("id", existing.id);
          if (error) throw error;
          out.updated += 1;
          out.emails_queued += await queueQuietly(existing.id, row);
          continue;
        }

        const { data: inserted, error } = await supabaseAdmin
          .from("waitlist_leads")
          .insert({ ...row, dedupe_key })
          .select("id")
          .single();
        if (error) {
          // Another delivery path won the race between our lookup and this
          // insert. Its row is the same submission, so that is success.
          if (error.code === "23505") {
            out.unchanged += 1;
            continue;
          }
          throw error;
        }
        out.inserted += 1;
        out.emails_queued += await queueQuietly(inserted.id, row);
      } catch (error) {
        out.errors += 1;
        console.error("airtable sync failed for record", { record: rec.id, error });
      }
    }
    offset = page.offset;
  } while (offset && parentPages < MAX_PAGES);

  if (offset) out.truncated.push(TABLES.waitlist);

  return out;
}

/**
 * The most recently submitted of several Stage 2 responses for one applicant.
 *
 * A duplicate happens: a resumed questionnaire written twice, or one filed
 * against a mistyped reference and again against the right one. The latest is
 * the applicant's current answer, and a record with no submitted time sorts
 * last rather than first — an undated row is more likely to be an import than
 * the newest thing the applicant said.
 */
function latestStage2(candidates: Stage2Enrichment[]): Stage2Enrichment | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) =>
      (Date.parse(b.stage2_completed_at ?? "") || 0) -
      (Date.parse(a.stage2_completed_at ?? "") || 0),
  )[0];
}

/**
 * Records the stage emails this applicant is owed, if any.
 *
 * Wrapped because the mirror's job is the mirror: a mailer that cannot write
 * its ledger must not cost the sync the row it just mapped. What it CANNOT do
 * is send — `enqueueStageEmails` only writes obligations, and the dispatcher
 * is what puts anything on the wire. That separation is what makes it safe to
 * call from a backfill: a historical lead gets its obligations suppressed by
 * the backstop window inside the enqueue, not by this caller remembering to.
 */
async function queueQuietly(leadId: string, row: Record<string, unknown>): Promise<number> {
  try {
    const result = await enqueueStageEmails({
      leadId,
      lead: row,
      trigger: "airtable_sync",
    });
    return result.queued;
  } catch (error) {
    console.error("stage email enqueue failed during airtable sync", { leadId, error });
    return 0;
  }
}
