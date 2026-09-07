/**
 * Reading a delivery-status notification.
 *
 * The hard rule is "never send to an address that bounced", and a hard rule
 * with no source of bounces is a rule that never fires. Microsoft Graph raises
 * no webhook for a failed `sendMail` from an application identity: the failure
 * comes back as a message IN the sending mailbox, written by a machine at the
 * far end, and this is where that message is turned into a fact.
 *
 * ## Hard and soft are not the same fact
 *
 * A 5.x.x status means the address is wrong and will stay wrong — no such
 * user, domain does not exist, blocked. A 4.x.x means the far end could not
 * take it right now: mailbox full, greylisted, server down. Suppressing on a
 * 4.x.x deletes a good customer from every future campaign because their inbox
 * was full for an afternoon, and nothing would ever tell anybody. So only hard
 * failures reach the register; soft ones are counted and reported.
 *
 * ## What this module deliberately does not decide
 *
 * It reads addresses out of a report; it does not decide to suppress them.
 * A report can name the sender, a mailing-list address, a forwarding host, or
 * an address in a quoted copy of the original message — and a scanner that
 * suppressed everything it found would eventually suppress the sending mailbox
 * itself. The caller cross-checks every address against contacts this
 * deployment actually sent to, and only those are recorded.
 */
import { extractAddresses } from "./emailAddress.pure";

export type BounceKind = "hard" | "soft" | "unknown";

export type BounceFinding = {
  /** Normalised address. */
  address: string;
  /** The RFC 3463 status, e.g. `5.1.1`, when the report carried one. */
  status: string | null;
  /** The SMTP reply code, e.g. `550`, when the diagnostic carried one. */
  smtpCode: number | null;
  kind: BounceKind;
  /** The diagnostic, trimmed to something a person can read in a table. */
  detail: string;
};

export type ReportInput = {
  subject?: string | null;
  fromAddress?: string | null;
  bodyText?: string | null;
  /** Header name → value, as Graph returns `internetMessageHeaders`. */
  headers?: Record<string, string> | null;
};

const POSTMASTER = /^(postmaster|mailer-daemon|mail|no-?reply)@/i;

const NDR_SUBJECT =
  /(undeliverable|undelivered|delivery status notification|delivery (has )?failed|returned mail|mail delivery (failed|subsystem)|failure notice|message not delivered|rejected)/i;

/**
 * Whether a message is a delivery report at all.
 *
 * The content type is the standards-compliant signal and is checked first. The
 * other two exist because a meaningful share of the internet's mail servers do
 * not set it — and a scanner that only trusted the header would read a
 * mailbox full of bounces and find none.
 */
export function isDeliveryReport(input: ReportInput): boolean {
  const contentType = findHeader(input.headers, "content-type") ?? "";
  if (/multipart\/report/i.test(contentType) && /delivery-status/i.test(contentType)) return true;
  if (findHeader(input.headers, "x-failed-recipients")) return true;
  const from = String(input.fromAddress ?? "");
  if (POSTMASTER.test(from) && NDR_SUBJECT.test(String(input.subject ?? ""))) return true;
  return NDR_SUBJECT.test(String(input.subject ?? "")) && POSTMASTER.test(from);
}

function findHeader(
  headers: Record<string, string> | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/** RFC 3464 fields are `Name: value`, foldable onto continuation lines. */
function unfold(text: string): string[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length > 0) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line);
  }
  return out;
}

function classify(status: string | null, smtpCode: number | null): BounceKind {
  if (status) {
    if (status.startsWith("5")) return "hard";
    if (status.startsWith("4")) return "soft";
    if (status.startsWith("2")) return "unknown";
  }
  if (smtpCode != null) {
    if (smtpCode >= 500 && smtpCode < 600) return "hard";
    if (smtpCode >= 400 && smtpCode < 500) return "soft";
  }
  return "unknown";
}

/**
 * Every recipient a report names, with what happened to each.
 *
 * The machine-readable `message/delivery-status` part is read first: it names
 * one recipient per block with its own status, which is the only reading that
 * stays correct when one message fails for two people for different reasons.
 * Where a sender did not produce one, the prose is read instead and the whole
 * report is attributed to whichever addresses appear in it — deliberately
 * imprecise, and safe only because the caller will not suppress an address it
 * never sent to.
 */
export function readDeliveryReport(input: ReportInput): BounceFinding[] {
  const body = String(input.bodyText ?? "");
  const lines = unfold(body);
  const findings: BounceFinding[] = [];

  let current: {
    address?: string;
    status?: string;
    action?: string;
    diagnostic?: string;
  } | null = null;

  const flush = () => {
    if (!current?.address) {
      current = null;
      return;
    }
    // `Action: delivered` and `relayed` are progress reports, not failures.
    const action = (current.action ?? "failed").toLowerCase();
    if (action === "delivered" || action === "relayed" || action === "expanded") {
      current = null;
      return;
    }
    const smtpCode = current.diagnostic ? readSmtpCode(current.diagnostic) : null;
    const status = current.status ?? null;
    const kind = classify(status, smtpCode);
    // `Action: delayed` is by definition not final, whatever the code says.
    const finalKind: BounceKind = action === "delayed" ? "soft" : kind;
    const address = extractAddresses(current.address)[0];
    if (address) {
      findings.push({
        address,
        status,
        smtpCode,
        kind: finalKind,
        detail: (current.diagnostic ?? status ?? "").slice(0, 300).trim(),
      });
    }
    current = null;
  };

  for (const line of lines) {
    const field = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!field) {
      if (line.trim() === "") flush();
      continue;
    }
    const name = field[1].toLowerCase();
    const value = field[2].trim();

    if (name === "final-recipient" || name === "original-recipient") {
      // A new recipient block begins; whatever was open is complete.
      if (current?.address && name === "final-recipient") flush();
      current = current ?? {};
      current.address = current.address ?? value;
      if (name === "final-recipient") current.address = value;
    } else if (current) {
      if (name === "action") current.action = value;
      else if (name === "status")
        current.status = /(\d\.\d{1,3}\.\d{1,3})/.exec(value)?.[1] ?? value;
      else if (name === "diagnostic-code") current.diagnostic = value;
    }
  }
  flush();

  if (findings.length > 0) return dedupe(findings);

  // No machine-readable part. `X-Failed-Recipients` is the common non-standard
  // substitute; after that, the prose.
  const failedHeader = findHeader(input.headers, "x-failed-recipients");
  const prose = `${input.subject ?? ""}\n${body}`;
  const statusMatch = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(body);
  const codeMatch = readSmtpCode(body);
  const kind = classify(statusMatch?.[1] ?? null, codeMatch);
  const addresses = extractAddresses(failedHeader ?? prose);

  return dedupe(
    addresses.map((address) => ({
      address,
      status: statusMatch?.[1] ?? null,
      smtpCode: codeMatch,
      kind,
      detail: (statusMatch?.[0] ?? "delivery report with no machine-readable part").slice(0, 300),
    })),
  );
}

/**
 * The SMTP reply code in a diagnostic.
 *
 * Anchored to the start of the field or to `smtp;`, because a diagnostic often
 * quotes the message's own numbers — a size, a queue id — and taking the first
 * three digits anywhere reads `550` out of a byte count.
 */
export function readSmtpCode(diagnostic: string): number | null {
  const text = String(diagnostic ?? "");
  const tagged = /smtp\s*;\s*(\d{3})\b/i.exec(text);
  if (tagged) return Number(tagged[1]);
  const leading = /(?:^|\n)\s*(\d{3})[ -]/.exec(text);
  if (leading) return Number(leading[1]);
  const anywhere = /\b([45]\d{2})\s+[45]\.\d/.exec(text);
  return anywhere ? Number(anywhere[1]) : null;
}

/** One finding per address; the hardest verdict wins. */
function dedupe(findings: BounceFinding[]): BounceFinding[] {
  const rank: Record<BounceKind, number> = { hard: 3, soft: 2, unknown: 1 };
  const byAddress = new Map<string, BounceFinding>();
  for (const finding of findings) {
    const existing = byAddress.get(finding.address);
    if (!existing || rank[finding.kind] > rank[existing.kind])
      byAddress.set(finding.address, finding);
  }
  return [...byAddress.values()];
}
