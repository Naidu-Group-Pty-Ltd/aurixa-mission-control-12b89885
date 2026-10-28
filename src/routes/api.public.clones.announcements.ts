import { createFileRoute } from "@tanstack/react-router";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import {
  announcementsForWorkspace,
  recordAnnouncementDeliveries,
  recordAnnouncementWithdrawals,
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
 * Where a message takes replies, the workspace is served its OWN thread and
 * nobody else's.
 *
 * ## The prime is a workspace
 *
 * A key with no clone is the prime's. Until 27 Oct 2026 it was answered an
 * empty list forever, on the reasoning that the prime is the operator's own
 * house — and so the dashboard the operator's own staff work in, polling 181
 * times a day, was never shown a single message. It is now served as the
 * workspace `PRIME_WORKSPACE_ID`, with no plan: it receives what is addressed
 * to every workspace or to it by name, and nothing scoped to a plan.
 *
 * ## The scope is deliberately wide
 *
 * The same list the gate route accepts, for the same reason: announcements
 * carry no secret — they are things the operator WANTS every matching
 * dashboard to display — and a key minted before any narrower scope existed
 * must not silence the fleet's announcement channel.
 *
 * ## How fast a dashboard hears
 *
 * Mission Control signals each workspace a change reaches the moment it is
 * made (`workspaceSignal.pure.ts`), and the dashboards there ask this route
 * at once. A scheduled message needs no signal at its start: the answer
 * carries `nextChangeAt`, the next moment this workspace's notices change by
 * themselves, and an open dashboard asks again then.
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
        // eat the token budget. A dashboard asks every two minutes while
        // Mission Control's signal reaches it (every one while it does not),
        // and once per signal, spread over a second or so — 120/min covers
        // well over a hundred open tabs on one key. A 429 fails soft on the
        // workspace: its relay marks the read unavailable, and the dashboard
        // keeps the notices it is already showing.
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

        const read = await announcementsForWorkspace(key.clone_id);
        if (!read.ok) {
          return jsonResponse({ ok: false, error: "announcements_read_failed" }, 503);
        }

        // A notice nobody's dashboard has fetched must be distinguishable in
        // the console from one that is working. Awaited, because a Worker may
        // cancel what is still pending once the response is returned; never
        // allowed to fail the answer, because the stamp is observability.
        if (read.workspaceId) {
          await recordAnnouncementDeliveries(
            read.workspaceId,
            read.announcements.map((a) => ({ id: a.id, revision: a.revision })),
          ).catch((err) => console.error("[announcements] delivery stamp threw", err));
          // And a recalled message this answer no longer holds is withdrawn
          // here: the console's "withdrawn from N of M" is read from this.
          await recordAnnouncementWithdrawals(read.workspaceId).catch((err) =>
            console.error("[announcements] withdrawal stamp threw", err),
          );
        }

        // `nextChangeAt` and `serverTime` let an open dashboard ask again at
        // the exact moment a scheduled message goes live or a live one ends,
        // measured against this server's clock rather than the browser's.
        return jsonResponse({
          ok: true,
          announcements: read.announcements,
          nextChangeAt: read.nextChangeAt,
          serverTime: new Date().toISOString(),
        });
      },
    },
  },
});
