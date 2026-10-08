import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { reconcileCloneMobileGateways } from "@/server/mobile/cloneMobileGateway.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron schedules a POST here every 30 min.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Runs `repairCloneMobileGateway` — the SAME function provisioning step 5h
// runs at birth — over every clone with a live backend. A clone born before
// the gateway existed converges through the identical path rather than a
// separate injection, and a clone whose birth step was interrupted is finished
// here. A second run over a converged fleet writes nothing (T66).
export const Route = createFileRoute("/hooks/mobile-gateway-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const result = await reconcileCloneMobileGateways(supabaseAdmin);
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "mobile gateway reconcile failed";
          console.error("mobile gateway reconcile failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
