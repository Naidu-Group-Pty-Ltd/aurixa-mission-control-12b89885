import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { indexVersion } from "@/server/report-cost-index.server";
import { presentAddonRow } from "@/lib/pricing/aurixa-catalog";
import type { Json } from "@/integrations/supabase/types";

/** What this route selects from `addon_modules`, for the presentation below. */
type AddonRow = {
  slug: string;
  price_min_cents: number | null;
  price_max_cents: number | null;
  metadata?: Json;
};

export const Route = createFileRoute("/api/public/pricing/catalog")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Catalog is non-sensitive; any of these scopes can read it.
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "pricing:read",
          "tokens:meter",
          "tokens:read",
          "seats:manage",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        const [roles, addons, setups, reports, plans, packs] = await Promise.all([
          supabaseAdmin
            .from("seat_roles" as never)
            .select(
              "slug,name,description,price_min_cents,price_max_cents,currency,permissions,metadata,sort_order",
            )
            .eq("is_active", true)
            .order("sort_order"),
          supabaseAdmin
            .from("addon_modules" as never)
            .select(
              "slug,name,category,description,price_min_cents,price_max_cents,billing_period,currency,included_in_plans,metadata,sort_order",
            )
            .eq("is_active", true)
            .order("sort_order"),
          supabaseAdmin
            .from("setup_packages" as never)
            .select(
              "slug,name,description,price_min_cents,price_max_cents,currency,applies_to_plans,deliverables,metadata,sort_order",
            )
            .eq("is_active", true)
            .order("sort_order"),
          supabaseAdmin
            .from("report_credit_costs" as never)
            // `updated_at` feeds the index version below; `metadata.token_kind`
            // is how a clone maps its own `kind` onto a row.
            .select("slug,name,category,description,credit_cost,metadata,sort_order,updated_at")
            .eq("is_active", true)
            .order("sort_order"),
          supabaseAdmin
            .from("seat_plans" as never)
            .select("slug,name,seat_limit,device_limit_per_seat,price_cents,currency,metadata")
            .eq("is_active", true)
            .order("price_cents"),
          supabaseAdmin
            .from("topup_packs" as never)
            .select("slug,name,tokens,price_cents,currency,metadata")
            .eq("is_active", true)
            .order("price_cents"),
        ]);

        // Version of the report cost index. Clones compare it against what
        // they last saw to decide whether a refresh actually changed anything,
        // and to log which revision a reservation was priced under.
        const reportsVersion = indexVersion((reports.data ?? []) as Array<{ updated_at: string }>);

        return jsonResponse({
          ok: true,
          roles: roles.data ?? [],
          addons: ((addons.data ?? []) as AddonRow[]).map(presentAddonRow),
          setups: setups.data ?? [],
          reports: reports.data ?? [],
          reports_version: reportsVersion,
          plans: plans.data ?? [],
          packs: packs.data ?? [],
        });
      },
    },
  },
});
