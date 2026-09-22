// Puts the add-on modules on sale.
//
// The modules have been in the catalog since the price list landed, but only
// as DISPLAY data: the seeding migration says so in as many words — "addon_modules
// carries no stripe_price_id and is not directly checkout-able" — and that was
// the right call at the time, because a row with a price and nothing behind it
// cannot overcharge anyone. It also means the twenty-three modules on the
// pricing page have never been buyable. This is the step that gives each one a
// Stripe product and a recurring price, and records the link on the row.
//
// Same plan/apply split, and the same invariant, as the tier and pack
// cutovers: `addon_modules.price_min_cents` is the figure the pricing page
// SHOWS and `addon_modules.stripe_price_id` is the price Stripe CHARGES, so
// the two have to move together. plan() is pure and unit-tested; apply()
// creates the Stripe price first and only then writes the row, so a row is
// never live against a price that does not exist.
//
// Three things differ from the pack ladder:
//
//   • Modules are a monthly subscription, not a one-off, so the prices are
//     recurring. A module is added to an existing subscription rather than
//     bought outright.
//   • Nothing is retired. No module supersedes another, and the rows are
//     already active and on display — linking one only adds a way to buy it.
//   • Modules that are not purchasable are skipped outright — Lenders because
//     it is on the page for the roadmap with no agreed price, the Builder /
//     Developer Portal because it is priced but sold directly. Neither may
//     reach Stripe. Skipped loudly, in the plan, rather than silently dropped.
import Stripe from "stripe";
import { getStripe } from "@/server/stripe.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { describeRefresh, refreshStorefrontMirror } from "@/server/storefront-refresh.server";
import {
  AML_MODULE_SLUG,
  MODULES,
  PURCHASABLE_MODULES,
  TIER_INCLUDES_AML,
  gstComponentCents,
  isModulePurchasable,
  type PricedModule,
} from "@/lib/pricing/aurixa-catalog";

const adminAny = supabaseAdmin;

export type ModuleRow = {
  id: string;
  slug: string;
  name: string;
  price_min_cents: number | null;
  is_active: boolean;
  stripe_price_id?: string | null;
  stripe_product_id?: string | null;
};

export type ModuleOp = {
  slug: string;
  name: string;
  category: string;
  /** Monthly, tax-INCLUSIVE, in cents — the sheet's figure for this module. */
  unitAmount: number;
  gstComponent: number;
  /** Tier slugs that already bundle this module at no extra cost. */
  includedIn: readonly string[];
  /** Whether the catalog row is already selling at this price. */
  alreadyLive: boolean;
};

export type ModuleSyncPlan = {
  modules: ModuleOp[];
  /** Listed for the roadmap only — deliberately given no Stripe price. */
  skipped: string[];
  /** Priced modules with no catalog row: the price-list migration has not run. */
  missing: string[];
  warnings: string[];
};

/** "Launch, Growth and Scale" — not "Launch and Growth and Scale". */
function tierList(slugs: readonly string[]): string {
  const names = slugs.map((s) => s[0].toUpperCase() + s.slice(1));
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * How a module presents itself in Stripe.
 *
 * The tiers that bundle the module go in the description, because a Stripe
 * product is what an invoice line and the billing portal read from — and the
 * single most likely support question about a module charge is "isn't this
 * already in my plan?". Answering it on the charge itself is cheaper than
 * answering it in a ticket.
 *
 * AML/CTF is the case where answering it wrong costs money rather than time.
 * Its `includedIn` is empty, which is true of the MODULE MATRIX but not of
 * what is sold: every tier's headline price already contains it — that is the
 * $195 gap between each tier's two published figures — so a customer on a
 * headline tier who bought this module as well would pay for it twice.
 * Describing it as an ordinary add-on would actively invite that.
 */
export function moduleProductShape(mod: PricedModule): {
  name: string;
  description: string;
  metadata: Record<string, string>;
} {
  const bundledInEveryTier = mod.slug === AML_MODULE_SLUG && TIER_INCLUDES_AML;
  const included = bundledInEveryTier
    ? "Already contained in every tier's headline price — needed only alongside a tier bought without it."
    : mod.includedIn.length
      ? `Included with ${tierList(mod.includedIn)}.`
      : "Available on every tier as an add-on.";
  return {
    // Two modules are already branded — "Aurixa Intelligence Hub", "Aurixa
    // Agent" — and prefixing those produces "Aurixa Aurixa Agent" on the
    // customer's invoice.
    name: mod.name.startsWith("Aurixa ") ? mod.name : `Aurixa ${mod.name}`,
    description: [mod.note, included].filter(Boolean).join(" "),
    metadata: {
      aurixa_module: mod.slug,
      module_category: mod.category,
      // Empty string rather than omitted: Stripe treats an absent key and an
      // empty one differently on update, and a module losing its last bundled
      // tier must actually clear the field rather than keep the stale list.
      included_in: mod.includedIn.join(","),
    },
  };
}

/** Everything the cutover will do, computed without touching anything. */
export function planModuleSync(rows: readonly ModuleRow[]): ModuleSyncPlan {
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const warnings: string[] = [];
  const missing: string[] = [];
  const modules: ModuleOp[] = [];

  for (const mod of PURCHASABLE_MODULES) {
    const row = bySlug.get(mod.slug);
    if (!row) {
      missing.push(mod.slug);
      continue;
    }
    modules.push({
      slug: mod.slug,
      name: mod.name,
      category: mod.category,
      unitAmount: mod.monthlyInclGstCents,
      gstComponent: gstComponentCents(mod.monthlyInclGstCents),
      includedIn: mod.includedIn,
      alreadyLive:
        row.is_active && row.price_min_cents === mod.monthlyInclGstCents && !!row.stripe_price_id,
    });
  }

  if (missing.length) {
    // Creating the rows here would work, but it would also mean this button
    // could quietly invent catalog entries nobody reviewed. The migration is
    // the reviewed artifact; say so and stop.
    warnings.push(
      `No catalog row for ${missing.join(", ")}. Apply the Aurixa price list migration first.`,
    );
  }

  return {
    modules,
    skipped: MODULES.filter((m) => !isModulePurchasable(m.slug)).map((m) => m.slug),
    missing,
    warnings,
  };
}

/** Loads the modules the cutover operates on. */
export async function loadModuleRows(): Promise<ModuleRow[]> {
  const { data, error } = await adminAny
    .from("addon_modules")
    .select("id, slug, name, price_min_cents, is_active, stripe_price_id, stripe_product_id")
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`addon_modules_read_failed: ${error.message}`);
  return (data ?? []) as ModuleRow[];
}

/**
 * The Stripe product for this module, or a new one.
 *
 * Same resolution order as the tier and pack products, for the same reason:
 * a stored id is a direct lookup and always right, search is eventually
 * consistent and can miss a product created moments ago, and creating is only
 * correct once both have come up empty. Get that order wrong and a retry after
 * a partial failure mints a duplicate product per module — which is exactly
 * what happened to the Growth tier, and why there are two `Aurixa Growth`
 * products in the account.
 *
 * `stripe_product_id` is consulted before `stripe_price_id` here, unlike the
 * pack sync, because this table stores both: the product id survives a
 * reprice, so it is the more stable of the two pointers.
 */
async function ensureModuleProduct(
  stripe: Stripe,
  mod: PricedModule,
  row?: ModuleRow,
): Promise<string> {
  const shape = moduleProductShape(mod);

  if (row?.stripe_product_id) {
    try {
      await stripe.products.update(row.stripe_product_id, shape);
      return row.stripe_product_id;
    } catch {
      // Archived, deleted, or from another account — fall through.
    }
  }

  if (row?.stripe_price_id) {
    try {
      const price = await stripe.prices.retrieve(row.stripe_price_id);
      const productId = typeof price.product === "string" ? price.product : price.product?.id;
      if (productId) {
        await stripe.products.update(productId, shape);
        return productId;
      }
    } catch {
      // Price deleted, or belongs to another account — fall through.
    }
  }

  try {
    const found = await stripe.products.search({
      query: `metadata['aurixa_module']:'${mod.slug}'`,
    });
    if (found.data[0]) {
      await stripe.products.update(found.data[0].id, shape);
      return found.data[0].id;
    }
  } catch {
    // Search unavailable on this account — creating is still correct.
  }

  const created = await stripe.products.create({
    ...shape,
    metadata: { ...shape.metadata, lookup: `aurixa_module_${mod.slug}` },
  });
  return created.id;
}

/**
 * A monthly recurring price at this amount, reusing one if the product has it.
 *
 * Stripe prices are immutable, so the natural implementation is "always
 * create" — but Apply is a button a human presses, and a press that fails
 * partway gets pressed again. Matching on the fields that DEFINE a price makes
 * the second press a no-op instead of a second identical price on the product.
 *
 * The `recurring.interval` check is load-bearing and not merely thorough: a
 * one-off price at the same amount is a different product entirely as far as
 * billing is concerned, and matching against one would attach a module to a
 * subscription that never renews it.
 */
async function ensureModulePrice(
  stripe: Stripe,
  productId: string,
  mod: PricedModule,
): Promise<{ id: string; created: boolean }> {
  const existing = await stripe.prices.list({ product: productId, active: true, limit: 100 });
  const match = existing.data.find(
    (p) =>
      p.unit_amount === mod.monthlyInclGstCents &&
      p.currency === "aud" &&
      p.recurring?.interval === "month" &&
      p.tax_behavior === "inclusive",
  );
  if (match) return { id: match.id, created: false };

  const price = await stripe.prices.create({
    product: productId,
    currency: "aud",
    unit_amount: mod.monthlyInclGstCents,
    // Every figure on the sheet already contains GST. Left at Stripe's
    // default, enabling Stripe Tax later would ADD 10% on top and quietly
    // overcharge every customer on every module they hold.
    tax_behavior: "inclusive",
    recurring: { interval: "month" },
    metadata: {
      aurixa_module: mod.slug,
      gst_component_cents: String(gstComponentCents(mod.monthlyInclGstCents)),
    },
  });
  return { id: price.id, created: true };
}

export type ModuleApplyResult = {
  applied: boolean;
  createdPrices: Array<{ slug: string; priceId: string; productId: string; amount: number }>;
  linked: string[];
  notes: string[];
  errors: string[];
  /** Whether the storefront's read mirror picked the change up straight away. */
  storefrontRefreshed?: boolean;
};

/**
 * Executes the plan: Stripe price first, catalog row second, one module at a
 * time.
 *
 * A module that fails is recorded and the rest carry on, because unlike the
 * pack ladder there is nothing here that has to move as a set — each module is
 * independently sellable, and eighteen of them working is strictly better than
 * none. The operator presses Apply again for the stragglers.
 */
export async function applyModuleSync(
  plan: ModuleSyncPlan,
  rows: readonly ModuleRow[] = [],
): Promise<ModuleApplyResult> {
  const stripe = getStripe();
  const result: ModuleApplyResult = {
    applied: true,
    createdPrices: [],
    linked: [],
    notes: [],
    errors: [],
  };
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const wanted = new Set(plan.modules.map((m) => m.slug));

  for (const mod of PURCHASABLE_MODULES) {
    if (!wanted.has(mod.slug)) continue;
    try {
      const row = bySlug.get(mod.slug);
      const productId = await ensureModuleProduct(stripe, mod, row);
      const price = await ensureModulePrice(stripe, productId, mod);
      if (price.created) {
        result.createdPrices.push({
          slug: mod.slug,
          priceId: price.id,
          productId,
          amount: mod.monthlyInclGstCents,
        });
      }

      const { error } = await adminAny
        .from("addon_modules")
        .update({
          name: mod.name,
          category: mod.category,
          price_min_cents: mod.monthlyInclGstCents,
          price_max_cents: mod.monthlyInclGstCents,
          currency: "AUD",
          billing_period: "monthly",
          stripe_product_id: productId,
          stripe_price_id: price.id,
          is_active: true,
          metadata: {
            tax_inclusive: true,
            gst_included: true,
            gst_component_cents: gstComponentCents(mod.monthlyInclGstCents),
          },
        })
        .eq("slug", mod.slug);
      if (error) throw new Error(error.message);
      result.linked.push(mod.slug);
    } catch (err) {
      result.errors.push(`${mod.slug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A module the catalogue withholds must not be sellable, and "we never
  // linked one" is not the same as "it cannot be bought" — a stale link from
  // an earlier run would still resolve at checkout. Clearing it is cheap and
  // makes the flag actually enforceable. Keyed on purchasability rather than
  // on `comingSoon`, so a module withheld for a NEW reason is swept too.
  for (const mod of MODULES.filter((m) => !isModulePurchasable(m.slug))) {
    const row = bySlug.get(mod.slug);
    if (!row?.stripe_price_id && !row?.stripe_product_id) continue;
    const { error } = await adminAny
      .from("addon_modules")
      .update({ stripe_price_id: null, stripe_product_id: null })
      .eq("slug", mod.slug);
    if (error) {
      result.notes.push(`Could not unlink the roadmap module ${mod.slug}: ${error.message}`);
    } else {
      result.notes.push(`Unlinked ${mod.slug} — listed, but not sold through a checkout.`);
    }
  }

  await refreshInto(result);
  result.applied = result.errors.length === 0;
  return result;
}

/**
 * Closes the loop rather than trusting the database trigger to do it.
 *
 * The storefront reads a mirror, and until that mirror refreshes the pricing
 * page shows the modules as they were. Reported, never fatal — the catalog is
 * already correct either way, and the 15-minute reconcile is the backstop.
 */
async function refreshInto(result: ModuleApplyResult): Promise<void> {
  const refresh = await refreshStorefrontMirror();
  result.storefrontRefreshed = refresh.ok;
  result.notes.push(describeRefresh(refresh, "module catalog"));
}
