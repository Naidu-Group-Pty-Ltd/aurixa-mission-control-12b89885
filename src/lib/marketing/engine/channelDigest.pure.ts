/**
 * The facts a channel digest is written from, and the prompt that hands them
 * to a model.
 *
 * The model writes; it does not measure. Every figure it may use is in the
 * facts, pre-formatted the way the page prints it, and the prompt forbids any
 * other. A figure the source did not measure is left OUT of the facts rather
 * than written as zero or "N/A" — a prohibition the model can obey is one it
 * has nothing to quote.
 *
 * The findings (`channelSignals.pure.ts`) are computed before the prompt is
 * built, so the digest narrates detections; it never makes them.
 */
import type { ChannelReport, ChannelSignal, EntityHealth, Measured } from './marketingTypes.pure.ts';
import { deriveRates, ratio } from './marketingMetrics.pure.ts';
import { formatRange } from './marketingRange.pure.ts';
import { formatChange, formatCount, formatMinutes, formatMoney, formatPercent, formatSeconds } from './marketingFormat.pure.ts';
import { outcomeOf } from './channelSignals.pure.ts';

export const CHANNEL_LABELS = {
  meta_ads: 'Meta Ads',
  youtube_channel: 'YouTube channel',
  youtube_ads: 'YouTube Ads',
  tiktok_ads: 'TikTok Ads',
} as const;

export interface DigestFact {
  label: string;
  value: string;
}

export interface DigestFacts {
  channel: string;
  period: string;
  totals: DigestFact[];
  entities: Array<{ name: string; facts: DigestFact[] }>;
  findings: Array<{ severity: string; title: string; detail: string }>;
  notes: string[];
}

/** Push a fact only when it was measured. */
function fact(list: DigestFact[], label: string, value: Measured, write: (v: Measured) => string): void {
  if (value !== null) list.push({ label, value: write(value) });
}

/** The facts of an advertising report, the top entities by spend, and its findings. */
export function adReportFacts(input: {
  report: ChannelReport;
  signals: readonly ChannelSignal[];
  health: readonly EntityHealth[];
  attributedLeads?: Measured;
  previousTotals?: ChannelReport['totals'] | null;
  maxEntities?: number;
}): DigestFacts {
  const { report } = input;
  const cur = report.currency;
  const t = report.totals;
  const r = deriveRates(t);
  const totals: DigestFact[] = [];
  fact(totals, 'Spend', t.spend, (v) => formatMoney(v, cur));
  fact(totals, 'Impressions', t.impressions, (v) => formatCount(v));
  fact(totals, 'Reach', t.reach, (v) => formatCount(v));
  fact(totals, 'Clicks', t.clicks, (v) => formatCount(v));
  fact(totals, 'CTR', r.ctr, (v) => formatPercent(v));
  fact(totals, 'CPM', r.cpm, (v) => formatMoney(v, cur));
  fact(totals, `Views (${report.viewDefinition ? report.viewDefinition.split(' — ')[0] : 'views'})`, t.views, (v) => formatCount(v));
  fact(totals, 'Cost per view', r.cpv, (v) => formatMoney(v, cur));
  fact(totals, 'View rate', r.viewRate, (v) => formatPercent(v));
  fact(totals, 'Six-second hold rate', r.hookRate, (v) => formatPercent(v));
  fact(totals, 'Completion rate', r.completionRate, (v) => formatPercent(v));
  fact(totals, 'Results', outcomeOf(t), (v) => formatCount(v));
  fact(totals, 'Cost per result', ratio(t.spend, outcomeOf(t)), (v) => formatMoney(v, cur));
  fact(totals, 'Conversion value', t.conversionValue, (v) => formatMoney(v, cur));
  fact(totals, 'Return on ad spend', r.roas, (v) => `${(v as number).toFixed(2)}×`);
  fact(totals, 'Engagement per impression', r.engagementPerImpression, (v) => formatPercent(v));
  fact(totals, 'New followers', t.follows, (v) => formatCount(v));
  if (input.attributedLeads !== undefined) {
    fact(totals, 'Leads in the CRM attributed to this channel', input.attributedLeads ?? null, (v) => formatCount(v));
    if (input.attributedLeads !== null && input.attributedLeads > 0) {
      fact(totals, 'Spend per attributed CRM lead', ratio(t.spend, input.attributedLeads), (v) => formatMoney(v, cur));
    }
  }
  if (input.previousTotals) {
    const p = input.previousTotals;
    if (t.spend !== null && p.spend !== null) totals.push({ label: 'Spend vs previous period', value: formatChange(ratio(t.spend - p.spend, p.spend)) });
    const co = outcomeOf(t);
    const po = outcomeOf(p);
    if (co !== null && po !== null) totals.push({ label: 'Results vs previous period', value: formatChange(ratio(co - po, po)) });
  }

  const healthById = new Map(input.health.map((h) => [h.entityId, h]));
  const entities = report.entities.slice(0, input.maxEntities ?? 8).map((e) => {
    const m = e.metrics;
    const er = deriveRates(m);
    const list: DigestFact[] = [];
    if (e.status) list.push({ label: 'Status', value: e.status });
    if (e.objective) list.push({ label: 'Objective', value: e.objective });
    fact(list, 'Spend', m.spend, (v) => formatMoney(v, cur));
    fact(list, 'Results', outcomeOf(m), (v) => formatCount(v));
    fact(list, 'Cost per result', ratio(m.spend, outcomeOf(m)), (v) => formatMoney(v, cur));
    fact(list, 'CTR', er.ctr, (v) => formatPercent(v));
    fact(list, 'View rate', er.viewRate, (v) => formatPercent(v));
    fact(list, 'Completion rate', er.completionRate, (v) => formatPercent(v));
    const h = healthById.get(e.id);
    if (h && h.score !== null) list.push({ label: 'Health score (vs this account)', value: `${h.score}/100 (${h.status.replace('_', ' ')})` });
    return { name: e.name, facts: list };
  });

  return {
    channel: CHANNEL_LABELS[report.channel],
    period: formatRange(report.range),
    totals,
    entities,
    findings: input.signals.slice(0, 10).map((s) => ({ severity: s.severity, title: s.title, detail: s.description })),
    notes: report.notes,
  };
}

/** The facts of an organic YouTube channel. */
export function youtubeChannelFacts(input: {
  channelTitle: string;
  period: string;
  subscribers: Measured;
  totalViews: Measured;
  uploadsInPeriod: number;
  uploadsPerWeek: Measured;
  periodViews: Measured;
  periodWatchMinutes: Measured;
  averageViewSeconds: Measured;
  netSubscribers: Measured;
  netSubscribersBasis: string | null;
  topTrafficSources: Array<{ label: string; share: Measured }>;
  topUploads: Array<{ title: string; views: Measured; ageDays: number | null }>;
  attributedLeads?: Measured;
  signals: readonly ChannelSignal[];
  notes: string[];
}): DigestFacts {
  const totals: DigestFact[] = [];
  fact(totals, 'Subscribers now', input.subscribers, (v) => formatCount(v));
  fact(totals, 'Lifetime channel views', input.totalViews, (v) => formatCount(v));
  totals.push({ label: 'Uploads in the period', value: formatCount(input.uploadsInPeriod) });
  fact(totals, 'Uploads per week', input.uploadsPerWeek, (v) => (v as number).toFixed(1));
  fact(totals, 'Views in the period', input.periodViews, (v) => formatCount(v));
  fact(totals, 'Watch time in the period', input.periodWatchMinutes, (v) => formatMinutes(v));
  fact(totals, 'Average view duration', input.averageViewSeconds, (v) => formatSeconds(v));
  if (input.netSubscribers !== null) {
    totals.push({ label: `Net subscribers${input.netSubscribersBasis ? ` (${input.netSubscribersBasis})` : ''}`, value: `${input.netSubscribers > 0 ? '+' : ''}${formatCount(input.netSubscribers)}` });
  }
  if (input.attributedLeads !== undefined) fact(totals, 'Leads in the CRM attributed to YouTube', input.attributedLeads ?? null, (v) => formatCount(v));
  for (const s of input.topTrafficSources.slice(0, 5)) {
    if (s.share !== null) totals.push({ label: `Traffic source: ${s.label}`, value: formatPercent(s.share, 1) });
  }
  return {
    channel: CHANNEL_LABELS.youtube_channel,
    period: input.period,
    totals,
    entities: input.topUploads.slice(0, 8).map((u) => {
      const list: DigestFact[] = [];
      fact(list, 'Lifetime views', u.views, (v) => formatCount(v));
      if (u.ageDays !== null) list.push({ label: 'Age', value: `${u.ageDays} days` });
      return { name: u.title, facts: list };
    }),
    findings: input.signals.slice(0, 10).map((s) => ({ severity: s.severity, title: s.title, detail: s.description })),
    notes: input.notes,
  };
}

function renderFacts(facts: DigestFacts): string {
  const lines: string[] = [];
  lines.push(`Channel: ${facts.channel}`);
  lines.push(`Period: ${facts.period}`);
  lines.push('');
  lines.push('Totals:');
  for (const f of facts.totals) lines.push(`- ${f.label}: ${f.value}`);
  if (facts.entities.length > 0) {
    lines.push('');
    lines.push('Breakdown (largest first):');
    for (const e of facts.entities) {
      lines.push(`- "${e.name}": ${e.facts.map((f) => `${f.label} ${f.value}`).join(' | ') || 'no figures measured'}`);
    }
  }
  lines.push('');
  lines.push('Findings already detected (by rule, with thresholds):');
  if (facts.findings.length === 0) lines.push('- None.');
  for (const f of facts.findings) lines.push(`- [${f.severity.toUpperCase()}] ${f.title}: ${f.detail}`);
  if (facts.notes.length > 0) {
    lines.push('');
    lines.push('What these figures are (do not contradict):');
    for (const n of facts.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

/**
 * The system and user messages for a digest. `business` names who the digest
 * is for, so the prime and Mission Control share one prompt.
 */
export function digestPrompt(facts: DigestFacts, business: string): { system: string; user: string } {
  const system = `You are a senior performance-marketing analyst writing an internal digest for ${business}. You write in Australian English, directly and specifically. You never state a figure that is not in the facts you are given, never estimate a missing figure, and never describe a figure that is absent as zero.`;
  const user = `Write a concise, actionable digest of this ${facts.channel} performance.

${renderFacts(facts)}

Instructions:
1. Open with a one or two sentence verdict on the period.
2. Name the strongest performer and why, using only the figures above.
3. Name the weakest performer and the specific action to take.
4. Address each CRITICAL or WARNING finding. Do not invent findings that are not listed.
5. Close with two or three specific next steps.
6. Under 300 words. Use only the figures above, quoted exactly as written.

FORMAT — structure the whole response with these fenced blocks (standard markdown may sit between them):
- Wrap the opening verdict in :::success or :::warning.
- Put two to four headline figures in :::metric blocks with Label and Value lines (copy the values exactly; add a Change line only where a "vs previous period" figure is given).
- Wrap each recommendation in a :::tip block.
- Wrap each risk in a :::warning block.
- Wrap any deeper observation in an :::insight block.

Example:
:::metric
Label: Cost per result
Value: $41.20
:::

:::tip
**Shift budget to "Campaign name"**: it delivers results at $28.10 against the account's $41.20.
:::`;
  return { system, user };
}
