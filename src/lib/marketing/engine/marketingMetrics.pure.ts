/**
 * Arithmetic over `MetricSet`s that never turns "not measured" into zero.
 *
 * Three rules, each one a way the page could otherwise lie:
 *
 * 1. A value the vendor did not send is `null`, and stays `null` through every
 *    sum. `null + 7` is 7 (the measured part), `null + null` is `null` (nothing
 *    was measured), never 0.
 * 2. A rate exists only where both of its inputs were measured and its
 *    denominator is above zero. A cost per lead over an unmeasured lead count
 *    is not "∞" or "$0" — it is not a figure at all.
 * 3. Rates are derived from counts AFTER summing, never averaged. The mean of
 *    three campaigns' CTRs is not the account's CTR.
 */
import type { DailyPoint, MetricKey, MetricSet, Measured } from './marketingTypes.pure.ts';

/** Every metric key, in the order the engine prints them. */
export const METRIC_KEYS: readonly MetricKey[] = [
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
  'results',
  'conversions',
  'conversionValue',
  'likes',
  'comments',
  'shares',
  'engagements',
  'follows',
  'unfollows',
  'profileVisits',
];

/** A set in which nothing was measured. */
export function emptyMetrics(): MetricSet {
  const out = {} as MetricSet;
  for (const k of METRIC_KEYS) out[k] = null;
  return out;
}

/**
 * A vendor's number, or null. Vendors send counts as strings ("1234"), as
 * numbers, as "" for nothing, and TikTok as "-" for a figure it suppressed.
 * Only a finite number survives; everything else is "not measured".
 */
export function readNumber(value: unknown): Measured {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '-' || trimmed.toLowerCase() === 'n/a') return null;
  // Thousands separators appear in some exports; a decimal comma never does here.
  const n = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** `readNumber` for a figure the vendor states as a share of 100 ("2.5" meaning 2.5%). */
export function readPercent(value: unknown): Measured {
  const n = readNumber(value);
  return n === null ? null : n / 100;
}

/** Add two measured values without inventing either. */
export function addMeasured(a: Measured, b: Measured): Measured {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** Subtract, where both were measured. A difference with one side unknown is unknown. */
export function subtractMeasured(a: Measured, b: Measured): Measured {
  if (a === null || b === null) return null;
  return a - b;
}

/** Sum metric sets key by key. An empty list sums to "nothing measured". */
export function sumMetrics(sets: readonly MetricSet[]): MetricSet {
  const out = emptyMetrics();
  for (const s of sets) {
    for (const k of METRIC_KEYS) out[k] = addMeasured(out[k], s[k]);
  }
  return out;
}

/**
 * `numerator / denominator × scale`, or null.
 *
 * Null when either side was not measured, and null when the denominator is
 * zero or negative — a CTR over no impressions is undefined, not 0%.
 */
export function ratio(numerator: Measured, denominator: Measured, scale = 1): Measured {
  if (numerator === null || denominator === null) return null;
  if (!(denominator > 0)) return null;
  return (numerator / denominator) * scale;
}

/** The rates a reader asks for, each derived from counts. */
export interface DerivedRates {
  /** Clicks per impression, as a fraction (0.012 is 1.2%). */
  ctr: Measured;
  /** Spend per thousand impressions. */
  cpm: Measured;
  /** Spend per click. */
  cpc: Measured;
  /** Spend per view (the channel's own view). */
  cpv: Measured;
  /** Views per impression, as a fraction. */
  viewRate: Measured;
  /**
   * Share watched to the end, as a fraction: of plays where the channel counts
   * plays (TikTok, Meta), of impressions where it does not (Google Ads, whose
   * quartiles are themselves rates of impressions).
   */
  completionRate: Measured;
  /** Plays held to six seconds, as a fraction of plays — how well the opening holds attention. */
  hookRate: Measured;
  /** Spend per optimisation-goal result. */
  costPerResult: Measured;
  /** Spend per conversion. */
  costPerConversion: Measured;
  /** Conversion value per unit of spend. */
  roas: Measured;
  /** Likes, comments and shares per view, as a fraction. */
  engagementPerView: Measured;
  /** Likes, comments and shares (or the vendor's own engagement count) per impression. */
  engagementPerImpression: Measured;
  /** Average seconds watched per view or play. */
  averageWatchSeconds: Measured;
  /** Impressions per person reached. */
  frequency: Measured;
  /** Followers gained less followers lost. */
  netFollows: Measured;
}

/** The interactions this engine calls engagement: likes, comments and shares, or the vendor's own count. */
export function engagementCount(m: MetricSet): Measured {
  const parts = addMeasured(addMeasured(m.likes, m.comments), m.shares);
  return parts !== null ? parts : m.engagements;
}

export function deriveRates(m: MetricSet): DerivedRates {
  const engaged = engagementCount(m);
  const watchBase = m.videoPlays ?? m.views;
  return {
    ctr: ratio(m.clicks, m.impressions),
    cpm: ratio(m.spend, m.impressions, 1000),
    cpc: ratio(m.spend, m.clicks),
    cpv: ratio(m.spend, m.views),
    viewRate: ratio(m.views, m.impressions),
    completionRate: ratio(m.quartile100, m.videoPlays ?? m.impressions),
    hookRate: ratio(m.views6s, m.videoPlays),
    costPerResult: ratio(m.spend, m.results),
    costPerConversion: ratio(m.spend, m.conversions),
    roas: ratio(m.conversionValue, m.spend),
    engagementPerView: ratio(engaged, m.views),
    engagementPerImpression: ratio(engaged, m.impressions),
    averageWatchSeconds: ratio(m.watchTimeMinutes, watchBase, 60),
    frequency: ratio(m.impressions, m.reach),
    // Net growth needs BOTH sides: a channel that reports new followers and
    // not lost ones (TikTok's paid `follows`) has no net figure to state.
    netFollows: subtractMeasured(m.follows, m.unfollows),
  };
}

/** True when at least one metric in the set was measured. */
export function anyMeasured(m: MetricSet): boolean {
  return METRIC_KEYS.some((k) => m[k] !== null);
}

/** The keys a list of sets measured at least once. */
export function measuredKeys(sets: readonly MetricSet[]): MetricKey[] {
  return METRIC_KEYS.filter((k) => sets.some((s) => s[k] !== null));
}

/** Combine daily points that share a date (pages of one report, chunks of a range), oldest first. */
export function mergeDaily(points: readonly DailyPoint[]): DailyPoint[] {
  const byDate = new Map<string, MetricSet[]>();
  for (const p of points) {
    const list = byDate.get(p.date) ?? [];
    list.push(p.metrics);
    byDate.set(p.date, list);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, sets]) => ({ date, metrics: sumMetrics(sets) }));
}

/**
 * A daily series with every day of the range present, oldest first.
 *
 * An advertising platform leaves a day out of its report when nothing was
 * delivered, so for a range that was read IN FULL a missing day is a measured
 * zero on the delivery metrics this source measures. `zeroFill` says the read
 * was complete; without it the gap stays a gap, because a day that was never
 * asked about is not a day on which nothing happened.
 */
export function completeDailySeries(
  points: readonly DailyPoint[],
  days: readonly string[],
  options: { zeroFill: boolean; measures: readonly MetricKey[] },
): DailyPoint[] {
  const merged = new Map(mergeDaily(points).map((p) => [p.date, p.metrics]));
  return days.map((date) => {
    const found = merged.get(date);
    if (found) return { date, metrics: found };
    const metrics = emptyMetrics();
    if (options.zeroFill) {
      for (const k of options.measures) metrics[k] = 0;
    }
    return { date, metrics };
  });
}

/** The relative change from `previous` to `current`, as a fraction, or null where it cannot be stated. */
export function relativeChange(current: Measured, previous: Measured): Measured {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous);
}

/** Round for display and prompts without turning null into anything. */
export function roundTo(value: Measured, places: number): Measured {
  if (value === null) return null;
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** A median that is null for an empty list. */
export function median(values: readonly number[]): Measured {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
