// What each tier actually includes, taken from the signed-off pricing sheet's
// own per-tier module matrices rather than written by hand.
//
// MIRRORED FROM aurixa-systems `src/lib/pricing/tierFeatures.ts`. Kept in step
// the same way `aurixa-catalog.ts` is — the pricing sheet is one source of
// truth for all three repos, and Mission Control needs the tier matrices to
// decide which technical modules a clone on a given tier should have
// installed. Edit the pricing sheet, then both copies.
//
// Higher tiers list only what they ADD. Repeating forty-odd inherited lines on
// every card buries the difference between the plans, which is the one thing a
// pricing page exists to make obvious — so Growth and Scale say "Everything in
// X, plus" and show only the delta.
//
// Sub-modules are kept as structured data rather than folded into the module
// name, so the card can nest them instead of rendering one unreadable
// parenthetical eighteen items long.
//
// The sheet predates some of what the prime builds. Quantitative Reports,
// Templates and Auto Report Generation (Launch) and the four pages under
// Agreements (Scale) were added on 29 Oct 2026, each where the prime already
// opens it, so placing those modules on a tier states what a workspace on it
// has rather than changing it.

export type FeatureItem = { name: string; subs?: string[] };
export type FeatureGroup = { heading: string; items: FeatureItem[] };

export type TierFeatures = {
  /** Display name of the tier whose features this one builds on. */
  inherits?: string;
  groups: FeatureGroup[];
};

export const TIER_FEATURES: Record<string, TierFeatures> = {
  launch: {
    groups: [
      {
        heading: "Main Dashboard",
        items: [{ name: "Overview" }, { name: "Calendar" }],
      },
      {
        heading: "Reports & Analysis",
        items: [
          { name: "Reports" },
          { name: "Generated Reports", subs: ["Investment"] },
          { name: "Quantitative Reports" },
          { name: "Cash Flow Analysis", subs: ["10 Year Cash Flow"] },
          { name: "Report Requests" },
        ],
      },
      {
        heading: "Client & CRM",
        items: [
          {
            name: "Clients",
            subs: [
              "Review",
              "Download Client Details PDF",
              "Portal Access",
              "View As Client",
              "Overview",
              "Personal",
              "Properties",
              "Employment",
              "Financials",
              "Reports",
              "Sent Reports",
              "Requests",
              "Portal Messages",
              "Notes",
              "Reminders",
              "Client Forms",
              "Files",
              "Activity/Documents",
            ],
          },
          { name: "Client Tracker" },
        ],
      },
      {
        heading: "Operations",
        items: [{ name: "Reminders" }, { name: "Checklist" }, { name: "Game Plan" }],
      },
      {
        heading: "Help & Usage",
        items: [{ name: "User Guide" }, { name: "Billing & Usage" }],
      },
      {
        heading: "Administration",
        items: [
          { name: "Settings" },
          { name: "User Management" },
          { name: "Branding" },
          { name: "Templates" },
          { name: "Auto Report Generation" },
          { name: "Error Logs" },
          { name: "Activity Logs" },
          { name: "Client Portal" },
        ],
      },
      {
        heading: "AML / CTF Compliance",
        items: [{ name: "AML/CTF Compliance" }],
      },
    ],
  },
  growth: {
    inherits: "Launch",
    groups: [
      {
        heading: "Reports & Analysis",
        items: [
          { name: "Generated Reports", subs: ["Comparisons"] },
          { name: "Cash Flow Analysis", subs: ["Comparisons"] },
        ],
      },
      {
        heading: "Client & CRM",
        items: [{ name: "Clients", subs: ["Deals"] }],
      },
      {
        heading: "Operations",
        items: [{ name: "Deal Pipeline" }],
      },
    ],
  },
  scale: {
    inherits: "Growth",
    groups: [
      {
        heading: "Main Dashboard",
        items: [
          { name: "Market Updates" },
          { name: "Commercial / Industrial" },
          { name: "Opportunity Marketplace" },
        ],
      },
      {
        heading: "Client & CRM",
        items: [
          {
            name: "Clients",
            subs: [
              "Send To Finance",
              "Portfolio Analysis",
              "Send Portfolio To Client",
              "Send Agreement",
              "Conversations",
              "Appointments",
              "Finance Messages",
              "Borrowing Capacity",
              "AI",
            ],
          },
        ],
      },
      {
        heading: "Operations",
        items: [
          {
            name: "Agreements",
            subs: [
              "Agreement Templates",
              "Partner Referrals",
              "Loan Writer Undertakings",
              "Partner Compliance",
            ],
          },
          { name: "Marketing" },
        ],
      },
      {
        heading: "Administration",
        items: [{ name: "Model Hub" }, { name: "Finance Portal" }, { name: "API Usage" }],
      },
    ],
  },
};

export const featuresForTier = (slug: string): TierFeatures | undefined => TIER_FEATURES[slug];
