import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requestMagicLink } from "@/server/mobile/gateway.server";
import {
  mobileClientIp,
  mobileJson,
  mobileRefusal,
  readJsonObject,
} from "@/server/mobile/http.server";

/**
 * POST /api/public/mobile/magic-link
 *
 * The self-service form on the gateway's front page. The answer is the same
 * sentence whether the email has access, has none, or the workspace does not
 * exist (T58); only a malformed request or a rate limit reads differently,
 * and neither depends on who the email belongs to.
 */
export const Route = createFileRoute("/api/public/mobile/magic-link")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readJsonObject(request);
        const answer = await requestMagicLink(supabaseAdmin, {
          email: typeof body?.email === "string" ? body.email : "",
          workspace: typeof body?.workspace === "string" ? body.workspace : "",
          portal: typeof body?.portal === "string" ? body.portal : null,
          ip: mobileClientIp(request.headers),
        });
        return answer.ok ? mobileJson(answer) : mobileRefusal(answer);
      },
    },
  },
});
