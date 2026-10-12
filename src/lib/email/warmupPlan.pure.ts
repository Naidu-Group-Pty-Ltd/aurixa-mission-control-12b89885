/**
 * Email warmup — the rules, without I/O.
 *
 * A warmup pool is a set of mailboxes, in the Microsoft tenants Mission Control
 * holds credentials for, that send each other ordinary-looking mail and then
 * treat what arrives the way an interested person would: open it, rescue it
 * from Junk, now and then flag it, reply to some of it. Mailbox providers read
 * those signals — mail that is opened, replied to and dragged out of spam — as
 * evidence that the sender is wanted, and a new domain or mailbox earns its
 * sending reputation from them. That is what Instantly, Lemwarm and the rest
 * sell; this is the same mechanism run on mailboxes we can act on directly
 * through Microsoft Graph. `src/server/email-warmup.server.ts` is the engine;
 * this file decides how much, when, to whom, and what counts as healthy.
 *
 * ## Only mail between organisations counts
 *
 * Mail from one mailbox to another in the same Microsoft 365 organisation is
 * delivered inside Exchange Online. It never leaves Microsoft's internal
 * routing, is not judged by inbound spam filtering, and does nothing for
 * either domain's reputation — so a pool pairs mailboxes ACROSS organisations
 * and never within one (unless the test-mode setting says otherwise). An
 * organisation is the directory a tenant's token was issued by (`tid`), not
 * the Mission Control tenant row: two app registrations in one directory are
 * one organisation.
 *
 * ## The ramp
 *
 * A mailbox starts at `startPerDay` new conversations a day and adds
 * `increasePerDay` each day it actually warms, up to `maxPerDay`. "Each day it
 * actually warms" — a paused week is not seven days of ramp. Replies are on
 * top of that number: they are the reply rate at work, not new conversations.
 *
 * ## Pacing
 *
 * Sends are spread across the mailbox's own window (its zone, its hours,
 * optionally weekdays only) with a randomised gap, never closer than a few
 * minutes: a burst of forty messages at nine o'clock is the opposite of what
 * a warmup is for.
 */
import {
  minutesOfClock,
  nextWindowOpening,
  windowState,
  zonedParts,
  zonedTimeToInstant,
  type CampaignRules,
} from "@/lib/email/campaignRules.pure";

/** The folder warmup mail is filed into in every mailbox, so it stays out of the inbox. */
export const WARMUP_FOLDER_NAME = "Warmup";
/** Replies to replies stop here: 0 is the first message, so a thread is at most three long. */
export const MAX_THREAD_DEPTH = 2;
/** Inbox placement is judged over this many days. */
export const HEALTH_WINDOW_DAYS = 7;
/** Fewer settled messages than this and there is no score yet, only "not enough mail". */
export const HEALTH_MIN_SAMPLE = 5;
/** No two sends from one mailbox closer than this. */
export const MIN_SEND_GAP_MINUTES = 4;
/** A message not found in the recipient's mailbox after this long is "missing" — quarantined, rejected or deleted. */
export const MISSING_AFTER_MINUTES = 6 * 60;
/** A row still `sending` this long after it was written belongs to a pass that died. */
export const STALE_SENDING_MINUTES = 15;
/** A sent draft still in Drafts this long after the send call was not sent. */
export const DRAFT_STUCK_MINUTES = 45;
/** Engage and reply steps that keep failing give up after this many tries. */
export const MAX_ACTION_ATTEMPTS = 6;
/** Consecutive failed sends that move a mailbox to `error`. */
export const FAILURES_BEFORE_ERROR = 3;

export type WarmupSchedule = {
  /** New conversations on the first day. */
  startPerDay: number;
  /** Added each day the mailbox warms. */
  increasePerDay: number;
  /** The ceiling. */
  maxPerDay: number;
  /** Percent of received warmup mail that gets a reply. */
  replyRate: number;
  /** Percent of received warmup mail that gets flagged — Outlook's "important". */
  importantRate: number;
  weekdaysOnly: boolean;
  timezone: string;
  /** `HH:MM`, in `timezone`. */
  windowStart: string;
  windowEnd: string;
};

/**
 * The defaults are the cautious end of what the warmup services recommend: a
 * couple a day to begin with, a slow climb, thirty as a ceiling, about a third
 * of conversations answered, business hours.
 */
export const DEFAULT_SCHEDULE: WarmupSchedule = {
  startPerDay: 2,
  increasePerDay: 2,
  maxPerDay: 30,
  replyRate: 30,
  importantRate: 15,
  weekdaysOnly: false,
  timezone: "Australia/Sydney",
  windowStart: "08:00",
  windowEnd: "18:00",
};

export const SCHEDULE_LIMITS = {
  startPerDay: { min: 1, max: 50 },
  increasePerDay: { min: 0, max: 20 },
  maxPerDay: { min: 1, max: 100 },
  replyRate: { min: 0, max: 100 },
  importantRate: { min: 0, max: 100 },
} as const;

const CLOCK = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Every reason a schedule cannot be saved, as what to fix. Empty when it can. */
export function scheduleProblems(schedule: Partial<WarmupSchedule>): string[] {
  const problems: string[] = [];
  const numbers: [keyof typeof SCHEDULE_LIMITS, string][] = [
    ["startPerDay", "the starting volume"],
    ["increasePerDay", "the daily increase"],
    ["maxPerDay", "the daily maximum"],
    ["replyRate", "the reply rate"],
    ["importantRate", "the mark-important rate"],
  ];
  for (const [key, name] of numbers) {
    const value = schedule[key];
    if (value === undefined) continue;
    const { min, max } = SCHEDULE_LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be a whole number from ${min} to ${max}`);
    }
  }
  if (
    schedule.startPerDay !== undefined &&
    schedule.maxPerDay !== undefined &&
    schedule.startPerDay > schedule.maxPerDay
  ) {
    problems.push("the starting volume cannot be more than the daily maximum");
  }
  if (schedule.timezone !== undefined && !validZone(schedule.timezone)) {
    problems.push("that time zone is not one this server knows");
  }
  for (const [key, name] of [
    ["windowStart", "the window's start"],
    ["windowEnd", "the window's end"],
  ] as const) {
    const value = schedule[key];
    if (value !== undefined && !CLOCK.test(value))
      problems.push(`${name} must be a time like 08:00`);
  }
  return problems;
}

/** The columns of an `email_warmup_mailboxes` row the schedule is read from. */
export type WarmupScheduleColumns = {
  start_per_day: number;
  increase_per_day: number;
  max_per_day: number;
  reply_rate: number;
  important_rate: number;
  weekdays_only: boolean;
  timezone: string | null;
  window_start: string;
  window_end: string;
};

export function scheduleFromRow(row: WarmupScheduleColumns): WarmupSchedule {
  return {
    startPerDay: row.start_per_day,
    increasePerDay: row.increase_per_day,
    maxPerDay: row.max_per_day,
    replyRate: row.reply_rate,
    importantRate: row.important_rate,
    weekdaysOnly: row.weekdays_only,
    timezone: row.timezone || DEFAULT_SCHEDULE.timezone,
    windowStart: String(row.window_start).slice(0, 5),
    windowEnd: String(row.window_end).slice(0, 5),
  };
}

/**
 * The schedule as a campaign calendar, so the window arithmetic — zones,
 * daylight saving, windows that wrap past midnight — is the code campaigns
 * already trust rather than a second copy of it.
 */
export function warmupRules(schedule: WarmupSchedule): CampaignRules {
  return {
    timezone: schedule.timezone,
    sendDays: schedule.weekdaysOnly ? [1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6, 7],
    windowStart: schedule.windowStart,
    windowEnd: schedule.windowEnd,
    maxMessagesPerDay: null,
    maxRecipientsPerDay: null,
    recipientsPerMessage: 1,
    minGapSeconds: 0,
    maxMessagesPerRun: 1,
    startsAt: null,
    endsAt: null,
  };
}

/** The calendar date an instant falls on in a zone, `YYYY-MM-DD`. */
export function localDate(now: Date, timeZone: string): string {
  const parts = zonedParts(now, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

/** Midnight of the day after the one an instant falls on, in a zone. */
export function startOfNextLocalDay(now: Date, timeZone: string): Date {
  const parts = zonedParts(now, timeZone);
  return zonedTimeToInstant(timeZone, parts.year, parts.month, parts.day + 1);
}

/**
 * Which day of its ramp a mailbox is on today, from 1. `activeDays` counts the
 * days it has sent on, including today if it already has.
 */
export function rampDay(input: {
  activeDays: number;
  lastActiveOn: string | null;
  today: string;
}): number {
  const before = Math.max(0, input.activeDays - (input.lastActiveOn === input.today ? 1 : 0));
  return before + 1;
}

/** How many new conversations a mailbox starts on a given day of its ramp. */
export function dailyTarget(schedule: WarmupSchedule, day: number): number {
  const ramped = schedule.startPerDay + schedule.increasePerDay * Math.max(0, day - 1);
  return Math.max(1, Math.min(schedule.maxPerDay, ramped));
}

/**
 * How much warmup mail a mailbox may RECEIVE in a day. Tied to its own volume,
 * so a mailbox two days into its warmup is not handed fifty messages a day by
 * partners that are further along.
 */
export function receiveCap(target: number): number {
  return Math.max(4, Math.ceil(target * 1.5));
}

/** "2 a day, rising by 2 a day to 30 from day 15" */
export function describeRamp(schedule: WarmupSchedule): string {
  const { startPerDay, increasePerDay, maxPerDay } = schedule;
  if (increasePerDay === 0 || startPerDay >= maxPerDay) {
    return `${Math.min(startPerDay, maxPerDay)} new conversations a day, every day`;
  }
  const topDay = Math.ceil((maxPerDay - startPerDay) / increasePerDay) + 1;
  return `${startPerDay} a day to start, rising by ${increasePerDay} each day it warms, to ${maxPerDay} a day from day ${topDay}`;
}

/** Minutes the window covers in one day. A window whose start equals its end is all day. */
function windowLengthMinutes(schedule: WarmupSchedule): number {
  const start = minutesOfClock(schedule.windowStart);
  const end = minutesOfClock(schedule.windowEnd);
  if (start === end) return 24 * 60;
  return end > start ? end - start : 24 * 60 - start + end;
}

/** When the window that is open at `now` closes. Null when it is not open. */
export function windowCloses(schedule: WarmupSchedule, now: Date): Date | null {
  const rules = warmupRules(schedule);
  if (!windowState(rules, now).open) return null;
  const start = minutesOfClock(schedule.windowStart);
  const end = minutesOfClock(schedule.windowEnd);
  const parts = zonedParts(now, schedule.timezone);
  if (start === end) return startOfNextLocalDay(now, schedule.timezone);
  // A window that wraps past midnight and is open before its end belongs to
  // the window that opened yesterday, and closes today.
  const closesTomorrow = end < start && parts.minutesOfDay >= start;
  return zonedTimeToInstant(
    schedule.timezone,
    parts.year,
    parts.month,
    parts.day + (closesTomorrow ? 1 : 0),
    Math.floor(end / 60),
    end % 60,
  );
}

const MINUTE = 60_000;

/**
 * When a mailbox should send its next warmup message.
 *
 * Inside the window with conversations left to start today, the rest of the
 * window is divided by what is left, and the gap drawn at random around that
 * (±40%), never under `MIN_SEND_GAP_MINUTES` — so a day's sends land spread
 * through it, at irregular intervals. Otherwise, the next opening of the
 * window (tomorrow's, once today's quota is spent), a little after it opens.
 * Null only when the window can never open.
 */
export function nextSendAt(input: {
  schedule: WarmupSchedule;
  now: Date;
  sentToday: number;
  target: number;
  random: () => number;
}): Date | null {
  const { schedule, now, sentToday, target, random } = input;
  const rules = warmupRules(schedule);
  const openingJitter = () =>
    Math.floor(random() * Math.min(25, Math.max(1, windowLengthMinutes(schedule) / 3)) * MINUTE);
  const opening = (from: Date) => {
    const at = nextWindowOpening(rules, from, 9);
    return at ? new Date(at.getTime() + openingJitter()) : null;
  };

  if (sentToday >= target) return opening(startOfNextLocalDay(now, schedule.timezone));
  const closes = windowCloses(schedule, now);
  if (!closes) return opening(now);

  const remaining = target - sentToday;
  const span = closes.getTime() - now.getTime();
  const mean = span / (remaining + 1);
  const gap = Math.min(
    3 * 60 * MINUTE,
    Math.max(MIN_SEND_GAP_MINUTES * MINUTE, mean * (0.6 + random() * 0.8)),
  );
  const at = new Date(now.getTime() + gap);
  if (at.getTime() < closes.getTime()) return at;
  // Not a full gap left before the window closes: one more near the end if
  // there is room for it, otherwise the next opening.
  if (span > MIN_SEND_GAP_MINUTES * 2 * MINUTE) {
    return new Date(now.getTime() + MIN_SEND_GAP_MINUTES * MINUTE + Math.floor(random() * MINUTE));
  }
  return opening(closes);
}

// ── Pairing ──────────────────────────────────────────────────────────────────

export type PoolMember = {
  id: string;
  address: string;
  /** The directory the mailbox's tenant token was issued by. */
  organisationId: string;
  /** Active, prepared, and its tenant's credentials work this pass. */
  eligible: boolean;
  /** Warmup mail sent to it in the last 24 hours. */
  receivedRecent: number;
  receiveCap: number;
};

export type PartnerChoice =
  | { partner: PoolMember; reason: null }
  | { partner: null; reason: string };

/**
 * Who a mailbox writes to next.
 *
 * Only a mailbox in another organisation (see the header), with room left in
 * its receive cap. Among those, the least loaded relative to its cap, with
 * the sender's last few partners pushed back and a little randomness, so the
 * pool's mail spreads across it rather than following one fixed rota.
 */
export function choosePartner(input: {
  senderId: string;
  senderOrganisationId: string;
  members: PoolMember[];
  /** The sender's recent partners, oldest first. */
  recentPartnerIds: string[];
  allowSameOrganisation: boolean;
  random: () => number;
}): PartnerChoice {
  const others = input.members.filter((member) => member.id !== input.senderId && member.eligible);
  if (others.length === 0) {
    return { partner: null, reason: "no other mailbox in the pool is warming" };
  }
  const reachable = input.allowSameOrganisation
    ? others
    : others.filter((member) => member.organisationId !== input.senderOrganisationId);
  if (reachable.length === 0) {
    return {
      partner: null,
      reason:
        "no mailbox in another organisation is warming — mail inside one organisation never leaves Microsoft and builds no reputation",
    };
  }
  const withRoom = reachable.filter((member) => member.receivedRecent < member.receiveCap);
  if (withRoom.length === 0) {
    return { partner: null, reason: "every partner has received its share for today" };
  }
  const recent = new Set(input.recentPartnerIds.slice(-3));
  const scored = withRoom.map((member) => ({
    member,
    score:
      member.receivedRecent / Math.max(1, member.receiveCap) +
      (recent.has(member.id) ? 0.5 : 0) +
      (member.organisationId === input.senderOrganisationId ? 0.75 : 0) +
      input.random() * 0.25,
  }));
  scored.sort((a, b) => a.score - b.score);
  return { partner: scored[0].member, reason: null };
}

// ── What happens to a message once it arrives ───────────────────────────────

export type EngagementPlan = { willReply: boolean; willFlag: boolean };

/**
 * Decided when a message is SENT and stored with it, so what the pool does is
 * a matter of record and a retried step cannot roll the dice again. A reply
 * to a reply is half as likely, and the thread stops at `MAX_THREAD_DEPTH`.
 */
export function engagementPlan(input: {
  replyRate: number;
  importantRate: number;
  depth: number;
  random: () => number;
}): EngagementPlan {
  const replyChance = input.depth === 0 ? input.replyRate : input.replyRate / 2;
  return {
    willReply: input.depth < MAX_THREAD_DEPTH && input.random() * 100 < replyChance,
    willFlag: input.random() * 100 < input.importantRate,
  };
}

/** A whole number of minutes in [min, max]. */
export function minutesBetween(min: number, max: number, random: () => number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** How long after it is found a message is opened: a person, not a robot. */
export const ENGAGE_DELAY_MINUTES = { min: 2, max: 20 } as const;
/** How long after it is opened a message is answered. */
export const REPLY_DELAY_MINUTES = { min: 10, max: 150 } as const;

const CHECK_DELAYS = [3, 5, 10, 15, 30, 30, 60];

/**
 * Minutes until the next look for a message in its recipient's mailbox.
 * Cross-tenant delivery takes seconds to a few minutes; the gaps widen so a
 * slow one is still found without asking Microsoft every two minutes for six
 * hours.
 */
export function checkDelayMinutes(attempt: number): number {
  return CHECK_DELAYS[Math.min(Math.max(0, attempt), CHECK_DELAYS.length - 1)];
}

// ── Health ───────────────────────────────────────────────────────────────────

export type PlacementCounts = { inbox: number; junk: number; other: number; missing: number };

/**
 * Inbox placement as a percentage: of the messages a mailbox sent whose fate
 * is known, how many reached somewhere other than Junk. "Other" is a folder a
 * rule moved it to, which is not spam; "missing" is a message that never
 * appeared at all — quarantined or rejected — which is worse than spam and
 * counts against. Null below `HEALTH_MIN_SAMPLE`.
 */
export function healthScore(counts: PlacementCounts): number | null {
  const total = counts.inbox + counts.other + counts.junk + counts.missing;
  if (total < HEALTH_MIN_SAMPLE) return null;
  return Math.round(((counts.inbox + counts.other) / total) * 100);
}

export type HealthTone = "good" | "fair" | "poor";

export function healthTone(score: number | null): HealthTone | null {
  if (score === null) return null;
  if (score >= 90) return "good";
  if (score >= 75) return "fair";
  return "poor";
}

/**
 * What a campaign about to send from a warming mailbox should be told, or
 * null. Warmup services advise about two weeks before real volume, and a
 * mailbox whose warmup mail is landing in Junk is telling you where campaign
 * mail will land.
 */
export function campaignWarmupAdvice(input: {
  address: string;
  status: string;
  rampDay: number;
  health: number | null;
}): string | null {
  if (input.status === "removed") return null;
  const health =
    input.health === null
      ? ""
      : ` (${input.health}% inbox placement over ${HEALTH_WINDOW_DAYS} days)`;
  if (input.health !== null && input.health < 75) {
    return `${input.address}'s warmup mail is landing in spam${health} — campaign mail from it is likely to land there too`;
  }
  if (input.rampDay < 14) {
    return `${input.address} is on day ${input.rampDay} of its warmup${health} — about two weeks of warmup is the usual advice before campaign volume`;
  }
  return null;
}

// ── Reading the daily figures ────────────────────────────────────────────────

/** One mailbox's day, as `email_warmup_daily` reports it. */
export type WarmupDay = {
  day: string;
  sent: number;
  replies_sent: number;
  inbox: number;
  junk: number;
  other: number;
  missing: number;
  received: number;
  rescued: number;
  replied: number;
};

const DAY_KEYS = [
  "sent",
  "replies_sent",
  "inbox",
  "junk",
  "other",
  "missing",
  "received",
  "rescued",
  "replied",
] as const;

export type WarmupTotals = Omit<WarmupDay, "day">;

export function emptyTotals(): WarmupTotals {
  return {
    sent: 0,
    replies_sent: 0,
    inbox: 0,
    junk: 0,
    other: 0,
    missing: 0,
    received: 0,
    rescued: 0,
    replied: 0,
  };
}

/** `YYYY-MM-DD`, `days` before another. */
export function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** The sum of the days from `from` to `to`, inclusive. */
export function totalsBetween(days: Partial<WarmupDay>[], from: string, to: string): WarmupTotals {
  const totals = emptyTotals();
  for (const row of days) {
    if (!row.day || row.day < from || row.day > to) continue;
    for (const key of DAY_KEYS) totals[key] += Number(row[key] ?? 0);
  }
  return totals;
}

/**
 * A run of consecutive days ending today, every day present — zeros where
 * nothing happened — so a chart's quiet days read as quiet, not as missing.
 */
export function dailySeries(days: Partial<WarmupDay>[], today: string, count: number): WarmupDay[] {
  const byDay = new Map(days.filter((row) => row.day).map((row) => [row.day as string, row]));
  const out: WarmupDay[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const day = daysBefore(today, back);
    const row = byDay.get(day);
    const filled = { day, ...emptyTotals() } as WarmupDay;
    if (row) for (const key of DAY_KEYS) filled[key] = Number(row[key] ?? 0);
    out.push(filled);
  }
  return out;
}
