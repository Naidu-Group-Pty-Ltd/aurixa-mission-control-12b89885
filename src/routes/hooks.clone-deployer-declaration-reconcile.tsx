import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 30 minutes.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Keeps `BACKEND_DEPLOYED_BY` declared on every clone repository, so a clone's
// own deploy workflow stands down instead of going red on every push that
// touches a function.
//
// It exists because that declaration used to be an ACT — written on
// provisioning, on cascade, and otherwise by a button an operator had to find.
// A clone whose write was refused, because the App lacked `variables: write`
// until somebody granted it, had no way back except the next cascade or
// remembering to click. A declaration nothing keeps true drifts, and its drift
// reads as a red check people learn to ignore.
//
// There is no "off" position, and that is a property of the workflow rather
// than a simplification here: its stand-down step requires no deploy token to
// be present, so a tenant whose CI holds a scoped token deploys exactly as it
// would have, declared or not.
//
// It settles. Once a repository says it, a pass is one variable listing and no
// write, so a quiet fleet files no audit row at all — see `sweepIsNoteworthy`.
export const Route = createFileRoute("/hooks/clone-deployer-declaration-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { reconcileCloneDeployerDeclarations } = await import(
            "@/server/cloneDeployerDeclaration.server"
          );
          const { sweepIsNoteworthy } = await import("@/server/cloneDeployerDeclaration.pure");
          const report = await reconcileCloneDeployerDeclarations(supabaseAdmin);

          if (sweepIsNoteworthy(report)) {
            await writeAuditLog({
              action: "clone_deployer_declaration_reconcile_cron",
              entityType: "cron",
              metadata: report as unknown as Record<string, unknown>,
            });
          }

          // 200 with the refusals in the body rather than 500: a repository
          // Mission Control may not write is a state, not a failed run.
          return new Response(JSON.stringify({ success: true, ...report }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "deployer declaration reconcile failed";
          console.error("[hooks/clone-deployer-declaration-reconcile]", message);
          await writeAuditLog({
            action: "clone_deployer_declaration_reconcile_cron",
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
