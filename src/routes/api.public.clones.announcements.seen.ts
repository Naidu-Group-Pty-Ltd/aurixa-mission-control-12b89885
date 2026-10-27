import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { recordAnnouncementSeen } from "@/server/announcements.server";

/**
 * POST /api/public/clones/announcements/seen
 *
 * A member of a workspace's staff opened, dismissed or acknowledged a
 * message. Fetching proves a dashboard asked; this proves a person was in
 * front of it. Counted on the delivery stamp, never by name — Mission Control
 * does not record who read anything.
 *
 * The workspace sends it at most once per message revision per browser and
 * never waits on it; a refusal (the message is no longer live, or never
 * reached this workspace) is answered as one, so the console's count is only
 * ever made of messages a workspace could actually have shown.
 */
const Schema = z.object({
  announcement_id: z.string().uuid(),
});

export const Route = createFileRoute("/api/public/clones/announcements/seen")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = await resolveCloneApiKey(request.headers.get("x-clone-api-key"), [
          "gate:read",
          "tokens:meter",
          "tokens:read",
          "seats:manage",
          "pricing:read",
        ]);
        if (!key) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

        const rl = await checkRateLimit(key.id, 120, "announcements:seen");
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
          return jsonResponse({ ok: false, error: "invalid_input" }, 400);
        }

        const result = await recordAnnouncementSeen({
          keyCloneId: key.clone_id,
          announcementId: parsed.data.announcement_id,
        });
        if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status);
        return jsonResponse({ ok: true });
      },
    },
  },
});
