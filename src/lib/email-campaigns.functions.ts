/**
 * The operator's API for the email scheduler.
 *
 * Every function here is gated by `requireOperator` and runs against the
 * CALLER'S Supabase client, so the RLS policies written beside the tables are
 * the real authorisation rather than a formality. Two exceptions are explicit
 * and both are marked where they occur: importing a list goes through a
 * `SECURITY DEFINER` function (which asserts operator itself), and the two
 * calls that talk to Microsoft Graph use the service role because they read
 * deployment configuration a browser session cannot see.
 *
 * The parse happens in the BROWSER and the rows arrive here in chunks. That is
 * the shape that makes the upload limit a property of Supabase Storage rather
 * than of the Worker in front of it: the file itself never passes through a
 * server function, so the request-body ceiling never applies to it, and a
 * 200 MB workbook is a storage question instead of a 413.
 *
 * Attachments travel the same way: the browser puts the file in the
 * `email-attachments` bucket, and `registerCampaignAttachment` reads it back
 * with the service role (a third marked exception) to measure and hash it
 * itself. A hash the browser computed would be a claim; the dispatcher checks
 * every file against this one before it claims a single contact.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { requireAdmin, requireOperator } from "@/integrations/supabase/role-middleware";
import { emailKey } from "@/lib/email/emailAddress.pure";
import {
  findTokens,
  missingFields,
  personalisingFields,
  renderTemplate,
  requiresOneRecipient,
} from "@/lib/email/mergeTemplate.pure";
import {
  admissionProblem,
  attachmentReadiness,
  contentIdFor,
  contentTypeFor,
  isImageType,
  isInline,
  previewInlineImages,
  sha256Hex,
  type DeliveryPath,
} from "@/lib/email/attachments.pure";
import { mayChoose, sameMailbox, type MailboxAccess } from "@/lib/email/mailboxes.pure";
import { sameTenant } from "@/lib/email/microsoftTenants.pure";
import {
  HEALTH_WINDOW_DAYS,
  campaignWarmupAdvice,
  daysBefore,
  healthScore,
  localDate,
  rampDay,
  totalsBetween,
  type WarmupDay,
} from "@/lib/email/warmupPlan.pure";
import {
  campaignRulesFromRow,
  describeSchedule,
  formatInZone,
  nextWindowOpening,
} from "@/lib/email/campaignRules.pure";

const uuid = z.string().uuid();

/** The bucket a campaign's attachments live in. Mirrors the migration. */
export const ATTACHMENT_BUCKET = "email-attachments";

/**
 * A campaign's files may change only while nothing is sending them. A file
 * swapped mid-run splits one campaign into two messages with no record of who
 * got which, and a file removed while a tick holds it in memory goes out
 * anyway.
 */
export const ATTACHMENT_EDITABLE_STATUSES = ["draft", "paused"] as const;

export const CAMPAIGN_STATUSES = ["draft", "running", "paused", "completed", "cancelled"] as const;

export const RECIPIENT_STATUSES = [
  "pending",
  "claimed",
  "sent",
  "failed",
  "unconfirmed",
  "suppressed",
  "cancelled",
] as const;

/** Rows accepted in one ingest call. Keeps every request small and resumable. */
export const INGEST_CHUNK_SIZE = 500;

const contactSchema = z.object({
  email: z.string().min(3).max(320),
  email_key: z.string().min(3).max(320),
  row_number: z.number().int().min(0).max(50_000_000),
  attributes: z.record(z.string()).default({}),
  attributes_norm: z.record(z.string()).default({}),
});

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "expected HH:MM");

const rulesSchema = z.object({
  timezone: z.string().min(1).max(64).optional(),
  sendDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  windowStart: clock.optional(),
  windowEnd: clock.optional(),
  maxMessagesPerDay: z.number().int().min(1).max(100_000).nullable().optional(),
  maxRecipientsPerDay: z.number().int().min(1).max(1_000_000).nullable().optional(),
  recipientsPerMessage: z.number().int().min(1).max(500).optional(),
  minGapSeconds: z.number().int().min(0).max(86_400).optional(),
  maxMessagesPerRun: z.number().int().min(1).max(200).optional(),
  startsAt: z.string().datetime({ offset: true }).nullable().optional(),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
});

// ── Campaigns ───────────────────────────────────────────────────────────────

export const listCampaigns = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        status: z.enum(["all", ...CAMPAIGN_STATUSES]).default("all"),
        limit: z.number().int().min(1).max(200).default(100),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("email_campaigns")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (data.status !== "all") query = query.eq("status", data.status);
    const { data: rows, error } = await query;
    if (error) throw error;

    // Through the aggregate view: one row per (campaign, status), so a page of
    // forty campaigns costs about two hundred rows rather than every recipient
    // of every one of them. The view reads with the caller's own rights.
    const ids = (rows ?? []).map((row) => row.id as string);
    const tallies = new Map<string, Record<string, number>>();
    if (ids.length > 0) {
      const { data: counts, error: countError } = await context.supabase
        .from("email_campaign_recipient_counts")
        .select("campaign_id, status, recipients")
        .in("campaign_id", ids);
      if (countError) throw countError;
      for (const row of counts ?? []) {
        const id = row.campaign_id as string | null;
        const status = row.status as string | null;
        if (!id || !status) continue;
        const bucket = tallies.get(id) ?? {};
        bucket[status] = (bucket[status] ?? 0) + Number(row.recipients ?? 0);
        tallies.set(id, bucket);
      }
    }

    return (rows ?? []).map((row) => ({
      ...row,
      counts: tallies.get(row.id as string) ?? {},
    }));
  });

export const getCampaign = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: campaign, error } = await context.supabase
      .from("email_campaigns")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!campaign) throw new Error("campaign_not_found");

    const [quotas, imports, messages, recipientStatuses, attachments] = await Promise.all([
      context.supabase
        .from("email_campaign_quotas")
        .select("*")
        .eq("campaign_id", data.id)
        .order("created_at", { ascending: true }),
      context.supabase
        .from("email_campaign_imports")
        .select("*")
        .eq("campaign_id", data.id)
        .order("created_at", { ascending: false })
        .limit(25),
      context.supabase
        .from("email_campaign_messages")
        .select("*")
        .eq("campaign_id", data.id)
        .order("queued_at", { ascending: false })
        .limit(25),
      context.supabase
        .from("email_campaign_recipient_counts")
        .select("status, recipients")
        .eq("campaign_id", data.id),
      context.supabase
        .from("email_campaign_attachments")
        .select("id, file_name, content_type, size_bytes, content_id, position, created_at")
        .eq("campaign_id", data.id)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
    ]);
    if (quotas.error) throw quotas.error;
    if (imports.error) throw imports.error;
    if (messages.error) throw messages.error;
    if (recipientStatuses.error) throw recipientStatuses.error;
    if (attachments.error) throw attachments.error;

    const counts: Record<string, number> = {};
    for (const row of recipientStatuses.data ?? []) {
      const status = row.status as string | null;
      if (!status) continue;
      counts[status] = (counts[status] ?? 0) + Number(row.recipients ?? 0);
    }

    return {
      campaign,
      quotas: quotas.data ?? [],
      imports: imports.data ?? [],
      messages: messages.data ?? [],
      attachments: attachments.data ?? [],
      counts,
    };
  });

export const createCampaign = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        name: z.string().min(1).max(200),
        description: z.string().max(2000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("email_campaigns")
      .insert({
        name: data.name,
        description: data.description ?? null,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id: row.id as string };
  });

export const updateCampaign = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).nullable().optional(),
        /** The Microsoft tenant it sends through; null is the deployment's own. */
        tenantId: uuid.nullable().optional(),
        fromMailbox: z.string().max(320).nullable().optional(),
        fromName: z.string().max(120).nullable().optional(),
        replyTo: z.string().max(320).nullable().optional(),
        subjectTemplate: z.string().max(500).optional(),
        bodyTemplate: z.string().max(200_000).optional(),
        bodyFormat: z.enum(["html", "text"]).optional(),
        rules: rulesSchema.optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    for (const address of [data.fromMailbox, data.replyTo]) {
      if (address && !emailKey(address)) throw new Error("that is not a valid email address");
    }

    const patch: Database["public"]["Tables"]["email_campaigns"]["Update"] = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined) patch.description = data.description;

    // The tenant and the sending mailbox are read together: a mailbox is only
    // a mailbox OF a tenant, so changing either is checked against the pair.
    let tenantChange: { from: string | null; to: string | null } | null = null;
    let mailboxChange: { from: string | null; to: string | null } | null = null;
    if (data.fromMailbox !== undefined || data.tenantId !== undefined) {
      const { data: current, error: currentError } = await context.supabase
        .from("email_campaigns")
        .select("from_mailbox, tenant_id, status")
        .eq("id", data.id)
        .maybeSingle();
      if (currentError) throw currentError;
      if (!current) throw new Error("campaign_not_found");
      const currentTenant = (current.tenant_id as string | null) ?? null;
      const currentMailbox = (current.from_mailbox as string | null) ?? null;

      let tenant = currentTenant;
      if (data.tenantId !== undefined && !sameTenant(currentTenant, data.tenantId)) {
        // A message in flight was claimed under one tenant's credentials; the
        // switch waits until nothing is sending.
        if (current.status === "running") {
          throw new Error(
            "pause the campaign before changing the Microsoft tenant it sends through",
          );
        }
        const { tenantProblem } = await import("@/server/microsoft-tenants.server");
        const problem = await tenantProblem(data.tenantId);
        if (problem && data.tenantId) throw new Error(problem);
        tenant = data.tenantId ?? null;
        tenantChange = { from: currentTenant, to: tenant };
        patch.tenant_id = tenant;
      }

      // The sending mailbox is checked against the tenant when either CHANGES,
      // and the check is fresh rather than cached: this is the moment an
      // operator commits to it, and a mailbox an access policy excludes is
      // refused here rather than discovered by the first contact's message.
      const next =
        data.fromMailbox !== undefined
          ? data.fromMailbox?.trim()
            ? emailKey(data.fromMailbox)
            : null
          : currentMailbox;
      if (tenantChange || !sameMailbox(currentMailbox, next)) {
        if (next) {
          const { graphConfigFor } = await import("@/server/microsoft-tenants.server");
          // Unconfigured, nothing can be checked and nothing can send either;
          // readiness blocks the start, and checks again once it is set.
          if (await graphConfigFor(tenant)) {
            const { checkMailbox } = await import("@/server/email-mailboxes.server");
            const access = await checkMailbox(next, { tenantId: tenant, force: true });
            if (!mayChoose(access)) {
              throw new Error(
                access.state === "unknown"
                  ? `${next} could not be checked just now: ${access.reason}`
                  : tenantChange
                    ? `${next} cannot be used with that tenant: ${access.reason} — choose one of its mailboxes, or leave the mailbox on the tenant's default`
                    : `${next} cannot be used: ${access.reason}`,
              );
            }
          }
        }
        if (!sameMailbox(currentMailbox, next)) mailboxChange = { from: currentMailbox, to: next };
      }
      if (data.fromMailbox !== undefined) patch.from_mailbox = next;
    }
    if (data.fromName !== undefined) patch.from_name = data.fromName || null;
    if (data.replyTo !== undefined) patch.reply_to = data.replyTo || null;
    if (data.subjectTemplate !== undefined) patch.subject_template = data.subjectTemplate;
    if (data.bodyTemplate !== undefined) patch.body_template = data.bodyTemplate;
    if (data.bodyFormat !== undefined) patch.body_format = data.bodyFormat;

    const rules = data.rules;
    if (rules) {
      if (rules.timezone !== undefined) patch.timezone = rules.timezone;
      if (rules.sendDays !== undefined) patch.send_days = [...new Set(rules.sendDays)].sort();
      if (rules.windowStart !== undefined) patch.window_start = rules.windowStart;
      if (rules.windowEnd !== undefined) patch.window_end = rules.windowEnd;
      if (rules.maxMessagesPerDay !== undefined)
        patch.max_messages_per_day = rules.maxMessagesPerDay;
      if (rules.maxRecipientsPerDay !== undefined)
        patch.max_recipients_per_day = rules.maxRecipientsPerDay;
      if (rules.recipientsPerMessage !== undefined)
        patch.recipients_per_message = rules.recipientsPerMessage;
      if (rules.minGapSeconds !== undefined) patch.min_gap_seconds = rules.minGapSeconds;
      if (rules.maxMessagesPerRun !== undefined)
        patch.max_messages_per_run = rules.maxMessagesPerRun;
      if (rules.startsAt !== undefined) patch.starts_at = rules.startsAt;
      if (rules.endsAt !== undefined) patch.ends_at = rules.endsAt;
    }

    if (Object.keys(patch).length === 0) return { ok: true };

    const { error } = await context.supabase
      .from("email_campaigns")
      .update(patch)
      .eq("id", data.id);
    if (error) throw error;

    if (tenantChange || mailboxChange) {
      // Which tenant and mailbox a campaign speaks as is an identity decision,
      // and an application permission can reach mailboxes nobody meant to share.
      const { writeAuditLog } = await import("@/server/audit.server");
      if (tenantChange) {
        await writeAuditLog({
          action: "email_campaign_tenant_changed",
          entityType: "email_campaign",
          entityId: data.id,
          actorUserId: context.userId,
          metadata: tenantChange,
        });
      }
      if (mailboxChange) {
        await writeAuditLog({
          action: "email_campaign_mailbox_changed",
          entityType: "email_campaign",
          entityId: data.id,
          actorUserId: context.userId,
          metadata: mailboxChange,
        });
      }
    }
    return { ok: true };
  });

/**
 * Move a campaign between states.
 *
 * Starting is the one transition that is checked rather than taken on trust:
 * it is the click that puts mail on the wire, and every reason it should not
 * happen — an empty subject, a merge field the list cannot supply, no
 * recipients, no mailbox — is cheaper to say here than to discover in an inbox.
 */
export const setCampaignStatus = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid,
        status: z.enum(["running", "paused", "cancelled", "draft"]),
        reason: z.string().max(500).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let firstSendAt: string | null = null;
    if (data.status === "running") {
      const readiness = await assessReadiness(context.supabase, data.id);
      if (readiness.blocking.length > 0) {
        throw new Error(`This campaign cannot start yet: ${readiness.blocking.join("; ")}`);
      }
      firstSendAt = readiness.schedule.nextOpening;
    }

    const patch: Database["public"]["Tables"]["email_campaigns"]["Update"] = {
      status: data.status,
    };
    if (data.status === "running") {
      patch.paused_reason = null;
      patch.started_at = new Date().toISOString();
      patch.completed_at = null;
    }
    if (data.status === "paused") patch.paused_reason = data.reason ?? "paused by an operator";
    if (data.status === "cancelled") {
      patch.paused_reason = data.reason ?? "cancelled by an operator";
      patch.completed_at = new Date().toISOString();
    }

    const { error } = await context.supabase
      .from("email_campaigns")
      .update(patch)
      .eq("id", data.id);
    if (error) throw error;

    // Cancelling stops the queue as well as the campaign — a recipient left
    // `pending` on a cancelled campaign reads as work waiting, for ever.
    if (data.status === "cancelled") {
      const { error: stopError } = await context.supabase
        .from("email_campaign_recipients")
        .update({ status: "cancelled" })
        .eq("campaign_id", data.id)
        .eq("status", "pending");
      if (stopError) throw stopError;
    }

    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: `email_campaign_${data.status}`,
      entityType: "email_campaign",
      entityId: data.id,
      actorUserId: context.userId,
      metadata: { reason: data.reason ?? null },
    });

    // Starting outside the window is allowed and common; the page says when
    // the first message will go rather than leaving "running" to explain it.
    return { ok: true, firstSendAt };
  });

// ── Readiness ───────────────────────────────────────────────────────────────

export type Readiness = {
  blocking: string[];
  warnings: string[];
  tokens: string[];
  personalising: string[];
  batchSize: number;
  pending: number;
  /** The tenant it sends through; `id` null is the deployment's own. */
  tenant: { id: string | null; label: string; configured: boolean };
  /** The mailbox the next message would leave from, and whether it can. */
  mailbox: { address: string | null; isDefault: boolean; access: MailboxAccess | null };
  attachments: { count: number; totalBytes: number; path: DeliveryPath };
  /** The campaign's calendar, and when it next lets a message go. */
  schedule: { description: string; openNow: boolean; nextOpening: string | null };
};

/** What the warmup pool says about a campaign's sending mailbox, or null. Advisory: a read that fails says nothing. */
async function warmupAdviceFor(
  supabase: SupabaseClient<Database>,
  address: string | null,
): Promise<string | null> {
  if (!address) return null;
  const { data: warming, error } = await supabase
    .from("email_warmup_mailboxes")
    .select("id, status, active_days, last_active_on, timezone")
    .eq("mailbox", address)
    .neq("status", "removed")
    .maybeSingle();
  if (error) {
    console.error("[email] could not read the warmup pool for readiness:", error.message);
    return null;
  }
  if (!warming) return null;
  const today = localDate(new Date(), warming.timezone || "Australia/Sydney");
  const from = daysBefore(today, HEALTH_WINDOW_DAYS - 1);
  const { data: days, error: daysError } = await supabase
    .from("email_warmup_daily")
    .select("*")
    .eq("mailbox_id", warming.id)
    .gte("day", from);
  if (daysError) {
    console.error("[email] could not read warmup figures for readiness:", daysError.message);
    return null;
  }
  return campaignWarmupAdvice({
    address,
    status: warming.status,
    rampDay: rampDay({
      activeDays: warming.active_days,
      lastActiveOn: warming.last_active_on,
      today,
    }),
    health: healthScore(totalsBetween((days ?? []) as Partial<WarmupDay>[], from, today)),
  });
}

/** The column profile an import carried, whatever shape the jsonb holds. */
export function importedColumns(value: unknown): { key?: string; isDimension?: boolean }[] {
  return Array.isArray(value) ? (value as { key?: string; isDimension?: boolean }[]) : [];
}

async function assessReadiness(
  supabase: SupabaseClient<Database>,
  campaignId: string,
): Promise<Readiness> {
  const { data: campaign, error } = await supabase
    .from("email_campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!campaign) throw new Error("campaign_not_found");

  const blocking: string[] = [];
  const warnings: string[] = [];

  const pendingResult = await supabase
    .from("email_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "pending");
  if (pendingResult.error) throw pendingResult.error;
  const pending = pendingResult.count ?? 0;

  if (!String(campaign.subject_template ?? "").trim()) blocking.push("the subject line is empty");
  if (!String(campaign.body_template ?? "").trim()) blocking.push("the message body is empty");
  if (pending === 0) blocking.push("no contacts are waiting — attach a list first");

  // Through the campaign's own tenant: the deployment's (null), or one added
  // under Microsoft tenants.
  const tenantId = (campaign.tenant_id as string | null) ?? null;
  const { graphConfigFor, tenantName, tenantProblem } =
    await import("@/server/microsoft-tenants.server");
  const config = await graphConfigFor(tenantId);
  const effectiveMailbox =
    (campaign.from_mailbox as string | null)?.trim() || config?.mailbox || null;
  let mailboxAccess: MailboxAccess | null = null;
  let canBuildDrafts: boolean | null = null;
  if (!config) {
    blocking.push((await tenantProblem(tenantId)) ?? "Microsoft Graph is not configured");
  } else if (!effectiveMailbox) {
    blocking.push(
      tenantId
        ? `no sending mailbox is chosen and "${tenantName(config)}" has no default mailbox — pick one on the Message tab`
        : "no sending mailbox is chosen — pick one on the Message tab",
    );
  } else {
    const { checkMailbox, graphCapabilities } = await import("@/server/email-mailboxes.server");
    const [access, capabilities] = await Promise.all([
      checkMailbox(effectiveMailbox, { tenantId }),
      graphCapabilities({ tenantId }),
    ]);
    mailboxAccess = access;
    canBuildDrafts = capabilities.readWrite;
    if (access.state === "denied" || access.state === "no_mailbox") {
      blocking.push(`${effectiveMailbox} cannot be used: ${access.reason}`);
    } else if (access.state === "unknown") {
      warnings.push(
        `${effectiveMailbox} could not be checked just now (${access.reason}) — if it cannot be used, the first message will be refused and the campaign will pause`,
      );
    } else if (access.state === "unverifiable") {
      warnings.push(`${effectiveMailbox} cannot be checked: ${access.reason}`);
    }
    // From the token's roles, which Exchange's RBAC for Applications does not
    // populate — so these warn and never block. The probe above is the
    // authority on the mailbox itself.
    if (capabilities.send === false) {
      warnings.push(
        "this application's token does not carry the Mail.Send permission — unless Exchange grants it another way, every message will be refused",
      );
    }
    if (capabilities.read === false && access.state !== "unverifiable") {
      warnings.push(
        "this application's token does not carry Mail.Read — the bounce scan may not be able to read the mailbox, and a bounce it cannot read never reaches the do-not-send register",
      );
    }
  }

  // A sending mailbox that is still young in its warmup, or whose warmup mail
  // lands in spam, is a warning about where this campaign's mail will land.
  if (effectiveMailbox) {
    const advice = await warmupAdviceFor(supabase, emailKey(effectiveMailbox));
    if (advice) warnings.push(advice);
  }

  // Which fields the attached lists can actually supply — read from each
  // import's own snapshot, so deleting the uploaded list afterwards does not
  // make a working campaign report its own template as unsupported.
  const { data: imports, error: importError } = await supabase
    .from("email_campaign_imports")
    .select("columns")
    .eq("campaign_id", campaignId);
  if (importError) throw importError;
  const available = new Set<string>();
  for (const row of imports ?? []) {
    for (const column of importedColumns(row.columns)) if (column?.key) available.add(column.key);
  }

  const tokens = findTokens(campaign.subject_template ?? "", campaign.body_template ?? "");
  const missing = missingFields(tokens, [...available]);
  if (missing.length > 0) {
    blocking.push(
      `the message uses ${missing.map((f) => `{{${f}}}`).join(", ")}, which no attached list supplies`,
    );
  }

  const personalising = personalisingFields(
    campaign.subject_template ?? "",
    campaign.body_template ?? "",
  );
  const oneAtATime = requiresOneRecipient(
    campaign.subject_template ?? "",
    campaign.body_template ?? "",
  );
  const batchSize = oneAtATime ? 1 : Math.max(1, Number(campaign.recipients_per_message) || 1);
  if (oneAtATime && Number(campaign.recipients_per_message) > 1) {
    warnings.push(
      `the message names ${personalising.map((f) => `{{${f}}}`).join(", ")}, so it goes to one contact at a time whatever the batch size says`,
    );
  }

  if (!tokens.includes("unsubscribe_url")) {
    // Not blocking: an internal notice to a handful of colleagues is a
    // legitimate use and the operator can see what they are sending. Said
    // plainly, because a commercial message in Australia needs a working
    // unsubscribe facility and this is the moment to notice.
    warnings.push(
      "there is no {{unsubscribe_url}} in the message — a commercial electronic message must carry a working unsubscribe facility",
    );
  }

  if (!campaign.reply_to) {
    warnings.push("no reply-to address is set, so replies go to the sending mailbox");
  }

  // The calendar. A campaign started outside its window is working exactly as
  // written and sends nothing until the window opens — which, said nowhere,
  // reads as a broken scheduler. So it is said here, before Start, with the
  // time the first message will actually go.
  const rules = campaignRulesFromRow(campaign);
  const now = new Date();
  const opening = nextWindowOpening(rules, now);
  const openNow = opening != null && opening.getTime() <= now.getTime();
  const description = describeSchedule(rules);
  if (!opening) {
    blocking.push(
      `its calendar never opens again (${description}${campaign.ends_at ? `, ending ${formatInZone(new Date(campaign.ends_at as string), rules.timezone)}` : ""}) — change the sending days or the end date on the Rules tab`,
    );
  } else if (!openNow && campaign.status !== "running") {
    warnings.push(
      `the sending window is closed right now (${description}) — once started, the first message goes out ${formatInZone(opening, rules.timezone)}`,
    );
  }

  const { data: attachmentRows, error: attachmentError } = await supabase
    .from("email_campaign_attachments")
    .select("file_name, size_bytes, content_id, content_type")
    .eq("campaign_id", campaignId);
  if (attachmentError) throw attachmentError;
  const attached = attachmentReadiness({
    attachments: (attachmentRows ?? []).map((row) => ({
      contentId: row.content_id,
      fileName: row.file_name,
      sizeBytes: Number(row.size_bytes),
      contentType: row.content_type,
    })),
    body: String(campaign.body_template ?? ""),
    bodyFormat: String(campaign.body_format ?? "html"),
    minGapSeconds: Number(campaign.min_gap_seconds) || 0,
    maxMessagesPerRun: Number(campaign.max_messages_per_run) || 1,
    canBuildDrafts,
  });
  blocking.push(...attached.blocking);
  warnings.push(...attached.warnings);

  return {
    blocking,
    warnings,
    tokens,
    personalising,
    batchSize,
    pending,
    tenant: { id: tenantId, label: tenantName(config), configured: config !== null },
    mailbox: {
      address: effectiveMailbox ? emailKey(effectiveMailbox) : null,
      isDefault: !(campaign.from_mailbox as string | null)?.trim(),
      access: mailboxAccess,
    },
    attachments: {
      count: (attachmentRows ?? []).length,
      totalBytes: attached.totalBytes,
      path: attached.path,
    },
    schedule: {
      description,
      openNow,
      nextOpening: opening ? opening.toISOString() : null,
    },
  };
}

export const campaignReadiness = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => assessReadiness(context.supabase, data.id));

/** The message as the next contact in the queue will receive it. */
export const previewCampaign = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: campaign, error } = await context.supabase
      .from("email_campaigns")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!campaign) throw new Error("campaign_not_found");

    const { data: recipients, error: recipientError } = await context.supabase
      .from("email_campaign_recipients")
      .select("email, attributes, unsubscribe_token")
      .eq("campaign_id", data.id)
      .eq("status", "pending")
      .order("position", { ascending: true })
      .limit(1);
    if (recipientError) throw recipientError;

    const lead = recipients?.[0] as
      | { email: string; attributes: Record<string, string>; unsubscribe_token: string }
      | undefined;
    const html = campaign.body_format !== "text";
    const fields: Record<string, string> = {
      ...(lead?.attributes ?? {}),
      email: lead?.email ?? "someone@example.com",
      campaign_name: campaign.name as string,
      sender_name: (campaign.from_name as string) ?? "",
      today: new Date().toISOString().slice(0, 10),
      unsubscribe_url: "https://example.invalid/unsubscribe?t=preview",
    };

    const { data: attachmentRows, error: attachmentError } = await context.supabase
      .from("email_campaign_attachments")
      .select("id, file_name, content_type, size_bytes, content_id, storage_path")
      .eq("campaign_id", data.id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (attachmentError) throw attachmentError;

    const bodyTemplate = String(campaign.body_template ?? "");
    const bodyFormat = String(campaign.body_format ?? "html");
    const attachments = (attachmentRows ?? []).map((row) => ({
      id: row.id,
      fileName: row.file_name,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
      contentId: row.content_id,
      inline: isInline(row.content_id, bodyTemplate, bodyFormat),
      storagePath: row.storage_path,
    }));

    let body = renderTemplate(bodyTemplate, fields, { html });
    if (html) {
      // A mail client resolves `cid:` against the attachment; a browser cannot.
      // The preview swaps each inline image for a short-lived link so the
      // operator sees what the reader will — the message itself keeps `cid:`.
      const urls = new Map<string, string>();
      for (const attachment of attachments) {
        if (!attachment.inline || !isImageType(attachment.contentType)) continue;
        const { data: signed, error: signError } = await context.supabase.storage
          .from(ATTACHMENT_BUCKET)
          .createSignedUrl(attachment.storagePath, 600);
        if (signError) {
          console.error("[email] could not sign an inline preview image:", signError.message);
          continue;
        }
        if (signed?.signedUrl) urls.set(attachment.contentId, signed.signedUrl);
      }
      body = previewInlineImages(body, urls);
    }

    return {
      recipient: lead?.email ?? null,
      subject: renderTemplate(campaign.subject_template as string, fields, { html: false }),
      body,
      html,
      attachments: attachments.map(({ storagePath: _path, ...rest }) => rest),
    };
  });

/**
 * Send one message to an address the operator names.
 *
 * Deliberately outside the ledger: nothing is claimed, nothing is marked sent,
 * and the campaign's caps are untouched. A test send is a look at the
 * rendering, not a delivery to a customer — recording it as one would consume
 * a recipient the campaign still owes a message to.
 */
export const sendTestEmail = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid, to: z.string().min(3).max(320) }).parse(input))
  .handler(async ({ data, context }) => {
    const address = emailKey(data.to);
    if (!address) throw new Error("that is not a valid email address");

    const { data: campaign, error } = await context.supabase
      .from("email_campaigns")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!campaign) throw new Error("campaign_not_found");

    const { deliverMessage } = await import("@/server/graph-client");
    const { requireGraphConfigFor } = await import("@/server/microsoft-tenants.server");
    const config = await requireGraphConfigFor((campaign.tenant_id as string | null) ?? null);
    const mailbox = (campaign.from_mailbox as string | null)?.trim() || config.mailbox;
    if (!mailbox) throw new Error("no sending mailbox is chosen");

    // The same files, read and verified the same way the dispatcher reads
    // them, so a test that arrives proves the campaign's message can be built.
    const { prepareCampaignAttachments } = await import("@/server/email-attachments.server");
    let attachments;
    try {
      attachments = await prepareCampaignAttachments({
        id: campaign.id as string,
        body_template: String(campaign.body_template ?? ""),
        body_format: String(campaign.body_format ?? "html"),
      });
    } catch (error) {
      throw new Error(
        `the attachments could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const html = campaign.body_format !== "text";
    const preview: Record<string, string> = {
      email: address,
      campaign_name: campaign.name as string,
      sender_name: (campaign.from_name as string) ?? "",
      today: new Date().toISOString().slice(0, 10),
      unsubscribe_url: "https://example.invalid/unsubscribe?t=test",
    };
    const outcome = await deliverMessage(
      mailbox,
      {
        subject: `[TEST] ${renderTemplate(campaign.subject_template as string, preview, { html: false })}`,
        body: {
          contentType: html ? "HTML" : "Text",
          content: renderTemplate(campaign.body_template as string, preview, { html }),
        },
        toRecipients: [{ emailAddress: { address } }],
        ...(campaign.reply_to
          ? { replyTo: [{ emailAddress: { address: campaign.reply_to as string } }] }
          : {}),
        ...(campaign.from_name
          ? { from: { emailAddress: { address: mailbox, name: campaign.from_name as string } } }
          : {}),
      },
      attachments.outbound,
      config,
    );

    if (outcome.kind !== "sent") {
      throw new Error(
        outcome.kind === "throttled"
          ? "Microsoft is throttling this mailbox — try again shortly"
          : "message" in outcome
            ? outcome.message
            : "the test message could not be sent",
      );
    }
    return {
      ok: true,
      mailbox,
      attachments: attachments.snapshot.length,
      attachmentBytes: attachments.totalBytes,
      path: outcome.path,
    };
  });

/**
 * Whether a tenant can send, its default mailbox, and what its application
 * was granted. Without a tenant, the deployment's own.
 *
 * The default is checked by reading its inbox folder — the same test every
 * mailbox in the picker gets — rather than by reading its directory entry,
 * which needs a directory permission sending does not and failed with
 * "insufficient privileges" on a deployment that could send perfectly well.
 */
export const mailboxStatus = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ tenantId: uuid.nullable().default(null) }).parse(input ?? {}),
  )
  .handler(async ({ data }) => {
    const { tenantId } = data;
    const { graphConfigFor } = await import("@/server/microsoft-tenants.server");
    const config = await graphConfigFor(tenantId);
    if (!config) {
      return {
        configured: false,
        mailbox: null as string | null,
        reachable: false,
        detail: null as string | null,
        capabilities: null,
      };
    }
    const { checkMailbox, displayNameFor, graphCapabilities } =
      await import("@/server/email-mailboxes.server");
    const capabilities = await graphCapabilities({ tenantId });
    const mailbox = config.mailbox;
    if (!mailbox) {
      return {
        configured: true,
        mailbox: null as string | null,
        reachable: false,
        detail: tenantId
          ? "this tenant has no default mailbox — that is fine: each campaign chooses its mailbox from the tenant"
          : "MICROSOFT_MAILBOX_EMAIL is not set — that is fine: each campaign chooses its mailbox from the tenant",
        capabilities,
      };
    }
    const access = await checkMailbox(mailbox, { tenantId });
    const reachable = access.state === "reachable";
    return {
      configured: true,
      mailbox,
      reachable,
      detail: reachable ? await displayNameFor(mailbox, tenantId) : access.reason,
      capabilities,
    };
  });

/**
 * Every mailbox in a tenant a campaign might send from, each marked with
 * whether that tenant's application can use it. `refresh` re-reads the
 * directory and re-checks access instead of answering from the five-minute
 * cache. Without a tenant, the deployment's own.
 */
export const listMailboxes = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({ refresh: z.boolean().default(false), tenantId: uuid.nullable().default(null) })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { mailboxDirectory } = await import("@/server/email-mailboxes.server");
    return mailboxDirectory(context.supabase, { tenantId: data.tenantId, force: data.refresh });
  });

/** Check one address the operator typed, against a tenant, now. */
export const verifyMailbox = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({ address: z.string().min(3).max(320), tenantId: uuid.nullable().default(null) })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const address = emailKey(data.address);
    if (!address) throw new Error("that is not a valid email address");
    const { checkMailbox, displayNameFor } = await import("@/server/email-mailboxes.server");
    const access = await checkMailbox(address, { tenantId: data.tenantId, force: true });
    return {
      address,
      access,
      displayName:
        access.state === "reachable" ? await displayNameFor(address, data.tenantId) : null,
    };
  });

// ── Attachments ─────────────────────────────────────────────────────────────

async function editableCampaign(
  supabase: SupabaseClient<Database>,
  campaignId: string,
): Promise<{ id: string; status: string }> {
  const { data: campaign, error } = await supabase
    .from("email_campaigns")
    .select("id, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!campaign) throw new Error("campaign_not_found");
  if (!(ATTACHMENT_EDITABLE_STATUSES as readonly string[]).includes(campaign.status)) {
    throw new Error(
      campaign.status === "running"
        ? "attachments cannot change while the campaign is sending — pause it first"
        : `attachments cannot change on a ${campaign.status} campaign`,
    );
  }
  return campaign;
}

/**
 * Record a file the browser has just put in the attachments bucket.
 *
 * The bytes are read back here, with the service role, and it is THEIR size
 * and THEIR hash that are recorded — never figures the browser sent. A file
 * refused for any reason is removed from the bucket on the way out, so a
 * refusal leaves nothing behind that a later registration could pick up.
 */
export const registerCampaignAttachment = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        campaignId: uuid,
        attachmentId: uuid,
        storagePath: z.string().min(1).max(600),
        fileName: z.string().min(1).max(255),
        contentType: z.string().max(200).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const prefix = `${data.campaignId}/${data.attachmentId}/`;
    const rest = data.storagePath.slice(prefix.length);
    if (
      !data.storagePath.startsWith(prefix) ||
      !rest ||
      rest.includes("/") ||
      rest.includes("..")
    ) {
      throw new Error("storage_path_outside_campaign");
    }

    // A refusal below deletes the object at this path with the service role.
    // That is only safe for a FRESH upload: an id an attachment row or a sent
    // message already knows names a file somebody received, and registering
    // it again must never become a way to delete that record — so it is
    // refused here, before anything is removed.
    const [{ count: rows, error: rowError }, { count: carried, error: carriedError }] =
      await Promise.all([
        context.supabase
          .from("email_campaign_attachments")
          .select("id", { count: "exact", head: true })
          // The id alone is enough: every row is created here, with its path
          // under `<campaign>/<its own id>/`, so a known id covers its path.
          .eq("id", data.attachmentId),
        context.supabase
          .from("email_campaign_messages")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", data.campaignId)
          .filter("attachments", "cs", JSON.stringify([{ id: data.attachmentId }])),
      ]);
    if (rowError) throw rowError;
    if (carriedError) throw carriedError;
    if ((rows ?? 0) > 0 || (carried ?? 0) > 0) throw new Error("attachment_already_registered");

    const { downloadStoredObject, removeStoredObject } =
      await import("@/server/email-attachments.server");
    const refuse = async (message: string): Promise<never> => {
      await removeStoredObject(data.storagePath);
      throw new Error(message);
    };

    try {
      await editableCampaign(context.supabase, data.campaignId);
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error));
    }

    const { data: existing, error: existingError } = await context.supabase
      .from("email_campaign_attachments")
      .select("id, file_name, size_bytes, content_id, position, sha256")
      .eq("campaign_id", data.campaignId);
    if (existingError) throw existingError;
    const others = existing ?? [];

    let bytes: Uint8Array;
    try {
      bytes = await downloadStoredObject(data.storagePath);
    } catch (error) {
      return refuse(`the uploaded file ${error instanceof Error ? error.message : String(error)}`);
    }

    const problem = admissionProblem(
      { fileName: data.fileName, sizeBytes: bytes.length },
      others.map((row) => ({ sizeBytes: Number(row.size_bytes) })),
    );
    if (problem) return refuse(problem);

    const sha256 = await sha256Hex(bytes);
    const twin = others.find((row) => row.sha256 === sha256);
    if (twin) return refuse(`that file is already attached, as ${twin.file_name}`);

    const row = {
      id: data.attachmentId,
      campaign_id: data.campaignId,
      file_name: data.fileName.trim(),
      content_type: contentTypeFor(data.fileName, data.contentType),
      size_bytes: bytes.length,
      storage_path: data.storagePath,
      sha256,
      content_id: contentIdFor(
        data.fileName,
        others.map((other) => other.content_id),
      ),
      position: others.reduce((max, other) => Math.max(max, Number(other.position) + 1), 0),
      created_by: context.userId,
    };
    const { data: inserted, error: insertError } = await context.supabase
      .from("email_campaign_attachments")
      .insert(row)
      .select("id, file_name, content_type, size_bytes, content_id, position, created_at")
      .single();
    if (insertError) return refuse(insertError.message);

    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "email_campaign_attachment_added",
      entityType: "email_campaign",
      entityId: data.campaignId,
      actorUserId: context.userId,
      metadata: {
        attachment_id: row.id,
        file_name: row.file_name,
        size_bytes: row.size_bytes,
        sha256,
      },
    });
    return inserted;
  });

/**
 * Take a file off a campaign.
 *
 * The ROW always goes. The stored FILE goes only when no message carried it:
 * once a file has been sent, it is the record of what those people received,
 * and every message that carried it still names its storage path.
 */
export const removeCampaignAttachment = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("email_campaign_attachments")
      .select("id, campaign_id, file_name, storage_path")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("attachment_not_found");
    await editableCampaign(context.supabase, row.campaign_id);

    const { count, error: carriedError } = await context.supabase
      .from("email_campaign_messages")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", row.campaign_id)
      .filter("attachments", "cs", JSON.stringify([{ id: row.id }]));
    if (carriedError) throw carriedError;
    const carried = (count ?? 0) > 0;

    const { error: deleteError } = await context.supabase
      .from("email_campaign_attachments")
      .delete()
      .eq("id", row.id);
    if (deleteError) throw deleteError;

    const { forgetAttachment, removeStoredObject } =
      await import("@/server/email-attachments.server");
    forgetAttachment(row.id);
    if (!carried) await removeStoredObject(row.storage_path);

    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "email_campaign_attachment_removed",
      entityType: "email_campaign",
      entityId: row.campaign_id,
      actorUserId: context.userId,
      metadata: { attachment_id: row.id, file_name: row.file_name, file_kept: carried },
    });
    return { ok: true, fileKept: carried };
  });

/**
 * A short-lived link to an attachment's file — a campaign's current one, or,
 * with `messageId`, one a sent message carried even if it has since been
 * removed from the campaign.
 */
export const attachmentDownloadUrl = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ attachmentId: uuid, messageId: uuid.optional() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    let path: string | null = null;
    let fileName: string | null = null;
    if (data.messageId) {
      const { data: message, error } = await context.supabase
        .from("email_campaign_messages")
        .select("attachments")
        .eq("id", data.messageId)
        .maybeSingle();
      if (error) throw error;
      const carried = Array.isArray(message?.attachments)
        ? (message.attachments as { id?: string; storage_path?: string; file_name?: string }[])
        : [];
      const entry = carried.find((item) => item?.id === data.attachmentId);
      path = entry?.storage_path ?? null;
      fileName = entry?.file_name ?? null;
    } else {
      const { data: row, error } = await context.supabase
        .from("email_campaign_attachments")
        .select("storage_path, file_name")
        .eq("id", data.attachmentId)
        .maybeSingle();
      if (error) throw error;
      path = row?.storage_path ?? null;
      fileName = row?.file_name ?? null;
    }
    if (!path) throw new Error("attachment_not_found");

    const { data: signed, error: signError } = await context.supabase.storage
      .from(ATTACHMENT_BUCKET)
      .createSignedUrl(path, 120, { download: fileName ?? true });
    if (signError || !signed?.signedUrl) {
      throw new Error(`the file could not be opened: ${signError?.message ?? "no link"}`);
    }
    return { url: signed.signedUrl };
  });

// ── Lists ───────────────────────────────────────────────────────────────────

export const listLists = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ limit: z.number().int().min(1).max(200).default(100) }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("email_lists")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (error) throw error;
    return rows ?? [];
  });

export const createList = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        name: z.string().min(1).max(200),
        fileName: z.string().max(400).nullable().optional(),
        filePath: z.string().max(600).nullable().optional(),
        mimeType: z.string().max(200).nullable().optional(),
        sizeBytes: z.number().int().min(0).nullable().optional(),
        checksum: z.string().max(128).nullable().optional(),
        sourceFormat: z.string().max(32).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("email_lists")
      .insert({
        name: data.name,
        file_name: data.fileName ?? null,
        file_path: data.filePath ?? null,
        mime_type: data.mimeType ?? null,
        size_bytes: data.sizeBytes ?? null,
        checksum: data.checksum ?? null,
        source_format: data.sourceFormat ?? null,
        status: "parsing",
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw error;
    return { id: row.id as string };
  });

/**
 * One chunk of parsed contacts.
 *
 * `ignoreDuplicates` rather than a merge: a list may legitimately spell the
 * same address twice, the first occurrence is the one whose row number and
 * attributes are kept, and the count of what was dropped is reported by
 * `finaliseList` rather than being silently absorbed.
 */
export const ingestListChunk = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        listId: uuid,
        contacts: z.array(contactSchema).min(1).max(INGEST_CHUNK_SIZE),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("email_list_contacts").upsert(
      data.contacts.map((contact) => ({
        list_id: data.listId,
        email: contact.email,
        email_key: contact.email_key,
        row_number: contact.row_number,
        attributes: contact.attributes,
        attributes_norm: contact.attributes_norm,
      })),
      { onConflict: "list_id,email_key", ignoreDuplicates: true },
    );
    if (error) throw error;
    return { accepted: data.contacts.length };
  });

export const finaliseList = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        listId: uuid,
        status: z.enum(["ready", "failed"]),
        rowCount: z.number().int().min(0).default(0),
        contactCount: z.number().int().min(0).default(0),
        invalidCount: z.number().int().min(0).default(0),
        duplicateCount: z.number().int().min(0).default(0),
        emailColumn: z.string().max(120).nullable().optional(),
        columns: z.array(z.record(z.unknown())).max(512).default([]),
        parseError: z.string().max(2000).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_lists")
      .update({
        status: data.status,
        row_count: data.rowCount,
        contact_count: data.contactCount,
        invalid_count: data.invalidCount,
        duplicate_count: data.duplicateCount,
        email_column: data.emailColumn ?? null,
        columns: data.columns as unknown as Json,
        parse_error: data.parseError ?? null,
      })
      .eq("id", data.listId);
    if (error) throw error;
    return { ok: true };
  });

export const deleteList = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    // The contacts cascade; recipients already imported into a campaign do
    // not, because they are that campaign's own record of who it has mailed.
    const { error } = await context.supabase.from("email_lists").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

/**
 * Copy a list into a campaign.
 *
 * Through the database function, in one statement: the suppression check, the
 * dedupe and the count of what each of them cost happen together or not at
 * all. Doing it here, row by row, is how half a list gets imported.
 */
export const attachListToCampaign = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ campaignId: uuid, listId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase.rpc("email_import_list_into_campaign", {
      p_campaign: data.campaignId,
      p_list: data.listId,
    });
    if (error) throw error;
    const result = (Array.isArray(rows) ? rows[0] : rows) as
      | { imported: number; skipped_duplicate: number; skipped_suppressed: number }
      | undefined;
    return {
      imported: result?.imported ?? 0,
      skippedDuplicate: result?.skipped_duplicate ?? 0,
      skippedSuppressed: result?.skipped_suppressed ?? 0,
    };
  });

// ── Recipients ──────────────────────────────────────────────────────────────

export const listRecipients = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        campaignId: uuid,
        status: z.enum(["all", ...RECIPIENT_STATUSES]).default("all"),
        search: z.string().max(200).default(""),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("email_campaign_recipients")
      .select("id, email, status, position, sent_at, last_error, suppressed_reason, attributes")
      .eq("campaign_id", data.campaignId)
      .order("position", { ascending: true })
      .limit(data.limit);
    if (data.status !== "all") query = query.eq("status", data.status);
    if (data.search.trim()) query = query.ilike("email", `%${data.search.trim()}%`);
    const { data: rows, error } = await query;
    if (error) throw error;
    return rows ?? [];
  });

export const cancelRecipient = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_campaign_recipients")
      .update({ status: "cancelled" })
      .eq("id", data.id)
      .in("status", ["pending", "suppressed"]);
    if (error) throw error;
    return { ok: true };
  });

/**
 * Put an unconfirmed recipient back in the queue.
 *
 * The only path that does this, and it is a person's decision on purpose. An
 * unconfirmed send is one where the answer never arrived: the message may have
 * gone. Releasing it accepts the risk of a second copy in exchange for the
 * certainty of a first, and no automatic process is entitled to make that
 * trade.
 */
export const releaseUnconfirmed = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_campaign_recipients")
      .update({ status: "pending", claimed_at: null, message_id: null })
      .eq("id", data.id)
      .in("status", ["unconfirmed", "failed"]);
    if (error) throw error;

    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "email_recipient_released",
      entityType: "email_campaign_recipient",
      entityId: data.id,
      actorUserId: context.userId,
      metadata: {},
    });
    return { ok: true };
  });

// ── Quotas ──────────────────────────────────────────────────────────────────

export const upsertQuota = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        id: uuid.optional(),
        campaignId: uuid,
        dimension: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[a-z][a-z0-9_]*$/, "not a column key this parser produces"),
        dimensionLabel: z.string().min(1).max(200),
        matchValues: z.array(z.string().max(1024)).min(1).max(200),
        valueLabel: z.string().min(1).max(200),
        maxPerDay: z.number().int().min(1).max(1_000_000).nullable().optional(),
        maxTotal: z.number().int().min(1).max(10_000_000).nullable().optional(),
        enabled: z.boolean().default(true),
      })
      .refine((value) => value.maxPerDay != null || value.maxTotal != null, {
        message: "a quota needs a daily limit, a total limit, or both",
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const payload = {
      campaign_id: data.campaignId,
      dimension: data.dimension,
      dimension_label: data.dimensionLabel,
      match_values: data.matchValues,
      value_label: data.valueLabel,
      max_per_day: data.maxPerDay ?? null,
      max_total: data.maxTotal ?? null,
      enabled: data.enabled,
    };
    if (data.id) {
      const { error } = await context.supabase
        .from("email_campaign_quotas")
        .update(payload)
        .eq("id", data.id);
      if (error) throw error;
      return { id: data.id };
    }
    const { data: row, error } = await context.supabase
      .from("email_campaign_quotas")
      .insert(payload)
      .select("id")
      .single();
    if (error) throw error;
    return { id: row.id as string };
  });

export const deleteQuota = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ id: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_campaign_quotas")
      .delete()
      .eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });

/** How much of each quota this campaign has already spent, today and in total. */
export const quotaUsage = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ campaignId: uuid }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: campaign, error: campaignError } = await context.supabase
      .from("email_campaigns")
      .select("timezone")
      .eq("id", data.campaignId)
      .maybeSingle();
    if (campaignError) throw campaignError;

    const { data: quotas, error } = await context.supabase
      .from("email_campaign_quotas")
      .select("*")
      .eq("campaign_id", data.campaignId);
    if (error) throw error;

    const { startOfZonedDay } = await import("@/lib/email/campaignRules.pure");
    const { jsonPathColumn, pgInList } = await import("@/lib/email/quotaFilter.pure");
    const dayStart = startOfZonedDay(
      new Date(),
      (campaign?.timezone as string) || "Australia/Sydney",
    ).toISOString();

    const out: Record<string, { today: number; total: number }> = {};
    for (const quota of quotas ?? []) {
      const column = jsonPathColumn("attributes_norm", quota.dimension as string);
      const list = pgInList((quota.match_values as string[]) ?? []);
      const total = await context.supabase
        .from("email_campaign_recipients")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", data.campaignId)
        .eq("status", "sent")
        .filter(column, "in", list);
      if (total.error) throw total.error;
      const today = await context.supabase
        .from("email_campaign_recipients")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", data.campaignId)
        .eq("status", "sent")
        .gte("sent_at", dayStart)
        .filter(column, "in", list);
      if (today.error) throw today.error;
      out[quota.id as string] = { today: today.count ?? 0, total: total.count ?? 0 };
    }
    return out;
  });

// ── The do-not-send register ────────────────────────────────────────────────

export const listSuppressions = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        search: z.string().max(200).default(""),
        reason: z
          .enum(["all", "bounced", "complaint", "unsubscribed", "invalid", "manual"])
          .default("all"),
        limit: z.number().int().min(1).max(500).default(200),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    let query = context.supabase
      .from("email_suppressions")
      .select("*")
      .order("last_seen_at", { ascending: false })
      .limit(data.limit);
    if (data.reason !== "all") query = query.eq("reason", data.reason);
    if (data.search.trim())
      query = query.ilike("email_key", `%${data.search.trim().toLowerCase()}%`);
    const { data: rows, error } = await query;
    if (error) throw error;
    return rows ?? [];
  });

export const addSuppression = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z
      .object({
        email: z.string().min(3).max(320),
        reason: z.enum(["bounced", "complaint", "unsubscribed", "invalid", "manual"]),
        detail: z.string().max(500).nullable().optional(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    const key = emailKey(data.email);
    if (!key) throw new Error("that is not a valid email address");

    const { error } = await context.supabase.from("email_suppressions").upsert(
      {
        email_key: key,
        email: data.email.trim(),
        reason: data.reason,
        detail: data.detail ?? null,
        source: "operator",
        created_by: context.userId,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "email_key" },
    );
    if (error) throw error;

    // Adding to the register stops every campaign that has not yet mailed this
    // address, not just the next one.
    const { error: stopError } = await context.supabase
      .from("email_campaign_recipients")
      .update({ status: "suppressed", suppressed_reason: `${data.reason} — added by an operator` })
      .eq("email_key", key)
      .eq("status", "pending");
    if (stopError) throw stopError;
    return { ok: true };
  });

/**
 * Take an address off the register.
 *
 * Admin only, and audited. Every other act here stops mail; this one is the
 * single act in the feature that can put mail back on the wire to an address
 * a receiving server has already rejected.
 */
export const removeSuppression = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) =>
    z.object({ emailKey: z.string().min(3).max(320), reason: z.string().max(500) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("email_suppressions")
      .delete()
      .eq("email_key", data.emailKey.toLowerCase());
    if (error) throw error;

    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "email_suppression_removed",
      entityType: "email_suppression",
      entityId: data.emailKey.toLowerCase(),
      actorUserId: context.userId,
      metadata: { reason: data.reason },
    });
    return { ok: true };
  });

export const listBounceScans = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) =>
    z.object({ limit: z.number().int().min(1).max(100).default(20) }).parse(input ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { data: rows, error } = await context.supabase
      .from("email_bounce_scans")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(data.limit);
    if (error) throw error;
    return rows ?? [];
  });
