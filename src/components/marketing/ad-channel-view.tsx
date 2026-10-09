// One advertising channel — Meta, Google Ads on YouTube, or TikTok — drawn the
// same way: headline figures, the trend, how far people watched, the
// drill-down, findings and health, the period comparison, budget advice, a
// projection, the leads and deals the CRM credits to it, and a digest on
// request. It is the prime's Meta/YouTube/TikTok tab carried across, drawn in
// the console's own materials.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricBar, type Metric } from "@/components/metric-bar";
import { getAdChannel } from "@/lib/marketing.functions";
import { changeTone, formatCents, statusWord } from "@/lib/marketing/labels.pure";
import {
  deriveRates,
  formatChange,
  formatCount,
  formatMoney,
  formatPercent,
  outcomeOf,
  ratio,
  type EntityRow,
  type MetricSet,
  type PeriodComparisonRow,
} from "@/lib/marketing/marketingEngine";
import { TrendChart } from "./charts";
import { DigestCard } from "./digest-card";
import { EntityTable, type EntityColumn } from "./entity-table";
import {
  BudgetAdviceCard,
  ComparisonTable,
  ForecastPanel,
  HealthList,
  PacingPanel,
  SignalList,
} from "./insights";
import { rangeKey, useMarketingRange } from "./use-marketing-range";
import { SourceNotice } from "./source-notice";
import { useAdDrill, type AdLevel } from "./use-ad-drill";
import { VideoFunnel, type FunnelStage } from "./video-funnel";

export type AdChannelKind = "meta_ads" | "youtube_ads" | "tiktok_ads";

const WORDS: Record<
  AdChannelKind,
  {
    source: string;
    outcome: string;
    costPerOutcome: string;
    view: string;
    costPerView: string;
    adGroup: string;
    provides: string;
  }
> = {
  meta_ads: {
    source: "Meta Ads",
    outcome: "Leads",
    costPerOutcome: "Cost / lead",
    view: "3s views",
    costPerView: "Cost / 3s view",
    adGroup: "Ad set",
    provides:
      "Connect Meta Ads to see Aurixa's Facebook and Instagram spend, reach, clicks, video plays and leads.",
  },
  youtube_ads: {
    source: "Google Ads",
    outcome: "Conversions",
    costPerOutcome: "Cost / conversion",
    view: "Views",
    costPerView: "Cost / view",
    adGroup: "Ad group",
    provides:
      "Connect Google Ads to see spend, TrueView views, view rate, cost per view and completion for campaigns on YouTube.",
  },
  tiktok_ads: {
    source: "TikTok Ads",
    outcome: "Results",
    costPerOutcome: "Cost / result",
    view: "Plays",
    costPerView: "Cost / play",
    adGroup: "Ad group",
    provides: "Connect TikTok Ads to see spend, plays, watch-through, engagement and results.",
  },
};

function columnsFor(kind: AdChannelKind, currency: string | null): EntityColumn[] {
  const w = WORDS[kind];
  const m = (r: EntityRow) => r.metrics;
  const cols: EntityColumn[] = [
    {
      key: "spend",
      label: "Spend",
      render: (r) => formatMoney(m(r).spend, currency),
      sortValue: (r) => m(r).spend,
    },
    {
      key: "impressions",
      label: "Impr.",
      render: (r) => formatCount(m(r).impressions, { compact: true }),
      sortValue: (r) => m(r).impressions,
    },
    {
      key: "views",
      label: w.view,
      render: (r) => formatCount(m(r).views, { compact: true }),
      sortValue: (r) => m(r).views,
    },
  ];
  if (kind === "tiktok_ads") {
    cols.push({
      key: "hook",
      label: "6s hold",
      render: (r) => formatPercent(deriveRates(m(r)).hookRate),
      sortValue: (r) => deriveRates(m(r)).hookRate,
    });
  } else {
    cols.push({
      key: "viewRate",
      label: "View rate",
      render: (r) => formatPercent(deriveRates(m(r)).viewRate),
      sortValue: (r) => deriveRates(m(r)).viewRate,
    });
  }
  cols.push(
    {
      key: "cpv",
      label: w.costPerView,
      render: (r) => formatMoney(deriveRates(m(r)).cpv, currency),
      sortValue: (r) => deriveRates(m(r)).cpv,
    },
    {
      key: "ctr",
      label: "CTR",
      render: (r) => formatPercent(deriveRates(m(r)).ctr),
      sortValue: (r) => deriveRates(m(r)).ctr,
    },
    {
      key: "outcome",
      label: w.outcome,
      render: (r) => formatCount(outcomeOf(m(r))),
      sortValue: (r) => outcomeOf(m(r)),
    },
    {
      key: "cpo",
      label: w.costPerOutcome,
      render: (r) => formatMoney(ratio(m(r).spend, outcomeOf(m(r))), currency),
      sortValue: (r) => ratio(m(r).spend, outcomeOf(m(r))),
    },
  );
  return cols;
}

function funnelsFor(
  kind: AdChannelKind,
  t: MetricSet | null,
): Array<{ title: string; stages: FunnelStage[]; basis: string }> {
  const q = (title: string, first: FunnelStage, basis: string) => ({
    title,
    basis,
    stages: [
      first,
      { key: "q25", label: "Watched 25%", value: t?.quartile25 ?? null },
      { key: "q50", label: "Watched 50%", value: t?.quartile50 ?? null },
      { key: "q75", label: "Watched 75%", value: t?.quartile75 ?? null },
      { key: "q100", label: "Watched to the end", value: t?.quartile100 ?? null },
    ],
  });
  if (kind === "youtube_ads") {
    return [
      q(
        "Completion",
        { key: "impressions", label: "Impressions", value: t?.impressions ?? null },
        "Google Ads reports how far into the video an impression got as a rate of impressions; each stage is that rate times impressions.",
      ),
    ];
  }
  if (kind === "tiktok_ads") {
    return [
      {
        title: "The opening",
        basis: "Plays held to two and to six seconds — how well the first seconds stop the scroll.",
        stages: [
          { key: "plays", label: "Plays", value: t?.videoPlays ?? null },
          { key: "s2", label: "Watched 2 seconds", value: t?.views2s ?? null },
          { key: "s6", label: "Watched 6 seconds", value: t?.views6s ?? null },
        ],
      },
      q(
        "Completion",
        { key: "plays", label: "Plays", value: t?.videoPlays ?? null },
        "Plays that reached each quarter of the video. A short video can reach 25% before six seconds, so the two are drawn apart.",
      ),
    ];
  }
  return [
    q(
      "Completion",
      { key: "plays", label: "Plays", value: t?.videoPlays ?? null },
      "Plays that reached each quarter of the video, as Meta counts them.",
    ),
  ];
}

function change(rows: PeriodComparisonRow[], key: string): string | undefined {
  const row = rows.find((r) => r.key === key);
  if (!row || row.change === null) return undefined;
  const tone = changeTone(row);
  return `${formatChange(row.change)} vs previous${tone === "bad" ? " · worse" : tone === "good" ? " · better" : ""}`;
}

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

export function AdChannelView({ kind }: { kind: AdChannelKind }) {
  const w = WORDS[kind];
  const range = useMarketingRange();
  const drill = useAdDrill(w.adGroup);
  const fetchFn = useServerFn(getAdChannel);
  const q = useQuery({
    queryKey: [
      "marketing",
      kind,
      rangeKey(range),
      drill.level,
      drill.drill.campaignId,
      drill.drill.adGroupId,
    ],
    queryFn: () =>
      fetchFn({
        data: {
          ...range.request,
          channel: kind,
          level: drill.level as AdLevel,
          campaignId: drill.drill.campaignId,
          adGroupId: drill.drill.adGroupId,
        },
      }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const data = q.data;
  const report = data?.report ?? null;
  const t = report?.totals ?? null;
  const currency = report?.currency ?? null;
  const rates = t ? deriveRates(t) : null;
  const comparison = data?.comparison ?? [];
  const outcome = t ? outcomeOf(t) : null;
  const leads = data?.leads ?? null;

  if (q.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {(q.error as Error).message}
      </p>
    );
  }

  const metrics: Metric[] = [
    {
      label: "spend",
      value: formatMoney(t?.spend ?? null, currency, { compact: true }),
      note: change(comparison, "spend") ?? currency ?? undefined,
    },
    {
      label: "impressions",
      value: formatCount(t?.impressions ?? null, { compact: true }),
      note: change(comparison, "impressions"),
    },
    {
      label: w.view.toLowerCase(),
      value: formatCount(t?.views ?? null, { compact: true }),
      note:
        kind === "youtube_ads"
          ? `view rate ${formatPercent(rates?.viewRate ?? null)}`
          : change(comparison, "views"),
    },
    {
      label: "clicks",
      value: formatCount(t?.clicks ?? null, { compact: true }),
      note: `ctr ${formatPercent(rates?.ctr ?? null)}`,
    },
    {
      label: w.outcome.toLowerCase(),
      value: formatCount(outcome),
      note: `${w.costPerOutcome.toLowerCase()} ${formatMoney(ratio(t?.spend ?? null, outcome), currency)}`,
    },
    {
      label: "crm leads",
      value: leads ? formatCount(leads.paid) : "—",
      note: leads
        ? `paid · ${formatMoney(ratio(t?.spend ?? null, leads.paid > 0 ? leads.paid : null), currency)} each · ${formatCount(leads.all)} in all`
        : "the leads could not be read",
    },
  ];

  const daily = (report?.daily ?? []).map((d) => ({
    date: d.date,
    spend: d.metrics.spend,
    views: d.metrics.views,
  }));
  const showBody = !!report || (q.isLoading && !data);
  const levelWords: Record<AdLevel, string> = {
    campaign: "Campaigns",
    adgroup: `${w.adGroup}s`,
    ad: "Ads",
  };

  return (
    <div className="space-y-5">
      <SourceNotice source={w.source} state={data?.sources.ads} provides={w.provides} />
      <SourceNotice source="Lead attribution" state={data?.sources.leads} compact />

      {showBody && (
        <>
          <MetricBar metrics={metrics} />
          {data && (
            <p className="font-mono text-[10px] text-muted-foreground">
              {data.rangeLabel} · {data.range.since} → {data.range.until} · {data.timeZone}
              {report?.accountName ? ` · ${report.accountName}` : ""}
            </p>
          )}

          <DigestCard channel={kind} title={`${w.source} digest`} disabled={!report} />

          {report && (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <Panel title="Day by day" description={report.viewDefinition ?? undefined}>
                  {daily.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Nothing delivered in this period.
                    </p>
                  ) : (
                    <TrendChart
                      ariaLabel={`${w.source} spend and ${w.view} by day`}
                      data={daily}
                      series={[
                        {
                          key: "spend",
                          label: "Spend",
                          kind: "bar",
                          axis: "left",
                          colour: 1,
                          format: (v) => formatMoney(v, currency, { compact: true }),
                        },
                        {
                          key: "views",
                          label: w.view,
                          kind: "line",
                          axis: "right",
                          colour: 2,
                          format: (v) => formatCount(v, { compact: true }),
                        },
                      ]}
                    />
                  )}
                </Panel>
              </div>
              <Panel title="How far people watched">
                <div className="space-y-5">
                  {funnelsFor(kind, t).map((f) => (
                    <div key={f.title} className="space-y-2">
                      <p className="label-mono">{f.title}</p>
                      <VideoFunnel stages={f.stages} basis={f.basis} />
                    </div>
                  ))}
                </div>
              </Panel>
            </div>
          )}

          {(data?.pacing || (data?.campaigns.length ?? 0) > 0) && (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {data?.pacing ? (
                <PacingPanel pacing={data.pacing} currency={currency} />
              ) : (
                <Panel
                  title="Month pacing"
                  description="Pacing is a month-to-date question. Choose “This Month” to see it."
                >
                  <p className="text-xs text-muted-foreground">
                    Campaigns with a lifetime budget are not included in pacing.
                  </p>
                </Panel>
              )}
              {data && data.campaigns.length > 0 && (
                <Panel title="Campaign budgets" description="As set in the ad platform today.">
                  <ul className="divide-y divide-border/50 text-sm">
                    {data.campaigns.slice(0, 12).map((c) => (
                      <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                        <span className="min-w-0">
                          <span className="block truncate" title={c.name ?? c.id}>
                            {c.name ?? `Campaign ${c.id}`}
                          </span>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {[statusWord(c.status), statusWord(c.objective)]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono tabular-nums">
                          {c.budget !== null
                            ? `${formatMoney(c.budget, currency)} ${c.budgetKind === "daily" ? "a day" : "lifetime"}`
                            : "no budget"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </div>
          )}

          <EntityTable
            title={`${w.source} performance`}
            entities={report?.entities ?? []}
            columns={columnsFor(kind, currency)}
            health={data?.health ?? []}
            level={drill.level}
            levelWords={levelWords}
            crumbs={drill.crumbs}
            loading={q.isLoading}
            onDrill={drill.onDrill}
            onCrumb={drill.onCrumb}
            onLevel={drill.onLevel}
          />

          {report && data && (
            <>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <SignalList
                  signals={data.signals}
                  currency={currency}
                  emptyText="Nothing in this period tripped a rule."
                />
                <HealthList health={data.health} />
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <ComparisonTable rows={comparison} currency={currency} />
                <BudgetAdviceCard advice={data.budget} currency={currency} />
              </div>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <ForecastPanel
                  forecast={data.forecast?.spend}
                  title="Spend trend"
                  formatValue={(v) => formatMoney(v, currency, { compact: true })}
                />
                <ForecastPanel
                  forecast={data.forecast?.views}
                  title={`${w.view} trend`}
                  formatValue={(v) => formatCount(v, { compact: true })}
                />
                <ForecastPanel
                  forecast={data.forecast?.results}
                  title={`${w.outcome} trend`}
                  formatValue={(v) => formatCount(v, { compact: true })}
                />
              </div>
              {leads && (
                <Panel
                  title="What the leads became"
                  description={
                    <>
                      Leads the CRM credits to {w.source.replace(" Ads", "")} in this period, and
                      the deals their accounts have reached since — first touch inside the period,
                      won at any time.
                      {leads.capped &&
                        " Only the most recent leads were read, so these counts are a floor."}
                    </>
                  }
                >
                  <div className="grid gap-4 md:grid-cols-2">
                    <dl className="grid grid-cols-2 gap-3">
                      {[
                        ["leads, paid", formatCount(leads.paid)],
                        ["leads, all", formatCount(leads.all)],
                        ["deals won", leads.deals ? formatCount(leads.deals.won) : "—"],
                        ["won mrr", leads.deals ? formatCents(leads.deals.wonMrrCents) : "—"],
                        [
                          "setup fees won",
                          leads.deals ? formatCents(leads.deals.wonSetupCents) : "—",
                        ],
                        ["deals open", leads.deals ? formatCount(leads.deals.open) : "—"],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt className="label-mono">{label}</dt>
                          <dd className="numeral mt-1 text-lg">{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <div>
                      <p className="label-mono mb-2">by campaign (utm_campaign)</p>
                      {leads.campaigns.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No lead named a campaign.</p>
                      ) : (
                        <ul className="divide-y divide-border/50 text-sm">
                          {leads.campaigns.slice(0, 8).map((c) => (
                            <li
                              key={c.campaign}
                              className="flex items-center justify-between gap-3 py-1.5"
                            >
                              <span className="min-w-0 truncate" title={c.campaign}>
                                {c.campaign}
                              </span>
                              <span className="font-mono tabular-nums">{formatCount(c.leads)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </Panel>
              )}
              {report.notes.length > 0 && (
                <Panel title="About these figures">
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {report.notes.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                </Panel>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
