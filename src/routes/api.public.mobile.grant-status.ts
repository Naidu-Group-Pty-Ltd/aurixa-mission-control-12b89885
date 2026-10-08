import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  authenticateCloneMobileCredential,
  grantStatusForClone,
} from "@/server/mobile/gateway.server";
import { mobileJson, mobileRefusal, readJsonObject } from "@/server/mobile/http.server";

/**
 * POST /api/public/mobile/grant-status
 *
 * A clone's `mobile-auth-refresh` asks whether the grant a native session was
 * minted from still stands before it honours a refresh. A revoked grant or
 * device reads `revoked`; a grant belonging to another clone reads `unknown`,
 * exactly as one that does not exist. A failed read answers 503, which the
 * clone treats as "could not check" — never as "still good" past the access
 * token's lifetime (T63).
 */
export const Route = createFileRoute("/api/public/mobile/grant-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const caller = await authenticateCloneMobileCredential(
          supabaseAdmin,
          request.headers.get("authorization"),
        );
        if (!caller) {
          return mobileJson({ ok: false, code: "AUTH_REQUIRED", message: "Not authorised." }, 401);
        }
        const body = (await readJsonObject(request)) ?? {};
        const answer = await grantStatusForClone(
          supabaseAdmin,
          caller,
          body.grant_ref,
          body.install_id,
        );
        return answer.ok ? mobileJson(answer) : mobileRefusal(answer);
      },
    },
  },
});
