import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { storefrontJson, storefrontPreflight } from "@/server/storefront-cors.server";
import { checkPublicRateLimit } from "@/server/token-rate-limit.server";
import { clientIpFrom } from "@/server/support-tickets.server";
import { verifyUploadGrant } from "@/server/website-briefings.server";

/**
 * POST /api/public/storefront/briefing-upload-grant   { token, paths }
 *
 * Asked by the website's `briefing-upload-sign` function before it signs an
 * upload of a Briefing Room video into its own bucket (docs/WEBSITE_VIDEOS.md).
 * The token is a single-use grant an admin's upload minted in Mission Control
 * for one listing's next version folder; the answer is that folder, and only
 * when the token is live and every path asked for was granted.
 *
 * Authorised by possession of the token, as a storefront handoff is: the
 * website holds no secret of Mission Control's and Mission Control none of the
 * website's. Rate limited per address, because the endpoint answers whether a
 * guessed token exists.
 */
const Body = z.object({
  token: z.string().min(20).max(200),
  paths: z.array(z.string().max(200)).min(1).max(200),
});

export const Route = createFileRoute("/api/public/storefront/briefing-upload-grant")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      POST: async ({ request }) => {
        const rl = await checkPublicRateLimit(
          "storefront:briefing-upload-grant",
          clientIpFrom(request.headers),
          120,
        );
        if (!rl.ok) {
          return storefrontJson(
            { ok: false, error: "rate_limited", retry_after_seconds: rl.retry_after_seconds },
            429,
          );
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return storefrontJson({ ok: false, error: "invalid_json" }, 400);
        }
        const parsed = Body.safeParse(body);
        if (!parsed.success) return storefrontJson({ ok: false, error: "invalid_input" }, 400);

        const grant = await verifyUploadGrant(parsed.data);
        if (!grant.ok) return storefrontJson({ ok: false, error: grant.error }, grant.status);
        return storefrontJson({ ok: true, prefix: grant.prefix });
      },
    },
  },
});
