// Attribution: where each lead came from, the evidence that says so, and what
// the leads of each channel became.
//
// A lead is a `waitlist_leads` row and its channel is decided by the marketing
// engine's one classifier — the same file the prime uses — from the strongest
// evidence it carried. A lead with none is Unknown, never guessed. Deals are
// credited to the channel of each account's FIRST lead in the period, once, and
// counted whenever they were won.
import type { ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { format, parseISO } from "date-fns";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { rangeKey, useMarketingRange } from "@/components/marketing/use-marketing-range";
import { SourceNotice } from "@/components/marketing/source-notice";
import { getMarketingHistory } from "@/lib/marketing.functions";
import { formatCents } from "@/lib/marketing/labels.pure";
import {
  LEAD_CHANNEL_LABELS,
  formatCount,
  type LeadChannel,
} from "@/lib/marketing/marketingEngine";

export const Route = createFileRoute("/marketing/attribution")({
  component: AttributionPage,
  head: () => ({ meta: [{ title: "Attribution — Marketing — Aurixa Systems Mission Control" }] }),
});

const EVIDENCE: Record<string, string> = {
  ttclid: "TikTok click id",
  fbclid: "Facebook click id",
  gclid: "Google click id",
  meta_campaign: "Meta campaign id",
  utm_source: "UTM source",
  utm_medium: "UTM medium",
  referrer: "referrer",
  crm_source: "form source",
  landing_page_only: "landing page",
  none: "no evidence",
};

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function when(iso: string): string {
  try {
    return format(parseISO(iso), "d MMM, h:mm a");
  } catch {
    return iso;
  }
}

function AttributionPage() {
  const range = useMarketingRange();
  const historyFn = useServerFn(getMarketingHistory);
  const q = useQuery({
    queryKey: ["marketing", "history", rangeKey(range)],
    queryFn: () => historyFn({ data: range.request }),
    staleTime: 5 * 60 * 1000,
  });
  const attribution = q.data?.attribution;

  const channels = attribution?.ok
    ? (Object.keys(LEAD_CHANNEL_LABELS) as LeadChannel[])
        .map((k) => ({
          key: k,
          label: LEAD_CHANNEL_LABELS[k],
          all: attribution.summary.byChannel[k],
          paid: attribution.summary.paidByChannel[k],
          organic: attribution.summary.organicByChannel[k],
          deals: attribution.dealsRead ? (attribution.deals[k] ?? null) : null,
          campaigns: attribution.summary.campaigns[k] ?? [],
        }))
        .filter((r) => r.all > 0)
        .sort((a, b) => b.all - a.all)
    : [];

  return (
    <div className="space-y-5">
      {q.error && (
        <p role="alert" className="text-sm text-destructive">
          {(q.error as Error).message}
        </p>
      )}
      <SourceNotice source="Lead attribution" state={q.data?.sources.leads} />

      <Panel
        title="Channels, leads and deals"
        description={
          <>
            Every lead in the period by channel, and the deals of the accounts those leads became —
            credited to each account's first lead in the period, won at any time since.
            {attribution?.ok &&
              attribution.capped &&
              " Only the most recent leads were read, so these counts are a floor."}
            {attribution?.ok &&
              !attribution.dealsRead &&
              " The deals could not be read, so they are left blank rather than shown as none."}
          </>
        }
      >
        {!attribution ? (
          <p className="text-sm text-muted-foreground">
            {q.isLoading ? "Reading the leads…" : "—"}
          </p>
        ) : !attribution.ok ? (
          <p className="text-sm text-muted-foreground">The leads could not be read.</p>
        ) : channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No leads arrived in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="label-mono text-left">
                  <th className="py-2 pr-3 font-normal">channel</th>
                  <th className="py-2 pr-3 text-right font-normal">leads</th>
                  <th className="py-2 pr-3 text-right font-normal">paid</th>
                  <th className="py-2 pr-3 text-right font-normal">organic</th>
                  <th className="py-2 pr-3 text-right font-normal">deals open</th>
                  <th className="py-2 pr-3 text-right font-normal">won</th>
                  <th className="py-2 pr-3 text-right font-normal">won mrr</th>
                  <th className="py-2 text-right font-normal">setup fees</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((r) => (
                  <tr key={r.key} className="border-t border-border/50 align-top">
                    <td className="py-2 pr-3">
                      <span className="font-medium">{r.label}</span>
                      {r.campaigns.length > 0 && (
                        <span className="block font-mono text-[10px] text-muted-foreground">
                          {r.campaigns
                            .slice(0, 3)
                            .map((c) => `${c.campaign} (${c.leads})`)
                            .join(" · ")}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {formatCount(r.all)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {formatCount(r.paid)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {formatCount(r.organic)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {r.deals ? formatCount(r.deals.open) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {r.deals ? formatCount(r.deals.won) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums">
                      {r.deals ? formatCents(r.deals.wonMrrCents) : "—"}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {r.deals ? formatCents(r.deals.wonSetupCents) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title="The most recent leads"
        description="The last fifty leads in the period, newest first, with the evidence that placed each one."
      >
        {!attribution?.ok ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : attribution.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">No leads arrived in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-sm">
              <thead>
                <tr className="label-mono text-left">
                  <th className="py-2 pr-3 font-normal">arrived</th>
                  <th className="py-2 pr-3 font-normal">lead</th>
                  <th className="py-2 pr-3 font-normal">channel</th>
                  <th className="py-2 pr-3 font-normal">evidence</th>
                  <th className="py-2 pr-3 font-normal">campaign</th>
                  <th className="py-2 font-normal">account</th>
                </tr>
              </thead>
              <tbody>
                {attribution.recent.map((l) => (
                  <tr key={l.id} className="border-t border-border/50">
                    <td className="py-2 pr-3 font-mono text-[11px] text-muted-foreground">
                      {when(l.createdAt)}
                    </td>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{l.name || "—"}</span>
                      {l.organisation && (
                        <span className="block font-mono text-[10px] text-muted-foreground">
                          {l.organisation}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {LEAD_CHANNEL_LABELS[l.classification.channel]}
                      {l.classification.paid !== null && (
                        <span className="ml-1 font-mono text-[10px] uppercase text-muted-foreground">
                          {l.classification.paid ? "paid" : "organic"}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 font-mono text-[11px] text-muted-foreground">
                      {EVIDENCE[l.classification.evidence] ?? l.classification.evidence}
                    </td>
                    <td
                      className="max-w-[14rem] truncate py-2 pr-3 font-mono text-[11px]"
                      title={l.classification.campaign ?? undefined}
                    >
                      {l.classification.campaign ?? "—"}
                    </td>
                    <td className="py-2">
                      {l.accountId ? (
                        <Link
                          to="/crm/accounts/$accountId"
                          params={{ accountId: l.accountId }}
                          className="font-mono text-[11px] text-primary"
                        >
                          open →
                        </Link>
                      ) : (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          not converted
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
