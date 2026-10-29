// The free trial applicant's emails, as Mission Control holds them: the
// edited copy, who sends each stage, the identity they send as, and the
// secure questionnaire links the Stage 1 email carries (docs/LEAD_EMAILS.md).
//
// The dispatcher (`lead-stage-emails.server.ts`) is still the only thing that
// sends a stage email. This module is what it reads before it does, and what
// the console writes through.
import crypto from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json, TablesInsert } from "@/integrations/supabase/types";
import { emailKey } from "@/lib/email/emailAddress.pure";
import { GATE_DEFAULT_HOURS, HOURS_PER_DAY } from "@/lib/clonePaymentGate.pure";
import {
  DEFAULT_LEAD_EMAIL_TEMPLATES,
  LEAD_STAGES,
  MAKE_EMAIL_MODULE,
  STAGE_NAMES,
  leadEmailContext,
  normaliseTemplate,
  renderLeadEmail,
  sampleContext,
  templateProblems,
  type LeadEmailSender,
  type LeadEmailSubject,
  type LeadEmailTemplate,
  type LeadStage,
  type RenderedLeadEmail,
} from "@/lib/leadEmailTemplates.pure";
import {
  defaultGraphConfig,
  sendMail,
  type GraphConfig,
  type GraphMessage,
} from "@/server/graph-client";
import { graphConfigFor } from "@/server/microsoft-tenants.server";
import { normaliseApplicationId } from "@/server/lead-capture.server";
import { readTrialOfferByCode } from "@/server/trial-offers.server";
import { normaliseOfferCode } from "@/lib/trialOffers.pure";
import { notifyOperators, writeAuditLog } from "@/server/audit.server";

type LeadRow = Database["public"]["Tables"]["waitlist_leads"]["Row"];

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function isSchemaPending(error: { code?: string | null } | null): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01" || error?.code === "42703";
}

/** How long a Stage 1 questionnaire link stays open. */
export const QUESTIONNAIRE_LINK_DAYS = 21;

const DEFAULT_SITE_URL = "https://www.aurixasystems.com.au";
const DEFAULT_SUPPORT_EMAIL = "admin@aurixasystems.com.au";

/** The website the links point at. `AURIXA_WEBSITE_URL`, else the questionnaire URL's origin. */
export function websiteUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = (env.AURIXA_WEBSITE_URL ?? "").trim();
  if (/^https?:\/\//i.test(explicit)) return explicit.replace(/\/+$/, "");
  const questionnaire = (env.AURIXA_QUESTIONNAIRE_URL ?? "").trim();
  try {
    if (questionnaire) return new URL(questionnaire).origin;
  } catch {
    // A malformed value is not an origin; the default is.
  }
  return DEFAULT_SITE_URL;
}

/** The strategic review scheduler, when the deployment names its own. */
export function reviewBookingUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = (env.AURIXA_REVIEW_BOOKING_URL ?? "").trim();
  return /^https:\/\//i.test(explicit) ? explicit : null;
}

// ── Settings ────────────────────────────────────────────────────────────────

export type LeadEmailSettings = {
  senders: Record<LeadStage, LeadEmailSender>;
  tenantId: string | null;
  fromMailbox: string | null;
  fromName: string | null;
  replyTo: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

export const DEFAULT_LEAD_EMAIL_SETTINGS: LeadEmailSettings = {
  senders: { 1: "make", 2: "make", 3: "make" },
  tenantId: null,
  fromMailbox: null,
  fromName: null,
  replyTo: null,
  updatedAt: null,
  updatedBy: null,
};

const sender = (value: unknown): LeadEmailSender =>
  value === "mission_control" ? "mission_control" : "make";

export type SettingsRead =
  | { ok: true; settings: LeadEmailSettings }
  | { ok: false; error: string; schemaPending: boolean };

export async function readLeadEmailSettings(): Promise<SettingsRead> {
  const { data, error } = await supabaseAdmin
    .from("lead_email_settings")
    .select("*")
    .eq("id", true)
    .maybeSingle();
  if (error) return { ok: false, error: error.message, schemaPending: isSchemaPending(error) };
  if (!data) return { ok: true, settings: DEFAULT_LEAD_EMAIL_SETTINGS };
  return {
    ok: true,
    settings: {
      senders: {
        1: sender(data.stage1_sender),
        2: sender(data.stage2_sender),
        3: sender(data.stage3_sender),
      },
      tenantId: data.tenant_id,
      fromMailbox: data.from_mailbox,
      fromName: data.from_name,
      replyTo: data.reply_to,
      updatedAt: data.updated_at,
      updatedBy: data.updated_by,
    },
  };
}

/**
 * What the dispatcher sends with.
 *
 * Before the migration has applied there is no row to have changed, so the
 * defaults — every stage on Make — are the truth. Any other failed read is
 * null: neither guess is safe. `make` for a stage whose Make module is off can
 * write a terminal skip; `mission_control` for one still on Make sends a
 * second copy.
 */
export async function settingsForSending(): Promise<LeadEmailSettings | null> {
  let read: SettingsRead;
  try {
    read = await readLeadEmailSettings();
  } catch (error) {
    read = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      schemaPending: false,
    };
  }
  if (read.ok) return read.settings;
  if (read.schemaPending) return DEFAULT_LEAD_EMAIL_SETTINGS;
  console.error(
    "[lead-emails] settings could not be read; applicant emails wait a tick:",
    read.error,
  );
  return null;
}

const MAILBOX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type SettingsInput = {
  tenantId: string | null;
  fromMailbox: string | null;
  fromName: string | null;
  replyTo: string | null;
  actorId: string;
};

export async function saveLeadEmailSettings(
  input: SettingsInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const fromMailbox = input.fromMailbox?.trim() || null;
  const replyTo = input.replyTo?.trim() || null;
  const fromName = input.fromName?.trim() || null;
  if (fromMailbox && !MAILBOX.test(fromMailbox)) {
    return { ok: false, error: "The sending mailbox is not an email address." };
  }
  if (replyTo && !MAILBOX.test(replyTo)) {
    return { ok: false, error: "The reply-to is not an email address." };
  }
  if (fromName && fromName.length > 80) {
    return { ok: false, error: "The sender name is longer than 80 characters." };
  }

  const { error } = await supabaseAdmin.from("lead_email_settings").upsert(
    {
      id: true,
      tenant_id: input.tenantId,
      from_mailbox: fromMailbox,
      from_name: fromName,
      reply_to: replyTo,
      updated_by: input.actorId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, error: isSchemaPending(error) ? "schema_pending" : error.message };

  await writeAuditLog({
    actorUserId: input.actorId,
    action: "lead_emails.identity_saved",
    entityType: "lead_email_settings",
    entityId: null,
    metadata: {
      tenant_id: input.tenantId,
      from_mailbox: fromMailbox,
      from_name: fromName,
      reply_to: replyTo,
    },
  });
  return { ok: true };
}

/**
 * Hands one stage's applicant email to Mission Control, or back to Make.
 *
 * The console asks for this only after the operator has said the Make module
 * is off. Every operator is told, because the change decides whether
 * applicants get one email, none or two.
 */
export async function setLeadEmailSender(input: {
  stage: LeadStage;
  sender: LeadEmailSender;
  actorId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const row: TablesInsert<"lead_email_settings"> = {
    id: true,
    updated_by: input.actorId,
    updated_at: new Date().toISOString(),
  };
  if (input.stage === 1) row.stage1_sender = input.sender;
  else if (input.stage === 2) row.stage2_sender = input.sender;
  else row.stage3_sender = input.sender;
  const { error } = await supabaseAdmin
    .from("lead_email_settings")
    .upsert(row, { onConflict: "id" });
  if (error) return { ok: false, error: isSchemaPending(error) ? "schema_pending" : error.message };

  const make = MAKE_EMAIL_MODULE[input.stage];
  await writeAuditLog({
    actorUserId: input.actorId,
    action: "lead_emails.sender_set",
    entityType: "lead_email_settings",
    entityId: null,
    metadata: { stage: input.stage, sender: input.sender, make_scenario: make.scenarioId },
  });
  await notifyOperators({
    kind: "lead_email_sender_changed",
    severity: "info",
    title:
      input.sender === "mission_control"
        ? `Mission Control now sends the "${STAGE_NAMES[input.stage]}" email`
        : `Make sends the "${STAGE_NAMES[input.stage]}" email again`,
    body:
      input.sender === "mission_control"
        ? `Stage ${input.stage} applicant emails go from Mission Control from now on. Make's ${make.scenario} (${make.scenarioId}) must not send it as well — its email modules ${make.modules} should be deleted.`
        : `Stage ${input.stage} applicant emails are Make's again (${make.scenario}, ${make.scenarioId}); Mission Control only backstops them.`,
    url: "/email/lead-emails",
    metadata: { stage: input.stage, sender: input.sender },
  });
  return { ok: true };
}

// ── Templates ───────────────────────────────────────────────────────────────

export type TemplateRecord = {
  stage: LeadStage;
  template: LeadEmailTemplate;
  /** True when no edit is saved and the shipped default applies. */
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type TemplatesRead =
  | { ok: true; records: TemplateRecord[] }
  | { ok: false; error: string; schemaPending: boolean };

export async function readLeadEmailTemplates(): Promise<TemplatesRead> {
  const { data, error } = await supabaseAdmin
    .from("lead_email_templates")
    .select("stage, subject, content, updated_at, updated_by");
  if (error) return { ok: false, error: error.message, schemaPending: isSchemaPending(error) };
  const byStage = new Map((data ?? []).map((row) => [row.stage as LeadStage, row]));
  return {
    ok: true,
    records: LEAD_STAGES.map((stage) => {
      const row = byStage.get(stage);
      return row
        ? {
            stage,
            template: normaliseTemplate(stage, { subject: row.subject, content: row.content }),
            isDefault: false,
            updatedAt: row.updated_at,
            updatedBy: row.updated_by,
          }
        : {
            stage,
            template: DEFAULT_LEAD_EMAIL_TEMPLATES[stage],
            isDefault: true,
            updatedAt: null,
            updatedBy: null,
          };
    }),
  };
}

/**
 * The template the dispatcher sends each stage with. Before the migration the
 * defaults are the only copy there is; any other failed read is null, and the
 * applicant's email waits a tick rather than going out in words an operator
 * may have replaced.
 */
export async function templatesForSending(): Promise<Record<LeadStage, LeadEmailTemplate> | null> {
  const read = await readLeadEmailTemplates();
  if (!read.ok) {
    if (read.schemaPending) return { ...DEFAULT_LEAD_EMAIL_TEMPLATES };
    console.error(
      "[lead-emails] templates could not be read; applicant emails wait a tick:",
      read.error,
    );
    return null;
  }
  return Object.fromEntries(read.records.map((r) => [r.stage, r.template])) as Record<
    LeadStage,
    LeadEmailTemplate
  >;
}

export async function saveLeadEmailTemplate(input: {
  stage: LeadStage;
  template: unknown;
  actorId: string;
}): Promise<{ ok: true } | { ok: false; error: string; problems?: string[] }> {
  const template = normaliseTemplate(input.stage, input.template);
  const problems = templateProblems(input.stage, template);
  if (problems.length)
    return { ok: false, error: "The email has problems to fix first.", problems };

  const { error } = await supabaseAdmin.from("lead_email_templates").upsert(
    {
      stage: input.stage,
      subject: template.subject,
      content: template.content as unknown as Json,
      updated_by: input.actorId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "stage" },
  );
  if (error) return { ok: false, error: isSchemaPending(error) ? "schema_pending" : error.message };

  await writeAuditLog({
    actorUserId: input.actorId,
    action: "lead_emails.template_saved",
    entityType: "lead_email_templates",
    entityId: null,
    metadata: { stage: input.stage, subject: template.subject },
  });
  return { ok: true };
}

export async function resetLeadEmailTemplate(input: {
  stage: LeadStage;
  actorId: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabaseAdmin
    .from("lead_email_templates")
    .delete()
    .eq("stage", input.stage);
  if (error) return { ok: false, error: isSchemaPending(error) ? "schema_pending" : error.message };
  await writeAuditLog({
    actorUserId: input.actorId,
    action: "lead_emails.template_reset",
    entityType: "lead_email_templates",
    entityId: null,
    metadata: { stage: input.stage },
  });
  return { ok: true };
}

// ── The sending identity ────────────────────────────────────────────────────

export type SendingIdentity =
  | {
      ok: true;
      config: GraphConfig;
      mailbox: string;
      fromName: string | null;
      replyTo: string | null;
      supportEmail: string;
    }
  | { ok: false; error: string };

/**
 * The Graph credentials, mailbox and names a lead email goes out with.
 *
 * In this order: the tenant and mailbox chosen on Email → Lead emails; else
 * the deployment's `LEAD_STAGE_EMAIL_MAILBOX`; else the tenant's default
 * mailbox. A tenant that cannot be read is a refusal, not a silent fall back
 * to a different tenant's credentials.
 */
export async function sendingIdentity(
  settings: LeadEmailSettings,
  envMailbox: string | null,
): Promise<SendingIdentity> {
  let config: GraphConfig | null;
  try {
    config = settings.tenantId ? await graphConfigFor(settings.tenantId) : defaultGraphConfig();
  } catch (error) {
    return {
      ok: false,
      error: `the Microsoft tenant could not be read: ${(error as Error).message}`,
    };
  }
  if (!config) {
    return {
      ok: false,
      error: settings.tenantId
        ? "the chosen Microsoft tenant has no usable credentials"
        : "Microsoft Graph is not configured on this deployment",
    };
  }
  const mailbox = settings.fromMailbox || envMailbox || config.mailbox || null;
  if (!mailbox) return { ok: false, error: "no sending mailbox is configured" };
  return {
    ok: true,
    config,
    mailbox,
    fromName: settings.fromName,
    replyTo: settings.replyTo,
    supportEmail: settings.replyTo || mailbox || DEFAULT_SUPPORT_EMAIL,
  };
}

/** The Graph message for one applicant email, from the identity it sends as. */
export function applicantMessage(
  rendered: RenderedLeadEmail,
  to: string[],
  identity: Extract<SendingIdentity, { ok: true }>,
): GraphMessage {
  return {
    subject: rendered.subject,
    body: { contentType: "HTML", content: rendered.html },
    toRecipients: to.map((address) => ({ emailAddress: { address } })),
    ...(identity.replyTo ? { replyTo: [{ emailAddress: { address: identity.replyTo } }] } : {}),
    ...(identity.fromName
      ? { from: { emailAddress: { address: identity.mailbox, name: identity.fromName } } }
      : {}),
  };
}

// ── The trial an applicant applied for ──────────────────────────────────────

const DEFAULT_TRIAL_DAYS = GATE_DEFAULT_HOURS / HOURS_PER_DAY;

/** Days of the trial offer the application carried, else the default. Never throws. */
export async function trialDaysFor(lead: Pick<LeadRow, "metadata">): Promise<number> {
  const meta = (lead.metadata ?? {}) as Record<string, unknown>;
  const code = normaliseOfferCode(
    typeof meta.trial_offer_code === "string" ? meta.trial_offer_code : "",
  );
  if (!code.ok) return DEFAULT_TRIAL_DAYS;
  try {
    const read = await readTrialOfferByCode(code.code);
    if (read.ok && read.offer) return read.offer.trial_days;
  } catch (error) {
    console.error("[lead-emails] trial offer read failed:", (error as Error).message);
  }
  return DEFAULT_TRIAL_DAYS;
}

// ── Questionnaire links ─────────────────────────────────────────────────────

/**
 * A secure questionnaire link for one applicant, minted for one send.
 *
 * The website checks the token's shape before anything else (16 to 256 of
 * `[A-Za-z0-9_-]`, paired with an `expires` in the future), so the link keeps
 * that shape and adds `ref`. Only the SHA-256 of the token is kept here.
 */
export async function mintQuestionnaireLink(input: {
  leadId: string;
  applicationId: string | null;
  now?: number;
}): Promise<{ ok: true; url: string; expiresAt: string } | { ok: false; error: string }> {
  const now = input.now ?? Date.now();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(now + QUESTIONNAIRE_LINK_DAYS * 86_400_000).toISOString();
  const { error } = await supabaseAdmin.from("lead_questionnaire_links").insert({
    lead_id: input.leadId,
    token_sha256: sha256(token),
    expires_at: expiresAt,
    created_at: new Date(now).toISOString(),
  });
  if (error) return { ok: false, error: error.message };

  const url = new URL(`${websiteUrl()}/questionnaire`);
  if (input.applicationId) url.searchParams.set("ref", input.applicationId);
  url.searchParams.set("token", token);
  url.searchParams.set("expires", expiresAt);
  return { ok: true, url: url.toString(), expiresAt };
}

export type QuestionnaireApplicant = {
  applicationId: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  organisationName: string;
  role: string;
  organisationType: string;
  annualVolume: string;
};

export type QuestionnaireAccess =
  | { ok: true; applicant: QuestionnaireApplicant; via: "link" | "reference" }
  | {
      ok: false;
      reason:
        | "invalid_reference"
        | "invalid_token"
        | "expired"
        | "already_completed"
        | "unavailable";
      applicationId?: string;
      completedAt?: string;
    };

/**
 * Whether the website may open the questionnaire for this applicant, and who
 * they are.
 *
 * Two ways in: the secure link from the Stage 1 email (reference + token), or
 * the reference with the work email the application gave, for a link that has
 * expired or was opened elsewhere. A wrong email and an unknown reference
 * answer the same way, so the reply says nothing about whether a reference
 * exists. What it returns is what the applicant typed at Stage 1 — enough to
 * address the questionnaire to them, nothing they did not give us.
 */
export async function verifyQuestionnaireAccess(input: {
  applicationId: unknown;
  token?: unknown;
  workEmail?: unknown;
  now?: number;
}): Promise<QuestionnaireAccess> {
  const now = input.now ?? Date.now();
  const reference = normaliseApplicationId(input.applicationId);
  if (!reference) return { ok: false, reason: "invalid_reference" };

  const { data: leads, error } = await supabaseAdmin
    .from("waitlist_leads")
    .select(
      "id, application_id, first_name, last_name, email, entity_name, role, entity_classification, transaction_volume, stage2_completed_at, created_at",
    )
    .eq("application_id", reference)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) {
    console.error("[lead-emails] questionnaire access read failed:", error.message);
    return { ok: false, reason: "unavailable" };
  }
  if (!leads?.length) return { ok: false, reason: "invalid_reference" };

  let lead = leads[0];
  let via: "link" | "reference";
  if (typeof input.token === "string" && input.token) {
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(input.token)) return { ok: false, reason: "invalid_token" };
    const { data: link, error: linkError } = await supabaseAdmin
      .from("lead_questionnaire_links")
      .select("id, lead_id, expires_at")
      .eq("token_sha256", sha256(input.token))
      .in(
        "lead_id",
        leads.map((row) => row.id),
      )
      .maybeSingle();
    if (linkError) {
      console.error("[lead-emails] questionnaire link read failed:", linkError.message);
      return { ok: false, reason: "unavailable" };
    }
    if (!link) return { ok: false, reason: "invalid_token", applicationId: reference };
    if (Date.parse(link.expires_at) <= now)
      return { ok: false, reason: "expired", applicationId: reference };
    lead = leads.find((row) => row.id === link.lead_id) ?? lead;
    via = "link";
    // A stamp that fails costs the console a "last opened" time, not the
    // applicant their questionnaire.
    const { error: stampError } = await supabaseAdmin
      .from("lead_questionnaire_links")
      .update({ last_used_at: new Date(now).toISOString() })
      .eq("id", link.id);
    if (stampError) console.error("[lead-emails] link stamp failed:", stampError.message);
  } else if (typeof input.workEmail === "string" && input.workEmail.trim()) {
    const given = emailKey(input.workEmail);
    const match = leads.find((row) => given && emailKey(row.email ?? "") === given);
    if (!match) return { ok: false, reason: "invalid_reference" };
    lead = match;
    via = "reference";
  } else {
    return { ok: false, reason: "invalid_reference" };
  }

  if (lead.stage2_completed_at) {
    return {
      ok: false,
      reason: "already_completed",
      applicationId: reference,
      completedAt: lead.stage2_completed_at,
    };
  }

  return {
    ok: true,
    via,
    applicant: {
      applicationId: reference,
      firstName: lead.first_name ?? "",
      lastName: lead.last_name ?? "",
      workEmail: lead.email ?? "",
      organisationName: lead.entity_name ?? "",
      role: lead.role ?? "",
      organisationType: lead.entity_classification ?? "",
      annualVolume: lead.transaction_volume ?? "",
    },
  };
}

// ── Composing ───────────────────────────────────────────────────────────────

/**
 * The applicant email for one lead at one stage, as it will be sent.
 *
 * Stage 1 mints the questionnaire link here, at send time, so a send that is
 * retried carries a link that was minted for it. A link that could not be
 * minted is a refusal to send: the email exists to carry it.
 */
export async function composeApplicantEmail(input: {
  lead: LeadRow;
  stage: LeadStage;
  template: LeadEmailTemplate;
  supportEmail: string;
}): Promise<{ ok: true; rendered: RenderedLeadEmail } | { ok: false; error: string }> {
  const { lead, stage } = input;
  let questionnaireUrl: string | null = null;
  let questionnaireExpiresAt: string | null = null;
  if (stage === 1) {
    const minted = await mintQuestionnaireLink({
      leadId: lead.id,
      applicationId: lead.application_id,
    });
    if (!minted.ok)
      return { ok: false, error: `the questionnaire link could not be minted: ${minted.error}` };
    questionnaireUrl = minted.url;
    questionnaireExpiresAt = minted.expiresAt;
  }
  const context = leadEmailContext(lead as LeadEmailSubject, stage, {
    siteUrl: websiteUrl(),
    bookingUrl: reviewBookingUrl(),
    questionnaireUrl,
    questionnaireExpiresAt,
    supportEmail: input.supportEmail,
    trialDays: await trialDaysFor(lead),
  });
  return { ok: true, rendered: renderLeadEmail(input.template, context) };
}

/** A preview: a real applicant's values when one is named, the samples otherwise. Mints nothing. */
export async function previewLeadEmail(input: {
  stage: LeadStage;
  template: LeadEmailTemplate;
  leadId?: string | null;
  supportEmail: string;
}): Promise<{ rendered: RenderedLeadEmail; recipient: string | null }> {
  if (input.leadId) {
    const { data: lead } = await supabaseAdmin
      .from("waitlist_leads")
      .select("*")
      .eq("id", input.leadId)
      .maybeSingle();
    if (lead) {
      const preview = new URL(`${websiteUrl()}/questionnaire`);
      if (lead.application_id) preview.searchParams.set("ref", lead.application_id);
      preview.searchParams.set("token", "preview-link-not-live");
      preview.searchParams.set(
        "expires",
        new Date(Date.now() + QUESTIONNAIRE_LINK_DAYS * 86_400_000).toISOString(),
      );
      const context = leadEmailContext(lead as LeadEmailSubject, input.stage, {
        siteUrl: websiteUrl(),
        bookingUrl: reviewBookingUrl(),
        questionnaireUrl: preview.toString(),
        questionnaireExpiresAt: preview.searchParams.get("expires"),
        supportEmail: input.supportEmail,
        trialDays: await trialDaysFor(lead),
      });
      return { rendered: renderLeadEmail(input.template, context), recipient: lead.email };
    }
  }
  const context = { ...sampleContext(input.stage), support_email: input.supportEmail };
  return { rendered: renderLeadEmail(input.template, context), recipient: null };
}

/** Recent applicants who reached a stage, for the preview's "show it for" picker. */
export async function previewCandidates(stage: LeadStage, limit = 12) {
  const column =
    stage === 1 ? "created_at" : stage === 2 ? "stage2_completed_at" : "stage3_booked_at";
  const { data, error } = await supabaseAdmin
    .from("waitlist_leads")
    .select("id, first_name, last_name, entity_name, application_id")
    .not(column, "is", null)
    .order(column, { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []).map((row) => ({
    id: row.id,
    label:
      [[row.first_name, row.last_name].filter(Boolean).join(" "), row.entity_name]
        .filter(Boolean)
        .join(" · ") ||
      row.application_id ||
      "Applicant",
  }));
}

/**
 * One test email, to one address, outside the funnel: no ledger row, no
 * link minted (the preview link opens nothing), the identity the stage sends
 * as. The subject says it is a test, so it is never mistaken for one sent to
 * an applicant.
 */
export async function sendLeadEmailTest(input: {
  stage: LeadStage;
  template: LeadEmailTemplate;
  to: string;
  leadId?: string | null;
  actorId: string;
}): Promise<{ ok: true; mailbox: string } | { ok: false; error: string }> {
  const to = input.to.trim();
  if (!MAILBOX.test(to)) return { ok: false, error: "That is not an email address." };
  const problems = templateProblems(input.stage, input.template);
  if (problems.length) return { ok: false, error: problems[0] };

  const settings = await settingsForSending();
  if (!settings) return { ok: false, error: "The sending identity could not be read; try again." };
  const identity = await sendingIdentity(
    settings,
    (process.env.LEAD_STAGE_EMAIL_MAILBOX ?? process.env.MICROSOFT_MAILBOX_EMAIL ?? "").trim() ||
      null,
  );
  if (!identity.ok) return { ok: false, error: identity.error };

  const { rendered } = await previewLeadEmail({
    stage: input.stage,
    template: input.template,
    leadId: input.leadId,
    supportEmail: identity.supportEmail,
  });
  const outcome = await sendMail(
    identity.mailbox,
    applicantMessage({ ...rendered, subject: `[Test] ${rendered.subject}` }, [to], identity),
    true,
    identity.config,
  );
  await writeAuditLog({
    actorUserId: input.actorId,
    action: "lead_emails.test_sent",
    entityType: "lead_email_templates",
    entityId: null,
    metadata: { stage: input.stage, to, outcome: outcome.kind },
  });
  if (outcome.kind === "sent") return { ok: true, mailbox: identity.mailbox };
  return {
    ok: false,
    error:
      outcome.kind === "throttled"
        ? "Microsoft Graph is throttling sends; try again in a minute."
        : `The test was not sent: ${outcome.message}`,
  };
}

/** The applicant emails Mission Control has raised, newest first, for the console. */
export async function recentApplicantSends(limit = 25) {
  const { data, error } = await supabaseAdmin
    .from("lead_stage_emails")
    .select(
      "id, lead_id, stage, status, reason, sent_at, created_at, to_address, last_error, subject",
    )
    .eq("audience", "applicant")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return { ok: false as const, error: error.message, rows: [] };
  return { ok: true as const, rows: data ?? [] };
}
