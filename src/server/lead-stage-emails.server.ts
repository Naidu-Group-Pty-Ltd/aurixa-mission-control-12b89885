// The priority-access stage mailer: raising obligations, and discharging them.
//
// Two halves, deliberately separate:
//
//   `enqueueStageEmails`   decides what is OWED and writes ledger rows. Never
//                          sends. Safe to call from the ingest endpoint, the
//                          Airtable sync and a backfill alike.
//   `dispatchStageEmails`  claims due rows and puts them on the wire. The only
//                          thing in this codebase that sends a lead email.
//
// The split is what makes the feature safe to switch on. Enqueuing is
// idempotent by a unique index, so the three callers racing produce one
// obligation; sending is a state transition on that one row, so the obligation
// is discharged once however many dispatchers are running.
//
// Read `supabase/migrations/20260922120000_lead_stage_email_ledger.sql` for why
// the ledger is a table and not a flag, and `leadStageEmailPolicy.pure.ts` for
// why the applicant's own acknowledgement defaults to a backstop rather than an
// unconditional send.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { emailKey } from "@/lib/email/emailAddress.pure";
import {
  defaultMailbox,
  isGraphConfigured,
  sendMail,
  type GraphMessage,
} from "@/server/graph-client";
import { notifyOperators } from "@/server/audit.server";
import { composeStageEmail, type StageEmailLead } from "@/server/leadStageEmail.pure";
import {
  decideApplicant,
  decideInternal,
  nextStepUrlFor,
  readPolicy,
  type ApplicantMode,
  type DroppedRecipient,
  type LeadStage,
  type RecipientSource,
  type StageAudience,
  type StageEmailPolicy,
} from "@/server/leadStageEmailPolicy.pure";

type LedgerInsert = Database["public"]["Tables"]["lead_stage_emails"]["Insert"];
type LedgerUpdate = Database["public"]["Tables"]["lead_stage_emails"]["Update"];

const STAGES: LeadStage[] = [1, 2, 3];
const AUDIENCES: StageAudience[] = ["internal", "applicant"];

/** One tick's ceiling. Small: a stage email is not a campaign. */
const DISPATCH_BATCH = 15;

function policy(): StageEmailPolicy {
  return readPolicy(process.env as Record<string, string | undefined>);
}

export type EnqueueResult = {
  queued: number;
  skipped: number;
  /** Obligations that already existed. Not an error — it is the rule working. */
  existing: number;
};

export type EnqueueInput = {
  leadId: string;
  /** The lead row as it now stands. Read-only here. */
  lead: Record<string, unknown>;
  /** Which path noticed. Recorded so a gap in one delivery path is visible. */
  trigger: "ingest" | "airtable_sync" | "manual";
};

/**
 * Records every stage email this applicant is owed and does not yet have.
 *
 * Called after a stage lands, from whichever path noticed first. It writes
 * rows and nothing else — no send, no network — so a caller may run it inside a
 * webhook handler without making the applicant wait on a mailbox.
 *
 * A `skip` verdict still WRITES a row, terminal, with its reason. That is the
 * difference between "we decided not to email this applicant, here is why" and
 * silence, and it is what lets the console answer the question this feature
 * exists for: was this person told?
 */
export async function enqueueStageEmails(input: EnqueueInput): Promise<EnqueueResult> {
  const out: EnqueueResult = { queued: 0, skipped: 0, existing: 0 };
  const p = policy();
  const now = Date.now();
  const lead = input.lead as StageEmailLead & Record<string, unknown>;

  const rows: LedgerInsert[] = [];
  for (const stage of STAGES) {
    for (const audience of AUDIENCES) {
      const decision =
        audience === "internal"
          ? decideInternal(lead, stage, p, now)
          : decideApplicant(lead, stage, p, now);

      // `none` means no obligation ever existed — a stage not reached, an
      // event outside the window. Writing a row for it would fill the ledger
      // with obligations nobody has, and make "skipped" mean two things.
      if (decision.verdict === "none") continue;

      const recipients =
        audience === "internal" ? p.internalRecipients : [String(lead.email ?? "")].filter(Boolean);

      // The resolution travels with the obligation. `mailbox_fallback` on an
      // internal row is the reading that means fewer people were told than
      // whoever set this up believes — it must survive to the sent row rather
      // than being recomputed later against an environment that has changed.
      const recipientSource = audience === "internal" ? p.internalRecipientSource : "applicant";
      const droppedNote =
        audience === "internal" && p.internalRecipientsDropped.length
          ? p.internalRecipientsDropped.map((d) => `${d.value} (${d.reason})`).join(", ")
          : null;
      const note = [
        recipientSource === "mailbox_fallback"
          ? "no LEAD_STAGE_INTERNAL_RECIPIENTS set — only the sending mailbox was told"
          : null,
        droppedNote ? `dropped from the recipient list: ${droppedNote}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      rows.push({
        lead_id: input.leadId,
        stage,
        audience,
        status: decision.verdict === "send" ? "pending" : "skipped",
        reason: decision.verdict === "skip" ? decision.reason : note || null,
        to_address: recipients[0] ?? null,
        recipients,
        recipient_source: recipientSource === "none" ? null : recipientSource,
        mailbox: p.mailbox,
      });
      if (decision.verdict === "send") out.queued += 1;
      else out.skipped += 1;
    }
  }

  if (rows.length === 0) return out;

  // `ignoreDuplicates` makes the unique index the arbiter: an obligation that
  // already exists keeps whatever state it reached, including `sent`. Nothing
  // here may resurrect a discharged obligation — that is the one write that
  // could produce a duplicate email.
  const { data, error } = await supabaseAdmin
    .from("lead_stage_emails")
    .upsert(rows, { onConflict: "lead_id,stage,audience", ignoreDuplicates: true })
    .select("id, status");

  if (error) {
    console.error("[lead-stage-email] could not record obligations", error.message);
    throw error;
  }

  const inserted = data ?? [];
  const insertedPending = inserted.filter((row) => row.status === "pending").length;
  out.existing = rows.length - inserted.length;
  // Report what this call actually created, not what it proposed: a caller
  // logging "queued 3" for three rows that already existed is how a duplicate
  // delivery gets diagnosed as a missing one.
  out.queued = insertedPending;
  out.skipped = inserted.length - insertedPending;
  return out;
}

export type DispatchResult = {
  claimed: number;
  sent: number;
  failed: number;
  unconfirmed: number;
  suppressed: number;
  skipped: number;
  note?: string;
  /** What this deployment is actually configured to do. See `readiness()`. */
  readiness: DispatchReadiness;
};

/**
 * The three facts that decide whether this mailer can do its job, answered in
 * the one call that already proves the tick is running.
 *
 * Every one of them lives on the DEPLOYMENT rather than in this repository, so
 * no test here can see any of them: whether Microsoft Graph is configured,
 * which mailbox it sends from, and who the team notification reaches. The
 * third is the one the cutover turns on — an unset recipient list resolves to
 * the sending mailbox and quietly tells one person, which looks identical, in
 * every ledger row and on every screen, to telling five.
 *
 * It is reported here because the schedule this hangs off is allowed to fail
 * silently: `20260922130000` wraps its `cron.schedule` in
 * `EXCEPTION WHEN OTHERS THEN RAISE WARNING`, so a deployment without pg_cron
 * records the migration as applied while no job exists. A tick that answers
 * with its own readiness is a single assertion BY EFFECT — the tick ran, and
 * here is what it would have done — in place of three separate readings of
 * configuration, none of which prove anything ran.
 *
 * It names no address: `recipients` is a COUNT. An operator who needs the list
 * has the environment; a response body does not need to carry five mailboxes.
 */
export type DispatchReadiness = {
  graph: boolean;
  mailbox: boolean;
  recipients: number;
  recipientSource: RecipientSource;
  /** Entries the recipient list carried that are not addresses, and why. */
  droppedRecipients: DroppedRecipient[];
  internalStages: LeadStage[];
  applicantMode: ApplicantMode;
};

/**
 * One tick of the mailer. Claims due obligations and sends them.
 *
 * Never throws for a send failure: each outcome is recorded on its own row, so
 * one refused address cannot cost the rest of the batch. It throws only for a
 * claim that the database refused, which is a fault worth surfacing to the
 * caller rather than reporting as "nothing to do".
 */
export async function dispatchStageEmails(limit = DISPATCH_BATCH): Promise<DispatchResult> {
  const p = policy();
  const graph = isGraphConfigured();
  const mailbox = p.mailbox ?? defaultMailbox();

  const out: DispatchResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    unconfirmed: 0,
    suppressed: 0,
    skipped: 0,
    readiness: {
      graph,
      mailbox: Boolean(mailbox),
      recipients: p.internalRecipients.length,
      recipientSource: p.internalRecipientSource,
      droppedRecipients: p.internalRecipientsDropped,
      internalStages: [...p.internalStages].sort(),
      applicantMode: p.applicantMode,
    },
  };

  if (!graph) {
    out.note = "Microsoft Graph is not configured on this deployment";
    return out;
  }
  if (!mailbox) {
    out.note = "no sending mailbox is configured";
    return out;
  }

  const { data: claimed, error } = await supabaseAdmin.rpc("claim_lead_stage_emails", {
    _limit: limit,
  });
  if (error) throw error;

  const batch = (claimed ?? []) as ClaimedRow[];
  out.claimed = batch.length;
  if (batch.length === 0) return out;

  // One read of the lead rows for the whole batch: a stage email is composed
  // from the applicant as they now stand, not as they were when the obligation
  // was raised, so a questionnaire that arrived in between is in the email.
  const leadIds = [...new Set(batch.map((row) => row.lead_id))];
  const { data: leadRows } = await supabaseAdmin
    .from("waitlist_leads")
    .select("*")
    .in("id", leadIds);
  const leads = new Map((leadRows ?? []).map((row) => [row.id as string, row]));

  // Resolve every row's recipients BEFORE the register is asked, because the
  // register must be asked about the addresses that will actually be SENT to.
  //
  // This was wrong and it was wrong in the direction that matters. The
  // re-resolution below can ADD addresses the row was never raised with — that
  // is its whole purpose — and `readSuppressions` used to build its query from
  // `row.recipients`, the stored list. So on precisely the cutover sequence
  // this feature exists for (rows raised under the fallback, the list set
  // afterwards), five people were mailed while the register was asked about
  // one, and a colleague on the do-not-send register received the mail with
  // nothing blocked, nothing notified and nothing in the ledger reason.
  //
  // Ask about what you are going to send to.
  const resolved = new Map<string, ResolvedRecipients>();
  for (const row of batch) resolved.set(row.id, resolveRecipientsFor(row, p));

  const register = await readSuppressions([...resolved.values()].flatMap((r) => r.recipients));
  const suppressed = register.keys;
  if (!register.readable) {
    // A notifier that cannot verify its own do-not-send register is an outage,
    // not a quiet skip \u2014 and this is the one fault in the path that leaves
    // every obligation in the batch undelivered at once.
    await notifyOperators({
      kind: "lead_stage_email_failed",
      severity: "warning",
      title: "Lead stage emails held: the do-not-send register could not be read",
      body: `${batch.length} obligation(s) were returned to pending rather than sent. Nobody is being emailed until the register answers.`,
      url: "/leads",
      metadata: { claimed: batch.length },
    });
  }

  for (const row of batch) {
    const lead = leads.get(row.lead_id);
    if (!lead) {
      await settle(row.id, {
        status: "failed",
        reason: "the lead this obligation belongs to no longer exists",
      });
      out.failed += 1;
      continue;
    }

    const { recipients, rewritten, resolvedSource } = resolved.get(row.id)!;

    if (recipients.length === 0) {
      await settle(row.id, { status: "skipped", reason: "no recipient address" });
      out.skipped += 1;
      continue;
    }

    // The register is re-read between the claim and the send, because an
    // unsubscribe or a bounce can land in between. An applicant who has asked
    // not to hear from us is never mailed by a backstop.
    const blocked = recipients.filter((address) => suppressed.has(emailKey(address) ?? address));
    const sendable = recipients.filter((address) => !blocked.includes(address));

    if (!register.readable) {
      // Held, not refused. The register could not be read, so we do not know
      // whether anybody is on it \u2014 and "we could not look" is not "everybody
      // is on it". Back to pending, where the next tick tries again.
      await settle(row.id, {
        status: "pending",
        claimed_at: null,
        last_error: "the do-not-send register could not be read \u2014 held rather than sent",
      });
      out.skipped += 1;
      continue;
    }

    if (sendable.length === 0) {
      await settle(row.id, {
        status: "suppressed",
        reason: "every recipient is on the do-not-send register",
      });
      out.suppressed += 1;
      continue;
    }

    const stage = clampStage(row.stage);
    const composed = composeStageEmail({
      lead: lead as StageEmailLead,
      stage,
      audience: row.audience,
      consoleUrl: p.consoleUrl,
      nextStepUrl: nextStepUrlFor(stage, p),
    });

    const message: GraphMessage = {
      subject: composed.subject,
      body: { contentType: "HTML", content: composed.html },
      toRecipients: sendable.map((address) => ({ emailAddress: { address } })),
      // An internal email answers to the applicant: hitting reply on "new
      // application" should reach the person who applied, which is the act the
      // email exists to prompt.
      ...(row.audience === "internal" && lead.email
        ? { replyTo: [{ emailAddress: { address: String(lead.email) } }] }
        : {}),
    };

    const outcome = await sendMail(mailbox, message);
    const sentAt = new Date().toISOString();

    if (outcome.kind === "sent") {
      await settle(row.id, {
        status: "sent",
        sent_at: sentAt,
        subject: composed.subject,
        mailbox,
        to_address: sendable[0],
        // The row answers one question — was this person told? — so a settled
        // row describes the send that happened rather than the one that was
        // raised. Without this the ledger keeps the list the obligation was
        // raised with, and the Leads page draws "sending mailbox only" over a
        // send that reached five people: the very defect the re-resolution
        // above exists to fix, surviving one layer up.
        recipients: sendable,
        recipient_source: resolvedSource,
        graph_status: outcome.status,
        graph_request_id: outcome.requestId,
        // The row already carries how its recipient list was resolved. A
        // successful send must not erase that: "sent" and "sent to one person
        // because nobody configured the list" are different facts.
        reason:
          [
            row.reason,
            rewritten,
            blocked.length ? `${blocked.length} recipient(s) suppressed` : null,
          ]
            .filter(Boolean)
            .join(" · ") || null,
      });
      out.sent += 1;
      // An INTERNAL recipient on the do-not-send register is anomalous: it is
      // a colleague, not a subscriber, and nobody unsubscribes themselves from
      // their own lead alerts. Once this is the sole notifier, the failure it
      // produces is that one person silently stops being told, for ever, while
      // every ledger row reads `sent`. Applicant suppression is the register
      // working as intended and raises nothing.
      if (row.audience === "internal" && blocked.length) {
        await notifyOperators({
          kind: "lead_stage_email_failed",
          severity: "warning",
          title: `A team recipient is on the do-not-send register`,
          body: `Stage ${row.stage} went to ${sendable.length} of ${recipients.length} recipients. Suppressed: ${blocked.join(", ")}. They will not receive lead alerts until the register entry is removed.`,
          url: "/leads",
          metadata: {
            lead_id: row.lead_id,
            stage: row.stage,
            suppressed: blocked,
            delivered: sendable.length,
          },
        });
      }
      continue;
    }

    if (outcome.kind === "throttled") {
      // A refusal to START is safe to try again: the row goes back to pending
      // rather than to a terminal state, and the next tick picks it up.
      await settle(row.id, {
        status: "pending",
        claimed_at: null,
        last_error: "Graph throttled the send",
        subject: composed.subject,
      });
      out.failed += 1;
      continue;
    }

    if (outcome.kind === "unconfirmed") {
      await settle(row.id, {
        status: "unconfirmed",
        subject: composed.subject,
        mailbox,
        last_error: outcome.message,
      });
      out.unconfirmed += 1;
      await raiseFailureNotice(row, lead, `delivery unconfirmed: ${outcome.message}`);
      continue;
    }

    await settle(row.id, {
      status: "failed",
      subject: composed.subject,
      mailbox,
      graph_status: outcome.status,
      last_error: outcome.message,
    });
    out.failed += 1;
    await raiseFailureNotice(row, lead, outcome.message);
  }

  return out;
}

type ClaimedRow = {
  id: string;
  lead_id: string;
  stage: number;
  audience: StageAudience;
  recipients: string[] | null;
  /** How that list was resolved when the obligation was raised. */
  recipient_source: RecipientSource | null;
  /** The note the obligation was raised with — preserved, never overwritten. */
  reason: string | null;
  attempts: number;
};

type ResolvedRecipients = {
  recipients: string[];
  resolvedSource: RecipientSource;
  /** A note for the ledger when the deployment disagreed with the row. */
  rewritten: string | null;
};

/**
 * Who this obligation is actually going to, decided now rather than when it
 * was raised.
 *
 * WHO an internal notification goes to is a property of the deployment as it
 * now stands — the same reasoning that composes the body from the current
 * lead row. The ledger upserts with `ignoreDuplicates`, so a row raised while
 * `LEAD_STAGE_INTERNAL_RECIPIENTS` was unset keeps `["<the sending mailbox>"]`
 * for ever and `UNIQUE (lead_id, stage, audience)` means it can never be
 * raised again. Reading `row.recipients` at send time meant the ordinary
 * cutover sequence — deploy, notice the list is not set, set it — left every
 * already-queued lead notifying one address, permanently, with the console
 * showing a healthy `sent` row.
 *
 * In this order, and the middle rung is the one worth stating:
 *
 *   1. the list this deployment has CONFIGURED — it is the live answer
 *   2. else the list the row was raised with — it knew something
 *   3. else the deployment's fallback — better one person than nobody
 *
 * A `mailbox_fallback` is not an answer about who should be told, it is an
 * admission that nobody is configured, so it never overrules a row that
 * already names real recipients — that would be the same silent collapse from
 * five addresses to one, arrived at from the other direction.
 *
 * The applicant's own address is NOT this: it is a fact about the lead, it was
 * resolved from the lead row, and it stays on the row.
 *
 * It is a separate function because the SUPPRESSION REGISTER has to be asked
 * about these addresses rather than the stored ones, which means they must be
 * known before the send loop begins.
 */
function resolveRecipientsFor(row: ClaimedRow, p: StageEmailPolicy): ResolvedRecipients {
  const stored = (row.recipients ?? []).filter(Boolean);
  const configured =
    row.audience === "internal" && p.internalRecipientSource === "configured"
      ? p.internalRecipients
      : [];
  const fallback = row.audience === "internal" ? p.internalRecipients : [];
  const recipients = configured.length ? configured : stored.length ? stored : fallback;

  const resolvedSource: RecipientSource =
    row.audience === "applicant"
      ? "applicant"
      : configured.length
        ? "configured"
        : stored.length
          ? (row.recipient_source ?? "configured")
          : p.internalRecipientSource;

  const rewritten =
    configured.length && !sameAddresses(configured, stored)
      ? `recipients re-resolved at send: ${stored.length} → ${configured.length}`
      : null;

  return { recipients, resolvedSource, rewritten };
}

/** Same people, in any order and any case. Identity is `emailKey`, always. */
function sameAddresses(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const keys = new Set(a.map((value) => emailKey(value) ?? value));
  return b.every((value) => keys.has(emailKey(value) ?? value));
}

function clampStage(value: number): LeadStage {
  return (value >= 3 ? 3 : value <= 1 ? 1 : 2) as LeadStage;
}

async function settle(id: string, patch: LedgerUpdate): Promise<void> {
  const { error } = await supabaseAdmin.from("lead_stage_emails").update(patch).eq("id", id);
  if (error) {
    // Loud, for the same reason the campaign dispatcher is: the message has
    // gone and a ledger that does not say so is the one state that can produce
    // a duplicate.
    console.error(`[lead-stage-email] could not settle ${id} as ${patch.status}:`, error.message);
  }
}

/**
 * The do-not-send register, as a reading rather than a set.
 *
 * The distinction `readable` carries is the whole point. An earlier version
 * returned a bare `Set` and, when the read FAILED, returned every key in the
 * batch — failing closed, which is right, because sending to somebody who
 * asked us not to is the unrecoverable direction. But the caller could then
 * not tell the two apart, and settled the row `suppressed` with the reason
 * "every recipient is on the do-not-send register". On a statement timeout
 * that sentence is FALSE: nobody was on the register, the register was not
 * read. `suppressed` is terminal, so a transient database fault permanently
 * dropped a notification and recorded a reason that said the opposite of what
 * happened, with nothing raised to anybody.
 *
 * Fail closed, and say which kind of closed it is.
 */
type SuppressionReading = { keys: Set<string>; readable: boolean };

async function readSuppressions(addresses: string[]): Promise<SuppressionReading> {
  const keys = [
    ...new Set(
      addresses.map((address) => emailKey(address)).filter((key): key is string => Boolean(key)),
    ),
  ];
  if (keys.length === 0) return { keys: new Set(), readable: true };
  const { data, error } = await supabaseAdmin
    .from("email_suppressions")
    .select("email_key")
    .in("email_key", keys);
  if (error) {
    console.error(
      "[lead-stage-email] suppression read failed \u2014 holding the batch:",
      error.message,
    );
    return { keys: new Set(keys), readable: false };
  }
  return { keys: new Set((data ?? []).map((row) => row.email_key as string)), readable: true };
}

/**
 * A stage email that did NOT go needs a person, so it is a notification.
 *
 * A stage email that went needs nobody, and is recorded in the ledger alone —
 * `notificationDisposition.ts`'s rule, applied rather than restated.
 */
async function raiseFailureNotice(
  row: ClaimedRow,
  lead: Record<string, unknown>,
  detail: string,
): Promise<void> {
  const who =
    [lead.first_name, lead.last_name].filter(Boolean).join(" ") || String(lead.email ?? "a lead");
  // Through the shared helper, not a second insert: supabase-js ANSWERS with
  // an error rather than throwing, so a bare `try` around this would discard
  // the one signal saying the operator was never told.
  await notifyOperators({
    kind: "lead_stage_email_failed",
    severity: "warning",
    title: `Stage ${row.stage} ${row.audience} email did not send: ${who}`,
    body: detail.slice(0, 500),
    url: "/leads",
    metadata: {
      lead_id: row.lead_id,
      stage: row.stage,
      audience: row.audience,
      attempts: row.attempts,
      application_id: typeof lead.application_id === "string" ? lead.application_id : null,
    },
  });
}

/**
 * A sweep for applicants whose obligations were never raised.
 *
 * `enqueueStageEmails` runs where a stage is NOTICED — the ingest endpoint and
 * the Airtable sync. Both can miss: a webhook that never arrived, a sync that
 * failed the tick an applicant advanced, or this feature simply not having
 * existed yet when they did. The sweep is the third reader, and it asks the
 * database rather than a delivery path.
 *
 * It is bounded by the same window the policy uses, so it can never reach back
 * into history — switching the mailer on does not mail a year of funnel.
 */
export async function sweepMissingStageEmails(limit = 100): Promise<EnqueueResult> {
  const p = policy();
  const out: EnqueueResult = { queued: 0, skipped: 0, existing: 0 };
  if (p.maxAgeMs <= 0) return out;

  const since = new Date(Date.now() - p.maxAgeMs).toISOString();

  /*
    THREE STATEMENTS, AND NOT ONE `or`.

    The condition is "applied recently OR completed the questionnaire recently
    OR booked a review recently", which reads as a single
    `.or("created_at.gte.<ts>,stage2_completed_at.gte.<ts>,…")` — and that is a
    STRING with a timestamp interpolated into it, the filter this platform has
    already paid for once. The screening consumer's claim predicate was exactly
    that shape: it never parsed, the claim had NEVER ONCE succeeded, and the
    code and its test double agreed with each other the whole time while only
    the server disagreed. `fleet-migration.server.ts` refuses the same
    construction for the same reason, in as many words.

    Nothing here can prove the string would have parsed — there is no PostgREST
    to ask from a unit test, which is the entire trap — so the question is
    removed rather than answered. Each half is its own typed filter the builder
    composes, and the three id sets are merged here.

    It matters more than it looks. This sweep is the ONLY path that raises the
    applicant's acknowledgement once the grace period has elapsed: enqueue at
    t=0 deliberately writes nothing while the clock is still running. A filter
    that silently returned no rows would mean no applicant is ever
    acknowledged, with an empty result and a `queued: 0` that reads exactly
    like a quiet week.
  */
  const windows = [
    { column: "created_at" as const, what: "applied" },
    { column: "stage2_completed_at" as const, what: "completed the questionnaire" },
    { column: "stage3_booked_at" as const, what: "booked a review" },
  ];

  const byId = new Map<string, Record<string, unknown>>();
  for (const window of windows) {
    const { data, error } = await supabaseAdmin
      .from("waitlist_leads")
      .select("*")
      .gte(window.column, since)
      .order(window.column, { ascending: false })
      .limit(limit);

    if (error) {
      // Named, because "the sweep found nobody who applied" and "the sweep
      // could not ask who applied" are different facts and only one of them is
      // about the applicants.
      console.error(
        `[lead-stage-email] sweep read failed for leads that ${window.what}`,
        error.message,
      );
      continue;
    }
    for (const lead of data ?? []) byId.set(lead.id as string, lead);
  }

  for (const lead of byId.values()) {
    try {
      const result = await enqueueStageEmails({
        leadId: lead.id as string,
        lead,
        trigger: "manual",
      });
      out.queued += result.queued;
      out.skipped += result.skipped;
      out.existing += result.existing;
    } catch (error) {
      console.error("[lead-stage-email] sweep enqueue failed", { lead: lead.id, error });
    }
  }
  return out;
}

/** What the console reads: the send record for one applicant. */
export type StageEmailRecord = {
  stage: number;
  audience: StageAudience;
  status: string;
  reason: string | null;
  sent_at: string | null;
  to_address: string | null;
  last_error: string | null;
};
