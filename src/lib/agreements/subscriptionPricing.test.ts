import { describe, expect, it } from "vitest";
import { tierPriceCents } from "@/lib/pricing/aurixa-catalog";
import { catalogTier, SUBSCRIPTION_TIER_SLUGS } from "./subscriptionTemplates";
import {
  addDays,
  anniversary,
  commitmentDiscountCents,
  formatAud,
  formatCount,
  formatLongDate,
  gstContainedCents,
  isValidAbn,
  isValidAcn,
  ordinal,
  parseIsoDate,
  priceBase,
  readIdentifier,
  serviceDates,
  standardBaseCents,
} from "./subscriptionPricing.pure";

describe("money", () => {
  it("prints amounts the way the templates do", () => {
    expect(formatAud(0)).toBe("$0.00");
    expect(formatAud(4900)).toBe("$49.00");
    expect(formatAud(12750)).toBe("$127.50");
    expect(formatAud(229415)).toBe("$2,294.15");
    expect(formatAud(275298000)).toBe("$2,752,980.00");
    expect(formatAud(-1500)).toBe("−$15.00");
    expect(() => formatAud(1.5)).toThrow(/non_integer/);
  });

  it("groups counts without depending on the runtime's locale", () => {
    expect(formatCount(1)).toBe("1");
    expect(formatCount(7000)).toBe("7,000");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("finds the GST contained in an inclusive price rather than adding it", () => {
    expect(gstContainedCents(99900)).toBe(9082);
    expect(gstContainedCents(1100)).toBe(100);
  });
});

describe("the base price (clauses 5.1, 5.2, 5.4)", () => {
  it("takes the standard base from the catalogue, with and without AML", () => {
    expect(standardBaseCents("launch", true)).toBe(99_900);
    expect(standardBaseCents("growth", true)).toBe(139_900);
    expect(standardBaseCents("scale", true)).toBe(269_900);
    expect(standardBaseCents("launch", false)).toBe(84_900);
    expect(standardBaseCents("growth", false)).toBe(124_900);
    expect(standardBaseCents("scale", false)).toBe(254_900);
  });

  it("gives 15% off the selected base only, rounded to the cent", () => {
    expect(commitmentDiscountCents(99_900)).toBe(14_985);
    const committed = {
      launch: [84_915, 72_165],
      growth: [118_915, 106_165],
      scale: [229_415, 216_665],
    } as const;
    for (const [tier, [withAml, withoutAml]] of Object.entries(committed)) {
      const t = tier as keyof typeof committed;
      expect(priceBase(t, true, "committed_monthly").netMonthlyCents).toBe(withAml);
      expect(priceBase(t, false, "committed_monthly").netMonthlyCents).toBe(withoutAml);
    }
  });

  it("charges the standard base on a flexible term, with nothing fixed", () => {
    const flexible = priceBase("growth", true, "flexible");
    expect(flexible).toEqual({
      standardMonthlyCents: 139_900,
      discountMonthlyCents: 0,
      netMonthlyCents: 139_900,
      annualPrepaymentCents: null,
      committedTotalCents: 0,
    });
  });

  it("prepays twelve discounted months on the annual option, and fixes the same total monthly", () => {
    const annual = priceBase("scale", true, "committed_annual");
    const monthly = priceBase("scale", true, "committed_monthly");
    expect(annual.annualPrepaymentCents).toBe(229_415 * 12);
    expect(monthly.annualPrepaymentCents).toBeNull();
    // "neither payment option increases the 15% base discount"
    expect(annual.committedTotalCents).toBe(monthly.committedTotalCents);
  });

  // The pricing page's annual plan IS a 12-month commitment paid up front, so
  // it must charge exactly what an agreement's annual prepayment states — the
  // owner's decision of 25 September 2026. This is the check that the price
  // list and the agreement cannot drift apart again.
  it("prices the catalogue's annual plan as the agreement's annual prepayment, on every base", () => {
    for (const tier of SUBSCRIPTION_TIER_SLUGS) {
      for (const withAml of [true, false]) {
        const agreement = priceBase(tier, withAml, "committed_annual").annualPrepaymentCents;
        const storefront = tierPriceCents(catalogTier(tier), { period: "annual", withAml });
        expect(storefront, `${tier}, ${withAml ? "with" : "without"} AML`).toBe(agreement);
      }
    }
  });
});

describe("service dates (clause 5.3)", () => {
  const d = (s: string) => {
    const parsed = parseIsoDate(s);
    if (!parsed) throw new Error(`bad date ${s}`);
    return parsed;
  };

  it("parses only real calendar dates", () => {
    expect(parseIsoDate("2026-02-29")).toBeNull();
    expect(parseIsoDate("2028-02-29")).toEqual({ y: 2028, m: 2, d: 29 });
    expect(parseIsoDate("2026-13-01")).toBeNull();
    expect(parseIsoDate("31/01/2026")).toBeNull();
  });

  it("uses the last day of a shorter month and restores the anchor when it returns", () => {
    const jan31 = d("2027-01-31");
    expect(anniversary(jan31, 1, 31)).toEqual(d("2027-02-28"));
    expect(anniversary(jan31, 2, 31)).toEqual(d("2027-03-31"));
    expect(anniversary(jan31, 3, 31)).toEqual(d("2027-04-30"));
    expect(anniversary(d("2027-12-15"), 1, 15)).toEqual(d("2028-01-15"));
  });

  it("ends a commitment immediately before the 12-month anniversary", () => {
    const dates = serviceDates(d("2026-10-31"), "committed_monthly");
    expect(dates.nextRenewal).toEqual(d("2026-11-30"));
    expect(dates.firstCycleEnd).toEqual(d("2026-11-29"));
    expect(dates.commitmentAnniversary).toEqual(d("2027-10-31"));
    expect(dates.commitmentLastDay).toEqual(d("2027-10-30"));
  });

  it("carries a leap day across the year", () => {
    const dates = serviceDates(d("2028-02-29"), "committed_annual");
    expect(dates.commitmentAnniversary).toEqual(d("2029-02-28"));
    expect(dates.commitmentLastDay).toEqual(d("2029-02-27"));
  });

  it("has no commitment end on a flexible term", () => {
    const dates = serviceDates(d("2026-10-01"), "flexible");
    expect(dates.commitmentAnniversary).toBeNull();
    expect(dates.commitmentLastDay).toBeNull();
    expect(dates.firstCycleEnd).toEqual(d("2026-10-31"));
  });

  it("prints dates and ordinals as the Order reads them", () => {
    expect(formatLongDate(d("2026-10-01"))).toBe("1 October 2026");
    expect(addDays(d("2026-12-31"), 1)).toEqual(d("2027-01-01"));
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "31st",
    ]);
  });
});

describe("legal identifiers", () => {
  it("checks an ABN the way the ABR does", () => {
    expect(isValidAbn("49695868243")).toBe(true); // Aurixa's own, printed on every template
    expect(isValidAbn("51824753556")).toBe(true); // the ATO's example
    expect(isValidAbn("51824753557")).toBe(false);
    expect(isValidAbn("5182475355")).toBe(false);
  });

  it("checks an ACN's check digit the way ASIC does", () => {
    expect(isValidAcn("004085616")).toBe(true);
    expect(isValidAcn("000000019")).toBe(true);
    expect(isValidAcn("004085617")).toBe(false);
  });

  it("reads and groups what was typed, keeping anything else as typed", () => {
    expect(readIdentifier("abn 51824753556")).toEqual({
      kind: "abn",
      display: "ABN 51 824 753 556",
      valid: true,
    });
    expect(readIdentifier("ACN: 004-085-616")).toEqual({
      kind: "acn",
      display: "ACN 004 085 616",
      valid: true,
    });
    expect(readIdentifier(" 51 824 753 557 ").valid).toBe(false);
    expect(readIdentifier("ARBN 123 456 789 012")).toEqual({
      kind: "other",
      display: "ARBN 123 456 789 012",
      valid: true,
    });
  });
});
