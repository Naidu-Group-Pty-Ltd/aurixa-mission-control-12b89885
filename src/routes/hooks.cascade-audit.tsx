import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every fifteen minutes.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// THE CONVERGENCE AUDITOR. It compares prime's tree with each clone's tree
// through the engine's own exclusion partition, and writes down what the
// cascade would still owe that clone if you asked it to run right now.
//
// It exists because every other reading of "is this clone in sync" is derived
// from the ledger the actor wrote — sync_status <- commits_behind <-
// last_synced_sha <- the merge drain <- the engine — so a wrong actor produces
// a reading wrong in the same direction. It is also the only reading that can
// see divergence no cascade event ever created: a force-push, a reverted
// merge, an exclusion that grew too broad, an edit made directly on a clone.
//
// It acts on NOTHING. No cascade is queued, no pointer is moved, no
// notification is raised. Step 1 of the shipping order in
// CASCADE_PIPELINE_HEALTH.md writes observations only, so a wrong reading
// costs nothing while it runs beside the existing signals and is compared
// against them. The escalation that replaces `drift_high` reads this table and
// ships separately.
//
// The response body is the diagnostic ledger, in the shape the cascade drain
// already uses: pg_cron records what it DELIVERED, never what happened, so the
// tick's own body is where a misbehaving pass is read from.
export const Route = createFileRoute("/hooks/cascade-audit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          // Yields below the scan floor. This is observability: a convergence
          // number taken at the cost of the cascade that would have fixed it
          // is a measurement that made the thing it measures worse, and the
          // next run takes the reading instead.
          const { decideSpend } = await import("@/server/cascade/githubBudget.pure");
          const { readGitHubRemaining } = await import("@/server/githubAllowance.server");
          const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
          if (!spend.proceed) {
            return new Response(JSON.stringify({ success: true, skipped: spend.why }), {
              headers: { "Content-Type": "application/json" },
            });
          }

          const { auditFleetConvergence } = await import("@/server/convergenceAudit.server");
          const report = await auditFleetConvergence(supabaseAdmin);

          // A run-level audit row only when the fleet is not simply
          // converging. A sweep that files an identical "3 converged" row four
          // times an hour is how an audit log stops being read — which is the
          // defect this whole area exists to remove, not one to repeat.
          if (report.stalled > 0 || report.fallingBehind > 0 || report.unknown > 0) {
            await writeAuditLog({
              action: "cascade_convergence_audit",
              entityType: "cron",
              metadata: report as unknown as Record<string, unknown>,
            });
          }

          return new Response(JSON.stringify({ success: true, ...report }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Convergence audit failed";
          console.error("[hooks/cascade-audit]", message);
          await writeAuditLog({
            action: "cascade_convergence_audit",
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
