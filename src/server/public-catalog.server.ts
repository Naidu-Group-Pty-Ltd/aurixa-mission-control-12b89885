// Public pricing catalog reads — safe, non-PII product/pricing data only.
// Shared by the getPublicPricing server fn (Mission Control's own operator
// pricing console) and the storefront REST endpoint
// (api/public/storefront/catalog) that powers the customer-facing pricing
// page on the Aurixa Systems website.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { presentAddonRow } from "@/lib/pricing/aurixa-catalog";

export async function fetchPublicCatalog() {
  const [plans, packs, setups, addons, roles, reports] = await Promise.all([
    supabaseAdmin
      .from("seat_plans")
      .select(
        "id, slug, name, description, price_cents, currency, seat_limit, device_limit_per_seat, overage_policy, is_default, metadata",
      )
      .eq("is_active", true)
      .order("price_cents", { ascending: true }),
    supabaseAdmin
      .from("topup_packs")
      .select("id, slug, name, tokens, price_cents, currency, expires_after_days, metadata")
      .eq("is_active", true)
      .order("tokens", { ascending: true }),
    supabaseAdmin
      .from("setup_packages")
      .select(
        "id, slug, name, description, price_min_cents, price_max_cents, currency, deliverables, metadata",
      )
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabaseAdmin
      .from("addon_modules")
      .select(
        "id, slug, name, description, price_min_cents, price_max_cents, currency, billing_period, category, included_in_plans",
      )
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabaseAdmin
      .from("seat_roles")
      .select(
        "id, slug, name, description, price_min_cents, price_max_cents, currency, permissions, metadata",
      )
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
    supabaseAdmin
      .from("report_credit_costs")
      .select("id, slug, name, category, description, credit_cost, metadata")
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
  ]);

  return {
    plans: plans.data ?? [],
    packs: packs.data ?? [],
    setups: setups.data ?? [],
    addons: (addons.data ?? []).map(presentAddonRow),
    roles: roles.data ?? [],
    reports: reports.data ?? [],
  };
}
