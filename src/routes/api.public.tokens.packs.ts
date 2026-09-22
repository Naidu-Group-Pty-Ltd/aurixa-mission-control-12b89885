import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ensureTenant, jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { createHandoff, handoffUrl, storefrontPricingBase } from "@/server/billing-handoffs.server";
import { topupLinkFor } from "@/lib/storefront";

/**
 * GET /api/public/tokens/packs
 *
 * Returns the catalogue of active top-up packs the prime repo can surface
 * (e.g. inside its out-of-tokens banner). Optionally accepts ?tenant_ref=...
 * to also return a deep link into the CUSTOMER-FACING pricing page on the
 * Aurixa Systems website, pre-scoped to that tenant.
 *
 * When ?origin_user_id=... (and optionally origin_username / origin_source)
 * accompany tenant_ref, the deep link is minted as an attributed handoff
 * (`?h=<token>`) instead of a bare `?uid=` link, so pre-fetched topup CTAs in
 * the command centers carry the initiating user with zero extra round-trips
 * (user-attributed pricing workflow, Phase 2).
 *
 * This used to answer `<mission-control>/billing/topup?tenant=...` whenever
 * the handoff was not minted — a page behind an OPERATOR sign-in, offered to
 * a customer who has no Mission Control account and never will. Every reading
 * now names the storefront or is `null`, which every caller already resolves
 * to the storefront's own pricing page (the prime's banners do
 * `topupUrl || AURIXA_PRICING_URL`). See lib/storefront.ts.
 */
export const Route = createFileRoute("/api/public/tokens/packs")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "tokens:read",
          "tokens:meter",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        const rl = await checkRateLimit(key.id);
        if (!rl.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "rate_limited",
              count: rl.count,
              limit: rl.limit,
              retry_after_seconds: rl.retry_after_seconds,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(rl.retry_after_seconds),
                "X-RateLimit-Limit": String(rl.limit),
                "X-RateLimit-Remaining": "0",
              },
            },
          );
        }

        const url = new URL(request.url);
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 50) || 50));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);

        const {
          data: packs,
          count,
          error,
        } = await supabaseAdmin
          .from("topup_packs")
          .select("id, slug, name, tokens, price_cents, currency, expires_after_days", {
            count: "exact",
          })
          .eq("is_active", true)
          .order("tokens", { ascending: true })
          .range(offset, offset + limit - 1);
        if (error) return jsonResponse({ ok: false, error: error.message }, 500);

        const tenantRef = url.searchParams.get("tenant_ref");
        let topupUrl: string | null = null;
        if (tenantRef) {
          const tenant = await ensureTenant(
            key.clone_id,
            tenantRef,
            url.searchParams.get("display_name") ?? undefined,
          );
          if (tenant.ok) {
            const pricingBase = storefrontPricingBase();
            // Unattributed floor: the storefront, always. Scoped by the
            // tenant's operator-assigned billing id where it has one, and
            // browse-only where it does not — never a Mission Control page a
            // customer cannot sign in to, and never a purchase credential
            // belonging to somebody else. topupLinkFor carries why.
            topupUrl = topupLinkFor(pricingBase, tenant.billingUserId);

            // Attributed deep link: mint a handoff when the caller identifies
            // the initiating user. Falls back to the unattributed link above
            // if the mint fails — an unattributed CTA beats a broken one.
            const originUserId = url.searchParams.get("origin_user_id");
            if (originUserId && originUserId.length <= 200) {
              let cloneSlug: string | null = null;
              if (key.clone_id) {
                const { data: clone } = await supabaseAdmin
                  .from("clones")
                  .select("slug")
                  .eq("id", key.clone_id)
                  .maybeSingle();
                cloneSlug = clone?.slug ?? null;
              }
              const originSource =
                url.searchParams.get("origin_source")?.slice(0, 100) ||
                (key.clone_id ? `clone:${cloneSlug ?? key.clone_id}` : `prime:${tenantRef}`);
              const created = await createHandoff({
                cloneId: key.clone_id,
                tenantId: tenant.tenantId,
                originUserId,
                originUsername: url.searchParams.get("origin_username")?.slice(0, 200) ?? null,
                originSource,
                intent: "topup",
              });
              if (created.ok) {
                // Land on the customer-facing Aurixa Systems pricing page:
                // user-centric purchases never route through Mission Control.
                topupUrl = handoffUrl(pricingBase, created.id);
              }
            }
          }
        }

        const total = count ?? 0;
        return new Response(
          JSON.stringify({
            ok: true,
            packs: packs ?? [],
            topup_url: topupUrl,
            pagination: {
              limit,
              offset,
              total,
              has_more: offset + (packs?.length ?? 0) < total,
              next_offset: offset + (packs?.length ?? 0) < total ? offset + limit : null,
            },
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-RateLimit-Limit": String(rl.limit),
              "X-RateLimit-Remaining": String(Math.max(0, rl.limit - rl.count)),
              "X-Total-Count": String(total),
            },
          },
        );
      },
    },
  },
});
