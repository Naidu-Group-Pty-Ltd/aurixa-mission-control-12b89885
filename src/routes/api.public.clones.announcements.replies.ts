import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { jsonResponse, resolveCloneApiKey } from "@/server/clone-api-keys.server";
import { checkRateLimit } from "@/server/token-rate-limit.server";
import { postWorkspaceReply } from "@/server/announcements.server";

/**
 * POST /api/public/clones/announcements/replies
 *
 * A workspace's member answers a message Mission Control sent with replies
 * enabled. The answer is stored in that workspace's thread and the operators
 * are told; the response carries the thread as it now stands, so the
 * workspace can draw the reply without waiting for its next poll.
 *
 * ## Who the author is, and who decides it
 *
 * The workspace's own server (`mission-control-announcements`) verifies the
 * staff session and its Message Hub permission, and names the author from its
 * own user record. A browser never states who it is; it reaches this route
 * only through that relay, which alone holds the key.
 *
 * ## What a workspace may answer
 *
 * Only a live message that asked for replies AND reaches it, judged by the
 * matcher the list was served with (`replyRefusal`). Anything else is a 409
 * naming the reason, never a silent success: a reply that did not land must
 * say so, because the person typing it believes it did.
 */
const Schema = z.object({
  announcement_id: z.string().uuid(),
  body: z.string().trim().min(1).max(2000),
  client_request_id: z.string().uuid().optional().nullable(),
  author: z.object({
    ref: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().max(320).optional().nullable(),
    role: z.string().trim().max(60).optional().nullable(),
  }),
});

export const Route = createFileRoute("/api/public/clones/announcements/replies")({
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

        // Its own bucket: people typing replies must never eat the polling
        // budget, and thirty a minute is more than any workspace types.
        const rl = await checkRateLimit(key.id, 30, "announcements:replies");
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

        const result = await postWorkspaceReply({
          keyCloneId: key.clone_id,
          announcementId: parsed.data.announcement_id,
          body: parsed.data.body,
          author: parsed.data.author,
          clientRequestId: parsed.data.client_request_id ?? null,
        });
        if (!result.ok) return jsonResponse({ ok: false, error: result.error }, result.status);
        return jsonResponse({ ok: true, thread: result.thread });
      },
    },
  },
});
