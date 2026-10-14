/**
 * The sending domains in use, and how each authenticates.
 *
 * Every domain a message can leave from — each warmup mailbox's, each live
 * campaign's sending mailbox, each tenant's default mailbox — read from public
 * DNS the way a receiving server reads it: SPF, the two Microsoft 365 DKIM
 * selectors, DMARC and MX. Warmup earns a mailbox a reputation; these records
 * are what let a receiver attach that reputation to the domain at all, and
 * nothing inside Microsoft 365 says when one is missing. See
 * docs/EMAIL_WARMUP.md, "Sending domains".
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireOperator } from "@/integrations/supabase/role-middleware";
import { domainOf, type DomainAuthReport, type Severity } from "@/lib/email/domainAuth.pure";

/** Domains checked in one call: each is five DNS lookups. */
const MAX_DOMAINS = 20;
/** Campaign statuses whose sending mailbox may still send. */
const LIVE_STATUSES = ["draft", "running", "paused"];
const SEVERITY_ORDER: Record<Severity, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 };

export type SendingDomain = {
  domain: string;
  /** The mailboxes that send from it, and what for. */
  usedBy: { address: string; as: "warmup" | "campaign" | "tenant default" }[];
  report: DomainAuthReport;
};

export const getSendingDomains = createServerFn({ method: "POST" })
  .middleware([requireOperator])
  .inputValidator((input) => z.object({ fresh: z.boolean().default(false) }).parse(input ?? {}))
  .handler(async ({ data, context }) => {
    const [warming, campaigns, tenants] = await Promise.all([
      context.supabase.from("email_warmup_mailboxes").select("mailbox").neq("status", "removed"),
      context.supabase
        .from("email_campaigns")
        .select("from_mailbox")
        .in("status", LIVE_STATUSES)
        .not("from_mailbox", "is", null),
      context.supabase
        .from("microsoft_tenants")
        .select("default_mailbox")
        .is("removed_at", null)
        .not("default_mailbox", "is", null),
    ]);
    for (const result of [warming, campaigns, tenants]) if (result.error) throw result.error;

    const usedBy = new Map<string, SendingDomain["usedBy"]>();
    const note = (
      address: string | null | undefined,
      as: SendingDomain["usedBy"][number]["as"],
    ) => {
      const domain = domainOf(address);
      if (!domain || !address) return;
      const list = usedBy.get(domain) ?? [];
      const key = address.trim().toLowerCase();
      if (!list.some((entry) => entry.address === key && entry.as === as)) {
        list.push({ address: key, as });
      }
      usedBy.set(domain, list);
    };
    for (const row of warming.data ?? []) note(row.mailbox, "warmup");
    for (const row of campaigns.data ?? []) note(row.from_mailbox, "campaign");
    for (const row of tenants.data ?? []) note(row.default_mailbox, "tenant default");
    const { defaultGraphConfig } = await import("@/server/graph-client");
    note(defaultGraphConfig()?.mailbox, "tenant default");

    const { checkSendingDomain } = await import("@/server/email-domain-health.server");
    const domains = [...usedBy.keys()].sort().slice(0, MAX_DOMAINS);
    const reports = await Promise.all(
      domains.map((domain) => checkSendingDomain(domain, { fresh: data.fresh })),
    );
    const out: SendingDomain[] = domains.map((domain, index) => ({
      domain,
      usedBy: usedBy.get(domain) ?? [],
      report: reports[index],
    }));
    out.sort(
      (a, b) =>
        SEVERITY_ORDER[a.report.verdict] - SEVERITY_ORDER[b.report.verdict] ||
        a.domain.localeCompare(b.domain),
    );
    return { domains: out, more: Math.max(0, usedBy.size - MAX_DOMAINS) };
  });
