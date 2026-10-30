import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { presentAddonRow } from "@/lib/pricing/aurixa-catalog";

export const listPricingCatalog = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const [roles, addons, setups, reports, plans, packs] = await Promise.all([
      supabase.from("seat_roles").select("*").eq("is_active", true).order("sort_order"),
      supabase.from("addon_modules").select("*").eq("is_active", true).order("sort_order"),
      supabase.from("setup_packages").select("*").eq("is_active", true).order("sort_order"),
      supabase.from("report_credit_costs").select("*").eq("is_active", true).order("sort_order"),
      supabase
        .from("seat_plans")
        .select("slug,name,price_cents,currency,metadata")
        .eq("is_active", true)
        .order("price_cents"),
      supabase
        .from("topup_packs")
        .select("slug,name,tokens,price_cents,currency,metadata")
        .eq("is_active", true)
        .order("price_cents"),
    ]);

    if (roles.error) throw roles.error;
    if (addons.error) throw addons.error;
    if (setups.error) throw setups.error;
    if (reports.error) throw reports.error;
    if (plans.error) throw plans.error;
    if (packs.error) throw packs.error;

    return {
      roles: roles.data ?? [],
      addons: (addons.data ?? []).map(presentAddonRow),
      setups: setups.data ?? [],
      reports: reports.data ?? [],
      plans: plans.data ?? [],
      packs: packs.data ?? [],
    };
  });
