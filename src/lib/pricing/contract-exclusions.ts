/**
 * A contract's module exclusions, in the vocabulary a contract is written in.
 *
 * An exclusion is a PRICE-LIST module slug: `MODULES[].slug` in
 * `aurixa-catalog.ts`, such as `aml-ctf`, `finance-portal` or `market-updates`.
 * A contract is negotiated in that vocabulary, and the prime gates on it: every
 * gated capability in the prime's registry carries its price-list slug as an
 * add-on slug.
 *
 * Until 27 Oct 2026 an exclusion was a LIBRARY module id
 * (`client_agreements.excluded_module_ids`): a row of `modules`, which holds the
 * code detection found in the prime (`aml`, `commercial`, `backend-aml`). That
 * named code rather than what was sold, and a library reset lost the ids without
 * a word.
 *
 * The dialog, the save, provisioning and the balance response all import this
 * module, so none of them spells an exclusion its own way. The reconcile's
 * translation into library modules lives beside the rest of that join, in
 * `module-mapping.ts`.
 */
import {
  AML_MODULE_SLUG,
  MODULES,
  TIER_INCLUDES_AML,
  moduleBySlug,
  tierBySlug,
  type PricedModule,
} from "./aurixa-catalog";

/** Sorted and de-duplicated: the one shape an exclusion list is stored and sent in. */
export function sortedUniqueSlugs(slugs: readonly string[]): string[] {
  return [...new Set(slugs)].sort();
}

/** The slugs in `slugs` that the price list does not know, sorted and de-duplicated. */
export function unknownExclusionSlugs(slugs: readonly string[]): string[] {
  return sortedUniqueSlugs(slugs.filter((s) => !moduleBySlug(s)));
}

export type ExclusionValidation = { ok: true; slugs: string[] } | { ok: false; error: string };

/**
 * The exclusions an agreement may record, sorted and de-duplicated.
 *
 * Two refusals, each with the slugs it refuses:
 *
 *  - a slug the price list does not know. Held until signature, it would
 *    exclude nothing and say nothing. A library slug such as `aml` is refused
 *    here too: it is the old vocabulary, and the price list calls that module
 *    `aml-ctf`.
 *  - a slug the same selection buys as an add-on. The clone would pay for the
 *    module and never be allowed to use it, because an exclusion always wins.
 *
 * An exclusion of a priced module the plan does not include is accepted. It
 * changes nothing on this plan and records the negotiation, so a later move to
 * a plan that includes the module does not hand it back.
 */
export function validateContractExclusions(
  slugs: readonly string[],
  selection: { addonSlugs?: readonly string[] } = {},
): ExclusionValidation {
  const unknown = unknownExclusionSlugs(slugs);
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `Not on the price list: ${unknown.join(", ")}. An exclusion names a price-list ` +
        `module, such as aml-ctf, finance-portal or market-updates.`,
    };
  }
  const bought = new Set(selection.addonSlugs ?? []);
  const alsoBought = sortedUniqueSlugs(slugs.filter((s) => bought.has(s)));
  if (alsoBought.length > 0) {
    return {
      ok: false,
      error:
        `Bought as an add-on in this selection and excluded as well: ${alsoBought.join(", ")}. ` +
        `Keep one or the other.`,
    };
  }
  return { ok: true, slugs: sortedUniqueSlugs(slugs) };
}

/**
 * The price-list modules a plan can have negotiated out: the ones it includes,
 * plus AML/CTF on a tier, because every tier's headline SKU carries it
 * (`TIER_INCLUDES_AML`) although `aml-ctf` lists no tier in `includedIn`.
 */
export function excludableModules(planSlug: string | null | undefined): PricedModule[] {
  if (!planSlug) return [];
  const amlOnThisPlan = TIER_INCLUDES_AML && Boolean(tierBySlug(planSlug));
  return MODULES.filter(
    (m) => m.includedIn.includes(planSlug) || (m.slug === AML_MODULE_SLUG && amlOnThisPlan),
  );
}

export type ExclusionChoice = {
  slug: string;
  /** The price list's name for it, or the slug itself when the price list has none. */
  name: string;
  /** Why it is listed although the plan does not offer it; null when the plan does. */
  note: "not in this tier" | "not on the price list" | null;
};

/**
 * The rows the agreement dialog lists: what the plan can have negotiated out
 * (`excludableModules`), then every saved or selected exclusion outside that
 * set, so one left over from another tier, or from an older price list, is
 * seen and can be removed rather than kept unseen.
 */
export function exclusionChoices(input: {
  planSlug: string | null | undefined;
  /** The exclusions the agreement holds. */
  saved: readonly string[];
  /** The exclusions currently ticked. */
  selected: readonly string[];
}): ExclusionChoice[] {
  const offered = excludableModules(input.planSlug);
  const offeredSlugs = new Set(offered.map((m) => m.slug));
  const outside = sortedUniqueSlugs([...input.saved, ...input.selected]).filter(
    (s) => !offeredSlugs.has(s),
  );
  return [
    ...offered.map((m): ExclusionChoice => ({ slug: m.slug, name: m.name, note: null })),
    ...outside.map((slug): ExclusionChoice => {
      const priced = moduleBySlug(slug);
      return {
        slug,
        name: priced?.name ?? slug,
        note: priced ? "not in this tier" : "not on the price list",
      };
    }),
  ];
}
