import { describe, expect, it } from "vitest";
import {
  ANNUAL_DISCOUNT,
  AML_CORE_BUNDLE_DISCOUNT_CENTS,
  AML_MODULE_SLUG,
  AML_NET_UPLIFT_CENTS,
  AML_REFERENCE_COMPONENT_CENTS,
  MODULES,
  PURCHASABLE_MODULES,
  isModulePurchasable,
  moduleSaleBlock,
  TIERS,
  annualCents,
  annualPerMonthCents,
  COMMITMENT_DISCOUNT_BPS,
  commitmentDiscountCents,
  exGstCents,
  gstComponentCents,
  moduleBySlug,
  tierBySlug,
  tierIncludesModule,
  tierPriceCents,
  tierBaseCents,
  tierHeadlineCents,
  upgradesFor,
} from "./aurixa-catalog";
import { SUB_MODULE_MATRIX, enabledSubModules, tierEnablesSubModule } from "./sub-module-matrix";

const $ = (dollars: number) => Math.round(dollars * 100);

describe("GST is derived from the price, never added to it", () => {
  it("splits a tax-inclusive total into base + GST", () => {
    // $999.00 incl = $908.18 + $90.82. Adding 10% instead would bill
    // $1,098.90, which is the mistake this direction-of-travel prevents.
    expect(gstComponentCents($(999))).toBe($(90.82));
    expect(exGstCents($(999))).toBe($(908.18));
  });

  it("reproduces every ex-GST and GST figure the pricing model publishes", () => {
    // The model's TIER PRICING sheet states all six splits to the cent. If
    // this table and that sheet ever disagree, one of them is wrong about
    // what a customer is charged — so it is checked rather than assumed.
    const published = [
      { incl: $(999), ex: $(908.18), gst: $(90.82) },
      { incl: $(849), ex: $(771.82), gst: $(77.18) },
      { incl: $(1399), ex: $(1271.82), gst: $(127.18) },
      { incl: $(1249), ex: $(1135.45), gst: $(113.55) },
      { incl: $(2699), ex: $(2453.64), gst: $(245.36) },
      { incl: $(2549), ex: $(2317.27), gst: $(231.73) },
    ];
    for (const row of published) {
      expect(exGstCents(row.incl)).toBe(row.ex);
      expect(gstComponentCents(row.incl)).toBe(row.gst);
    }
  });

  it("always reconciles: base + GST is exactly the price charged", () => {
    for (const cents of [$(49), $(79), $(849), $(999), $(1249), $(1399), $(2549), $(2699), 1, 0]) {
      expect(exGstCents(cents) + gstComponentCents(cents)).toBe(cents);
    }
  });

  it("never exceeds one eleventh of the total", () => {
    for (const cents of [$(849), $(1249), $(2549), $(495)]) {
      expect(gstComponentCents(cents)).toBeLessThanOrEqual(Math.ceil(cents / 11));
    }
  });
});

describe("headline tier prices match the signed-off pricing model", () => {
  // The model publishes two figures per tier. Both must fall out of the code.
  const expected = [
    { slug: "launch", without: $(849), with: $(999), seats: [1, 4] },
    { slug: "growth", without: $(1249), with: $(1399), seats: [5, 15] },
    { slug: "scale", without: $(2549), with: $(2699), seats: [16, 30] },
  ];

  for (const e of expected) {
    it(`${e.slug}: $${e.without / 100} without AML/CTF, $${e.with / 100} with`, () => {
      const tier = tierBySlug(e.slug)!;
      expect(tierPriceCents(tier)).toBe(e.without);
      expect(tierPriceCents(tier, { withAml: true })).toBe(e.with);
      expect([tier.seatMin, tier.seatMax]).toEqual(e.seats);
    });
  }

  it("the with/without gap is the AML/CTF module price on every tier", () => {
    const aml = moduleBySlug(AML_MODULE_SLUG)!;
    expect(aml.monthlyInclGstCents).toBe($(150));
    for (const tier of TIERS) {
      expect(tierPriceCents(tier, { withAml: true }) - tierPriceCents(tier)).toBe(
        aml.monthlyInclGstCents,
      );
    }
  });

  it("seat bands are contiguous and non-overlapping", () => {
    const sorted = [...TIERS].sort((a, b) => a.seatMin - b.seatMin);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].seatMin).toBe(sorted[i - 1].seatMax + 1);
    }
  });
});

describe("the annual plan is a 12-month commitment at 15% off the base", () => {
  it("is 15%, held in basis points", () => {
    expect(COMMITMENT_DISCOUNT_BPS).toBe(1500);
    expect(ANNUAL_DISCOUNT).toBe(0.15);
  });

  it("takes the discount off each month, rounded to the cent", () => {
    expect(commitmentDiscountCents($(849))).toBe($(127.35));
    expect(commitmentDiscountCents($(999))).toBe($(149.85));
    // A base that is not a whole number of dollars still rounds per month.
    expect(commitmentDiscountCents(12_345)).toBe(1_852);
  });

  it("lands on exact cents for every tier", () => {
    expect(annualCents($(849))).toBe($(8659.8));
    expect(annualCents($(1249))).toBe($(12739.8));
    expect(annualCents($(2549))).toBe($(25999.8));
  });

  it("is twelve discounted months — the agreement's annual prepayment — for any base", () => {
    // Clause 5.2 states the prepayment as twelve times the discounted monthly
    // base. Discounting the year instead would differ by a cent on a base
    // with odd cents, and the storefront and the agreement must not.
    for (const base of [$(849), $(999), 12_345, 1, 7]) {
      expect(annualCents(base)).toBe((base - commitmentDiscountCents(base)) * 12);
    }
    expect(annualCents(12_345)).toBe(125_916);
  });

  it("is cheaper than paying monthly, by exactly fifteen per cent of the year", () => {
    for (const tier of TIERS) {
      const monthly12 = tier.monthlyInclGstCents * 12;
      const annual = tierPriceCents(tier, { period: "annual" });
      expect(monthly12 - annual).toBe(Math.round(monthly12 * 0.15));
    }
  });

  it("applies to the AML-inclusive price too", () => {
    const launch = tierBySlug("launch")!;
    expect(tierPriceCents(launch, { period: "annual", withAml: true })).toBe(annualCents($(999)));
  });

  it("reports the discounted base as its per-month equivalent", () => {
    expect(annualPerMonthCents($(849))).toBe($(721.65));
    expect(annualPerMonthCents($(999)) * 12).toBe(annualCents($(999)));
  });

  it("stays tax-inclusive, so GST still divides out of the annual total", () => {
    const annual = annualCents($(849));
    expect(exGstCents(annual) + gstComponentCents(annual)).toBe(annual);
  });
});

describe("the AML component, the conditional discount and the net uplift", () => {
  it("is $400 less $250, which is the $150 that is actually charged", () => {
    expect(AML_REFERENCE_COMPONENT_CENTS).toBe($(400));
    expect(AML_CORE_BUNDLE_DISCOUNT_CENTS).toBe($(250));
    expect(AML_NET_UPLIFT_CENTS).toBe($(150));
    expect(AML_REFERENCE_COMPONENT_CENTS - AML_CORE_BUNDLE_DISCOUNT_CENTS).toBe(
      AML_NET_UPLIFT_CENTS,
    );
  });

  it("never lets the $400 reference reach a chargeable price", () => {
    // The model is explicit: "do not charge an unadjusted $400 on top of the
    // no-AML price", and a $400 component is not approval to sell a
    // standalone AML product. The only amount that may be billed is the net
    // one, so nothing in the catalogue may carry the reference figure.
    for (const m of MODULES) {
      expect(m.monthlyInclGstCents).not.toBe(AML_REFERENCE_COMPONENT_CENTS);
    }
    expect(moduleBySlug(AML_MODULE_SLUG)!.monthlyInclGstCents).toBe(AML_NET_UPLIFT_CENTS);
  });

  it("costs the same to add later as it did to take from the start", () => {
    // Opt out, then back in, and the subscription must land exactly where it
    // began — the component and the discount always end and begin together.
    for (const tier of TIERS) {
      const withAml = tierPriceCents(tier, { withAml: true });
      const without = tierPriceCents(tier, { withAml: false });
      expect(withAml - without).toBe(AML_NET_UPLIFT_CENTS);
      expect(without + AML_NET_UPLIFT_CENTS).toBe(withAml);
    }
  });

  it("charges one AML component per subscription, whatever the tier", () => {
    const gaps = TIERS.map(
      (t) => tierPriceCents(t, { withAml: true }) - tierPriceCents(t, { withAml: false }),
    );
    expect(new Set(gaps).size).toBe(1);
  });
});

describe("module catalogue", () => {
  it("carries all 25 priced modules from the pricing model", () => {
    expect(MODULES).toHaveLength(25);
    expect(MODULES.every((m) => m.monthlyInclGstCents > 0)).toBe(true);
  });

  it("has unique slugs", () => {
    expect(new Set(MODULES.map((m) => m.slug)).size).toBe(MODULES.length);
  });

  it("carries every module price the pricing model publishes", () => {
    // The model's MODULE CATALOGUE, in full. Spot-checking four of twenty-five
    // is how the other twenty-one drift: each of these moved in this revision
    // except Advanced Forms Builder, and a partial check would have caught
    // none of them.
    const published: Record<string, number> = {
      "market-updates": $(79),
      "commercial-industrial": $(249),
      "opportunity-marketplace": $(249),
      "intelligence-hub": $(129),
      "report-comparisons": $(129),
      "cashflow-comparisons": $(129),
      "email-copilot": $(149),
      "call-logs": $(249),
      "portfolio-analysis": $(179),
      "send-portfolio": $(99),
      "agreements": $(129),
      "deal-pipeline": $(149),
      "client-forms": $(49),
      "borrowing-capacity": $(295),
      "client-ai": $(129),
      "marketing": $(249),
      "model-hub": $(249),
      "finance-portal": $(349),
      "integrations": $(199),
      "api-usage": $(199),
      "solicitor-portal": $(299),
      "aurixa-agent": $(495),
      "builder-developer-portal": $(699),
      "aml-ctf": $(150),
    };
    for (const [slug, cents] of Object.entries(published)) {
      expect(moduleBySlug(slug), slug).toBeDefined();
      expect(moduleBySlug(slug)!.monthlyInclGstCents, slug).toBe(cents);
    }
    // Every module except Lenders, which the model retires to price history.
    expect(Object.keys(published).length).toBe(MODULES.length - 1);
  });

  it("only ever references tiers that exist", () => {
    const slugs = new Set(TIERS.map((t) => t.slug));
    for (const m of MODULES) {
      for (const t of m.includedIn) expect(slugs.has(t)).toBe(true);
    }
  });

  it("includes with Growth exactly what Growth introduces", () => {
    // Market Updates moved to Scale-only bundling in the tiered-entitlement
    // rollout — Growth reaches it through the add-on, not the tier.
    const added = MODULES.filter(
      (m) => m.includedIn.includes("growth") && !m.includedIn.includes("launch"),
    ).map((m) => m.slug);
    expect(added.sort()).toEqual(
      ["cashflow-comparisons", "deal-pipeline", "report-comparisons"].sort(),
    );
  });

  it("bundles Market Updates into Scale only", () => {
    expect(moduleBySlug("market-updates")!.includedIn).toEqual(["scale"]);
  });

  it("keeps AML/CTF an add-on on every tier — it is what the gap is made of", () => {
    expect(moduleBySlug(AML_MODULE_SLUG)!.includedIn).toEqual([]);
    for (const tier of TIERS) expect(tierIncludesModule(tier.slug, AML_MODULE_SLUG)).toBe(false);
  });

  it("offers fewer upgrades the higher the tier", () => {
    expect(upgradesFor("launch").length).toBeGreaterThan(upgradesFor("growth").length);
    expect(upgradesFor("growth").length).toBeGreaterThan(upgradesFor("scale").length);
  });
});

describe("what may be sold through a checkout", () => {
  it("withholds Lenders and the Builder / Developer Portal, and nothing else", () => {
    const withheld = MODULES.filter((m) => !isModulePurchasable(m.slug)).map((m) => m.slug);
    expect(withheld.sort()).toEqual(["builder-developer-portal", "lenders"]);
    expect(PURCHASABLE_MODULES).toHaveLength(MODULES.length - 2);
  });

  it("says WHICH reason, because the two send an operator elsewhere", () => {
    // No agreed price is a roadmap problem; a price with no agreed buyer is a
    // contract problem. Collapsing them loses the difference.
    expect(moduleSaleBlock("lenders")).toBe("coming_soon");
    expect(moduleSaleBlock("builder-developer-portal")).toBe("direct_sale");
    expect(moduleSaleBlock("finance-portal")).toBeNull();
  });

  it("keeps a withheld module priced and listed rather than hidden", () => {
    // The model lists both with a figure. A surface that drops them tells a
    // customer they do not exist.
    expect(moduleBySlug("builder-developer-portal")!.monthlyInclGstCents).toBe($(699));
    expect(moduleBySlug("lenders")).toBeDefined();
  });

  it("never bundles a withheld module into a tier", () => {
    for (const m of MODULES) {
      if (isModulePurchasable(m.slug)) continue;
      expect(m.includedIn, m.slug).toEqual([]);
    }
  });
});

describe("sub-module entitlement matrix", () => {
  it("covers all 34 sub-modules", () => {
    expect(SUB_MODULE_MATRIX).toHaveLength(34);
    expect(new Set(SUB_MODULE_MATRIX.map((r) => r.key)).size).toBe(34);
  });

  it("never takes away what a lower tier had", () => {
    // A customer upgrading must not silently lose a capability.
    for (const row of SUB_MODULE_MATRIX) {
      if (row.launch) expect(row.growth).toBe(true);
      if (row.growth) expect(row.scale).toBe(true);
    }
  });

  it("matches the sheet at the boundaries", () => {
    expect(tierEnablesSubModule("launch", "generated-reports.comparisons")).toBe(false);
    expect(tierEnablesSubModule("growth", "generated-reports.comparisons")).toBe(true);
    expect(tierEnablesSubModule("growth", "clients.borrowing-capacity")).toBe(false);
    expect(tierEnablesSubModule("scale", "clients.borrowing-capacity")).toBe(true);
  });

  it("leaves Emails and Lenders off on every tier", () => {
    for (const tier of ["launch", "growth", "scale"]) {
      expect(tierEnablesSubModule(tier, "clients.emails")).toBe(false);
      expect(tierEnablesSubModule(tier, "clients.lenders")).toBe(false);
    }
  });

  it("denies unknown keys and unknown tiers rather than defaulting open", () => {
    expect(tierEnablesSubModule("scale", "clients.not-a-thing")).toBe(false);
    expect(tierEnablesSubModule("enterprise", "clients.review")).toBe(false);
  });

  it("grows monotonically across tiers", () => {
    expect(enabledSubModules("launch").length).toBe(20);
    expect(enabledSubModules("growth").length).toBe(23);
    expect(enabledSubModules("scale").length).toBe(32);
  });
});

describe("the headline price is the one the sheet titles each tier with", () => {
  // The sheet names every tier by its with-AML figure, so that is the number
  // customers see and the number Stripe charges. The without-AML figure is the
  // documented alternative, not the headline.
  const headline = [
    { slug: "launch", monthly: $(999), annual: $(10189.8) },
    { slug: "growth", monthly: $(1399), annual: $(14269.8) },
    { slug: "scale", monthly: $(2699), annual: $(27529.8) },
  ];

  for (const h of headline) {
    it(`${h.slug} headlines at $${h.monthly / 100} / month`, () => {
      const tier = tierBySlug(h.slug)!;
      expect(tierHeadlineCents(tier)).toBe(h.monthly);
      expect(tierHeadlineCents(tier, "annual")).toBe(h.annual);
    });
  }

  it("still exposes the without-AML figure the sheet also publishes", () => {
    expect(tierBaseCents(tierBySlug("launch")!)).toBe($(849));
    expect(tierBaseCents(tierBySlug("growth")!)).toBe($(1249));
    expect(tierBaseCents(tierBySlug("scale")!)).toBe($(2549));
  });

  it("keeps headline and base exactly one AML module apart", () => {
    const aml = moduleBySlug(AML_MODULE_SLUG)!.monthlyInclGstCents;
    for (const tier of TIERS) {
      expect(tierHeadlineCents(tier) - tierBaseCents(tier)).toBe(aml);
    }
  });

  it("discounts the headline annual by 15% of twelve months", () => {
    for (const tier of TIERS) {
      const twelve = tierHeadlineCents(tier) * 12;
      expect(tierHeadlineCents(tier, "annual")).toBe(Math.round(twelve * 0.85));
    }
  });

  it("headline GST still divides out cleanly", () => {
    expect(gstComponentCents($(699))).toBe($(63.55));
    expect(gstComponentCents($(1055))).toBe($(95.91));
    expect(gstComponentCents($(2210))).toBe($(200.91));
  });
});
