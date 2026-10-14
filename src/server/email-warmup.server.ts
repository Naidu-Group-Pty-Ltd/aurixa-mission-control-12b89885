/**
 * Email warmup — the engine.
 *
 * `src/lib/email/warmupPlan.pure.ts` decides how much, when and to whom, and
 * says why the pool only pairs mailboxes across organisations;
 * `warmupContent.pure.ts` decides what the mail says. This file does it, one
 * pass at a time, from the `email-warmup-2min` cron hook.
 *
 * ## A message's life
 *
 * 1. **Sent.** A row is written, then the message is created as a DRAFT in the
 *    sender's mailbox and the draft is sent. Drafting rather than `sendMail`
 *    is what gives the engine a handle on it: the draft's immutable id is the
 *    Sent Items copy's id afterwards, and its Message-ID is the one the
 *    recipient's copy carries.
 * 2. **Confirmed and found.** A few minutes later the sender's copy is read
 *    back — still a draft means it never left — and filed into the sender's
 *    warmup folder. Then the recipient's mailbox is searched for that
 *    Message-ID: the inbox, then Junk, then anywhere. Where it is found is its
 *    placement, the number warmup exists to move. Not found within six hours,
 *    it is `missing`: quarantined, rejected or deleted on arrival — worse than
 *    Junk, and counted so.
 * 3. **Engaged.** Minutes later, as a reader would: moved out of Junk if it
 *    landed there, marked read, flagged now and then, moved to Focused if
 *    Focused had put it in Other, and filed into the recipient's warmup folder
 *    so it does not sit in a person's inbox.
 * 4. **Answered**, at the recipient's reply rate, after a pause and inside the
 *    recipient's own window: a reply draft (Microsoft's own, quoting the
 *    original) with a few lines above the quote, sent, and recorded as a
 *    message of its own that goes through all of this again — so the original
 *    sender's inbox placement is measured too, and the thread can go one more
 *    round.
 *
 * What the recipient will do — reply, flag — is decided when the message is
 * sent and stored on it, so a step that is retried does not roll again.
 *
 * ## One pass at a time
 *
 * pg_net delivers this hook's ticks in bursts. A pass takes the pool's lease
 * with one conditional UPDATE on `email_warmup_settings`; a concurrent tick
 * finds it taken and leaves. A pass that dies holding it costs the lease's
 * lifetime.
 *
 * ## What stops it
 *
 * The pool's pause stops new conversations and replies; mail already in flight
 * is still found, engaged with and filed, so nothing is left in anyone's
 * inbox. A mailbox's own pause does the same for that mailbox, and takes it
 * out of the pool as a recipient. A mailbox whose sends Microsoft refuses
 * three times running is put into `error` with the reason.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { capabilitiesFrom } from "@/lib/email/mailboxes.pure";
import {
  nextWindowOpening,
  startOfZonedDay,
  windowState,
  zonedParts,
} from "@/lib/email/campaignRules.pure";
import {
  composeWarmupMessage,
  composeWarmupReply,
  firstNameFor,
  prependToReplyBody,
} from "@/lib/email/warmupContent.pure";
import {
  DRAFT_STUCK_MINUTES,
  ENGAGE_DELAY_MINUTES,
  FAILURES_BEFORE_ERROR,
  MAX_ACTION_ATTEMPTS,
  MAX_THREAD_DEPTH,
  MISSING_AFTER_MINUTES,
  REPLY_DELAY_MINUTES,
  STALE_SENDING_MINUTES,
  UNCHECKABLE_AFTER_MINUTES,
  WARMUP_FOLDER_NAME,
  checkDelayMinutes,
  choosePartner,
  daysBefore,
  engagementPlan,
  HEALTH_WINDOW_DAYS,
  localDate,
  minutesBetween,
  nextSendAt,
  rampDay,
  rampEvidence,
  rampGate,
  receiveCap,
  scheduleFromRow,
  startOfNextLocalDay,
  warmupRules,
  type PoolMember,
  type RampGate,
  type WarmupDay,
  type WarmupScheduleColumns,
} from "@/lib/email/warmupPlan.pure";
import {
  GraphError,
  createDraftMessage,
  createReplyDraft,
  deleteMailboxMessage,
  ensureMailFolder,
  findMessageByInternetId,
  getMailboxMessage,
  grantedRoles,
  moveMailboxMessage,
  organisationOf,
  sendDraftMessage,
  updateMailboxMessage,
  type GraphConfig,
  type MailboxItem,
} from "@/server/graph-client";
import { graphConfigFor, tenantProblem } from "@/server/microsoft-tenants.server";

type MailboxRow = Database["public"]["Tables"]["email_warmup_mailboxes"]["Row"];
type MailboxUpdate = Database["public"]["Tables"]["email_warmup_mailboxes"]["Update"];
type MessageRow = Database["public"]["Tables"]["email_warmup_messages"]["Row"];
type MessageUpdate = Database["public"]["Tables"]["email_warmup_messages"]["Update"];
type MessageInsert = Database["public"]["Tables"]["email_warmup_messages"]["Insert"];

/** How long a pass may keep STARTING work; the hook's HTTP timeout is 115 s. */
const DEFAULT_BUDGET_MS = 85_000;
/** How long a pass owns the pool. Longer than any pass. */
const LEASE_MS = 150_000;
/** Steps in flight at once — gentle on each mailbox's Graph concurrency limit of four. */
const CONCURRENCY = 3;
/** The most of each kind of step one pass takes on. */
const LIMITS = { prepare: 5, checks: 40, engage: 40, replies: 20, sends: 25 } as const;
/** A reply due longer ago than this (the pool was paused) is dropped rather than sent days late. */
const STALE_REPLY_MS = 24 * 60 * 60_000;
const MINUTE = 60_000;

export type WarmupTickSummary = {
  /** Another pass held the lease; this one did nothing. */
  leased: boolean;
  paused: boolean;
  prepared: number;
  sent: number;
  found: number;
  inJunk: number;
  missing: number;
  engaged: number;
  rescued: number;
  replied: number;
  failed: number;
  notes: string[];
};

function emptySummary(): WarmupTickSummary {
  return {
    leased: false,
    paused: false,
    prepared: 0,
    sent: 0,
    found: 0,
    inJunk: 0,
    missing: 0,
    engaged: 0,
    rescued: 0,
    replied: 0,
    failed: 0,
    notes: [],
  };
}

function describe(error: unknown): string {
  if (error instanceof GraphError) {
    return error.status
      ? `${error.message} (${error.status}${error.code ? ` ${error.code}` : ""})`
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

const isGone = (error: unknown) => error instanceof GraphError && error.status === 404;
const isDenied = (error: unknown) =>
  error instanceof GraphError && (error.status === 401 || error.status === 403);

// ── Tenants ──────────────────────────────────────────────────────────────────

type TenantAccess =
  | { config: GraphConfig; organisationId: string; problem: null }
  | { config: null; organisationId: null; problem: string };

/** A tenant's credentials, proven by taking a token, and the organisation it belongs to. */
async function resolveTenant(tenantId: string | null): Promise<TenantAccess> {
  try {
    const config = await graphConfigFor(tenantId);
    if (!config) {
      return {
        config: null,
        organisationId: null,
        problem: (await tenantProblem(tenantId)) ?? "Microsoft Graph is not configured",
      };
    }
    return { config, organisationId: await organisationOf(config), problem: null };
  } catch (error) {
    return { config: null, organisationId: null, problem: describe(error) };
  }
}

// ── Preparing a mailbox ──────────────────────────────────────────────────────

export type Preparation =
  | { ok: true; folderId: string; organisationId: string }
  | { ok: false; reason: string; transient: boolean };

/**
 * Make a mailbox ready to warm: its tenant's credentials work, its
 * application holds (or may hold) the permissions warmup needs, and the
 * folder warmup mail is filed into exists. Creating that folder is a write,
 * so it is also the proof that this application may change the mailbox — the
 * one thing that cannot be read off the token when Exchange's RBAC for
 * Applications grants access instead of a role.
 */
export async function prepareWarmupMailbox(input: {
  mailbox: string;
  tenantId: string | null;
}): Promise<Preparation> {
  const access = await resolveTenant(input.tenantId);
  if (!access.config) return { ok: false, reason: access.problem, transient: false };

  const capabilities = capabilitiesFrom(await grantedRoles(access.config).catch(() => null));
  // A token that lists roles but not these will be refused; one that lists
  // none may be relying on Exchange RBAC, which the folder write below tests.
  if (capabilities.roles?.length) {
    const missing = [
      capabilities.send === false ? "Mail.Send" : null,
      capabilities.readWrite === false ? "Mail.ReadWrite" : null,
    ].filter(Boolean);
    if (missing.length > 0) {
      return {
        ok: false,
        transient: false,
        reason: `this tenant's application does not hold ${missing.join(" or ")} — warmup sends, files and replies to mail, so it needs both (application permissions, with admin consent)`,
      };
    }
  }

  try {
    const folderId = await ensureMailFolder(input.mailbox, WARMUP_FOLDER_NAME, access.config);
    return { ok: true, folderId, organisationId: access.organisationId };
  } catch (error) {
    if (isDenied(error)) {
      return {
        ok: false,
        transient: false,
        reason: `this application may not change ${input.mailbox} — it needs Mail.ReadWrite and Mail.Send, and no access policy excluding this mailbox (${describe(error)})`,
      };
    }
    if (isGone(error)) {
      return {
        ok: false,
        transient: false,
        reason: `${input.mailbox} has no Exchange Online mailbox in this tenant (${describe(error)})`,
      };
    }
    return { ok: false, transient: true, reason: describe(error) };
  }
}

// ── The pass ─────────────────────────────────────────────────────────────────

type Load = {
  /** Mail sent to each mailbox in the last 24 hours. */
  received: Map<string, number>;
  /** New conversations each mailbox started since its own local midnight. */
  startedToday: Map<string, number>;
  /** Each mailbox's recent partners, oldest first. */
  partners: Map<string, string[]>;
  /** Each mailbox's daily figures over the health window, for its brake. */
  days: Map<string, Partial<WarmupDay>[]>;
};

type Pass = {
  now: () => Date;
  deadline: number;
  random: () => number;
  paused: boolean;
  allowSameOrganisation: boolean;
  /** Every enrolled mailbox not removed, by id. */
  pool: Map<string, MailboxRow>;
  tenant: (tenantId: string | null) => Promise<TenantAccess>;
  load: Load;
  summary: WarmupTickSummary;
};

/**
 * Take the pool for this pass, or learn that another pass has it. Answers the
 * pool settings with the lease token.
 */
async function acquireLease(now: Date): Promise<{
  token: string;
  paused: boolean;
  allowSameOrganisation: boolean;
} | null> {
  const token = crypto.randomUUID();
  const { data, error } = await supabaseAdmin
    .from("email_warmup_settings")
    .update({
      lease_until: new Date(now.getTime() + LEASE_MS).toISOString(),
      lease_token: token,
    })
    .eq("id", true)
    .or(`lease_until.is.null,lease_until.lt."${now.toISOString()}"`)
    .select("paused, allow_same_organisation");
  if (error) throw error;
  const row = (data ?? [])[0] as { paused: boolean; allow_same_organisation: boolean } | undefined;
  return row
    ? {
        token,
        paused: Boolean(row.paused),
        allowSameOrganisation: Boolean(row.allow_same_organisation),
      }
    : null;
}

async function releaseLease(token: string, note: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("email_warmup_settings")
    .update({
      lease_until: null,
      lease_token: null,
      last_tick_at: new Date().toISOString(),
      last_tick_note: note.slice(0, 500),
    })
    .eq("id", true)
    .eq("lease_token", token);
  if (error) console.error("[warmup] could not release the pool lease:", error.message);
}

function noteFor(summary: WarmupTickSummary): string {
  const parts = [
    summary.sent ? `sent ${summary.sent}` : null,
    summary.found
      ? `found ${summary.found}${summary.inJunk ? ` (${summary.inJunk} in junk)` : ""}`
      : null,
    summary.missing ? `${summary.missing} missing` : null,
    summary.engaged ? `engaged with ${summary.engaged}` : null,
    summary.rescued ? `rescued ${summary.rescued} from junk` : null,
    summary.replied ? `replied to ${summary.replied}` : null,
    summary.prepared
      ? `prepared ${summary.prepared} mailbox${summary.prepared === 1 ? "" : "es"}`
      : null,
    summary.failed ? `${summary.failed} failed` : null,
  ].filter(Boolean);
  const head = summary.paused ? "the pool is paused" : null;
  const body = parts.length ? parts.join(", ") : "nothing was due";
  const tail = summary.notes.length ? ` — ${summary.notes.slice(0, 3).join("; ")}` : "";
  return [head, body].filter(Boolean).join("; ") + tail;
}

/** Run `work` over `items`, a few at a time, starting nothing after the deadline. */
async function within<T>(
  items: T[],
  deadline: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      if (Date.now() > deadline) return;
      try {
        await work(item);
      } catch (error) {
        // One message's fault must not stop the pass.
        console.error("[warmup] step failed:", describe(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
}

/**
 * One pass of the warmup engine. `now` and `random` are injectable for tests;
 * the clock advances with real elapsed time, as the dispatcher's does.
 */
export async function runWarmupTick(
  options: { budgetMs?: number; now?: Date; random?: () => number } = {},
): Promise<WarmupTickSummary> {
  const startedAt = Date.now();
  const base = options.now ?? new Date();
  const now = () => new Date(base.getTime() + (Date.now() - startedAt));
  const summary = emptySummary();

  const lease = await acquireLease(now());
  if (!lease) {
    summary.leased = true;
    return summary;
  }

  try {
    const { data: rows, error } = await supabaseAdmin
      .from("email_warmup_mailboxes")
      .select("*")
      .neq("status", "removed");
    if (error) throw error;

    const tenants = new Map<string, Promise<TenantAccess>>();
    const pass: Pass = {
      now,
      deadline: startedAt + (options.budgetMs ?? DEFAULT_BUDGET_MS),
      random: options.random ?? Math.random,
      paused: lease.paused,
      allowSameOrganisation: lease.allowSameOrganisation,
      pool: new Map(((rows ?? []) as MailboxRow[]).map((row) => [row.id, row])),
      tenant: (tenantId) => {
        const key = tenantId ?? "default";
        let access = tenants.get(key);
        if (!access) {
          access = resolveTenant(tenantId);
          tenants.set(key, access);
        }
        return access;
      },
      load: { received: new Map(), startedToday: new Map(), partners: new Map(), days: new Map() },
      summary,
    };
    summary.paused = pass.paused;

    await sweepStaleSends(pass);
    await prepareMailboxes(pass);
    await checkSentMessages(pass);
    await engageLandedMessages(pass);
    if (!pass.paused) await sendReplies(pass);
    if (!pass.paused) await startConversations(pass);
  } finally {
    await releaseLease(lease.token, noteFor(summary));
  }
  return summary;
}

// ── Phase 0: rows a dead pass left as `sending` ──────────────────────────────

async function sweepStaleSends(pass: Pass): Promise<void> {
  const cutoff = new Date(pass.now().getTime() - STALE_SENDING_MINUTES * MINUTE).toISOString();
  const { data, error } = await supabaseAdmin
    .from("email_warmup_messages")
    .select("id, sender_item_id")
    .eq("status", "sending")
    .lt("created_at", cutoff);
  if (error) throw error;
  for (const row of data ?? []) {
    // With a draft on record the send may have gone: let the check find out.
    // Without one, nothing was created.
    const patch: MessageUpdate = row.sender_item_id
      ? {
          status: "sent",
          sent_at: pass.now().toISOString(),
          next_check_at: pass.now().toISOString(),
          error: "the engine stopped part-way through sending this; checking whether it left",
        }
      : { status: "failed", error: "the engine stopped before the message was created" };
    await updateMessage(row.id, patch);
  }
}

// ── Phase 1: mailboxes enrolled but not yet prepared ─────────────────────────

async function prepareMailboxes(pass: Pass): Promise<void> {
  const waiting = [...pass.pool.values()]
    .filter((row) => row.status === "active" && !row.prepared_at)
    .slice(0, LIMITS.prepare);
  await within(waiting, pass.deadline, async (row) => {
    const prepared = await prepareWarmupMailbox({ mailbox: row.mailbox, tenantId: row.tenant_id });
    const at = pass.now().toISOString();
    const patch: MailboxUpdate = prepared.ok
      ? {
          prepared_at: at,
          warmup_folder_id: prepared.folderId,
          organisation_id: prepared.organisationId,
          last_error: null,
          last_error_at: null,
          updated_at: at,
        }
      : prepared.transient
        ? { last_error: prepared.reason, last_error_at: at, updated_at: at }
        : {
            status: "error",
            status_reason: prepared.reason,
            last_error: prepared.reason,
            last_error_at: at,
            updated_at: at,
          };
    await updateMailbox(row.id, patch);
    Object.assign(row, patch);
    if (prepared.ok) pass.summary.prepared += 1;
  });
}

// ── Phase 2: was it sent, and where did it land? ─────────────────────────────

async function checkSentMessages(pass: Pass): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("email_warmup_messages")
    .select("*")
    .eq("status", "sent")
    .lte("next_check_at", pass.now().toISOString())
    .order("next_check_at", { ascending: true })
    .limit(LIMITS.checks);
  if (error) throw error;
  await within((data ?? []) as MessageRow[], pass.deadline, (message) =>
    checkMessage(pass, message),
  );
}

/** Where a message arrived: the inbox, then Junk, then anywhere else in the mailbox. */
async function locate(
  mailbox: string,
  internetMessageId: string,
  config: GraphConfig,
): Promise<{ item: MailboxItem; placement: "inbox" | "junk" | "other" } | null> {
  const inbox = await findMessageByInternetId(mailbox, "inbox", internetMessageId, config);
  if (inbox) return { item: inbox, placement: "inbox" };
  const junk = await findMessageByInternetId(mailbox, "junkemail", internetMessageId, config);
  if (junk) return { item: junk, placement: "junk" };
  const anywhere = await findMessageByInternetId(mailbox, null, internetMessageId, config);
  return anywhere ? { item: anywhere, placement: "other" } : null;
}

const minutesSince = (iso: string | null, now: Date) =>
  iso ? (now.getTime() - Date.parse(iso)) / MINUTE : Number.POSITIVE_INFINITY;

async function checkMessage(pass: Pass, message: MessageRow): Promise<void> {
  const now = pass.now();
  const sender = pass.pool.get(message.sender_id);
  const recipient = pass.pool.get(message.recipient_id);
  const patch: MessageUpdate = {};
  const attempts = message.check_attempts + 1;
  const lookAgain = () =>
    new Date(now.getTime() + checkDelayMinutes(attempts) * MINUTE).toISOString();

  // The recipient's mailbox was searched and the message is not in it. Only
  // this can make a message `missing` — after six hours of looking.
  const notFound = async () => {
    if (minutesSince(message.sent_at, now) >= MISSING_AFTER_MINUTES) {
      await updateMessage(message.id, {
        ...patch,
        status: "missing",
        check_attempts: attempts,
        next_check_at: null,
        error: `never arrived in ${message.recipient_address} — quarantined, rejected or deleted on arrival`,
      });
      pass.summary.missing += 1;
      return;
    }
    await updateMessage(message.id, {
      ...patch,
      check_attempts: attempts,
      next_check_at: lookAgain(),
    });
  };

  // Nobody could look — Microsoft unreachable or throttling, the tenant's
  // credentials refused. That says nothing about whether it arrived, so it is
  // never `missing`: keep looking, and after two days give it up as
  // unchecked, which does not count against anyone's placement.
  const couldNotCheck = async (why: string) => {
    if (minutesSince(message.sent_at, now) >= UNCHECKABLE_AFTER_MINUTES) {
      await updateMessage(message.id, {
        ...patch,
        status: "done",
        check_attempts: attempts,
        next_check_at: null,
        error: `could not be checked: ${why}`,
      });
      return;
    }
    await updateMessage(message.id, {
      ...patch,
      check_attempts: attempts,
      next_check_at: lookAgain(),
      error: why,
    });
  };

  if (!recipient) {
    await updateMessage(message.id, {
      status: "done",
      next_check_at: null,
      error: "the recipient left the warmup pool before this could be checked",
    });
    return;
  }

  // 1. Did it leave? Read the sender's copy back once: still a draft means no.
  // When the copy cannot be read the recipient is still searched — finding
  // the message there proves it left — but not finding it proves nothing.
  let internetMessageId = message.internet_message_id;
  let unconfirmed: string | null = null;
  if (!message.sent_confirmed_at && message.sender_item_id) {
    const access = sender ? await pass.tenant(sender.tenant_id) : null;
    if (!sender || !access?.config) {
      unconfirmed = sender
        ? `could not confirm it was sent: ${access?.problem ?? "no credentials"}`
        : "could not confirm it was sent: the sender left the warmup pool";
    } else {
      try {
        const copy = await getMailboxMessage(sender.mailbox, message.sender_item_id, access.config);
        if (copy?.isDraft) {
          if (minutesSince(message.sent_at, now) >= DRAFT_STUCK_MINUTES) {
            await deleteMailboxMessage(sender.mailbox, message.sender_item_id, access.config).catch(
              () => undefined,
            );
            await updateMessage(message.id, {
              status: "failed",
              next_check_at: null,
              error: "Microsoft never sent it — the draft was still in Drafts",
            });
            pass.summary.failed += 1;
            return;
          }
          await updateMessage(message.id, {
            next_check_at: new Date(now.getTime() + checkDelayMinutes(0) * MINUTE).toISOString(),
          });
          return;
        }
        if (copy?.internetMessageId) internetMessageId = copy.internetMessageId;
        patch.sent_confirmed_at = now.toISOString();
        patch.internet_message_id = internetMessageId;
        // File the sender's own copy too, so warmup does not fill Sent Items.
        if (copy && sender.tidy_sent && sender.warmup_folder_id) {
          try {
            await moveMailboxMessage(
              sender.mailbox,
              copy.id,
              sender.warmup_folder_id,
              access.config,
            );
            patch.sender_filed_at = now.toISOString();
          } catch (error) {
            console.error("[warmup] could not file a sent copy:", describe(error));
          }
        }
      } catch (error) {
        if (isGone(error)) {
          // The sender's copy is gone (deleted by a person); the recipient's
          // copy is still the question, by the Message-ID we already have.
          patch.sent_confirmed_at = now.toISOString();
        } else {
          unconfirmed = `could not read the sent copy: ${describe(error)}`;
        }
      }
    }
  }
  if (!internetMessageId) {
    return couldNotCheck("Microsoft gave this message no Message-ID to look for");
  }

  // 2. Where did it land?
  const access = await pass.tenant(recipient.tenant_id);
  if (!access.config) {
    return couldNotCheck(`could not reach ${recipient.mailbox}: ${access.problem}`);
  }
  let found: Awaited<ReturnType<typeof locate>>;
  try {
    found = await locate(recipient.mailbox, internetMessageId, access.config);
  } catch (error) {
    return couldNotCheck(`could not search ${recipient.mailbox}: ${describe(error)}`);
  }
  if (!found) return unconfirmed ? couldNotCheck(unconfirmed) : notFound();

  const engageIn = minutesBetween(ENGAGE_DELAY_MINUTES.min, ENGAGE_DELAY_MINUTES.max, pass.random);
  await updateMessage(message.id, {
    ...patch,
    status: "landed",
    placement: found.placement,
    focused:
      found.item.inferenceClassification === "focused"
        ? true
        : found.item.inferenceClassification === "other"
          ? false
          : null,
    recipient_item_id: found.item.id,
    landed_at: now.toISOString(),
    engage_at: new Date(now.getTime() + engageIn * MINUTE).toISOString(),
    next_check_at: null,
    check_attempts: attempts,
    error: null,
  });
  pass.summary.found += 1;
  if (found.placement === "junk") pass.summary.inJunk += 1;
}

// ── Phase 3: read it, rescue it, flag it, file it ────────────────────────────

async function engageLandedMessages(pass: Pass): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("email_warmup_messages")
    .select("*")
    .eq("status", "landed")
    .lte("engage_at", pass.now().toISOString())
    .order("engage_at", { ascending: true })
    .limit(LIMITS.engage);
  if (error) throw error;
  await within((data ?? []) as MessageRow[], pass.deadline, (message) =>
    engageMessage(pass, message),
  );
}

/** When a mailbox should answer something it read at `now`: after a pause, inside its window. */
function replyTime(row: MailboxRow, now: Date, random: () => number): Date {
  const schedule = scheduleFromRow(row);
  const rules = warmupRules(schedule);
  const due = new Date(
    now.getTime() +
      minutesBetween(REPLY_DELAY_MINUTES.min, REPLY_DELAY_MINUTES.max, random) * MINUTE,
  );
  if (windowState(rules, due).open) return due;
  const opening = nextWindowOpening(rules, due, 9);
  return opening ? new Date(opening.getTime() + minutesBetween(5, 45, random) * MINUTE) : due;
}

/**
 * A step that failed: try again later, or give up after `MAX_ACTION_ATTEMPTS`
 * — keeping whatever part of the step already happened.
 */
async function actionFailed(
  pass: Pass,
  message: MessageRow,
  patch: MessageUpdate,
  why: string,
  retryField: "engage_at" | "reply_due_at",
): Promise<void> {
  const attempts = message.action_attempts + 1;
  if (attempts >= MAX_ACTION_ATTEMPTS) {
    await updateMessage(message.id, {
      ...patch,
      status: "done",
      action_attempts: attempts,
      error: why,
    });
    return;
  }
  await updateMessage(message.id, {
    ...patch,
    action_attempts: attempts,
    error: why,
    [retryField]: new Date(pass.now().getTime() + 10 * attempts * MINUTE).toISOString(),
  });
}

async function engageMessage(pass: Pass, message: MessageRow): Promise<void> {
  const now = pass.now();
  const recipient = pass.pool.get(message.recipient_id);
  if (!recipient) {
    await updateMessage(message.id, {
      status: "done",
      error: "the recipient left the warmup pool",
    });
    return;
  }
  const access = await pass.tenant(recipient.tenant_id);
  if (!access.config) {
    return actionFailed(
      pass,
      message,
      {},
      `could not reach ${recipient.mailbox}: ${access.problem}`,
      "engage_at",
    );
  }
  const config = access.config;
  const patch: MessageUpdate = {};
  let id = message.recipient_item_id as string;

  try {
    if (message.placement === "junk" && !message.rescued_at) {
      id = await moveMailboxMessage(recipient.mailbox, id, "inbox", config);
      patch.rescued_at = now.toISOString();
      patch.recipient_item_id = id;
      pass.summary.rescued += 1;
    }
    await updateMailboxMessage(
      recipient.mailbox,
      id,
      {
        isRead: true,
        ...(message.will_flag ? { flag: { flagStatus: "flagged" as const } } : {}),
        ...(message.focused === false ? { inferenceClassification: "focused" as const } : {}),
      },
      config,
    );
    if (message.will_flag) patch.flagged_at = now.toISOString();
    if (recipient.warmup_folder_id && !message.filed_at) {
      id = await moveMailboxMessage(recipient.mailbox, id, recipient.warmup_folder_id, config);
      patch.filed_at = now.toISOString();
      patch.recipient_item_id = id;
    }
  } catch (error) {
    if (isGone(error)) {
      await updateMessage(message.id, {
        ...patch,
        status: "done",
        error: `the copy in ${recipient.mailbox} is gone — deleted before it could be read`,
      });
      return;
    }
    return actionFailed(
      pass,
      message,
      patch,
      `could not engage with it in ${recipient.mailbox}: ${describe(error)}`,
      "engage_at",
    );
  }

  const answers =
    message.will_reply && message.depth < MAX_THREAD_DEPTH && recipient.status === "active";
  await updateMessage(message.id, {
    ...patch,
    engaged_at: now.toISOString(),
    status: answers ? "engaged" : "done",
    reply_due_at: answers ? replyTime(recipient, now, pass.random).toISOString() : null,
    action_attempts: 0,
    error: null,
  });
  pass.summary.engaged += 1;
}

// ── Phase 4: answer it ───────────────────────────────────────────────────────

async function sendReplies(pass: Pass): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("email_warmup_messages")
    .select("*")
    .eq("status", "engaged")
    .lte("reply_due_at", pass.now().toISOString())
    .order("reply_due_at", { ascending: true })
    .limit(LIMITS.replies);
  if (error) throw error;
  await within((data ?? []) as MessageRow[], pass.deadline, (message) => replyTo(pass, message));
}

async function replyTo(pass: Pass, message: MessageRow): Promise<void> {
  const now = pass.now();
  const replier = pass.pool.get(message.recipient_id);
  const original = pass.pool.get(message.sender_id);
  const finish = (error: string | null) =>
    updateMessage(message.id, { status: "done", reply_due_at: null, ...(error ? { error } : {}) });

  if (!replier || !original) return finish("the other mailbox left the warmup pool");

  // Never answer twice. A reply already on record settles it — including one
  // a pass sent and then died before it could mark this message answered.
  // One still `sending` is a pass in flight or a dead one; the stale sweep
  // settles that row first, so this waits.
  const { data: earlier, error: earlierError } = await supabaseAdmin
    .from("email_warmup_messages")
    .select("id, status, created_at")
    .eq("parent_id", message.id)
    .neq("status", "failed");
  if (earlierError) throw earlierError;
  if ((earlier ?? []).length > 0) {
    if ((earlier ?? []).some((row) => row.status === "sending")) {
      await updateMessage(message.id, {
        reply_due_at: new Date(now.getTime() + STALE_SENDING_MINUTES * MINUTE).toISOString(),
      });
      return;
    }
    const first = [...(earlier ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    await updateMessage(message.id, {
      status: "done",
      reply_due_at: null,
      replied_at: first.created_at,
      action_attempts: 0,
      error: null,
    });
    return;
  }
  if (replier.status !== "active") return finish(`${replier.mailbox} was paused before it replied`);
  if (message.reply_due_at && now.getTime() - Date.parse(message.reply_due_at) > STALE_REPLY_MS) {
    return finish("the reply was due more than a day ago, so it was not sent late");
  }
  const rules = warmupRules(scheduleFromRow(replier));
  if (!windowState(rules, now).open) {
    const opening = nextWindowOpening(rules, now, 9);
    await updateMessage(message.id, {
      reply_due_at: (opening
        ? new Date(opening.getTime() + minutesBetween(5, 45, pass.random) * MINUTE)
        : new Date(now.getTime() + 60 * MINUTE)
      ).toISOString(),
    });
    return;
  }

  const access = await pass.tenant(replier.tenant_id);
  if (!access.config) {
    return actionFailed(
      pass,
      message,
      {},
      `could not reach ${replier.mailbox}: ${access.problem}`,
      "reply_due_at",
    );
  }
  const config = access.config;

  let draft: Awaited<ReturnType<typeof createReplyDraft>>;
  const childId = crypto.randomUUID();
  try {
    draft = await createReplyDraft(replier.mailbox, message.recipient_item_id as string, config);
    const reply = composeWarmupReply({
      seed: childId,
      senderName: firstNameFor(replier.display_name, replier.mailbox),
      recipientName: firstNameFor(original.display_name, original.mailbox),
      depth: message.depth + 1,
    });
    await updateMailboxMessage(
      replier.mailbox,
      draft.id,
      { body: { contentType: "HTML", content: prependToReplyBody(reply.html, draft.bodyHtml) } },
      config,
    );
  } catch (error) {
    if (isGone(error)) return finish(`the message to reply to is gone from ${replier.mailbox}`);
    return actionFailed(
      pass,
      message,
      {},
      `could not write the reply in ${replier.mailbox}: ${describe(error)}`,
      "reply_due_at",
    );
  }

  // What the ORIGINAL sender will do with the reply, by its own rates.
  const plan = engagementPlan({
    replyRate: original.reply_rate,
    importantRate: original.important_rate,
    depth: message.depth + 1,
    random: pass.random,
  });
  const child: MessageInsert = {
    id: childId,
    thread_id: message.thread_id,
    parent_id: message.id,
    depth: message.depth + 1,
    sender_id: replier.id,
    recipient_id: original.id,
    sender_address: replier.mailbox,
    recipient_address: original.mailbox,
    subject: (draft.subject ?? `RE: ${message.subject}`).slice(0, 300),
    status: "sending",
    sender_item_id: draft.id,
    internet_message_id: draft.internetMessageId,
    will_reply: plan.willReply,
    will_flag: plan.willFlag,
    created_at: now.toISOString(),
  };
  const { error: insertError } = await supabaseAdmin.from("email_warmup_messages").insert(child);
  if (insertError) {
    await deleteMailboxMessage(replier.mailbox, draft.id, config).catch(() => undefined);
    throw insertError;
  }

  const outcome = await sendDraftMessage(replier.mailbox, draft.id, config);
  if (outcome.kind === "sent" || outcome.kind === "unconfirmed") {
    await updateMessage(childId, {
      status: "sent",
      sent_at: now.toISOString(),
      next_check_at: new Date(now.getTime() + checkDelayMinutes(0) * MINUTE).toISOString(),
      ...(outcome.kind === "unconfirmed"
        ? { error: `the send was not confirmed: ${outcome.message}` }
        : {}),
    });
    await updateMessage(message.id, {
      status: "done",
      replied_at: now.toISOString(),
      action_attempts: 0,
      error: null,
    });
    pass.summary.replied += 1;
    return;
  }
  await deleteMailboxMessage(replier.mailbox, draft.id, config).catch(() => undefined);
  const why =
    outcome.kind === "throttled"
      ? "Microsoft is throttling this mailbox"
      : `Microsoft refused the reply: ${outcome.message}`;
  await updateMessage(childId, { status: "failed", error: why });
  pass.summary.failed += 1;
  return actionFailed(pass, message, {}, why, "reply_due_at");
}

// ── Phase 5: start new conversations ─────────────────────────────────────────

/**
 * Who has received and sent what recently — read once per pass from the last
 * 26 hours of the log, which covers "since local midnight" in every zone.
 */
async function readLoad(pass: Pass): Promise<void> {
  const now = pass.now();
  const since = new Date(now.getTime() - 26 * 60 * MINUTE).toISOString();
  const dayAgo = now.getTime() - 24 * 60 * MINUTE;
  const midnights = new Map<string, number>();
  for (const row of pass.pool.values()) {
    midnights.set(row.id, startOfZonedDay(now, scheduleFromRow(row).timezone).getTime());
  }

  const PAGE = 1000;
  for (let page = 0; page < 20; page++) {
    const { data, error } = await supabaseAdmin
      .from("email_warmup_messages")
      .select("sender_id, recipient_id, depth, status, sent_at")
      .gte("sent_at", since)
      .order("sent_at", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.status === "failed" || !row.sent_at) continue;
      const at = Date.parse(row.sent_at);
      if (at >= dayAgo) {
        pass.load.received.set(
          row.recipient_id,
          (pass.load.received.get(row.recipient_id) ?? 0) + 1,
        );
      }
      if (row.depth === 0) {
        if (at >= (midnights.get(row.sender_id) ?? Number.POSITIVE_INFINITY)) {
          pass.load.startedToday.set(
            row.sender_id,
            (pass.load.startedToday.get(row.sender_id) ?? 0) + 1,
          );
        }
        const partners = pass.load.partners.get(row.sender_id) ?? [];
        partners.push(row.recipient_id);
        pass.load.partners.set(row.sender_id, partners.slice(-5));
      }
    }
    if ((data ?? []).length < PAGE) break;
  }
}

/**
 * Every pool mailbox's daily figures over the health window — where its mail
 * has been landing, and what has gone missing — for the brake on its ramp.
 * A day either side covers every mailbox's zone.
 */
async function readPlacement(pass: Pass): Promise<void> {
  const ids = [...pass.pool.keys()];
  if (ids.length === 0) return;
  const from = daysBefore(pass.now().toISOString().slice(0, 10), HEALTH_WINDOW_DAYS + 1);
  const { data, error } = await supabaseAdmin
    .from("email_warmup_daily")
    .select("mailbox_id, day, inbox, junk, other, missing")
    .in("mailbox_id", ids)
    .gte("day", from);
  if (error) throw error;
  for (const row of data ?? []) {
    if (!row.mailbox_id) continue;
    const list = pass.load.days.get(row.mailbox_id) ?? [];
    list.push(row as Partial<WarmupDay>);
    pass.load.days.set(row.mailbox_id, list);
  }
}

/**
 * Today's ramp for a mailbox, in its own zone: what the ramp planned, and
 * what the brake lets it send given how its mail has been landing.
 */
function gateToday(pass: Pass, row: MailboxRow, now: Date): RampGate {
  const schedule = scheduleFromRow(row);
  const today = localDate(now, schedule.timezone);
  return rampGate({
    schedule,
    day: rampDay({ activeDays: row.active_days, lastActiveOn: row.last_active_on, today }),
    evidence: rampEvidence(pass.load.days.get(row.id) ?? [], today),
  });
}

async function startConversations(pass: Pass): Promise<void> {
  const now = pass.now();
  const due = [...pass.pool.values()]
    .filter(
      (row) =>
        row.status === "active" &&
        row.prepared_at &&
        (!row.next_send_at || Date.parse(row.next_send_at) <= now.getTime()),
    )
    .sort(
      (a, b) =>
        Date.parse(a.next_send_at ?? "1970-01-01") - Date.parse(b.next_send_at ?? "1970-01-01"),
    )
    .slice(0, LIMITS.sends);
  if (due.length === 0) return;

  await readLoad(pass);
  await readPlacement(pass);
  // The pool as partners see it: who is eligible to receive, and how loaded.
  const members: PoolMember[] = [];
  for (const row of pass.pool.values()) {
    const access = await pass.tenant(row.tenant_id);
    members.push({
      id: row.id,
      address: row.mailbox,
      organisationId: access.organisationId ?? row.organisation_id ?? `unknown:${row.id}`,
      eligible: row.status === "active" && Boolean(row.prepared_at) && access.config !== null,
      receivedRecent: pass.load.received.get(row.id) ?? 0,
      // From the planned volume, not the braked one: a held mailbox still
      // reads, rescues and answers its share, and its partners still need
      // somewhere to write to.
      receiveCap: receiveCap(gateToday(pass, row, now).planned),
    });
  }

  // Sequential on purpose: each choice changes the load the next one reads.
  for (const row of due) {
    if (Date.now() > pass.deadline) break;
    try {
      await startConversation(pass, row, members);
    } catch (error) {
      console.error(`[warmup] ${row.mailbox} could not send:`, describe(error));
      pass.summary.notes.push(`${row.mailbox}: ${describe(error)}`);
    }
  }
}

async function startConversation(
  pass: Pass,
  row: MailboxRow,
  members: PoolMember[],
): Promise<void> {
  const now = pass.now();
  const schedule = scheduleFromRow(row);
  const today = localDate(now, schedule.timezone);
  const gate = gateToday(pass, row, now);
  const target = gate.target;
  const startedToday = pass.load.startedToday.get(row.id) ?? 0;
  const later = (sentToday: number) =>
    nextSendAt({ schedule, now, sentToday, target, random: pass.random })?.toISOString() ?? null;

  if (startedToday >= target || !windowState(warmupRules(schedule), now).open) {
    await updateMailbox(row.id, { next_send_at: later(startedToday) });
    return;
  }

  const access = await pass.tenant(row.tenant_id);
  if (!access.config) {
    await updateMailbox(row.id, {
      next_send_at: new Date(now.getTime() + 15 * MINUTE).toISOString(),
      last_error: access.problem,
      last_error_at: now.toISOString(),
    });
    pass.summary.notes.push(`${row.mailbox}: ${access.problem}`);
    return;
  }

  const choice = choosePartner({
    senderId: row.id,
    senderOrganisationId: access.organisationId,
    members,
    recentPartnerIds: pass.load.partners.get(row.id) ?? [],
    allowSameOrganisation: pass.allowSameOrganisation,
    random: pass.random,
  });
  if (!choice.partner) {
    await updateMailbox(row.id, {
      next_send_at: new Date(
        now.getTime() + minutesBetween(30, 60, pass.random) * MINUTE,
      ).toISOString(),
      last_error: `waiting: ${choice.reason}`,
      last_error_at: now.toISOString(),
    });
    pass.summary.notes.push(`${row.mailbox}: ${choice.reason}`);
    return;
  }
  const partner = pass.pool.get(choice.partner.id) as MailboxRow;
  // Reserved now, so the next sender this pass sees it.
  choice.partner.receivedRecent += 1;

  const id = crypto.randomUUID();
  const local = zonedParts(now, schedule.timezone);
  const content = composeWarmupMessage({
    seed: id,
    senderName: firstNameFor(row.display_name, row.mailbox),
    recipientName: firstNameFor(partner.display_name, partner.mailbox),
    localHour: local.hour,
  });
  // What the RECIPIENT will do with it, by its own rates.
  const plan = engagementPlan({
    replyRate: partner.reply_rate,
    importantRate: partner.important_rate,
    depth: 0,
    random: pass.random,
  });
  const { error: insertError } = await supabaseAdmin.from("email_warmup_messages").insert({
    id,
    thread_id: id,
    depth: 0,
    sender_id: row.id,
    recipient_id: partner.id,
    sender_address: row.mailbox,
    recipient_address: partner.mailbox,
    subject: content.subject.slice(0, 300),
    status: "sending",
    will_reply: plan.willReply,
    will_flag: plan.willFlag,
    created_at: now.toISOString(),
  });
  if (insertError) throw insertError;

  let draft: { id: string; internetMessageId: string | null };
  try {
    draft = await createDraftMessage(
      row.mailbox,
      {
        subject: content.subject,
        body: { contentType: "HTML", content: content.html },
        toRecipients: [
          {
            emailAddress: {
              address: partner.mailbox,
              ...(partner.display_name ? { name: partner.display_name } : {}),
            },
          },
        ],
      },
      access.config,
    );
  } catch (error) {
    await updateMessage(id, {
      status: "failed",
      error: `could not create the message: ${describe(error)}`,
    });
    pass.summary.failed += 1;
    await sendFailed(pass, row, describe(error), !isDenied(error) && !isGone(error));
    return;
  }
  await updateMessage(id, {
    sender_item_id: draft.id,
    internet_message_id: draft.internetMessageId,
  });

  const outcome = await sendDraftMessage(row.mailbox, draft.id, access.config);
  if (outcome.kind === "sent" || outcome.kind === "unconfirmed") {
    await updateMessage(id, {
      status: "sent",
      sent_at: now.toISOString(),
      next_check_at: new Date(now.getTime() + checkDelayMinutes(0) * MINUTE).toISOString(),
      ...(outcome.kind === "unconfirmed"
        ? { error: `the send was not confirmed: ${outcome.message}` }
        : {}),
    });
    pass.load.startedToday.set(row.id, startedToday + 1);
    pass.load.partners.set(
      row.id,
      [...(pass.load.partners.get(row.id) ?? []), partner.id].slice(-5),
    );
    // A day of ramp is earned only by a day the brake let it climb.
    const newDay = row.last_active_on !== today && gate.advances;
    await updateMailbox(row.id, {
      next_send_at: later(startedToday + 1),
      consecutive_failures: 0,
      last_error: null,
      last_error_at: null,
      ...(newDay ? { active_days: row.active_days + 1, last_active_on: today } : {}),
    });
    if (newDay) {
      row.active_days += 1;
      row.last_active_on = today;
    }
    pass.summary.sent += 1;
    return;
  }

  await deleteMailboxMessage(row.mailbox, draft.id, access.config).catch(() => undefined);
  if (outcome.kind === "throttled") {
    await updateMessage(id, {
      status: "failed",
      error: "Microsoft is throttling this mailbox; not sent",
    });
    await updateMailbox(row.id, {
      next_send_at: new Date(
        now.getTime() + Math.max(outcome.retryAfterMs, 10 * MINUTE),
      ).toISOString(),
    });
    pass.summary.failed += 1;
    return;
  }
  await updateMessage(id, { status: "failed", error: `Microsoft refused it: ${outcome.message}` });
  pass.summary.failed += 1;
  await sendFailed(pass, row, outcome.message, outcome.status === 429 || outcome.status >= 500);
}

/**
 * A send that did not happen. Transient faults wait a while; anything else
 * counts towards `FAILURES_BEFORE_ERROR`, after which the mailbox is put into
 * `error` with the reason, for a person to look at.
 */
async function sendFailed(
  pass: Pass,
  row: MailboxRow,
  why: string,
  transient: boolean,
): Promise<void> {
  const now = pass.now();
  const failures = transient ? row.consecutive_failures : row.consecutive_failures + 1;
  const stop = failures >= FAILURES_BEFORE_ERROR;
  await updateMailbox(row.id, {
    consecutive_failures: failures,
    last_error: why.slice(0, 500),
    last_error_at: now.toISOString(),
    next_send_at: new Date(now.getTime() + (transient ? 15 : 30) * MINUTE).toISOString(),
    ...(stop
      ? {
          status: "error",
          status_reason:
            `stopped after ${failures} sends in a row were refused — the last said: ${why}`.slice(
              0,
              1000,
            ),
        }
      : {}),
  });
  row.consecutive_failures = failures;
  if (stop) row.status = "error";
  pass.summary.notes.push(`${row.mailbox}: ${why}`);
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function updateMessage(id: string, patch: MessageUpdate): Promise<void> {
  const { error } = await supabaseAdmin.from("email_warmup_messages").update(patch).eq("id", id);
  if (error) throw error;
}

async function updateMailbox(id: string, patch: MailboxUpdate): Promise<void> {
  const { error } = await supabaseAdmin
    .from("email_warmup_mailboxes")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/**
 * When a mailbox that is (re)starting should first send: a few minutes from
 * now inside its window, or a little after it next opens. Used on enrolment
 * and on resume.
 */
export function firstSendAt(
  row: WarmupScheduleColumns,
  now: Date,
  random = Math.random,
): Date | null {
  const schedule = scheduleFromRow(row);
  const rules = warmupRules(schedule);
  if (windowState(rules, now).open) {
    return new Date(now.getTime() + minutesBetween(2, 15, random) * MINUTE);
  }
  return (
    nextSendAt({ schedule, now, sentToday: 0, target: 1, random }) ??
    startOfNextLocalDay(now, schedule.timezone)
  );
}
