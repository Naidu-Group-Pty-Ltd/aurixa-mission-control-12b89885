import { createFileRoute } from "@tanstack/react-router";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { checkPublicRateLimit } from "@/server/token-rate-limit.server";
import { clientIpFrom } from "@/server/support-tickets.server";
import { readTrialOfferByCode } from "@/server/trial-offers.server";
import { normaliseOfferCode, websiteOfferStatus } from "@/lib/trialOffers.pure";

/**
 * GET /api/public/storefront/trial-offer?code=PARTNER-30
 *
 * What the website's free-trial page asks when a visitor arrives on a link
 * carrying `?trial=CODE`: is this a trial offer, and how long is it? The answer
 * is the code, the label and the number of days — nothing an admin wrote in an
 * offer's notes, nothing about who made it.
 *
 * A refusal names its reason (`unknown`, `retired`, `expired`) with 200, not
 * 404: the page shows the default trial either way and only needs to know
 * whether to say "this offer has ended". A failed read is 503, because a read
 * that failed is not a code that does not exist.
 *
 * Rate limited per address, because the endpoint answers whether a guessed
 * code exists. Codes are not secrets — they go on slides and in emails — but a
 * crawler enumerating them is not a visitor.
 */
const LOOKUPS_PER_MINUTE = 30;

export const Route = createFileRoute("/api/public/storefront/trial-offer")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      GET: async ({ request }) => {
        const rl = await checkPublicRateLimit(
          "storefront:trial-offer",
          clientIpFrom(request.headers),
          LOOKUPS_PER_MINUTE,
        );
        if (!rl.ok) {
          return storefrontJson(
            { ok: false, error: "rate_limited", retry_after_seconds: rl.retry_after_seconds },
            429,
          );
        }

        const code = normaliseOfferCode(new URL(request.url).searchParams.get("code"));
        if (!code.ok) return storefrontJson({ ok: false, reason: "unknown" });

        const read = await readTrialOfferByCode(code.code);
        if (!read.ok) {
          console.error("[trial-offer] read failed", read.error);
          return storefrontJson({ ok: false, error: "unavailable" }, 503);
        }

        const status = websiteOfferStatus(read.offer);
        if (status !== "accepted" || !read.offer) {
          return storefrontJson({ ok: false, reason: status });
        }
        return storefrontJson({
          ok: true,
          offer: {
            code: read.offer.code,
            label: read.offer.label,
            trial_days: read.offer.trial_days,
          },
        });
      },
    },
  },
});
