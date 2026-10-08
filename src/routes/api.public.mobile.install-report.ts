import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { authenticateCloneMobileCredential } from "@/server/mobile/gateway.server";
import { recordInstallReport } from "@/server/mobile/releases.server";
import { mobileJson, mobileRefusal, readJsonObject } from "@/server/mobile/http.server";

/**
 * POST /api/public/mobile/install-report
 *
 * Adoption: what an installation is running, and whether an update it was
 * offered installed, failed or was blocked. Relayed by the clone on the
 * `mmc_` credential; Mission Control's release console reads it.
 */
export const Route = createFileRoute("/api/public/mobile/install-report")({
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
        const answer = await recordInstallReport(supabaseAdmin, caller, {
          portal: body.portal,
          platform: body.platform,
          install_id: body.install_id,
          build_number: body.build_number,
          outcome: body.outcome,
          release_id: body.release_id,
          detail: body.detail,
        });
        return answer.ok ? mobileJson(answer) : mobileRefusal(answer);
      },
    },
  },
});
