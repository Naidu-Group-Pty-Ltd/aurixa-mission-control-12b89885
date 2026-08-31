import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { startCheckoutCore } from "@/server/checkout.server";
import { resolveCloneBillingTenant } from "@/server/billing-tenant.server";
import { normalizeBillingContact } from "@/server/billing-contact.server";
import { factsOf, logGateEvent, readGate } from "@/server/payment-gate.server";
import { resolveGateState } from "@/lib/clonePaymentGate.pure";
import { storefrontPricingBase } from "@/server/billing-handoffs.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { seatPlanForTier } from "@/lib/pricing/seatPlanForTier.pure";

/**
 * POST /api/public/clones/gate/checkout
 *
 * The activation CTA's destination: one click in a locked workspace, one
 * Stripe-hosted page, money to Aurixa Systems, gate opens.
 *
 * ## Why a route and not a link
 *
 * The clone knows its API key and nothing else. Left to build its own link it
 * would have to know a plan id, a price and a tenant — three facts that live
 * here and drift there. This resolves all three from the gate row the platform
 * already wrote at provisioning, so the button charges exactly what the clone
 * was armed for.
 *
 * ## What it will not do
 *
 * It refuses on a gate that is already paid. Minting a second subscription
 * checkout for a workspace that has one is how a customer ends up paying
 * twice, and a CTA is the one place that is easy to click again.
 */
const Schema = z.object({
  /** Where Stripe returns the buyer. Must be an https URL on the clone's own
   *  origin; anything else falls back to the pricing site's receipt pages. */
  return_url: z.string().url().max(2000).optional().nullable(),
  contact: z
    .object({
      email: z.string().max(320).optional().nullable(),
      first_name: z.string().max(100).optional().nullable(),
      last_name: z.string().max(100).optional().nullable(),
      full_name: z.string().max(200).optional().nullable(),
      phone: z.string().max(40).optional().nullable(),
      company: z.string().max(200).optional().nullable(),
    })
    .optional()
    .nullable(),
});

/** https only, and no credentials in the URL. A return URL is handed to Stripe
 *  and then to a browser, so it is an open-redirect surface. */
function safeReturnUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/public/clones/gate/checkout")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "gate:read",
          "tokens:meter",
          "seats:manage",
          "pricing:read",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);
        if (!key.clone_id) return jsonResponse({ ok: false, error: "not_a_clone_key" }, 400);

        // A checkout mints a Stripe Session and may create a Customer. Held to
        // the same limit as the storefront's own checkout for the same reason.
        const rl = await checkRateLimit(`gate:checkout:${key.id}`, 12);
        if (!rl.ok) {
          return jsonResponse(
            { ok: false, error: "rate_limited", retry_after_seconds: rl.retry_after_seconds },
            429,
          );
        }

        let body: unknown = {};
        try {
          const text = await request.text();
          body = text ? JSON.parse(text) : {};
        } catch {
          return jsonResponse({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) {
          return jsonResponse(
            { ok: false, error: "invalid_input", issues: parsed.error.issues },
            400,
          );
        }

        const read = await readGate(key.clone_id);
        if (!read.ok) return jsonResponse({ ok: false, error: "gate_read_failed" }, 503);
        if (!read.row) return jsonResponse({ ok: false, error: "not_gated" }, 404);
        if (read.row.paid_at) {
          return jsonResponse({ ok: false, error: "already_paid" }, 409);
        }
        if (!read.row.plan_slug) {
          return jsonResponse({ ok: false, error: "no_plan_on_gate" }, 409);
        }

        // The Stripe-facing catalogue row for the gate's plan.
        //
        // NOT `WHERE slug = plan_slug`. The catalogue reuses rows through the
        // tier rename — `professional` becomes Growth and `growth` becomes
        // Scale — so a row called `growth` exists on both sides of the cutover
        // and is a DIFFERENT tier in each. A naive slug match would quote a
        // Growth customer $860 and charge them Scale's $2,015.
        // `seatPlanForTier` settles that the same way the catalogue sync does,
        // and then refuses any row whose price disagrees with what this gate
        // quoted — because the settling rule is inference about a cutover this
        // request cannot observe, and the cost of inferring wrong is a
        // customer charged more than twice what they agreed to.
        const { data: planRows, error: planError } = await supabaseAdmin
          .from("seat_plans")
          .select("id, slug, name, is_active, stripe_price_id, price_cents");
        if (planError) return jsonResponse({ ok: false, error: "plan_lookup_failed" }, 503);

        const match = seatPlanForTier(
          read.row.plan_slug,
          (planRows ?? []).filter((r) => r.is_active),
          read.row.amount_due_cents,
        );
        if (!match.ok) {
          console.error("[gate] no purchasable plan row for this gate", {
            clone_id: key.clone_id,
            plan_slug: read.row.plan_slug,
            reason: match.reason,
            quoted_cents: read.row.amount_due_cents,
            row_cents: match.reason === "price_mismatch" ? match.rowCents : undefined,
          });
          // Not the customer's problem and not something they can retry — send
          // them to the pricing page, where a person chooses and sees the
          // number before paying it.
          return jsonResponse(
            {
              ok: false,
              error: "plan_not_purchasable",
              detail: match.reason,
              pricing_url: storefrontPricingBase(),
            },
            409,
          );
        }
        const plan = match.row;

        if (!plan.stripe_price_id) {
          // Not the customer's problem and not something they can retry — send
          // them to the pricing page, which can always take a payment.
          return jsonResponse(
            {
              ok: false,
              error: "plan_not_purchasable",
              pricing_url: storefrontPricingBase(),
            },
            409,
          );
        }

        const { data: clone } = await supabaseAdmin
          .from("clones")
          .select("id, name, slug, billing_user_id, deploy_url")
          .eq("id", key.clone_id)
          .maybeSingle();

        const tenant = await resolveCloneBillingTenant(key.clone_id, {
          billingUserId: clone?.billing_user_id ?? null,
          fallbackExternalRef: `clone:${clone?.slug ?? key.clone_id}`,
          fallbackDisplayName: clone?.name ?? null,
        });
        if (!tenant.ok) return jsonResponse({ ok: false, error: tenant.error }, 500);

        const back = safeReturnUrl(parsed.data.return_url) ?? clone?.deploy_url ?? null;
        const pricingBase = storefrontPricingBase();
        // Success returns the buyer to their own workspace where possible: the
        // gate they were blocked by is the thing they want to see open. The
        // pricing site's receipt page is the fallback.
        const successUrl = back
          ? `${back}${back.includes("?") ? "&" : "?"}activation=success&session_id={CHECKOUT_SESSION_ID}`
          : `${pricingBase}/success?session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = back
          ? `${back}${back.includes("?") ? "&" : "?"}activation=cancelled`
          : `${pricingBase}/cancel`;

        try {
          const result = await startCheckoutCore({
            mode: "seat_plan",
            itemId: plan.id,
            quantity: 1,
            period: "monthly",
            cloneId: key.clone_id,
            tenantId: tenant.tenantId,
            successUrl,
            cancelUrl,
            contact: normalizeBillingContact(parsed.data.contact),
            attribution: {
              originUserId: clone?.billing_user_id ?? key.clone_id,
              originUsername: clone?.name ?? null,
              // Distinct from `storefront_uid`: this purchase started inside a
              // locked workspace, which is worth being able to count.
              originSource: "activation_gate",
              handoffId: null,
            },
          });
          if (!result.ok) return jsonResponse(result, 400);

          await logGateEvent({
            gateId: read.row.id,
            cloneId: key.clone_id,
            kind: "checkout_started",
            statusBefore: resolveGateState(factsOf(read.row)).status,
            statusAfter: resolveGateState(factsOf(read.row)).status,
            reason: "Activation checkout started from the locked workspace",
            actor: "system",
            metadata: { session_id: result.sessionId, plan_slug: plan.slug },
          });

          return jsonResponse({ ok: true, url: result.url, session_id: result.sessionId });
        } catch (err) {
          console.error("[gate] activation checkout failed", err);
          return jsonResponse(
            { ok: false, error: "checkout_failed", pricing_url: pricingBase },
            500,
          );
        }
      },
    },
  },
});
