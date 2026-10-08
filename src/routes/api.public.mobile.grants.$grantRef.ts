import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { previewGrant } from "@/server/mobile/gateway.server";
import { mobileJson } from "@/server/mobile/http.server";

/**
 * GET /api/public/mobile/grants/:grantRef
 *
 * What the link page shows before anything is spent: the workspace's name and
 * the app it opens. It names no person. An unknown, revoked or unreadable
 * grant is one answer, so the endpoint cannot be used to tell them apart.
 */
export const Route = createFileRoute("/api/public/mobile/grants/$grantRef")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const answer = await previewGrant(supabaseAdmin, params.grantRef);
        if (!answer.ok) {
          return mobileJson(
            { ok: false, code: "NOT_FOUND", message: "This access link is not valid." },
            404,
          );
        }
        return mobileJson(answer);
      },
    },
  },
});
