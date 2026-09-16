import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { startHandoffCheckout, startUidCheckout } from "@/server/checkout.server";
import { normalizeBillingContact } from "@/server/billing-contact.server";
import { storefrontPricingBase } from "@/server/billing-handoffs.server";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { checkPublicRateLimit } from "@/server/token-rate-limit.server";

// A buyer clicks Buy a handful of times at most; the limit is set to leave
// real behaviour untouched while capping what one credential can mint.
const STOREFRONT_CHECKOUT_LIMIT = 12;

/**
 * POST /api/public/storefront/checkout
 *
 * Stripe checkout for the customer-facing Aurixa Systems pricing page. No
 * login. The purchase scope (clone/tenant) is pinned by one of two credentials
 * carried in the pricing-page link:
 *   • `h`   — a single-use, expiring, server-minted handoff token (burns on
 *             session creation; can restrict the item via its intent), or
 *   • `uid` — the operator-assigned, stable billing_user_id set on the clone
 *             in Mission Control.
 * Exactly one must be supplied. Success/cancel redirect back to the
 * STOREFRONT's own receipt pages (never Mission Control's UI), carrying the
 * (session_id, credential) pair the receipt endpoint requires.
 */
const Schema = z
  .object({
    h: z.string().uuid().optional(),
    uid: z.string().min(1).max(200).optional(),
    mode: z.enum(["topup", "seat_plan", "setup_package"]),
    item_id: z.string().uuid(),
    quantity: z.number().int().min(1).max(10).default(1),
    // Which price to charge. Annual is a separate Stripe price, so the
    // storefront has to say which one the buyer chose — otherwise the toggle
    // is cosmetic and every purchase bills monthly.
    period: z.enum(["monthly", "annual"]).default("monthly"),
    // Self-declared buyer details from the pricing page. Only ever used to
    // seed BLANK Stripe Customer fields (see billing-contact.server.ts), so a
    // public `uid` link cannot repoint an established billing email.
    contact: z
      .object({
        email: z.string().max(320).optional().nullable(),
        first_name: z.string().max(100).optional().nullable(),
        last_name: z.string().max(100).optional().nullable(),
        full_name: z.string().max(200).optional().nullable(),
        phone: z.string().max(40).optional().nullable(),
        company: z.string().max(200).optional().nullable(),
        // Business tax ID (ABN). Validated server-side; an invalid value is
        // dropped so Stripe Checkout asks the buyer for one instead.
        tax_id: z.string().max(50).optional().nullable(),
        tax_id_type: z.string().max(32).optional().nullable(),
      })
      .optional()
      .nullable(),
  })
  .refine((v) => !!v.h !== !!v.uid, {
    message: "exactly one of h or uid is required",
    path: ["h"],
  });

export const Route = createFileRoute("/api/public/storefront/checkout")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return storefrontJson({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) {
          return storefrontJson(
            { ok: false, error: "invalid_input", issues: parsed.error.issues },
            400,
          );
        }
        const data = parsed.data;

        // Rate limit before touching Stripe. A `uid` is deliberately a stable,
        // non-secret key carried in a pricing-page link, so possession of one
        // is not a scarce thing — and every accepted request here mints a
        // Stripe Checkout Session and may create a Customer. The sibling
        // `tokens.*`, `seats.*` and `billing.*` public routes all limit; this
        // family did not, and it is the family reachable with no secret at all.
        const rl = await checkPublicRateLimit(
          "storefront:checkout",
          data.h ?? data.uid ?? "",
          STOREFRONT_CHECKOUT_LIMIT,
        );
        if (!rl.ok) {
          return storefrontJson(
            {
              ok: false,
              error: "rate_limited",
              retry_after_seconds: rl.retry_after_seconds,
            },
            429,
          );
        }

        const url = new URL(request.url);
        const mcOrigin = process.env.PUBLIC_APP_URL ?? `${url.protocol}//${url.host}`;
        // Receipt credential travels back in the redirect: the same `h` or
        // `uid` the checkout was scoped to. The receipt endpoint re-checks it
        // against the session before returning any purchase data.
        const cred = data.h
          ? `h=${encodeURIComponent(data.h)}`
          : `uid=${encodeURIComponent(data.uid as string)}`;
        // When the storefront is configured, receipts render on its own
        // /pricing/success|cancel pages. The unconfigured fallback keeps the
        // flow working end-to-end via Mission Control's receipt pages (which
        // also accept the (session_id, credential) pair).
        const site = process.env.PUBLIC_PRICING_SITE_URL;
        const onStorefront = !!site && /^https?:\/\//.test(site);
        const pricingBase = storefrontPricingBase();
        const successUrl = onStorefront
          ? `${pricingBase}/success?${cred}&session_id={CHECKOUT_SESSION_ID}`
          : `${mcOrigin}/billing/success?${cred}&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = onStorefront
          ? `${pricingBase}/cancel?${cred}`
          : `${mcOrigin}/billing/cancel?${cred}`;

        try {
          const result = data.h
            ? await startHandoffCheckout({
                handoffId: data.h,
                mode: data.mode,
                itemId: data.item_id,
                quantity: data.quantity,
                period: data.period,
                successUrl,
                cancelUrl,
              })
            : await startUidCheckout({
                billingUserId: data.uid as string,
                mode: data.mode,
                itemId: data.item_id,
                quantity: data.quantity,
                period: data.period,
                successUrl,
                cancelUrl,
                // A handoff carries its own contact server-side; only the
                // uid path can be told anything by the browser.
                contact: normalizeBillingContact(data.contact),
              });
          if (!result.ok) return storefrontJson(result, 400);
          return storefrontJson({ ok: true, url: result.url, session_id: result.sessionId });
        } catch (err) {
          console.error("storefront checkout failed", err);
          return storefrontJson({ ok: false, error: "checkout_failed" }, 500);
        }
      },
    },
  },
});
