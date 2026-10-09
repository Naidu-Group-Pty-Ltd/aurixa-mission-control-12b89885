/**
 * What the Marketing pages conclude from a channel's figures — the same
 * conclusions the prime's `marketing-channels` draws, from the same engine.
 *
 * Every conclusion here is deterministic: findings and health are each
 * entity judged against this account's own figures, budget advice moves at
 * most a fifth of an entity's spend, and the trend is a fitted line with its
 * typical spread. Nothing here is a model's; the digest is the only place a
 * model's words appear.
 */
import {
  addDays,
  adviseBudget,
  comparePeriods,
  detectAdSignals,
  forecastMetric,
  monthPacing,
  scoreAdEntities,
  type BudgetAdvice,
  type ChannelReport,
  type ChannelSignal,
  type DatePreset,
  type EntityHealth,
  type MetricSet,
  type MonthPacing,
  type PeriodComparisonRow,
  type SeriesForecast,
} from "./marketingEngine";

export const FORECAST_DAYS = 14;

export interface AdAnalysis {
  signals: ChannelSignal[];
  health: EntityHealth[];
  budget: BudgetAdvice | null;
  comparison: PeriodComparisonRow[];
  forecast: { spend: SeriesForecast; views: SeriesForecast; results: SeriesForecast } | null;
}

export function adAnalysis(
  report: ChannelReport | null,
  previousTotals: MetricSet | null,
): AdAnalysis {
  if (!report) return { signals: [], health: [], budget: null, comparison: [], forecast: null };
  return {
    signals: detectAdSignals(report),
    health: scoreAdEntities(report),
    budget: adviseBudget(report),
    comparison: previousTotals ? comparePeriods(report.totals, previousTotals) : [],
    forecast: {
      spend: forecastMetric(report.daily, "spend", FORECAST_DAYS),
      views: forecastMetric(report.daily, "views", FORECAST_DAYS),
      results: forecastMetric(report.daily, "results", FORECAST_DAYS),
    },
  };
}

/** A campaign's daily budget, where it has one and is running. */
export interface DailyBudgetLine {
  dailyBudget: number | null;
  running: boolean;
}

/**
 * Month pacing is a month-to-date question, so it is answered for "This Month"
 * alone, counted to the end of yesterday (today is still being spent), against
 * the running campaigns' daily budgets. A lifetime budget cannot be spread over
 * a month without inventing a schedule, so it is left out and the note says so.
 */
export function pacingFor(
  report: ChannelReport | null,
  preset: DatePreset | null,
  today: string,
  budgets: readonly DailyBudgetLine[],
): MonthPacing | null {
  if (!report || preset !== "this_month") return null;
  const yesterday = addDays(today, -1);
  // On the first of the month nothing of the month has been spent yet.
  if (yesterday.slice(0, 7) !== today.slice(0, 7)) return null;
  const dailyBudget = budgets
    .filter((b) => b.running && b.dailyBudget !== null)
    .reduce((s, b) => s + (b.dailyBudget ?? 0), 0);
  const monthToDate = report.daily
    .filter((d) => d.date <= yesterday)
    .reduce((s, d) => s + (d.metrics.spend ?? 0), 0);
  return monthPacing({
    asOf: yesterday,
    monthToDateSpend: monthToDate,
    dailyBudgetTotal: dailyBudget > 0 ? dailyBudget : null,
  });
}

/** TikTok's operation status word for a running campaign. */
export function tiktokRunning(status: string | null): boolean {
  return /(^|_)ENABLE$/.test(status ?? "");
}

/** Meta's effective status for a running campaign. */
export function metaRunning(status: string | null): boolean {
  return status === "ACTIVE";
}
