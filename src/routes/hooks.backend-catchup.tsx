import { createFileRoute } from "@tanstack/react-router";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. Auth: the shared CRON_SECRET as a Bearer token.
//
// Brings an EXISTING clone's backend up to the prime without waiting for a
// cascade to merge.
//
// `requestBackendSyncAfterCascade` already computes exactly what a clone's
// backend owes and queues it, and it works — eight `edge_function_deploy`
// runs have succeeded through it. It had two callers, the cascade engine and
// the merge drain, and both fire only when a cascade MERGES. A cascade merges
// only when the clone repository's CI goes green, and since 4 September
// GitHub has started no job on any private clone repository — so no clone has
// received a backend change since 04:00 that day, while the cascade opened its
// pull requests on schedule and recorded no error.
//
// The deploy never needed the clone's CI: it reads the prime's repository and
// writes to the clone's Supabase project through the Management API. The
// catch-up was chained to an event that can stop happening.
//
// It plans and never advances `last_synced_sha` — that column means the
// clone's repository CONTENT is at that prime revision, and this deploys
// FUNCTIONS. It settles, because the planner widens an open run rather than
// queuing a second one.
export const Route = createFileRoute("/hooks/backend-catchup")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { runBackendCatchup } = await import("@/server/backendCatchup.server");
          const report = await runBackendCatchup("backend catch-up sweep");

          // Only a breadcrumb when something was planned or refused. A sweep
          // over a fleet that owes nothing is the healthy steady state and
          // should not fill the audit log twice an hour.
          if (report.planned || report.refused || report.outcomes.some((o) => o.refused)) {
            await writeAuditLog({
              action: "backend_catchup_cron",
              entityType: "cron",
              metadata: report as unknown as Record<string, unknown>,
            });
          }

          // 200 with the refusals in the body: one clone with no Supabase
          // project is a state, not a failed sweep.
          return new Response(JSON.stringify({ success: true, ...report }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "backend catch-up failed";
          console.error("[hooks/backend-catchup]", message);
          await writeAuditLog({
            action: "backend_catchup_cron",
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
