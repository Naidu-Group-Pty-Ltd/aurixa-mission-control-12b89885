/**
 * The three approved Subscription Agreement templates, as data.
 *
 * Each tier has its own Word template — Launch, Growth and Scale — authored
 * outside this repository and committed byte-for-byte under
 * `public/agreements/subscription/`. They are not generated here and must not
 * be: the wording is the approved legal text, and the only thing Mission
 * Control does to one is complete its Order fields (see `docxFill.pure.ts`).
 *
 * What this module pins, and why each pin exists:
 *
 *  - **The file's SHA-256.** The Worker fetches the template from its own
 *    public origin at send time. A digest mismatch — a stale deploy, a CDN
 *    serving something else, an edited file committed without review — stops
 *    the send rather than issuing an offer on text nobody approved.
 *
 *  - **Schedule A3, transcribed.** The template prints its own optional
 *    catalogue with reference prices and "Included" markers per tier. The
 *    offer composer prices additional lines from THIS table, so the price on
 *    the Order always equals the price in the same document's Schedule A3. A
 *    test re-reads the table out of each committed `.docx` and fails on any
 *    difference, and a second test compares it with the live commercial
 *    catalogue (`aurixa-catalog.ts`) with the known disagreements named.
 *
 *  - **Schedule A5 and the token allowance**, for the same reason: the
 *    agreement states them, so the tests hold them to the catalogue.
 */
import { TIERS, TOPUP_PACKS } from "@/lib/pricing/aurixa-catalog";

export type SubscriptionTierSlug = "launch" | "growth" | "scale";

export const SUBSCRIPTION_TIER_SLUGS: readonly SubscriptionTierSlug[] = [
  "launch",
  "growth",
  "scale",
];

export type SubscriptionTemplate = {
  tier: SubscriptionTierSlug;
  /** Display name, as the template's title prints it. */
  tierName: string;
  /** Stable identifier recorded on every issued offer. */
  id: string;
  /** The version the template's own title states. */
  version: string;
  /** Path under the Worker's public origin. */
  path: string;
  /** SHA-256 of the committed file, lowercase hex. */
  sha256: string;
  /** Included Subscription Tokens per monthly Billing Cycle, as the template prints them. */
  includedTokensPerCycle: number;
};

/**
 * The committed templates. Replacing a file means replacing its digest here in
 * the same change — and re-running the tests, which re-read every control and
 * the A3/A5 tables out of the new file.
 */
export const SUBSCRIPTION_TEMPLATES: Readonly<Record<SubscriptionTierSlug, SubscriptionTemplate>> =
  {
    launch: {
      tier: "launch",
      tierName: "Launch",
      id: "aurixa-subscription-launch-v8",
      version: "Version 8",
      path: "/agreements/subscription/aurixa-launch-subscription-agreement.docx",
      sha256: "f2fcd6258a523c580383e7ed70a15ee0892a8a70f26f8f7809edf633cd264cd6",
      includedTokensPerCycle: 7_000,
    },
    growth: {
      tier: "growth",
      tierName: "Growth",
      id: "aurixa-subscription-growth-v8",
      version: "Version 8",
      path: "/agreements/subscription/aurixa-growth-subscription-agreement.docx",
      sha256: "cd14a5e13d18be3cdb838c33f5636a590450caff73f10957d39d6b6c05df0147",
      includedTokensPerCycle: 35_000,
    },
    scale: {
      tier: "scale",
      tierName: "Scale",
      id: "aurixa-subscription-scale-v8",
      version: "Version 8",
      path: "/agreements/subscription/aurixa-scale-subscription-agreement.docx",
      sha256: "d8c6d20d0ca29019f499682da5ee996db1d81e15ae66b106aeb9bf8ea673dd95",
      includedTokensPerCycle: 75_000,
    },
  };

export function isSubscriptionTier(value: string): value is SubscriptionTierSlug {
  return (SUBSCRIPTION_TIER_SLUGS as readonly string[]).includes(value);
}

/**
 * The DocuSign anchors a subscription offer carries. Distinct from the SLA's
 * (`\sig_client_1\` …) so a tab set built for one document can never land on
 * the other. Painted in the acceptance panel's own colour at 6pt, as the SLA
 * does, so the signer sees the DocuSign tab and not the token.
 */
export const SUBSCRIPTION_ANCHORS = {
  clientSignature: "\\sub_sig_client\\",
  clientDate: "\\sub_date_client\\",
} as const;

export const SUBSCRIPTION_ANCHOR_LIST: readonly string[] = Object.values(SUBSCRIPTION_ANCHORS);

/* ─────────────────────────── Schedule A3 ─────────────────────────── */

/**
 * How a catalogue row may be bought under a tier agreement.
 *
 *  - `module` — an optional product, or included at some tiers.
 *  - `seat` — Additional User Seat: bought through the offer's seat count,
 *    never as a free-standing line, so one seat cannot be charged twice.
 *  - `independent_contract` — Builder / Developer Portal: "requires its own
 *    purchaser and paid agreement; the $699 reference is not an order under
 *    this tier".
 *  - `not_for_sale` — Lenders.
 */
export type A3ItemKind = "module" | "seat" | "independent_contract" | "not_for_sale";

export type A3Item = {
  /** Stable key used by offers. */
  key: string;
  /** Exactly as the template's A3 table prints it. */
  label: string;
  kind: A3ItemKind;
  /** AUD/month incl. GST as A3 prints it; null for "Not for sale". */
  referenceMonthlyCents: number | null;
  /** The commercial catalogue module this row is, or null where there is none. */
  catalogSlug: string | null;
  /**
   * The template's readiness rule requires an identified scope before this
   * line can be issued (A3: "Advanced Forms Builder must have an identified
   * incremental, ready scope. Model Hub and API Usage must state
   * customer-facing boundaries.").
   */
  requiresScope?: boolean;
  /** Enables email, SMS, voice or recording use, so A4's communications row must be completed. */
  enablesCommunications?: boolean;
  /** Brings the X09 Marketplace & Commercial Product Supplement into scope. */
  invokesX09?: boolean;
};

/** In the template's own order. */
export const A3_ITEMS: readonly A3Item[] = [
  {
    key: "market-news-feed",
    label: "Market News Feed",
    kind: "module",
    referenceMonthlyCents: 7900,
    catalogSlug: "market-updates",
  },
  {
    key: "commercial-industrial",
    label: "Commercial / Industrial",
    kind: "module",
    referenceMonthlyCents: 24900,
    catalogSlug: "commercial-industrial",
    invokesX09: true,
  },
  {
    key: "property-marketplace",
    label: "Property Marketplace",
    kind: "module",
    referenceMonthlyCents: 24900,
    catalogSlug: "opportunity-marketplace",
    invokesX09: true,
  },
  {
    key: "intelligence-hub",
    label: "Aurixa Intelligence Hub",
    kind: "module",
    referenceMonthlyCents: 12900,
    catalogSlug: "intelligence-hub",
  },
  {
    key: "report-comparisons",
    label: "Generated Report Comparisons",
    kind: "module",
    referenceMonthlyCents: 12900,
    catalogSlug: "report-comparisons",
  },
  {
    key: "cashflow-comparisons",
    label: "Cash Flow Comparisons",
    kind: "module",
    referenceMonthlyCents: 12900,
    catalogSlug: "cashflow-comparisons",
  },
  {
    key: "email-copilot",
    label: "Email Copilot",
    kind: "module",
    referenceMonthlyCents: 14900,
    catalogSlug: "email-copilot",
    enablesCommunications: true,
  },
  {
    key: "call-logs",
    label: "Call Logs",
    kind: "module",
    referenceMonthlyCents: 24900,
    catalogSlug: "call-logs",
    enablesCommunications: true,
  },
  {
    key: "portfolio-analysis",
    label: "Portfolio Analysis",
    kind: "module",
    referenceMonthlyCents: 17900,
    catalogSlug: "portfolio-analysis",
  },
  {
    key: "send-portfolio",
    label: "Send Portfolio To Client",
    kind: "module",
    referenceMonthlyCents: 9900,
    catalogSlug: "send-portfolio",
  },
  {
    key: "agreements",
    label: "Agreements",
    kind: "module",
    referenceMonthlyCents: 12900,
    catalogSlug: "agreements",
  },
  {
    key: "deal-pipeline",
    label: "Deal Pipeline",
    kind: "module",
    referenceMonthlyCents: 14900,
    catalogSlug: "deal-pipeline",
  },
  {
    // The template distinguishes this from the standard Client Forms every
    // tier includes ("Standard Client Forms do not automatically include the
    // separate Advanced Forms Builder"). The commercial catalogue has no
    // module for it, so a signature does not switch it on — confirmed by the
    // owner on 25 September 2026.
    key: "advanced-forms-builder",
    label: "Advanced Forms Builder",
    kind: "module",
    referenceMonthlyCents: 4900,
    catalogSlug: null,
    requiresScope: true,
  },
  {
    key: "borrowing-capacity",
    label: "Borrowing Capacity",
    kind: "module",
    referenceMonthlyCents: 29500,
    catalogSlug: "borrowing-capacity",
  },
  {
    key: "ai",
    label: "AI",
    kind: "module",
    referenceMonthlyCents: 12900,
    catalogSlug: "client-ai",
  },
  {
    key: "marketing",
    label: "Marketing",
    kind: "module",
    referenceMonthlyCents: 24900,
    catalogSlug: "marketing",
    enablesCommunications: true,
  },
  {
    key: "model-hub",
    label: "Model Hub",
    kind: "module",
    referenceMonthlyCents: 24900,
    catalogSlug: "model-hub",
    requiresScope: true,
  },
  {
    key: "finance-portal",
    label: "Finance Portal",
    kind: "module",
    referenceMonthlyCents: 34900,
    catalogSlug: "finance-portal",
  },
  {
    key: "integrations",
    label: "Integrations",
    kind: "module",
    referenceMonthlyCents: 19900,
    catalogSlug: "integrations",
  },
  {
    key: "api-usage",
    label: "API Usage",
    kind: "module",
    referenceMonthlyCents: 19900,
    catalogSlug: "api-usage",
    requiresScope: true,
  },
  {
    key: "solicitor-portal",
    label: "Solicitor Portal",
    kind: "module",
    referenceMonthlyCents: 29900,
    catalogSlug: "solicitor-portal",
  },
  {
    key: "aurixa-agent",
    label: "Aurixa Agent",
    kind: "module",
    referenceMonthlyCents: 49500,
    catalogSlug: "aurixa-agent",
  },
  {
    key: "builder-developer-portal",
    label: "Builder / Developer Portal",
    kind: "independent_contract",
    referenceMonthlyCents: 69900,
    catalogSlug: "builder-developer-portal",
  },
  {
    key: "additional-user-seat",
    label: "Additional User Seat",
    kind: "seat",
    referenceMonthlyCents: 4900,
    catalogSlug: null,
  },
  {
    key: "lenders",
    label: "Lenders",
    kind: "not_for_sale",
    referenceMonthlyCents: null,
    catalogSlug: "lenders",
  },
];

/** Items each template prints as "Included" in its A3 table. */
export const A3_INCLUDED: Readonly<Record<SubscriptionTierSlug, readonly string[]>> = {
  launch: [],
  growth: ["market-news-feed", "report-comparisons", "cashflow-comparisons", "deal-pipeline"],
  scale: [
    "market-news-feed",
    "commercial-industrial",
    "property-marketplace",
    "report-comparisons",
    "cashflow-comparisons",
    "portfolio-analysis",
    "send-portfolio",
    "agreements",
    "deal-pipeline",
    "borrowing-capacity",
    "ai",
    "marketing",
    "model-hub",
    "finance-portal",
    "api-usage",
  ],
};

export const EXTRA_SEAT_KEY = "additional-user-seat";

export function a3Item(key: string): A3Item | undefined {
  return A3_ITEMS.find((i) => i.key === key);
}

export function isIncludedInTier(tier: SubscriptionTierSlug, key: string): boolean {
  return A3_INCLUDED[tier].includes(key);
}

/**
 * The items an operator may add as an additional line for a tier: optional
 * modules the tier does not already include. Seats go through the seat count;
 * independent-contract and not-for-sale rows never appear.
 */
export function purchasableItems(tier: SubscriptionTierSlug): readonly A3Item[] {
  return A3_ITEMS.filter((i) => i.kind === "module" && !isIncludedInTier(tier, i.key));
}

/**
 * The A3 table as the template prints it — the text of the "This tier" and
 * "Monthly fee" columns — so a test can compare it with the committed file.
 */
export function expectedA3Rows(
  tier: SubscriptionTierSlug,
): Array<{ label: string; thisTier: string; fee: string }> {
  return A3_ITEMS.map((item) => {
    const included = isIncludedInTier(tier, item.key);
    let thisTier: string;
    if (item.kind === "independent_contract") thisTier = "Independent contract only";
    else if (item.kind === "seat") thisTier = "Approved additional seats only";
    else if (item.kind === "not_for_sale") thisTier = "Excluded / coming soon";
    else thisTier = included ? "Included" : "Optional; not in base";
    const fee =
      item.referenceMonthlyCents === null
        ? "Not for sale"
        : included
          ? "Included; no separate access fee"
          : `$${(item.referenceMonthlyCents / 100).toFixed(2)}`;
    return { label: item.label, thisTier, fee };
  });
}

/* ─────────────────────────── Schedule A5 ─────────────────────────── */

/** The credit packs each template's A5 table lists, in order. */
export const A5_PACKS: ReadonlyArray<{ credits: number; totalCents: number }> = [
  { credits: 250, totalCents: 2090 },
  { credits: 500, totalCents: 3850 },
  { credits: 1_000, totalCents: 7150 },
  { credits: 2_500, totalCents: 16390 },
  { credits: 5_000, totalCents: 30690 },
  { credits: 7_500, totalCents: 43890 },
  { credits: 10_000, totalCents: 54890 },
  { credits: 15_000, totalCents: 71390 },
];

/* ─────────────────────────── catalogue joins ─────────────────────────── */

/** The commercial tier behind a template. */
export function catalogTier(tier: SubscriptionTierSlug) {
  const found = TIERS.find((t) => t.slug === tier);
  if (!found) throw new Error(`catalogue_tier_missing: ${tier}`);
  return found;
}

/** The catalogue's credit packs, in the A5 shape — for the drift test. */
export function catalogA5Packs(): Array<{ credits: number; totalCents: number }> {
  return TOPUP_PACKS.map((p) => ({ credits: p.credits, totalCents: p.priceInclGstCents }));
}
