/**
 * When a campaign may send, how fast, and to whom — the whole ruleset, decided
 * without touching a database or a clock of its own.
 *
 * Every input arrives as an argument, so the awkward cases can be tested
 * rather than reasoned about: the last minute of a sending window, the hour a
 * daylight-saving change repeats, a campaign whose gap is longer than the
 * dispatcher's own tick.
 *
 * ## Two things worth knowing before changing a rule here
 *
 * **The zone is the campaign's, never the server's.** This runs in a
 * Cloudflare Worker, which is UTC wherever it happens to be executing. A
 * window of 09:00–17:00 written by somebody in Sydney means 09:00 in Sydney,
 * and a scheduler that reads the server's own clock mails an Australian list
 * at ten at night for half the year and eleven for the other half. Every
 * comparison here goes through `zonedParts`.
 *
 * **A cap is counted in its own units.** "Emails per day" and "contacts per
 * day" are different numbers the moment one message carries forty people, and
 * conflating them was the first thing to get wrong: a campaign capped at 200 a
 * day and batching 40 to a message either sends 200 messages (8,000 people) or
 * 5 messages, depending on which of the two you meant. Both are here, both
 * nullable, and neither is derived from the other.
 */

export type CampaignRules = {
  timezone: string;
  /** ISO weekday numbers: 1 = Monday … 7 = Sunday. */
  sendDays: number[];
  /** `HH:MM`, in the campaign's zone. */
  windowStart: string;
  windowEnd: string;
  maxMessagesPerDay: number | null;
  maxRecipientsPerDay: number | null;
  recipientsPerMessage: number;
  minGapSeconds: number;
  maxMessagesPerRun: number;
  startsAt: string | null;
  endsAt: string | null;
};

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  minutesOfDay: number;
};

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = PART_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    PART_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock reading in a zone, for an instant. */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatterFor(timeZone).formatToParts(date);
  } catch {
    // An unknown zone must not stop a campaign dead. UTC is wrong by hours;
    // throwing is wrong by the whole campaign.
    parts = formatterFor("UTC").formatToParts(date);
  }
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const year = read("year");
  const month = read("month");
  const day = read("day");
  // `h23` still renders midnight as 24 in some ICU builds.
  const hour = read("hour") % 24;
  const minute = read("minute");
  const second = read("second");
  const weekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
  return { year, month, day, hour, minute, second, weekday, minutesOfDay: hour * 60 + minute };
}

/** How far ahead of UTC a zone is, at an instant. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

/**
 * The instant a wall-clock reading names in a zone.
 *
 * Two passes, because the offset depends on the answer: the first guess uses
 * the offset at the wrong instant, and around a daylight-saving change that is
 * an hour out. Re-reading the offset at the corrected instant settles it.
 */
export function zonedTimeToInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = naive - zoneOffsetMs(new Date(naive), timeZone);
  const second_ = naive - zoneOffsetMs(new Date(first), timeZone);
  return new Date(second_);
}

/** Midnight, in the campaign's zone, of the day an instant falls in. */
export function startOfZonedDay(date: Date, timeZone: string): Date {
  const parts = zonedParts(date, timeZone);
  return zonedTimeToInstant(timeZone, parts.year, parts.month, parts.day);
}

/** `HH:MM` → minutes since midnight. Tolerates `HH:MM:SS`, which is how Postgres renders `time`. */
export function minutesOfClock(clock: string): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(clock ?? "").trim());
  if (!match) return 0;
  return Math.min(23, Number(match[1])) * 60 + Math.min(59, Number(match[2]));
}

export type WindowState =
  | { open: true }
  | {
      open: false;
      reason: "before_start" | "after_end" | "day_not_selected" | "outside_hours";
      detail: string;
    };

/** Whether the campaign's own calendar says now is a time it may send. */
export function windowState(rules: CampaignRules, now: Date): WindowState {
  if (rules.startsAt && now.getTime() < Date.parse(rules.startsAt)) {
    return { open: false, reason: "before_start", detail: "the campaign has not started yet" };
  }
  if (rules.endsAt && now.getTime() > Date.parse(rules.endsAt)) {
    return { open: false, reason: "after_end", detail: "the campaign's end date has passed" };
  }

  const parts = zonedParts(now, rules.timezone);
  const days = rules.sendDays?.length ? rules.sendDays : [1, 2, 3, 4, 5, 6, 7];
  if (!days.includes(parts.weekday)) {
    return {
      open: false,
      reason: "day_not_selected",
      detail: "today is not one of this campaign's sending days",
    };
  }

  const start = minutesOfClock(rules.windowStart);
  const end = minutesOfClock(rules.windowEnd);
  const at = parts.minutesOfDay;
  // A window whose end is before its start wraps past midnight, which is a
  // legitimate thing to ask for and reads as an empty window if not handled.
  // One whose start EQUALS its end — 00:00–00:00 — is the whole day: read as
  // half-open it would be a window that never opens, and a running campaign
  // that sends nothing for ever, which nobody setting that value meant.
  const open =
    start === end ? true : start < end ? at >= start && at < end : at >= start || at < end;
  if (!open) {
    return {
      open: false,
      reason: "outside_hours",
      detail: `outside the ${String(rules.windowStart).slice(0, 5)}–${String(rules.windowEnd).slice(0, 5)} window (${rules.timezone})`,
    };
  }
  return { open: true };
}

/** The columns of an `email_campaigns` row the rules are read from. */
export type CampaignRuleColumns = {
  timezone: string | null;
  send_days: number[] | null;
  window_start: string;
  window_end: string;
  max_messages_per_day: number | null;
  max_recipients_per_day: number | null;
  recipients_per_message: number;
  min_gap_seconds: number;
  max_messages_per_run: number;
  starts_at: string | null;
  ends_at: string | null;
};

/**
 * A campaign row → its ruleset. One reading, used by the dispatcher and by the
 * page, so "when will this send" has the same answer in both places.
 */
export function campaignRulesFromRow(row: CampaignRuleColumns): CampaignRules {
  return {
    timezone: row.timezone || "Australia/Sydney",
    sendDays: row.send_days?.length ? row.send_days : [1, 2, 3, 4, 5, 6, 7],
    windowStart: row.window_start,
    windowEnd: row.window_end,
    maxMessagesPerDay: row.max_messages_per_day,
    maxRecipientsPerDay: row.max_recipients_per_day,
    recipientsPerMessage: row.recipients_per_message,
    minGapSeconds: row.min_gap_seconds,
    maxMessagesPerRun: row.max_messages_per_run,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

/** A calendar date in a zone, `days` after the one an instant falls on. */
function zonedDatePlus(
  from: ZonedParts,
  days: number,
): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(from.year, from.month - 1, from.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * The first instant at or after `from` that the campaign's calendar allows a
 * send, or null when it never will (its end date has passed, or no day is
 * selected).
 *
 * Every candidate is a wall-clock boundary in the CAMPAIGN'S zone — the start
 * of each day's window, and midnight for a window that wraps past it —
 * converted to an instant for that specific date, and then confirmed with
 * `windowState` itself. Confirming rather than assuming is what keeps this
 * honest across daylight saving: on the night a zone's clocks jump, a
 * wall-clock time can name no instant at all, or two.
 */
export function nextWindowOpening(rules: CampaignRules, from: Date, horizonDays = 9): Date | null {
  const startsAt = rules.startsAt ? Date.parse(rules.startsAt) : null;
  const endsAt = rules.endsAt ? Date.parse(rules.endsAt) : null;
  let at = from;
  if (startsAt != null && Number.isFinite(startsAt) && at.getTime() < startsAt) {
    at = new Date(startsAt);
  }
  if (endsAt != null && Number.isFinite(endsAt) && at.getTime() > endsAt) return null;
  if (windowState(rules, at).open) return at;

  const start = minutesOfClock(rules.windowStart);
  const end = minutesOfClock(rules.windowEnd);
  const wraps = end < start;
  const base = zonedParts(at, rules.timezone);
  const candidates: Date[] = [];
  for (let offset = 0; offset <= horizonDays; offset++) {
    const date = zonedDatePlus(base, offset);
    const clocks = [start, ...(wraps || start === end ? [0] : [])];
    for (const minutes of clocks) {
      candidates.push(
        zonedTimeToInstant(
          rules.timezone,
          date.year,
          date.month,
          date.day,
          Math.floor(minutes / 60),
          minutes % 60,
        ),
      );
    }
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  for (const candidate of candidates) {
    if (candidate.getTime() <= at.getTime()) continue;
    if (endsAt != null && candidate.getTime() > endsAt) return null;
    if (windowState(rules, candidate).open) return candidate;
  }
  return null;
}

/**
 * When the next message may go, all rules considered: the calendar, the gap
 * since the last message, and today's caps. `now` when it may go now.
 *
 * This is what the page shows as "next message", and what the dispatcher
 * records after every pass — so "running, and nothing is happening" always
 * comes with the reason and the time it ends.
 */
export function nextSendTime(input: {
  rules: CampaignRules;
  now: Date;
  lastMessageAt: string | null;
  messagesToday: number;
  recipientsToday: number;
}): Date | null {
  const { rules, now } = input;
  let earliest = now.getTime();
  if (rules.minGapSeconds > 0 && input.lastMessageAt) {
    const due = Date.parse(input.lastMessageAt) + rules.minGapSeconds * 1000;
    if (Number.isFinite(due) && due > earliest) earliest = due;
  }
  const capSpent =
    (rules.maxMessagesPerDay != null && input.messagesToday >= rules.maxMessagesPerDay) ||
    (rules.maxRecipientsPerDay != null && input.recipientsToday >= rules.maxRecipientsPerDay);
  if (capSpent) {
    const today = zonedParts(now, rules.timezone);
    const tomorrow = zonedDatePlus(today, 1);
    const midnight = zonedTimeToInstant(
      rules.timezone,
      tomorrow.year,
      tomorrow.month,
      tomorrow.day,
    );
    if (midnight.getTime() > earliest) earliest = midnight.getTime();
  }
  return nextWindowOpening(rules, new Date(earliest));
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** `[1,2,3,4,5]` → "Mon–Fri"; `[1,3,5]` → "Mon, Wed, Fri"; all seven → "every day". */
export function describeSendDays(days: number[] | null | undefined): string {
  const set = [
    ...new Set((days?.length ? days : [1, 2, 3, 4, 5, 6, 7]).filter((d) => d >= 1 && d <= 7)),
  ].sort((a, b) => a - b);
  if (set.length === 7) return "every day";
  if (set.length === 0) return "no days";
  const contiguous = set.every((day, index) => index === 0 || day === set[index - 1] + 1);
  if (contiguous && set.length >= 3)
    return `${DAY_NAMES[set[0] - 1]}–${DAY_NAMES[set[set.length - 1] - 1]}`;
  return set.map((day) => DAY_NAMES[day - 1]).join(", ");
}

/** "Mon–Fri, 09:00–17:00 Australia/Sydney" — the calendar in one line. */
export function describeSchedule(rules: CampaignRules): string {
  const start = String(rules.windowStart ?? "").slice(0, 5);
  const end = String(rules.windowEnd ?? "").slice(0, 5);
  const hours = minutesOfClock(start) === minutesOfClock(end) ? "all day" : `${start}–${end}`;
  return `${describeSendDays(rules.sendDays)}, ${hours} ${rules.timezone}`;
}

/** An instant as the campaign's own clock reads it: "Tue 13 Oct, 09:00". */
export function formatInZone(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-AU", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export type TickPlan = {
  canSend: boolean;
  /** Why not, in words an operator can act on. Null when it can. */
  blockedBy: string | null;
  /** Messages this tick may send, after every cap. */
  messageAllowance: number;
  /** Contacts this tick may reach, after the daily contact cap. */
  recipientAllowance: number;
  /** Wait before the first message, honouring the gap since the last one. */
  initialDelayMs: number;
};

export type TickInput = {
  rules: CampaignRules;
  now: Date;
  lastMessageAt: string | null;
  messagesToday: number;
  recipientsToday: number;
  pendingCount: number;
};

/** What one dispatcher tick is allowed to do for one campaign. */
export function planTick(input: TickInput): TickPlan {
  const { rules, now } = input;
  const idle: TickPlan = {
    canSend: false,
    blockedBy: null,
    messageAllowance: 0,
    recipientAllowance: 0,
    initialDelayMs: 0,
  };

  if (input.pendingCount <= 0) {
    return { ...idle, blockedBy: "no recipients are waiting" };
  }

  const window = windowState(rules, now);
  if (!window.open) return { ...idle, blockedBy: window.detail };

  const perMessage = Math.max(1, rules.recipientsPerMessage);

  let messageAllowance = Math.max(0, rules.maxMessagesPerRun);
  if (rules.maxMessagesPerDay != null) {
    const left = rules.maxMessagesPerDay - input.messagesToday;
    if (left <= 0) return { ...idle, blockedBy: "today's message limit has been reached" };
    messageAllowance = Math.min(messageAllowance, left);
  }

  let recipientAllowance = messageAllowance * perMessage;
  if (rules.maxRecipientsPerDay != null) {
    const left = rules.maxRecipientsPerDay - input.recipientsToday;
    if (left <= 0) return { ...idle, blockedBy: "today's contact limit has been reached" };
    recipientAllowance = Math.min(recipientAllowance, left);
    // A contact cap smaller than one full message still permits a smaller
    // message; it must not silently permit a full one.
    messageAllowance = Math.min(messageAllowance, Math.ceil(recipientAllowance / perMessage));
  }

  recipientAllowance = Math.min(recipientAllowance, input.pendingCount);
  messageAllowance = Math.min(messageAllowance, Math.ceil(recipientAllowance / perMessage));

  if (messageAllowance <= 0 || recipientAllowance <= 0) {
    return { ...idle, blockedBy: "no allowance left in this run" };
  }

  let initialDelayMs = 0;
  if (rules.minGapSeconds > 0 && input.lastMessageAt) {
    const since = now.getTime() - Date.parse(input.lastMessageAt);
    const gap = rules.minGapSeconds * 1000;
    if (Number.isFinite(since) && since < gap) initialDelayMs = gap - since;
  }

  return {
    canSend: true,
    blockedBy: null,
    messageAllowance,
    recipientAllowance,
    initialDelayMs,
  };
}

// ── Per-parameter quotas ────────────────────────────────────────────────────

export type QuotaRule = {
  id: string;
  dimension: string;
  dimensionLabel: string;
  /** Normalised values this rule covers. */
  matchValues: string[];
  valueLabel: string;
  maxPerDay: number | null;
  maxTotal: number | null;
  enabled: boolean;
};

export type QuotaUsage = { today: number; total: number };

export type QuotaBlock = { rule: QuotaRule; scope: "day" | "total" };

/** Whether a contact's attributes fall under a rule. */
export function quotaCovers(rule: QuotaRule, attributesNorm: Record<string, string>): boolean {
  const value = attributesNorm?.[rule.dimension];
  if (value == null || value === "") return false;
  return rule.matchValues.includes(value);
}

/**
 * The first rule that refuses this contact right now, or null.
 *
 * `taken` is what THIS tick has already allocated. Without it a tick planning
 * forty messages against a quota of twenty reads the same "twenty already
 * sent" for every one of them and sends all forty — the quota holds across
 * ticks and fails inside one, which is the harder failure to notice because
 * the daily total looks correct until the day it does not.
 */
export function quotaBlocking(
  rules: QuotaRule[],
  usage: Map<string, QuotaUsage>,
  taken: Map<string, number>,
  attributesNorm: Record<string, string>,
): QuotaBlock | null {
  for (const rule of rules) {
    if (!rule.enabled || !quotaCovers(rule, attributesNorm)) continue;
    const seen = usage.get(rule.id) ?? { today: 0, total: 0 };
    const claimed = taken.get(rule.id) ?? 0;
    if (rule.maxPerDay != null && seen.today + claimed >= rule.maxPerDay) {
      return { rule, scope: "day" };
    }
    if (rule.maxTotal != null && seen.total + claimed >= rule.maxTotal) {
      return { rule, scope: "total" };
    }
  }
  return null;
}

/** Record one allocation against every rule that covers a contact. */
export function claimQuota(
  rules: QuotaRule[],
  taken: Map<string, number>,
  attributesNorm: Record<string, string>,
): void {
  for (const rule of rules) {
    if (!rule.enabled || !quotaCovers(rule, attributesNorm)) continue;
    taken.set(rule.id, (taken.get(rule.id) ?? 0) + 1);
  }
}
