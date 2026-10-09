/**
 * YouTube advertising, read through the Google Ads API.
 *
 * A YouTube ad is a Google Ads campaign, so its spend is never in YouTube's
 * own APIs. This module asks Google Ads for the part of each campaign that ran
 * ON YOUTUBE — `segments.ad_network_type = 'YOUTUBE'` — which catches video
 * campaigns and the YouTube share of Demand Gen and Performance Max alike, and
 * excludes the same campaigns' search or display spend.
 *
 * MEASURED, NOT ASSUMED (8 Oct 2026, against the v25 field reference)
 * ------------------------------------------------------------------
 * - `metrics.video_views` was REMOVED in v22. A view is now
 *   `metrics.video_trueview_views`; asking for the old name is a 400 on every
 *   current version.
 * - v22 was sunset on 7 Oct 2026. The default is v25 (released July 2026,
 *   sunset scheduled for August 2027) and the version is a parameter, because
 *   Google retires one roughly every quarter and a hard-coded version is a
 *   dated outage.
 * - `segments.ad_network_type` takes `YOUTUBE` (the YouTube Search / YouTube
 *   Videos split was merged). A segment in WHERE must also be SELECTed — the
 *   date segments are the only exception — so it is selected.
 * - Video quartiles are reported as a RATE of impressions. A rate cannot be
 *   summed across days, so each row's rate is turned back into a count against
 *   that row's impressions before anything is added.
 * - Money is `cost_micros`, an integer of millionths.
 *
 * Proto3 JSON leaves out a field whose value is zero, so a SELECTED metric
 * missing from a row is a measured zero — the one place in the engine where an
 * absent field is read as 0, and only because the query named it.
 */
import type { ChannelReport, DailyPoint, DateRange, EntityLevel, EntityRow, MetricKey, MetricSet, SourceErrorReason } from './marketingTypes.pure.ts';
import { emptyMetrics, mergeDaily, readNumber, sumMetrics } from './marketingMetrics.pure.ts';
import { isValidYmd, rangeContains } from './marketingRange.pure.ts';
import { googleErrorOf } from './googleApi.pure.ts';
import type { VendorRequest } from './vendorRequest.pure.ts';

export const GOOGLE_ADS_API_BASE = 'https://googleads.googleapis.com';
export const GOOGLE_ADS_DEFAULT_VERSION = 'v25';
/** At most this many pages of results are read for one question. */
export const GOOGLE_ADS_MAX_PAGES = 10;

export type GoogleAdsLevel = 'campaign' | 'adgroup' | 'ad';

/** The metrics this source can measure. Everything else stays null. */
export const GOOGLE_ADS_MEASURES: readonly MetricKey[] = [
  'spend',
  'impressions',
  'clicks',
  'views',
  'quartile25',
  'quartile50',
  'quartile75',
  'quartile100',
  'engagements',
  'conversions',
  'conversionValue',
];

const METRIC_FIELDS = [
  'metrics.cost_micros',
  'metrics.impressions',
  'metrics.clicks',
  'metrics.video_trueview_views',
  'metrics.video_quartile_p25_rate',
  'metrics.video_quartile_p50_rate',
  'metrics.video_quartile_p75_rate',
  'metrics.video_quartile_p100_rate',
  'metrics.engagements',
  'metrics.conversions',
  'metrics.conversions_value',
];

/** `v25`, never anything an attacker could turn into a path. Anything else falls back to the default. */
export function googleAdsVersion(value: unknown): string {
  return typeof value === 'string' && /^v\d{2,3}$/.test(value.trim()) ? value.trim() : GOOGLE_ADS_DEFAULT_VERSION;
}

/** `123-456-7890` → `1234567890`. Null for anything that is not ten digits. */
export function normaliseCustomerId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/[\s-]/g, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}

/** A numeric id, safe to place inside a GAQL literal. */
function gaqlId(value: unknown): string | null {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null;
}

function dateClause(range: DateRange): string {
  if (!isValidYmd(range.since) || !isValidYmd(range.until)) throw new Error('GAQL dates must be YYYY-MM-DD');
  return `segments.date BETWEEN '${range.since}' AND '${range.until}'`;
}

/**
 * The GAQL for one level of the account, YouTube placements only.
 *
 * `withDate` adds `segments.date` so each row is one entity on one day; the
 * engine sums those rows into both the entity totals and the daily series.
 * Every value interpolated here is a validated date or a numeric id.
 */
export function youtubeAdsQuery(
  level: GoogleAdsLevel,
  range: DateRange,
  options: { withDate?: boolean; campaignId?: string | null; adGroupId?: string | null } = {},
): string {
  const select: string[] = [
    'customer.currency_code',
    'customer.descriptive_name',
    'campaign.id',
    'campaign.name',
    'campaign.status',
    'campaign.advertising_channel_type',
  ];
  let from = 'campaign';
  if (level === 'adgroup' || level === 'ad') {
    select.push('ad_group.id', 'ad_group.name', 'ad_group.status');
    from = 'ad_group';
  }
  if (level === 'ad') {
    select.push('ad_group_ad.ad.id', 'ad_group_ad.ad.name', 'ad_group_ad.status');
    from = 'ad_group_ad';
  }
  select.push('segments.ad_network_type');
  if (options.withDate) select.push('segments.date');
  select.push(...METRIC_FIELDS);

  const where = [dateClause(range), "segments.ad_network_type = 'YOUTUBE'"];
  const campaignId = gaqlId(options.campaignId ?? undefined);
  if (campaignId) where.push(`campaign.id = ${campaignId}`);
  const adGroupId = gaqlId(options.adGroupId ?? undefined);
  if (adGroupId && level === 'ad') where.push(`ad_group.id = ${adGroupId}`);

  return `SELECT ${select.join(', ')} FROM ${from} WHERE ${where.join(' AND ')}`;
}

export interface GoogleAdsCredentials {
  developerToken: string;
  customerId: string;
  /** The manager account, where the customer is reached through one. Digits only. */
  loginCustomerId?: string | null;
  accessToken: string;
}

export function googleAdsSearchRequest(
  credentials: GoogleAdsCredentials,
  query: string,
  options: { version?: string; pageToken?: string | null } = {},
): VendorRequest {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    'developer-token': credentials.developerToken,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const login = normaliseCustomerId(credentials.loginCustomerId ?? undefined);
  if (login) headers['login-customer-id'] = login;
  const body: Record<string, string> = { query };
  if (options.pageToken) body.pageToken = options.pageToken;
  return {
    method: 'POST',
    url: `${GOOGLE_ADS_API_BASE}/${googleAdsVersion(options.version)}/customers/${credentials.customerId}/googleAds:search`,
    headers,
    body: JSON.stringify(body),
  };
}

export function parseGoogleAdsSearch(
  status: number,
  body: unknown,
): { ok: true; rows: Record<string, unknown>[]; nextPageToken: string | null } | { ok: false; reason: SourceErrorReason; message: string; status: number } {
  if (status < 200 || status >= 300) {
    const { reason, message } = googleErrorOf(status, body);
    return { ok: false, reason, message, status };
  }
  const b = (body ?? {}) as { results?: unknown; nextPageToken?: unknown };
  const rows = Array.isArray(b.results) ? (b.results.filter((r) => r && typeof r === 'object') as Record<string, unknown>[]) : [];
  const next = typeof b.nextPageToken === 'string' && b.nextPageToken !== '' ? b.nextPageToken : null;
  return { ok: true, rows, nextPageToken: next };
}

/** A selected Google Ads count: absent means zero, because the query asked for it. */
function selected(value: unknown): number {
  return readNumber(value) ?? 0;
}

/** Rates come as fractions; a value above 1 can only be a percentage and is read as one. */
function fraction(value: unknown): number {
  const n = selected(value);
  return n > 1 ? n / 100 : n;
}

/** One row's metrics as counts. */
export function googleAdsRowMetrics(row: Record<string, unknown>): MetricSet {
  const m = (row.metrics ?? {}) as Record<string, unknown>;
  const impressions = selected(m.impressions);
  const out = emptyMetrics();
  out.spend = selected(m.costMicros) / 1_000_000;
  out.impressions = impressions;
  out.clicks = selected(m.clicks);
  out.views = selected(m.videoTrueviewViews);
  out.quartile25 = fraction(m.videoQuartileP25Rate) * impressions;
  out.quartile50 = fraction(m.videoQuartileP50Rate) * impressions;
  out.quartile75 = fraction(m.videoQuartileP75Rate) * impressions;
  out.quartile100 = fraction(m.videoQuartileP100Rate) * impressions;
  out.engagements = selected(m.engagements);
  out.conversions = selected(m.conversions);
  out.conversionValue = selected(m.conversionsValue);
  return out;
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function entityOf(row: Record<string, unknown>, level: GoogleAdsLevel): Omit<EntityRow, 'metrics'> | null {
  const campaign = (row.campaign ?? {}) as Record<string, unknown>;
  const adGroup = (row.adGroup ?? {}) as Record<string, unknown>;
  const adGroupAd = (row.adGroupAd ?? {}) as Record<string, unknown>;
  const ad = (adGroupAd.ad ?? {}) as Record<string, unknown>;
  const base = { publishedAt: null, durationSeconds: null, thumbnailUrl: null, url: null };
  if (level === 'campaign') {
    const id = str(campaign.id);
    if (!id) return null;
    return {
      ...base,
      id,
      name: str(campaign.name) ?? `Campaign ${id}`,
      level: 'campaign' as EntityLevel,
      parentId: null,
      parentName: null,
      status: str(campaign.status),
      objective: str(campaign.advertisingChannelType),
    };
  }
  if (level === 'adgroup') {
    const id = str(adGroup.id);
    if (!id) return null;
    return {
      ...base,
      id,
      name: str(adGroup.name) ?? `Ad group ${id}`,
      level: 'adgroup' as EntityLevel,
      parentId: str(campaign.id),
      parentName: str(campaign.name),
      status: str(adGroup.status),
      objective: str(campaign.advertisingChannelType),
    };
  }
  const id = str(ad.id);
  if (!id) return null;
  return {
    ...base,
    id,
    name: str(ad.name) ?? `Ad ${id}`,
    level: 'ad' as EntityLevel,
    parentId: str(adGroup.id),
    parentName: str(adGroup.name),
    status: str(adGroupAd.status),
    objective: str(campaign.advertisingChannelType),
  };
}

/** Rows (one per entity, or one per entity per day) summed into one row per entity, biggest spend first. */
export function googleAdsEntities(rows: readonly Record<string, unknown>[], level: GoogleAdsLevel, range?: DateRange): EntityRow[] {
  const byId = new Map<string, { entity: Omit<EntityRow, 'metrics'>; sets: MetricSet[] }>();
  for (const row of rows) {
    if (range) {
      const date = ((row.segments ?? {}) as Record<string, unknown>).date;
      if (typeof date === 'string' && !rangeContains(range, date)) continue;
    }
    const entity = entityOf(row, level);
    if (!entity) continue;
    const slot = byId.get(entity.id) ?? { entity, sets: [] };
    slot.sets.push(googleAdsRowMetrics(row));
    byId.set(entity.id, slot);
  }
  return [...byId.values()]
    .map(({ entity, sets }) => ({ ...entity, metrics: sumMetrics(sets) }))
    .sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0));
}

/** Rows carrying `segments.date`, summed into one point per day. Rows without a date are ignored. */
export function googleAdsDaily(rows: readonly Record<string, unknown>[]): DailyPoint[] {
  const points: DailyPoint[] = [];
  for (const row of rows) {
    const date = ((row.segments ?? {}) as Record<string, unknown>).date;
    if (!isValidYmd(date)) continue;
    points.push({ date, metrics: googleAdsRowMetrics(row) });
  }
  return mergeDaily(points);
}

/** The account's currency and name, from whichever row carries them. */
export function googleAdsAccount(rows: readonly Record<string, unknown>[]): { currency: string | null; name: string | null } {
  for (const row of rows) {
    const c = (row.customer ?? {}) as Record<string, unknown>;
    const currency = str(c.currencyCode);
    if (currency) return { currency, name: str(c.descriptiveName) };
  }
  return { currency: null, name: null };
}

/** The report a page draws, from the entity rows and the daily rows. */
export function googleAdsReport(input: {
  customerId: string;
  range: DateRange;
  level: GoogleAdsLevel;
  entityRows: readonly Record<string, unknown>[];
  dailyRows: readonly Record<string, unknown>[];
}): ChannelReport {
  const entities = googleAdsEntities(input.entityRows, input.level, input.range);
  const daily = googleAdsDaily(input.dailyRows).filter((p) => rangeContains(input.range, p.date));
  const account = googleAdsAccount([...input.entityRows, ...input.dailyRows]);
  // Totals come from the daily rows where there are any: entity rows at the ad
  // level can omit an ad Google no longer returns, the account's days cannot.
  const totals = daily.length > 0 ? sumMetrics(daily.map((d) => d.metrics)) : sumMetrics(entities.map((e) => e.metrics));
  return {
    channel: 'youtube_ads',
    accountRef: input.customerId,
    accountName: account.name,
    currency: account.currency,
    range: input.range,
    totals,
    daily,
    entities,
    measures: [...GOOGLE_ADS_MEASURES],
    viewDefinition: 'TrueView views — a view of 30 seconds (or the whole ad, if shorter) or an interaction with it.',
    notes: [
      'YouTube placements only: the spend each Google Ads campaign delivered on YouTube, not its search or display spend.',
      'Quartile figures are Google’s rates of impressions converted to counts, so they can be added across days.',
    ],
  };
}
