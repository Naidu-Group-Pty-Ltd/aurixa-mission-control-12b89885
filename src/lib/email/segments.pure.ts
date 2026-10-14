/**
 * Segments: every message goes to people who share one value of one column,
 * and a sending time sends each segment its own share.
 *
 * The shape this exists for: a list carrying a `State` column, sent fifty to a
 * message, one message per state at each of four sending times, Monday to
 * Saturday. Without segments a fifty-person BCC batch is simply the next fifty
 * contacts in the file — NSW, VIC and QLD mixed in one message — and "one
 * message per state" is not something any setting can say.
 *
 * Four rules, each decided here so it can be tested rather than reasoned about:
 *
 * **A segment is a SET of values, like a quota.** `NSW` and `New South Wales`
 * are one state. The operator says so — `suggestSegments` pre-groups
 * Australian state spellings — and nothing in anybody's list is rewritten.
 *
 * **A contact belongs to at most one segment.** Two segments both claiming
 * `nsw` would make "one NSW message per sending time" mean two, so overlap is
 * refused when a segment is saved, and `overlappingValues` names the values.
 *
 * **The segment's own column is the same for everybody in its message.** So
 * `{{state}}` may appear in a batched message — it renders the segment's label
 * — where any other column still forces one contact per message.
 *
 * **Turns rotate.** Segments are served least recently served first. When a
 * sending time is long enough for every segment that changes nothing; when it
 * is not — six segments, a ten-minute gap, a thirty-minute grace — it is the
 * difference between the last two segments going first next time and never
 * going at all.
 */
import { auStateCode, type ColumnProfile } from "./listProfile.pure";
import {
  isSlotMode,
  normaliseSendTimes,
  slotOccurrences,
  zonedParts,
  type CampaignRules,
} from "./campaignRules.pure";

/** More than this and a "segment" is a contact list of its own. */
export const MAX_SEGMENTS = 50;

/**
 * Share of a column's filled cells that must read as Australian states before
 * its suggestions are grouped by state. Below it the column is something else
 * that happens to contain `WA`, and grouping would be a guess.
 */
export const AU_STATE_SHARE = 0.8;

/** The order states are listed in, so the suggestion reads like a map. */
const AU_ORDER = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

export type Segment = {
  id: string;
  label: string;
  /** Normalised values (`attributes_norm`) this segment covers. */
  matchValues: string[];
  position: number;
  enabled: boolean;
};

/** Whether a contact's attributes fall in a segment. A blank value is in none. */
export function segmentCovers(
  segment: Pick<Segment, "matchValues">,
  dimension: string,
  attributesNorm: Record<string, string> | null | undefined,
): boolean {
  const value = attributesNorm?.[dimension];
  if (value == null || value === "") return false;
  return segment.matchValues.includes(value);
}

/** Values more than one segment claims. Empty when the segments are disjoint. */
export function overlappingValues(segments: Pick<Segment, "id" | "matchValues">[]): string[] {
  const owner = new Map<string, string>();
  const overlap = new Set<string>();
  for (const segment of segments) {
    for (const value of segment.matchValues) {
      const held = owner.get(value);
      if (held !== undefined && held !== segment.id) overlap.add(value);
      else owner.set(value, segment.id);
    }
  }
  return [...overlap];
}

/**
 * Every parameter column across every list a campaign has taken, merged by
 * key, from each import's own column snapshot: two lists that both carry
 * `state` are one column, with their values counted together.
 */
export function importedDimensions(imports: { columns?: unknown }[]): ColumnProfile[] {
  const merged = new Map<string, ColumnProfile>();
  for (const row of imports) {
    const columns = Array.isArray(row.columns) ? (row.columns as ColumnProfile[]) : [];
    for (const column of columns) {
      if (!column?.isDimension) continue;
      const existing = merged.get(column.key);
      if (!existing) {
        merged.set(column.key, { ...column, values: [...(column.values ?? [])] });
        continue;
      }
      const values = new Map(existing.values.map((value) => [value.value, { ...value }]));
      for (const value of column.values ?? []) {
        const seen = values.get(value.value);
        if (seen) seen.count += value.count;
        else values.set(value.value, { ...value });
      }
      existing.values = [...values.values()].sort((a, b) => b.count - a.count);
      existing.distinct = existing.values.length;
    }
  }
  return [...merged.values()];
}

export type SegmentSuggestion = {
  label: string;
  matchValues: string[];
  /** Contacts the list holds with these values — the list, not what is still waiting. */
  contacts: number;
};

/**
 * One segment per value a column holds — or, for a column of Australian
 * states, one per state with every spelling the list uses gathered into it:
 * `NSW`, `nsw` and `New South Wales` become the segment "NSW". Values that are
 * not states keep a segment of their own, so nothing is silently left out.
 */
export function suggestSegments(column: Pick<ColumnProfile, "values">): SegmentSuggestion[] {
  const values = column.values ?? [];
  const total = values.reduce((sum, value) => sum + value.count, 0);
  const recognised = values
    .filter((value) => auStateCode(value.value) != null)
    .reduce((sum, value) => sum + value.count, 0);

  const out: SegmentSuggestion[] = [];
  if (total > 0 && recognised / total >= AU_STATE_SHARE) {
    const states = new Map<string, SegmentSuggestion>();
    const rest: SegmentSuggestion[] = [];
    for (const value of values) {
      const code = auStateCode(value.value);
      if (!code) {
        rest.push({ label: value.label, matchValues: [value.value], contacts: value.count });
        continue;
      }
      const group = states.get(code) ?? { label: code, matchValues: [], contacts: 0 };
      group.matchValues.push(value.value);
      group.contacts += value.count;
      states.set(code, group);
    }
    for (const code of AU_ORDER) {
      const group = states.get(code);
      if (group) out.push(group);
    }
    out.push(...rest);
  } else {
    for (const value of values) {
      out.push({ label: value.label, matchValues: [value.value], contacts: value.count });
    }
  }

  // Labels are unique per campaign; two values a person spells alike get a suffix.
  const taken = new Set<string>();
  return out.slice(0, MAX_SEGMENTS).map((suggestion) => {
    let label = suggestion.label.trim().slice(0, 120) || "(blank)";
    for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${suggestion.label} (${n})`;
    taken.add(label.toLowerCase());
    return { ...suggestion, label };
  });
}

export type SegmentTurn = {
  segment: Segment;
  /** Messages it may still have in the sending time open now; Infinity outside one. */
  remaining: number;
};

/**
 * The order the enabled segments are served in this pass, and how many
 * messages each may still have. Least recently served first, then the
 * operator's own order — see "Turns rotate" above.
 */
export function segmentTurns(input: {
  segments: Segment[];
  /** Messages each segment may have per sending time; null with a window. */
  perSlot: number | null;
  sentThisSlot: ReadonlyMap<string, number>;
  /** Epoch ms each segment last had a message started, from the ledger. */
  lastServedAt: ReadonlyMap<string, number>;
}): SegmentTurn[] {
  const never = Number.NEGATIVE_INFINITY;
  return input.segments
    .filter((segment) => segment.enabled)
    .map((segment) => ({
      segment,
      last: input.lastServedAt.get(segment.id) ?? never,
      remaining:
        input.perSlot == null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, input.perSlot - (input.sentThisSlot.get(segment.id) ?? 0)),
    }))
    .sort((a, b) => {
      if (a.last !== b.last) return a.last < b.last ? -1 : 1;
      return (
        a.segment.position - b.segment.position || a.segment.label.localeCompare(b.segment.label)
      );
    })
    .map(({ segment, remaining }) => ({ segment, remaining }));
}

// ── What a calendar of sending times can carry ─────────────────────────────

export type Throughput = { messages: number | null; contacts: number | null };

export type SlotCapacity = {
  slotsPerDay: number;
  sendDaysPerWeek: number;
  /** Null on an axis nothing limits. */
  perSlot: Throughput;
  perDay: Throughput;
  perWeek: Throughput;
};

const minOf = (...values: (number | null | undefined)[]): number | null => {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value));
  return finite.length ? Math.max(0, Math.min(...finite)) : null;
};

/**
 * Messages one sending time can carry: its own limit, every segment's share,
 * and how many gaps fit in the time it stays open. Null when none applies.
 */
export function messagesPerSlot(input: {
  rules: Pick<CampaignRules, "maxMessagesPerSlot" | "minGapSeconds" | "slotGraceMinutes">;
  /** Enabled segments, or null when the campaign is not segmented. */
  segments: number | null;
  segmentMessagesPerSlot: number;
  /** How long this sending time is open; the grace when not given. */
  openSeconds?: number;
}): number | null {
  const { rules } = input;
  const open = input.openSeconds ?? Math.max(1, rules.slotGraceMinutes) * 60;
  return minOf(
    rules.maxMessagesPerSlot,
    input.segments == null ? null : input.segments * Math.max(1, input.segmentMessagesPerSlot),
    rules.minGapSeconds > 0 ? Math.floor(open / rules.minGapSeconds) + 1 : null,
  );
}

/**
 * What the calendar carries at full stretch: per sending time, per day and per
 * week — "6 messages × 50 = 300 contacts each time, 1,200 a day, 7,200 a week".
 * Before quotas, and before the list runs out.
 */
export function slotCapacity(input: {
  rules: CampaignRules;
  perMessage: number;
  segments: number | null;
  segmentMessagesPerSlot: number;
}): SlotCapacity {
  const { rules } = input;
  const perMessage = Math.max(1, input.perMessage);
  const slotsPerDay = normaliseSendTimes(rules.sendTimes).length;
  const sendDaysPerWeek = new Set(
    (rules.sendDays?.length ? rules.sendDays : [1, 2, 3, 4, 5, 6, 7]).filter(
      (d) => d >= 1 && d <= 7,
    ),
  ).size;

  const slotMessages = messagesPerSlot(input);
  const perSlot: Throughput = {
    messages: slotMessages,
    contacts: slotMessages == null ? null : slotMessages * perMessage,
  };
  const dayMessages = minOf(
    slotMessages == null ? null : slotMessages * slotsPerDay,
    rules.maxMessagesPerDay,
  );
  const perDay: Throughput = {
    messages: dayMessages,
    contacts: minOf(
      dayMessages == null ? null : dayMessages * perMessage,
      rules.maxRecipientsPerDay,
    ),
  };
  const week = (value: number | null) => (value == null ? null : value * sendDaysPerWeek);
  return {
    slotsPerDay,
    sendDaysPerWeek,
    perSlot,
    perDay,
    perWeek: { messages: week(perDay.messages), contacts: week(perDay.contacts) },
  };
}

// ── When the list runs out ──────────────────────────────────────────────────

export type ForecastSegment = {
  id: string;
  label: string;
  /** Contacts in this segment still waiting. */
  pending: number;
  /** Epoch ms of its last message, so the simulation rotates as the dispatcher does. */
  lastServedAt?: number | null;
  /** Messages it has already had in the sending time open at `from`. */
  sentThisSlot?: number;
};

export type PlannedSlot = {
  at: Date;
  clock: string;
  messages: number;
  contacts: number;
  /** Segment labels, in the order they are expected to go. */
  segments: string[];
};

export type SlotForecast = {
  /** Sending times the plan lists, soonest first, each with what it should carry. */
  upcoming: PlannedSlot[];
  segments: {
    id: string;
    label: string;
    pending: number;
    messages: number;
    /** The sending time its last message goes in; null when that is not within the horizon. */
    finishesAt: Date | null;
  }[];
  /** The sending time the last message goes in, or null. */
  finishesAt: Date | null;
  outcome: "finishes" | "nothing_waiting" | "calendar_ends" | "beyond_horizon" | "no_sending_times";
};

/**
 * Walk the calendar sending time by sending time and say what each one will
 * carry, and when every segment — and the list — runs out.
 *
 * The dispatcher's own rules, replayed: each sending time's limit, every
 * segment's share, the gaps that fit while it is open, the daily caps, a
 * contact cap that shortens a message rather than skipping it, and the same
 * least-recently-served rotation. What it cannot see — per-parameter quotas,
 * a throttled mailbox, a scheduler that stalls — only ever makes the real
 * campaign later, so this is the earliest it can finish, and says so.
 */
export function forecastSlots(input: {
  rules: CampaignRules;
  from: Date;
  perMessage: number;
  segments: ForecastSegment[] | null;
  /** Contacts waiting. Ignored with segments, which carry their own. */
  pending: number;
  segmentMessagesPerSlot: number;
  messagesToday: number;
  recipientsToday: number;
  /** Messages already sent in the sending time open at `from`. */
  messagesThisSlot: number;
  horizonDays?: number;
  upcomingCount?: number;
}): SlotForecast {
  const { rules, from } = input;
  const perMessage = Math.max(1, input.perMessage);
  const perSegment = Math.max(1, input.segmentMessagesPerSlot);
  const horizonDays = input.horizonDays ?? 366;
  const upcomingCount = input.upcomingCount ?? 8;

  type Bucket = {
    id: string;
    label: string;
    pending: number;
    left: number;
    messages: number;
    finishesAt: Date | null;
    sentThisSlot: number;
  };
  const buckets: Bucket[] = (
    input.segments ?? [{ id: "", label: "", pending: input.pending, sentThisSlot: 0 }]
  ).map((segment) => ({
    id: segment.id,
    label: segment.label,
    pending: Math.max(0, segment.pending),
    left: Math.max(0, segment.pending),
    messages: 0,
    finishesAt: null,
    sentThisSlot: segment.sentThisSlot ?? 0,
  }));
  const lastServed = new Map<string, number>(
    (input.segments ?? []).map((segment) => [
      segment.id,
      segment.lastServedAt ?? Number.NEGATIVE_INFINITY,
    ]),
  );

  const result = (outcome: SlotForecast["outcome"], upcoming: PlannedSlot[]): SlotForecast => {
    const finishes = buckets.map((bucket) => bucket.finishesAt);
    const done = buckets.every((bucket) => bucket.left === 0);
    const last = finishes.reduce<Date | null>(
      (latest, at) => (at && (!latest || at > latest) ? at : latest),
      null,
    );
    return {
      upcoming,
      segments: input.segments
        ? buckets.map(({ id, label, pending, messages, finishesAt }) => ({
            id,
            label,
            pending,
            messages,
            finishesAt,
          }))
        : [],
      finishesAt: done ? last : null,
      outcome,
    };
  };

  const upcoming: PlannedSlot[] = [];
  if (!isSlotMode(rules)) return result("no_sending_times", upcoming);
  if (buckets.every((bucket) => bucket.left === 0)) return result("nothing_waiting", upcoming);

  const startsAt = rules.startsAt ? Date.parse(rules.startsAt) : null;
  const endsAt = rules.endsAt ? Date.parse(rules.endsAt) : null;
  const dayKey = (date: Date) => {
    const parts = zonedParts(date, rules.timezone);
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const fromDay = dayKey(from);
  let currentDay: string | null = null;
  let dayMessages = 0;
  let dayContacts = 0;

  for (const slot of slotOccurrences(rules, from, horizonDays)) {
    if (slot.closesAt.getTime() <= from.getTime()) continue;
    if (startsAt != null && slot.closesAt.getTime() <= startsAt) continue;
    if (endsAt != null && slot.at.getTime() > endsAt) return result("calendar_ends", upcoming);

    const key = dayKey(slot.at);
    if (key !== currentDay) {
      currentDay = key;
      dayMessages = key === fromDay ? input.messagesToday : 0;
      dayContacts = key === fromDay ? input.recipientsToday : 0;
    }
    const opensAt = Math.max(slot.at.getTime(), from.getTime(), startsAt ?? 0);
    const isCurrent = slot.at.getTime() <= from.getTime();
    let capacity =
      messagesPerSlot({
        rules,
        segments: input.segments ? input.segments.length : null,
        segmentMessagesPerSlot: perSegment,
        openSeconds: (slot.closesAt.getTime() - opensAt) / 1000,
      }) ?? Number.POSITIVE_INFINITY;
    if (isCurrent) capacity -= input.messagesThisSlot;

    const planned: PlannedSlot = {
      at: slot.at,
      clock: slot.clock,
      messages: 0,
      contacts: 0,
      segments: [],
    };
    // One message from a bucket, within today's caps. False when nothing more can go.
    const send = (bucket: Bucket, sequence: number): boolean => {
      if (capacity <= 0 || bucket.left <= 0) return false;
      if (rules.maxMessagesPerDay != null && dayMessages >= rules.maxMessagesPerDay) return false;
      const contactRoom =
        rules.maxRecipientsPerDay == null
          ? Number.POSITIVE_INFINITY
          : rules.maxRecipientsPerDay - dayContacts;
      const contacts = Math.min(perMessage, bucket.left, contactRoom);
      if (contacts <= 0) return false;
      bucket.left -= contacts;
      bucket.messages += 1;
      capacity -= 1;
      dayMessages += 1;
      dayContacts += contacts;
      planned.messages += 1;
      planned.contacts += contacts;
      if (input.segments) {
        planned.segments.push(bucket.label);
        lastServed.set(bucket.id, slot.at.getTime() + sequence);
      }
      if (bucket.left === 0) bucket.finishesAt = slot.at;
      return true;
    };

    if (input.segments) {
      const turns = segmentTurns({
        segments: buckets
          .filter((bucket) => bucket.left > 0)
          .map((bucket, position) => ({
            id: bucket.id,
            label: bucket.label,
            matchValues: [],
            position,
            enabled: true,
          })),
        perSlot: perSegment,
        sentThisSlot: new Map(isCurrent ? buckets.map((b) => [b.id, b.sentThisSlot]) : []),
        lastServedAt: lastServed,
      });
      let sequence = 0;
      for (const turn of turns) {
        const bucket = buckets.find((candidate) => candidate.id === turn.segment.id)!;
        for (let n = 0; n < turn.remaining; n++) if (!send(bucket, sequence++)) break;
      }
    } else {
      const bucket = buckets[0];
      const unlimited =
        !Number.isFinite(capacity) &&
        rules.maxMessagesPerDay == null &&
        rules.maxRecipientsPerDay == null;
      if (unlimited) {
        // Nothing limits this sending time: the rest of the list goes in it.
        const messages = Math.ceil(bucket.left / perMessage);
        planned.messages += messages;
        planned.contacts += bucket.left;
        bucket.messages += messages;
        bucket.left = 0;
        bucket.finishesAt = slot.at;
      } else {
        let sequence = 0;
        while (send(bucket, sequence)) sequence++;
      }
    }

    if (planned.messages > 0 && upcoming.length < upcomingCount) upcoming.push(planned);
    if (buckets.every((bucket) => bucket.left === 0)) return result("finishes", upcoming);
  }
  return result("beyond_horizon", upcoming);
}
