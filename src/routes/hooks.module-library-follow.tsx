import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import { followPrimeHead } from "@/server/library-follow.server";

// The module library follows the prime (docs/DELIVERY_SYSTEM_PLAN.md, D19).
// pg_cron POSTs here every 15 minutes, with two and a half minutes' patience
// (20261029160000_library_follow_patience), and Bearer(cron_secret) auth
// (20261029140000_module_library_follows_the_prime).
// While the catalogue is settled at the prime's head this reads the head and
// returns; when the head has moved it detects the catalogue there and settles
// it (`library-follow.server.ts`).
export const Route = createFileRoute("/hooks/module-library-follow")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        // Attribute this invocation's App-installation calls (githubUsageMeter.ts).
        beginGithubLane("module-library-follow");

        try {
          // A detection reads about a hundred calls' worth of the prime, from
          // the budget the cascade shares. In a starved window it waits for
          // the next tick, which finds the head where this one left it.
          const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
          if (!spend.proceed) {
            return new Response(JSON.stringify({ success: true, skipped: spend.why }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          const report = await followPrimeHead(supabaseAdmin);
          const failed = report.outcome === "failed";
          return new Response(JSON.stringify({ success: !failed, ...report }), {
            status: failed ? 500 : 200,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "The library follow failed";
          console.error("Library follow failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
