/**
 * The arithmetic a Subscription Agreement's Order states, and the dates it
 * prints.
 *
 * Every rule here is the agreement's own, quoted where it is applied:
 *
 *  - 5.1 — a 12-month commitment gives 15% off the complete with-AML or
 *    without-AML base.
 *  - 5.4 — the discount applies to the selected base ONLY: seats, modules,
 *    credit packs and support stay at their accepted prices. "The monthly
 *    difference between the two discounted AML base options is $127.50; it is
 *    $150 under flexible standard pricing." — which the tests reproduce from
 *    the catalogue, so a price change that breaks the clause cannot ship.
 *  - 5.2 — monthly payment means 12 monthly advance instalments; an annual
 *    prepayment covers the discounted base and "neither payment option
 *    increases the 15% base discount".
 *  - 5.3 — the commitment "ends immediately before the corresponding
 *    anniversary 12 calendar months later. Billing anniversaries use the
 *    original anchor day, with the last day used in a month lacking that day
 *    and the original anchor restored when available."
 *  - 7.3 — GST is contained within a stated GST-inclusive price, never added.
 *
 * Money is integer cents throughout; nothing here touches a float that is
 * then displayed.
 */
import {
  AML_NET_UPLIFT_CENTS,
  COMMITMENT_DISCOUNT_BPS,
  commitmentDiscountCents,
  GST_DIVISOR,
  tierPriceCents,
} from "@/lib/pricing/aurixa-catalog";
import { catalogTier, type SubscriptionTierSlug } from "./subscriptionTemplates";

export type SubscriptionTerm = "flexible" | "committed_monthly" | "committed_annual";

export const COMMITMENT_MONTHS = 12;

/**
 * Clause 5.1's 15%, and the dollar discount it grants on a base, rounded to the
 * cent. Both are the price list's own: the annual plan is a 12-month
 * commitment paid up front, so the catalogue prices it by this same rule, and
 * one definition means the pricing page and an issued agreement cannot quote
 * different discounts.
 */
export { COMMITMENT_DISCOUNT_BPS, commitmentDiscountCents };

export function isCommitted(term: SubscriptionTerm): boolean {
  return term !== "flexible";
}

/* ───────────────────────────── money ───────────────────────────── */

/** "$1,234.56", as the templates print amounts. Negative amounts get a real minus sign. */
export function formatAud(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`formatAud_non_integer: ${cents}`);
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * "7,000" — a count grouped in thousands the way the templates print them.
 * Not `toLocaleString`: the output must not depend on the runtime's locale
 * data, because it becomes part of a document whose bytes are hashed.
 */
export function formatCount(n: number): string {
  if (!Number.isInteger(n)) throw new Error(`formatCount_non_integer: ${n}`);
  const sign = n < 0 ? "−" : "";
  return (
    sign +
    Math.abs(n)
      .toString()
      .replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  );
}

/** The GST contained in a GST-inclusive amount (clause 7.3). */
export function gstContainedCents(inclGstCents: number): number {
  return Math.round(inclGstCents / GST_DIVISOR);
}

/** The standard monthly base: the catalogue's tier price, with or without AML. */
export function standardBaseCents(tier: SubscriptionTierSlug, withAml: boolean): number {
  return tierPriceCents(catalogTier(tier), { withAml });
}

export type BasePricing = {
  standardMonthlyCents: number;
  discountMonthlyCents: number;
  netMonthlyCents: number;
  /** The annual prepayment where one is selected; null otherwise. */
  annualPrepaymentCents: number | null;
  /** The base charges fixed by a commitment; zero on a flexible term. */
  committedTotalCents: number;
};

export function priceBase(
  tier: SubscriptionTierSlug,
  withAml: boolean,
  term: SubscriptionTerm,
): BasePricing {
  const standard = standardBaseCents(tier, withAml);
  const discount = isCommitted(term) ? commitmentDiscountCents(standard) : 0;
  const net = standard - discount;
  return {
    standardMonthlyCents: standard,
    discountMonthlyCents: discount,
    netMonthlyCents: net,
    annualPrepaymentCents: term === "committed_annual" ? net * COMMITMENT_MONTHS : null,
    committedTotalCents: isCommitted(term) ? net * COMMITMENT_MONTHS : 0,
  };
}

/** Clause 5.4's two stated differences, derived rather than typed. */
export function amlDifferenceCents(tier: SubscriptionTierSlug, term: SubscriptionTerm): number {
  return priceBase(tier, true, term).netMonthlyCents - priceBase(tier, false, term).netMonthlyCents;
}

/** What the uplift is under flexible pricing — the catalogue's AML figure. */
export const FLEXIBLE_AML_DIFFERENCE_CENTS = AML_NET_UPLIFT_CENTS;

/* ───────────────────────────── dates ───────────────────────────── */

export type CalendarDate = { y: number; m: number; d: number };

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function parseIsoDate(value: string): CalendarDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const date = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (date.m < 1 || date.m > 12 || date.d < 1 || date.d > daysInMonth(date.y, date.m)) return null;
  return date;
}

export function isoDate(date: CalendarDate): string {
  return `${String(date.y).padStart(4, "0")}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The billing anniversary `months` after `from`, on `anchorDay` — the last
 * day of the month where the month is shorter, and the anchor itself again
 * wherever it exists (clause 5.3).
 */
export function anniversary(from: CalendarDate, months: number, anchorDay: number): CalendarDate {
  const index = from.y * 12 + (from.m - 1) + months;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return { y, m, d: Math.min(anchorDay, daysInMonth(y, m)) };
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** "1 October 2026". */
export function formatLongDate(date: CalendarDate): string {
  return `${date.d} ${MONTHS[date.m - 1]} ${date.y}`;
}

/** "1st", "2nd", "23rd", "31st". */
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export type ServiceDates = {
  activation: CalendarDate;
  anchorDay: number;
  /** The first monthly renewal and the second token grant. */
  nextRenewal: CalendarDate;
  /** The last day of the first Billing Cycle. */
  firstCycleEnd: CalendarDate;
  /** The 12-month anniversary the commitment ends immediately before; null when flexible. */
  commitmentAnniversary: CalendarDate | null;
  /** The commitment's last day; null when flexible. */
  commitmentLastDay: CalendarDate | null;
};

export function serviceDates(activation: CalendarDate, term: SubscriptionTerm): ServiceDates {
  const anchorDay = activation.d;
  const nextRenewal = anniversary(activation, 1, anchorDay);
  const commitmentAnniversary = isCommitted(term)
    ? anniversary(activation, COMMITMENT_MONTHS, anchorDay)
    : null;
  return {
    activation,
    anchorDay,
    nextRenewal,
    firstCycleEnd: addDays(nextRenewal, -1),
    commitmentAnniversary,
    commitmentLastDay: commitmentAnniversary ? addDays(commitmentAnniversary, -1) : null,
  };
}

/* ───────────────────────────── identifiers ───────────────────────────── */

const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
const ACN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 1];

/** The ABR's published ABN check: subtract 1 from the first digit, weight, sum mod 89. */
export function isValidAbn(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) return false;
  const values = digits.split("").map(Number);
  values[0] -= 1;
  const sum = values.reduce((acc, v, i) => acc + v * ABN_WEIGHTS[i], 0);
  return sum % 89 === 0;
}

/** ASIC's ACN check digit. */
export function isValidAcn(digits: string): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  const values = digits.split("").map(Number);
  const sum = ACN_WEIGHTS.reduce((acc, w, i) => acc + w * values[i], 0);
  const check = (10 - (sum % 10)) % 10;
  return check === values[8];
}

export type IdentifierReading =
  | { kind: "abn"; display: string; valid: boolean }
  | { kind: "acn"; display: string; valid: boolean }
  | { kind: "other"; display: string; valid: true };

/**
 * A typed identifier, read as the ABR or ASIC would: eleven digits are an ABN,
 * nine an ACN, each grouped the way they are printed and checked against its
 * check digits. Anything else — an ARBN, an overseas registration — is kept
 * exactly as typed.
 */
export function readIdentifier(raw: string): IdentifierReading {
  const typed = raw.trim();
  const withoutLabel = typed.replace(/^(ABN|ACN)\s*:?\s*/i, "");
  const digits = withoutLabel.replace(/[\s-]/g, "");
  if (/^\d{11}$/.test(digits)) {
    return {
      kind: "abn",
      display: `ABN ${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`,
      valid: isValidAbn(digits),
    };
  }
  if (/^\d{9}$/.test(digits)) {
    return {
      kind: "acn",
      display: `ACN ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`,
      valid: isValidAcn(digits),
    };
  }
  return { kind: "other", display: typed, valid: true };
}
