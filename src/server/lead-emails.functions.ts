/**
 * Operator RPCs for Email → Lead emails (docs/LEAD_EMAILS.md).
 *
 * Reads are `requireOperator`. Every write — the copy, the sending identity,
 * who sends a stage, who hears about a lead, a test send — is `requireAdmin`:
 * these are the emails every applicant receives, the same weight as a
 * campaign, and the alerts the team acts on.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import {
  DEFAULT_LEAD_EMAIL_TEMPLATES,
  normaliseTemplate,
  templateProblems,
  templateWarnings,
  type LeadStage,
} from "@/lib/leadEmailTemplates.pure";
import { isGraphConfigured } from "@/server/graph-client";
import { readPolicy, withSendingMailbox, withTeamAlerts } from "@/server/leadStageEmailPolicy.pure";
import {
  previewCandidates,
  previewLeadEmail,
  readLeadEmailSettings,
  readLeadEmailTemplates,
  recentApplicantSends,
  resetLeadEmailTemplate,
  saveLeadEmailSettings,
  saveLeadEmailTemplate,
  sendLeadEmailTest,
  sendingIdentity,
  setLeadEmailSender,
  setLeadEmailTeamAlerts,
  TEAM_ALERT_RECIPIENT_LIMIT,
} from "./lead-emails.server";

const stage = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const SCHEMA_PENDING =
  "Lead emails are not in the database yet — the migration that adds them has not applied.";

const envMailbox = () =>
  (process.env.LEAD_STAGE_EMAIL_MAILBOX ?? process.env.MICROSOFT_MAILBOX_EMAIL ?? "").trim() ||
  null;

export const getLeadEmailsFn = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async () => {
    const [settings, templates, recent] = await Promise.all([
      readLeadEmailSettings(),
      readLeadEmailTemplates(),
      recentApplicantSends(),
    ]);
    const schemaPending =
      (!settings.ok && settings.schemaPending) || (!templates.ok && templates.schemaPending);
    const effective = settings.ok ? settings.settings : null;
    const identity = effective ? await sendingIdentity(effective, envMailbox()) : null;
    const policy = readPolicy(process.env as Record<string, string | undefined>);
    // Who the team alert actually reaches, resolved the way the dispatcher
    // resolves it (`loadPolicy`): the console's list, else the environment's,
    // else the mailbox the emails send from.
    const alerts = withSendingMailbox(
      withTeamAlerts(policy, effective?.teamAlerts),
      identity?.ok ? identity.mailbox : null,
    );

    return {
      schemaPending,
      error:
        !settings.ok && !settings.schemaPending
          ? settings.error
          : !templates.ok && !templates.schemaPending
            ? templates.error
            : null,
      settings: effective,
      templates: templates.ok
        ? templates.records.map((record) => ({
            ...record,
            problems: templateProblems(record.stage, record.template),
            warnings: templateWarnings(record.stage, record.template),
          }))
        : [],
      defaults: DEFAULT_LEAD_EMAIL_TEMPLATES,
      identity: identity
        ? identity.ok
          ? { ok: true as const, mailbox: identity.mailbox, supportEmail: identity.supportEmail }
          : { ok: false as const, error: identity.error }
        : null,
      graphConfigured: isGraphConfigured(),
      envMailbox: envMailbox(),
      // The deployment-wide switches that still apply on top of the console.
      applicantMode: policy.applicantMode,
      applicantStages: [...policy.applicantStages].sort(),
      teamAlerts: {
        recipients: alerts.internalRecipients,
        source: alerts.internalRecipientSource,
        stages: [...alerts.internalStages].sort(),
        dropped: alerts.internalRecipientsDropped,
        // The environment's answer, shown while the console has not set one.
        env: {
          recipients:
            policy.internalRecipientSource === "configured" ? policy.internalRecipients : [],
          stages: [...policy.internalStages].sort(),
        },
        limit: TEAM_ALERT_RECIPIENT_LIMIT,
      },
      recent: recent.rows,
    };
  });

export const previewLeadEmailFn = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ stage, template: z.unknown(), leadId: z.string().uuid().nullish() }).parse(input),
  )
  .handler(async ({ data }) => {
    const template = normaliseTemplate(data.stage as LeadStage, data.template);
    const settings = await readLeadEmailSettings();
    const identity = settings.ok ? await sendingIdentity(settings.settings, envMailbox()) : null;
    const supportEmail = identity?.ok ? identity.supportEmail : "admin@aurixasystems.com.au";
    const preview = await previewLeadEmail({
      stage: data.stage as LeadStage,
      template,
      leadId: data.leadId ?? null,
      supportEmail,
    });
    return { ...preview, problems: templateProblems(data.stage as LeadStage, template) };
  });

export const listPreviewLeadsFn = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ stage }).parse(input))
  .handler(async ({ data }) => ({ leads: await previewCandidates(data.stage as LeadStage) }));

export const saveLeadEmailTemplateFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ stage, template: z.unknown() }).parse(input))
  .handler(async ({ data, context }) => {
    const result = await saveLeadEmailTemplate({
      stage: data.stage as LeadStage,
      template: data.template,
      actorId: context.userId,
    });
    if (!result.ok && result.error === "schema_pending")
      return { ok: false as const, error: SCHEMA_PENDING };
    return result;
  });

export const resetLeadEmailTemplateFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => z.object({ stage }).parse(input))
  .handler(async ({ data, context }) => {
    const result = await resetLeadEmailTemplate({
      stage: data.stage as LeadStage,
      actorId: context.userId,
    });
    if (!result.ok && result.error === "schema_pending")
      return { ok: false as const, error: SCHEMA_PENDING };
    return result;
  });

export const saveLeadEmailSettingsFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        tenantId: z.string().uuid().nullable(),
        fromMailbox: z.string().max(254).nullable(),
        fromName: z.string().max(120).nullable(),
        replyTo: z.string().max(254).nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const result = await saveLeadEmailSettings({ ...data, actorId: context.userId });
    if (!result.ok && result.error === "schema_pending")
      return { ok: false as const, error: SCHEMA_PENDING };
    return result;
  });

export const setLeadEmailSenderFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({ stage, sender: z.enum(["make", "mission_control"]), makeOff: z.boolean() })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    // Handing a stage over is the act that can double an applicant's email,
    // so it needs the operator's word that Make has stopped sending it.
    if (data.sender === "mission_control" && !data.makeOff) {
      return {
        ok: false as const,
        error: "Remove the email modules from Make first, then confirm it here.",
      };
    }
    const result = await setLeadEmailSender({
      stage: data.stage as LeadStage,
      sender: data.sender,
      actorId: context.userId,
    });
    if (!result.ok && result.error === "schema_pending")
      return { ok: false as const, error: SCHEMA_PENDING };
    return result;
  });

export const setLeadEmailTeamAlertsFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        // Bounds the request; the real limit, and every address's spelling,
        // are `setLeadEmailTeamAlerts`'s to judge and name.
        recipients: z.array(z.string().max(254)).max(TEAM_ALERT_RECIPIENT_LIMIT * 2),
        stages: z.array(stage).max(3),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const result = await setLeadEmailTeamAlerts({
      recipients: data.recipients,
      stages: data.stages as LeadStage[],
      actorId: context.userId,
    });
    if (!result.ok && result.error === "schema_pending")
      return { ok: false as const, error: SCHEMA_PENDING };
    return result;
  });

export const sendLeadEmailTestFn = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z
      .object({
        stage,
        template: z.unknown(),
        to: z.string().max(254),
        leadId: z.string().uuid().nullish(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) =>
    sendLeadEmailTest({
      stage: data.stage as LeadStage,
      template: normaliseTemplate(data.stage as LeadStage, data.template),
      to: data.to,
      leadId: data.leadId ?? null,
      actorId: context.userId,
    }),
  );
