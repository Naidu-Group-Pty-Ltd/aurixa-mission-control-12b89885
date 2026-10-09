/**
 * Looking forward from what a channel reported: a trend line, month pacing,
 * a period-on-period comparison and where budget could move.
 *
 * Each of these is arithmetic a reader can redo by hand, and each says what it
 * cannot know. A straight line through thirty days is not a forecast of a
 * market; it is "if the last month continues". Moving budget to the cheapest
 * campaign assumes its next dollar costs what its average dollar did, which is
 * never quite true — so every projection carries that sentence with it.
 */
import type { DailyPoint, EntityRow, Measured, MetricKey, MetricSet, ChannelReport } from './marketingTypes.pure.ts';
import { deriveRates, ratio, relativeChange } from './marketingMetrics.pure.ts';
import { addDays, daysFrom } from './marketingRange.pure.ts';
import { outcomeOf } from './channelSignals.pure.ts';

/** Fewer measured days than this and no line is drawn. */
export const MIN_TREND_DAYS = 7;

export interface TrendFit {
  slope: number;
  intercept: number;
  /** Standard deviation of past days around the line. */
  residualSd: number;
  points: number;
}

/** Least squares through (0, v0), (1, v1), … */
export function fitLine(values: readonly number[]): TrendFit | null {
  const n = values.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += values[i];
    sxx += i * i;
    sxy += i * values[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const e = values[i] - (intercept + slope * i);
    ss += e * e;
  }
  const residualSd = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return { slope, intercept, residualSd, points: n };
}

export interface ForecastPoint {
  date: string;
  value: number;
  low: number;
  high: number;
}

export interface SeriesForecast {
  metric: MetricKey;
  history: Array<{ date: string; value: number }>;
  forecast: ForecastPoint[];
  trend: 'rising' | 'falling' | 'flat' | null;
  /** Sum of the projected days. */
  projectedTotal: Measured;
  /** Average of the measured days, for "per day" copy. */
  dailyAverage: Measured;
  note: string;
}

/**
 * Project one metric forward by `horizonDays`.
 *
 * Only measured days feed the line — a day the source did not report is not
 * a zero. The band is one standard deviation of past days around the line,
 * described as exactly that; it is not a confidence interval and is never
 * called one. Projections are floored at zero.
 */
export function forecastMetric(daily: readonly DailyPoint[], metric: MetricKey, horizonDays: number): SeriesForecast {
  const history = daily
    .filter((d) => d.metrics[metric] !== null)
    .map((d) => ({ date: d.date, value: d.metrics[metric] as number }));
  const base: SeriesForecast = {
    metric,
    history,
    forecast: [],
    trend: null,
    projectedTotal: null,
    dailyAverage: history.length > 0 ? history.reduce((s, h) => s + h.value, 0) / history.length : null,
    note: '',
  };
  if (history.length < MIN_TREND_DAYS || horizonDays < 1) {
    return { ...base, note: `A trend needs at least ${MIN_TREND_DAYS} days with data; this range has ${history.length}.` };
  }
  const fit = fitLine(history.map((h) => h.value));
  if (!fit) return { ...base, note: 'The days on record do not define a trend.' };

  const last = history[history.length - 1].date;
  const forecast: ForecastPoint[] = [];
  for (let k = 1; k <= horizonDays; k++) {
    // Position on the line: days since the first measured day.
    const x = daysFrom(history[0].date, addDays(last, k));
    const value = Math.max(0, fit.intercept + fit.slope * x);
    forecast.push({
      date: addDays(last, k),
      value,
      low: Math.max(0, value - fit.residualSd),
      high: value + fit.residualSd,
    });
  }
  const mean = base.dailyAverage ?? 0;
  const weeklyMove = Math.abs(fit.slope * 7);
  const trend: SeriesForecast['trend'] = mean > 0 && weeklyMove / mean < 0.05 ? 'flat' : fit.slope > 0 ? 'rising' : fit.slope < 0 ? 'falling' : 'flat';
  return {
    ...base,
    forecast,
    trend,
    projectedTotal: forecast.reduce((s, p) => s + p.value, 0),
    note: `A straight line through ${history.length} days, continued ${horizonDays} days. The band is one standard deviation of past days around that line — how far a typical day strayed from it — not a confidence interval.`,
  };
}

export interface MonthPacing {
  daysElapsed: number;
  daysInMonth: number;
  monthToDateSpend: Measured;
  projectedMonthSpend: Measured;
  monthBudget: Measured;
  /** Projected spend over budget, as a fraction (1.0 is on budget). */
  pace: Measured;
  status: 'under' | 'on_track' | 'over' | null;
  note: string;
}

/** Days in the month that contains `day` (YYYY-MM-DD). */
export function daysInMonthOf(day: string): number {
  const first = `${day.slice(0, 7)}-01`;
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  const nextFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return daysFrom(first, nextFirst);
}

/**
 * Where this month's spend is heading against the daily budgets set.
 *
 * Only DAILY budgets can be paced: a lifetime budget is spread over a schedule
 * this engine does not read, so a month budget is stated only from daily
 * budgets and says so.
 */
export function monthPacing(input: {
  /** The last complete day, YYYY-MM-DD. */
  asOf: string;
  monthToDateSpend: Measured;
  /** Sum of the daily budgets of the campaigns running now. */
  dailyBudgetTotal: Measured;
}): MonthPacing {
  const daysInMonth = daysInMonthOf(input.asOf);
  const daysElapsed = Number(input.asOf.slice(8, 10));
  const projected = input.monthToDateSpend === null || daysElapsed <= 0 ? null : (input.monthToDateSpend / daysElapsed) * daysInMonth;
  const budget = input.dailyBudgetTotal === null || input.dailyBudgetTotal <= 0 ? null : input.dailyBudgetTotal * daysInMonth;
  const pace = ratio(projected, budget);
  const status: MonthPacing['status'] = pace === null ? null : pace > 1.1 ? 'over' : pace < 0.9 ? 'under' : 'on_track';
  return {
    daysElapsed,
    daysInMonth,
    monthToDateSpend: input.monthToDateSpend,
    projectedMonthSpend: projected,
    monthBudget: budget,
    pace,
    status,
    note: budget === null
      ? 'No daily budgets were reported, so there is nothing to pace against. Campaigns on lifetime budgets are not paced.'
      : `Projected from ${daysElapsed} days at the month-to-date average, against daily budgets × ${daysInMonth} days. Lifetime budgets are not included.`,
  };
}

export interface PeriodComparisonRow {
  key: string;
  current: Measured;
  previous: Measured;
  /** Relative change as a fraction; null where it cannot be stated. */
  change: Measured;
  /** Which way is good news: up for results, down for costs, neither for spend. */
  goodDirection: 'up' | 'down' | 'neutral';
}

/** The figures a reader compares period on period, counts and rates both. */
export function comparePeriods(current: MetricSet, previous: MetricSet): PeriodComparisonRow[] {
  const cr = deriveRates(current);
  const pr = deriveRates(previous);
  const row = (key: string, c: Measured, p: Measured, goodDirection: PeriodComparisonRow['goodDirection']): PeriodComparisonRow => ({
    key,
    current: c,
    previous: p,
    change: relativeChange(c, p),
    goodDirection,
  });
  return [
    row('spend', current.spend, previous.spend, 'neutral'),
    row('impressions', current.impressions, previous.impressions, 'up'),
    row('clicks', current.clicks, previous.clicks, 'up'),
    row('views', current.views, previous.views, 'up'),
    row('results', outcomeOf(current), outcomeOf(previous), 'up'),
    row('ctr', cr.ctr, pr.ctr, 'up'),
    row('cpm', cr.cpm, pr.cpm, 'down'),
    row('cpv', cr.cpv, pr.cpv, 'down'),
    row('costPerResult', ratio(current.spend, outcomeOf(current)), ratio(previous.spend, outcomeOf(previous)), 'down'),
    row('watchTimeMinutes', current.watchTimeMinutes, previous.watchTimeMinutes, 'up'),
    row('netFollows', cr.netFollows, pr.netFollows, 'up'),
  ].filter((r) => r.current !== null || r.previous !== null);
}

export interface BudgetMove {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  /** In the report's currency. */
  amount: number;
  fromCostPerResult: Measured;
  toCostPerResult: number;
  /** Results gained at today's AVERAGE costs. An estimate, and an optimistic one. */
  estimatedExtraResults: number;
}

export interface BudgetAdvice {
  moves: BudgetMove[];
  accountCostPerResult: Measured;
  notes: string[];
}

export const BUDGET_ADVICE = {
  /** Never suggest moving more than this share of one entity's spend. */
  maxShiftShare: 0.2,
  /** A donor's cost per result is at least this multiple of the account's. */
  donorCostMultiple: 1.5,
  /** A recipient's cost per result is at most this multiple of the account's. */
  recipientCostMultiple: 0.8,
  /** A recipient needs this many results before its cost is believed. */
  recipientMinResults: 3,
} as const;

/**
 * Where moving budget would buy more results, at the account's own prices.
 *
 * Donors cost well above the account per result (or spent twice the account's
 * cost per result and got none); recipients cost well below it on enough
 * results to trust the figure. The suggested amount is capped at a fifth of
 * the donor's spend, because the average cost of a campaign's last dollar is
 * not the cost of its next one.
 */
export function adviseBudget(report: ChannelReport): BudgetAdvice {
  const a = BUDGET_ADVICE;
  const accountCost = ratio(report.totals.spend, outcomeOf(report.totals));
  const notes = [
    'Estimates use each campaign’s average cost per result over the period. The next dollar into a campaign usually costs more than its average, so treat the gain as an upper bound.',
  ];
  if (accountCost === null) {
    return { moves: [], accountCostPerResult: null, notes: ['No results were measured in this period, so there is no cost per result to reallocate by.'] };
  }
  const withCost = report.entities
    .filter((e) => (e.metrics.spend ?? 0) > 0 && outcomeOf(e.metrics) !== null)
    .map((e) => ({ e, outcome: outcomeOf(e.metrics) as number, spend: e.metrics.spend as number }));

  const donors = withCost
    .filter(({ outcome, spend }) => (outcome > 0 ? spend / outcome >= accountCost * a.donorCostMultiple : spend >= accountCost * 2))
    .sort((x, y) => y.spend - x.spend);
  const recipients = withCost
    .filter(({ outcome, spend }) => outcome >= a.recipientMinResults && spend / outcome <= accountCost * a.recipientCostMultiple)
    .sort((x, y) => x.spend / x.outcome - y.spend / y.outcome);

  if (donors.length === 0 || recipients.length === 0) {
    return {
      moves: [],
      accountCostPerResult: accountCost,
      notes: [
        donors.length === 0
          ? 'No campaign costs far enough above the account average to fund a move.'
          : 'No campaign is both cheap and proven on enough results to receive budget.',
        ...notes,
      ],
    };
  }

  const moves: BudgetMove[] = [];
  donors.forEach((donor, i) => {
    const target = recipients[i % recipients.length];
    if (target.e.id === donor.e.id) return;
    const amount = Math.round(donor.spend * a.maxShiftShare * 100) / 100;
    const toCost = target.spend / target.outcome;
    const fromCost = donor.outcome > 0 ? donor.spend / donor.outcome : null;
    const lost = fromCost === null ? 0 : amount / fromCost;
    moves.push({
      fromId: donor.e.id,
      fromName: donor.e.name,
      toId: target.e.id,
      toName: target.e.name,
      amount,
      fromCostPerResult: fromCost,
      toCostPerResult: toCost,
      estimatedExtraResults: Math.max(0, amount / toCost - lost),
    });
  });
  return { moves, accountCostPerResult: accountCost, notes };
}

/** The entities that carry the given share of spend, largest first — for "where the money went". */
export function spendConcentration(entities: readonly EntityRow[], share = 0.8): EntityRow[] {
  const total = entities.reduce((s, e) => s + (e.metrics.spend ?? 0), 0);
  if (total <= 0) return [];
  const sorted = [...entities].sort((a, b) => (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0));
  const out: EntityRow[] = [];
  let running = 0;
  for (const e of sorted) {
    if (running / total >= share) break;
    out.push(e);
    running += e.metrics.spend ?? 0;
  }
  return out;
}
