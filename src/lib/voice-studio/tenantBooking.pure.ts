// Availability and booking rules for a deployed tenant fleet - the same
// deterministic approach as Aurixa's own tools (voice-tools.server.ts), with
// the business's timezone, days and hours as parameters instead of constants.
//
// A promise like "we can do Tuesday at 3" must never depend on a model's date
// arithmetic, so the agent is only ever offered slots this module generated
// and a booking is only ever written for a slot it would still generate.
//
// The caller's day preference (parseSlotPreference / slotMatchesPreference /
// orderSlotsByPreference) lives here once, parameterised by timezone; Aurixa's
// tools call the same functions with Australia/Sydney.

export interface TenantWindow {
  timezone: string;
  /** ISO weekdays: 1 = Monday ... 7 = Sunday. */
  days: number[];
  /** Minutes after local midnight of the first bookable start. */
  firstStartMinutes: number;
  /** Minutes after local midnight of the LAST bookable start. */
  lastStartMinutes: number;
  slotMinutes: number;
  minNoticeHours: number;
  horizonDays: number;
}

export interface BookingTypeDef {
  key: string;
  label: string;
  synonyms: string[];
  durationMinutes: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseHhmm(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The planner's booking window as a tenant window, or null when it is unusable. */
export function tenantWindow(
  w: { days: number[]; startTime: string; endTime: string; slotMinutes: number; minNoticeHours: number; horizonDays: number } | null,
  timezone: string,
): TenantWindow | null {
  if (!w) return null;
  const first = parseHhmm(w.startTime);
  const last = parseHhmm(w.endTime);
  const days = [...new Set(w.days)].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  if (first == null || last == null || last < first || !days.length) return null;
  if (!(w.slotMinutes >= 5 && w.slotMinutes <= 480)) return null;
  return {
    timezone,
    days,
    firstStartMinutes: first,
    lastStartMinutes: last,
    slotMinutes: w.slotMinutes,
    minNoticeHours: Math.max(0, w.minNoticeHours),
    horizonDays: Math.min(Math.max(1, w.horizonDays), 120),
  };
}

export interface ZoneParts {
  y: number;
  m: number;
  d: number;
  /** 0 = Sunday ... 6 = Saturday */
  day: number;
  minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

export function zoneParts(date: Date, timezone: string): ZoneParts {
  let fmt = formatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-AU", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    formatters.set(timezone, fmt);
  }
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    day: WEEKDAYS.indexOf(get("weekday").slice(0, 3)),
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

const STEP_MS = 5 * 60_000;

/**
 * Candidate slot starts over the horizon, as UTC instants. Scanned in five-
 * minute steps so a window starting at 8:45, or a zone offset by 30 or 45
 * minutes, lands on its real starts; a start is kept when it is on a bookable
 * day, inside the window and a whole number of slots after the first start.
 */
export function candidateSlotsIn(now: Date, w: TenantWindow): Date[] {
  const slots: Date[] = [];
  const earliest = now.getTime() + w.minNoticeHours * 3_600_000;
  const start = Math.ceil(earliest / STEP_MS) * STEP_MS;
  const end = now.getTime() + w.horizonDays * 86_400_000;
  const isoDays = new Set(w.days.map((d) => d % 7)); // ISO 7 (Sunday) -> 0
  for (let t = start; t < end; t += STEP_MS) {
    const d = new Date(t);
    const p = zoneParts(d, w.timezone);
    if (!isoDays.has(p.day)) continue;
    if (p.minutes < w.firstStartMinutes || p.minutes > w.lastStartMinutes) continue;
    if ((p.minutes - w.firstStartMinutes) % w.slotMinutes !== 0) continue;
    slots.push(d);
  }
  return slots;
}

/** Slots from `candidates` that no booked interval overlaps, for a booking of `minutes`. */
export function freeOf(candidates: Date[], booked: Array<{ start: number; end: number }>, minutes: number): Date[] {
  return candidates.filter((slot) => {
    const s = slot.getTime();
    const e = s + minutes * 60_000;
    return !booked.some((b) => s < b.end && e > b.start);
  });
}

export function slotSpoken(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

// ------------------------------------------------------------ booking type --

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Which booking type the caller means. Matched on the type's key, label and
 * synonyms as whole phrases; one configured type is the answer to everything;
 * anything ambiguous asks rather than guesses.
 */
export function classifyBookingType(
  text: string | null | undefined,
  types: BookingTypeDef[],
): { type: BookingTypeDef | null; clarificationQuestion: string | null } {
  if (types.length === 0) return { type: null, clarificationQuestion: "This business has no bookable appointment types configured." };
  if (types.length === 1) return { type: types[0], clarificationQuestion: null };
  const t = ` ${norm(text ?? "")} `;
  const hits = types.filter((ty) =>
    [ty.key.replace(/_/g, " "), ty.label, ...ty.synonyms].some((p) => {
      const phrase = norm(p);
      return phrase.length > 0 && t.includes(` ${phrase} `);
    }),
  );
  if (hits.length === 1) return { type: hits[0], clarificationQuestion: null };
  const labels = types.map((ty) => ty.label);
  const list = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}` : labels[0];
  return { type: null, clarificationQuestion: `Is this for a ${list}?` };
}

// ------------------------------------------------------------- preference --

export type SlotPreference = {
  weekday: number | null;
  dayOfMonth: number | null;
  month: number | null;
  partOfDay: "morning" | "afternoon" | null;
  recognised: boolean;
};

const WEEKDAY_WORDS: Array<[RegExp, number]> = [
  [/\bsun(day)?\b/, 0],
  [/\bmon(day)?\b/, 1],
  [/\btue(s|sday)?\b/, 2],
  [/\bwed(s|nesday)?\b/, 3],
  [/\bthu(r|rs|rsday)?\b/, 4],
  [/\bfri(day)?\b/, 5],
  [/\bsat(urday)?\b/, 6],
];

const MONTH_WORDS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * The caller's day preference. Deliberately narrow: a weekday name, a relative
 * day, a day-of-month with an optional month, and morning/afternoon. Anything
 * else is left unrecognised rather than guessed - an invented preference
 * silently reorders what the caller is offered.
 */
export function parseSlotPreference(text: string | null | undefined, now: Date, timezone: string): SlotPreference {
  const pref: SlotPreference = { weekday: null, dayOfMonth: null, month: null, partOfDay: null, recognised: false };
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return pref;

  // Relative days resolve to an absolute LOCAL date, because "tomorrow" said
  // at 11pm local is a different date from "tomorrow" said at 9am UTC.
  const relativeDays = /\bday after tomorrow\b/.test(t) ? 2 : /\btomorrow\b/.test(t) ? 1 : /\btoday\b/.test(t) ? 0 : null;
  if (relativeDays !== null) {
    const p = zoneParts(new Date(now.getTime() + relativeDays * 86_400_000), timezone);
    pref.dayOfMonth = p.d;
    pref.month = p.m;
    pref.recognised = true;
  } else {
    for (const [re, day] of WEEKDAY_WORDS) {
      if (re.test(t)) {
        pref.weekday = day;
        pref.recognised = true;
        break;
      }
    }
    // "the 18th", "18 September", "18/9"
    const dom = /\b(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:am|pm|:|o'?clock))/.exec(t);
    // The full name or its three-letter form, both whole words - `\bmay` alone
    // reads "maybe" as May.
    const monthIndex = MONTH_WORDS.findIndex((m) => new RegExp(`\\b(${m}|${m.slice(0, 3)})\\b`).test(t));
    if (dom) {
      const n = Number(dom[1]);
      if (n >= 1 && n <= 31) {
        pref.dayOfMonth = n;
        pref.recognised = true;
        if (monthIndex >= 0) pref.month = monthIndex + 1;
      }
    }
  }

  if (/\bmorning\b|\bbefore lunch\b|\bam\b/.test(t)) {
    pref.partOfDay = "morning";
    pref.recognised = true;
  } else if (/\bafternoon\b|\bafter lunch\b|\bpm\b|\blate in the day\b/.test(t)) {
    pref.partOfDay = "afternoon";
    pref.recognised = true;
  }
  return pref;
}

/** Does this slot satisfy every constraint the caller actually stated? */
export function slotMatchesPreference(slot: Date, pref: SlotPreference, timezone: string): boolean {
  if (!pref.recognised) return false;
  const p = zoneParts(slot, timezone);
  if (pref.weekday !== null && p.day !== pref.weekday) return false;
  if (pref.dayOfMonth !== null && p.d !== pref.dayOfMonth) return false;
  if (pref.month !== null && p.m !== pref.month) return false;
  if (pref.partOfDay === "morning" && p.minutes >= 12 * 60) return false;
  if (pref.partOfDay === "afternoon" && p.minutes < 12 * 60) return false;
  return true;
}

/**
 * Preferred slots first, everything else after, each half still in time order.
 * A SORT, never a filter: a caller who asks for Thursday and has no Thursday
 * free must still be offered something. An unrecognised preference returns the
 * input untouched.
 */
export function orderSlotsByPreference(slots: Date[], pref: SlotPreference, timezone: string): Date[] {
  if (!pref.recognised) return slots;
  const preferred: Date[] = [];
  const rest: Date[] = [];
  for (const s of slots) (slotMatchesPreference(s, pref, timezone) ? preferred : rest).push(s);
  return [...preferred, ...rest];
}
