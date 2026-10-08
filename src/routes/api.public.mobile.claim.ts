import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { claim } from "@/server/mobile/gateway.server";
import {
  mobileClientIp,
  mobileJson,
  mobileRefusal,
  readJsonObject,
} from "@/server/mobile/http.server";

/**
 * POST /api/public/mobile/claim
 *
 * The one request that spends an access link. The app sends the grant ref and
 * the fragment ticket (or, once bound, its gateway key) with its install id,
 * device thumbprint and PKCE challenge; Mission Control answers a 60-second
 * activation assertion the clone exchanges for its own native session, and a
 * signed workspace bootstrap naming which clone the app now belongs to.
 *
 * There is deliberately no GET: a link page, a prefetcher or a mail scanner
 * that follows the URL spends nothing (T55).
 */
export const Route = createFileRoute("/api/public/mobile/claim")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = await readJsonObject(request);
        if (!body) {
          return mobileJson(
            { ok: false, code: "INVALID_REQUEST", message: "This request is not a valid claim." },
            400,
          );
        }
        const answer = await claim(supabaseAdmin, body, mobileClientIp(request.headers));
        return answer.ok ? mobileJson(answer) : mobileRefusal(answer);
      },
    },
  },
});
