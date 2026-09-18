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
// The same tick then classifies WHY any clone is not converging into
// `clone_sync_blockages` — every reason with a class, an owner and a clock,
// because a blockage may be silent or permanent but never both. That half
// reads Mission Control's own tables only and spends no GitHub budget.
//
// The custodian then runs on that ledger. It may RE-RUN work — a stale URL, an
// unseeded policy, a retired delivery — and it may never change a verdict: a
// red check is the gate working, and no amount of retrying substitutes for
// somebody changing the code. One act is switched on today, and every act it
// takes, would take or refuses is written to `clone_custodial_acts` with the
// means to reverse it.
//
// Nothing here queues a cascade, moves a pointer or raises a notification. Step 1 of the shipping order in
// CASCADE_PIPELINE_HEALTH.md writes observations only, so a wrong reading
// costs nothing while it runs beside the existing signals and is compared
// against them. The escalation that replaces `drift_high` reads this table and
// ships separately.
//
// The response body is the diagnostic ledger, in the shape the cascade drain
// already uses: pg_cron records what it DELIVERED, never what happened, so the
// tick's own body is where a misbehaving pass is read from.
/** Did the custodian do or refuse anything worth an audit row? */
function custodianActed(
  c: { performed: number; failed: number; refused: number } | { error: string },
): boolean {
  if ("error" in c) return true;
  return c.performed > 0 || c.failed > 0 || c.refused > 0;
}

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

          /*
            THE LEDGER RUNS IN THE SAME TICK, AND AFTER.

            After, because it classifies against the auditor's NEWEST reading —
            a ledger running on a quarter-hour-old observation would describe a
            fleet that has since moved. Same tick, because every fact it needs
            is already in Mission Control's own tables: it touches no
            repository and asks the installation budget for nothing, so there
            is no reason to make it wait for its own schedule.

            A classification that fails must not lose the reading that was just
            taken, so it is caught here rather than allowed to fail the tick.
          */
          const { reconcileBlockageLedger } = await import("@/server/blockageLedger.server");
          let blockages: Awaited<ReturnType<typeof reconcileBlockageLedger>> | { error: string };
          try {
            blockages = await reconcileBlockageLedger(supabaseAdmin);
          } catch (e) {
            blockages = { error: e instanceof Error ? e.message : "Blockage ledger failed" };
          }

          // A run-level audit row only when the fleet is not simply
          // converging. A sweep that files an identical "3 converged" row four
          // times an hour is how an audit log stops being read — which is the
          // defect this whole area exists to remove, not one to repeat.
          const unclassified = "error" in blockages ? 0 : blockages.unclassified;
          /*
            THE CUSTODIAN RUNS LAST, ON THE LEDGER WRITTEN SECONDS AGO.

            Last because it acts on what the two passes above just observed; a
            custodian reading a quarter-hour-old ledger would repair a fleet
            that has since moved. It yields below the SCAN floor rather than
            the cascade's, because it is a repair actor and not the priority
            consumer: a record corrected fifteen minutes later costs nothing,
            and spending the window the cascade needs to make the correction
            unnecessary would be the measurement making the thing worse again.

            Like the ledger, a failure here must not lose the readings already
            taken.
          */
          const { runCustodian } = await import("@/server/custodian.server");
          let custodian: Awaited<ReturnType<typeof runCustodian>> | { error: string };
          try {
            custodian =
              "error" in blockages
                ? { error: "skipped — the blockage ledger did not complete this pass" }
                : await runCustodian(supabaseAdmin);
          } catch (e) {
            custodian = { error: e instanceof Error ? e.message : "Custodian failed" };
          }

          const ledgerFailed = "error" in blockages;
          if (
            report.stalled > 0 ||
            report.fallingBehind > 0 ||
            report.unknown > 0 ||
            unclassified > 0 ||
            ledgerFailed ||
            custodianActed(custodian)
          ) {
            await writeAuditLog({
              action: "cascade_convergence_audit",
              entityType: "cron",
              metadata: { ...report, blockages, custodian } as unknown as Record<string, unknown>,
            });
          }

          return new Response(JSON.stringify({ success: true, ...report, blockages, custodian }), {
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
