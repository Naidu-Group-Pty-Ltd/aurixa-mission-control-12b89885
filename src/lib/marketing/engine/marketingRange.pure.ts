/**
 * Calendar ranges for the marketing engine.
 *
 * Meta answers a named preset (`last_30d`) by itself, in the ad account's own
 * time zone. YouTube, Google Ads and TikTok want explicit dates, so the same
 * preset has to be turned into the same two days here — otherwise "Last 30
 * days" on the YouTube tab and "Last 30 days" on the Meta tab describe
 * different months and nothing on the page says so.
 *
 * The presets therefore follow Meta's definitions exactly: `last_Nd` is the N
 * whole days BEFORE today and excludes today, `this_month` includes today.
 *
 * All arithmetic is on calendar dates, never on instants. A day is a
 * YYYY-MM-DD string; adding one is done on its UTC midnight, where no
 * daylight-saving change can move it. "Today" is the only instant read, and it
 * is read in a named time zone.
 */
import type { DateRange } from './marketingTypes.pure.ts';

export type DatePreset =
  | 'today'
  | 'yesterday'
  | 'last_7d'
  | 'last_14d'
  | 'last_30d'
  | 'this_month'
  | 'last_month'
  | 'last_90d';

export const DATE_PRESETS: readonly DatePreset[] = [
  'today',
  'yesterday',
  'last_7d',
  'last_14d',
  'last_30d',
  'this_month',
  'last_month',
  'last_90d',
];

/** Human labels, the same words the Meta tab's picker prints. */
export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  last_7d: 'Last 7 Days',
  last_14d: 'Last 14 Days',
  last_30d: 'Last 30 Days',
  this_month: 'This Month',
  last_month: 'Last Month',
  last_90d: 'Last 90 Days',
};

/** The zone a range is read in when the caller names none. Both deployments are Australian. */
export const DEFAULT_MARKETING_TIME_ZONE = 'Australia/Sydney';

/** The longest custom range accepted. Bounds the vendor calls one request can cause. */
export const MAX_RANGE_DAYS = 366;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** True for a real calendar date written YYYY-MM-DD. `2026-02-30` is not one. */
export function isValidYmd(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = YMD.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
}

function toUtcMs(ymd: string): number {
  const m = YMD.exec(ymd);
  if (!m) throw new Error(`not a date: ${ymd}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fromUtcMs(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/** `addDays('2026-03-31', 1)` is `'2026-04-01'`. Negative moves back. */
export function addDays(ymd: string, days: number): string {
  return fromUtcMs(toUtcMs(ymd) + days * DAY_MS);
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysFrom(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

/** Days in a closed range, both ends counted. */
export function dayCount(range: DateRange): number {
  return daysFrom(range.since, range.until) + 1;
}

/** Every day of a closed range, oldest first. */
export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  const n = dayCount(range);
  for (let i = 0; i < n; i++) out.push(addDays(range.since, i));
  return out;
}

/** A time zone Intl recognises, or the fallback. An unknown zone must not throw from a read path. */
export function safeTimeZone(timeZone: unknown, fallback = DEFAULT_MARKETING_TIME_ZONE): string {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return fallback;
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone }).format(0);
    return timeZone;
  } catch {
    return fallback;
  }
}

/** The calendar date an instant falls on in a time zone. */
export function ymdInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: safeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "Today" for a reader in `timeZone`. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return ymdInTimeZone(now, timeZone);
}

/**
 * The calendar date an ISO instant falls on in a time zone, or null when the
 * string is not an instant. A YouTube upload published at 23:30 UTC belongs to
 * the next day in Sydney, and to the range that day is in.
 */
export function ymdOfInstant(iso: unknown, timeZone: string): string | null {
  if (typeof iso !== 'string' || iso.trim() === '') return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return ymdInTimeZone(new Date(t), timeZone);
}

/** True when `day` (YYYY-MM-DD) is inside the closed range. String order is date order. */
export function rangeContains(range: DateRange, day: string): boolean {
  return day >= range.since && day <= range.until;
}

function firstOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** The two days a preset names, read against `today`. */
export function resolvePreset(preset: DatePreset, today: string): DateRange {
  switch (preset) {
    case 'today':
      return { since: today, until: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { since: y, until: y };
    }
    case 'last_7d':
      return { since: addDays(today, -7), until: addDays(today, -1) };
    case 'last_14d':
      return { since: addDays(today, -14), until: addDays(today, -1) };
    case 'last_30d':
      return { since: addDays(today, -30), until: addDays(today, -1) };
    case 'last_90d':
      return { since: addDays(today, -90), until: addDays(today, -1) };
    case 'this_month':
      return { since: firstOfMonth(today), until: today };
    case 'last_month': {
      const lastOfPrevious = addDays(firstOfMonth(today), -1);
      return { since: firstOfMonth(lastOfPrevious), until: lastOfPrevious };
    }
  }
}

export function isDatePreset(value: unknown): value is DatePreset {
  return typeof value === 'string' && (DATE_PRESETS as readonly string[]).includes(value);
}

export type RangeRequest = {
  datePreset?: unknown;
  timeRange?: unknown;
};

export type ResolvedRange =
  | { ok: true; range: DateRange; preset: DatePreset | null; days: number }
  | { ok: false; error: string };

/**
 * Turn what a page sent into a range, or say exactly why it cannot.
 *
 * A custom range wins over a preset, as it does on the Meta tab. A range that
 * ends after today is refused rather than clamped: a vendor answers a future
 * day with nothing, and a total over days that have not happened yet reads as
 * a fall in performance.
 */
export function resolveRange(
  request: RangeRequest,
  today: string,
  options: { maxDays?: number; defaultPreset?: DatePreset } = {},
): ResolvedRange {
  const maxDays = options.maxDays ?? MAX_RANGE_DAYS;
  const tr = request.timeRange as { since?: unknown; until?: unknown } | null | undefined;
  if (tr && typeof tr === 'object' && (tr.since !== undefined || tr.until !== undefined)) {
    if (!isValidYmd(tr.since) || !isValidYmd(tr.until)) {
      return { ok: false, error: 'A custom range needs two dates written YYYY-MM-DD.' };
    }
    const range = { since: tr.since, until: tr.until };
    if (range.since > range.until) {
      return { ok: false, error: 'A custom range must start on or before the day it ends.' };
    }
    if (range.until > today) {
      return { ok: false, error: 'A custom range cannot end after today.' };
    }
    const days = dayCount(range);
    if (days > maxDays) {
      return { ok: false, error: `A custom range may cover at most ${maxDays} days.` };
    }
    return { ok: true, range, preset: null, days };
  }

  const preset = request.datePreset ?? options.defaultPreset ?? 'last_30d';
  if (!isDatePreset(preset)) {
    return { ok: false, error: `Unknown date preset "${String(preset)}".` };
  }
  const range = resolvePreset(preset, today);
  return { ok: true, range, preset, days: dayCount(range) };
}

/** The range of the same length that ends the day before `range` starts. */
export function previousPeriod(range: DateRange): DateRange {
  const n = dayCount(range);
  return { since: addDays(range.since, -n), until: addDays(range.since, -1) };
}

/**
 * Cut a range into consecutive pieces of at most `maxDays`, oldest first.
 *
 * TikTok refuses a daily report spanning more than thirty days; this is how a
 * ninety-day range is asked for in three questions instead of one refused one.
 */
export function splitRange(range: DateRange, maxDays: number): DateRange[] {
  if (!Number.isInteger(maxDays) || maxDays < 1) throw new Error('maxDays must be a positive integer');
  const out: DateRange[] = [];
  let since = range.since;
  while (since <= range.until) {
    const candidate = addDays(since, maxDays - 1);
    const until = candidate < range.until ? candidate : range.until;
    out.push({ since, until });
    since = addDays(until, 1);
  }
  return out;
}

/** "1 Sep 2026 – 30 Sep 2026", in Australian English, for prose and prompts. */
export function formatRange(range: DateRange): string {
  const fmt = (ymd: string) => {
    const d = new Date(toUtcMs(ymd));
    return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
  };
  return range.since === range.until ? fmt(range.since) : `${fmt(range.since)} – ${fmt(range.until)}`;
}
