// Who is owed an email when an applicant finishes a stage, and who is not.
//
// Pure. No clock but the one handed in, no environment but the one handed in,
// no database. Every decision this feature can make wrongly is decided here,
// where a test can drive it.
//
// ## The two obligations are independent
//
// **Internal.** Aurixa's team is told. The measurement behind this was too
// narrow when it was written and the conclusion drawn from it was wrong.
//
// What was measured, and is still true: across all four Make blueprints every
// `toRecipients` in the funnel names the applicant and only the applicant, and
// nothing in `aurixa-systems` sends mail at all. What was NOT searched:
// Airtable's own automations. The live base runs three `sendEmail` automations
// (exported 2026-08-18 to `npc-property-dashbord/docs/integrations/airtable/
// npc-emails/automations/`), and one of them IS the internal notification:
//
//   Stage 1  `wflM9vUhBoHb0ZE8r` "Aurixa Lead Capture" — DEPLOYED, triggers on
//            `recordCreated` in Aurixa Waitlist (`tblHzGiB591W3GpoZ`), which is
//            the table Make stage 1 writes. Subject "New Lead Received", to
//            five @aurixasystems.com.au addresses. It fires.
//   Stage 2  `wflh1IWRe0okzxeTK` "Notify Aurixa Team…" — DEPLOYED, but bound to
//            Business Readiness Responses (`tblXQx00T3CKEVnvV`) while Make
//            stage 2 writes BRQ Detailed Responses (`tblB1t18q6aUTNI0g`). Two
//            different tables, so it does NOT fire.
//   Stage 3  nothing, anywhere.
//
// So this is on by default at every stage and that default DUPLICATES stage 1.
// `LEAD_STAGE_INTERNAL_STAGES` is what settles it per deployment; the rule is
// that a stage already covered by a firing automation is excluded, and one
// that is not covered is not.
//
// **Applicant.** The Make.com scenarios ALREADY send this, through Microsoft
// Graph, at all three stages. So the risk here is not silence, it is sending a
// second copy of an email the applicant already has. Mission Control therefore
// defaults to a BACKSTOP: it sends only where the operations record positively
// says nobody did.
//
// ## What "nobody did" can actually be established from
//
// The Make scenarios write their own proof back to Airtable, and the mirror now
// reads it:
//
//   Stage 1   `Email Message ID`        written by scenario 9389960, module 22
//   Stage 3   `Confirmation Sent At`    written by scenario 9601915, module 9
//   Stage 2   — nothing. Scenario 9590512 is four modules: webhook, create
//             record, compose, send. It writes nothing back.
//
// So for Stage 2 the honest answer is **we cannot tell**, and `auto` does not
// guess. It records the obligation as skipped, naming that reason, and the
// console shows it. An operator who would rather Mission Control own the Stage
// 2 acknowledgement outright sets `LEAD_STAGE_APPLICANT_MODE=always`.
//
// Guessing the other way — sending because we could not prove otherwise — is
// how an applicant gets two "Questionnaire Received" emails four minutes apart,
// and there is no undo on that.

import { emailKey, unwrapAddress } from "@/lib/email/emailAddress.pure";

export type LeadStage = 1 | 2 | 3;
export type StageAudience = "internal" | "applicant";

export type StageEmailEnv = {
  LEAD_STAGE_INTERNAL_RECIPIENTS?: string;
  LEAD_STAGE_INTERNAL_STAGES?: string;
  LEAD_STAGE_APPLICANT_MODE?: string;
  LEAD_STAGE_APPLICANT_STAGES?: string;
  LEAD_STAGE_APPLICANT_GRACE_MINUTES?: string;
  LEAD_STAGE_EMAIL_MAX_AGE_HOURS?: string;
  LEAD_STAGE_EMAIL_MAILBOX?: string;
  MICROSOFT_MAILBOX_EMAIL?: string;
  MISSION_CONTROL_URL?: string;
  AURIXA_QUESTIONNAIRE_URL?: string;
  AURIXA_REVIEW_BOOKING_URL?: string;
};

export type ApplicantMode = "auto" | "always" | "off";

export type StageEmailPolicy = {
  internalRecipients: string[];
  internalStages: Set<LeadStage>;
  applicantMode: ApplicantMode;
  applicantStages: Set<LeadStage>;
  /** How long after a stage event the applicant backstop waits before it fires. */
  applicantGraceMs: number;
  /**
   * How old a stage event may be and still raise an obligation.
   *
   * This is the single most important number here. Without it, the first tick
   * after this ships raises an obligation for every historical applicant in the
   * table and mails a year of funnel at once. 72 hours covers a webhook that
   * failed and a sync that had not run, and covers nothing older.
   */
  maxAgeMs: number;
  mailbox: string | null;
  consoleUrl: string;
  questionnaireUrl: string | null;
  bookingUrl: string | null;
  /**
   * How `internalRecipients` was arrived at. Recorded on every ledger row,
   * because the difference between "five people were told" and "one was"
   * must not be something an operator has to infer from an env var.
   */
  internalRecipientSource: RecipientSource;
  /** Entries the list carried that could not be an address, and why. */
  internalRecipientsDropped: DroppedRecipient[];
};

export type RecipientSource = "configured" | "mailbox_fallback" | "applicant" | "none";

export type DroppedRecipient = { value: string; reason: string };

export type RecipientResolution = {
  recipients: string[];
  source: RecipientSource;
  dropped: DroppedRecipient[];
};

const DEFAULT_CONSOLE_URL = "https://mission-control.aurixasystems.com.au";

/**
 * A RECIPIENT list, split on separators a person would type deliberately.
 *
 * Not `list()`, which splits on whitespace too. Whitespace is the right
 * separator for a stage list (`"1 2 3"`) and the wrong one for addresses: it
 * shreds `Rugesh Naidu <rugesh@…>` into three tokens, which is exactly how an
 * address arrives when somebody pastes a contact out of Outlook, and it makes
 * the `unwrapAddress` reading below unreachable. Splitting on comma, semicolon
 * and newline keeps the display-name form intact for `unwrapAddress` to read,
 * and a leading or trailing space is still trimmed off each entry.
 */
function addressList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,;\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stageSet(value: string | undefined, fallback: LeadStage[]): Set<LeadStage> {
  const parsed = list(value)
    .map((item) => Number(item))
    .filter((n): n is LeadStage => n === 1 || n === 2 || n === 3);
  // An explicitly empty value means "none" and must not silently re-open the
  // default: `LEAD_STAGE_INTERNAL_STAGES=""` is somebody switching it off.
  if (value !== undefined && value.trim() === "") return new Set();
  if (value !== undefined && value.trim().toLowerCase() === "none") return new Set();
  return new Set(parsed.length ? parsed : fallback);
}

/**
 * Who the team's notification actually goes to, and how that was decided.
 *
 * Three things happen here that all exist because of one live defect. The
 * Airtable automation this mailer replaces carries a LEADING SPACE on four of
 * its five recipients (` rugesh@…`, ` lavan@…`, ` arvinraj@…`,
 * ` mithrubanbupathy@…`; only `admin@` is clean) and nothing anywhere records
 * whether they are trimmed before the send. If they are not, four people have
 * never received a lead alert and no surface says so.
 *
 * So: whitespace is trimmed (and a test pins that, naming the defect); an
 * address repeated in a different case is collapsed rather than mailed twice;
 * and anything that cannot be an address is dropped WITH ITS REASON rather
 * than passed to Graph to fail on — which matters more than it looks, because
 * Graph refuses the WHOLE message for one bad recipient, so a single typo in
 * this variable silences the notification for everybody on it.
 *
 * The reading of an address is `emailKey`/`unwrapAddress` and never a private
 * regex. An earlier version of this function carried its own shallow pattern,
 * and a second reading of an address is precisely the defect that lets an
 * address the SUPPRESSION REGISTER cannot key reach the wire: the register is
 * asked `emailKey(address)`, so anything this function admits that `emailKey`
 * rejects is invisible to it and is mailed however many times somebody has
 * asked us to stop. One reading, or the two disagree in the gap.
 *
 * The fallback to the sending mailbox is kept — refusing would mean nobody is
 * told, which is worse than one person being told — but it is NAMED, because
 * as the sole notifier a silent collapse from five recipients to one is the
 * same failure in a different place.
 */
export function resolveInternalRecipients(
  explicit: string[],
  mailbox: string | null,
): RecipientResolution {
  const dropped: DroppedRecipient[] = [];
  const seen = new Map<string, string>();

  for (const entry of explicit) {
    // `unwrapAddress` is what strips the leading space, the angle brackets a
    // copied Outlook contact arrives in, and a `mailto:` prefix.
    const address = unwrapAddress(entry);
    const key = emailKey(address);
    if (!key) {
      dropped.push({ value: entry, reason: "not an address this deployment can send to" });
      continue;
    }
    if (seen.has(key)) {
      dropped.push({ value: entry, reason: "the same address, already listed" });
      continue;
    }
    // Stored as spelled (trimmed), keyed by identity: `Rugesh@…` renders as
    // typed and still collapses against `rugesh@…`.
    seen.set(key, address);
  }

  const recipients = [...seen.values()];
  if (recipients.length) return { recipients, source: "configured", dropped };

  const fallback = mailbox ? unwrapAddress(mailbox) : "";
  if (fallback && emailKey(fallback)) {
    return { recipients: [fallback], source: "mailbox_fallback", dropped };
  }
  return { recipients: [], source: "none", dropped };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function readPolicy(env: StageEmailEnv): StageEmailPolicy {
  const mailbox =
    (env.LEAD_STAGE_EMAIL_MAILBOX ?? env.MICROSOFT_MAILBOX_EMAIL ?? "").trim() || null;

  // With no explicit recipient list the team's own sending mailbox is the
  // recipient. That is deliberately a real destination rather than a refusal:
  // a deployment that has configured a mailbox and forgotten the recipients
  // should still be told about its leads, in the inbox it already watches.
  const internal = resolveInternalRecipients(
    addressList(env.LEAD_STAGE_INTERNAL_RECIPIENTS),
    mailbox,
  );
  const internalRecipients = internal.recipients;

  const rawMode = (env.LEAD_STAGE_APPLICANT_MODE ?? "auto").trim().toLowerCase();
  const applicantMode: ApplicantMode =
    rawMode === "always" || rawMode === "on"
      ? "always"
      : rawMode === "off" || rawMode === "none" || rawMode === "false"
        ? "off"
        : "auto";

  return {
    internalRecipients,
    internalStages: stageSet(env.LEAD_STAGE_INTERNAL_STAGES, [1, 2, 3]),
    applicantMode,
    applicantStages: stageSet(env.LEAD_STAGE_APPLICANT_STAGES, [1, 2, 3]),
    applicantGraceMs: positiveNumber(env.LEAD_STAGE_APPLICANT_GRACE_MINUTES, 45) * 60_000,
    maxAgeMs: positiveNumber(env.LEAD_STAGE_EMAIL_MAX_AGE_HOURS, 72) * 3_600_000,
    mailbox,
    consoleUrl: (env.MISSION_CONTROL_URL ?? DEFAULT_CONSOLE_URL).replace(/\/+$/, ""),
    questionnaireUrl: (env.AURIXA_QUESTIONNAIRE_URL ?? "").trim() || null,
    bookingUrl: (env.AURIXA_REVIEW_BOOKING_URL ?? "").trim() || null,
    internalRecipientSource: internal.source,
    internalRecipientsDropped: internal.dropped,
  };
}

/** The lead fields the decision reads. Deliberately a narrow surface. */
export type StageEmailSubject = {
  stage?: number | null;
  created_at?: string | null;
  submitted_at?: string | null;
  email?: string | null;
  stage2_completed_at?: string | null;
  stage3_booked_at?: string | null;
  /** Proof the Stage 1 acknowledgement went: Graph's message id. */
  stage1_email_message_id?: string | null;
  /** Proof the Stage 3 confirmation went. */
  stage3_confirmation_sent_at?: string | null;
  /**
   * When the Airtable mirror last read this lead's record.
   *
   * `airtable-sync` is the ONLY writer of `waitlist_leads` and it stamps this
   * on every row it writes, so the column is not "when we last enriched" — it
   * is *when we last looked*, which is the only thing that turns a missing
   * receipt into evidence about the workflow rather than about the mirror.
   */
  enrichment_synced_at?: string | null;
};

export type StageDecision =
  | { verdict: "send" }
  | { verdict: "skip"; reason: string }
  /** Not owed at all — no ledger row is written. */
  | { verdict: "none"; reason: string };

/** When the stage this obligation is about actually happened. */
export function stageOccurredAt(lead: StageEmailSubject, stage: LeadStage): string | null {
  if (stage === 3) return lead.stage3_booked_at ?? null;
  if (stage === 2) return lead.stage2_completed_at ?? null;
  return lead.submitted_at ?? lead.created_at ?? null;
}

/**
 * Whether this applicant has actually reached the stage.
 *
 * Stage 1 is reached by existing. Stages 2 and 3 need their own timestamp —
 * `stage` alone is not enough, because the column is the FURTHEST stage reached
 * and a Stage 3 booking sets it to 3 whether or not a questionnaire was ever
 * completed. Emailing "your questionnaire has been received" to somebody who
 * never filled one in is the failure that distinction prevents.
 */
export function hasReachedStage(lead: StageEmailSubject, stage: LeadStage): boolean {
  if (stage === 1) return true;
  return Boolean(stageOccurredAt(lead, stage));
}

export function decideInternal(
  lead: StageEmailSubject,
  stage: LeadStage,
  policy: StageEmailPolicy,
  now: number,
): StageDecision {
  if (!hasReachedStage(lead, stage)) return { verdict: "none", reason: "stage not reached" };
  const occurred = stageOccurredAt(lead, stage);
  if (isTooOld(occurred, policy.maxAgeMs, now)) {
    return { verdict: "none", reason: "outside the stage-email window" };
  }
  if (!policy.internalStages.has(stage)) {
    return { verdict: "skip", reason: `internal email is switched off for stage ${stage}` };
  }
  if (policy.internalRecipients.length === 0) {
    return {
      verdict: "skip",
      reason: "no internal recipients configured (set LEAD_STAGE_INTERNAL_RECIPIENTS)",
    };
  }
  return { verdict: "send" };
}

export function decideApplicant(
  lead: StageEmailSubject,
  stage: LeadStage,
  policy: StageEmailPolicy,
  now: number,
): StageDecision {
  if (!hasReachedStage(lead, stage)) return { verdict: "none", reason: "stage not reached" };
  if (!lead.email) return { verdict: "none", reason: "no applicant address" };

  const occurred = stageOccurredAt(lead, stage);
  if (isTooOld(occurred, policy.maxAgeMs, now)) {
    return { verdict: "none", reason: "outside the stage-email window" };
  }
  if (policy.applicantMode === "off") {
    return { verdict: "skip", reason: "applicant email is switched off on this deployment" };
  }
  if (!policy.applicantStages.has(stage)) {
    return { verdict: "skip", reason: `applicant email is switched off for stage ${stage}` };
  }
  if (policy.applicantMode === "always") return { verdict: "send" };

  // ── auto: the backstop ──────────────────────────────────────────────────
  const evidence = applicantEmailEvidence(lead, stage, policy.applicantGraceMs, now);
  if (evidence.sent === true) {
    return { verdict: "skip", reason: "the workflow already emailed the applicant" };
  }
  if (evidence.sent === null) {
    // The two ways of not knowing want OPPOSITE handling, and collapsing them
    // is how this branch has already failed once.
    //
    // A `skip` writes a TERMINAL ledger row: the upsert carries
    // `ignoreDuplicates` on (lead_id, stage, audience), so nothing can ever
    // replace it with a later, better-informed decision. That is right where
    // the not-knowing is PERMANENT — Stage 2's scenario writes no receipt
    // anywhere, so no tick will ever know more than this one does, and the
    // operator's lever is named in the reason. It is wrong where the
    // not-knowing is merely CURRENT: a terminal row there freezes the wrong
    // answer for a lead the very next sync would have settled, which is
    // exactly the defect this branch shipped against the grace clock.
    if (evidence.why === "mirror_has_not_read_since") {
      return {
        verdict: "none",
        reason: "the mirror has not read this lead's record since the stage happened",
      };
    }
    return {
      verdict: "skip",
      reason:
        "cannot tell whether the workflow emailed the applicant at this stage — set LEAD_STAGE_APPLICANT_MODE=always to have Mission Control own this send",
    };
  }
  // Established: the mirror looked, after the workflow's own window closed,
  // and found no receipt. Nobody has emailed this applicant.
  return { verdict: "send" };
}

/**
 * What is established about the funnel's own acknowledgement.
 *
 * `sent: true` it went, `sent: false` it did not, `sent: null` we do not know —
 * and the third reading is the whole point. Collapsing it into `false` sends a
 * duplicate; collapsing it into `true` leaves an applicant unacknowledged. It
 * also carries WHY, because the two ways of not knowing are not alike and the
 * caller must treat them differently (see `decideApplicant`).
 */
export type ApplicantEmailEvidence =
  | { sent: true }
  | { sent: false }
  | { sent: null; why: "no_receipt_is_written" | "mirror_has_not_read_since" };

/**
 * Read the evidence, never guess at it.
 *
 * ## An absent receipt is a fact about the MIRROR until it is one about the
 * ## WORKFLOW
 *
 * `Boolean(lead.stage1_email_message_id)` reads a null receipt as "the workflow
 * did not send", and that is only true once somebody has actually looked.
 * `airtable-sync` is the only writer of `waitlist_leads` and runs hourly, so a
 * row can hold a null receipt for either of two reasons and the column cannot
 * tell them apart:
 *
 *   - the workflow did not send, or
 *   - the mirror has not read the record since it did.
 *
 * The second is not hypothetical. `stage1_email_message_id` and
 * `enrichment_synced_at` were added by the SAME migration, so on the first tick
 * after that ships every row in the table reads null — not because nobody was
 * emailed, but because nothing had yet mapped the column. Read as "not sent",
 * every in-window applicant of the last 72 hours takes a second copy of an
 * email they already have, on one tick, with no undo.
 *
 * So the absence counts as evidence only where the mirror READ the record after
 * the workflow's own window closed. The instrument is `enrichment_synced_at`,
 * which the mirror stamps on every row it writes whether or not the receipt was
 * populated — it records that we LOOKED, which is the question being asked.
 * That it arrived alongside the receipt columns is what makes the guard exactly
 * right rather than merely cautious: "the mirror has not read this row since
 * the receipt became mappable" and "`enrichment_synced_at` is null" are the
 * same condition.
 *
 * ## Holding is never permanent, and that is a property of the INGRESS
 *
 * The obvious objection is that this suppresses the backstop exactly where it
 * is needed: a lead the mirror never reads keeps `enrichment_synced_at` null
 * for ever, so an applicant nobody emailed would never be acknowledged. It
 * does not, and the reason is not in this module.
 *
 * `waitlist_leads` has two writers, and BOTH are downstream of the Make
 * scenario having already run. The mirror writes rows it found in Airtable.
 * The capture route writes rows delivered either by the site's dual-write —
 * which fires the Make webhook first and posts here only ON SUCCESS — or by
 * an HTTP module inside the scenario itself. So a row existing at all means
 * the scenario ran, which means the Airtable record exists, which means the
 * mirror has something to link and will stamp this row on its next pass.
 * An unlinked row is a row waiting for the next hourly sync, never a row
 * waiting for ever, and `maxAgeMs` is 72 hours against that one hour.
 *
 * Which also says what the backstop is actually FOR. Not "the scenario never
 * ran" — that population cannot reach this table. It is "the scenario ran,
 * created the record, and its email step failed or wrote no receipt back".
 * That case has an Airtable record by construction, so the mirror reads it,
 * stamps the row, finds no receipt, and this answers `sent: false` on the
 * earliest tick that can honestly say so — the sync enqueues with the row it
 * has just stamped, so the backstop fires from the sync itself.
 *
 * ## The grace period lives here now
 *
 * The window is the operator's own `LEAD_STAGE_APPLICANT_GRACE_MINUTES`: the
 * declared answer to "how long after a stage event does an absence start to
 * mean something". Requiring the mirror's read to land at or after the end of
 * that window also closes the race where the mirror catches an Airtable record
 * between the module that creates it and the module that writes the receipt
 * back — seconds apart in one scenario run, but enough.
 *
 * It SUBSUMES the clock-only check it replaces. A mirror cannot read the
 * future, so `looked >= occurred + grace` implies `now >= occurred + grace`:
 * every lead the old check held, this holds, and it holds several the old one
 * let through. Two checks where one implies the other is one check and a piece
 * of dead code, so there is one.
 */
export function applicantEmailEvidence(
  lead: StageEmailSubject,
  stage: LeadStage,
  graceMs: number,
  now: number,
): ApplicantEmailEvidence {
  // Stage 2's scenario is four modules — webhook, create, compose, send — and
  // writes nothing back. No amount of waiting makes that absence mean anything,
  // so this reading is permanent and the caller may act on it.
  if (stage === 2) return { sent: null, why: "no_receipt_is_written" };

  const receipt = stage === 1 ? lead.stage1_email_message_id : lead.stage3_confirmation_sent_at;
  if (receipt) return { sent: true };

  return mirrorLookedAfterGrace(lead, stage, graceMs, now)
    ? { sent: false }
    : { sent: null, why: "mirror_has_not_read_since" };
}

/** Did the mirror read this record at or after the end of the grace window? */
function mirrorLookedAfterGrace(
  lead: StageEmailSubject,
  stage: LeadStage,
  graceMs: number,
  now: number,
): boolean {
  const occurred = Date.parse(stageOccurredAt(lead, stage) ?? "");
  // An event with no readable time cannot have been looked at "since" — and
  // the conservative side of not knowing is the one that does not send.
  if (!Number.isFinite(occurred)) return false;

  const looked = Date.parse(lead.enrichment_synced_at ?? "");
  if (!Number.isFinite(looked)) return false;

  // A stamp from the future is a clock disagreement, not a reading: trust the
  // earlier of the two rather than letting a skewed mirror satisfy the window.
  return Math.min(looked, now) >= occurred + Math.max(0, graceMs);
}

function isTooOld(occurred: string | null, maxAgeMs: number, now: number): boolean {
  if (maxAgeMs <= 0) return false;
  if (!occurred) return false;
  const ms = Date.parse(occurred);
  if (!Number.isFinite(ms)) return false;
  return now - ms > maxAgeMs;
}

/** The link an applicant email offers at each stage, or null for no button. */
export function nextStepUrlFor(stage: LeadStage, policy: StageEmailPolicy): string | null {
  if (stage === 1) return policy.questionnaireUrl;
  if (stage === 2) return policy.bookingUrl;
  return null;
}
