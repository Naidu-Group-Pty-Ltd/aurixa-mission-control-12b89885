import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runDriftRefresh } from "@/server/drift-refresh.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";

// Cron-invoked endpoint. pg_cron schedules a POST here every 5 min.
// Auth: requires the shared CRON_SECRET as a Bearer token.
export const Route = createFileRoute("/hooks/drift-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        // Attribute this invocation's App-installation calls. See
        // githubUsageMeter.ts: the count is taken at the one hook every call
        // already passes through, and named here.
        beginGithubLane("drift-refresh");

        try {
          // A drift number refreshed into a starved window is a measurement
          // taken at the cost of the act it measures — the cascade shares
          // this installation's budget. The next run takes the reading.
          const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
          if (!spend.proceed) {
            return new Response(JSON.stringify({ success: true, skipped: spend.why }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          const result = await runDriftRefresh(supabaseAdmin);
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Drift refresh failed";
          console.error("Drift refresh failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
