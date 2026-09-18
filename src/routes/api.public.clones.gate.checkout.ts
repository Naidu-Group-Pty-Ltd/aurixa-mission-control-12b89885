import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { mintGateActivationCheckout } from "@/server/gateCheckout.server";

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
 * here and drift there. `mintGateActivationCheckout` resolves all three from
 * the gate row the platform already wrote at provisioning, so the button
 * charges exactly what the clone was armed for.
 *
 * ## Authentication is all this route adds
 *
 * The act itself — which catalogue row the plan means, whether the money can
 * open the gate at all, where Stripe returns the buyer — lives in
 * `gateCheckout.server.ts`, because an operator mints the same thing from the
 * Payment Gates page and two implementations of a payment is how one of them
 * comes to be wrong. What belongs here is the clone key, its scopes, the rate
 * limit, and mapping the refusal onto a status. Everything the caller is told,
 * including the fallback pricing URL and what it means for that URL to be
 * absent, is decided there.
 */
const Schema = z.object({
  /** Where Stripe returns the buyer. Must be an https URL; anything else falls
   *  back to the clone's own deploy URL and then to the pricing site. */
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
        const rl = await checkRateLimit(key.id, 12, "gate:checkout");
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

        const result = await mintGateActivationCheckout({
          cloneId: key.clone_id,
          returnUrl: parsed.data.return_url ?? null,
          contact: parsed.data.contact ?? null,
          origin: "clone_cta",
        });

        if (result.ok) {
          return jsonResponse({ ok: true, url: result.url, session_id: result.sessionId });
        }

        // `pricing_url` is omitted rather than nulled when there is none, so a
        // client reading `typeof body.pricing_url === "string"` sees the same
        // absence it always has.
        return jsonResponse(
          {
            ok: false,
            error: result.error,
            ...(result.detail ? { detail: result.detail } : {}),
            ...(result.pricingUrl ? { pricing_url: result.pricingUrl } : {}),
          },
          result.status,
        );
      },
    },
  },
});
