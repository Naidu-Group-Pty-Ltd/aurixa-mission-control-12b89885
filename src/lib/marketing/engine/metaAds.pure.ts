/**
 * Meta (Facebook and Instagram) advertising, read through the Marketing API's
 * Ads Insights.
 *
 * The prime's Meta tab has its own fetch (`fetch-meta-ads`) and its own
 * analysis, and this module does not replace them. It exists so the same
 * Insights rows can be read in the engine's vocabulary — for the cross-channel
 * summary that adds Meta to YouTube and TikTok, and for Mission Control, which
 * reads Aurixa's own Meta account through this module alone.
 *
 * Three things about Insights that the arithmetic depends on:
 *
 * - **Leads are an action, not a column.** `actions` is a list of
 *   `{ action_type, value }`. Meta's `lead` action is already the total across
 *   instant forms and the pixel, so adding `offsite_conversion.fb_pixel_lead`
 *   to it counts the same lead twice. The result is the FIRST action type
 *   present from an ordered list, never a sum of several.
 * - **Budgets are in minor units.** `daily_budget: "5000"` on an AUD account
 *   is $50.00. Zero-decimal currencies (JPY, KRW, …) are not divided.
 * - **Spend is a decimal string in major units**, unlike Google's micros.
 *
 * Versions: v21.0 — which the prime's own `fetch-meta-ads` still names — left
 * Meta's Marketing API support on 9 Sep 2025 (Meta's changelog, read 8 Oct
 * 2026). This module defaults to v25.0 and takes the version as a parameter.
 */
import type { ChannelReport, DailyPoint, DateRange, EntityLevel, EntityRow, MetricKey, MetricSet, SourceErrorReason } from './marketingTypes.pure.ts';
import { emptyMetrics, mergeDaily, readNumber, sumMetrics } from './marketingMetrics.pure.ts';
import { isValidYmd, rangeContains } from './marketingRange.pure.ts';
import { queryString, safeVendorMessage, type VendorRequest } from './vendorRequest.pure.ts';

export const META_GRAPH_BASE = 'https://graph.facebook.com';
export const META_DEFAULT_VERSION = 'v25.0';
export const META_PAGE_LIMIT = 500;
export const META_MAX_PAGES = 10;

export type MetaLevel = 'campaign' | 'adset' | 'ad';

/** The action types read as a result, in order of preference. The first one present wins. */
export const META_DEFAULT_RESULT_ACTIONS: readonly string[] = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];

export const META_MEASURES: readonly MetricKey[] = [
  'spend',
  'impressions',
  'reach',
  'clicks',
  'views',
  'videoPlays',
  'quartile25',
  'quartile50',
  'quartile75',
  'quartile100',
  'watchTimeMinutes',
  'results',
  'likes',
  'comments',
  'shares',
  'follows',
];

const INSIGHT_FIELDS = [
  'spend',
  'impressions',
  'clicks',
  'actions',
  'action_values',
  'video_play_actions',
  'video_p25_watched_actions',
  'video_p50_watched_actions',
  'video_p75_watched_actions',
  'video_p100_watched_actions',
  'video_avg_time_watched_actions',
];

const LEVEL_FIELDS: Record<MetaLevel, readonly string[]> = {
  campaign: ['campaign_id', 'campaign_name'],
  adset: ['adset_id', 'adset_name', 'campaign_id', 'campaign_name'],
  ad: ['ad_id', 'ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name'],
};

export function metaVersion(value: unknown): string {
  return typeof value === 'string' && /^v\d{2}\.0$/.test(value.trim()) ? value.trim() : META_DEFAULT_VERSION;
}

/** `act_123` or `123` → `act_123`. Null for anything that is not an ad account number. */
export function normaliseAdAccountId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).trim().replace(/^act_/, '');
  return /^\d{5,25}$/.test(digits) ? `act_${digits}` : null;
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
}

export interface MetaInsightsQuery {
  adAccountId: string;
  level: MetaLevel | 'account';
  range: DateRange;
  daily: boolean;
  /** Narrow ad set or ad insights to one campaign, or ads to one ad set. */
  campaignId?: string | null;
  adSetId?: string | null;
  after?: string | null;
  version?: string;
}

export function metaInsightsRequest(query: MetaInsightsQuery, accessToken: string): VendorRequest {
  if (!isValidYmd(query.range.since) || !isValidYmd(query.range.until)) throw new Error('Meta ranges must be YYYY-MM-DD');
  const fields = [...INSIGHT_FIELDS];
  // Reach is unique people and cannot be summed across days.
  if (!query.daily) fields.push('reach');
  if (query.level !== 'account') fields.unshift(...LEVEL_FIELDS[query.level]);
  const filtering: Array<{ field: string; operator: string; value: string[] }> = [];
  if (query.campaignId && /^\d{1,25}$/.test(query.campaignId) && query.level !== 'campaign' && query.level !== 'account') {
    filtering.push({ field: 'campaign.id', operator: 'IN', value: [query.campaignId] });
  }
  if (query.adSetId && /^\d{1,25}$/.test(query.adSetId) && query.level === 'ad') {
    filtering.push({ field: 'adset.id', operator: 'IN', value: [query.adSetId] });
  }
  return {
    method: 'GET',
    url: `${META_GRAPH_BASE}/${metaVersion(query.version)}/${query.adAccountId}/insights${queryString({
      level: query.level === 'account' ? 'account' : query.level,
      fields: fields.join(','),
      time_range: { since: query.range.since, until: query.range.until },
      time_increment: query.daily ? 1 : undefined,
      limit: META_PAGE_LIMIT,
      filtering: filtering.length > 0 ? filtering : undefined,
      after: query.after || undefined,
    })}`,
    headers: authHeaders(accessToken),
  };
}

export function metaAccountRequest(adAccountId: string, accessToken: string, version?: string): VendorRequest {
  return {
    method: 'GET',
    url: `${META_GRAPH_BASE}/${metaVersion(version)}/${adAccountId}${queryString({ fields: 'name,currency,timezone_name,account_status' })}`,
    headers: authHeaders(accessToken),
  };
}

export function metaCampaignsRequest(adAccountId: string, accessToken: string, version?: string, after?: string | null): VendorRequest {
  return {
    method: 'GET',
    url: `${META_GRAPH_BASE}/${metaVersion(version)}/${adAccountId}/campaigns${queryString({
      fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget',
      limit: 200,
      after: after || undefined,
    })}`,
    headers: authHeaders(accessToken),
  };
}

/** What a Graph API error code means for the person who has to act on it. */
export function metaErrorOf(status: number, body: unknown): { reason: SourceErrorReason; message: string } {
  const err = ((body ?? {}) as { error?: Record<string, unknown> }).error ?? {};
  const code = typeof err.code === 'number' ? err.code : null;
  const subcode = typeof err.error_subcode === 'number' ? err.error_subcode : null;
  const message = safeVendorMessage(err.error_user_msg) || safeVendorMessage(err.message) || `Meta answered HTTP ${status}.`;
  if (code === 190 || code === 102 || status === 401) return { reason: 'credentials_rejected', message };
  if (code === 4 || code === 17 || code === 32 || code === 613 || (code !== null && code >= 80000 && code <= 80014) || status === 429) {
    return { reason: 'rate_limited', message };
  }
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) return { reason: 'permission_denied', message };
  if (code === 100 && subcode === 33) return { reason: 'not_found', message };
  if (code === 1 || code === 2 || status >= 500) return { reason: 'vendor_unavailable', message };
  if (status >= 400 || code !== null) return { reason: 'request_rejected', message };
  return { reason: 'unreadable_answer', message };
}

export type MetaPage =
  | { ok: true; rows: Record<string, unknown>[]; after: string | null }
  | { ok: false; reason: SourceErrorReason; message: string; status: number };

/** One page of a Graph list. The next page is read by cursor, never by following a URL Meta wrote. */
export function parseMetaPage(status: number, body: unknown): MetaPage {
  if (status < 200 || status >= 300) {
    const { reason, message } = metaErrorOf(status, body);
    return { ok: false, reason, message, status };
  }
  const b = (body ?? {}) as { data?: unknown; paging?: { cursors?: { after?: unknown }; next?: unknown } };
  const rows = Array.isArray(b.data) ? (b.data.filter((r) => r && typeof r === 'object') as Record<string, unknown>[]) : [];
  const after = typeof b.paging?.next === 'string' && typeof b.paging?.cursors?.after === 'string' ? b.paging.cursors.after : null;
  return { ok: true, rows, after };
}

function actionValue(list: unknown, type: string): number | null {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const a = (item ?? {}) as Record<string, unknown>;
    if (a.action_type === type) return readNumber(a.value);
  }
  return null;
}

/** The sum of every entry in an action list — the shape Meta uses for video play counts. */
function actionTotal(list: unknown): number | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  let total: number | null = null;
  for (const item of list) {
    const v = readNumber((item as Record<string, unknown>)?.value);
    if (v !== null) total = (total ?? 0) + v;
  }
  return total;
}

/** An Insights row in the engine's vocabulary. */
export function metaInsightMetrics(row: Record<string, unknown>, resultActions: readonly string[] = META_DEFAULT_RESULT_ACTIONS): MetricSet {
  const out = emptyMetrics();
  out.spend = readNumber(row.spend);
  out.impressions = readNumber(row.impressions);
  out.reach = readNumber(row.reach);
  out.clicks = readNumber(row.clicks);
  out.videoPlays = actionTotal(row.video_play_actions);
  // Meta's `video_view` action is its three-second view — the headline "video views" figure.
  out.views = actionValue(row.actions, 'video_view');
  out.quartile25 = actionTotal(row.video_p25_watched_actions);
  out.quartile50 = actionTotal(row.video_p50_watched_actions);
  out.quartile75 = actionTotal(row.video_p75_watched_actions);
  out.quartile100 = actionTotal(row.video_p100_watched_actions);
  const avgSeconds = actionTotal(row.video_avg_time_watched_actions);
  out.watchTimeMinutes = avgSeconds !== null && out.videoPlays !== null ? (avgSeconds * out.videoPlays) / 60 : null;
  // Only a row that carries an `actions` list measured actions at all; an
  // absent list is "not measured", a list without the type is a measured zero.
  const hasActions = Array.isArray(row.actions);
  let results: number | null = null;
  for (const type of resultActions) {
    const v = actionValue(row.actions, type);
    if (v !== null) {
      results = v;
      break;
    }
  }
  out.results = results !== null ? results : hasActions ? 0 : null;
  out.likes = hasActions ? actionValue(row.actions, 'post_reaction') ?? 0 : null;
  out.comments = hasActions ? actionValue(row.actions, 'comment') ?? 0 : null;
  out.shares = hasActions ? actionValue(row.actions, 'post') ?? 0 : null;
  out.follows = hasActions ? actionValue(row.actions, 'like') ?? 0 : null;
  return out;
}

const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);

/** A Meta budget in the account's minor units, as money. */
export function metaBudget(value: unknown, currency: string | null): number | null {
  const n = readNumber(value);
  if (n === null || n <= 0) return null;
  return currency && ZERO_DECIMAL.has(currency.toUpperCase()) ? n : n / 100;
}

export interface MetaCampaignInfo {
  id: string;
  name: string | null;
  status: string | null;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
}

export function parseMetaCampaigns(rows: readonly Record<string, unknown>[], currency: string | null): MetaCampaignInfo[] {
  return rows
    .filter((r) => typeof r.id === 'string')
    .map((r) => ({
      id: r.id as string,
      name: typeof r.name === 'string' ? r.name : null,
      status: typeof r.effective_status === 'string' ? r.effective_status : typeof r.status === 'string' ? r.status : null,
      objective: typeof r.objective === 'string' ? r.objective : null,
      dailyBudget: metaBudget(r.daily_budget, currency),
      lifetimeBudget: metaBudget(r.lifetime_budget, currency),
    }));
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const ID_FIELD: Record<MetaLevel, string> = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' };

export function metaEntities(
  rows: readonly Record<string, unknown>[],
  level: MetaLevel,
  campaigns: readonly MetaCampaignInfo[] = [],
  resultActions?: readonly string[],
): EntityRow[] {
  const settings = new Map(campaigns.map((c) => [c.id, c]));
  const byId = new Map<string, { row: Record<string, unknown>; sets: MetricSet[] }>();
  for (const row of rows) {
    const id = str(row[ID_FIELD[level]]);
    if (!id) continue;
    const slot = byId.get(id) ?? { row, sets: [] };
    slot.sets.push(metaInsightMetrics(row, resultActions));
    byId.set(id, slot);
  }
  const levelName: Record<MetaLevel, EntityLevel> = { campaign: 'campaign', adset: 'adgroup', ad: 'ad' };
  return [...byId.entries()]
    .map(([id, { row, sets }]) => {
      const campaignId = str(row.campaign_id);
      const setting = campaignId ? settings.get(campaignId) : undefined;
      const name = level === 'campaign' ? str(row.campaign_name) : level === 'adset' ? str(row.adset_name) : str(row.ad_name);
      return {
        id,
        name: name ?? `${level === 'adset' ? 'Ad set' : level === 'ad' ? 'Ad' : 'Campaign'} ${id}`,
        level: levelName[level],
        parentId: level === 'campaign' ? null : level === 'adset' ? campaignId : str(row.adset_id),
        parentName: level === 'campaign' ? null : level === 'adset' ? str(row.campaign_name) : str(row.adset_name),
        status: level === 'campaign' ? setting?.status ?? null : null,
        objective: setting?.objective ?? null,
        metrics: sumMetrics(sets),
        publishedAt: null,
        durationSeconds: null,
        thumbnailUrl: null,
        url: null,
      };
    })
    .sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0));
}

/** Rows read with `time_increment=1` (they carry `date_start`), one point per day. */
export function metaDaily(rows: readonly Record<string, unknown>[], resultActions?: readonly string[]): DailyPoint[] {
  const points: DailyPoint[] = [];
  for (const row of rows) {
    const date = row.date_start;
    if (!isValidYmd(date)) continue;
    points.push({ date, metrics: metaInsightMetrics(row, resultActions) });
  }
  return mergeDaily(points);
}

export function metaReport(input: {
  adAccountId: string;
  accountName: string | null;
  currency: string | null;
  range: DateRange;
  level: MetaLevel;
  entityRows: readonly Record<string, unknown>[];
  dailyRows: readonly Record<string, unknown>[];
  accountRows: readonly Record<string, unknown>[];
  campaigns: readonly MetaCampaignInfo[];
  resultActions?: readonly string[];
}): ChannelReport {
  const entities = metaEntities(input.entityRows, input.level, input.campaigns, input.resultActions);
  const daily = metaDaily(input.dailyRows, input.resultActions).filter((p) => rangeContains(input.range, p.date));
  const totals = input.accountRows.length > 0
    ? sumMetrics(input.accountRows.map((r) => metaInsightMetrics(r, input.resultActions)))
    : { ...sumMetrics(daily.map((d) => d.metrics)), reach: null };
  return {
    channel: 'meta_ads',
    accountRef: input.adAccountId,
    accountName: input.accountName,
    currency: input.currency,
    range: input.range,
    totals,
    daily,
    entities,
    measures: [...META_MEASURES],
    viewDefinition: 'Three-second video views (Meta’s `video_view` action).',
    notes: [
      'Results are leads: Meta’s `lead` action, which already includes instant-form and pixel leads.',
      'Dates are in the ad account’s own time zone.',
    ],
  };
}
