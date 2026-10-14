/**
 * When a running campaign should stop to protect the domain it sends from.
 *
 * The campaign rules elsewhere are about one contact — never twice, never an
 * address that bounced. These are about the campaign as a whole, because the
 * failures that get a domain blocklisted are: a list whose addresses bounce by
 * the dozen, sent on regardless, reads to a receiver exactly like a spammer's
 * scraped list; and a mailbox whose mail has started landing in spam sends
 * every further message into spam, deepening the hole.
 *
 * Both answers are taken from records — the recipient ledger joined to the
 * do-not-send register, and the warmup pool's measured placement — never from
 * a counter, and both are decided here so the thresholds are tested rather
 * than reasoned about.
 */
import { healthScore, type PlacementCounts } from "@/lib/email/warmupPlan.pure";

/** Below this bounce rate nothing is said. */
export const BOUNCE_WARN_PERCENT = 2;
/**
 * The rate is taken over at least this many sends, so three bounces among the
 * first ten contacts do not stop a campaign — but forty bounces among the
 * first forty do, because the denominator never makes them look small.
 */
export const BOUNCE_MIN_SAMPLE = 50;
/** Warmup placement is trusted for the guard only over at least this many settled messages. */
export const GUARD_MIN_SAMPLE = 10;
/** Warmup placement below this pauses a guarded campaign: the "poor" band. */
export const GUARD_PLACEMENT_PERCENT = 75;

export type BounceVerdict = {
  action: "ok" | "warn" | "pause";
  /** Percent, one decimal place; null before anything was sent. */
  rate: number | null;
  sent: number;
  bounced: number;
  /** Words for the heartbeat or the pause reason; null when there is nothing to say. */
  detail: string | null;
};

const percent = (part: number, whole: number) => Math.round((part / whole) * 1000) / 10;

/**
 * The campaign's hard-bounce rate since it was last started, and what to do.
 * `pausePercent` null is the protection switched off: it still warns.
 */
export function bounceVerdict(input: {
  sent: number;
  bounced: number;
  pausePercent: number | null;
}): BounceVerdict {
  const { sent, bounced, pausePercent } = input;
  if (sent <= 0 || bounced <= 0) {
    return { action: "ok", rate: sent > 0 ? 0 : null, sent, bounced, detail: null };
  }
  const rate = percent(bounced, Math.max(sent, BOUNCE_MIN_SAMPLE));
  const shown = percent(bounced, sent);
  if (pausePercent != null && rate >= pausePercent) {
    return {
      action: "pause",
      rate,
      sent,
      bounced,
      detail: `${bounced} of the ${sent} contacts sent since it was started have hard-bounced (${shown}%), at or past its ${pausePercent}% limit — paused before the rest of the list does the same to the domain's reputation. Clean the list, then resume (resuming starts a fresh count), or raise the limit on the Rules tab`,
    };
  }
  if (rate >= BOUNCE_WARN_PERCENT) {
    return {
      action: "warn",
      rate,
      sent,
      bounced,
      detail: `hard-bounce rate ${shown}% since it was started (${bounced} of ${sent})${pausePercent != null ? ` — it pauses at ${pausePercent}%` : " — automatic pausing is off"}`,
    };
  }
  return { action: "ok", rate, sent, bounced, detail: null };
}

export type GuardVerdict = { pause: boolean; score: number | null; detail: string | null };

/**
 * Whether a campaign should stop because its sending mailbox's own warmup
 * mail is landing in spam. Only on evidence: a mailbox outside the pool, or
 * with too little settled warmup mail to judge, is never paused by this.
 */
export function warmupGuardVerdict(input: {
  address: string;
  counts: PlacementCounts | null;
}): GuardVerdict {
  if (!input.counts) return { pause: false, score: null, detail: null };
  const settled =
    input.counts.inbox + input.counts.junk + input.counts.other + input.counts.missing;
  if (settled < GUARD_MIN_SAMPLE) return { pause: false, score: null, detail: null };
  const score = healthScore(input.counts);
  if (score === null || score >= GUARD_PLACEMENT_PERCENT)
    return { pause: false, score, detail: null };
  return {
    pause: true,
    score,
    detail: `${input.address}'s own warmup mail is landing in spam (${score}% inbox placement over the last 7 days, ${settled} messages) — campaign mail from it will too, so the campaign is paused to protect the domain. Resume once warmup placement is back above ${GUARD_PLACEMENT_PERCENT}%, or switch the warmup guard off on the Rules tab`,
  };
}

/**
 * What a campaign sending from a mailbox outside the warmup pool is told.
 * Nothing then measures where its mail lands, so the warmup guard has nothing
 * to act on: the first sign of trouble is the replies stopping.
 */
export function unwatchedSenderAdvice(input: {
  address: string;
  contactsPerDay: number | null;
}): string {
  const volume =
    input.contactsPerDay != null && input.contactsPerDay > 0
      ? ` At full pace this campaign addresses ${input.contactsPerDay.toLocaleString("en-AU")} contacts a day from it.`
      : "";
  return `${input.address} is not in the warmup pool, so nothing measures whether its mail reaches inboxes and the warmup guard cannot pause this campaign if it starts landing in spam — enrol it on the Warmup page.${volume}`;
}
