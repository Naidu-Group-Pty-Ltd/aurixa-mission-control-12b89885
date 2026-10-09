// Aurixa's YouTube channel: its audience, its uploads, and — with the owner's
// consent — YouTube Analytics' daily figures.
//
// Three kinds of figure, and the page says which is which: YouTube's lifetime
// counters as of today, the period's own figures from YouTube Analytics, and
// growth Mission Control measured by recording the counters day by day. The
// Data API has no history, so a day nobody recorded can never be recovered;
// every visit here records today's reading.
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { format, parseISO } from "date-fns";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricBar, type Metric } from "@/components/metric-bar";
import { getYouTubeOverview } from "@/lib/marketing.functions";
import { changeTone, signedCount } from "@/lib/marketing/labels.pure";
import {
  deriveRates,
  formatChange,
  formatCount,
  formatMinutes,
  formatPercent,
  formatSeconds,
} from "@/lib/marketing/marketingEngine";
import { TrendChart } from "./charts";
import { DigestCard } from "./digest-card";
import { ComparisonTable, SignalList } from "./insights";
import { rangeKey, useMarketingRange } from "./use-marketing-range";
import { SourceNotice } from "./source-notice";

function published(iso: string | null): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "d MMM yyyy");
  } catch {
    return iso.slice(0, 10);
  }
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

export function YouTubeChannelView() {
  const range = useMarketingRange();
  const fetchFn = useServerFn(getYouTubeOverview);
  const q = useQuery({
    queryKey: ["marketing", "youtube_channel", rangeKey(range)],
    queryFn: () => fetchFn({ data: range.request }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  if (q.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {(q.error as Error).message}
      </p>
    );
  }
  const data = q.data;
  const channel = data?.channel ?? null;
  const a = data?.analytics ?? null;
  const t = a?.totals ?? null;
  const comparison = a?.comparison ?? [];
  const changeNote = (key: string) => {
    const row = comparison.find((r) => r.key === key);
    if (!row || row.change === null) return undefined;
    const tone = changeTone(row);
    return `${formatChange(row.change)} vs previous${tone === "bad" ? " · worse" : tone === "good" ? " · better" : ""}`;
  };
  const net = data?.netSubscribers ?? null;

  const metrics: Metric[] = [
    {
      label: "subscribers",
      value: channel?.subscribersHidden
        ? "Hidden"
        : formatCount(channel?.subscribers ?? null, { compact: true }),
      note: channel?.subscribersHidden ? "the channel hides its count" : "as of today",
    },
    {
      label: "net subscribers",
      value: net ? signedCount(net.value) : "—",
      note: !net
        ? "needs analytics, or two days of readings"
        : net.basis === "analytics"
          ? "gained less lost · analytics"
          : `from readings over ${net.spanDays ?? "?"} days`,
    },
    {
      label: "views",
      value: formatCount(t?.views ?? null, { compact: true }),
      note: t ? (changeNote("views") ?? "in this period") : "needs youtube analytics",
    },
    {
      label: "watch time",
      value: formatMinutes(t?.watchTimeMinutes ?? null),
      note: t
        ? `average view ${formatSeconds(deriveRates(t).averageWatchSeconds)}`
        : "needs youtube analytics",
    },
    {
      label: "uploads",
      value: formatCount(data?.uploads.inRange ?? null),
      note:
        data?.uploads.perWeek != null
          ? `${data.uploads.perWeek.toFixed(1)} a week`
          : "in this period",
    },
    {
      label: "crm leads",
      value: data?.leads ? formatCount(data.leads.all) : "—",
      note: data?.leads
        ? `${formatCount(data.leads.organic)} organic · ${formatCount(data.leads.paid)} paid`
        : "the leads could not be read",
    },
  ];
  const videos = data ? (data.uploads.videos.length > 0 ? data.uploads.videos : data.recent) : [];
  const inRange = (data?.uploads.videos.length ?? 0) > 0;
  const daily = (a?.daily ?? []).map((d) => ({
    date: d.date,
    views: d.metrics.views,
    watch: d.metrics.watchTimeMinutes,
  }));

  return (
    <div className="space-y-5">
      <SourceNotice
        source="YouTube channel"
        state={data?.sources.data}
        provides="Connect a YouTube Data API key and the channel id to see the channel's subscribers, lifetime views and every upload."
      />

      {channel && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4 p-4">
            {channel.thumbnailUrl && (
              <img
                src={channel.thumbnailUrl}
                alt=""
                referrerPolicy="no-referrer"
                loading="lazy"
                className="h-14 w-14 shrink-0 border border-border object-cover"
              />
            )}
            <div className="min-w-0 flex-[1_1_14rem]">
              <p className="font-display truncate text-xl">{channel.title}</p>
              <p className="font-mono text-[11px] text-muted-foreground">
                {channel.customUrl ? `${channel.customUrl} · ` : ""}
                {formatCount(channel.totalViews, { compact: true })} lifetime views ·{" "}
                {formatCount(channel.videoCount)} videos
              </p>
            </div>
            <a
              href={channel.url}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono text-[11px] uppercase tracking-[0.14em] text-primary"
            >
              open channel →
            </a>
          </CardContent>
        </Card>
      )}

      {(q.isLoading || channel) && <MetricBar metrics={metrics} />}

      <SourceNotice
        source="YouTube Analytics"
        state={data?.sources.analytics}
        provides="With the owner's consent, YouTube Analytics adds each day's views, watch time, subscribers gained and lost, traffic sources and the period's top videos."
        compact
      />
      <SourceNotice source="Daily readings" state={data?.sources.history} compact />
      <SourceNotice source="Lead attribution" state={data?.sources.leads} compact />

      {channel && <DigestCard channel="youtube_channel" title="YouTube channel digest" />}

      {a && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <div className="xl:col-span-2">
            <Panel
              title="Day by day"
              description="YouTube Analytics lags by up to three days, so the latest days may still be filling in."
            >
              {daily.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No daily figures for this period yet.
                </p>
              ) : (
                <TrendChart
                  ariaLabel="YouTube views and watch time by day"
                  data={daily}
                  series={[
                    {
                      key: "views",
                      label: "Views",
                      kind: "bar",
                      axis: "left",
                      colour: 1,
                      format: (v) => formatCount(v, { compact: true }),
                    },
                    {
                      key: "watch",
                      label: "Watch time (min)",
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
          <Panel
            title="Where views came from"
            description="YouTube's own traffic-source categories."
          >
            {a.trafficSources.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No traffic sources were reported for this period.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {a.trafficSources.slice(0, 8).map((s) => (
                  <li key={s.key} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">{s.label}</span>
                      <span className="shrink-0 font-mono tabular-nums">
                        {formatCount(s.views, { compact: true })}{" "}
                        <span className="text-muted-foreground">· {formatPercent(s.share, 1)}</span>
                      </span>
                    </div>
                    <div className="h-1.5 bg-muted" aria-hidden>
                      <div
                        className="h-full bg-primary"
                        style={{ width: `${Math.max(1, (s.share ?? 0) * 100)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}

      {a && a.topVideos.length > 0 && (
        <Panel
          title="Most watched in this period"
          description="Views and watch time inside the period, whenever the video was published."
        >
          <ul className="divide-y divide-border/50">
            {a.topVideos.slice(0, 10).map((v) => (
              <li key={v.videoId} className="flex items-center gap-3 py-2.5">
                {v.thumbnailUrl ? (
                  <img
                    src={v.thumbnailUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    className="h-12 w-20 shrink-0 border border-border object-cover"
                  />
                ) : (
                  <div className="h-12 w-20 shrink-0 bg-muted" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <a
                    href={v.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="line-clamp-2 text-sm font-medium hover:text-primary"
                  >
                    {v.title ?? `Video ${v.videoId}`}
                  </a>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {formatMinutes(v.watchTimeMinutes)} watched · average{" "}
                    {formatSeconds(v.averageViewDurationSeconds)}
                    {v.subscribersGained != null
                      ? ` · +${formatCount(v.subscribersGained)} subscribers`
                      : ""}
                  </p>
                </div>
                <span className="numeral shrink-0 text-lg">
                  {formatCount(v.views, { compact: true })}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {channel && (
        <Panel
          title={inRange ? "Published in this period" : "Recent uploads"}
          description={
            <>
              {inRange
                ? "Every upload published inside the range."
                : "Nothing was published in this range, so these are the most recent uploads."}{" "}
              Views, likes and comments are each video's lifetime totals as of today.
            </>
          }
        >
          {videos.length === 0 ? (
            <p className="text-sm text-muted-foreground">The channel has no public uploads.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="label-mono text-left">
                    <th className="py-2 pr-3 font-normal">video</th>
                    <th className="py-2 pr-3 text-right font-normal">published</th>
                    <th className="py-2 pr-3 text-right font-normal">length</th>
                    <th className="py-2 pr-3 text-right font-normal">views</th>
                    <th className="py-2 pr-3 text-right font-normal">likes</th>
                    <th className="py-2 text-right font-normal">comments</th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v) => (
                    <tr key={v.id} className="border-t border-border/50">
                      <td className="max-w-[24rem] py-2 pr-3">
                        {v.url ? (
                          <a
                            href={v.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="block truncate font-medium hover:text-primary"
                            title={v.name}
                          >
                            {v.name}
                          </a>
                        ) : (
                          <span className="block truncate font-medium">{v.name}</span>
                        )}
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {[
                            v.objective === "short_form" ? "short-form" : null,
                            v.status === "live"
                              ? "live"
                              : v.status === "upcoming"
                                ? "upcoming"
                                : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                        {published(v.publishedAt)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                        {formatSeconds(v.durationSeconds)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums">
                        {formatCount(v.metrics.views, { compact: true })}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono tabular-nums">
                        {formatCount(v.metrics.likes, { compact: true })}
                      </td>
                      <td className="py-2 text-right font-mono tabular-nums">
                        {formatCount(v.metrics.comments, { compact: true })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {data && channel && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SignalList
            signals={data.signals}
            currency={null}
            emptyText="Nothing about the channel tripped a rule in this period."
          />
          {comparison.length > 0 ? (
            <ComparisonTable rows={comparison} currency={null} followersWord="subscribers" />
          ) : (
            <Panel
              title="Growth Mission Control measured"
              description="YouTube publishes subscriber and view totals, not their history. Each day this page or the nightly job reads them, and growth is the difference between readings."
            >
              {data.growth.from && data.growth.to ? (
                <dl className="grid grid-cols-2 gap-3">
                  <div>
                    <dt className="label-mono">subscribers</dt>
                    <dd className="numeral mt-1 text-lg">
                      {signedCount(data.growth.netSubscribers)}{" "}
                      <span className="font-mono text-[11px] text-muted-foreground">
                        over {data.growth.spanDays} days
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt className="label-mono">lifetime views</dt>
                    <dd className="numeral mt-1 text-lg">{signedCount(data.growth.netViews)}</dd>
                  </div>
                  <p className="col-span-2 font-mono text-[10px] text-muted-foreground">
                    from {data.growth.from.date} to {data.growth.to.date} ·{" "}
                    {formatCount(data.growth.readingsInWindow)} readings in the window
                  </p>
                </dl>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {data.growth.readingsInWindow === 0
                    ? "No readings exist for this range yet. The first was taken just now."
                    : "Only one reading exists in this range so far; growth needs two."}
                </p>
              )}
            </Panel>
          )}
        </div>
      )}

      {data && data.quotaUnits > 0 && (
        <p className="font-mono text-[10px] text-muted-foreground">
          this read used about {formatCount(data.quotaUnits)} of the YouTube Data API's default
          10,000 daily units
        </p>
      )}
    </div>
  );
}
