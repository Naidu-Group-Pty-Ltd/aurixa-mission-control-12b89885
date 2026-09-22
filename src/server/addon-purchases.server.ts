/**
 * Per-clone add-on purchases.
 *
 * `clone_addon_purchases` is current *state*: which add-ons a clone holds right
 * now, with a status lifecycle. That is deliberately not the same thing as the
 * `purchases` table, which records events — a purchase is never retracted, so
 * a cancelled add-on would keep entitling code forever if entitlement read
 * from there.
 *
 * Add-ons are recurring items on an existing Stripe subscription (see
 * `stripe-module-sync`), so the durable handle is the subscription *item* id,
 * not the subscription. `syncFromStripeItems` is the write path a line-item
 * webhook calls; it is idempotent on that id, so a replayed delivery updates
 * the row it already created rather than granting the add-on twice.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { MODULES, moduleSaleBlock } from "@/lib/pricing/aurixa-catalog";

type Supabase = SupabaseClient<Database>;

export type AddonStatus = "active" | "pending" | "past_due" | "cancelled";

/**
 * Statuses that entitle code.
 *
 * `past_due` is included on purpose: a failed card should not strip a
 * customer's features mid-period. Dunning decides when it becomes `cancelled`,
 * and only then does the entitlement stop.
 */
export const ENTITLING_STATUSES: readonly AddonStatus[] = ["active", "past_due"];

export type AddonPurchase = {
  id: string;
  clone_id: string;
  addon_slug: string;
  addon_name: string | null;
  status: AddonStatus;
  quantity: number;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  stripe_price_id: string | null;
  unit_amount_cents: number | null;
  currency: string;
  purchased_at: string;
  cancelled_at: string | null;
  current_period_end: string | null;
  source: string;
  notes: string | null;
};

/** Valid add-on slugs, so a typo cannot create an entitlement for nothing. */
const CATALOGUE_SLUGS = new Set(MODULES.map((m) => m.slug));

export function isKnownAddon(slug: string): boolean {
  return CATALOGUE_SLUGS.has(slug);
}

/** Add-on slugs a clone currently holds — the set entitlement resolution uses. */
export async function activeAddonSlugs(supabase: Supabase, cloneId: string): Promise<string[]> {
  const { data } = await supabase
    .from("clone_addon_purchases")
    .select("addon_slug")
    .eq("clone_id", cloneId)
    .in("status", ENTITLING_STATUSES as unknown as string[]);
  return [
    ...new Set(((data ?? []) as Array<{ addon_slug: string }>).map((r) => r.addon_slug)),
  ].sort();
}

export async function listAddonPurchases(
  supabase: Supabase,
  cloneId: string,
): Promise<AddonPurchase[]> {
  const { data } = await supabase
    .from("clone_addon_purchases")
    .select("*")
    .eq("clone_id", cloneId)
    .order("status", { ascending: true })
    .order("addon_slug", { ascending: true });
  return (data ?? []) as unknown as AddonPurchase[];
}

export type GrantAddonInput = {
  cloneId: string;
  addonSlug: string;
  quantity?: number;
  source?: "operator" | "stripe" | "storefront";
  stripeSubscriptionId?: string | null;
  stripeSubscriptionItemId?: string | null;
  stripePriceId?: string | null;
  unitAmountCents?: number | null;
  currentPeriodEnd?: string | null;
  externalRef?: string | null;
  notes?: string | null;
  userId?: string | null;
};

/**
 * Grant an add-on to a clone.
 *
 * Re-granting something already live is a no-op rather than an error: an
 * operator clicking twice, or a webhook arriving twice, must not produce two
 * entitlements. A previously cancelled add-on is revived in place so the row's
 * history (and its Stripe link) is preserved.
 */
export async function grantAddon(args: {
  supabase: Supabase;
  input: GrantAddonInput;
}): Promise<{ ok: boolean; error?: string; id?: string; alreadyHeld?: boolean }> {
  const { supabase, input } = args;

  if (!isKnownAddon(input.addonSlug)) {
    return { ok: false, error: `Unknown add-on "${input.addonSlug}"` };
  }

  const catalogue = MODULES.find((m) => m.slug === input.addonSlug);
  const block = moduleSaleBlock(input.addonSlug);
  if (block) {
    // Two reasons a listed module is not for sale here, and they send an
    // operator to different places. Lenders is on the pricing page so the
    // roadmap is visible but has no agreed price; the Builder / Developer
    // Portal has a price and is sold directly, so granting it self-serve
    // would entitle code against a contract nobody wrote. Either way,
    // granting it entitles code nobody can be billed for.
    const name = catalogue?.name ?? input.addonSlug;
    return {
      ok: false,
      error:
        block === "coming_soon"
          ? `"${name}" is not purchasable yet`
          : `"${name}" is sold directly — it cannot be granted from here`,
    };
  }

  const { data: existing } = await supabase
    .from("clone_addon_purchases")
    .select("id, status")
    .eq("clone_id", input.cloneId)
    .eq("addon_slug", input.addonSlug)
    .neq("status", "cancelled")
    .maybeSingle();

  if (existing) {
    return { ok: true, id: existing.id, alreadyHeld: true };
  }

  // Revive a cancelled row rather than stacking a second one, so the add-on
  // keeps one lineage per clone.
  const { data: prior } = await supabase
    .from("clone_addon_purchases")
    .select("id")
    .eq("clone_id", input.cloneId)
    .eq("addon_slug", input.addonSlug)
    .eq("status", "cancelled")
    .order("cancelled_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const payload = {
    clone_id: input.cloneId,
    addon_slug: input.addonSlug,
    addon_name: catalogue?.name ?? input.addonSlug,
    status: "active" as const,
    quantity: input.quantity ?? 1,
    stripe_subscription_id: input.stripeSubscriptionId ?? null,
    stripe_subscription_item_id: input.stripeSubscriptionItemId ?? null,
    stripe_price_id: input.stripePriceId ?? null,
    unit_amount_cents: input.unitAmountCents ?? catalogue?.monthlyInclGstCents ?? null,
    current_period_end: input.currentPeriodEnd ?? null,
    source: input.source ?? "operator",
    external_ref: input.externalRef ?? null,
    notes: input.notes ?? null,
    created_by: input.userId ?? null,
    purchased_at: new Date().toISOString(),
    cancelled_at: null,
  };

  if (prior) {
    const { error } = await supabase
      .from("clone_addon_purchases")
      .update(payload)
      .eq("id", prior.id);
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: prior.id };
  }

  const { data: created, error } = await supabase
    .from("clone_addon_purchases")
    .insert(payload)
    .select("id")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, id: created?.id };
}

/**
 * Stop an add-on entitling code.
 *
 * The row is marked cancelled, never deleted — the same reasoning as a tier
 * downgrade. History is what answers "why did this customer lose a feature",
 * and deleting it makes that unanswerable.
 */
export async function cancelAddon(args: {
  supabase: Supabase;
  cloneId: string;
  addonSlug: string;
  reason?: string;
}): Promise<{ ok: boolean; error?: string; cancelled: number }> {
  const { supabase, cloneId, addonSlug, reason } = args;

  const { data, error } = await supabase
    .from("clone_addon_purchases")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      notes: reason ?? null,
    })
    .eq("clone_id", cloneId)
    .eq("addon_slug", addonSlug)
    .neq("status", "cancelled")
    .select("id");

  if (error) return { ok: false, error: error.message, cancelled: 0 };
  return { ok: true, cancelled: (data ?? []).length };
}

// ─── Stripe line-item sync ───────────────────────────────────────────

export type StripeLineItem = {
  /** Subscription item id — the durable handle for an add-on. */
  subscriptionItemId: string;
  subscriptionId: string;
  priceId: string;
  quantity?: number;
  unitAmountCents?: number | null;
  currentPeriodEnd?: string | null;
  /** Stripe subscription status, mapped onto our lifecycle. */
  subscriptionStatus?: string;
};

/** Map Stripe's subscription status onto our entitlement lifecycle. */
export function mapStripeStatus(stripeStatus: string | undefined): AddonStatus {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "incomplete":
      return "pending";
    case "canceled":
    case "incomplete_expired":
      return "cancelled";
    default:
      // An unrecognised status must not silently entitle code.
      return "pending";
  }
}

export type StripeSyncResult = {
  ok: boolean;
  error?: string;
  granted: string[];
  updated: string[];
  cancelled: string[];
  /** Price ids with no matching add-on in the catalogue. */
  unrecognisedPrices: string[];
};

/**
 * Reconcile a clone's add-ons against the live Stripe subscription items.
 *
 * This is the whole point of the table: a webhook hands over the current line
 * items and this makes the clone match them. Idempotent on
 * `stripe_subscription_item_id`, so a replayed delivery converges rather than
 * duplicating.
 *
 * Items present in Stripe but not held are granted; items held but absent from
 * Stripe are cancelled, because Stripe is authoritative for what is being paid
 * for. Prices that map to no catalogue add-on are reported, never guessed at.
 */
export async function syncFromStripeItems(args: {
  supabase: Supabase;
  cloneId: string;
  items: StripeLineItem[];
  userId?: string | null;
}): Promise<StripeSyncResult> {
  const { supabase, cloneId, items, userId } = args;

  const result: StripeSyncResult = {
    ok: true,
    granted: [],
    updated: [],
    cancelled: [],
    unrecognisedPrices: [],
  };

  // Price id → add-on slug, from the catalogue rows stripe-module-sync linked.
  const { data: addons } = await supabase
    .from("addon_modules")
    .select("slug, name, stripe_price_id")
    .not("stripe_price_id", "is", null);

  const slugByPrice = new Map(
    ((addons ?? []) as Array<{ slug: string; stripe_price_id: string | null }>)
      .filter((a) => a.stripe_price_id)
      .map((a) => [a.stripe_price_id as string, a.slug]),
  );

  const seenSlugs = new Set<string>();

  for (const item of items) {
    const slug = slugByPrice.get(item.priceId);
    if (!slug) {
      // A price we do not recognise is almost always the tier subscription
      // itself or a top-up pack sharing the subscription. Reporting beats
      // guessing — a wrong guess entitles code nobody bought.
      result.unrecognisedPrices.push(item.priceId);
      continue;
    }
    seenSlugs.add(slug);

    const status = mapStripeStatus(item.subscriptionStatus);

    const { data: existing } = await supabase
      .from("clone_addon_purchases")
      .select("id, status")
      .eq("stripe_subscription_item_id", item.subscriptionItemId)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("clone_addon_purchases")
        .update({
          status,
          quantity: item.quantity ?? 1,
          stripe_subscription_id: item.subscriptionId,
          stripe_price_id: item.priceId,
          unit_amount_cents: item.unitAmountCents ?? null,
          current_period_end: item.currentPeriodEnd ?? null,
          cancelled_at: status === "cancelled" ? new Date().toISOString() : null,
        })
        .eq("id", existing.id);
      result.updated.push(slug);
      continue;
    }

    const granted = await grantAddon({
      supabase,
      input: {
        cloneId,
        addonSlug: slug,
        quantity: item.quantity ?? 1,
        source: "stripe",
        stripeSubscriptionId: item.subscriptionId,
        stripeSubscriptionItemId: item.subscriptionItemId,
        stripePriceId: item.priceId,
        unitAmountCents: item.unitAmountCents ?? null,
        currentPeriodEnd: item.currentPeriodEnd ?? null,
        externalRef: `stripe:si:${item.subscriptionItemId}`,
        userId,
      },
    });
    if (granted.ok && !granted.alreadyHeld) result.granted.push(slug);
    else if (granted.ok) result.updated.push(slug);
    else result.error = granted.error;
  }

  // Anything held from Stripe but no longer on the subscription has stopped
  // being paid for. Operator grants are left alone — they were never Stripe's
  // to cancel.
  const { data: held } = await supabase
    .from("clone_addon_purchases")
    .select("id, addon_slug, source")
    .eq("clone_id", cloneId)
    .eq("source", "stripe")
    .neq("status", "cancelled");

  for (const row of (held ?? []) as Array<{ id: string; addon_slug: string }>) {
    if (seenSlugs.has(row.addon_slug)) continue;
    await supabase
      .from("clone_addon_purchases")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
        notes: "No longer present on the Stripe subscription",
      })
      .eq("id", row.id);
    result.cancelled.push(row.addon_slug);
  }

  return result;
}
