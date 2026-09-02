import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 30 minutes.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Applies each clone's OWN authorised credential forwards — the per-clone
// counterpart to `prime_secret_forwards`, which is fleet policy applied at
// provisioning time only. A row in `clone_secret_forwards` IS the
// authorisation, so applying it should not depend on somebody remembering to
// press a button, and a clone provisioned before the row existed is covered
// at all only because of this.
//
// It settles: the ledger is the filter, so once a clone holds its authorised
// names every pass is two reads and no Management API calls. A `failed` row
// is deliberately NOT filtered out — that is the state a retry is for.
//
// It can only ever write to a clone. The ref comes from
// `resolveCloneSecretTarget`, which refuses the prime's project, refuses
// Mission Control's own, and refuses when it cannot tell which is which. What
// may travel at all is `cloneSecretForward.pure.ts`, and a class refusal
// there (a signing key, a CAPTCHA half) outranks every row.
export const Route = createFileRoute("/hooks/clone-secret-forward-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { reconcileCloneSecretForwards } = await import(
            "@/server/cloneSecretForward.server"
          );
          const report = await reconcileCloneSecretForwards(supabaseAdmin);

          // Only a breadcrumb when the run did something or refused. A job
          // that files an identical row every half hour is one people stop
          // reading, and this one settles.
          if (report.pushed || report.refused.length) {
            await writeAuditLog({
              action: "clone_secret_forward_reconcile_cron",
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
          const message = e instanceof Error ? e.message : "secret forward reconcile failed";
          console.error("[hooks/clone-secret-forward-reconcile]", message);
          await writeAuditLog({
            action: "clone_secret_forward_reconcile_cron",
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
