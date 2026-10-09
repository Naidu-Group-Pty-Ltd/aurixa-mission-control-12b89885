/**
 * Deterministic findings about an advertising account and a YouTube channel.
 *
 * Every finding here is arithmetic over figures the vendor reported, with the
 * threshold printed beside it. The model that writes the digest is handed
 * these findings; it does not find them. That is the line the Meta tab already
 * draws (`analyze-meta-ads` detects in code and narrates with a model), kept
 * for the new channels.
 *
 * Two rules that stop a finding from being invented:
 *
 * - **A rule runs only where its inputs were measured.** An entity whose
 *   results were not measured cannot have "zero results"; a channel that does
 *   not count plays cannot have a weak hook.
 * - **Comparisons are with the entity's OWN account.** "Cost per result 2.4×
 *   the account's" is a fact about this account. "Above the industry
 *   benchmark" would need a benchmark nobody here measured.
 *
 * Thresholds are named constants, and the finding carries the value and the
 * threshold it was compared with, so the page can say exactly why it fired.
 */
import type { ChannelReport, ChannelSignal, EntityHealth, EntityRow, HealthFactor, Measured, MetricSet, SignalSeverity } from './marketingTypes.pure.ts';
import { deriveRates, engagementCount, median, ratio } from './marketingMetrics.pure.ts';
import { daysFrom, ymdOfInstant } from './marketingRange.pure.ts';
import type { YouTubeVideo } from './youtubeData.pure.ts';

/** The outcome a channel optimises toward: its results where it reports them, else conversions. */
export function outcomeOf(m: MetricSet): Measured {
  return m.results ?? m.conversions;
}

export const SIGNAL_THRESHOLDS = {
  /** Below this many impressions a rate is noise. */
  minImpressions: 1000,
  /** Below this many plays a video rate is noise. */
  minPlays: 500,
  /** An entity with no outcome has spent "enough to judge" at this multiple of the account's cost per outcome. */
  zeroOutcomeSpendMultiple: 2,
  zeroOutcomeCriticalMultiple: 3,
  costSpikeWarning: 1.8,
  costSpikeCritical: 2.5,
  rateDropShare: 0.5,
  hookDropShare: 0.6,
  cpmSpikeMultiple: 2,
  concentrationShare: 0.7,
  uploadGapWarningDays: 21,
  uploadGapCriticalDays: 45,
  /**
   * An upload this many days old has earned most of the views it will earn.
   * Lifetime views favour older uploads, so a younger one is never compared.
   */
  uploadMatureDays: 28,
  underperformingShare: 0.25,
  /** How many earlier uploads make a fair median. */
  uploadBaselineCount: 10,
} as const;

const SEVERITY_ORDER: Record<SignalSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function sortSignals(signals: ChannelSignal[]): ChannelSignal[] {
  return signals.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.value - a.value);
}

function money(value: number, currency: string | null): string {
  const n = value.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${n}` : n;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(2)}%`;
}

/** Findings about the entities of an advertising report. */
export function detectAdSignals(report: ChannelReport): ChannelSignal[] {
  const t = SIGNAL_THRESHOLDS;
  const out: ChannelSignal[] = [];
  const account = report.totals;
  const accountRates = deriveRates(account);
  const accountOutcome = outcomeOf(account);
  const accountCostPerOutcome = ratio(account.spend, accountOutcome);
  const cur = report.currency;
  const spendingEntities = report.entities.filter((e) => (e.metrics.spend ?? 0) > 0);

  if (account.spend !== null && account.spend > 0 && accountOutcome === 0) {
    out.push({
      id: `account-zero-outcome-${report.channel}`,
      severity: 'warning',
      rule: 'account_zero_outcome',
      entityId: null,
      entityName: null,
      title: 'Spend with no results across the account',
      description: `The account spent ${money(account.spend, cur)} in this period and recorded no results. Check the optimisation goal and that conversion tracking is firing.`,
      value: account.spend,
      threshold: 0,
      unit: 'currency',
    });
  }

  for (const e of spendingEntities) {
    const m = e.metrics;
    const rates = deriveRates(m);
    const spend = m.spend ?? 0;
    const outcome = outcomeOf(m);

    if (outcome === 0 && accountCostPerOutcome !== null && spend >= accountCostPerOutcome * t.zeroOutcomeSpendMultiple) {
      out.push({
        id: `zero-outcome-${e.id}`,
        severity: spend >= accountCostPerOutcome * t.zeroOutcomeCriticalMultiple ? 'critical' : 'warning',
        rule: 'zero_outcome',
        entityId: e.id,
        entityName: e.name,
        title: 'No results despite spend',
        description: `${e.name} spent ${money(spend, cur)} — ${(spend / accountCostPerOutcome).toFixed(1)}× what a result costs across the account — and recorded none.`,
        value: spend,
        threshold: accountCostPerOutcome * t.zeroOutcomeSpendMultiple,
        unit: 'currency',
      });
    }

    const costPerOutcome = ratio(m.spend, outcome);
    if (costPerOutcome !== null && accountCostPerOutcome !== null && outcome !== null && outcome > 0 && costPerOutcome > accountCostPerOutcome * t.costSpikeWarning) {
      out.push({
        id: `cost-spike-${e.id}`,
        severity: costPerOutcome > accountCostPerOutcome * t.costSpikeCritical ? 'critical' : 'warning',
        rule: 'cost_per_result_spike',
        entityId: e.id,
        entityName: e.name,
        title: 'Cost per result well above the account',
        description: `${money(costPerOutcome, cur)} per result is ${((costPerOutcome / accountCostPerOutcome - 1) * 100).toFixed(0)}% above the account's ${money(accountCostPerOutcome, cur)}.`,
        value: costPerOutcome,
        threshold: accountCostPerOutcome,
        unit: 'currency',
      });
    }

    if ((m.impressions ?? 0) >= t.minImpressions) {
      if (rates.ctr !== null && accountRates.ctr !== null && accountRates.ctr > 0 && rates.ctr < accountRates.ctr * t.rateDropShare) {
        out.push({
          id: `ctr-drop-${e.id}`,
          severity: 'warning',
          rule: 'ctr_drop',
          entityId: e.id,
          entityName: e.name,
          title: 'Click-through rate well below the account',
          description: `CTR of ${pct(rates.ctr)} is under half the account's ${pct(accountRates.ctr)}. The creative or the audience is not earning the click.`,
          value: rates.ctr,
          threshold: accountRates.ctr,
          unit: 'percent',
        });
      }
      if (rates.viewRate !== null && accountRates.viewRate !== null && accountRates.viewRate > 0 && rates.viewRate < accountRates.viewRate * t.rateDropShare) {
        out.push({
          id: `view-rate-drop-${e.id}`,
          severity: 'warning',
          rule: 'view_rate_drop',
          entityId: e.id,
          entityName: e.name,
          title: 'View rate well below the account',
          description: `${pct(rates.viewRate)} of impressions became views, under half the account's ${pct(accountRates.viewRate)}. The opening seconds are not holding attention.`,
          value: rates.viewRate,
          threshold: accountRates.viewRate,
          unit: 'percent',
        });
      }
      if (rates.cpm !== null && accountRates.cpm !== null && rates.cpm > accountRates.cpm * t.cpmSpikeMultiple) {
        out.push({
          id: `cpm-spike-${e.id}`,
          severity: 'info',
          rule: 'cpm_spike',
          entityId: e.id,
          entityName: e.name,
          title: 'Paying a premium for reach',
          description: `CPM of ${money(rates.cpm, cur)} is ${(rates.cpm / accountRates.cpm).toFixed(1)}× the account's ${money(accountRates.cpm, cur)}. A narrow audience or a competitive placement is raising the price.`,
          value: rates.cpm,
          threshold: accountRates.cpm * t.cpmSpikeMultiple,
          unit: 'currency',
        });
      }
    }

    if ((m.videoPlays ?? 0) >= t.minPlays) {
      if (rates.hookRate !== null && accountRates.hookRate !== null && accountRates.hookRate > 0 && rates.hookRate < accountRates.hookRate * t.hookDropShare) {
        out.push({
          id: `weak-hook-${e.id}`,
          severity: 'warning',
          rule: 'weak_hook',
          entityId: e.id,
          entityName: e.name,
          title: 'Weak opening',
          description: `${pct(rates.hookRate)} of plays reached six seconds against ${pct(accountRates.hookRate)} across the account. Test a stronger first two seconds.`,
          value: rates.hookRate,
          threshold: accountRates.hookRate,
          unit: 'percent',
        });
      }
    }
    if ((m.videoPlays ?? m.impressions ?? 0) >= t.minPlays && rates.completionRate !== null && accountRates.completionRate !== null && accountRates.completionRate > 0 && rates.completionRate < accountRates.completionRate * t.rateDropShare) {
      out.push({
        id: `low-completion-${e.id}`,
        severity: 'info',
        rule: 'low_completion',
        entityId: e.id,
        entityName: e.name,
        title: 'Few viewers reach the end',
        description: `${pct(rates.completionRate)} watched to the end against ${pct(accountRates.completionRate)} across the account. The message may come too late in the video.`,
        value: rates.completionRate,
        threshold: accountRates.completionRate,
        unit: 'percent',
      });
    }
  }

  // One entity taking most of the money while converting worse than the account.
  if (account.spend !== null && account.spend > 0 && spendingEntities.length > 1) {
    const top = spendingEntities[0];
    const share = (top.metrics.spend ?? 0) / account.spend;
    const topCost = ratio(top.metrics.spend, outcomeOf(top.metrics));
    if (share >= t.concentrationShare && topCost !== null && accountCostPerOutcome !== null && topCost > accountCostPerOutcome) {
      out.push({
        id: `concentration-${top.id}`,
        severity: 'warning',
        rule: 'budget_concentration',
        entityId: top.id,
        entityName: top.name,
        title: 'Most of the budget on a below-average performer',
        description: `${top.name} took ${pct(share)} of spend at ${money(topCost, cur)} per result, above the account's ${money(accountCostPerOutcome, cur)}.`,
        value: share,
        threshold: t.concentrationShare,
        unit: 'percent',
      });
    }
  }

  return sortSignals(out);
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/**
 * A 0–100 judgement of each spending entity against its own account.
 *
 * Factors the entity cannot be judged on are left out and the remaining
 * weights renormalised; fewer than two judged factors is `not_scored`, because
 * a score resting on one number is that number wearing a costume.
 */
export function scoreAdEntities(report: ChannelReport): EntityHealth[] {
  const account = report.totals;
  const accountRates = deriveRates(account);
  const accountOutcome = outcomeOf(account);
  const accountCostPerOutcome = ratio(account.spend, accountOutcome);
  const accountEngagement = ratio(engagementCount(account), account.impressions);

  return report.entities
    .filter((e) => (e.metrics.spend ?? 0) > 0)
    .map((e) => {
      const m = e.metrics;
      const rates = deriveRates(m);
      const outcome = outcomeOf(m);
      const spend = m.spend ?? 0;

      let efficiency: number | null = null;
      if (accountCostPerOutcome !== null && outcome !== null) {
        if (outcome > 0) {
          const cost = spend / outcome;
          efficiency = clamp((accountCostPerOutcome / cost) * 75);
        } else if (spend >= accountCostPerOutcome * SIGNAL_THRESHOLDS.zeroOutcomeSpendMultiple) {
          efficiency = 0;
        }
      }

      const attentionRate = rates.viewRate !== null && accountRates.viewRate ? { mine: rates.viewRate, base: accountRates.viewRate } : rates.ctr !== null && accountRates.ctr ? { mine: rates.ctr, base: accountRates.ctr } : null;
      const attention = attentionRate && attentionRate.base > 0 && (m.impressions ?? 0) >= SIGNAL_THRESHOLDS.minImpressions
        ? clamp((attentionRate.mine / attentionRate.base) * 60)
        : null;

      const retention = rates.completionRate !== null && accountRates.completionRate && accountRates.completionRate > 0
        ? clamp((rates.completionRate / accountRates.completionRate) * 60)
        : null;

      const myEngagement = ratio(engagementCount(m), m.impressions);
      const engagement = myEngagement !== null && accountEngagement && accountEngagement > 0
        ? clamp((myEngagement / accountEngagement) * 60)
        : null;

      let volume: number | null = null;
      if (accountOutcome !== null && accountOutcome > 0 && outcome !== null && account.spend && account.spend > 0) {
        const outcomeShare = outcome / accountOutcome;
        const spendShare = spend / account.spend;
        volume = spendShare > 0 ? clamp((outcomeShare / spendShare) * 60) : null;
      }

      const factors: HealthFactor[] = [
        { key: 'efficiency', label: 'Cost per result', score: efficiency === null ? null : Math.round(efficiency), weight: 0.35 },
        { key: 'attention', label: rates.viewRate !== null ? 'View rate' : 'Click-through', score: attention === null ? null : Math.round(attention), weight: 0.2 },
        { key: 'retention', label: 'Completion', score: retention === null ? null : Math.round(retention), weight: 0.15 },
        { key: 'engagement', label: 'Engagement', score: engagement === null ? null : Math.round(engagement), weight: 0.1 },
        { key: 'volume', label: 'Result share', score: volume === null ? null : Math.round(volume), weight: 0.2 },
      ];
      const judged = factors.filter((f) => f.score !== null);
      if (judged.length < 2) {
        return {
          entityId: e.id,
          entityName: e.name,
          score: null,
          status: 'not_scored' as const,
          factors,
          recommendations: ['Too little measured to score yet — this needs results or a thousand impressions to compare.'],
        };
      }
      const weightSum = judged.reduce((s, f) => s + f.weight, 0);
      const score = Math.round(judged.reduce((s, f) => s + (f.score as number) * f.weight, 0) / weightSum);
      const status: EntityHealth['status'] = score >= 60 ? 'healthy' : score >= 35 ? 'watch' : 'action_needed';
      const recs: string[] = [];
      if (efficiency !== null && efficiency < 30) recs.push(outcome === 0 ? 'No results yet at this spend — check the optimisation goal and tracking, or pause and restructure.' : 'Results cost well above the account average — review the landing page and the audience.');
      if (attention !== null && attention < 40) recs.push(rates.viewRate !== null ? 'Few impressions become views — test a stronger opening.' : 'Few impressions become clicks — test new creative or tighten the audience.');
      if (retention !== null && retention < 40) recs.push('Viewers leave early — bring the message forward or shorten the cut.');
      if (engagement !== null && engagement < 40) recs.push('Little engagement — try a clearer call to action or a more native creative.');
      if (recs.length === 0 && score >= 70) recs.push('Performing well against the account — a candidate for more budget.');
      return { entityId: e.id, entityName: e.name, score, status, factors, recommendations: recs };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

export interface YouTubeChannelSignalInput {
  /** Every upload read, newest first or not — they are sorted here. */
  uploads: readonly YouTubeVideo[];
  /** Today, YYYY-MM-DD in the report's zone. */
  today: string;
  timeZone: string;
  /** Net subscribers over the period, where it was measured (analytics, or two snapshot readings). */
  netSubscribers: Measured;
  /** Days that net figure spans. */
  netSubscribersSpanDays: number | null;
}

/** Findings about an organic YouTube channel. */
export function detectYouTubeChannelSignals(input: YouTubeChannelSignalInput): ChannelSignal[] {
  const t = SIGNAL_THRESHOLDS;
  const out: ChannelSignal[] = [];
  const dated = input.uploads
    .map((v) => ({ v, day: ymdOfInstant(v.publishedAt, input.timeZone) }))
    .filter((x): x is { v: YouTubeVideo; day: string } => x.day !== null)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

  if (dated.length > 0) {
    const gap = daysFrom(dated[0].day, input.today);
    if (gap >= t.uploadGapWarningDays) {
      out.push({
        id: 'upload-gap',
        severity: gap >= t.uploadGapCriticalDays ? 'critical' : 'warning',
        rule: 'upload_gap',
        entityId: dated[0].v.id,
        entityName: dated[0].v.title,
        title: 'No new uploads',
        description: `The last upload was ${gap} days ago. A channel that stops publishing loses its place in subscribers' feeds and in suggestions.`,
        value: gap,
        threshold: t.uploadGapWarningDays,
        unit: 'days',
      });
    }
  }

  if (input.netSubscribers !== null && input.netSubscribers < 0) {
    out.push({
      id: 'subscriber-decline',
      severity: 'warning',
      rule: 'subscriber_decline',
      entityId: null,
      entityName: null,
      title: 'Losing subscribers',
      description: `The channel lost ${Math.abs(input.netSubscribers).toLocaleString('en-AU')} subscribers net${input.netSubscribersSpanDays ? ` over ${input.netSubscribersSpanDays} days` : ''}.`,
      value: input.netSubscribers,
      threshold: 0,
      unit: 'count',
    });
  }

  // A mature upload far below the median of the uploads before it.
  const mature = dated.filter((x) => daysFrom(x.day, input.today) >= t.uploadMatureDays && x.v.views !== null);
  for (let i = 0; i < Math.min(mature.length, 5); i++) {
    const current = mature[i];
    const earlier = mature.slice(i + 1, i + 1 + t.uploadBaselineCount).map((x) => x.v.views as number);
    if (earlier.length < 3) continue;
    const base = median(earlier);
    if (base === null || base <= 0) continue;
    const views = current.v.views as number;
    if (views < base * t.underperformingShare) {
      const age = daysFrom(current.day, input.today);
      out.push({
        id: `underperforming-${current.v.id}`,
        severity: 'info',
        rule: 'underperforming_upload',
        entityId: current.v.id,
        entityName: current.v.title,
        title: 'Upload well below the channel’s usual',
        description: `"${current.v.title}" has ${views.toLocaleString('en-AU')} views after ${age} days — under a quarter of the median ${Math.round(base).toLocaleString('en-AU')} lifetime views of the ${earlier.length} uploads before it. Its title and thumbnail are the first things to test.`,
        value: views,
        threshold: base * t.underperformingShare,
        unit: 'count',
      });
    }
  }

  return sortSignals(out);
}

/** Uploads ranked by engagement per view, the organic counterpart of a health score. */
export function rankUploads(uploads: readonly YouTubeVideo[]): Array<{ video: YouTubeVideo; engagementPerView: Measured }> {
  return uploads
    .map((video) => {
      const engaged = video.likes === null && video.comments === null ? null : (video.likes ?? 0) + (video.comments ?? 0);
      return { video, engagementPerView: ratio(engaged, video.views) };
    })
    .sort((a, b) => (b.video.views ?? -1) - (a.video.views ?? -1));
}

/** Entities sorted by their outcome cost, cheapest first; those without a cost last. */
export function rankByCostPerOutcome(entities: readonly EntityRow[]): EntityRow[] {
  const cost = (e: EntityRow) => ratio(e.metrics.spend, outcomeOf(e.metrics));
  return [...entities].sort((a, b) => {
    const ca = cost(a);
    const cb = cost(b);
    if (ca === null && cb === null) return (b.metrics.spend ?? 0) - (a.metrics.spend ?? 0);
    if (ca === null) return 1;
    if (cb === null) return -1;
    return ca - cb;
  });
}
