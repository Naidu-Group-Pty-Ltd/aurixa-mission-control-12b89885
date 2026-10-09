/**
 * One line per channel, and what may honestly be said about all of them at
 * once.
 *
 * Adding channels together is where a marketing page most easily lies, in
 * three ways this module refuses:
 *
 * - **Money in different currencies is never added.** A TikTok account billed
 *   in USD and a Meta account in AUD give two totals, not one.
 * - **A channel that did not answer is not a channel that spent nothing.** Its
 *   line says why it is missing and the total says it is partial.
 * - **"Views" are not summed across channels.** A TikTok play, a Meta
 *   three-second view and a YouTube TrueView view are different events; the
 *   overview shows each channel's own count beside its own definition.
 */
import type { ChannelReport, Measured, SourceState } from './marketingTypes.pure.ts';
import { ratio } from './marketingMetrics.pure.ts';
import { outcomeOf } from './channelSignals.pure.ts';

export interface ChannelHeadline {
  key: string;
  label: string;
  state: SourceState['state'] | 'loading';
  currency: string | null;
  spend: Measured;
  impressions: Measured;
  clicks: Measured;
  views: Measured;
  viewDefinition: string | null;
  results: Measured;
  /** Leads the CRM attributes to this channel over the same period. */
  attributedLeads: Measured;
}

export function headlineOf(
  key: string,
  label: string,
  state: ChannelHeadline['state'],
  report: ChannelReport | null,
  attributedLeads: Measured = null,
): ChannelHeadline {
  const t = report?.totals;
  return {
    key,
    label,
    state,
    currency: report?.currency ?? null,
    spend: t?.spend ?? null,
    impressions: t?.impressions ?? null,
    clicks: t?.clicks ?? null,
    views: t?.views ?? null,
    viewDefinition: report?.viewDefinition ?? null,
    results: t ? outcomeOf(t) : null,
    attributedLeads,
  };
}

export interface CrossChannelSummary {
  /** Channels that answered. */
  answered: number;
  /** Channels configured but failing, or still loading. */
  incomplete: number;
  /** Channels with no credentials. */
  notConfigured: number;
  /** Spend per currency, largest first. More than one entry means it cannot be one total. */
  spendByCurrency: Array<{ currency: string | null; amount: number; channels: string[] }>;
  /** A single total, only where every answered channel spent in one known currency. */
  totalSpend: { currency: string; amount: number } | null;
  /** Results summed across answered channels that measure them. */
  results: Measured;
  attributedLeads: Measured;
  /** Total spend over attributed leads, only where both are single-currency and measured. */
  costPerAttributedLead: Measured;
  /** True when a configured channel is missing from the totals. */
  partial: boolean;
}

export function summariseChannels(headlines: readonly ChannelHeadline[]): CrossChannelSummary {
  const answered = headlines.filter((h) => h.state === 'ok');
  const incomplete = headlines.filter((h) => h.state === 'error' || h.state === 'loading').length;
  const notConfigured = headlines.filter((h) => h.state === 'not_configured').length;

  const byCurrency = new Map<string | null, { amount: number; channels: string[] }>();
  for (const h of answered) {
    if (h.spend === null) continue;
    const slot = byCurrency.get(h.currency) ?? { amount: 0, channels: [] };
    slot.amount += h.spend;
    slot.channels.push(h.label);
    byCurrency.set(h.currency, slot);
  }
  const spendByCurrency = [...byCurrency.entries()]
    .map(([currency, v]) => ({ currency, amount: v.amount, channels: v.channels }))
    .sort((a, b) => b.amount - a.amount);
  const totalSpend = spendByCurrency.length === 1 && spendByCurrency[0].currency !== null
    ? { currency: spendByCurrency[0].currency, amount: spendByCurrency[0].amount }
    : null;

  let results: Measured = null;
  let leads: Measured = null;
  for (const h of answered) {
    if (h.results !== null) results = (results ?? 0) + h.results;
    if (h.attributedLeads !== null) leads = (leads ?? 0) + h.attributedLeads;
  }

  return {
    answered: answered.length,
    incomplete,
    notConfigured,
    spendByCurrency,
    totalSpend,
    results,
    attributedLeads: leads,
    costPerAttributedLead: totalSpend ? ratio(totalSpend.amount, leads) : null,
    partial: incomplete > 0,
  };
}
