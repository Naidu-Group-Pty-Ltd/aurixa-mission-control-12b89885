import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { loadValidHandoff } from "@/server/purchases.server";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { heldEntitlements, type HeldEntitlementsTenant } from "@/server/heldEntitlements.server";

type HandoffTenant = NonNullable<HeldEntitlementsTenant> & {
  display_name?: string | null;
  external_ref?: string | null;
  billing_plans?: { slug?: string | null; name?: string | null } | null;
};

/**
 * The handoff's tenant, read once for everything the page shows: its name, its
 * plan, and what the balance response derives entitlements from. `null` when
 * there is none or the read failed, which shows less, never more.
 */
async function readHandoffTenant(tenantId: string | null): Promise<HandoffTenant | null> {
  if (!tenantId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("tenants")
      .select(
        "display_name, external_ref, billing_exempt, metadata, billing_plans:plan_id(slug, name)",
      )
      .eq("id", tenantId)
      .maybeSingle();
    if (error) {
      console.warn("[storefront/handoff] tenant unavailable", error.message);
      return null;
    }
    return (data ?? null) as HandoffTenant;
  } catch (err) {
    console.warn("[storefront/handoff] tenant unavailable", err);
    return null;
  }
}

/**
 * GET /api/public/storefront/handoff?h=<uuid>
 *
 * Display-safe handoff resolution for the Aurixa Systems pricing page: the
 * storefront shows "Purchasing for <clone> as <user>" and knows which intent
 * to auto-launch. The unguessable single-use token is the credential; the
 * response is deliberately minimal — the raw origin_user_id stays server-side
 * and checkout re-reads it from the handoff row.
 */
export const Route = createFileRoute("/api/public/storefront/handoff")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const h = url.searchParams.get("h") ?? "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(h)) {
          return storefrontJson({ ok: false, error: "handoff_invalid" }, 400);
        }

        const handoff = await loadValidHandoff(h);
        if (!handoff) return storefrontJson({ ok: false, error: "handoff_invalid" }, 404);

        const tenant = await readHandoffTenant(handoff.tenant_id);

        // Workspace display name: the clone's name when the handoff belongs to
        // a clone, else the tenant's display name — prime-install handoffs have
        // clone_id NULL but always carry tenant_id, and returning null here
        // made the pricing page fall back to a generic "your workspace".
        let cloneName: string | null = null;
        if (handoff.clone_id) {
          const { data: clone } = await supabaseAdmin
            .from("clones")
            .select("name, slug")
            .eq("id", handoff.clone_id)
            .maybeSingle();
          cloneName = clone?.name ?? clone?.slug ?? null;
        }
        if (!cloneName) cloneName = tenant?.display_name ?? tenant?.external_ref ?? null;

        const plan = tenant?.billing_plans?.slug
          ? { slug: tenant.billing_plans.slug, name: tenant.billing_plans.name ?? null }
          : null;

        // What the workspace holds, so the storefront can gate documentation
        // and its add-on buttons the way the workspace's own app is gated. Tier
        // alone cannot answer it: a separately-sold module carries an empty
        // tier list, so a Launch workspace that bought Market Updates looks
        // identical to one that did not unless the add-ons travel too. Nor can
        // the purchases alone: AML/CTF comes with a tier's headline SKU, the
        // partner portals come with AML/CTF (29 Oct 2026), and a contract can
        // exclude any of it.
        //
        // So it is the balance response's own answer, through the same helper.
        // Best-effort as there: a docs page is not worth failing a handoff
        // resolution over. A failed add-on read is "none known", which shows
        // less; failed exclusions are `null`, said as unknown rather than none.
        const entitlements = await heldEntitlements({
          tenant,
          cloneId: handoff.clone_id,
          logTag: "storefront/handoff",
        });

        return storefrontJson({
          ok: true,
          current_plan_slug: plan?.slug ?? null,
          current_plan_name: plan?.name ?? null,
          addon_slugs: entitlements.addons,
          excluded_slugs: entitlements.excluded ?? null,
          handoff_id: handoff.id,
          clone_name: cloneName,
          origin_username: handoff.origin_username,
          intent: handoff.intent,
          expires_at: handoff.expires_at,
        });
      },
    },
  },
});
