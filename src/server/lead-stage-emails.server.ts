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
  type LeadStage,
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

      rows.push({
        lead_id: input.leadId,
        stage,
        audience,
        status: decision.verdict === "send" ? "pending" : "skipped",
        reason: decision.verdict === "skip" ? decision.reason : null,
        to_address: recipients[0] ?? null,
        recipients,
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
  const out: DispatchResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    unconfirmed: 0,
    suppressed: 0,
    skipped: 0,
  };

  if (!isGraphConfigured()) {
    out.note = "Microsoft Graph is not configured on this deployment";
    return out;
  }

  const p = policy();
  const mailbox = p.mailbox ?? defaultMailbox();
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

  const suppressed = await readSuppressions(batch);

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

    const recipients = (row.recipients ?? []).filter(Boolean);
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
        graph_status: outcome.status,
        graph_request_id: outcome.requestId,
        reason: blocked.length ? `${blocked.length} recipient(s) suppressed` : null,
      });
      out.sent += 1;
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
  attempts: number;
};

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

async function readSuppressions(batch: ClaimedRow[]): Promise<Set<string>> {
  const keys = [
    ...new Set(
      batch
        .flatMap((row) => row.recipients ?? [])
        .map((address) => emailKey(address))
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  if (keys.length === 0) return new Set();
  const { data, error } = await supabaseAdmin
    .from("email_suppressions")
    .select("email_key")
    .in("email_key", keys);
  if (error) {
    // Failing closed here means sending to somebody who asked us not to.
    // Refusing the batch is recoverable; the send is not.
    console.error("[lead-stage-email] suppression read failed — treating all as blocked");
    return new Set(keys);
  }
  return new Set((data ?? []).map((row) => row.email_key as string));
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
  const { data, error } = await supabaseAdmin
    .from("waitlist_leads")
    .select("*")
    .or(
      [
        `created_at.gte.${since}`,
        `stage2_completed_at.gte.${since}`,
        `stage3_booked_at.gte.${since}`,
      ].join(","),
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[lead-stage-email] sweep read failed", error.message);
    return out;
  }

  for (const lead of data ?? []) {
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
