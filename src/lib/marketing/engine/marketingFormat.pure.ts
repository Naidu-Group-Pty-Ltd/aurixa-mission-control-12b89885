/**
 * How the engine's figures are written for a person — on the page and in the
 * facts handed to the model, in the same words, so the digest can never quote
 * a figure the page prints differently.
 *
 * `null` is written as an em dash and never as zero. Money carries its
 * currency code unless the caller says the currency goes without saying.
 */
import type { Measured } from './marketingTypes.pure.ts';

const DASH = '—';

export function formatMoney(value: Measured, currency: string | null, options: { compact?: boolean; showCode?: boolean } = {}): string {
  if (value === null) return DASH;
  const code = currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
  if (code) {
    try {
      return new Intl.NumberFormat('en-AU', {
        style: 'currency',
        currency: code,
        currencyDisplay: options.showCode ? 'code' : 'narrowSymbol',
        notation: options.compact && Math.abs(value) >= 10_000 ? 'compact' : 'standard',
        maximumFractionDigits: options.compact && Math.abs(value) >= 10_000 ? 1 : 2,
        minimumFractionDigits: options.compact && Math.abs(value) >= 10_000 ? 0 : 2,
      }).format(value);
    } catch {
      // An unknown currency code falls through to a plain number with the code.
    }
  }
  const n = value.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return code ? `${code} ${n}` : n;
}

export function formatCount(value: Measured, options: { compact?: boolean } = {}): string {
  if (value === null) return DASH;
  if (options.compact && Math.abs(value) >= 10_000) {
    return new Intl.NumberFormat('en-AU', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  }
  return Math.round(value).toLocaleString('en-AU');
}

/** A fraction (0.0123) as a percentage ("1.23%"). */
export function formatPercent(fraction: Measured, digits = 2): string {
  if (fraction === null) return DASH;
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** A signed relative change ("+12.4%", "−3.0%"). */
export function formatChange(fraction: Measured, digits = 1): string {
  if (fraction === null) return DASH;
  const pct = (fraction * 100).toFixed(digits);
  return fraction > 0 ? `+${pct}%` : fraction < 0 ? `−${pct.replace('-', '')}%` : `${pct}%`;
}

/** Seconds as "1:05", minutes-and-hours as "2h 05m". */
export function formatSeconds(value: Measured): string {
  if (value === null) return DASH;
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatMinutes(value: Measured): string {
  if (value === null) return DASH;
  if (value >= 60) return `${formatCount(value / 60)} h`;
  return `${formatCount(value)} min`;
}
