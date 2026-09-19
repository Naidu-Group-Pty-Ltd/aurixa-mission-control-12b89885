import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { runFleetMigrationSync } from "@/server/fleet-migration.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";

// Cron-invoked endpoint. pg_cron schedules a POST here every 30 min.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Applies the prime's migrations to a bounded slice of the fleet. The cascade
// already copies migration FILES into every clone's repository; this is what
// gets them into the clone's DATABASE, which until now happened only when an
// operator pressed a button on an admin page.
//
// Thirty minutes, not one: nothing here is queue-draining, a clone's schema
// does not change between ticks, and each run is bounded to a few clones so
// the fleet is worked through across ticks rather than in one invocation that
// would outlive the isolate.
//
// It can only ever reach a clone: the candidate list is `clone_backends`, whose
// `clone_id` is NOT NULL, so the prime — whose ref lives in `prime_config` —
// has no row there to return.
export const Route = createFileRoute("/hooks/fleet-migration-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        // Attribute this invocation's App-installation calls. See
        // githubUsageMeter.ts: the count is taken at the one hook every call
        // already passes through, and named here.
        beginGithubLane("fleet-migration-sync");

        try {
          // This lane reads the prime's whole migration corpus from GitHub and
          // then a body per unapplied migration per clone, on an installation
          // it shares with every other lane. It stood down for nothing until
          // 19 Sep 2026: it exhausted the window that night, and because a
          // quota refusal mid-pass looked like a migration the clone had
          // rejected, three clones were ejected from the fleet on the strength
          // of it. Both halves of that are fixed — this is the half that stops
          // it spending the window down in the first place.
          const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
          if (!spend.proceed) {
            return new Response(JSON.stringify({ success: true, skipped: spend.why }), {
              headers: { "Content-Type": "application/json" },
            });
          }
          const result = await runFleetMigrationSync(supabaseAdmin);
          // 200 with the failures in the body rather than 500: one clone whose
          // migration failed is not a failed run, and a job that reports
          // failure for a state it handled correctly is one people stop reading.
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Fleet migration sync failed";
          console.error("Fleet migration sync failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
