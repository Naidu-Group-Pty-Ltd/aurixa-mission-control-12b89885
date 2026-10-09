/**
 * TikTok advertising, read through the TikTok API for Business (v1.3).
 *
 * WHAT WAS CHECKED BEFORE THIS WAS WRITTEN (8 Oct 2026)
 * ----------------------------------------------------
 * The report endpoint is `GET /open_api/v1.3/report/integrated/get/`, and its
 * metric names are the ones TikTok's official SDK and a production connector
 * (Airbyte's `source-tiktok-marketing`) send: `spend`, `impressions`, `reach`,
 * `clicks`, `video_play_actions`, `video_watched_2s`, `video_watched_6s`,
 * `average_video_play`, `video_views_p25…p100`, `likes`, `comments`,
 * `shares`, `follows`, `profile_visits`, `conversion`, `result`. A metric name
 * TikTok does not recognise fails the WHOLE report, so nothing speculative is
 * asked for.
 *
 * Four behaviours shape the code:
 *
 * - **HTTP 200 is not success.** TikTok answers almost every refusal with
 *   HTTP 200 and `code != 0` in the body. `judgeTikTokBody` is what lets the
 *   meter record those as errors rather than as billable successes.
 * - **A daily report may span at most 30 days.** A longer range is asked for
 *   in 30-day pieces (`splitRange`) and the pieces are joined.
 * - **Reach is not additive across days.** It is asked for over the whole
 *   range, per entity, and never summed from daily rows.
 * - **Deleted campaigns still spent money.** Entity reports carry the
 *   `STATUS_ALL` filter so a campaign deleted mid-month does not vanish from
 *   the month's spend.
 *
 * The advertiser token is long-lived (TikTok's advertiser authorisation issues
 * no refresh token). It travels in the `Access-Token` header.
 */
import type { ChannelReport, DailyPoint, DateRange, EntityLevel, EntityRow, MetricKey, MetricSet, SourceErrorReason } from './marketingTypes.pure.ts';
import { emptyMetrics, mergeDaily, readNumber, sumMetrics } from './marketingMetrics.pure.ts';
import { rangeContains } from './marketingRange.pure.ts';
import { queryString, safeVendorMessage, type VendorRequest } from './vendorRequest.pure.ts';

export const TIKTOK_BUSINESS_API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';

export type TikTokLevel = 'campaign' | 'adgroup' | 'ad';

export const TIKTOK_DATA_LEVEL: Record<TikTokLevel | 'advertiser', string> = {
  advertiser: 'AUCTION_ADVERTISER',
  campaign: 'AUCTION_CAMPAIGN',
  adgroup: 'AUCTION_ADGROUP',
  ad: 'AUCTION_AD',
};

/** TikTok's limit on a report that has `stat_time_day` as a dimension. */
export const TIKTOK_MAX_DAYS_PER_DAILY_REPORT = 30;
export const TIKTOK_PAGE_SIZE = 1000;
export const TIKTOK_MAX_PAGES = 10;

/** Delivery and video metrics, valid at every level. */
export const TIKTOK_DELIVERY_METRICS = [
  'spend',
  'impressions',
  'clicks',
  'video_play_actions',
  'video_watched_2s',
  'video_watched_6s',
  'average_video_play',
  'video_views_p25',
  'video_views_p50',
  'video_views_p75',
  'video_views_p100',
  'likes',
  'comments',
  'shares',
  'follows',
  'profile_visits',
  'conversion',
  'result',
] as const;

/** Names and parents, which TikTok returns as metrics. */
export const TIKTOK_ATTRIBUTE_METRICS: Record<TikTokLevel, readonly string[]> = {
  campaign: ['campaign_name'],
  adgroup: ['adgroup_name', 'campaign_id', 'campaign_name'],
  ad: ['ad_name', 'adgroup_id', 'adgroup_name', 'campaign_id', 'campaign_name'],
};

const ID_DIMENSION: Record<TikTokLevel | 'advertiser', string> = {
  advertiser: 'advertiser_id',
  campaign: 'campaign_id',
  adgroup: 'adgroup_id',
  ad: 'ad_id',
};

const STATUS_FIELD: Record<TikTokLevel, string> = {
  campaign: 'campaign_status',
  adgroup: 'adgroup_status',
  ad: 'ad_status',
};

/** The metrics this source can measure. */
export const TIKTOK_MEASURES: readonly MetricKey[] = [
  'spend',
  'impressions',
  'reach',
  'clicks',
  'views',
  'videoPlays',
  'views2s',
  'views6s',
  'quartile25',
  'quartile50',
  'quartile75',
  'quartile100',
  'watchTimeMinutes',
  'likes',
  'comments',
  'shares',
  'follows',
  'profileVisits',
  'conversions',
  'results',
];

/** An advertiser id is a long number. Anything else is refused before it reaches a URL. */
export function isTikTokId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{5,25}$/.test(value.trim());
}

function headers(accessToken: string): Record<string, string> {
  return { 'Access-Token': accessToken, Accept: 'application/json' };
}

/** The advertiser's own account: its name, currency and time zone. */
export function tiktokAdvertiserInfoRequest(advertiserId: string, accessToken: string): VendorRequest {
  return {
    method: 'GET',
    url: `${TIKTOK_BUSINESS_API_BASE}/advertiser/info/${queryString({ advertiser_ids: [advertiserId] })}`,
    headers: headers(accessToken),
  };
}

/** Campaign settings: status, objective, budget. */
export function tiktokCampaignsRequest(advertiserId: string, accessToken: string, page = 1): VendorRequest {
  return {
    method: 'GET',
    url: `${TIKTOK_BUSINESS_API_BASE}/campaign/get/${queryString({ advertiser_id: advertiserId, page, page_size: 100 })}`,
    headers: headers(accessToken),
  };
}

export interface TikTokReportQuery {
  advertiserId: string;
  level: TikTokLevel | 'advertiser';
  range: DateRange;
  /** Add `stat_time_day`: one row per entity per day. Ranges over 30 days must be split first. */
  daily: boolean;
  page?: number;
  /** Narrow an ad group or ad report to one campaign. */
  campaignId?: string | null;
  /** Narrow an ad report to one ad group. */
  adGroupId?: string | null;
}

export function tiktokReportRequest(query: TikTokReportQuery, accessToken: string): VendorRequest {
  const dimensions = [ID_DIMENSION[query.level]];
  if (query.daily) dimensions.push('stat_time_day');
  const metrics: string[] = [...TIKTOK_DELIVERY_METRICS];
  // Reach is unique people; summing it across days double-counts them.
  if (!query.daily) metrics.push('reach');
  if (query.level !== 'advertiser') metrics.push(...TIKTOK_ATTRIBUTE_METRICS[query.level]);

  const filtering: Array<{ field_name: string; filter_type: string; filter_value: string }> = [];
  if (query.level !== 'advertiser') {
    filtering.push({ field_name: STATUS_FIELD[query.level], filter_type: 'IN', filter_value: JSON.stringify(['STATUS_ALL']) });
    if (isTikTokId(query.campaignId ?? undefined) && query.level !== 'campaign') {
      filtering.push({ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify([query.campaignId]) });
    }
    if (isTikTokId(query.adGroupId ?? undefined) && query.level === 'ad') {
      filtering.push({ field_name: 'adgroup_ids', filter_type: 'IN', filter_value: JSON.stringify([query.adGroupId]) });
    }
  }

  return {
    method: 'GET',
    url: `${TIKTOK_BUSINESS_API_BASE}/report/integrated/get/${queryString({
      advertiser_id: query.advertiserId,
      service_type: 'AUCTION',
      report_type: 'BASIC',
      data_level: TIKTOK_DATA_LEVEL[query.level],
      dimensions,
      metrics,
      start_date: query.range.since,
      end_date: query.range.until,
      page: query.page ?? 1,
      page_size: TIKTOK_PAGE_SIZE,
      filtering: filtering.length > 0 ? filtering : undefined,
    })}`,
    headers: headers(accessToken),
  };
}

/** For the meter: a TikTok answer is an error when its body says so, whatever the HTTP status. */
export function judgeTikTokBody(body: unknown): 'success' | 'error' | null {
  const code = (body as { code?: unknown } | null)?.code;
  if (typeof code !== 'number') return null;
  return code === 0 ? 'success' : 'error';
}

const RATE_CODES = new Set([40016, 40100, 40133]);
const CREDENTIAL_CODES = new Set([40101, 40102, 40103, 40104, 40105]);
const VENDOR_CODES = new Set([50000, 51002, 51004, 51041, 60001]);

/** What a TikTok error code means for the person who has to act on it. */
export function tiktokErrorReason(code: number, httpStatus: number): SourceErrorReason {
  if (RATE_CODES.has(code) || httpStatus === 429) return 'rate_limited';
  if (CREDENTIAL_CODES.has(code) || httpStatus === 401) return 'credentials_rejected';
  if (code === 40001) return 'permission_denied';
  if (code === 40002) return 'not_found';
  if (VENDOR_CODES.has(code) || (code >= 50000 && code < 70000) || httpStatus >= 500) return 'vendor_unavailable';
  if (code >= 40000 && code < 50000) return 'request_rejected';
  return 'unknown';
}

export type TikTokEnvelope =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: SourceErrorReason; message: string; code: number | null; status: number };

/** Unwrap `{ code, message, data }`. HTTP 200 with a non-zero code is a refusal. */
export function parseTikTokEnvelope(status: number, body: unknown): TikTokEnvelope {
  const b = (body ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
  const code = typeof b.code === 'number' ? b.code : null;
  if (status >= 200 && status < 300 && code === 0) {
    return { ok: true, data: b.data && typeof b.data === 'object' ? (b.data as Record<string, unknown>) : {} };
  }
  const message = safeVendorMessage(b.message) || `TikTok answered HTTP ${status}${code !== null ? ` with code ${code}` : ''}.`;
  if (code === null) {
    const reason: SourceErrorReason = status >= 500 ? 'vendor_unavailable' : status === 429 ? 'rate_limited' : status === 401 ? 'credentials_rejected' : status >= 400 ? 'request_rejected' : 'unreadable_answer';
    return { ok: false, reason, message, code, status };
  }
  return { ok: false, reason: tiktokErrorReason(code, status), message, code, status };
}

export interface TikTokReportRow {
  dimensions: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

export function parseTikTokReportPage(data: Record<string, unknown>): { rows: TikTokReportRow[]; totalPages: number | null } {
  const list = Array.isArray(data.list) ? data.list : [];
  const rows: TikTokReportRow[] = [];
  for (const item of list) {
    const r = (item ?? {}) as Record<string, unknown>;
    rows.push({
      dimensions: (r.dimensions && typeof r.dimensions === 'object' ? r.dimensions : {}) as Record<string, unknown>,
      metrics: (r.metrics && typeof r.metrics === 'object' ? r.metrics : {}) as Record<string, unknown>,
    });
  }
  const pageInfo = (data.page_info ?? {}) as Record<string, unknown>;
  const totalPages = readNumber(pageInfo.total_page);
  return { rows, totalPages };
}

/** One report row's metrics. TikTok's `-` (suppressed) and missing fields stay null. */
export function tiktokRowMetrics(row: TikTokReportRow): MetricSet {
  const m = row.metrics;
  const out = emptyMetrics();
  out.spend = readNumber(m.spend);
  out.impressions = readNumber(m.impressions);
  out.reach = readNumber(m.reach);
  out.clicks = readNumber(m.clicks);
  out.videoPlays = readNumber(m.video_play_actions);
  // A TikTok "view" on this page is a play — TikTok's own headline video metric.
  out.views = out.videoPlays;
  out.views2s = readNumber(m.video_watched_2s);
  out.views6s = readNumber(m.video_watched_6s);
  out.quartile25 = readNumber(m.video_views_p25);
  out.quartile50 = readNumber(m.video_views_p50);
  out.quartile75 = readNumber(m.video_views_p75);
  out.quartile100 = readNumber(m.video_views_p100);
  const averagePlay = readNumber(m.average_video_play);
  out.watchTimeMinutes = averagePlay !== null && out.videoPlays !== null ? (averagePlay * out.videoPlays) / 60 : null;
  out.likes = readNumber(m.likes);
  out.comments = readNumber(m.comments);
  out.shares = readNumber(m.shares);
  out.follows = readNumber(m.follows);
  out.profileVisits = readNumber(m.profile_visits);
  out.conversions = readNumber(m.conversion);
  out.results = readNumber(m.result);
  return out;
}

/** `2026-09-01 00:00:00` → `2026-09-01`. */
export function tiktokDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = value.trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export interface TikTokCampaignInfo {
  id: string;
  name: string | null;
  objective: string | null;
  /** The vendor's own operation status word (`ENABLE`, `DISABLE`). */
  status: string | null;
  budget: number | null;
  /** `BUDGET_MODE_DAY`, `BUDGET_MODE_TOTAL` or `BUDGET_MODE_INFINITE`. */
  budgetMode: string | null;
}

export function parseTikTokCampaigns(data: Record<string, unknown>): TikTokCampaignInfo[] {
  const out: TikTokCampaignInfo[] = [];
  for (const item of Array.isArray(data.list) ? data.list : []) {
    const c = (item ?? {}) as Record<string, unknown>;
    const id = str(c.campaign_id);
    if (!id) continue;
    out.push({
      id,
      name: str(c.campaign_name),
      objective: str(c.objective_type),
      status: str(c.secondary_status) ?? str(c.operation_status),
      budget: readNumber(c.budget),
      budgetMode: str(c.budget_mode),
    });
  }
  return out;
}

export function parseTikTokAdvertiser(data: Record<string, unknown>): { name: string | null; currency: string | null; timeZone: string | null } {
  const first = (Array.isArray(data.list) ? data.list[0] : null) as Record<string, unknown> | null;
  if (!first) return { name: null, currency: null, timeZone: null };
  return { name: str(first.name), currency: str(first.currency), timeZone: str(first.timezone) ?? str(first.display_timezone) };
}

/** Rows (one per entity over the whole range) as entities, biggest spend first. */
export function tiktokEntities(
  rows: readonly TikTokReportRow[],
  level: TikTokLevel,
  campaigns: readonly TikTokCampaignInfo[] = [],
): EntityRow[] {
  const settings = new Map(campaigns.map((c) => [c.id, c]));
  const byId = new Map<string, { row: TikTokReportRow; sets: MetricSet[] }>();
  for (const row of rows) {
    const id = str(row.dimensions[ID_DIMENSION[level]]);
    if (!id) continue;
    const slot = byId.get(id) ?? { row, sets: [] };
    slot.sets.push(tiktokRowMetrics(row));
    byId.set(id, slot);
  }
  const out: EntityRow[] = [];
  for (const [id, { row, sets }] of byId) {
    const m = row.metrics;
    const campaignId = level === 'campaign' ? id : str(m.campaign_id);
    const setting = campaignId ? settings.get(campaignId) : undefined;
    const name = level === 'campaign'
      ? str(m.campaign_name) ?? setting?.name ?? `Campaign ${id}`
      : level === 'adgroup'
        ? str(m.adgroup_name) ?? `Ad group ${id}`
        : str(m.ad_name) ?? `Ad ${id}`;
    out.push({
      id,
      name,
      level: level as EntityLevel,
      parentId: level === 'campaign' ? null : level === 'adgroup' ? str(m.campaign_id) : str(m.adgroup_id),
      parentName: level === 'campaign' ? null : level === 'adgroup' ? str(m.campaign_name) : str(m.adgroup_name),
      status: level === 'campaign' ? setting?.status ?? null : null,
      objective: setting?.objective ?? null,
      metrics: sumMetrics(sets),
      publishedAt: null,
      durationSeconds: null,
      thumbnailUrl: null,
      url: null,
    });
  }
  return out.sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0));
}

/** Daily rows (any level) summed into one point per day. */
export function tiktokDaily(rows: readonly TikTokReportRow[]): DailyPoint[] {
  const points: DailyPoint[] = [];
  for (const row of rows) {
    const date = tiktokDay(row.dimensions.stat_time_day);
    if (!date) continue;
    points.push({ date, metrics: tiktokRowMetrics(row) });
  }
  return mergeDaily(points);
}

export function tiktokReport(input: {
  advertiserId: string;
  advertiserName: string | null;
  currency: string | null;
  range: DateRange;
  level: TikTokLevel;
  entityRows: readonly TikTokReportRow[];
  dailyRows: readonly TikTokReportRow[];
  /** The whole-range account row, which is the only place reach is additive. */
  accountRows: readonly TikTokReportRow[];
  campaigns: readonly TikTokCampaignInfo[];
}): ChannelReport {
  const entities = tiktokEntities(input.entityRows, input.level, input.campaigns);
  const daily = tiktokDaily(input.dailyRows).filter((p) => rangeContains(input.range, p.date));
  const accountTotals = sumMetrics(input.accountRows.map(tiktokRowMetrics));
  const dailyTotals = sumMetrics(daily.map((d) => d.metrics));
  // The account row answers the whole range in one figure; the daily rows are
  // the fallback when it is missing, with reach left unknown (not additive).
  const totals = input.accountRows.length > 0 ? accountTotals : { ...dailyTotals, reach: null };
  return {
    channel: 'tiktok_ads',
    accountRef: input.advertiserId,
    accountName: input.advertiserName,
    currency: input.currency,
    range: input.range,
    totals,
    daily,
    entities,
    measures: [...TIKTOK_MEASURES],
    viewDefinition: 'Video plays — every time an ad started playing, replays excluded. Two- and six-second views are shown separately.',
    notes: [
      'Results are counted against each campaign’s own optimisation goal, so a result on a lead campaign is a lead and on a traffic campaign is a click.',
      'Watch time is estimated from TikTok’s average play time multiplied by plays.',
      'Dates are in the advertiser account’s own time zone.',
    ],
  };
}
