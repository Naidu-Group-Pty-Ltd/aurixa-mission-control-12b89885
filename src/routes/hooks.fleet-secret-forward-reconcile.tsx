import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. Auth: the shared CRON_SECRET as a Bearer token.
//
// Applies FLEET policy — `prime_secret_forwards` — to clones that already
// exist. `runBackendProvisioning` reads that table and nothing else does, so
// a name marked `inherit` has always reached every future clone and no
// current one, while the per-clone sweep beside this reports the same name as
// `already_fleet_wide`: accurate about provisioning, wrong about the fleet.
//
// The only remedy before this was a whole-engine convergence pass, which is
// refused unless the backend is `ready` and costs vendor calls and minutes
// against a live tenant — to deliver a handful of environment variables.
//
// It settles: the ledger is the filter, so once a clone holds fleet policy
// every pass is two reads and no Management API calls. A `failed` row is
// deliberately NOT filtered out — that is the state a retry is for.
//
// It can only ever write to a clone. The ref comes from
// `resolveCloneSecretTarget`, which refuses the prime's project, refuses
// Mission Control's own, and refuses when it cannot tell which is which. The
// class refusals are the same FUNCTION the per-clone path uses, not a second
// copy of them.
export const Route = createFileRoute("/hooks/fleet-secret-forward-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { reconcileFleetSecretForwards } =
            await import("@/server/fleetSecretForward.server");
          const report = await reconcileFleetSecretForwards(supabaseAdmin);

          // Only a breadcrumb when the run did something or could not. A name
          // that is fleet policy with no value behind it is filed too: it
          // reads as healthy at every other surface, which is what made the
          // gap this hook closes invisible in the first place.
          if (report.pushed || report.refused.length || report.withoutValue.length) {
            await writeAuditLog({
              action: "fleet_secret_forward_reconcile_cron",
              entityType: "cron",
              metadata: report as unknown as Record<string, unknown>,
            });
          }

          // 200 with the refusals in the body rather than 500: one clone whose
          // project cannot be resolved is a state, not a failed run.
          return new Response(JSON.stringify({ success: true, ...report }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "fleet secret forward reconcile failed";
          console.error("[hooks/fleet-secret-forward-reconcile]", message);
          await writeAuditLog({
            action: "fleet_secret_forward_reconcile_cron",
            entityType: "cron",
            metadata: { error: message },
          });
          return new Response(JSON.stringify({ success: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
