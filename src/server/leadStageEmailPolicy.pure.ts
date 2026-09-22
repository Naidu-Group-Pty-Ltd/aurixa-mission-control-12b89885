// Who is owed an email when an applicant finishes a stage, and who is not.
//
// Pure. No clock but the one handed in, no environment but the one handed in,
// no database. Every decision this feature can make wrongly is decided here,
// where a test can drive it.
//
// ## The two obligations are independent
//
// **Internal.** Aurixa's team is told. Nothing anywhere sent this before —
// measured on all four Make blueprints, every `toRecipients` in the funnel
// names the applicant and only the applicant — so Mission Control owns it
// outright and it is on by default.
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
};

const DEFAULT_CONSOLE_URL = "https://mission-control.aurixasystems.com.au";

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
  const explicit = list(env.LEAD_STAGE_INTERNAL_RECIPIENTS);
  const internalRecipients = explicit.length ? explicit : mailbox ? [mailbox] : [];

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

  // ── auto: the backstop ───────────────────────────────────────────────────
  const alreadySent = applicantAlreadyEmailed(lead, stage);
  if (alreadySent === true) {
    return { verdict: "skip", reason: "the workflow already emailed the applicant" };
  }
  if (alreadySent === null) {
    return {
      verdict: "skip",
      reason:
        "cannot tell whether the workflow emailed the applicant at this stage — set LEAD_STAGE_APPLICANT_MODE=always to have Mission Control own this send",
    };
  }
  // Known NOT sent. Wait out the grace period so a delivery still in flight,
  // or a sync that has not run since it, is not overtaken by this.
  const since = occurred ? now - Date.parse(occurred) : Number.POSITIVE_INFINITY;
  if (Number.isFinite(since) && since < policy.applicantGraceMs) {
    return { verdict: "skip", reason: "waiting for the workflow's own acknowledgement" };
  }
  return { verdict: "send" };
}

/**
 * Whether the funnel's own scenario already emailed this applicant.
 *
 * `true` it did, `false` it did not, `null` there is no evidence either way —
 * and the third value is the whole point. Collapsing `null` into `false` sends
 * a duplicate; collapsing it into `true` leaves an applicant unacknowledged.
 * Neither is acceptable, so the caller decides what to do with not knowing.
 */
export function applicantAlreadyEmailed(
  lead: StageEmailSubject,
  stage: LeadStage,
): boolean | null {
  if (stage === 1) return Boolean(lead.stage1_email_message_id);
  if (stage === 3) return Boolean(lead.stage3_confirmation_sent_at);
  // Stage 2's scenario writes no receipt anywhere this deployment can read.
  return null;
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
