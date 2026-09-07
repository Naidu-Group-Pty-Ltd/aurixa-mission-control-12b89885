/**
 * Where bounces come from.
 *
 * "Never send another email to a contact that bounced" is one of this
 * feature's two hard rules, and it was one command away from being
 * decorative: Microsoft Graph raises no webhook when an application-identity
 * `sendMail` fails downstream. There is no callback, no status field to poll,
 * and no error on the send — a message accepted with 202 and rejected by the
 * receiving server twenty seconds later looks identical to one that was read.
 * The failure comes back as a message IN the sending mailbox, and if nothing
 * reads that mailbox the register stays empty for ever while the product
 * reports the rule as enforced.
 *
 * So this reads it, every fifteen minutes.
 *
 * ## The safety rule
 *
 * A delivery report is a message written by a stranger's mail server. It names
 * the failed recipient, and it also usually quotes the entire original
 * message — headers, sender, every visible address in the body. A scanner that
 * suppressed every address it found in one would, given a bounce from a
 * mailing list, suppress the sending mailbox itself and then silently stop the
 * whole product.
 *
 * **An address is only ever suppressed when this deployment actually sent to
 * it.** Every candidate is checked against the recipient ledger, and one that
 * no campaign has sent to is counted and discarded. That single check is what
 * makes reading arbitrary inbound mail safe.
 *
 * ## Hard only
 *
 * 4.x.x is "not right now" — a full mailbox, a greylist, a server restarting.
 * Suppressing on one deletes a good customer from every future campaign
 * because of an afternoon, and nothing would ever say so. Soft failures are
 * counted here and recorded on the scan; they never reach the register.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  isDeliveryReport,
  readDeliveryReport,
  type BounceFinding,
} from "@/lib/email/bounceReport.pure";
import {
  defaultMailbox,
  isGraphConfigured,
  listInboxPage,
  listInboxSince,
  type GraphMailMessage,
} from "@/server/graph-client";

const DEFAULT_BUDGET_MS = 20_000;
/** How far back a mailbox with no successful scan on record starts. */
const COLD_START_DAYS = 7;
/** Pages of 50, so one tick cannot walk a year of mail. */
const MAX_PAGES = 6;

export type BounceScanSummary = {
  mailboxes: number;
  examined: number;
  reports: number;
  suppressed: number;
  soft: number;
  /** Findings discarded because no campaign ever sent to that address. */
  unmatched: number;
  notes: string[];
};

/** Every mailbox this deployment sends from: the configured one, plus overrides. */
async function sendingMailboxes(): Promise<string[]> {
  const mailboxes = new Set<string>();
  const configured = defaultMailbox();
  if (configured) mailboxes.add(configured.toLowerCase());

  const { data, error } = await supabaseAdmin
    .from("email_campaigns")
    .select("from_mailbox")
    .not("from_mailbox", "is", null)
    .neq("status", "draft");
  if (error) throw error;
  for (const row of data ?? []) {
    const value = (row.from_mailbox as string | null)?.trim();
    if (value) mailboxes.add(value.toLowerCase());
  }
  return [...mailboxes];
}

async function resumePoint(mailbox: string): Promise<Date> {
  const { data, error } = await supabaseAdmin
    .from("email_bounce_scans")
    .select("cursor_at")
    .eq("mailbox", mailbox)
    .eq("status", "ok")
    .not("cursor_at", "is", null)
    .order("cursor_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  const mark = data?.[0]?.cursor_at as string | null | undefined;
  if (mark) return new Date(mark);
  return new Date(Date.now() - COLD_START_DAYS * 86400000);
}

function messageText(message: GraphMailMessage): string {
  const body = message.body?.content ?? message.bodyPreview ?? "";
  // Where Exchange declined the plain-text rendering, strip the markup rather
  // than hand a wall of HTML to a line-oriented parser.
  if ((message.body?.contentType ?? "").toLowerCase() === "html") {
    return body
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }
  return body;
}

function headerMap(message: GraphMailMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const header of message.internetMessageHeaders ?? []) {
    if (header?.name) out[header.name] = header.value ?? "";
  }
  return out;
}

/** One pass over every sending mailbox. */
export async function scanForBounces(
  options: { budgetMs?: number } = {},
): Promise<BounceScanSummary> {
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const summary: BounceScanSummary = {
    mailboxes: 0,
    examined: 0,
    reports: 0,
    suppressed: 0,
    soft: 0,
    unmatched: 0,
    notes: [],
  };

  if (!isGraphConfigured()) {
    summary.notes.push("Microsoft Graph is not configured on this deployment");
    return summary;
  }

  const mailboxes = await sendingMailboxes();
  if (mailboxes.length === 0) {
    summary.notes.push("no sending mailbox is configured");
    return summary;
  }

  for (const mailbox of mailboxes) {
    if (Date.now() > deadline) {
      summary.notes.push(`${mailbox}: out of time this tick`);
      break;
    }
    try {
      const result = await scanMailbox(mailbox, deadline);
      summary.mailboxes += 1;
      summary.examined += result.examined;
      summary.reports += result.reports;
      summary.suppressed += result.suppressed;
      summary.soft += result.soft;
      summary.unmatched += result.unmatched;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[email] bounce scan failed for ${mailbox}:`, message);
      summary.notes.push(`${mailbox}: ${message}`);
    }
  }

  return summary;
}

async function scanMailbox(mailbox: string, deadline: number) {
  const since = await resumePoint(mailbox);
  const { data: scanRow, error: scanError } = await supabaseAdmin
    .from("email_bounce_scans")
    .insert({ mailbox, status: "running" })
    .select("id")
    .single();
  if (scanError) throw scanError;
  const scanId = scanRow.id as string;

  let examined = 0;
  let reports = 0;
  let soft = 0;
  let unmatched = 0;
  let suppressed = 0;
  let cursor: string | null = null;

  try {
    const findings = new Map<string, BounceFinding>();
    let page = await listInboxSince(mailbox, since, 50);

    for (let index = 0; index < MAX_PAGES; index++) {
      for (const message of page.messages) {
        examined += 1;
        // The high-water mark advances over every message examined, not just
        // the reports: a mailbox with a thousand ordinary emails and one
        // bounce must not re-read the thousand for ever.
        if (!cursor || message.receivedDateTime > cursor) cursor = message.receivedDateTime;

        const headers = headerMap(message);
        const input = {
          subject: message.subject,
          fromAddress: message.from?.emailAddress?.address ?? null,
          bodyText: messageText(message),
          headers,
        };
        if (!isDeliveryReport(input)) continue;
        reports += 1;

        for (const finding of readDeliveryReport(input)) {
          if (finding.kind === "soft") {
            soft += 1;
            continue;
          }
          if (finding.kind !== "hard") continue;
          const existing = findings.get(finding.address);
          if (!existing) findings.set(finding.address, finding);
        }
      }

      if (!page.nextLink || Date.now() > deadline) break;
      page = await listInboxPage(page.nextLink);
    }

    if (findings.size > 0) {
      const recorded = await recordBounces([...findings.values()]);
      suppressed = recorded.suppressed;
      unmatched = recorded.unmatched;
    }

    const { error } = await supabaseAdmin
      .from("email_bounce_scans")
      .update({
        status: "ok",
        finished_at: new Date().toISOString(),
        messages_examined: examined,
        reports_found: reports,
        addresses_suppressed: suppressed,
        soft_failures: soft,
        // Only a run that got this far may move the mark. A failed run
        // re-reads its window rather than stepping over it.
        cursor_at: cursor ?? since.toISOString(),
      })
      .eq("id", scanId);
    if (error) console.error("[email] could not close a bounce scan:", error.message);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { error: updateError } = await supabaseAdmin
      .from("email_bounce_scans")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        messages_examined: examined,
        reports_found: reports,
        error: message.slice(0, 500),
      })
      .eq("id", scanId);
    if (updateError) console.error("[email] could not record a failed scan:", updateError.message);
    throw error;
  }

  return { examined, reports, suppressed, soft, unmatched };
}

/**
 * Write hard bounces to the register — for addresses this deployment sent to,
 * and no others.
 */
export async function recordBounces(
  findings: BounceFinding[],
): Promise<{ suppressed: number; unmatched: number }> {
  const addresses = findings.map((finding) => finding.address).filter(Boolean);
  if (addresses.length === 0) return { suppressed: 0, unmatched: 0 };

  // The safety rule. An address in a quoted original, a forwarding host, a
  // mailing-list manager — anything we did not send to — is discarded here.
  const { data: known, error: knownError } = await supabaseAdmin
    .from("email_campaign_recipients")
    .select("email_key, email, campaign_id")
    .in("email_key", addresses)
    .in("status", ["sent", "unconfirmed"]);
  if (knownError) throw knownError;

  const sentTo = new Map<string, { email: string; campaign_id: string }>();
  for (const row of known ?? []) {
    const key = row.email_key as string;
    if (!sentTo.has(key)) {
      sentTo.set(key, { email: row.email as string, campaign_id: row.campaign_id as string });
    }
  }

  const matched = findings.filter((finding) => sentTo.has(finding.address));
  const unmatched = findings.length - matched.length;
  if (matched.length === 0) return { suppressed: 0, unmatched };

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("email_suppressions")
    .select("email_key, occurrences")
    .in(
      "email_key",
      matched.map((finding) => finding.address),
    );
  if (existingError) throw existingError;
  const seen = new Map((existing ?? []).map((row) => [row.email_key as string, row]));

  const now = new Date().toISOString();
  const fresh = matched.filter((finding) => !seen.has(finding.address));

  if (fresh.length > 0) {
    const { error } = await supabaseAdmin.from("email_suppressions").insert(
      fresh.map((finding) => ({
        email_key: finding.address,
        email: sentTo.get(finding.address)?.email ?? finding.address,
        reason: "bounced",
        detail: finding.detail || finding.status || null,
        source: "bounce_scan",
        campaign_id: sentTo.get(finding.address)?.campaign_id ?? null,
        first_seen_at: now,
        last_seen_at: now,
        occurrences: 1,
      })),
    );
    if (error) throw error;
  }

  for (const finding of matched) {
    const row = seen.get(finding.address);
    if (!row) continue;
    const { error } = await supabaseAdmin
      .from("email_suppressions")
      .update({
        last_seen_at: now,
        occurrences: (row.occurrences as number) + 1,
        detail: finding.detail || (row as { detail?: string }).detail || null,
      })
      .eq("email_key", finding.address);
    if (error) console.error("[email] could not update a suppression:", error.message);
  }

  // A bounce learned in one campaign stops every other one immediately, which
  // is the point of a register that is not scoped to a campaign.
  const { error: cascadeError } = await supabaseAdmin
    .from("email_campaign_recipients")
    .update({ status: "suppressed", suppressed_reason: "the address bounced" })
    .in(
      "email_key",
      matched.map((finding) => finding.address),
    )
    .eq("status", "pending");
  if (cascadeError) {
    console.error(
      "[email] could not stop pending sends to a bounced address:",
      cascadeError.message,
    );
  }

  return { suppressed: matched.length, unmatched };
}
