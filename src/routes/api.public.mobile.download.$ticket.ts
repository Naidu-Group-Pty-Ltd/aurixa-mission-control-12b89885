import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { redeemDownloadTicket } from "@/server/mobile/releases.server";
import { mobileRefusal } from "@/server/mobile/http.server";

/**
 * GET /api/public/mobile/download/:ticket
 *
 * Redeems a download ticket with a 302 to a 60-second signed Storage URL. The
 * package bytes never pass through the Worker, and the bucket stays private:
 * the redirect target is useless a minute later. HEAD answers the same
 * redirect so a downloader can probe before it resumes with a Range request.
 */
async function redeem(ticket: string): Promise<Response> {
  const answer = await redeemDownloadTicket(supabaseAdmin, ticket);
  if (!answer.ok) return mobileRefusal(answer);
  return new Response(null, {
    status: 302,
    headers: {
      location: answer.url,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export const Route = createFileRoute("/api/public/mobile/download/$ticket")({
  server: {
    handlers: {
      GET: ({ params }) => redeem(params.ticket),
      HEAD: ({ params }) => redeem(params.ticket),
    },
  },
});
