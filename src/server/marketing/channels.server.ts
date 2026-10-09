// What each Marketing page is drawn from — the prime's `marketing-channels`
// operations, carried across: the YouTube channel, the three advertising
// channels, the recorded history, and lead attribution.
//
// Every answer carries a `SourceState` per source, so a page says WHY a
// section is empty — not connected, refused, unreachable — instead of drawing
// zeros. Nothing here writes a vendor account; the one write is the day's
// YouTube reading, because a channel's growth exists only if it was recorded.
import {
  addDays,
  channelGrowth,
  comparePeriods,
  dayCount,
  deriveRates,
  detectYouTubeChannelSignals,
  RECENT_UPLOAD_COUNT,
  uploadsInRange,
  uploadsPerWeek,
  youtubeVideoEntity,
  type ChannelCounterReading,
  type ChannelGrowth,
  type ChannelReport,
  type ChannelSignal,
  type DateRange,
  type DatePreset,
  type EntityRow,
  type LeadChannel,
  type MetricSet,
  type MonthPacing,
  type SourceState,
  type TikTokCampaignInfo,
  type MetaCampaignInfo,
  type YouTubeChannelInfo,
  type YouTubeVideo,
  type DailyPoint,
  type PeriodComparisonRow,
  type TrafficSourceRow,
  type TopVideoRow,
} from "@/lib/marketing/marketingEngine";
import {
  adAnalysis,
  metaRunning,
  pacingFor,
  tiktokRunning,
  type AdAnalysis,
} from "@/lib/marketing/analysis.pure";
import { readLeadAttribution, type LeadAttribution } from "./leads.server";
import {
  readMetaAds,
  readTikTokAds,
  readYouTubeAds,
  readYouTubeAnalytics,
  readYouTubeChannel,
  type AdLevel,
  type Drill,
} from "./reads.server";
import {
  channelReadingRow,
  metricsFromStorage,
  readSnapshots,
  upsertSnapshots,
  type SnapshotChannel,
} from "./snapshots.server";

export type AdChannel = "meta_ads" | "youtube_ads" | "tiktok_ads";

/** The lead channel each advertising channel's spend is meant to produce. */
export const LEAD_CHANNEL_OF: Record<AdChannel, LeadChannel> = {
  meta_ads: "meta",
  youtube_ads: "youtube",
  tiktok_ads: "tiktok",
};

function leadsState(read: LeadAttribution): SourceState {
  return read.ok
    ? { state: "ok" }
    : { state: "error", reason: "unknown", message: read.message, status: null };
}

/** The CRM's leads and won deals for one channel, from an attribution read. */
export interface ChannelLeads {
  all: number;
  paid: number;
  organic: number;
  total: number;
  campaigns: Array<{ campaign: string; leads: number }>;
  capped: boolean;
  deals: {
    accounts: number;
    open: number;
    won: number;
    lost: number;
    wonMrrCents: number;
    wonSetupCents: number;
  } | null;
}

function leadsFor(read: LeadAttribution, channel: LeadChannel): ChannelLeads | null {
  if (!read.ok) return null;
  return {
    all: read.summary.byChannel[channel],
    paid: read.summary.paidByChannel[channel],
    organic: read.summary.organicByChannel[channel],
    total: read.summary.total,
    campaigns: read.summary.campaigns[channel] ?? [],
    capped: read.capped,
    deals: read.dealsRead
      ? (read.deals[channel] ?? {
          accounts: 0,
          open: 0,
          won: 0,
          lost: 0,
          wonMrrCents: 0,
          wonSetupCents: 0,
        })
      : null,
  };
}

// ── YouTube: the channel ──────────────────────────────────────────────────────

export interface YouTubeOverview {
  sources: { data: SourceState; analytics: SourceState; history: SourceState; leads: SourceState };
  channel: YouTubeChannelInfo | null;
  uploads: { inRange: number; perWeek: number | null; videos: EntityRow[] };
  recent: EntityRow[];
  analytics: {
    totals: MetricSet | null;
    previousTotals: MetricSet | null;
    comparison: PeriodComparisonRow[];
    daily: DailyPoint[];
    trafficSources: TrafficSourceRow[];
    topVideos: Array<
      TopVideoRow & { title: string | null; thumbnailUrl: string | null; url: string }
    >;
  } | null;
  growth: ChannelGrowth & { readingsInWindow: number };
  netSubscribers: {
    value: number | null;
    basis: "analytics" | "readings";
    spanDays: number | null;
  } | null;
  leads: ChannelLeads | null;
  signals: ChannelSignal[];
  quotaUnits: number;
}

export async function buildYouTubeOverview(
  range: DateRange,
  today: string,
  timeZone: string,
): Promise<YouTubeOverview> {
  const [channelRead, analytics, leads] = await Promise.all([
    readYouTubeChannel(range, timeZone),
    readYouTubeAnalytics(range),
    readLeadAttribution(range, timeZone),
  ]);
  const channel = channelRead.channel;

  let historyState: SourceState = { state: "not_requested" };
  let readings: ChannelCounterReading[] = [];
  if (channel) {
    const write = await upsertSnapshots([channelReadingRow(channel, today, "page_view")]);
    try {
      const rows = await readSnapshots(["youtube_channel"], addDays(range.since, -1), range.until);
      readings = rows
        .filter((r) => r.account_ref === channel.id)
        .map((r) => {
          const m = (r.metrics ?? {}) as Record<string, unknown>;
          const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
          return {
            date: r.snapshot_date,
            subscribers: num(m.subscribers),
            totalViews: num(m.totalViews),
            videoCount: num(m.videoCount),
          };
        });
      historyState = write.ok
        ? { state: "ok" }
        : { state: "error", reason: "unknown", message: write.message, status: null };
    } catch (error) {
      historyState = {
        state: "error",
        reason: "unknown",
        message: `The recorded readings could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
        status: null,
      };
    }
  }
  const growth = channelGrowth(readings, range, addDays(range.since, -1));
  const inRange = uploadsInRange(channelRead.videos, range, timeZone);
  const titleOf = new Map<string, YouTubeVideo>(channelRead.videos.map((v) => [v.id, v]));

  let netSubscribers: YouTubeOverview["netSubscribers"] = null;
  if (analytics.totals) {
    netSubscribers = {
      value: deriveRates(analytics.totals).netFollows,
      basis: "analytics",
      spanDays: dayCount(range),
    };
  } else if (growth.netSubscribers !== null) {
    netSubscribers = { value: growth.netSubscribers, basis: "readings", spanDays: growth.spanDays };
  }

  const signals = detectYouTubeChannelSignals({
    uploads: channelRead.videos,
    today,
    timeZone,
    netSubscribers: netSubscribers?.value ?? null,
    netSubscribersSpanDays: netSubscribers?.spanDays ?? null,
  });

  return {
    sources: {
      data: channelRead.state,
      analytics: analytics.state,
      history: historyState,
      leads: leadsState(leads),
    },
    channel,
    uploads: {
      inRange: inRange.length,
      perWeek: uploadsPerWeek(inRange.length, dayCount(range)),
      videos: inRange.map(youtubeVideoEntity),
    },
    recent: channelRead.videos.slice(0, RECENT_UPLOAD_COUNT).map(youtubeVideoEntity),
    analytics:
      analytics.state.state === "ok"
        ? {
            totals: analytics.totals,
            previousTotals: analytics.previousTotals,
            comparison:
              analytics.totals && analytics.previousTotals
                ? comparePeriods(analytics.totals, analytics.previousTotals)
                : [],
            daily: analytics.daily,
            trafficSources: analytics.trafficSources,
            topVideos: analytics.topVideos.map((t) => ({
              ...t,
              title: titleOf.get(t.videoId)?.title ?? null,
              thumbnailUrl: titleOf.get(t.videoId)?.thumbnailUrl ?? null,
              url: `https://www.youtube.com/watch?v=${encodeURIComponent(t.videoId)}`,
            })),
          }
        : null,
    growth: { ...growth, readingsInWindow: readings.length },
    netSubscribers,
    leads: leadsFor(leads, "youtube"),
    signals,
    quotaUnits: channelRead.quotaUnits,
  };
}

// ── Advertising ───────────────────────────────────────────────────────────────

export interface AdChannelView extends AdAnalysis {
  channel: AdChannel;
  level: AdLevel;
  sources: { ads: SourceState; leads: SourceState };
  report: ChannelReport | null;
  previousTotals: MetricSet | null;
  pacing: MonthPacing | null;
  campaigns: Array<{
    id: string;
    name: string | null;
    status: string | null;
    objective: string | null;
    budget: number | null;
    budgetKind: "daily" | "lifetime" | "none";
  }>;
  leads: ChannelLeads | null;
}

function campaignLines(
  channel: AdChannel,
  campaigns: readonly (TikTokCampaignInfo | MetaCampaignInfo)[],
): AdChannelView["campaigns"] {
  if (channel === "tiktok_ads") {
    return (campaigns as TikTokCampaignInfo[]).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      budget: c.budget,
      budgetKind:
        c.budgetMode === "BUDGET_MODE_DAY"
          ? "daily"
          : c.budgetMode === "BUDGET_MODE_TOTAL"
            ? "lifetime"
            : "none",
    }));
  }
  return (campaigns as MetaCampaignInfo[]).map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    objective: c.objective,
    budget: c.dailyBudget ?? c.lifetimeBudget,
    budgetKind: c.dailyBudget !== null ? "daily" : c.lifetimeBudget !== null ? "lifetime" : "none",
  }));
}

export async function buildAdChannel(args: {
  channel: AdChannel;
  range: DateRange;
  preset: DatePreset | null;
  today: string;
  timeZone: string;
  level: AdLevel;
  drill: Drill;
}): Promise<AdChannelView> {
  const { channel, range, level, drill } = args;
  const [read, leads] = await Promise.all([
    channel === "meta_ads"
      ? readMetaAds(range, level, drill)
      : channel === "tiktok_ads"
        ? readTikTokAds(range, level, drill)
        : readYouTubeAds(range, level, drill).then((r) => ({
            ...r,
            campaigns: [] as TikTokCampaignInfo[],
          })),
    readLeadAttribution(range, args.timeZone),
  ]);
  const campaigns = campaignLines(channel, read.campaigns);
  const budgets = campaigns
    .filter((c) => c.budgetKind === "daily")
    .map((c) => ({
      dailyBudget: c.budget,
      running: channel === "tiktok_ads" ? tiktokRunning(c.status) : metaRunning(c.status),
    }));
  return {
    channel,
    level,
    sources: { ads: read.state, leads: leadsState(leads) },
    report: read.report,
    previousTotals: read.previousTotals,
    ...adAnalysis(read.report, read.previousTotals),
    // Google Ads exposes campaign budgets through a different resource; it has
    // no pacing here rather than a pacing computed from no budget.
    pacing:
      channel === "youtube_ads" ? null : pacingFor(read.report, args.preset, args.today, budgets),
    campaigns,
    leads: leadsFor(leads, LEAD_CHANNEL_OF[channel]),
  };
}

// ── History ───────────────────────────────────────────────────────────────────

export interface HistorySeries {
  channel: SnapshotChannel;
  accountRef: string;
  currency: string | null;
  /** An advertising day's metrics, or a YouTube reading's counters (numbers only). */
  points: Array<{ date: string; metrics: MetricSet | Record<string, number | null> }>;
}

/** A YouTube reading's stored counters, numbers only: anything else is unmeasured. */
function counters(stored: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (stored && typeof stored === "object") {
    for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
      out[k] = typeof v === "number" && Number.isFinite(v) ? v : null;
    }
  }
  return out;
}

export async function buildHistory(
  range: DateRange,
  timeZone: string,
): Promise<{
  sources: { history: SourceState; leads: SourceState };
  series: HistorySeries[];
  attribution: LeadAttribution;
}> {
  const channels: SnapshotChannel[] = ["meta_ads", "youtube_ads", "tiktok_ads", "youtube_channel"];
  const attribution = await readLeadAttribution(range, timeZone, { recent: 50 });
  try {
    const rows = await readSnapshots(channels, range.since, range.until);
    const byKey = new Map<string, HistorySeries>();
    for (const row of rows) {
      const key = `${row.channel}:${row.account_ref}`;
      const slot = byKey.get(key) ?? {
        channel: row.channel,
        accountRef: row.account_ref,
        currency: row.currency,
        points: [],
      };
      slot.points.push({
        date: row.snapshot_date,
        metrics:
          row.channel === "youtube_channel"
            ? counters(row.metrics)
            : metricsFromStorage(row.metrics),
      });
      if (!slot.currency && row.currency) slot.currency = row.currency;
      byKey.set(key, slot);
    }
    return {
      sources: { history: { state: "ok" }, leads: leadsState(attribution) },
      series: [...byKey.values()],
      attribution,
    };
  } catch (error) {
    return {
      sources: {
        history: {
          state: "error",
          reason: "unknown",
          message: `The recorded history could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
          status: null,
        },
        leads: leadsState(attribution),
      },
      series: [],
      attribution,
    };
  }
}
