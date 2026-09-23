// The pricing half of the voice knowledge base, GENERATED from the catalog.
//
// Every figure here comes from src/lib/pricing/aurixa-catalog.ts, which is the
// price list the storefront and Stripe both read. It is generated rather than
// written because the previous knowledge base had its prices typed in, and by
// the time this was measured (23 Sep 2026) every one of them was stale: the
// document told callers Launch was A$699 against a list price of A$999, Scale
// A$2,210 against A$2,699, and the AML/CTF module A$195 against A$150. Nine
// module prices were wrong and four modules were missing entirely.
//
// A voice agent quoting a price three hundred dollars under the list is worse
// than one that cannot quote at all, and nothing anywhere would have caught
// it - the document is uploaded to a vendor by hand and compared with nothing.
//
// Two rules follow. A price is READ from the catalog, never restated: a
// literal at each end is how two ends drift. And a module the catalog marks
// `comingSoon` carries no figure at all - `lenders` says so in its own note,
// "the listed figure is historical and is not a current price", and a
// historical figure spoken aloud is a quote.
import {
  AML_CORE_BUNDLE_DISCOUNT_CENTS,
  AML_NET_UPLIFT_CENTS,
  AML_REFERENCE_COMPONENT_CENTS,
  ANNUAL_DISCOUNT,
  MODULES,
  TIERS,
  TOPUP_PACKS,
  tierBaseCents,
  tierHeadlineCents,
} from "../../../src/lib/pricing/aurixa-catalog.ts";
import { TIER_FEATURES } from "../../../src/lib/pricing/tier-features.ts";

/** "A$999", or "A$20.90" where there are cents. Spoken aloud as written. */
export function money(cents) {
  const whole = cents % 100 === 0;
  return `A$${(cents / 100).toLocaleString("en-AU", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

const CATEGORY_ORDER = [
  "Main Dashboard",
  "Reports & Analysis",
  "Client & CRM",
  "Operations",
  "AML / CTF Compliance",
  "Administration",
  "AI Assistant",
];

export function tierLines() {
  return TIERS.map((t) => {
    const head = money(tierHeadlineCents(t));
    const base = money(tierBaseCents(t));
    return (
      `${t.name} — ${head} per month for ${t.seatMin} to ${t.seatMax} seats, ` +
      `including ${t.monthlyCredits.toLocaleString("en-AU")} report credits a month. ` +
      `That headline includes the AML/CTF Compliance module; without it the same ` +
      `tier is ${base} per month.`
    );
  });
}

export function amlSentence() {
  return (
    `The gap between a tier's two prices is always ${money(AML_NET_UPLIFT_CENTS)} a month, ` +
    `which is what the AML/CTF Compliance module costs. It is described as a ` +
    `${money(AML_REFERENCE_COMPONENT_CENTS)} reference component less a ` +
    `${money(AML_CORE_BUNDLE_DISCOUNT_CENTS)} Core Platform discount that applies only while ` +
    `AML/CTF is selected — but ${money(AML_NET_UPLIFT_CENTS)} is the only amount ever charged, ` +
    `whether it is added to a plan or dropped from one. Never quote the ` +
    `${money(AML_REFERENCE_COMPONENT_CENTS)} figure as a price.`
  );
}

/** The AML/CTF module's monthly charge, spoken as a figure. */
export function amlUplift() {
  return money(AML_NET_UPLIFT_CENTS);
}

/**
 * "Which plan fits a firm like ours?" - the seat band and the catalog's own
 * one-line blurb for each tier. The blurb is the price list's statement of who
 * the tier is for, so it is read from there rather than paraphrased here.
 */
export function tierFitLines() {
  return TIERS.map((t) => `${t.name}, for ${t.seatMin} to ${t.seatMax} seats — ${t.blurb}`);
}

/**
 * What each plan includes, GENERATED from tier-features.ts - the signed-off
 * pricing sheet's own per-tier matrices, the same data the storefront's plan
 * cards read.
 *
 * One rule decides what is spoken. A higher tier lists only what it ADDS, and
 * the add is the whole point of the sentence, so a delta tier's sub-items are
 * always named. The base tier's client record carries eighteen sub-views
 * ("Portal Access", "View As Client", ...) that are a page map rather than a
 * sentence anyone could say, so on the base tier an item's sub-items are named
 * only when there are a handful of them.
 */
export function tierInclusionLines() {
  return TIERS.map((t) => {
    const f = TIER_FEATURES[t.slug];
    if (!f) return null;
    const isDelta = Boolean(f.inherits);
    const items = f.groups.flatMap((g) =>
      g.items.map((it) => {
        const subs = it.subs ?? [];
        if (!subs.length) return it.name;
        if (isDelta || subs.length <= 4) return `${it.name} (${listOf(subs)})`;
        return it.name;
      }),
    );
    const lead = isDelta ? `${t.name} includes everything in ${f.inherits}, plus` : `${t.name} includes`;
    return `${lead} ${listOf(items)}.`;
  }).filter(Boolean);
}

export function annualSentence() {
  return `Annual billing is available at ${Math.round(ANNUAL_DISCOUNT * 100)}% off, billed twelve months up front.`;
}

/** One bullet per module, grouped by the catalog's own categories. */
export function moduleLines() {
  const out = [];
  for (const category of CATEGORY_ORDER) {
    const rows = MODULES.filter((m) => m.category === category);
    if (!rows.length) continue;
    out.push({ heading: category, bullets: rows.map(moduleBullet) });
  }
  return out;
}

function moduleBullet(m) {
  // A module with no agreed selling price is named without one. Saying "not
  // yet available" is a fact; saying a number the catalog calls historical is
  // a quote nobody approved.
  if (m.comingSoon) return `${m.name} — not yet available for purchase, and not priced.`;
  const price = `${money(m.monthlyInclGstCents)} a month`;
  const included = m.includedIn.length
    ? ` Included at no extra cost on ${listOf(m.includedIn.map(tierName))}.`
    : "";
  const direct = m.directSale ? " Sold directly by the team rather than through a checkout." : "";
  // The AML row's note restates the reference component in raw dollars, and
  // amlSentence() already explains that pairing properly. Repeating it here
  // would put "$400" in a price list, which is the one thing that note warns
  // against.
  const note = m.note && m.slug !== "aml-ctf" ? ` ${m.note}` : "";
  return `${m.name} — ${price}.${included}${direct}${note}`;
}

/** "Launch, Growth and Scale" - a spoken list, not "and and". */
function listOf(items) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function tierName(slug) {
  return TIERS.find((t) => t.slug === slug)?.name ?? slug;
}

export function topupLines() {
  return TOPUP_PACKS.map(
    (p) => `${p.credits.toLocaleString("en-AU")} credits — ${money(p.priceInclGstCents)}`,
  );
}

export function topupRangeSentence() {
  const first = TOPUP_PACKS[0];
  const last = TOPUP_PACKS[TOPUP_PACKS.length - 1];
  return (
    `One-off top-up packs run from ${first.credits.toLocaleString("en-AU")} credits at ` +
    `${money(first.priceInclGstCents)} to ${last.credits.toLocaleString("en-AU")} credits at ` +
    `${money(last.priceInclGstCents)}; the larger packs cost substantially less per credit.`
  );
}
