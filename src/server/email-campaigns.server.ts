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
 * failure costs one tick and touches no recipient. Each campaign sends through
 * its own Microsoft tenant — the deployment's, or one added in the console —
 * so the token is taken per tenant, once a pass, and a tenant whose
 * credentials fail holds up only the campaigns that use it.
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
 *
 * Two more follow from campaigns carrying files and choosing their mailbox.
 *
 * **Attachments are read and verified before anything is claimed**, like the
 * token and for the same reason. A message without its file is a different
 * message, and once it has gone the never-twice rule makes it permanent: the
 * contact cannot be sent the right one afterwards. So a file that cannot be
 * read, or no longer hashes to what was attached, costs a tick and touches no
 * recipient.
 *
 * **A refusal that is about the mailbox or the message pauses the campaign.**
 * Access withdrawn from the chosen mailbox, or a message too large for it, is
 * the same answer for every contact. Recording it against each contact in
 * turn converts one configuration fault into a whole list of "refused" rows a
 * person must release one at a time. Nothing was sent, so those contacts go
 * back in the queue and the campaign stops with the reason on it. Three
 * refusals in a row of any kind do the same, because a fault this file has no
 * name for looks exactly like that.
 *
 * And three follow from what actually calls this. pg_net delivers the
 * "every minute" tick in bursts — one to four calls at once, roughly every
 * minute and a half, and about one cron start in eleven never happens at all
 * (measured; see migration 20261012110000).
 *
 * **One pass per campaign at a time.** A pass takes a lease on the campaign
 * with one conditional UPDATE; the other calls in a burst leave it alone.
 * Without it they all read the same `last_message_at` and none of them waited
 * out the gap for the others.
 *
 * **A pass long enough to cover the wait for the next one.** It keeps starting
 * messages for up to 90 seconds, waiting out the gap between them, so a
 * campaign sends at its own pace rather than one message per burst — and
 * re-checks the campaign's status and window before each one, because in that
 * time an operator may pause it or its window may close.
 *
 * **Every pass writes down what it decided.** `last_tick_at`,
 * `last_tick_note` and `next_send_at` are what let the page say "waiting for
 * the window to open at 09:00 tomorrow" instead of only "running" — which is
 * exactly what a working campaign outside its hours used to look like, and
 * exactly what a stalled scheduler looked like too.
 *
 * And two follow from sending at set times, one message per segment.
 *
 * **A sending time's share is counted from the ledger.** Every message records
 * the sending time it belonged to (`slot_at`) and its segment; "has NSW had
 * its 09:00 message" is a count of those rows, so a pass that dies, a pause and
 * resume, or three ticks in one burst all read the same answer. A message that
 * may have reached people — sent, sending, unconfirmed — spends its share; one
 * Microsoft refused before accepting does not, because nothing went.
 *
 * **Every message stays inside one segment.** Its contacts are chosen with the
 * segment's values as a filter, so a fifty-contact BCC batch is fifty people
 * from one state, and the segment column's merge field has one answer for all
 * of them — the segment's label.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import {
  campaignRulesFromRow,
  claimQuota,
  currentSlot,
  isSlotMode,
  nextSendTime,
  planTick,
  quotaBlocking,
  startOfZonedDay,
  windowState,
  type CampaignRules,
  type QuotaRule,
  type SendSlot,
} from "@/lib/email/campaignRules.pure";
import { bodyPreview, perRecipientFields, renderTemplate } from "@/lib/email/mergeTemplate.pure";
import { segmentTurns, type Segment, type SegmentTurn } from "@/lib/email/segments.pure";
import { jsonPathColumn, pgInList } from "@/lib/email/quotaFilter.pure";
import { refusalPauseReason, refusalScope } from "@/lib/email/mailboxes.pure";
import { resolveMissionControlOrigin } from "@/server/missionControlLink.pure";
import {
  accessToken,
  deliverMessage,
  GraphError,
  type GraphConfig,
  type GraphMessage,
  type GraphRecipient,
} from "@/server/graph-client";
import { tenantKey } from "@/lib/email/microsoftTenants.pure";
import { graphConfigFor, tenantProblem } from "@/server/microsoft-tenants.server";
import {
  prepareCampaignAttachments,
  type PreparedAttachments,
} from "@/server/email-attachments.server";

/**
 * How long a pass may keep STARTING messages. One pass has to cover the gap
 * between the ticks that actually arrive — pg_net delivers them in bursts
 * roughly a minute and a half apart, not one a minute — so that a campaign
 * with a 60-second gap sends at its own pace instead of one message per burst.
 * The hook's HTTP timeout is 115 s (migration 20261012110000); the last
 * message starts by 90 s and a draft send with large files finishes well inside
 * the rest, because a caller that disconnects cancels the Worker, and a
 * cancellation mid-send is how a contact is stranded as `claimed`.
 */
const DEFAULT_BUDGET_MS = 90_000;
/**
 * How long a pass owns a campaign. Longer than the longest pass, so a pass
 * that dies holding it delays the campaign by this much and no more.
 */
const LEASE_MS = 150_000;
/**
 * A contact `claimed` this long ago is not in flight: no pass lives longer
 * than the lease. Whether its message left is unknowable, so it becomes
 * `unconfirmed` — never resent automatically — instead of `claimed` for ever,
 * which would also stop the campaign ever completing.
 */
const STALE_CLAIM_MS = 10 * 60_000;
/** Campaigns worked at once in one pass, so one waiting out its gap does not hold up the rest. */
const CAMPAIGN_CONCURRENCY = 4;
/** Candidates read per message, so quota-blocked contacts can be stepped over. */
const CANDIDATE_MULTIPLIER = 4;
const MAX_CANDIDATES = 2000;
/** Refusals in a row, within one tick, that pause a campaign whatever their cause. */
export const REFUSALS_BEFORE_PAUSE = 3;

export type DispatchSummary = {
  campaigns: number;
  messages: number;
  recipients: number;
  failed: number;
  unconfirmed: number;
  completed: number;
  paused: number;
  /** Campaigns another pass was already working — normal when ticks arrive in bursts. */
  leased: number;
  /** Contacts found stranded as `claimed` and recorded as unconfirmed. */
  stranded: number;
  skipped: string[];
};

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  /** The Microsoft tenant it sends through; null is the deployment's own. */
  tenant_id: string | null;
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
  send_times: string[] | null;
  slot_grace_minutes: number | null;
  max_messages_per_slot: number | null;
  max_messages_per_day: number | null;
  max_recipients_per_day: number | null;
  recipients_per_message: number;
  min_gap_seconds: number;
  max_messages_per_run: number;
  starts_at: string | null;
  ends_at: string | null;
  last_message_at: string | null;
  /** The list column every message is confined to; null is no segmentation. */
  segment_dimension: string | null;
  segment_messages_per_slot: number | null;
  /** The campaign's shared unsubscribe link, for a message to several contacts. */
  unsubscribe_token: string | null;
};

/** A segmented campaign's enabled segments, and every value they cover. */
type Segmentation = { dimension: string; segments: Segment[]; values: string[] };

/** Statuses of a message that may have reached people, so spend a sending time's share. */
const SPENDING_STATUSES = ["sending", "sent", "unconfirmed"];
/** How far back a segment's last message is looked for, to decide whose turn it is. */
const TURN_MEMORY_MS = 7 * 24 * 3_600_000;

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
  return campaignRulesFromRow(campaign);
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

/**
 * The campaign's enabled segments in the operator's order, or null when it is
 * not segmented. A segmented campaign with none enabled has nobody it may
 * send to — which the caller says, rather than falling back to everybody.
 */
async function loadSegmentation(campaign: CampaignRow): Promise<Segmentation | null> {
  const dimension = campaign.segment_dimension?.trim();
  if (!dimension) return null;
  // The key reaches a filter expression, so it is validated before anything else.
  jsonPathColumn("attributes_norm", dimension);
  const { data, error } = await supabaseAdmin
    .from("email_campaign_segments")
    .select("id, label, match_values, position, enabled")
    .eq("campaign_id", campaign.id)
    .eq("enabled", true)
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  const segments: Segment[] = (data ?? []).map((row) => ({
    id: row.id as string,
    label: row.label as string,
    matchValues: (row.match_values as string[]) ?? [],
    position: Number(row.position) || 0,
    enabled: true,
  }));
  return {
    dimension,
    segments,
    values: [...new Set(segments.flatMap((segment) => segment.matchValues))],
  };
}

type SlotLedger = {
  /** Messages that may have reached people in the sending time open now. */
  thisSlot: number;
  /** The same, per segment. */
  bySegment: Map<string, number>;
  /** When each segment last had a message, for whose turn it is. */
  lastServedAt: Map<string, number>;
};

/** What the message ledger says about this sending time, and about each segment's last turn. */
async function loadSlotLedger(
  campaignId: string,
  slot: SendSlot | null,
  segmented: boolean,
): Promise<SlotLedger> {
  const ledger: SlotLedger = { thisSlot: 0, bySegment: new Map(), lastServedAt: new Map() };
  if (!slot && !segmented) return ledger;
  const { data, error } = await supabaseAdmin
    .from("email_campaign_messages")
    .select("segment_id, slot_at, queued_at")
    .eq("campaign_id", campaignId)
    .in("status", SPENDING_STATUSES)
    .gte("queued_at", new Date(Date.now() - TURN_MEMORY_MS).toISOString())
    .order("queued_at", { ascending: false })
    .limit(2000);
  if (error) throw error;
  for (const row of data ?? []) {
    const segment = (row.segment_id as string | null) ?? null;
    const queued = Date.parse(row.queued_at as string);
    if (segment && Number.isFinite(queued) && queued > (ledger.lastServedAt.get(segment) ?? -1)) {
      ledger.lastServedAt.set(segment, queued);
    }
    if (slot && row.slot_at && Date.parse(row.slot_at as string) === slot.at.getTime()) {
      ledger.thisSlot += 1;
      if (segment) ledger.bySegment.set(segment, (ledger.bySegment.get(segment) ?? 0) + 1);
    }
  }
  return ledger;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One pass over every running campaign.
 *
 * Called by `/hooks/email-campaign-dispatch` on a one-minute schedule — which
 * on this deployment arrives as bursts of one to four calls every minute and
 * a half or so (see the migration that added the lease). Each campaign is
 * worked by whichever call takes its lease; the others leave it alone.
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
    paused: 0,
    leased: 0,
    stranded: 0,
    skipped: [],
  };

  // Each tenant's credentials are read and tried once a pass, however many
  // of its campaigns are due, and only when one of them is about to send.
  const checked = new Map<string, Promise<TenantAccess>>();
  const credentials = (tenantId: string | null) => {
    const key = tenantKey(tenantId);
    let access = checked.get(key);
    if (!access) {
      access = tenantAccess(tenantId);
      checked.set(key, access);
    }
    return access;
  };

  const { data: campaigns, error: campaignError } = await supabaseAdmin
    .from("email_campaigns")
    .select("*")
    .eq("status", "running")
    .order("last_message_at", { ascending: true, nullsFirst: true })
    .limit(25);
  if (campaignError) throw campaignError;

  // The injected clock (tests), advanced by real elapsed time, so a pass that
  // waits out a gap judges the window at the moment it sends, not when it began.
  const base = options.now ?? new Date();
  const clock = () => new Date(base.getTime() + (Date.now() - startedAt));
  const deadline = startedAt + budgetMs;

  const queue = [...((campaigns ?? []) as unknown as CampaignRow[])];
  const worker = async () => {
    for (let campaign = queue.shift(); campaign; campaign = queue.shift()) {
      if (Date.now() > deadline) {
        summary.skipped.push(`${campaign.name}: out of time this tick`);
        continue;
      }
      try {
        const outcome = await runCampaignTick(campaign, { clock, deadline, credentials });
        if (outcome.leased) {
          summary.leased += 1;
          continue;
        }
        summary.campaigns += 1;
        summary.messages += outcome.messages;
        summary.recipients += outcome.recipients;
        summary.failed += outcome.failed;
        summary.unconfirmed += outcome.unconfirmed;
        summary.stranded += outcome.stranded;
        if (outcome.completed) summary.completed += 1;
        if (outcome.paused) summary.paused += 1;
        if (outcome.note) summary.skipped.push(`${campaign.name}: ${outcome.note}`);
      } catch (error) {
        // One campaign's fault must not stop the others: they share nothing but
        // this loop.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[email] campaign ${campaign.id} failed this tick:`, message);
        summary.skipped.push(`${campaign.name}: ${message}`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CAMPAIGN_CONCURRENCY, queue.length) }, () => worker()),
  );

  return summary;
}

type TickOutcome = {
  messages: number;
  recipients: number;
  failed: number;
  unconfirmed: number;
  completed: boolean;
  paused: boolean;
  /** Another pass held the campaign; this one did nothing to it. */
  leased: boolean;
  stranded: number;
  note: string | null;
};

type TenantAccess = { config: GraphConfig; problem: null } | { config: null; problem: string };

type TickContext = {
  clock: () => Date;
  deadline: number;
  /** A tenant's credentials with a token already taken, or why there are none. */
  credentials: (tenantId: string | null) => Promise<TenantAccess>;
};

/**
 * A tenant's credentials, proven by taking a token with them. Before anything
 * is claimed: a credential failure now costs a tick; the same failure after a
 * claim costs a queue that never moves.
 */
async function tenantAccess(tenantId: string | null): Promise<TenantAccess> {
  try {
    const config = await graphConfigFor(tenantId);
    if (!config) {
      return {
        config: null,
        problem: (await tenantProblem(tenantId)) ?? "Microsoft Graph is not configured",
      };
    }
    await accessToken(config);
    return { config, problem: null };
  } catch (error) {
    return {
      config: null,
      problem:
        error instanceof GraphError
          ? error.message
          : `could not obtain a Microsoft Graph token: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Stop a running campaign and say why. Only a `running` campaign is touched,
 * so an operator who paused or cancelled it meanwhile keeps their own reason.
 */
async function pauseCampaign(campaignId: string, reason: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("email_campaigns")
    .update({ status: "paused", paused_reason: reason.slice(0, 1000) })
    .eq("id", campaignId)
    .eq("status", "running")
    .select("id");
  if (error) {
    console.error(`[email] could not pause campaign ${campaignId}:`, error.message);
    return false;
  }
  if ((data ?? []).length === 0) return false;
  const { writeAuditLog } = await import("@/server/audit.server");
  await writeAuditLog({
    action: "email_campaign_paused_by_dispatcher",
    entityType: "email_campaign",
    entityId: campaignId,
    actorUserId: null,
    metadata: { reason },
  });
  return true;
}

/**
 * Take the campaign for this pass, or learn that another pass has it.
 *
 * One conditional UPDATE: it succeeds only when no lease is held or the one
 * held has run out, and only for a campaign still running. pg_net routinely
 * delivers two to four ticks at once, and before this every one of them read
 * the same `last_message_at` — so none of them waited out the gap for the
 * others, and each counted the same "sent today". The row the update returns
 * also carries the freshest `last_message_at`, written by whichever pass came
 * before.
 */
async function acquireLease(
  campaignId: string,
): Promise<{ token: string; lastMessageAt: string | null } | null> {
  const token = crypto.randomUUID();
  const now = new Date();
  const { data, error } = await supabaseAdmin
    .from("email_campaigns")
    .update({
      dispatch_lease_until: new Date(now.getTime() + LEASE_MS).toISOString(),
      dispatch_lease_token: token,
    })
    .eq("id", campaignId)
    .eq("status", "running")
    .or(`dispatch_lease_until.is.null,dispatch_lease_until.lt."${now.toISOString()}"`)
    .select("id, last_message_at");
  if (error) throw error;
  const row = (data ?? [])[0] as { last_message_at: string | null } | undefined;
  return row ? { token, lastMessageAt: row.last_message_at ?? null } : null;
}

/**
 * Hand the campaign back, and write down what this pass decided: the
 * heartbeat the page reads to say why a running campaign is or is not
 * sending, and when it next will.
 */
async function releaseLease(
  campaignId: string,
  token: string,
  heartbeat: { note: string | null; nextSendAt: Date | null },
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("email_campaigns")
    .update({
      dispatch_lease_until: null,
      dispatch_lease_token: null,
      last_tick_at: new Date().toISOString(),
      last_tick_note: heartbeat.note ? heartbeat.note.slice(0, 500) : null,
      next_send_at: heartbeat.nextSendAt ? heartbeat.nextSendAt.toISOString() : null,
    })
    .eq("id", campaignId)
    .eq("dispatch_lease_token", token);
  if (error) console.error(`[email] could not release campaign ${campaignId}:`, error.message);
}

/**
 * Contacts stranded as `claimed` by a pass that never finished, recorded as
 * `unconfirmed`. Safe because the lease is held: no pass that could still be
 * sending to them is alive. Never back to `pending` — the message may have left.
 */
async function expireStrandedClaims(campaignId: string, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("email_campaign_recipients")
    .update({
      status: "unconfirmed",
      last_error:
        "the dispatcher stopped part-way through sending to this contact, so whether the message left is unknown",
    })
    .eq("campaign_id", campaignId)
    .eq("status", "claimed")
    .lt("claimed_at", cutoff)
    .select("id");
  if (error) {
    console.error(`[email] could not expire stranded claims for ${campaignId}:`, error.message);
    return 0;
  }
  const { error: messageError } = await supabaseAdmin
    .from("email_campaign_messages")
    .update({
      status: "unconfirmed",
      error: "the dispatcher stopped before it recorded what Microsoft answered",
    })
    .eq("campaign_id", campaignId)
    .eq("status", "sending")
    .lt("queued_at", cutoff);
  if (messageError) {
    console.error(
      `[email] could not expire stranded messages for ${campaignId}:`,
      messageError.message,
    );
  }
  return (data ?? []).length;
}

/**
 * Why this pass must stop before its next message, or null. Asked after any
 * wait: a pass can run for a minute and a half, and in that time an operator
 * may pause the campaign or its window may close. `final` when the campaign
 * itself stopped — then there is no next message to promise.
 */
async function reasonToStop(
  campaignId: string,
  rules: CampaignRules,
  now: Date,
  slot: SendSlot | null,
): Promise<{ reason: string; final: boolean } | null> {
  const { data, error } = await supabaseAdmin
    .from("email_campaigns")
    .select("status")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== "running") {
    return { reason: `stopped: the campaign is now ${data?.status ?? "gone"}`, final: true };
  }
  const window = windowState(rules, now);
  if (!window.open) return { reason: window.detail, final: false };
  // The pass counted THIS sending time's share. If the next one has opened,
  // the next pass counts that one's.
  if (slot && currentSlot(rules, now)?.at.getTime() !== slot.at.getTime()) {
    return { reason: `the ${slot.clock} sending time has closed`, final: false };
  }
  return null;
}

async function runCampaignTick(campaign: CampaignRow, context: TickContext): Promise<TickOutcome> {
  const lease = await acquireLease(campaign.id);
  if (!lease) {
    return {
      messages: 0,
      recipients: 0,
      failed: 0,
      unconfirmed: 0,
      completed: false,
      paused: false,
      leased: true,
      stranded: 0,
      note: null,
    };
  }

  let outcome: TickOutcome | null = null;
  let nextSendAt: Date | null = null;
  try {
    const worked = await workCampaign(
      { ...campaign, last_message_at: lease.lastMessageAt },
      context,
    );
    outcome = worked.outcome;
    nextSendAt = worked.nextSendAt;
    return outcome;
  } finally {
    const note = outcome
      ? [
          outcome.messages > 0
            ? `sent ${outcome.messages} message${outcome.messages === 1 ? "" : "s"}`
            : null,
          outcome.note,
        ]
          .filter(Boolean)
          .join("; ") || "nothing to do"
      : "the pass failed — see the dispatcher's log";
    await releaseLease(campaign.id, lease.token, { note, nextSendAt });
  }
}

/** Everything one pass does with a campaign it holds the lease on. */
async function workCampaign(
  campaign: CampaignRow,
  context: TickContext,
): Promise<{ outcome: TickOutcome; nextSendAt: Date | null }> {
  const outcome: TickOutcome = {
    messages: 0,
    recipients: 0,
    failed: 0,
    unconfirmed: 0,
    completed: false,
    paused: false,
    leased: false,
    stranded: 0,
    note: null,
  };

  const rules = rulesFor(campaign);
  const startedNow = context.clock();
  const dayStart = startOfZonedDay(startedNow, rules.timezone);
  // The sending time open now, for a campaign that sends at set times. Fixed
  // for the pass: the share counted below is this one's, so a pass that runs
  // into the next sending time stops rather than spending it on a stale count.
  const slot = isSlotMode(rules) ? currentSlot(rules, startedNow) : null;

  outcome.stranded = await expireStrandedClaims(campaign.id, new Date());

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
    return { outcome, nextSendAt: null };
  }

  // With segments, only contacts in an enabled one may be sent. The rest stay
  // waiting — a segment disabled for now is a decision to hold them, not to
  // drop them — and the campaign says so rather than completing over them.
  const segmentation = await loadSegmentation(campaign);
  let sendable = pendingCount;
  if (segmentation) {
    sendable =
      segmentation.values.length === 0
        ? 0
        : await countRecipients(campaign.id, (q) =>
            q
              .eq("status", "pending")
              .filter(
                jsonPathColumn("attributes_norm", segmentation.dimension),
                "in",
                pgInList(segmentation.values),
              ),
          );
    if (sendable === 0) {
      const waiting = `${pendingCount.toLocaleString("en-AU")} waiting contact${pendingCount === 1 ? "" : "s"}`;
      outcome.note =
        segmentation.segments.length === 0
          ? `no segment is enabled, so none of the ${waiting} can be sent — enable one on the Segments tab`
          : `every enabled segment is finished; ${waiting} ${pendingCount === 1 ? "is" : "are"} outside them (in a disabled segment, or in none) — enable a segment, or cancel the campaign to close it`;
      return { outcome, nextSendAt: null };
    }
  }

  const messagesTodayResult = await supabaseAdmin
    .from("email_campaign_messages")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaign.id)
    .eq("status", "sent")
    .gte("sent_at", dayStart.toISOString());
  if (messagesTodayResult.error) throw messagesTodayResult.error;
  let messagesToday = messagesTodayResult.count ?? 0;

  let recipientsToday = await countRecipients(campaign.id, (q) =>
    q.eq("status", "sent").gte("sent_at", dayStart.toISOString()),
  );
  let lastMessageAt = campaign.last_message_at;

  const ledger = await loadSlotLedger(campaign.id, slot, segmentation != null);
  let messagesThisSlot = ledger.thisSlot;
  // Whose turn it is, and how much of this sending time's share each has left.
  // Reordered as the pass goes, so consecutive messages go to different segments.
  const turns: SegmentTurn[] | null = segmentation
    ? segmentTurns({
        segments: segmentation.segments,
        perSlot: slot ? Math.max(1, campaign.segment_messages_per_slot ?? 1) : null,
        sentThisSlot: ledger.bySegment,
        lastServedAt: ledger.lastServedAt,
      })
    : null;
  // Segments with nobody claimable this pass: finished, or held by a quota.
  const exhausted = new Set<string>();
  const slotSpent = () =>
    slot != null &&
    ((rules.maxMessagesPerSlot != null && messagesThisSlot >= rules.maxMessagesPerSlot) ||
      (turns != null &&
        turns.every((turn) => turn.remaining <= 0 || exhausted.has(turn.segment.id))));
  const slotDone = () =>
    `that is everything the ${slot?.clock ?? ""} sending time may send — the next goes at the next sending time`;
  const whenNext = () =>
    nextSendTime({
      rules,
      now: context.clock(),
      lastMessageAt,
      messagesToday,
      recipientsToday,
      slotSpent: slotSpent(),
    });

  const plan = planTick({
    rules,
    now: startedNow,
    lastMessageAt,
    messagesToday,
    recipientsToday,
    pendingCount: sendable,
    messagesThisSlot,
  });
  if (!plan.canSend) {
    outcome.note = plan.blockedBy;
    return { outcome, nextSendAt: whenNext() };
  }
  if (slotSpent()) {
    outcome.note = slotDone();
    return { outcome, nextSendAt: whenNext() };
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
  const tenant = await context.credentials(campaign.tenant_id ?? null);
  if (!tenant.config) {
    outcome.note = `nothing was claimed: ${tenant.problem}`;
    return { outcome, nextSendAt: null };
  }
  const config = tenant.config;
  const mailbox = campaign.from_mailbox?.trim() || config.mailbox;
  if (!mailbox) {
    outcome.note = "no sending mailbox is configured";
    return { outcome, nextSendAt: null };
  }

  // Before anything is claimed — see the header.
  let attachments: PreparedAttachments;
  try {
    attachments = await prepareCampaignAttachments(campaign);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outcome.note = `its attachments could not be prepared, so nothing was claimed: ${message}`;
    return { outcome, nextSendAt: null };
  }

  const origin = resolveMissionControlOrigin({ PUBLIC_APP_URL: process.env.PUBLIC_APP_URL });
  let recipientsLeft = plan.recipientAllowance;
  let delayMs = plan.initialDelayMs;
  let refusalsInARow = 0;
  let stopped = false;
  // Contacts a quota has stepped over this tick, so the next page does not
  // hand back the same ones for ever.
  const stepOver = new Set<string>();

  for (let message = 0; message < plan.messageAllowance; message++) {
    if (recipientsLeft <= 0) break;
    // Before waiting out a gap for a message this sending time has no room for.
    if (slotSpent()) break;
    if (Date.now() + delayMs > context.deadline) {
      // Not a fault: the next pass picks up where this one stopped, and the
      // heartbeat says when that will be.
      outcome.note = outcome.note ?? "waiting out the gap until the next pass";
      break;
    }
    if (delayMs > 0) await sleep(delayMs);
    delayMs = rules.minGapSeconds * 1000;

    // The world may have moved while this pass waited or sent.
    if (message > 0 || plan.initialDelayMs > 0) {
      const stop = await reasonToStop(campaign.id, rules, context.clock(), slot);
      if (stop) {
        outcome.note = stop.reason;
        stopped = stop.final;
        break;
      }
    }

    const wanted = Math.min(perMessage, recipientsLeft);
    let chosen: RecipientRow[] = [];
    let turn: SegmentTurn | null = null;
    if (turns && segmentation) {
      // The first segment whose turn it is and that has somebody to send to.
      for (const candidate of turns) {
        if (candidate.remaining <= 0 || exhausted.has(candidate.segment.id)) continue;
        const picked = await chooseRecipients(campaign.id, wanted, quotas, usage, taken, stepOver, {
          dimension: segmentation.dimension,
          values: candidate.segment.matchValues,
        });
        if (picked.length === 0) {
          exhausted.add(candidate.segment.id);
          continue;
        }
        chosen = picked;
        turn = candidate;
        break;
      }
    } else {
      chosen = await chooseRecipients(campaign.id, wanted, quotas, usage, taken, stepOver, null);
    }
    if (chosen.length === 0) {
      // Every segment with a share left is finished or held, a quota holding
      // every waiting contact, or another pass having claimed them between the
      // read and the claim. None of these is a fault.
      outcome.note =
        outcome.note ??
        (slotSpent()
          ? slotDone()
          : "no contact could be claimed — held by a quota, or taken by another pass");
      break;
    }

    const sent = await sendOneMessage({
      campaign,
      config,
      mailbox,
      origin,
      recipients: chosen,
      attachments,
      segment:
        turn && segmentation
          ? { id: turn.segment.id, label: turn.segment.label, dimension: segmentation.dimension }
          : null,
      slotAt: slot?.at ?? null,
    });
    // `last_message_at` is stamped for every attempt; so is this pass's copy,
    // with the same instant, so the next send time is measured from it.
    lastMessageAt = sent.at;

    if (turns && turn) {
      // Its go is over whatever happened: the next message is another segment's.
      turns.splice(turns.indexOf(turn), 1);
      turns.push(turn);
    }
    if (sent.kind === "sent" || sent.kind === "unconfirmed") {
      // Either may have reached people, so either spends the share — the
      // ledger counts them the same way.
      messagesThisSlot += 1;
      if (turn) turn.remaining -= 1;
    }

    outcome.messages += 1;
    if (sent.kind === "sent") {
      refusalsInARow = 0;
      outcome.recipients += chosen.length;
      recipientsLeft -= chosen.length;
      messagesToday += 1;
      recipientsToday += chosen.length;
      for (const recipient of chosen) claimQuota(quotas, taken, recipient.attributes_norm ?? {});
    } else if (sent.kind === "failed") {
      outcome.failed += chosen.length;
      refusalsInARow += 1;
      if (refusalsInARow >= REFUSALS_BEFORE_PAUSE) {
        const reason = `${REFUSALS_BEFORE_PAUSE} messages in a row were refused by Microsoft — the last said: ${sent.detail}. Paused so the rest of the list is not refused the same way; the refused contacts can be retried from the Audience tab.`;
        outcome.paused = await pauseCampaign(campaign.id, reason);
        outcome.note = reason;
        stopped = true;
        break;
      }
    } else if (sent.kind === "unconfirmed") {
      refusalsInARow = 0;
      outcome.unconfirmed += chosen.length;
    } else if (sent.kind === "halted") {
      // A refusal about the mailbox or the message. Nothing was sent, the
      // claim was released, and the campaign has been paused.
      outcome.messages -= 1;
      outcome.paused = sent.paused;
      outcome.note = sent.detail;
      stopped = true;
      break;
    } else if (sent.kind === "deferred") {
      // Nothing was sent and the claim was released; whatever went wrong
      // while the draft was being built will be tried again next tick.
      outcome.messages -= 1;
      outcome.note = `nothing was sent this tick: ${sent.detail}`;
      break;
    } else {
      // Throttled: the claim was released, nothing was sent, and pressing on
      // this tick would only earn another 429.
      outcome.messages -= 1;
      outcome.note = "Microsoft is throttling this mailbox";
      break;
    }
  }

  if (!stopped && outcome.note == null && slotSpent()) outcome.note = slotDone();

  // A campaign that stopped (paused, here or by an operator) has no next message.
  return { outcome, nextSendAt: stopped ? null : whenNext() };
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
 *
 * The one column exempt is a segmented campaign's own: every contact in its
 * message shares the segment, so `{{state}}` has one answer for all of them.
 */
export function messageBatchSize(campaign: {
  subject_template: string;
  body_template: string;
  recipients_per_message: number;
  segment_dimension?: string | null;
}): number {
  const shared = campaign.segment_dimension ? [campaign.segment_dimension] : [];
  const templates = [campaign.subject_template, campaign.body_template];
  if (perRecipientFields(templates, shared).length > 0) return 1;
  return Math.max(1, campaign.recipients_per_message);
}

/**
 * Pending contacts that no quota is holding — and, for a segmented campaign,
 * only the segment whose turn it is — re-checked against the suppression
 * register immediately before they are claimed.
 */
async function chooseRecipients(
  campaignId: string,
  wanted: number,
  quotas: QuotaRule[],
  usage: Map<string, { today: number; total: number }>,
  taken: Map<string, number>,
  stepOver: Set<string>,
  segment: { dimension: string; values: string[] } | null,
): Promise<RecipientRow[]> {
  const limit = Math.min(MAX_CANDIDATES, Math.max(wanted * CANDIDATE_MULTIPLIER, wanted + 20));
  let query = supabaseAdmin
    .from("email_campaign_recipients")
    .select("id, email, email_key, attempts, attributes, attributes_norm, unsubscribe_token")
    .eq("campaign_id", campaignId)
    .eq("status", "pending");
  if (segment) {
    // In the query rather than after it: a page of the first two thousand
    // contacts may hold none of this segment's.
    query = query.filter(
      jsonPathColumn("attributes_norm", segment.dimension),
      "in",
      pgInList(segment.values),
    );
  }
  const { data, error } = await query.order("position", { ascending: true }).limit(limit);
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

type MessageResult = (
  | { kind: "sent" | "unconfirmed" | "throttled" }
  | { kind: "failed"; detail: string }
  | { kind: "deferred"; detail: string }
  | { kind: "halted"; detail: string; paused: boolean }
) & {
  /** The `last_message_at` this attempt stamped on the campaign. */
  at: string;
};

/** Return claimed contacts to the queue. Only ever after a send that did not happen. */
async function releaseClaims(ids: string[], why: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("email_campaign_recipients")
    .update({ status: "pending", claimed_at: null })
    .in("id", ids)
    .eq("status", "claimed");
  if (error) console.error(`[email] could not release a claim (${why}):`, error.message);
}

/**
 * The unsubscribe link a message carries: the contact's own for a message to
 * one, the campaign's shared one for a message to several — or none, for a
 * campaign row that predates the shared token, which renders the field empty
 * rather than handing a batch one person's link.
 */
export function unsubscribeUrl(
  origin: string,
  campaign: { unsubscribe_token?: string | null },
  only: { unsubscribe_token: string } | null,
): string | null {
  if (only)
    return `${origin}/api/public/email/unsubscribe?t=${encodeURIComponent(only.unsubscribe_token)}`;
  if (!campaign.unsubscribe_token) return null;
  return `${origin}/api/public/email/unsubscribe?c=${encodeURIComponent(campaign.unsubscribe_token)}`;
}

/** Compose, record, send, record again. */
async function sendOneMessage(input: {
  campaign: CampaignRow;
  /** The campaign's tenant's credentials. */
  config: GraphConfig;
  mailbox: string;
  origin: string;
  recipients: RecipientRow[];
  attachments: PreparedAttachments;
  /** The segment every one of these recipients is in, for a segmented campaign. */
  segment: { id: string; label: string; dimension: string } | null;
  /** The sending time this message belongs to, for a campaign that has them. */
  slotAt: Date | null;
}): Promise<MessageResult> {
  const { campaign, config, mailbox, origin, recipients, attachments, segment } = input;
  const html = campaign.body_format !== "text";
  const lead = recipients[0];

  // Per-recipient fields belong to a message with one recipient. `messageBatchSize`
  // already guarantees a personalised template is never batched; stating it here
  // as well means that if that guarantee were ever weakened, a batched message
  // renders those fields EMPTY rather than filling them with the first
  // person's name, state and unsubscribe link.
  //
  // The segment's column is the exception, and it is the segment's LABEL that
  // renders, for every message alike: one message carrying `NSW` and
  // `New South Wales` contacts says "NSW" to all of them.
  //
  // So is the unsubscribe link, which has an answer for a batch: the
  // campaign's shared link, where the reader confirms the address the message
  // reached them at. One contact gets their own one-click link instead.
  const personal = recipients.length === 1;
  const unsubscribe = unsubscribeUrl(origin, campaign, personal ? lead : null);
  const context: Record<string, string> = {
    ...(personal ? (lead.attributes ?? {}) : {}),
    ...(segment ? { [segment.dimension]: segment.label } : {}),
    ...(personal ? { email: lead.email } : {}),
    ...(unsubscribe ? { unsubscribe_url: unsubscribe } : {}),
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
      // Which tenant's mailbox: the bounce scan reads it through the same one.
      tenant_id: campaign.tenant_id ?? null,
      to_address: toRecipients[0]?.emailAddress.address ?? null,
      recipient_count: recipients.length,
      bcc_count: bccRecipients?.length ?? 0,
      // Written BEFORE the send: the record of what this message carried must
      // exist whatever happens on the wire.
      attachments: attachments.snapshot as unknown as Json,
      attachment_count: attachments.snapshot.length,
      attachment_bytes: attachments.totalBytes,
      // Before the send too: these are what a sending time's share is counted
      // from, and a message that may have left has spent it.
      segment_id: segment?.id ?? null,
      segment_label: segment?.label ?? null,
      slot_at: input.slotAt ? input.slotAt.toISOString() : null,
    })
    .select("id")
    .single();
  if (messageError) throw messageError;
  const messageId = messageRow.id as string;

  const outcome = await deliverMessage(mailbox, message, attachments.outbound, config);
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
        graph_draft_id: outcome.draftId,
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

    return { kind: "sent", at: finishedAt };
  }

  if (outcome.kind === "throttled" || outcome.kind === "deferred") {
    const detail =
      outcome.kind === "throttled" ? "throttled by Microsoft" : `not sent: ${outcome.message}`;
    const { error } = await supabaseAdmin
      .from("email_campaign_messages")
      .update({ status: "failed", error: detail.slice(0, 500), duration_ms: durationMs })
      .eq("id", messageId);
    if (error) console.error("[email] could not record an unsent message:", error.message);

    // Nothing was accepted, so returning these to the queue is safe — and
    // these are the only outcomes, with a halt below, for which that is true.
    await releaseClaims(ids, outcome.kind);
    return outcome.kind === "throttled"
      ? { kind: "throttled", at: finishedAt }
      : { kind: "deferred", detail: outcome.message, at: finishedAt };
  }

  if (outcome.kind === "refused") {
    const scope = refusalScope(outcome.status, outcome.code);
    if (scope !== "recipient") {
      // The same answer for every contact this campaign has. Refused BEFORE
      // acceptance, so nothing exists: release, and stop the campaign.
      const reason = refusalPauseReason(scope, mailbox, outcome.message, outcome.path);
      const { error } = await supabaseAdmin
        .from("email_campaign_messages")
        .update({
          status: "failed",
          error: outcome.message.slice(0, 500),
          duration_ms: durationMs,
          graph_status: outcome.status,
        })
        .eq("id", messageId);
      if (error) console.error("[email] could not record a refused message:", error.message);
      await releaseClaims(ids, `refused: ${scope}`);
      const paused = await pauseCampaign(campaign.id, reason);
      return { kind: "halted", detail: reason, paused, at: finishedAt };
    }
  }

  const failed = outcome.kind === "refused";
  const detail = outcome.message.slice(0, 500);
  const { error } = await supabaseAdmin
    .from("email_campaign_messages")
    .update({
      status: failed ? "failed" : "unconfirmed",
      error: detail,
      duration_ms: durationMs,
      graph_draft_id: outcome.draftId,
      ...(outcome.kind === "refused" ? { graph_status: outcome.status } : {}),
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

  return failed
    ? { kind: "failed", detail, at: finishedAt }
    : { kind: "unconfirmed", at: finishedAt };
}
