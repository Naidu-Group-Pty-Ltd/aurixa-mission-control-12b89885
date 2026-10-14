/**
 * Domain checks against live DNS: how a sending domain authenticates, and
 * whether a recipient's domain takes mail at all. The judgements are
 * `domainAuth.pure.ts`; this file only asks DNS and remembers the answers.
 *
 * Recipient domains are remembered in `email_mail_domains` as well as per
 * isolate, because the dispatcher asks about the same agencies' domains slot
 * after slot from isolates that come and go. A domain that takes mail is
 * trusted for thirty days; one that does not is asked again after a week, in
 * case it was mid-move.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  judgeDomain,
  judgeMailDomain,
  type DomainAuthReport,
  type MailDomainVerdict,
} from "@/lib/email/domainAuth.pure";
import { resolveDns } from "@/server/dns.server";

const REPORT_TTL_MS = 60 * 60_000;
const reports = new Map<string, { at: number; report: DomainAuthReport }>();

/** SPF, DKIM, DMARC and MX for a sending domain, as a receiver sees them. */
export async function checkSendingDomain(
  domain: string,
  options: { fresh?: boolean } = {},
): Promise<DomainAuthReport> {
  const key = domain.toLowerCase();
  const cached = reports.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < REPORT_TTL_MS) return cached.report;
  const [spf, dmarc, dkim1, dkim2, mx] = await Promise.all([
    resolveDns(key, "TXT"),
    resolveDns(`_dmarc.${key}`, "TXT"),
    resolveDns(`selector1._domainkey.${key}`, "CNAME"),
    resolveDns(`selector2._domainkey.${key}`, "CNAME"),
    resolveDns(key, "MX"),
  ]);
  const report = judgeDomain({
    domain: key,
    checkedAt: new Date().toISOString(),
    spf,
    dmarc,
    dkim1,
    dkim2,
    mx,
  });
  // A report built on failed lookups is not worth keeping for an hour.
  if (report.verdict !== "unknown") reports.set(key, { at: Date.now(), report });
  return report;
}

/** Whether mail to one domain can be delivered, from DNS. */
export async function judgeRecipientDomain(domain: string): Promise<MailDomainVerdict> {
  const mx = await resolveDns(domain, "MX");
  // Only a domain that exists with no MX needs its address records read.
  const needsAddress = mx.ok && mx.rcode === 0 && !mx.answers.some((a) => a.type === 15);
  const address = needsAddress ? await resolveDns(domain, "A") : null;
  return judgeMailDomain(mx, address);
}

const TAKES_MAIL_TTL_MS = 30 * 24 * 60 * 60_000;
const NO_MAIL_TTL_MS = 7 * 24 * 60 * 60_000;
/** Lookups at once, so one batch of fifty contacts is not fifty requests in a burst. */
const LOOKUP_CONCURRENCY = 8;

/**
 * The recipient domains among `domains` that are known not to take mail,
 * with why. Remembered answers first; the rest asked of DNS and written back.
 * A domain DNS could not answer for is left out — it is not known to be dead.
 *
 * `budgetMs` bounds how long new lookups keep STARTING, so a resolver having
 * a bad minute costs a sending pass a few seconds rather than its whole
 * budget; the domains it did not reach are asked next time.
 */
export async function deadRecipientDomains(
  domains: string[],
  options: { budgetMs?: number } = {},
): Promise<Map<string, string>> {
  const deadline = Date.now() + (options.budgetMs ?? Number.POSITIVE_INFINITY);
  const wanted = [...new Set(domains.map((d) => d.toLowerCase()).filter(Boolean))];
  const dead = new Map<string, string>();
  if (wanted.length === 0) return dead;

  const { data, error } = await supabaseAdmin
    .from("email_mail_domains")
    .select("domain, accepts_mail, detail, checked_at")
    .in("domain", wanted);
  if (error) {
    // The register of answers is an optimisation; without it, ask DNS.
    console.error("[email] could not read remembered mail domains:", error.message);
  }
  const now = Date.now();
  const known = new Set<string>();
  for (const row of data ?? []) {
    const age = now - Date.parse(row.checked_at as string);
    const ttl = row.accepts_mail ? TAKES_MAIL_TTL_MS : NO_MAIL_TTL_MS;
    if (!Number.isFinite(age) || age > ttl) continue;
    known.add(row.domain as string);
    if (row.accepts_mail === false) {
      dead.set(row.domain as string, (row.detail as string) ?? "the domain has no mail server");
    }
  }

  const queue = wanted.filter((domain) => !known.has(domain));
  const answered: { domain: string; accepts_mail: boolean; detail: string; checked_at: string }[] =
    [];
  const worker = async () => {
    for (let domain = queue.shift(); domain; domain = queue.shift()) {
      if (Date.now() > deadline) return;
      const verdict = await judgeRecipientDomain(domain);
      if (verdict.accepts === "unknown") continue;
      answered.push({
        domain,
        accepts_mail: verdict.accepts === "yes",
        detail: verdict.detail,
        checked_at: new Date().toISOString(),
      });
      if (verdict.accepts === "no") dead.set(domain, verdict.detail);
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, queue.length) }, worker));

  if (answered.length > 0) {
    const { error: writeError } = await supabaseAdmin
      .from("email_mail_domains")
      .upsert(answered, { onConflict: "domain" });
    if (writeError) {
      console.error("[email] could not remember mail domains:", writeError.message);
    }
  }
  return dead;
}
