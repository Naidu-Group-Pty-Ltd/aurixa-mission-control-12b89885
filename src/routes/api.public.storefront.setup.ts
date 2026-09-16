import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { startHandoffCardSetup, startUidCardSetup } from "@/server/checkout.server";
import { normalizeBillingContact } from "@/server/billing-contact.server";
import { storefrontPricingBase } from "@/server/billing-handoffs.server";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { checkPublicRateLimit } from "@/server/token-rate-limit.server";

// A buyer clicks Buy a handful of times at most; the limit is set to leave
// real behaviour untouched while capping what one credential can mint.
const STOREFRONT_CHECKOUT_LIMIT = 12;

/**
 * POST /api/public/storefront/setup
 *
 * Saves a card for later (wallet flow) via Stripe Checkout in `setup` mode —
 * the storefront sibling of /api/public/storefront/checkout. Card details are
 * entered on Stripe's hosted page and never touch Aurixa infrastructure; the
 * platform webhook persists the resulting payment-method reference (brand /
 * last4 / expiry only) against the tenant's wallet, capped at 3 cards
 * (primary / secondary / backup).
 *
 * Credentials are identical to checkout: exactly one of `h` (single-use
 * handoff) or `uid` (stable billing_user_id).
 */
const Schema = z
  .object({
    h: z.string().uuid().optional(),
    uid: z.string().min(1).max(200).optional(),
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

export const Route = createFileRoute("/api/public/storefront/setup")({
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
          "storefront:setup",
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
        const cred = data.h
          ? `h=${encodeURIComponent(data.h)}`
          : `uid=${encodeURIComponent(data.uid as string)}`;
        const site = process.env.PUBLIC_PRICING_SITE_URL;
        const onStorefront = !!site && /^https?:\/\//.test(site);
        const pricingBase = storefrontPricingBase();
        // The storefront's card-saved page polls the wallet endpoint with the
        // same (session_id, credential) pair the receipt flow uses.
        const successUrl = onStorefront
          ? `${pricingBase}/card-saved?${cred}&session_id={CHECKOUT_SESSION_ID}`
          : `${mcOrigin}/billing/success?${cred}&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = onStorefront
          ? `${pricingBase}/cancel?${cred}`
          : `${mcOrigin}/billing/cancel?${cred}`;

        try {
          const result = data.h
            ? await startHandoffCardSetup({ handoffId: data.h, successUrl, cancelUrl })
            : await startUidCardSetup({
                billingUserId: data.uid as string,
                successUrl,
                cancelUrl,
                contact: normalizeBillingContact(data.contact),
              });
          if (!result.ok) return storefrontJson(result, 400);
          return storefrontJson({ ok: true, url: result.url, session_id: result.sessionId });
        } catch (err) {
          console.error("storefront card setup failed", err);
          return storefrontJson({ ok: false, error: "setup_failed" }, 500);
        }
      },
    },
  },
});
