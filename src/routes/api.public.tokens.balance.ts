import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { EXPIRY_WARNING_DAYS, TOKEN_EXPIRY_DAYS } from "@/server/token-lots.server";
import { balanceEntitlements } from "@/server/balanceEntitlements.pure";

/**
 * The clone's contract exclusions, or `null` when they could not be read.
 *
 * A row that is not there is a failed read as well. The key's foreign key
 * cascades on delete, so a key naming a clone always has a row, and "the read
 * found nothing" can only mean the read did not say.
 */
async function readContractExclusions(cloneId: string): Promise<string[] | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("clones")
      .select("contract_excluded_module_slugs")
      .eq("id", cloneId)
      .maybeSingle();
    if (error) {
      console.warn("[tokens/balance] contract exclusions unavailable", error.message);
      return null;
    }
    const slugs = data?.contract_excluded_module_slugs;
    if (!Array.isArray(slugs)) {
      console.warn("[tokens/balance] contract exclusions unavailable: no readable row", cloneId);
      return null;
    }
    return slugs;
  } catch (err) {
    console.warn("[tokens/balance] contract exclusions unavailable", err);
    return null;
  }
}

export const Route = createFileRoute("/api/public/tokens/balance")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "tokens:read",
          "tokens:meter",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        const url = new URL(request.url);
        const tenantRef = url.searchParams.get("tenant_ref");
        if (!tenantRef || tenantRef.length > 200) {
          return jsonResponse({ ok: false, error: "tenant_ref_required" }, 400);
        }
        const displayName = url.searchParams.get("display_name") ?? undefined;
        const tenant = await ensureTenant(key.clone_id, tenantRef, displayName);
        if (!tenant.ok) return jsonResponse(tenant, 500);

        // `token_balances` is a cache refreshed by ledger writes. A reservation
        // orphaned by an abandoned generation run stops counting once its TTL
        // passes, but nothing rewrites the cache — so without this the tenant
        // keeps seeing credits that are already free again as "reserved". The
        // RPC no-ops unless the cached row is actually stale.
        await supabaseAdmin
          .rpc("refresh_token_balance", { _tenant_id: tenant.tenantId, _max_age_seconds: 60 })
          .then(
            ({ error }) => {
              if (error) console.warn("[tokens/balance] refresh failed", error.message);
            },
            () => {},
          );

        const [bal, ten] = await Promise.all([
          supabaseAdmin
            .from("token_balances")
            .select("available, reserved, lifetime_granted, lifetime_spent, updated_at")
            .eq("tenant_id", tenant.tenantId)
            .maybeSingle(),
          supabaseAdmin
            .from("tenants")
            .select(
              "id, external_ref, display_name, status, current_period_end, billing_exempt, metadata, billing_plans:plan_id(slug, name, monthly_allowance, overage_policy)",
            )
            .eq("id", tenant.tenantId)
            .maybeSingle(),
        ]);

        // What lapses, and when. Credits live 30 days from issue, so a clone
        // needs to be able to warn before a balance quietly shrinks. Derived
        // from the same lot arithmetic as `available`, so the warning can never
        // contradict the number beside it. Best-effort: a balance read must not
        // fail because the schedule query did.
        let expiringSoon = 0;
        let nextExpiryAt: string | null = null;
        try {
          const { data: schedule } = await supabaseAdmin.rpc(
            "token_expiry_schedule" as never,
            {
              _tenant_id: tenant.tenantId,
            } as never,
          );
          const rows = (schedule ?? []) as Array<{ expires_at: string | null; remaining: number }>;
          const dated = rows.filter((r) => r.expires_at);
          nextExpiryAt = dated[0]?.expires_at ?? null;
          const horizon = Date.now() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000;
          expiringSoon = dated
            .filter((r) => Date.parse(r.expires_at as string) <= horizon)
            .reduce((sum, r) => sum + Number(r.remaining ?? 0), 0);
        } catch (err) {
          console.warn("[tokens/balance] expiry schedule unavailable", err);
        }

        // Entitled add-ons for this clone.
        //
        // The clone's plan-tier gate could never decide an add-on: a module
        // sold separately has an empty tier list, so `planIncludesModule`
        // deliberately fell through to the user-permission check rather than
        // lock out a workspace that had paid for it. That leaves add-ons
        // effectively ungated on the clone. Supplying them here is what closes
        // it — the balance call is the one request every clone already makes.
        //
        // `past_due` still entitles, matching how the reconciler treats it: a
        // failed card should not strip a feature mid-period.
        // Best-effort, like the expiry schedule above — a balance read must not
        // fail because the entitlement query did, and an empty list degrades to
        // exactly the behaviour clones have today.
        //
        // A platform-level key carries no clone, and add-ons are bought against a
        // clone — so there is nothing to look up. Skipping is also the only correct
        // form: `.eq("clone_id", null)` asks PostgREST for `clone_id = NULL`, which
        // no row satisfies, so the empty answer was right by accident rather than by
        // rule.
        let addonSlugs: string[] = [];
        const addonCloneId = key.clone_id;
        if (addonCloneId) {
          try {
            const { data: addons } = await supabaseAdmin
              .from("clone_addon_purchases")
              .select("addon_slug")
              .eq("clone_id", addonCloneId)
              .in("status", ["active", "past_due"]);
            addonSlugs = [
              ...new Set(
                ((addons ?? []) as Array<{ addon_slug: string }>).map((a) => a.addon_slug),
              ),
            ].sort();
          } catch (err) {
            console.warn("[tokens/balance] add-on entitlements unavailable", err);
          }
        }

        // The contract's exclusions (D18), price-list slugs read off the
        // clone. Clones gate on this response alone, so this is the only way
        // an exclusion reaches one. Best-effort like the reads above: a failed
        // read never fails the balance. It leaves `excluded` out, and the
        // clone keeps the exclusions it last knew. A platform-level key has
        // no clone, so no agreement and nothing excluded.
        const contractExcluded = addonCloneId ? await readContractExclusions(addonCloneId) : [];

        // AML/CTF is entitled by the purchased SKU, never by tier membership.
        // Every tier's headline SKU — the one Stripe charges — includes the
        // module (TIER_INCLUDES_AML), so a tenant on a known tier is entitled
        // unless a without-AML SKU is recorded or the contract excludes it.
        // Stating it HERE makes this response the authoritative answer;
        // clones no longer have to assume. A future without-AML SKU sets
        // tenants.metadata.aml_excluded and this stops adding the slug.
        const tenantRow = ten.data as {
          billing_plans?: { slug?: string | null } | null;
          metadata?: Record<string, unknown> | null;
        } | null;
        const entitlements = balanceEntitlements({
          addonSlugs,
          planSlug: tenantRow?.billing_plans?.slug ?? null,
          amlExcluded: Boolean(tenantRow?.metadata?.aml_excluded),
          contractExcluded,
        });

        return jsonResponse({
          ok: true,
          tenant: ten.data,
          entitlements,
          balance: bal.data ?? {
            available: 0,
            reserved: 0,
            lifetime_granted: 0,
            lifetime_spent: 0,
          },
          expiry: {
            policy_days: TOKEN_EXPIRY_DAYS,
            warning_days: EXPIRY_WARNING_DAYS,
            expiring_soon: expiringSoon,
            next_expiry_at: nextExpiryAt,
          },
        });
      },
    },
  },
});
