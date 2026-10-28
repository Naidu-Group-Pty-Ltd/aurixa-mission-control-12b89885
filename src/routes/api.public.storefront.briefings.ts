import { createFileRoute } from "@tanstack/react-router";
import { STOREFRONT_CORS, storefrontPreflight } from "@/server/storefront-cors.server";
import { listPublicListings } from "@/server/website-briefings.server";

/**
 * GET /api/public/storefront/briefings
 *
 * The Briefing Room listings the Aurixa Systems website builds its /watch
 * pages from (docs/WEBSITE_VIDEOS.md). Its build calls this before rendering
 * (`scripts/sync-briefings.ts` in aurixa-systems), keeps the listings that pass
 * its publishing rules, and keeps its committed snapshot if this answers
 * anything but `ok: true`.
 *
 * Public, like the catalogue: everything here is what the website itself
 * publishes. Premiere and published listings only; drafts and archived
 * listings never leave Mission Control, and a premiere carries no media.
 *
 * A failed read is a 503 with `ok: false`, never an empty list: the website
 * honours an empty list as "no videos", and a database blip must not take
 * every video off the site on the next deploy.
 */
export const Route = createFileRoute("/api/public/storefront/briefings")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      GET: async () => {
        const result = await listPublicListings();
        if (!result.ok) {
          console.error("[website-briefings] public listing read failed", result.error);
          return new Response(JSON.stringify({ ok: false, error: "briefings_unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json", ...STOREFRONT_CORS },
          });
        }
        return new Response(JSON.stringify({ ok: true, briefings: result.listings }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            // A build reads this once; a minute's cache keeps a burst of
            // builds from each reaching the database.
            "Cache-Control": "public, max-age=60",
            ...STOREFRONT_CORS,
          },
        });
      },
    },
  },
});
