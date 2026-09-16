import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import {
  announcementsForClone,
  recordAnnouncementDeliveries,
} from "@/server/announcements.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";

/**
 * GET /api/public/clones/announcements
 *
 * What Mission Control wants this clone's dashboard to be showing. The server
 * decides everything — which notices are live, who they target, what they say
 * — and the clone renders the answer; it never derives one.
 *
 * ## What a clone is told, and what it is not
 *
 * The wire shape (`cloneAnnouncements.pure.ts`) carries the words to draw and
 * nothing else. Targeting never travels: a clone is not told which plans a
 * notice was scoped to, which other clones can see it, or that other clones
 * exist. Draft, scheduled, expired and archived rows never leave this server.
 *
 * ## The scope is deliberately wide
 *
 * The same list the gate route accepts, for the same reason: announcements
 * carry no secret — they are things the operator WANTS every matching
 * dashboard to display — and a key minted before any narrower scope existed
 * must not silence the fleet's announcement channel.
 *
 * ## Failure shape
 *
 * A failed read is 503, never an empty 200 — the clone's broker treats any
 * failure as "show nothing new", so the only cost of honesty here is
 * diagnosability, and a 200-with-empty would erase the difference between
 * "nothing to show" and "could not look".
 */
export const Route = createFileRoute("/api/public/clones/announcements")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "gate:read",
          "tokens:meter",
          "tokens:read",
          "seats:manage",
          "pricing:read",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        // Its own bucket, like the gate's: polling announcements must never
        // eat the token budget, and 120/min covers ~600 concurrent tabs at
        // the hook's five-minute cadence. A 429 fails soft on the clone —
        // the broker serves an empty list and the dashboard shows nothing.
        const rl = await checkRateLimit(key.id, 120, "announcements");
        if (!rl.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "rate_limited",
              retry_after_seconds: rl.retry_after_seconds,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(rl.retry_after_seconds),
              },
            },
          );
        }

        // A key with no clone is a Prime-scoped key. Announcements are the
        // operator talking to tenant workspaces; the prime is the operator's
        // own house, so it gets the same definite, empty answer forever.
        if (!key.clone_id) {
          return jsonResponse({ ok: true, announcements: [] });
        }

        const read = await announcementsForClone(key.clone_id);
        if (!read.ok) {
          return jsonResponse({ ok: false, error: "announcements_read_failed" }, 503);
        }

        // Best-effort, unawaited: a notice nobody's dashboard has fetched
        // must be distinguishable in the console from one that is working.
        recordAnnouncementDeliveries(
          key.clone_id,
          read.announcements.map((a) => ({ id: a.id, revision: a.revision })),
        ).catch(() => {});

        return jsonResponse({ ok: true, announcements: read.announcements });
      },
    },
  },
});
