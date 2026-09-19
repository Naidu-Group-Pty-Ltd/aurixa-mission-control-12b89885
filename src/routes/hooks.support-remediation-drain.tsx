// Self-healing remediation drain — invoked by pg_cron every 2 minutes with
// Bearer(cron_secret) auth.
//
// Each pass reclaims runs a dead invocation left stuck in `executing`,
// executes due remediation runs (P2-and-below actions the policy cleared,
// plus anything an admin approved), plans auto-merges for freshly verified
// scan remediations, rolls ticket statuses up from their runs, escalates SLA
// breaches, and prunes the ingest rate-limit ledger. Without this endpoint
// nothing self-heals: runs would sit `planned` forever.
//
// The reclaim step is first because `executeRemediationRun` accepts only
// `planned` and `approved`: without it a killed pass strands its row on no
// work list at all, which is how the first live edge-function deploy came to
// sit in `executing` having deployed nothing.
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";

export const Route = createFileRoute("/hooks/support-remediation-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        // Attribute this invocation's App-installation calls. See
        // githubUsageMeter.ts: the count is taken at the one hook every call
        // already passes through, and named here.
        beginGithubLane("support-remediation-drain");
        try {
          // Plans auto-merges and lands remediation work through the shared App
          // installation, twice a minute's worth of ticks an hour. An actor, so
          // it yields only at the reserve floor — but it yields, which it did
          // not before 19 Sep 2026.
          const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
          if (!spend.proceed) {
            return new Response(JSON.stringify({ success: true, skipped: spend.why }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          const { sweepSupportRemediations } = await import("@/server/self-healing.server");
          const result = await sweepSupportRemediations();
          return new Response(
            JSON.stringify({
              success: true,
              executed: result.executed.length,
              runsReclaimed: result.runsReclaimed,
              ticketsRolledUp: result.ticketsRolledUp,
              slaEscalations: result.slaEscalations,
              scanMergesPlanned: result.scanMergesPlanned,
              detail: result,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "drain_failed";
          console.error("support-remediation-drain failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
