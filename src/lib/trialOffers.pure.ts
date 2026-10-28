/**
 * Free-trial lengths: the platform default, a typed number of days, or a named
 * trial offer — and the one function that turns an operator's choice into the
 * hours a gate is armed with.
 *
 * A gate stores hours and nothing else about where they came from; that is
 * deliberate (see `trial_offers` in its migration). So every picker in the
 * console — the New Clone wizard, an agreement's provisioning settings — goes
 * through `resolveTrialChoice`, and the preview an operator reads before
 * confirming is what the gate is armed with.
 */
import {
  GATE_DEFAULT_HOURS,
  HOURS_PER_DAY,
  TRIAL_LENGTH_PRESET_DAYS,
  TRIAL_MAX_DAYS,
  TRIAL_MIN_DAYS,
  describeWindowHours,
  normaliseTrialDays,
} from "./clonePaymentGate.pure";

export { TRIAL_LENGTH_PRESET_DAYS, TRIAL_MAX_DAYS, TRIAL_MIN_DAYS };

/** What a picker holds. `days` keeps the operator's raw text so a half-typed
 *  value is shown back rather than replaced. */
export type TrialChoice =
  | { kind: "default" }
  | { kind: "days"; days: string }
  | { kind: "offer"; offerId: string };

export type TrialOfferSummary = {
  id: string;
  code: string;
  label: string;
  trial_days: number;
  active: boolean;
  expires_at: string | null;
};

export type ResolvedTrial =
  | {
      ok: true;
      /** Undefined means "the platform default": the caller passes nothing and
       *  `armGate` reads `prime_config` at the moment it arms. */
      hours: number | undefined;
      days: number | null;
      offerCode: string | null;
      /** "the platform default (14 days)", "30 days", "Partner referral — 30 days". */
      summary: string;
    }
  | { ok: false; error: string };

export const DEFAULT_CHOICE: TrialChoice = { kind: "default" };

/**
 * Resolve a picker's choice.
 *
 * `defaultHours` is only for the summary: the hours themselves stay undefined
 * for the default, so a default changed between this screen and the arming is
 * the default the gate gets — which is what "platform default" means.
 */
export function resolveTrialChoice(
  choice: TrialChoice,
  context: { offers: readonly TrialOfferSummary[]; defaultHours: number | null },
): ResolvedTrial {
  if (choice.kind === "default") {
    const hours = context.defaultHours ?? GATE_DEFAULT_HOURS;
    return {
      ok: true,
      hours: undefined,
      days: hours % HOURS_PER_DAY === 0 ? hours / HOURS_PER_DAY : null,
      offerCode: null,
      summary: `the platform default (${describeWindowHours(hours)})`,
    };
  }
  if (choice.kind === "days") {
    const parsed = normaliseTrialDays(choice.days);
    if (!parsed.ok) return { ok: false, error: describeTrialDaysError(parsed.error) };
    return {
      ok: true,
      hours: parsed.hours,
      days: parsed.days,
      offerCode: null,
      summary: describeWindowHours(parsed.hours),
    };
  }
  const offer = context.offers.find((o) => o.id === choice.offerId);
  if (!offer) return { ok: false, error: "That trial offer no longer exists." };
  if (!offer.active) return { ok: false, error: `${offer.label} has been retired.` };
  const parsed = normaliseTrialDays(offer.trial_days);
  if (!parsed.ok) return { ok: false, error: describeTrialDaysError(parsed.error) };
  return {
    ok: true,
    hours: parsed.hours,
    days: parsed.days,
    offerCode: offer.code,
    summary: `${offer.label} — ${describeWindowHours(parsed.hours)}`,
  };
}

export function describeTrialDaysError(code: string): string {
  switch (code) {
    case "required":
      return "Enter the trial length in days.";
    case "not_a_number":
    case "not_whole_days":
      return "Enter a whole number of days.";
    case "below_minimum":
    case "above_maximum":
      return `A trial is between ${TRIAL_MIN_DAYS} and ${TRIAL_MAX_DAYS} days.`;
    default:
      return "That trial length cannot be used.";
  }
}

/**
 * A stored agreement trial, back into a picker choice. An agreement keeps the
 * days and the code it took them from; the code is provenance, so a choice is
 * rebuilt as that offer only while the offer still gives the same days.
 * Otherwise it is shown as the days it holds, which is what it provisions.
 */
export function choiceFromStored(
  stored: { trial_days: number | null; trial_offer_code: string | null },
  offers: readonly TrialOfferSummary[],
): TrialChoice {
  if (stored.trial_days === null) return DEFAULT_CHOICE;
  if (stored.trial_offer_code) {
    const offer = offers.find((o) => o.code === stored.trial_offer_code);
    if (offer && offer.trial_days === stored.trial_days)
      return { kind: "offer", offerId: offer.id };
  }
  return { kind: "days", days: String(stored.trial_days) };
}

// ── Codes ───────────────────────────────────────────────────────────────────

export const OFFER_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,31}$/;

/**
 * An offer code as stored: trimmed and upper-cased, two to 32 characters of
 * letters, digits and hyphens. Spaces become hyphens, because "PARTNER 30"
 * typed on a call is meant as PARTNER-30, not refused.
 */
export function normaliseOfferCode(
  input: string | null | undefined,
): { ok: true; code: string } | { ok: false; error: string } {
  const code = (input ?? "").trim().toUpperCase().replace(/\s+/g, "-");
  if (!code) return { ok: false, error: "required" };
  if (!OFFER_CODE_PATTERN.test(code)) return { ok: false, error: "bad_shape" };
  return { ok: true, code };
}

/**
 * Will the website accept this offer's code right now?
 *
 * Active and not past its campaign end. A retired or expired offer is refused
 * by reason, so the trial page can say "this offer has ended" rather than
 * "unknown code" — and in both cases the visitor still gets the default trial.
 */
export function websiteOfferStatus(
  offer: Pick<TrialOfferSummary, "active" | "expires_at"> | null,
  now: Date = new Date(),
): "accepted" | "unknown" | "retired" | "expired" {
  if (!offer) return "unknown";
  if (!offer.active) return "retired";
  if (offer.expires_at) {
    const ends = Date.parse(offer.expires_at);
    if (Number.isFinite(ends) && ends <= now.getTime()) return "expired";
  }
  return "accepted";
}

/** The offers a picker lists: the active ones, by label. */
export function pickableOffers(offers: readonly TrialOfferSummary[]): TrialOfferSummary[] {
  return offers
    .filter((o) => o.active)
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label));
}
