/**
 * The YouTube Analytics API v2: what a channel did INSIDE a range.
 *
 * This is the half the Data API cannot answer — views, watch time and
 * subscribers gained or lost per day, where the views came from, and which
 * uploads earned them. It needs the channel owner's consent: an OAuth refresh
 * token minted with the `yt-analytics.readonly` scope, exchanged for an access
 * token on every read (`googleApi.pure.ts`).
 *
 * Only ADDITIVE metrics are asked for per day. YouTube's own
 * `averageViewDuration` is an average and cannot be summed across days, so the
 * engine derives it from minutes watched and views after summing.
 *
 * YouTube publishes analytics with a lag of up to about three days, so the
 * newest days of a range are often absent from the answer. They are left
 * absent: a day YouTube has not processed yet is not a day with no views.
 */
import type { DailyPoint, DateRange, Measured, SourceErrorReason } from './marketingTypes.pure.ts';
import { emptyMetrics, readNumber } from './marketingMetrics.pure.ts';
import { isValidYmd } from './marketingRange.pure.ts';
import { googleErrorOf } from './googleApi.pure.ts';
import { queryString, type VendorRequest } from './vendorRequest.pure.ts';

export const YOUTUBE_ANALYTICS_REPORTS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';
export const YOUTUBE_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';

/** Per-day metrics, every one of them additive. */
export const YOUTUBE_DAILY_METRICS = [
  'views',
  'estimatedMinutesWatched',
  'likes',
  'comments',
  'shares',
  'subscribersGained',
  'subscribersLost',
] as const;

/** How long YouTube may take to publish a day's analytics. */
export const YOUTUBE_ANALYTICS_LAG_DAYS = 3;

export interface AnalyticsQuery {
  range: DateRange;
  metrics: readonly string[];
  dimensions?: string;
  sort?: string;
  maxResults?: number;
  filters?: string;
}

export function youtubeAnalyticsRequest(accessToken: string, query: AnalyticsQuery): VendorRequest {
  return {
    method: 'GET',
    url: `${YOUTUBE_ANALYTICS_REPORTS_URL}${queryString({
      ids: 'channel==MINE',
      startDate: query.range.since,
      endDate: query.range.until,
      metrics: query.metrics.join(','),
      dimensions: query.dimensions,
      sort: query.sort,
      maxResults: query.maxResults,
      filters: query.filters,
    })}`,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  };
}

export const youtubeDailyQuery = (range: DateRange): AnalyticsQuery => ({
  range,
  metrics: YOUTUBE_DAILY_METRICS,
  dimensions: 'day',
  sort: 'day',
});

export const youtubeTrafficSourceQuery = (range: DateRange): AnalyticsQuery => ({
  range,
  metrics: ['views', 'estimatedMinutesWatched'],
  dimensions: 'insightTrafficSourceType',
  sort: '-views',
});

export const youtubeTopVideosQuery = (range: DateRange, maxResults = 10): AnalyticsQuery => ({
  range,
  metrics: ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'subscribersGained', 'likes'],
  dimensions: 'video',
  sort: '-views',
  maxResults,
});

/** YouTube's result table: named columns and positional rows. */
export interface ResultTable {
  columns: string[];
  rows: unknown[][];
}

export function parseResultTable(
  status: number,
  body: unknown,
): { ok: true; table: ResultTable } | { ok: false; reason: SourceErrorReason; message: string; status: number } {
  if (status < 200 || status >= 300) {
    const { reason, message } = googleErrorOf(status, body);
    return { ok: false, reason, message, status };
  }
  const b = (body ?? {}) as { columnHeaders?: unknown; rows?: unknown };
  if (!Array.isArray(b.columnHeaders)) {
    return { ok: false, reason: 'unreadable_answer', message: 'YouTube Analytics answered without column headers.', status };
  }
  const columns = b.columnHeaders.map((h) => String((h as { name?: unknown })?.name ?? ''));
  // No rows at all is YouTube's way of saying the range held no activity.
  const rows = Array.isArray(b.rows) ? (b.rows.filter((r) => Array.isArray(r)) as unknown[][]) : [];
  return { ok: true, table: { columns, rows } };
}

/** The table's rows as records keyed by column name. */
export function tableRecords(table: ResultTable): Record<string, unknown>[] {
  return table.rows.map((row) => {
    const rec: Record<string, unknown> = {};
    table.columns.forEach((c, i) => {
      rec[c] = row[i];
    });
    return rec;
  });
}

/** The per-day series, oldest first, for days YouTube has published. */
export function youtubeDailySeries(table: ResultTable): DailyPoint[] {
  const out: DailyPoint[] = [];
  for (const rec of tableRecords(table)) {
    const day = rec.day;
    if (!isValidYmd(day)) continue;
    const m = emptyMetrics();
    m.views = readNumber(rec.views);
    m.watchTimeMinutes = readNumber(rec.estimatedMinutesWatched);
    m.likes = readNumber(rec.likes);
    m.comments = readNumber(rec.comments);
    m.shares = readNumber(rec.shares);
    m.follows = readNumber(rec.subscribersGained);
    m.unfollows = readNumber(rec.subscribersLost);
    out.push({ date: day, metrics: m });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** YouTube's traffic source types in the words YouTube Studio uses. */
export const YOUTUBE_TRAFFIC_SOURCE_LABELS: Record<string, string> = {
  ADVERTISING: 'YouTube advertising',
  ANNOTATION: 'Annotations',
  CAMPAIGN_CARD: 'Campaign cards',
  END_SCREEN: 'End screens',
  EXT_URL: 'External websites and apps',
  HASHTAGS: 'Hashtag pages',
  IMMERSIVE_LIVE: 'Immersive live',
  LIVE_REDIRECT: 'Live redirects',
  NO_LINK_EMBEDDED: 'Embedded players',
  NO_LINK_OTHER: 'Direct or unknown',
  NOTIFICATION: 'Notifications',
  PLAYLIST: 'Playlists',
  PRODUCT_PAGE: 'Product pages',
  PROMOTED: 'Promoted by YouTube',
  RELATED_VIDEO: 'Suggested videos',
  SHORTS: 'Shorts feed',
  SHORTS_CONTENT_LINKS: 'Shorts content links',
  SOUND_PAGE: 'Sound pages',
  SUBSCRIBER: 'Browse features',
  VIDEO_REMIXES: 'Remixes',
  YT_CHANNEL: 'Channel pages',
  YT_OTHER_PAGE: 'Other YouTube features',
  YT_PLAYLIST_PAGE: 'Playlist pages',
  YT_SEARCH: 'YouTube search',
};

/** An unknown source type is shown in plain words rather than dropped. */
export function trafficSourceLabel(key: string): string {
  return YOUTUBE_TRAFFIC_SOURCE_LABELS[key]
    ?? key.toLowerCase().split('_').filter(Boolean).map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

export interface TrafficSourceRow {
  key: string;
  label: string;
  views: Measured;
  watchTimeMinutes: Measured;
  /** Share of all views in the table, as a fraction. */
  share: Measured;
}

export function youtubeTrafficSources(table: ResultTable): TrafficSourceRow[] {
  const recs = tableRecords(table);
  const rows = recs
    .filter((r) => typeof r.insightTrafficSourceType === 'string')
    .map((r) => ({
      key: String(r.insightTrafficSourceType),
      label: trafficSourceLabel(String(r.insightTrafficSourceType)),
      views: readNumber(r.views),
      watchTimeMinutes: readNumber(r.estimatedMinutesWatched),
      share: null as Measured,
    }));
  const total = rows.reduce((s, r) => s + (r.views ?? 0), 0);
  for (const r of rows) r.share = total > 0 && r.views !== null ? r.views / total : null;
  return rows.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
}

export interface TopVideoRow {
  videoId: string;
  views: Measured;
  watchTimeMinutes: Measured;
  averageViewDurationSeconds: Measured;
  subscribersGained: Measured;
  likes: Measured;
}

export function youtubeTopVideos(table: ResultTable): TopVideoRow[] {
  return tableRecords(table)
    .filter((r) => typeof r.video === 'string' && r.video !== '')
    .map((r) => ({
      videoId: String(r.video),
      views: readNumber(r.views),
      watchTimeMinutes: readNumber(r.estimatedMinutesWatched),
      averageViewDurationSeconds: readNumber(r.averageViewDuration),
      subscribersGained: readNumber(r.subscribersGained),
      likes: readNumber(r.likes),
    }));
}
