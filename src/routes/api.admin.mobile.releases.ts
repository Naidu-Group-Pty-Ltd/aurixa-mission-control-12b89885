import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  authenticateReleaseCi,
  markUploaded,
  registerRelease,
} from "@/server/mobile/releases.server";
import { mobileJson, mobileRefusal, readJsonObject } from "@/server/mobile/http.server";

/**
 * POST /api/admin/mobile/releases
 *
 * The release workflow's only door, on `MC_RELEASE_CI_TOKEN`.
 *
 * - `{ "op": "register", ...descriptor }` registers a CANDIDATE and hands back
 *   a one-use signed upload URL for the package. Re-registering the same build
 *   with the same SHA-256 is idempotent; a different package for a build
 *   number already used is refused.
 * - `{ "op": "uploaded", "release_id": … }` checks the object landed at the
 *   declared size and stamps it.
 *
 * CI can never approve or promote: those are operator acts in the console,
 * with an audit row, so a compromised workflow can stage a candidate and
 * nothing more.
 */
export const Route = createFileRoute("/api/admin/mobile/releases")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = authenticateReleaseCi(request.headers.get("authorization"));
        if (!auth.ok) return mobileRefusal(auth);
        const body = await readJsonObject(request);
        if (!body) {
          return mobileJson({ ok: false, code: "INVALID_REQUEST", message: "Expected JSON." }, 400);
        }
        const { op, ...rest } = body;
        if (op === "register") {
          const answer = await registerRelease(supabaseAdmin, rest);
          return answer.ok ? mobileJson(answer) : mobileRefusal(answer);
        }
        if (op === "uploaded") {
          if (typeof rest.release_id !== "string") {
            return mobileJson(
              { ok: false, code: "INVALID_REQUEST", message: "release_id is required." },
              400,
            );
          }
          const answer = await markUploaded(supabaseAdmin, rest.release_id);
          return answer.ok ? mobileJson(answer) : mobileRefusal(answer);
        }
        return mobileJson(
          { ok: false, code: "INVALID_REQUEST", message: "op must be register or uploaded." },
          400,
        );
      },
    },
  },
});
