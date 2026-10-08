import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { issueGatewayDownloadTicket } from "@/server/mobile/releases.server";
import {
  mobileClientIp,
  mobileJson,
  mobileRefusal,
  readJsonObject,
} from "@/server/mobile/http.server";

/**
 * POST /api/public/mobile/download-request
 *
 * The link page's "Install app" button, for a phone that does not have the
 * app yet. The activation ticket is shown, not spent: the same link still has
 * to be opened in the app to claim. Answers a ten-minute download URL.
 */
export const Route = createFileRoute("/api/public/mobile/download-request")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readJsonObject(request);
        const answer = await issueGatewayDownloadTicket(supabaseAdmin, {
          grant_ref: body?.grant_ref,
          ticket: body?.ticket,
          ip: mobileClientIp(request.headers),
        });
        return answer.ok ? mobileJson(answer) : mobileRefusal(answer);
      },
    },
  },
});
