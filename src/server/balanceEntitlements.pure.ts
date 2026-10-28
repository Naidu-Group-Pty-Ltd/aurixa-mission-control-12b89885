/**
 * What a clone's balance response says it is entitled to.
 *
 * `/api/public/tokens/balance` is the one request every clone already makes,
 * and a clone gates only on its answer: the plan slug and these add-on slugs.
 * It never reads Mission Control's bookkeeping (`entitlement_keys`,
 * `entitled_module_slugs`), so a contract's exclusions reach a clone here or
 * not at all (decision D18).
 *
 * The contract with the prime, exactly:
 *
 *     entitlements: { addons: string[], excluded?: string[] }
 *
 *  - `excluded` holds the clone's contract exclusions: price-list slugs,
 *    sorted and de-duplicated. It is PRESENT, possibly `[]`, whenever the
 *    clone's row was read, and `[]` for a platform-level key, which has no
 *    clone and so no agreement. It is ABSENT only when the read failed. The
 *    prime then keeps the exclusions it last knew, because a failed read is not
 *    "no exclusions".
 *  - `addons` never contains an excluded slug, and the AML derivation never
 *    adds `aml-ctf` for a clone whose contract excludes it.
 *  - A billing-exempt tenant's `addons` is every module on the price list,
 *    less its exclusions (D17). The prime's gate already passes an exempt
 *    workspace on a live answer, but its last-known-good cache records only
 *    the plan and these add-ons, and never the exemption itself. Measured 28
 *    Oct 2026, the prime's cache held `scale` and `["aml-ctf"]`, so during a
 *    Mission Control outage the prime's gate would refuse every add-on-only
 *    module, and gating the Solicitor Portal would refuse its four portal
 *    users too. Stating the list here lets the cache keep what a live answer
 *    grants. The cache still never records the exemption, which also waives
 *    metering.
 *
 * Pure, so every case above is asserted without a database.
 */
import {
  AML_MODULE_SLUG,
  MODULES,
  TIER_INCLUDES_AML,
  tierBySlug,
} from "@/lib/pricing/aurixa-catalog";
import { sortedUniqueSlugs } from "@/lib/pricing/contract-exclusions";

export type BalanceEntitlements = { addons: string[]; excluded?: string[] };

export function balanceEntitlements(input: {
  /** Add-on slugs the clone holds: `clone_addon_purchases`, active or past_due. */
  addonSlugs: readonly string[];
  /** The tenant's billing plan slug. */
  planSlug: string | null | undefined;
  /** `tenants.metadata.aml_excluded`: the tenant bought a without-AML SKU. */
  amlExcluded: boolean;
  /**
   * The clone's `contract_excluded_module_slugs`. `[]` for a key that carries
   * no clone. `null` when the read failed.
   */
  contractExcluded: readonly string[] | null;
  /** `tenants.billing_exempt`: the workspace pays for nothing it uses. */
  billingExempt: boolean;
}): BalanceEntitlements {
  const excluded =
    input.contractExcluded === null ? null : sortedUniqueSlugs(input.contractExcluded);
  const withheld = new Set(excluded ?? []);

  const addons = new Set(input.addonSlugs);
  // The exemption waives what the workspace pays, not what it agreed to, so
  // the exclusions still come off below. A without-AML SKU is something
  // bought, and an exempt workspace buys nothing, so it narrows nothing here,
  // as on the prime's live gate.
  if (input.billingExempt) {
    for (const m of MODULES) addons.add(m.slug);
  }
  // AML/CTF is entitled by the purchased SKU, never by tier membership. Every
  // tier's headline SKU, the one Stripe charges, includes the module
  // (TIER_INCLUDES_AML), so a tenant on a known tier is entitled unless a
  // without-AML SKU is recorded (`aml_excluded`) or the contract excludes it.
  if (
    TIER_INCLUDES_AML &&
    !input.amlExcluded &&
    input.planSlug &&
    tierBySlug(input.planSlug) &&
    !withheld.has(AML_MODULE_SLUG)
  ) {
    addons.add(AML_MODULE_SLUG);
  }

  const allowed = sortedUniqueSlugs([...addons].filter((s) => !withheld.has(s)));
  return excluded === null ? { addons: allowed } : { addons: allowed, excluded };
}
