/**
 * What a workspace holds, read the way the balance response reads it.
 *
 * Two routes answer the question: `/api/public/tokens/balance`, which every
 * clone gates on, and `/api/public/storefront/handoff`, which the storefront
 * gates its documentation and its add-on buttons on. They read the same rows
 * through these helpers and derive the answer with the same
 * `balanceEntitlements`, so a workspace is told one thing in its own app and
 * on the storefront: what it bought, the AML/CTF its tier's SKU carries, the
 * partner portals that come with it (29 Oct 2026), and what its contract
 * excludes.
 *
 * Every read here is best-effort and says which kind of answer it gave. A
 * failed add-on read is no add-ons known, which only ever shows less; a failed
 * exclusions read is `null`, never `[]`, because "no exclusions" would hand a
 * clone back what its contract took away.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { balanceEntitlements, type BalanceEntitlements } from "@/server/balanceEntitlements.pure";

/**
 * The add-ons a clone has bought and still holds: `active`, or `past_due`,
 * which still entitles, matching how the reconciler treats it — a failed card
 * should not strip a feature mid-period. Sorted, each once, and `[]` when the
 * read failed.
 */
export async function readPurchasedAddonSlugs(cloneId: string, logTag: string): Promise<string[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("clone_addon_purchases")
      .select("addon_slug")
      .eq("clone_id", cloneId)
      .in("status", ["active", "past_due"]);
    if (error) {
      console.warn(`[${logTag}] add-on entitlements unavailable`, error.message);
      return [];
    }
    return [
      ...new Set(((data ?? []) as Array<{ addon_slug: string }>).map((a) => a.addon_slug)),
    ].sort();
  } catch (err) {
    console.warn(`[${logTag}] add-on entitlements unavailable`, err);
    return [];
  }
}

/**
 * The clone's contract exclusions, or `null` when they could not be read.
 *
 * A row that is not there is a failed read as well. The key's foreign key
 * cascades on delete, so a key naming a clone always has a row, and "the read
 * found nothing" can only mean the read did not say.
 */
export async function readContractExclusions(
  cloneId: string,
  logTag: string,
): Promise<string[] | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("clones")
      .select("contract_excluded_module_slugs")
      .eq("id", cloneId)
      .maybeSingle();
    if (error) {
      console.warn(`[${logTag}] contract exclusions unavailable`, error.message);
      return null;
    }
    const slugs = data?.contract_excluded_module_slugs;
    if (!Array.isArray(slugs)) {
      console.warn(`[${logTag}] contract exclusions unavailable: no readable row`, cloneId);
      return null;
    }
    return slugs;
  } catch (err) {
    console.warn(`[${logTag}] contract exclusions unavailable`, err);
    return null;
  }
}

/** The tenant columns the derivation reads, as the balance route selects them. */
export type HeldEntitlementsTenant = {
  billing_exempt?: boolean | null;
  billing_plans?: { slug?: string | null } | null;
  metadata?: Record<string, unknown> | null;
} | null;

/**
 * The balance response's `entitlements` for a tenant and the clone it belongs
 * to. A tenant with no clone (a platform-level key, or the prime's own
 * install) has bought nothing against a clone and has no agreement, so nothing
 * is read for it and nothing is excluded.
 */
export async function heldEntitlements(args: {
  tenant: HeldEntitlementsTenant;
  cloneId: string | null;
  logTag: string;
}): Promise<BalanceEntitlements> {
  const { tenant, cloneId, logTag } = args;
  const [addonSlugs, contractExcluded] = cloneId
    ? await Promise.all([
        readPurchasedAddonSlugs(cloneId, logTag),
        readContractExclusions(cloneId, logTag),
      ])
    : [[] as string[], [] as string[]];
  return balanceEntitlements({
    addonSlugs,
    planSlug: tenant?.billing_plans?.slug ?? null,
    amlExcluded: Boolean(tenant?.metadata?.aml_excluded),
    contractExcluded,
    billingExempt: tenant?.billing_exempt === true,
  });
}
