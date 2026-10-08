import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authenticateCloneMobileCredential } from "@/server/mobile/gateway.server";
import { currentReleaseForClone } from "@/server/mobile/releases.server";
import { mobileJson, mobileRefusal, readJsonObject } from "@/server/mobile/http.server";

/**
 * POST /api/public/mobile/releases/current
 *
 * A clone's `mobile-release` function asks, on behalf of one installation,
 * what it should run. Authenticated by the clone's `mmc_` credential, which is
 * minted at birth, so every clone has this connection from its first minute.
 * The answer is a manifest signed with the release key: the app trusts
 * nothing outside its signed payload, so the clone in between cannot alter it.
 */
export const Route = createFileRoute("/api/public/mobile/releases/current")({
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
        const answer = await currentReleaseForClone(supabaseAdmin, caller, {
          portal: body.portal,
          platform: body.platform,
          install_id: body.install_id,
          installed_build: body.installed_build,
        });
        return answer.ok ? mobileJson(answer) : mobileRefusal(answer);
      },
    },
  },
});
