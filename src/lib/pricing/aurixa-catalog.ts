// The Aurixa price list, as decided — one source of truth for all three repos.
//
// Transcribed from the final-review pricing model
// (Aurixa_Systems_Pricing_Model_2026_Final_Review, 10 September 2026), which
// supersedes Aurixa_Pricing_Tier_1.xlsx in full. Every figure in that model is
// headed "incl. GST", and that is how they are stored here: these are the
// amounts a customer actually pays. GST is derived FROM them (÷11), never
// added to them. Getting that backwards overcharges every customer by 10%, so
// the direction is asserted in the tests.
//
// A tier is still modelled as `base + the AML/CTF module`, and the model's own
// numbers still say that is what it is: 999−849, 1399−1249 and 2699−2549 all
// equal exactly 150. Storing one number per tier and deriving the other means
// the two can never drift apart.
//
// ── What that 150 is made of, and why $400 is not a price ────────────────────
//
// The model prices AML as a $400 reference component sitting beside a $250
// Core Platform discount that exists ONLY while AML is selected. Taking AML
// adds the first and earns the second, so the subscription moves by $150; so
// does dropping it later, because both end together. Those two figures are
// exported (AML_REFERENCE_COMPONENT_CENTS, AML_CORE_BUNDLE_DISCOUNT_CENTS)
// because the approved customer wording states them — but the only amount ever
// CHARGED is the net one, and the model is explicit about why: "Do not charge
// an unadjusted $400 on top of the no-AML price", and "a $400 component is not
// approval to sell a standalone AML-only product". So the module row carries
// AML_NET_UPLIFT_CENTS, derived from the other two rather than typed, and a
// $400 price can never reach Stripe, a checkout or an invoice.
//
// The model's $599 / $999 / $2,299 figures are deliberately NOT here. They are
// the discounted core ALLOCATION inside the with-AML bundle, and the previous
// sheet's habit of reading them as without-AML selling prices is the specific
// mislabelling this revision was written to end.
//
// Which of the two prices is the HEADLINE is a commercial decision, and the
// model makes it: every tier is titled with its with-AML figure. So
// `tierHeadlineCents` is what Stripe charges and what both surfaces lead with;
// `tierBaseCents` is the documented alternative, shown alongside rather than
// hidden. See TIER_INCLUDES_AML.

/** Australian GST is 10%, so a tax-inclusive total is 11/10 of its base. */
export const GST_DIVISOR = 11;

/** Annual plans bill 12 months at a 10% discount. */
export const ANNUAL_DISCOUNT = 0.1;

/**
 * The AML/CTF reference component, as the pricing model states it.
 *
 * A reference value, never a selling price: it is the gross figure the bundle
 * is described with, and it is always paired with the discount below. Exported
 * so the approved customer wording ("a $400 AML reference component and a $250
 * conditional Core Platform bundle discount") can be rendered from the same
 * numbers the arithmetic uses, instead of being retyped into prose that then
 * drifts.
 */
export const AML_REFERENCE_COMPONENT_CENTS = 40000;

/**
 * The Core Platform discount that exists only while AML/CTF is selected.
 *
 * Conditional, and conditional in both directions — removing AML ends the
 * discount as well as the component, which is why the subscription moves by
 * the net figure and not by $400.
 */
export const AML_CORE_BUNDLE_DISCOUNT_CENTS = 25000;

/**
 * What taking or dropping AML/CTF actually costs: $150 a month, every tier.
 *
 * Derived rather than typed, because this is the one AML number that is ever
 * charged — the tier gap, the add-on price and the opt-out saving are all
 * this, and a literal here could disagree with the two constants above.
 */
export const AML_NET_UPLIFT_CENTS =
  AML_REFERENCE_COMPONENT_CENTS - AML_CORE_BUNDLE_DISCOUNT_CENTS;

/** The GST contained within a tax-inclusive amount. */
export function gstComponentCents(inclGstCents: number): number {
  return Math.round(inclGstCents / GST_DIVISOR);
}

/** The ex-GST (net) amount of a tax-inclusive total. */
export function exGstCents(inclGstCents: number): number {
  return inclGstCents - gstComponentCents(inclGstCents);
}

/**
 * The annual charge for a monthly tax-inclusive price: twelve months less 10%.
 * Still tax-inclusive — the discount is applied to the total the customer pays.
 */
export function annualCents(monthlyInclGstCents: number): number {
  return Math.round(monthlyInclGstCents * 12 * (1 - ANNUAL_DISCOUNT));
}

/** What an annual plan works out to per month, for "$X/mo billed annually". */
export function annualPerMonthCents(monthlyInclGstCents: number): number {
  return Math.round(annualCents(monthlyInclGstCents) / 12);
}

export type BillingPeriod = "monthly" | "annual";

export type Tier = {
  slug: string;
  name: string;
  /** Row this replaces in the existing catalog, or null to keep its own. */
  replacesSlug: string | null;
  seatMin: number;
  seatMax: number;
  /**
   * Monthly, tax-inclusive, WITHOUT the AML/CTF module. The headline price
   * customers see is derived from this — see tierHeadlineCents.
   */
  monthlyInclGstCents: number;
  /**
   * Report credits included with the tier, every month.
   *
   * Issued as real credits on the same 30-day clock as everything else — an
   * allowance is not a separate currency, it is a grant into the same balance
   * a top-up pack credits. Which also means it is spent by the same
   * soonest-to-expire rule, so an allowance is always consumed before a
   * top-up bought later.
   */
  monthlyCredits: number;
  blurb: string;
};

/**
 * The three tiers from the sheet.
 *
 * `replacesSlug` records the decision to reuse existing catalog rows rather
 * than mint new ones: the old Professional row becomes Growth and the old
 * Growth row becomes Scale, so Stripe products and subscription history stay
 * attached to a row instead of being orphaned. Enterprise is untouched and
 * stays on sale.
 */
export const TIERS: readonly Tier[] = [
  {
    slug: "launch",
    name: "Launch",
    replacesSlug: "launch",
    seatMin: 1,
    seatMax: 4,
    monthlyInclGstCents: 84900,
    monthlyCredits: 7_000,
    blurb: "For a solo adviser or a small team getting started.",
  },
  {
    slug: "growth",
    name: "Growth",
    replacesSlug: "professional",
    seatMin: 5,
    seatMax: 15,
    monthlyInclGstCents: 124900,
    monthlyCredits: 35_000,
    blurb: "For a growing practice running comparisons and a deal pipeline.",
  },
  {
    slug: "scale",
    name: "Scale",
    replacesSlug: "growth",
    seatMin: 16,
    seatMax: 30,
    monthlyInclGstCents: 254900,
    monthlyCredits: 75_000,
    blurb: "The full platform, with finance, marketing and agreements.",
  },
];

export type ModuleCategory =
  | "Main Dashboard"
  | "Reports & Analysis"
  | "Client & CRM"
  | "Operations"
  | "AML / CTF Compliance"
  | "Administration"
  | "AI Assistant";

export type PricedModule = {
  slug: string;
  name: string;
  category: ModuleCategory;
  /** Monthly, tax-inclusive. */
  monthlyInclGstCents: number;
  /** Tier slugs that include this module at no extra cost. */
  includedIn: readonly string[];
  /** Not yet purchasable — listed so the roadmap is visible. */
  comingSoon?: boolean;
  /**
   * Priced, built and available — but sold by a person, not by a checkout.
   *
   * The pricing model marks the Builder / Developer Portal "Direct sale" on
   * every tier and says so twice: it "is a direct-sale reference, not an
   * automatic tier add-on", and its quote builder excludes direct-sale items
   * from the recurring subtotal. Separate from `comingSoon` because the two
   * answer different questions — one has no agreed price, this one has a price
   * and no agreed buyer (decision D05: who is billed, and for what scope).
   * Both are unsellable through self-serve, which is what PURCHASABLE_MODULES
   * derives.
   */
  directSale?: boolean;
  note?: string;
};

/**
 * The add-on modules, with the sheet's tax-inclusive prices.
 *
 * `includedIn` is derived from the sheet's own tier matrix, and the two agree
 * everywhere: each "Activated under X pricing" note names the module that the
 * tier introducing that capability unlocks. Deal Pipeline and Market Updates
 * arrive with Growth; Agreements, Marketing, Model Hub, Finance Portal, API
 * Usage, Commercial/Industrial and Opportunity Marketplace arrive with Scale.
 */
export const MODULES: readonly PricedModule[] = [
  // Main Dashboard
  {
    // Market News Feed. Bundled into SCALE only — the signed-off commercial
    // rules for the tiered-entitlement rollout place it beside Commercial /
    // Industrial: included at Scale, and an independently purchasable add-on
    // for Launch and Growth. (The original sheet transcription had it
    // arriving with Growth; the entitlement rollout superseded that, and the
    // prime app, this catalogue and the pricing site moved together.)
    slug: "market-updates",
    name: "Market Updates",
    category: "Main Dashboard",
    monthlyInclGstCents: 7900,
    includedIn: ["scale"],
  },
  {
    slug: "commercial-industrial",
    name: "Commercial / Industrial",
    category: "Main Dashboard",
    monthlyInclGstCents: 24900,
    includedIn: ["scale"],
  },
  {
    slug: "opportunity-marketplace",
    name: "Opportunity Marketplace",
    category: "Main Dashboard",
    monthlyInclGstCents: 24900,
    includedIn: ["scale"],
  },

  // Reports & Analysis
  {
    slug: "intelligence-hub",
    name: "Aurixa Intelligence Hub",
    category: "Reports & Analysis",
    monthlyInclGstCents: 12900,
    includedIn: [],
  },
  {
    slug: "report-comparisons",
    name: "Generated Reports — Comparisons",
    category: "Reports & Analysis",
    monthlyInclGstCents: 12900,
    includedIn: ["growth", "scale"],
  },
  {
    slug: "cashflow-comparisons",
    name: "Cash Flow Analysis — Comparisons",
    category: "Reports & Analysis",
    monthlyInclGstCents: 12900,
    includedIn: ["growth", "scale"],
  },

  // Client & CRM
  {
    slug: "email-copilot",
    name: "Email Copilot",
    category: "Client & CRM",
    monthlyInclGstCents: 14900,
    includedIn: [],
    note: "Unlocks client Emails, which stay off on every tier without it.",
  },
  {
    slug: "call-logs",
    name: "Call Logs",
    category: "Client & CRM",
    monthlyInclGstCents: 24900,
    includedIn: [],
    note: "Plus a custom build price if requested.",
  },
  {
    slug: "portfolio-analysis",
    name: "Portfolio Analysis",
    category: "Client & CRM",
    monthlyInclGstCents: 17900,
    includedIn: ["scale"],
  },
  {
    slug: "send-portfolio",
    name: "Send Portfolio To Client",
    category: "Client & CRM",
    monthlyInclGstCents: 9900,
    includedIn: ["scale"],
  },
  {
    slug: "client-forms",
    name: "Client Forms",
    category: "Client & CRM",
    monthlyInclGstCents: 4900,
    includedIn: ["launch", "growth", "scale"],
    // Wording matches the catalog row. "In the sheet" is how this was
    // originally phrased, and it reaches a customer invoice via the Stripe
    // product description — internal provenance is not something to bill
    // someone alongside.
    note: "Enabled on every tier; the price applies to standalone purchase.",
  },
  {
    slug: "borrowing-capacity",
    name: "Borrowing Capacity",
    category: "Client & CRM",
    monthlyInclGstCents: 29500,
    includedIn: ["scale"],
  },
  {
    slug: "lenders",
    name: "Lenders",
    category: "Client & CRM",
    // The pricing model retires this figure to price history and records no
    // active selling price. Kept only so the roadmap row has a shape; nothing
    // may quote it, which `comingSoon` is what enforces.
    monthlyInclGstCents: 9900,
    includedIn: [],
    comingSoon: true,
    note: "Not for sale. The listed figure is historical and is not a current price.",
  },
  {
    slug: "client-ai",
    name: "Client AI",
    category: "Client & CRM",
    monthlyInclGstCents: 12900,
    includedIn: ["scale"],
  },

  // Operations
  {
    slug: "agreements",
    name: "Agreements",
    category: "Operations",
    monthlyInclGstCents: 12900,
    includedIn: ["scale"],
  },
  {
    slug: "marketing",
    name: "Marketing",
    category: "Operations",
    monthlyInclGstCents: 24900,
    includedIn: ["scale"],
  },
  {
    slug: "deal-pipeline",
    name: "Deal Pipeline",
    category: "Operations",
    monthlyInclGstCents: 14900,
    includedIn: ["growth", "scale"],
  },

  // AML / CTF Compliance — the $150 that separates the headline tier prices.
  //
  // Derived, not typed: this is the $400 reference component net of the $250
  // conditional Core Platform discount, and it is the only AML figure that is
  // ever charged — as the gap between a tier's two prices, as the add-on price
  // for a tier bought without it, and as the saving for dropping it.
  {
    slug: "aml-ctf",
    name: "AML / CTF Compliance",
    category: "AML / CTF Compliance",
    monthlyInclGstCents: AML_NET_UPLIFT_CENTS,
    includedIn: [],
    note: "Includes a $400 AML reference component less a $250 conditional Core Platform bundle discount.",
  },

  // Administration
  {
    slug: "model-hub",
    name: "Model Hub",
    category: "Administration",
    monthlyInclGstCents: 24900,
    includedIn: ["scale"],
  },
  {
    slug: "finance-portal",
    name: "Finance Portal",
    category: "Administration",
    monthlyInclGstCents: 34900,
    includedIn: ["scale"],
    note: "Also unlocks client Send To Finance and Finance Messages.",
  },
  {
    slug: "integrations",
    name: "Integrations",
    category: "Administration",
    monthlyInclGstCents: 19900,
    includedIn: [],
    note: "Subject to the client integrating their own APIs.",
  },
  {
    slug: "api-usage",
    name: "API Usage",
    category: "Administration",
    monthlyInclGstCents: 19900,
    includedIn: ["scale"],
  },
  {
    slug: "solicitor-portal",
    name: "Solicitor Portal",
    category: "Administration",
    monthlyInclGstCents: 29900,
    includedIn: [],
    note: "Partner hand-off portal. A portal fee buys that portal's own scope and never grants AML/CTF.",
  },
  {
    // Direct sale, on every tier — see `directSale`. Priced here so the price
    // list is complete and so nothing has to invent a figure at quote time;
    // excluded from self-serve because D05 has not settled who is billed.
    slug: "builder-developer-portal",
    name: "Builder / Developer Portal",
    category: "Administration",
    monthlyInclGstCents: 69900,
    includedIn: [],
    directSale: true,
    note: "Sold separately, not as a tier add-on. A portal fee buys that portal's own scope and never grants AML/CTF.",
  },

  // AI Assistant
  {
    slug: "aurixa-agent",
    name: "Aurixa Agent",
    category: "AI Assistant",
    monthlyInclGstCents: 49500,
    includedIn: [],
  },
];

export type TopupPack = {
  slug: string;
  name: string;
  /** Position in the ladder, 1 = smallest. Also the sheet's own "Stage". */
  stage: number;
  credits: number;
  /** Tax-inclusive, in cents — the sheet's "Recommended price incl. GST". */
  priceInclGstCents: number;
  /** The sheet's "Positioning" column, shown on the card. */
  positioning: string;
  /** The sheet marks exactly one pack as the popular choice. */
  popular?: boolean;
  /** …and exactly one as the best value. */
  bestValue?: boolean;
};

/**
 * The top-up ladder, transcribed from the sheet's "Top-Up Pricing — GST
 * Inclusive" table.
 *
 * Only credits and price are stored. Price-per-credit and discount-from-the-
 * smallest-pack are the sheet's other two columns, but they are consequences
 * of these two numbers, not independent facts — storing them would let a
 * rounded copy drift away from what is actually charged. They are derived by
 * packPerCreditCents/packDiscountFraction and pinned against the sheet's
 * published figures in the tests.
 *
 * The ladder must stay sorted by credits: the discount column, the storefront
 * ordering and the "smallest pack" baseline all read position 0 as the floor.
 */
export const TOPUP_PACKS: readonly TopupPack[] = [
  {
    slug: "topup-250",
    name: "250 Credit Pack",
    stage: 1,
    credits: 250,
    priceInclGstCents: 2090,
    positioning: "Emergency top-up",
  },
  {
    slug: "topup-500",
    name: "500 Credit Pack",
    stage: 2,
    credits: 500,
    priceInclGstCents: 3850,
    positioning: "Small reporting boost",
  },
  {
    slug: "topup-1000",
    name: "1,000 Credit Pack",
    stage: 3,
    credits: 1000,
    priceInclGstCents: 7150,
    positioning: "Light additional usage",
  },
  {
    slug: "topup-2500",
    name: "2,500 Credit Pack",
    stage: 4,
    credits: 2500,
    priceInclGstCents: 16390,
    positioning: "Regular reporting top-up",
  },
  {
    slug: "topup-5000",
    name: "5,000 Credit Pack",
    stage: 5,
    credits: 5000,
    priceInclGstCents: 30690,
    positioning: "Most popular",
    popular: true,
  },
  {
    slug: "topup-7500",
    name: "7,500 Credit Pack",
    stage: 6,
    credits: 7500,
    priceInclGstCents: 43890,
    positioning: "Team reporting capacity",
  },
  {
    slug: "topup-10000",
    name: "10,000 Credit Pack",
    stage: 7,
    credits: 10000,
    priceInclGstCents: 54890,
    positioning: "High-volume monthly overflow",
  },
  {
    slug: "topup-15000",
    name: "15,000 Credit Pack",
    stage: 8,
    credits: 15000,
    priceInclGstCents: 71390,
    positioning: "Best top-up value",
    bestValue: true,
  },
];

/** Packs the ladder replaces. Retired on cutover, never deleted — they have sales against them. */
export const RETIRED_PACK_SLUGS: readonly string[] = [
  "credits-50",
  "credits-100",
  "credits-250",
  "credits-500",
];

export const packBySlug = (slug: string): TopupPack | undefined =>
  TOPUP_PACKS.find((p) => p.slug === slug);

/**
 * What one credit costs in this pack, in cents — a fraction of a cent, so
 * deliberately NOT rounded here. The sheet quotes it to two decimals ("8.36
 * cents") and so should any display, but the discount column is computed from
 * the unrounded figure and rounding first moves it (5,000 credits reads 26.6%
 * from 6.138c and 26.6% from 6.14c only by luck).
 */
export function packPerCreditCents(pack: TopupPack): number {
  return pack.priceInclGstCents / pack.credits;
}

/**
 * How much cheaper a credit is here than in the smallest pack, as a fraction.
 * Zero for the smallest pack itself, which is the baseline.
 */
export function packDiscountFraction(pack: TopupPack): number {
  const baseline = packPerCreditCents(TOPUP_PACKS[0]);
  if (!baseline) return 0;
  return 1 - packPerCreditCents(pack) / baseline;
}

/**
 * The module whose price is the gap between a tier's two headline figures.
 *
 * That gap is AML_NET_UPLIFT_CENTS on every tier, which is what makes the
 * choice independent of the tier: a Growth customer who declines AML keeps
 * every other thing Growth includes, and pays $150 less for it.
 */
export const AML_MODULE_SLUG = "aml-ctf";

/**
 * Whether a tier is SOLD with the AML/CTF module included.
 *
 * The pricing model titles every tier with its with-AML figure — $999 / $1,399
 * / $2,699 — so that is the headline product and the amount Stripe charges.
 * The without-AML figure ($849 / $1,249 / $2,549) is the documented
 * alternative, shown alongside it rather than hidden.
 *
 * Kept as one constant because it is a commercial decision, not an
 * implementation detail: flipping it moves the headline, the Stripe price and
 * both surfaces together, so display can never drift from what is charged.
 */
export const TIER_INCLUDES_AML = true;

/** The headline price for a tier — what the sheet titles it with, and what Stripe charges. */
export function tierHeadlineCents(tier: Tier, period: BillingPeriod = "monthly"): number {
  return tierPriceCents(tier, { period, withAml: TIER_INCLUDES_AML });
}

/** The same tier without the AML/CTF module — the sheet's stated alternative. */
export function tierBaseCents(tier: Tier, period: BillingPeriod = "monthly"): number {
  return tierPriceCents(tier, { period, withAml: !TIER_INCLUDES_AML });
}

export const moduleBySlug = (slug: string): PricedModule | undefined =>
  MODULES.find((m) => m.slug === slug);

/**
 * The modules that can actually be sold through a checkout.
 *
 * Two flags take a row out, for two different reasons. `comingSoon` rows are
 * on the pricing page so the roadmap is visible but have no price anyone has
 * agreed to pay. `directSale` rows have a price and no agreed buyer — the
 * model prices the Builder / Developer Portal and in the same breath excludes
 * it from the recurring subtotal. Neither may reach Stripe or a self-serve
 * purchase.
 *
 * Deriving the sellable set here rather than filtering at each call site means
 * a module going on sale is one flag, not a hunt through the sync, the
 * checkout and the storefront. That was already the stated intent, and the
 * call sites had drifted to testing `comingSoon` by hand — which is precisely
 * how adding a second reason to withhold a module would have shipped one that
 * anybody could buy. They go through `isModulePurchasable` now.
 */
export const PURCHASABLE_MODULES: readonly PricedModule[] = MODULES.filter(
  (m) => !m.comingSoon && !m.directSale,
);

/** Whether a module may be sold through a checkout. */
export const isModulePurchasable = (slug: string): boolean =>
  PURCHASABLE_MODULES.some((m) => m.slug === slug);

/**
 * Why a module cannot be bought here, or null if it can.
 *
 * A surface that hides an unsellable module tells a customer it does not
 * exist; the model wants it listed WITH its price and a reason. Callers that
 * only need the yes/no use `isModulePurchasable`.
 */
export function moduleSaleBlock(slug: string): "coming_soon" | "direct_sale" | null {
  const mod = moduleBySlug(slug);
  if (!mod) return null;
  if (mod.comingSoon) return "coming_soon";
  if (mod.directSale) return "direct_sale";
  return null;
}

export const tierBySlug = (slug: string): Tier | undefined => TIERS.find((t) => t.slug === slug);

/** Tax-inclusive price of a tier, for a billing period, with or without AML/CTF. */
export function tierPriceCents(
  tier: Tier,
  opts: { period?: BillingPeriod; withAml?: boolean } = {},
): number {
  const aml = moduleBySlug(AML_MODULE_SLUG);
  const monthly = tier.monthlyInclGstCents + (opts.withAml && aml ? aml.monthlyInclGstCents : 0);
  return opts.period === "annual" ? annualCents(monthly) : monthly;
}

/** Whether a tier includes a module without paying for it separately. */
export function tierIncludesModule(tierSlug: string, moduleSlug: string): boolean {
  return moduleBySlug(moduleSlug)?.includedIn.includes(tierSlug) ?? false;
}

/**
 * What a tier's included credits work out to per credit, in cents.
 *
 * Not a price — nothing sells credits at this rate — but the number that says
 * whether the allowance is worth having. Measured against the tier's headline,
 * because that is what is actually paid.
 */
export function tierCreditRateCents(tier: Tier): number {
  return tier.monthlyCredits > 0 ? tierHeadlineCents(tier) / tier.monthlyCredits : 0;
}

/** Modules a tier does NOT include, i.e. what it can still be upgraded with. */
export function upgradesFor(tierSlug: string): readonly PricedModule[] {
  return MODULES.filter((m) => !m.includedIn.includes(tierSlug));
}
