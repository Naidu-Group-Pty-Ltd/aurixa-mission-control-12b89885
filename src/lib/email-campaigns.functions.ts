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

const uuid = z.string().uuid();

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

    const [quotas, imports, messages, recipientStatuses] = await Promise.all([
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
    ]);
    if (quotas.error) throw quotas.error;
    if (imports.error) throw imports.error;
    if (messages.error) throw messages.error;
    if (recipientStatuses.error) throw recipientStatuses.error;

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
    if (data.fromMailbox !== undefined) patch.from_mailbox = data.fromMailbox || null;
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
    if (data.status === "running") {
      const readiness = await assessReadiness(context.supabase, data.id);
      if (readiness.blocking.length > 0) {
        throw new Error(`This campaign cannot start yet: ${readiness.blocking.join("; ")}`);
      }
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

    return { ok: true };
  });

// ── Readiness ───────────────────────────────────────────────────────────────

export type Readiness = {
  blocking: string[];
  warnings: string[];
  tokens: string[];
  personalising: string[];
  batchSize: number;
  pending: number;
};

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

  const { isGraphConfigured, defaultMailbox } = await import("@/server/graph-client");
  if (!isGraphConfigured()) {
    blocking.push("Microsoft Graph is not configured on this deployment");
  } else if (!campaign.from_mailbox && !defaultMailbox()) {
    blocking.push("no sending mailbox is configured");
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

  return { blocking, warnings, tokens, personalising, batchSize, pending };
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

    return {
      recipient: lead?.email ?? null,
      subject: renderTemplate(campaign.subject_template as string, fields, { html: false }),
      body: renderTemplate(campaign.body_template as string, fields, { html }),
      html,
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

    const { defaultMailbox, sendMail } = await import("@/server/graph-client");
    const mailbox = (campaign.from_mailbox as string | null)?.trim() || defaultMailbox();
    if (!mailbox) throw new Error("no sending mailbox is configured");

    const html = campaign.body_format !== "text";
    const preview: Record<string, string> = {
      email: address,
      campaign_name: campaign.name as string,
      sender_name: (campaign.from_name as string) ?? "",
      today: new Date().toISOString().slice(0, 10),
      unsubscribe_url: "https://example.invalid/unsubscribe?t=test",
    };
    const outcome = await sendMail(mailbox, {
      subject: `[TEST] ${renderTemplate(campaign.subject_template as string, preview, { html: false })}`,
      body: {
        contentType: html ? "HTML" : "Text",
        content: renderTemplate(campaign.body_template as string, preview, { html }),
      },
      toRecipients: [{ emailAddress: { address } }],
    });

    if (outcome.kind !== "sent") {
      throw new Error(
        outcome.kind === "throttled"
          ? "Microsoft is throttling this mailbox — try again shortly"
          : "message" in outcome
            ? outcome.message
            : "the test message could not be sent",
      );
    }
    return { ok: true, mailbox };
  });

/** Whether this deployment can send, and from where. */
export const mailboxStatus = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .handler(async () => {
    const { isGraphConfigured, defaultMailbox, probeMailbox, GraphError } =
      await import("@/server/graph-client");
    if (!isGraphConfigured()) {
      return { configured: false, mailbox: null, reachable: false, detail: null as string | null };
    }
    const mailbox = defaultMailbox();
    if (!mailbox) {
      return {
        configured: true,
        mailbox: null,
        reachable: false,
        detail: "MICROSOFT_MAILBOX_EMAIL is not set, so campaigns must name their own mailbox",
      };
    }
    try {
      const probe = await probeMailbox(mailbox);
      return { configured: true, mailbox, reachable: true, detail: probe.displayName };
    } catch (error) {
      return {
        configured: true,
        mailbox,
        reachable: false,
        detail: error instanceof GraphError ? error.message : "the mailbox could not be reached",
      };
    }
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
