// Marketing overview: every channel side by side, from Mission Control's own
// daily record, with the leads and deals the CRM credits to each.
//
// It answers from `marketing_channel_snapshots` rather than asking three
// vendors at once. Its honesty rules are the engine's: spend in two currencies
// is never one total, a channel with no recorded days is said to have none
// rather than drawn at zero, and every total says how many of the range's days
// it covers.
import { useMemo, useState, type ReactNode } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricBar, type Metric } from "@/components/metric-bar";
import { BriefText } from "@/components/marketing/brief-text";
import { TrendChart } from "@/components/marketing/charts";
import { rangeKey, useMarketingRange } from "@/components/marketing/use-marketing-range";
import { SourceNotice } from "@/components/marketing/source-notice";
import {
  getMarketingConnections,
  getMarketingHistory,
  writeMarketingWeeklyBrief,
} from "@/lib/marketing.functions";
import { formatCents } from "@/lib/marketing/labels.pure";
import {
  LEAD_CHANNEL_LABELS,
  dayCount,
  formatCount,
  formatMoney,
  outcomeOf,
  ratio,
  sumMetrics,
  summariseChannels,
  type ChannelHeadline,
  type LeadChannel,
  type MetricSet,
} from "@/lib/marketing/marketingEngine";

export const Route = createFileRoute("/marketing/")({
  component: MarketingOverview,
  head: () => ({ meta: [{ title: "Marketing — Aurixa Systems Mission Control" }] }),
});

type AdKey = "meta_ads" | "youtube_ads" | "tiktok_ads";

const CHANNELS: Array<{
  key: AdKey;
  label: string;
  lead: LeadChannel;
  source: "meta_ads" | "google_ads" | "tiktok_ads";
  to: string;
  colour: 1 | 2 | 3;
}> = [
  {
    key: "meta_ads",
    label: "Meta Ads",
    lead: "meta",
    source: "meta_ads",
    to: "/marketing/meta",
    colour: 1,
  },
  {
    key: "youtube_ads",
    label: "YouTube Ads",
    lead: "youtube",
    source: "google_ads",
    to: "/marketing/youtube",
    colour: 2,
  },
  {
    key: "tiktok_ads",
    label: "TikTok Ads",
    lead: "tiktok",
    source: "tiktok_ads",
    to: "/marketing/tiktok",
    colour: 3,
  },
];

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

function MarketingOverview() {
  const range = useMarketingRange();
  const historyFn = useServerFn(getMarketingHistory);
  const connectionsFn = useServerFn(getMarketingConnections);
  const briefFn = useServerFn(writeMarketingWeeklyBrief);
  const qc = useQueryClient();
  const history = useQuery({
    queryKey: ["marketing", "history", rangeKey(range)],
    queryFn: () => historyFn({ data: range.request }),
    staleTime: 5 * 60 * 1000,
  });
  const connections = useQuery({
    queryKey: ["marketing", "connections"],
    queryFn: () => connectionsFn(),
  });
  const [brief, setBrief] = useState<{ content: string; label: string } | null>(null);
  const [briefError, setBriefError] = useState("");
  const [writing, setWriting] = useState(false);

  const data = history.data;
  const days = data ? dayCount(data.range) : null;
  const attribution = data?.attribution;
  const configured = useMemo(
    () => new Map((connections.data?.connections ?? []).map((c) => [c.source, c.configured])),
    [connections.data],
  );

  const rows = useMemo(() => {
    if (!data) return [];
    return CHANNELS.map((c) => {
      const series = data.series.filter((s) => s.channel === c.key);
      const points = series.flatMap((s) => s.points);
      const totals =
        points.length > 0 ? sumMetrics(points.map((p) => p.metrics as MetricSet)) : null;
      const currencies = [
        ...new Set(series.map((s) => s.currency).filter((x): x is string => !!x)),
      ];
      const paid = attribution?.ok ? attribution.summary.paidByChannel[c.lead] : null;
      const all = attribution?.ok ? attribution.summary.byChannel[c.lead] : null;
      const deals =
        attribution?.ok && attribution.dealsRead ? (attribution.deals[c.lead] ?? null) : null;
      const headline: ChannelHeadline = {
        key: c.key,
        label: c.label,
        state: totals
          ? "ok"
          : configured.get(c.source) === false
            ? "not_configured"
            : "not_requested",
        currency: currencies.length === 1 ? currencies[0] : null,
        spend: totals?.spend ?? null,
        impressions: totals?.impressions ?? null,
        clicks: totals?.clicks ?? null,
        views: totals?.views ?? null,
        viewDefinition: null,
        results: totals ? outcomeOf(totals) : null,
        attributedLeads: paid,
      };
      return {
        ...c,
        headline,
        recordedDays: new Set(points.map((p) => p.date)).size,
        currencies,
        all,
        deals,
      };
    });
  }, [data, attribution, configured]);

  const summary = useMemo(() => summariseChannels(rows.map((r) => r.headline)), [rows]);
  const single = summary.spendByCurrency.length === 1 ? summary.spendByCurrency[0].currency : null;
  const wonMrr = rows.reduce((s, r) => s + (r.deals?.wonMrrCents ?? 0), 0);
  const won = rows.reduce((s, r) => s + (r.deals?.won ?? 0), 0);

  const spendChart = useMemo(() => {
    if (!data || !single) return null;
    const byDate = new Map<string, Record<string, number | string | null>>();
    for (const c of CHANNELS) {
      for (const s of data.series.filter((x) => x.channel === c.key)) {
        for (const p of s.points) {
          const slot = byDate.get(p.date) ?? { date: p.date };
          const spend = (p.metrics as MetricSet).spend;
          slot[c.key] =
            spend === null || spend === undefined
              ? null
              : ((slot[c.key] as number | null) ?? 0) + spend;
          byDate.set(p.date, slot);
        }
      }
    }
    return [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [data, single]);

  const metrics: Metric[] = [
    {
      label: "channels",
      value: history.isLoading ? "…" : `${summary.answered}/3`,
      note:
        summary.notConfigured > 0
          ? `${summary.notConfigured} not connected`
          : "with recorded figures",
    },
    {
      label: "spend",
      value: summary.totalSpend
        ? formatMoney(summary.totalSpend.amount, summary.totalSpend.currency, { compact: true })
        : summary.spendByCurrency.length > 1
          ? "mixed"
          : "—",
      note:
        summary.spendByCurrency.length > 1
          ? "two currencies are never added together"
          : "recorded days only",
    },
    {
      label: "leads",
      value: attribution?.ok ? formatCount(attribution.summary.total) : "—",
      note: "every lead in the period",
    },
    {
      label: "paid leads",
      value: attribution?.ok
        ? formatCount(Object.values(attribution.summary.paidByChannel).reduce((a, b) => a + b, 0))
        : "—",
      note: summary.totalSpend
        ? `${formatMoney(summary.costPerAttributedLead, summary.totalSpend.currency)} each`
        : "cost needs one currency",
    },
    {
      label: "deals won",
      value: attribution?.ok && attribution.dealsRead ? formatCount(won) : "—",
      note: "from this period's ad leads",
    },
    {
      label: "won mrr",
      value: attribution?.ok && attribution.dealsRead ? formatCents(wonMrr) : "—",
      note: "monthly, to date",
    },
  ];

  const writeBrief = async () => {
    setWriting(true);
    setBriefError("");
    try {
      const answer = await briefFn({ data: range.request });
      if (answer.ok) {
        setBrief({ content: answer.content, label: answer.rangeLabel });
        qc.invalidateQueries({ queryKey: ["marketing", "reports"] });
      } else {
        setBriefError(answer.error);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "The brief could not be written.";
      setBriefError(message);
      toast.error(message);
    } finally {
      setWriting(false);
    }
  };

  const leadMix = attribution?.ok
    ? (Object.keys(LEAD_CHANNEL_LABELS) as LeadChannel[])
        .map((k) => ({
          key: k,
          label: LEAD_CHANNEL_LABELS[k],
          all: attribution.summary.byChannel[k],
          paid: attribution.summary.paidByChannel[k],
          organic: attribution.summary.organicByChannel[k],
        }))
        .filter((r) => r.all > 0)
        .sort((a, b) => b.all - a.all)
    : [];

  return (
    <div className="space-y-5">
      {history.error && (
        <p role="alert" className="text-sm text-destructive">
          {(history.error as Error).message}
        </p>
      )}
      <SourceNotice source="Daily record" state={data?.sources.history} />
      <SourceNotice source="Lead attribution" state={data?.sources.leads} compact />

      <MetricBar metrics={metrics} />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden /> Weekly brief
            </CardTitle>
            <Button size="sm" onClick={writeBrief} disabled={writing}>
              {writing ? (
                <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-3.5 w-3.5" />
              )}
              {writing ? "Writing…" : "Write brief"}
            </Button>
          </div>
          <CardDescription>
            One brief across every connected channel, written by a model from figures this server
            re-reads — each channel's figures kept under its own name. Every brief is kept on{" "}
            <Link to="/marketing/briefs" className="text-primary">
              Briefs
            </Link>
            .{brief && <> Covers {brief.label}.</>}
          </CardDescription>
        </CardHeader>
        {(brief || briefError) && (
          <CardContent>
            {brief ? (
              <BriefText text={brief.content} />
            ) : (
              <p role="alert" className="text-sm text-destructive">
                {briefError}
              </p>
            )}
          </CardContent>
        )}
      </Card>

      <Panel
        title="By channel"
        description="Each channel's recorded days in the range, its totals over those days, and what the CRM credits to it."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="label-mono text-left">
                <th className="py-2 pr-3 font-normal">channel</th>
                <th className="py-2 pr-3 text-right font-normal">days recorded</th>
                <th className="py-2 pr-3 text-right font-normal">spend</th>
                <th className="py-2 pr-3 text-right font-normal">impressions</th>
                <th className="py-2 pr-3 text-right font-normal">results</th>
                <th className="py-2 pr-3 text-right font-normal">leads paid / all</th>
                <th className="py-2 pr-3 text-right font-normal">cost / paid lead</th>
                <th className="py-2 text-right font-normal">won · mrr</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-border/50">
                  <td className="py-2 pr-3">
                    <Link to={r.to} className="font-medium hover:text-primary">
                      {r.label}
                    </Link>
                    {r.headline.state !== "ok" && (
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                        {r.headline.state === "not_configured"
                          ? "not connected"
                          : "no days recorded yet"}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                    {days ? `${r.recordedDays} of ${days}` : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {r.currencies.length > 1
                      ? "mixed"
                      : formatMoney(r.headline.spend, r.headline.currency)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {formatCount(r.headline.impressions, { compact: true })}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {formatCount(r.headline.results)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {r.headline.attributedLeads === null
                      ? "—"
                      : `${formatCount(r.headline.attributedLeads)} / ${formatCount(r.all)}`}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tabular-nums">
                    {formatMoney(
                      ratio(
                        r.headline.spend,
                        r.headline.attributedLeads && r.headline.attributedLeads > 0
                          ? r.headline.attributedLeads
                          : null,
                      ),
                      r.headline.currency,
                    )}
                  </td>
                  <td className="py-2 text-right font-mono tabular-nums">
                    {r.deals
                      ? `${formatCount(r.deals.won)} · ${formatCents(r.deals.wonMrrCents)}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          The nightly recorder writes each connected account's days and re-reads the last seven,
          because platforms restate them as late conversions arrive. A day it did not record is
          missing from these totals rather than counted as nothing. Each channel counts a "view" its
          own way, so views are compared within a channel, never across. Deals are those of the
          period's leads, credited to the channel of each account's first lead in the period, won at
          any time since.
        </p>
      </Panel>

      {spendChart && spendChart.length > 0 && single && (
        <Panel title="Spend by day" description={`${single}, recorded days only.`}>
          <TrendChart
            ariaLabel="Spend by day for each channel"
            data={spendChart}
            series={CHANNELS.filter(
              (c) => rows.find((r) => r.key === c.key)?.headline.state === "ok",
            ).map((c) => ({
              key: c.key,
              label: c.label,
              kind: "line" as const,
              axis: "left" as const,
              colour: c.colour,
              format: (v: number) => formatMoney(v, single, { compact: true }),
            }))}
          />
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title="Where the period's leads came from"
          description={
            <>
              Every lead, placed on a channel by the strongest evidence it carried — a click id
              first, then its UTM tags, then its referrer.{" "}
              <Link to="/marketing/attribution" className="text-primary">
                See each lead
              </Link>
              .
            </>
          }
        >
          {!attribution?.ok ? (
            <p className="text-sm text-muted-foreground">
              {history.isLoading ? "Reading the leads…" : "The leads could not be read."}
            </p>
          ) : leadMix.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leads arrived in this period.</p>
          ) : (
            <ul className="space-y-2.5">
              {leadMix.map((r) => (
                <li key={r.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{r.label}</span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {formatCount(r.all)}
                      <span className="ml-2 text-[11px] text-muted-foreground">
                        {formatCount(r.paid)} paid · {formatCount(r.organic)} organic
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 bg-muted" aria-hidden>
                    <div
                      className="h-full bg-primary"
                      style={{
                        width: `${Math.max(1, (r.all / Math.max(1, attribution.summary.total)) * 100)}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel
          title="How each lead was placed"
          description="The kind of evidence that decided each lead's channel. A lead with none is Unknown, never guessed."
        >
          {!attribution?.ok ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <ul className="divide-y divide-border/50 text-sm">
              {Object.entries(attribution.summary.byEvidence)
                .filter(([, n]) => (n ?? 0) > 0)
                .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                .map(([k, n]) => (
                  <li key={k} className="flex items-center justify-between gap-3 py-2">
                    <span>{EVIDENCE_WORDS[k] ?? k}</span>
                    <span className="font-mono tabular-nums">{formatCount(n ?? 0)}</span>
                  </li>
                ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

const EVIDENCE_WORDS: Record<string, string> = {
  ttclid: "TikTok click id",
  fbclid: "Facebook click id",
  gclid: "Google click id",
  meta_campaign: "Meta campaign id",
  utm_source: "UTM source",
  utm_medium: "UTM medium",
  referrer: "Referring site",
  crm_source: "Lead form's source field",
  landing_page_only: "Landing page only",
  none: "No evidence",
};
