import { createFileRoute } from "@tanstack/react-router";
import { STOREFRONT_CORS, storefrontPreflight } from "@/server/storefront-cors.server";
import { checkPublicRateLimit } from "@/server/token-rate-limit.server";
import { clientIpFrom } from "@/server/support-tickets.server";
import {
  buildAnnouncementFrom,
  listPublicListings,
  recordWebsiteBuildRead,
} from "@/server/website-briefings.server";

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
 *
 * A Vercel build says so (`X-Aurixa-Build-Env`, `X-Aurixa-Build-Id`), and the
 * read is recorded: that is how Website → Videos knows a rebuild ran, by its
 * effect, whatever Vercel answered the deploy hook. Recording is rate limited
 * per address; the listings are answered either way.
 */
const BUILD_READS_PER_MINUTE = 6;

async function noteBuildRead(request: Request, read: { ok: boolean; listings: number }) {
  const announcement = buildAnnouncementFrom(request.headers);
  if (!announcement) return;
  try {
    const rl = await checkPublicRateLimit(
      "storefront:briefings-build-read",
      clientIpFrom(request.headers),
      BUILD_READS_PER_MINUTE,
    );
    if (rl.ok) await recordWebsiteBuildRead(announcement, read);
  } catch (err) {
    // The build is owed its listings whether or not the read is recorded.
    console.error("[website-briefings] build read not recorded:", (err as Error).message);
  }
}
export const Route = createFileRoute("/api/public/storefront/briefings")({
  server: {
    handlers: {
      OPTIONS: async () => storefrontPreflight(),
      GET: async ({ request }) => {
        const result = await listPublicListings();
        await noteBuildRead(request, {
          ok: result.ok,
          listings: result.ok ? result.listings.length : 0,
        });
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
