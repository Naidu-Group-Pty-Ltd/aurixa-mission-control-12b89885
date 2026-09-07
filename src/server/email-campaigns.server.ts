/**
 * The dispatcher: what one tick of the email scheduler does.
 *
 * It is deliberately shaped like `dispatchDueOutboundJobs` in `voice.server.ts`
 * — read what is due, claim it optimistically, re-check the blocking register
 * AT THE WIRE, act, record — because that shape has already survived
 * production here and the failure modes are understood.
 *
 * Four decisions carry this file.
 *
 * **The token is taken before anything is claimed.** A credential failure that
 * happens after a claim leaves rows marked `claimed` with nothing to release
 * them, and a queue that looks like it is working. Taken first, a credential
 * failure costs one tick and touches no recipient.
 *
 * **The suppression register is re-read between the claim and the send.** A
 * bounce can arrive at any moment, including after a recipient was imported
 * and before it was sent. The import filters, the database trigger refuses,
 * and this reads it again — three checks, because the cost of the rule failing
 * is mail sent to an address we have already been told is dead.
 *
 * **An unknown outcome is recorded as unknown.** `sendMail` answers 202 with
 * no body; a network failure after the request left says nothing about whether
 * a message exists. That recipient becomes `unconfirmed` and no automatic path
 * ever sends to it again — releasing it would be the duplicate this feature
 * exists to prevent, and the only thing that can weigh "probably not delivered"
 * against "possibly delivered twice" is a person.
 *
 * **Quotas are counted from the ledger and claimed within the tick.** Counting
 * from the ledger means the number cannot drift from what was sent; claiming
 * within the tick means a single tick planning forty messages against an
 * allowance of twenty does not read "twenty already sent" forty times over.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  claimQuota,
  planTick,
  quotaBlocking,
  startOfZonedDay,
  type CampaignRules,
  type QuotaRule,
} from "@/lib/email/campaignRules.pure";
import { bodyPreview, renderTemplate, requiresOneRecipient } from "@/lib/email/mergeTemplate.pure";
import { jsonPathColumn, pgInList } from "@/lib/email/quotaFilter.pure";
import { resolveMissionControlOrigin } from "@/server/missionControlLink.pure";
import {
  defaultMailbox,
  isGraphConfigured,
  accessToken,
  sendMail,
  GraphError,
  type GraphMessage,
  type GraphRecipient,
} from "@/server/graph-client";

/** Wall clock one invocation may spend. Well inside a Worker's allowance. */
const DEFAULT_BUDGET_MS = 20_000;
/** Candidates read per message, so quota-blocked contacts can be stepped over. */
const CANDIDATE_MULTIPLIER = 4;
const MAX_CANDIDATES = 2000;

export type DispatchSummary = {
  campaigns: number;
  messages: number;
  recipients: number;
  failed: number;
  unconfirmed: number;
  completed: number;
  skipped: string[];
};

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  from_mailbox: string | null;
  from_name: string | null;
  reply_to: string | null;
  subject_template: string;
  body_template: string;
  body_format: string;
  timezone: string;
  send_days: number[] | null;
  window_start: string;
  window_end: string;
  max_messages_per_day: number | null;
  max_recipients_per_day: number | null;
  recipients_per_message: number;
  min_gap_seconds: number;
  max_messages_per_run: number;
  starts_at: string | null;
  ends_at: string | null;
  last_message_at: string | null;
};

type RecipientRow = {
  id: string;
  email: string;
  email_key: string;
  attempts: number;
  attributes: Record<string, string> | null;
  attributes_norm: Record<string, string> | null;
  unsubscribe_token: string;
};

/** A campaign row → the ruleset the pure planner reads. */
export function rulesFor(campaign: CampaignRow): CampaignRules {
  return {
    timezone: campaign.timezone || "Australia/Sydney",
    sendDays: campaign.send_days?.length ? campaign.send_days : [1, 2, 3, 4, 5, 6, 7],
    windowStart: campaign.window_start,
    windowEnd: campaign.window_end,
    maxMessagesPerDay: campaign.max_messages_per_day,
    maxRecipientsPerDay: campaign.max_recipients_per_day,
    recipientsPerMessage: campaign.recipients_per_message,
    minGapSeconds: campaign.min_gap_seconds,
    maxMessagesPerRun: campaign.max_messages_per_run,
    startsAt: campaign.starts_at,
    endsAt: campaign.ends_at,
  };
}

async function countRecipients(
  campaignId: string,
  build: (query: ReturnType<typeof pendingQuery>) => ReturnType<typeof pendingQuery>,
): Promise<number> {
  const { count, error } = await build(pendingQuery(campaignId));
  if (error) throw error;
  return count ?? 0;
}

function pendingQuery(campaignId: string) {
  return supabaseAdmin
    .from("email_campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
}

async function loadQuotaUsage(
  campaignId: string,
  rules: QuotaRule[],
  dayStart: Date,
): Promise<Map<string, { today: number; total: number }>> {
  const usage = new Map<string, { today: number; total: number }>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const column = jsonPathColumn("attributes_norm", rule.dimension);
    const list = pgInList(rule.matchValues);

    const total = await supabaseAdmin
      .from("email_campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "sent")
      .filter(column, "in", list);
    if (total.error) throw total.error;

    const today = await supabaseAdmin
      .from("email_campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("status", "sent")
      .gte("sent_at", dayStart.toISOString())
      .filter(column, "in", list);
    if (today.error) throw today.error;

    usage.set(rule.id, { today: today.count ?? 0, total: total.count ?? 0 });
  }
  return usage;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One pass over every running campaign.
 *
 * Called by `/hooks/email-campaign-dispatch` on a one-minute schedule.
 */
export async function dispatchDueCampaigns(
  options: { budgetMs?: number; now?: Date } = {},
): Promise<DispatchSummary> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const summary: DispatchSummary = {
    campaigns: 0,
    messages: 0,
    recipients: 0,
    failed: 0,
    unconfirmed: 0,
    completed: 0,
    skipped: [],
  };

  if (!isGraphConfigured()) {
    summary.skipped.push("Microsoft Graph is not configured on this deployment");
    return summary;
  }

  // Before anything is claimed. A credential failure now costs a tick; the
  // same failure after a claim costs a queue that never moves.
  try {
    await accessToken();
  } catch (error) {
    summary.skipped.push(
      error instanceof GraphError ? error.message : "could not obtain a Microsoft Graph token",
    );
    return summary;
  }

  const { data: campaigns, error: campaignError } = await supabaseAdmin
    .from("email_campaigns")
    .select("*")
    .eq("status", "running")
    .order("last_message_at", { ascending: true, nullsFirst: true })
    .limit(25);
  if (campaignError) throw campaignError;

  for (const campaign of (campaigns ?? []) as unknown as CampaignRow[]) {
    if (Date.now() - startedAt > budgetMs) {
      summary.skipped.push(`${campaign.name}: out of time this tick`);
      break;
    }
    try {
      const outcome = await runCampaignTick(campaign, {
        now: options.now ?? new Date(),
        deadline: startedAt + budgetMs,
      });
      summary.campaigns += 1;
      summary.messages += outcome.messages;
      summary.recipients += outcome.recipients;
      summary.failed += outcome.failed;
      summary.unconfirmed += outcome.unconfirmed;
      if (outcome.completed) summary.completed += 1;
      if (outcome.note) summary.skipped.push(`${campaign.name}: ${outcome.note}`);
    } catch (error) {
      // One campaign's fault must not stop the others: they share nothing but
      // this loop.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[email] campaign ${campaign.id} failed this tick:`, message);
      summary.skipped.push(`${campaign.name}: ${message}`);
    }
  }

  return summary;
}

type TickOutcome = {
  messages: number;
  recipients: number;
  failed: number;
  unconfirmed: number;
  completed: boolean;
  note: string | null;
};

async function runCampaignTick(
  campaign: CampaignRow,
  context: { now: Date; deadline: number },
): Promise<TickOutcome> {
  const outcome: TickOutcome = {
    messages: 0,
    recipients: 0,
    failed: 0,
    unconfirmed: 0,
    completed: false,
    note: null,
  };

  const rules = rulesFor(campaign);
  const dayStart = startOfZonedDay(context.now, rules.timezone);

  const pendingCount = await countRecipients(campaign.id, (q) => q.eq("status", "pending"));
  if (pendingCount === 0) {
    const inFlight = await countRecipients(campaign.id, (q) => q.eq("status", "claimed"));
    if (inFlight === 0) {
      const { error } = await supabaseAdmin
        .from("email_campaigns")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", campaign.id)
        .eq("status", "running");
      if (error)
        console.error(`[email] could not complete campaign ${campaign.id}:`, error.message);
      else outcome.completed = true;
    }
    outcome.note = "nothing left to send";
    return outcome;
  }

  const messagesTodayResult = await supabaseAdmin
    .from("email_campaign_messages")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .eq("status", "sent")
    .gte("sent_at", dayStart.toISOString());
  if (messagesTodayResult.error) throw messagesTodayResult.error;

  const recipientsToday = await countRecipients(campaign.id, (q) =>
    q.eq("status", "sent").gte("sent_at", dayStart.toISOString()),
  );

  const plan = planTick({
    rules,
    now: context.now,
    lastMessageAt: campaign.last_message_at,
    messagesToday: messagesTodayResult.count ?? 0,
    recipientsToday,
    pendingCount,
  });
  if (!plan.canSend) {
    outcome.note = plan.blockedBy;
    return outcome;
  }

  const { data: quotaRows, error: quotaError } = await supabaseAdmin
    .from("email_campaign_quotas")
    .select("*")
    .eq("campaign_id", campaign.id)
    .eq("enabled", true);
  if (quotaError) throw quotaError;

  const quotas: QuotaRule[] = (quotaRows ?? []).map((row) => ({
    id: row.id as string,
    dimension: row.dimension as string,
    dimensionLabel: row.dimension_label as string,
    matchValues: (row.match_values as string[]) ?? [],
    valueLabel: row.value_label as string,
    maxPerDay: row.max_per_day as number | null,
    maxTotal: row.max_total as number | null,
    enabled: row.enabled as boolean,
  }));
  const usage = await loadQuotaUsage(campaign.id, quotas, dayStart);
  const taken = new Map<string, number>();

  const perMessage = messageBatchSize(campaign);
  const mailbox = campaign.from_mailbox?.trim() || defaultMailbox();
  if (!mailbox) {
    outcome.note = "no sending mailbox is configured";
    return outcome;
  }

  const origin = resolveMissionControlOrigin({ PUBLIC_APP_URL: process.env.PUBLIC_APP_URL });
  let recipientsLeft = plan.recipientAllowance;
  let delayMs = plan.initialDelayMs;
  // Contacts a quota has stepped over this tick, so the next page does not
  // hand back the same ones for ever.
  const stepOver = new Set<string>();

  for (let message = 0; message < plan.messageAllowance; message++) {
    if (recipientsLeft <= 0) break;
    if (Date.now() + delayMs > context.deadline) {
      outcome.note = outcome.note ?? "ran out of time before the next message";
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
    delayMs = rules.minGapSeconds * 1000;

    const wanted = Math.min(perMessage, recipientsLeft);
    const chosen = await chooseRecipients(campaign.id, wanted, quotas, usage, taken, stepOver);
    if (chosen.length === 0) {
      // A quota holding every waiting contact, or another pass having claimed
      // them between the read and the claim. Both mean there is nothing to do
      // this tick and neither is a fault.
      outcome.note =
        outcome.note ?? "no contact could be claimed — held by a quota, or taken by another pass";
      break;
    }

    const sent = await sendOneMessage({ campaign, mailbox, origin, recipients: chosen });

    outcome.messages += 1;
    if (sent.kind === "sent") {
      outcome.recipients += chosen.length;
      recipientsLeft -= chosen.length;
      for (const recipient of chosen) claimQuota(quotas, taken, recipient.attributes_norm ?? {});
    } else if (sent.kind === "failed") {
      outcome.failed += chosen.length;
    } else if (sent.kind === "unconfirmed") {
      outcome.unconfirmed += chosen.length;
    } else {
      // Throttled: the claim was released, nothing was sent, and pressing on
      // this tick would only earn another 429.
      outcome.messages -= 1;
      outcome.note = "Microsoft is throttling this mailbox";
      break;
    }
  }

  return outcome;
}

/**
 * How many contacts share one message.
 *
 * A template that names anything per-recipient — a column, the address, the
 * unsubscribe link — cannot be batched, because there is one subject and one
 * body per message and no way to give forty people forty different ones. The
 * page says so while the campaign is being written; this is the enforcement,
 * so a template edited after the fact cannot quietly send `Hi ,` to a hundred
 * people in one BCC line.
 */
export function messageBatchSize(campaign: {
  subject_template: string;
  body_template: string;
  recipients_per_message: number;
}): number {
  if (requiresOneRecipient(campaign.subject_template, campaign.body_template)) return 1;
  return Math.max(1, campaign.recipients_per_message);
}

/**
 * Pending contacts that no quota is holding, re-checked against the
 * suppression register immediately before they are claimed.
 */
async function chooseRecipients(
  campaignId: string,
  wanted: number,
  quotas: QuotaRule[],
  usage: Map<string, { today: number; total: number }>,
  taken: Map<string, number>,
  stepOver: Set<string>,
): Promise<RecipientRow[]> {
  const limit = Math.min(MAX_CANDIDATES, Math.max(wanted * CANDIDATE_MULTIPLIER, wanted + 20));
  const { data, error } = await supabaseAdmin
    .from("email_campaign_recipients")
    .select("id, email, email_key, attempts, attributes, attributes_norm, unsubscribe_token")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .order("position", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const candidates: RecipientRow[] = [];
  for (const row of (data ?? []) as unknown as RecipientRow[]) {
    if (stepOver.has(row.id)) continue;
    const block = quotaBlocking(quotas, usage, taken, row.attributes_norm ?? {});
    if (block) {
      stepOver.add(row.id);
      continue;
    }
    candidates.push(row);
    if (candidates.length >= wanted) break;
  }
  if (candidates.length === 0) return [];

  // The wire re-check. A bounce recorded since the import — or since this
  // tick began — takes the address out here, before anything is claimed.
  const { data: suppressed, error: suppressionError } = await supabaseAdmin
    .from("email_suppressions")
    .select("email_key")
    .in(
      "email_key",
      candidates.map((c) => c.email_key),
    );
  if (suppressionError) throw suppressionError;

  const blocked = new Set((suppressed ?? []).map((row) => row.email_key as string));
  const sendable = candidates.filter((c) => !blocked.has(c.email_key));

  if (blocked.size > 0) {
    const { error } = await supabaseAdmin
      .from("email_campaign_recipients")
      .update({ status: "suppressed", suppressed_reason: "on the do-not-send register" })
      .eq("campaign_id", campaignId)
      .eq("status", "pending")
      .in("email_key", [...blocked]);
    if (error) console.error("[email] could not mark suppressed recipients:", error.message);
  }
  if (sendable.length === 0) return [];

  return claimRecipients(sendable);
}

/**
 * Flip pending → claimed, and own only what the flip returned.
 *
 * Grouped by the attempt count each row was read with, so the increment is
 * that row's own rather than a single number applied to the batch, and so a
 * row another tick has already touched loses the race rather than being
 * overwritten.
 */
async function claimRecipients(rows: RecipientRow[]): Promise<RecipientRow[]> {
  const byAttempts = new Map<number, RecipientRow[]>();
  for (const row of rows) {
    const bucket = byAttempts.get(row.attempts) ?? [];
    bucket.push(row);
    byAttempts.set(row.attempts, bucket);
  }

  const claimed: RecipientRow[] = [];
  const claimedAt = new Date().toISOString();
  for (const [attempts, group] of byAttempts) {
    const { data, error } = await supabaseAdmin
      .from("email_campaign_recipients")
      .update({ status: "claimed", claimed_at: claimedAt, attempts: attempts + 1 })
      .in(
        "id",
        group.map((row) => row.id),
      )
      .eq("status", "pending")
      .eq("attempts", attempts)
      .select("id");
    if (error) {
      // The guard trigger refuses a claim on a suppressed address, which is
      // the one thing that can raise here after the re-check above — a bounce
      // that landed in between. Losing this batch costs a tick; overriding the
      // guard would cost the rule.
      console.error("[email] claim refused:", error.message);
      continue;
    }
    const won = new Set((data ?? []).map((row) => row.id as string));
    for (const row of group) if (won.has(row.id)) claimed.push(row);
  }
  return claimed;
}

type MessageResult = { kind: "sent" | "failed" | "unconfirmed" | "throttled" };

/** Compose, record, send, record again. */
async function sendOneMessage(input: {
  campaign: CampaignRow;
  mailbox: string;
  origin: string;
  recipients: RecipientRow[];
}): Promise<MessageResult> {
  const { campaign, mailbox, origin, recipients } = input;
  const html = campaign.body_format !== "text";
  const lead = recipients[0];

  // Per-recipient fields belong to a message with one recipient. `messageBatchSize`
  // already guarantees a personalised template is never batched; stating it here
  // as well means that if that guarantee were ever weakened, a batched message
  // renders those fields EMPTY rather than filling them with the first
  // person's name, state and unsubscribe link.
  const personal = recipients.length === 1;
  const context: Record<string, string> = {
    ...(personal ? (lead.attributes ?? {}) : {}),
    ...(personal
      ? {
          email: lead.email,
          unsubscribe_url: `${origin}/api/public/email/unsubscribe?t=${encodeURIComponent(lead.unsubscribe_token)}`,
        }
      : {}),
    campaign_name: campaign.name,
    sender_name: campaign.from_name ?? "",
    today: new Date().toISOString().slice(0, 10),
  };

  const subject = renderTemplate(campaign.subject_template, context, { html: false });
  const content = renderTemplate(campaign.body_template, context, { html });

  const toRecipients: GraphRecipient[] =
    recipients.length === 1
      ? [{ emailAddress: { address: recipients[0].email } }]
      : // The mailbox addresses itself and everybody else travels blind, so one
        // campaign cannot publish its own list to every person on it.
        [{ emailAddress: { address: mailbox } }];
  const bccRecipients: GraphRecipient[] | undefined =
    recipients.length === 1
      ? undefined
      : recipients.map((recipient) => ({ emailAddress: { address: recipient.email } }));

  const message: GraphMessage = {
    subject,
    body: { contentType: html ? "HTML" : "Text", content },
    toRecipients,
    ...(bccRecipients ? { bccRecipients } : {}),
    ...(campaign.reply_to ? { replyTo: [{ emailAddress: { address: campaign.reply_to } }] } : {}),
    // Only a display name is set, and only on the mailbox that is already
    // sending: naming a different address would need send-as rights this
    // application deliberately does not rely on.
    ...(campaign.from_name
      ? { from: { emailAddress: { address: mailbox, name: campaign.from_name } } }
      : {}),
  };

  const started = Date.now();
  const { data: messageRow, error: messageError } = await supabaseAdmin
    .from("email_campaign_messages")
    .insert({
      campaign_id: campaign.id,
      status: "sending",
      subject,
      body_preview: bodyPreview(content),
      mailbox,
      to_address: toRecipients[0]?.emailAddress.address ?? null,
      recipient_count: recipients.length,
      bcc_count: bccRecipients?.length ?? 0,
    })
    .select("id")
    .single();
  if (messageError) throw messageError;
  const messageId = messageRow.id as string;

  const outcome = await sendMail(mailbox, message);
  const durationMs = Date.now() - started;
  const ids = recipients.map((recipient) => recipient.id);
  const finishedAt = new Date().toISOString();

  // Stamped for every attempt, not only for a success. `min_gap_seconds` is a
  // rate limit on what this campaign puts on the wire, and measuring it from
  // the last SUCCESSFUL message means a campaign whose sends are all being
  // refused has no gap at all — it would retry at the per-tick ceiling for as
  // long as the fault lasted, which is exactly when a mailbox is least able to
  // take it.
  const { error: stampError } = await supabaseAdmin
    .from("email_campaigns")
    .update({ last_message_at: finishedAt })
    .eq("id", campaign.id);
  if (stampError) {
    console.error("[email] could not stamp last_message_at:", stampError.message);
  }

  if (outcome.kind === "sent") {
    const { error } = await supabaseAdmin
      .from("email_campaign_messages")
      .update({
        status: "sent",
        sent_at: finishedAt,
        duration_ms: durationMs,
        graph_status: outcome.status,
        graph_request_id: outcome.requestId,
      })
      .eq("id", messageId);
    if (error) console.error("[email] could not record a sent message:", error.message);

    const { error: recipientError } = await supabaseAdmin
      .from("email_campaign_recipients")
      .update({ status: "sent", sent_at: finishedAt, message_id: messageId, last_error: null })
      .in("id", ids);
    if (recipientError) {
      // The message HAS gone. A ledger that does not say so is the one state
      // that can produce a duplicate, so it is loud.
      console.error(
        `[email] SENT but could not mark recipients for message ${messageId}:`,
        recipientError.message,
      );
    }

    return { kind: "sent" };
  }

  if (outcome.kind === "throttled") {
    const { error } = await supabaseAdmin
      .from("email_campaign_messages")
      .update({ status: "failed", error: "throttled by Microsoft", duration_ms: durationMs })
      .eq("id", messageId);
    if (error) console.error("[email] could not record a throttled message:", error.message);

    // Nothing was accepted, so returning these to the queue is safe — and it
    // is the only outcome here for which that is true.
    const { error: releaseError } = await supabaseAdmin
      .from("email_campaign_recipients")
      .update({ status: "pending", claimed_at: null })
      .in("id", ids)
      .eq("status", "claimed");
    if (releaseError)
      console.error("[email] could not release a throttled claim:", releaseError.message);
    return { kind: "throttled" };
  }

  const failed = outcome.kind === "refused";
  const detail = outcome.message.slice(0, 500);
  const { error } = await supabaseAdmin
    .from("email_campaign_messages")
    .update({
      status: failed ? "failed" : "unconfirmed",
      error: detail,
      duration_ms: durationMs,
      ...(failed && "status" in outcome ? { graph_status: outcome.status } : {}),
    })
    .eq("id", messageId);
  if (error) console.error("[email] could not record a failed message:", error.message);

  const { error: failureError } = await supabaseAdmin
    .from("email_campaign_recipients")
    .update({
      status: failed ? "failed" : "unconfirmed",
      message_id: messageId,
      last_error: detail,
    })
    .in("id", ids);
  if (failureError) {
    console.error("[email] could not record recipient failures:", failureError.message);
  }

  return { kind: failed ? "failed" : "unconfirmed" };
}
