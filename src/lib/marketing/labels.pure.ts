/**
 * The words the Marketing pages use for the engine's vocabulary — a source
 * that did not answer, a period-comparison row, a signal's figure.
 *
 * The same wording as the prime's `src/lib/marketing/channelLabels.ts`, so the
 * two Marketing modules describe one state one way. Every figure is written by
 * the engine's `marketingFormat.pure.ts`, which also writes the facts a digest
 * is given, so a number on the page and the same number quoted in a brief are
 * the same string.
 */
import {
  formatCount,
  formatMinutes,
  formatMoney,
  formatPercent,
  type ChannelSignal,
  type Measured,
  type PeriodComparisonRow,
  type SourceErrorReason,
  type SourceState,
} from "./marketingEngine";

/** Why a source did not answer, in a reader's words. Each sends them somewhere different. */
export const SOURCE_ERROR_WORDS: Record<SourceErrorReason, { title: string; remedy: string }> = {
  credentials_rejected: {
    title: "The saved credentials were refused",
    remedy: "Reconnect it on the Connections tab — a token may have expired or been revoked.",
  },
  permission_denied: {
    title: "The credentials cannot read this account",
    remedy: "They are valid, but the account they belong to has not been given access to this one.",
  },
  quota_exhausted: {
    title: "The API quota is used up",
    remedy:
      "The vendor allows a fixed number of requests a day. It resets on the vendor’s own clock.",
  },
  rate_limited: {
    title: "The vendor asked us to slow down",
    remedy: "Wait a minute and refresh.",
  },
  not_found: {
    title: "The account id names nothing these credentials can see",
    remedy: "Check the account, advertiser or channel id on the Connections tab.",
  },
  request_rejected: {
    title: "The vendor rejected the request this page built",
    remedy: "This is a defect on our side, not the connection's settings.",
  },
  vendor_unavailable: {
    title: "The vendor could not be reached",
    remedy: "Their service did not answer. Try again shortly.",
  },
  unreadable_answer: {
    title: "The vendor answered with something this page cannot read",
    remedy: "This is a defect on our side, not the connection's settings.",
  },
  unknown: {
    title: "The read failed",
    remedy: "Try again shortly.",
  },
};

export function sourceUnavailable(state: SourceState | undefined | null): boolean {
  return !!state && state.state !== "ok" && state.state !== "not_requested";
}

type Unit = "money" | "percent" | "count" | "minutes" | "signed";

const COMPARISON_ROWS: Record<string, { label: string; unit: Unit }> = {
  spend: { label: "Spend", unit: "money" },
  impressions: { label: "Impressions", unit: "count" },
  clicks: { label: "Clicks", unit: "count" },
  views: { label: "Views", unit: "count" },
  results: { label: "Results", unit: "count" },
  ctr: { label: "Click-through rate", unit: "percent" },
  cpm: { label: "Cost per 1,000 impressions", unit: "money" },
  cpv: { label: "Cost per view", unit: "money" },
  costPerResult: { label: "Cost per result", unit: "money" },
  watchTimeMinutes: { label: "Watch time", unit: "minutes" },
  netFollows: { label: "Net followers", unit: "signed" },
};

export function comparisonLabel(key: string, followersWord = "followers"): string {
  if (key === "netFollows") return `Net ${followersWord}`;
  return COMPARISON_ROWS[key]?.label ?? key;
}

export function signedCount(value: Measured): string {
  if (value === null) return "—";
  const text = formatCount(Math.abs(value));
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
}

export function formatComparisonValue(
  key: string,
  value: Measured,
  currency: string | null,
): string {
  switch (COMPARISON_ROWS[key]?.unit) {
    case "money":
      return formatMoney(value, currency);
    case "percent":
      return formatPercent(value);
    case "minutes":
      return formatMinutes(value);
    case "signed":
      return signedCount(value);
    default:
      return formatCount(value);
  }
}

/** Whether a change is good news. Spend is neither: more spend is a decision, not a result. */
export function changeTone(
  row: Pick<PeriodComparisonRow, "change" | "goodDirection">,
): "good" | "bad" | "neutral" {
  if (row.change === null || row.change === 0 || row.goodDirection === "neutral") return "neutral";
  const up = row.change > 0;
  return (row.goodDirection === "up") === up ? "good" : "bad";
}

export function formatSignalFigure(
  signal: ChannelSignal,
  value: number,
  currency: string | null,
): string {
  switch (signal.unit) {
    case "currency":
      return formatMoney(value, currency);
    case "percent":
      return formatPercent(value);
    case "ratio":
      return `${value.toFixed(2)}×`;
    case "days":
      return `${formatCount(value)} day${value === 1 ? "" : "s"}`;
    default:
      return formatCount(value);
  }
}

/** The vendor's status word, made readable without translating it into a judgement. */
export function statusWord(status: string | null): string | null {
  if (!status) return null;
  const words = status
    .replace(/^(CAMPAIGN|ADGROUP|AD)_STATUS_/, "")
    .replace(/_/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Cents as Australian dollars, for CRM deal values (which `crm_deals` keeps in cents). */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return formatMoney(cents / 100, "AUD");
}
