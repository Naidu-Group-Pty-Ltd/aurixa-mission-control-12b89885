// Codex Security nightly scan drainer — invoked by pg_cron with
// Bearer(cron_secret) auth. Enqueues one Codex scan for Prime plus one for
// every clone with codex_nightly_enabled=true, with a dedup window so
// overlapping cron runs (or manual re-runs) don't stack duplicates.
//
// IT SPENDS THE APP INSTALLATION, AND FOR A YEAR IT NEVER SAID SO.
//
// `enqueueScanNoAuth` dispatches as it enqueues — `dispatchJob` →
// `dispatchCodexScan` → `workflow_dispatch` — so this is one GitHub call per
// enabled clone plus the prime, fanned out by `mapWithConcurrency`. The
// scheduling module's own comment gives the scale: "a 40-clone fleet used to
// serialize 40 round-trips to GitHub."
//
// `everyGithubLaneYields.contract.test.ts` could not see it. It followed ONE
// import hop from the route, and the `getAppOctokit` is two away:
//
//     hooks.codex-nightly.tsx
//       → codex-scheduling.server.ts        (no GitHub call here)
//         → codex-security-client.server.ts (getAppOctokit)
//
// Measured 20 Sep 2026 by varying the walk depth: 13 lanes and 0 unguarded at
// depth 1, 15 and 2 at depth 2, converging there. This lane and
// `/hooks/codex-sweep` were the two. See #234.
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { runNightlyScans, sweepStalledScans } from "@/server/codex-scheduling.server";

export const Route = createFileRoute("/hooks/codex-nightly")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        // Named before anything is spent. Ten other lanes do this; these two
        // did not, so every call they made was attributed to whichever lane
        // had run last in the isolate — which is the misattribution
        // `githubUsageMeter` flushes on a lane change to prevent.
        beginGithubLane("codex-nightly");

        /*
          A SCAN, AND THE WHOLE HANDLER IS ONE DECISION.

          `githubBudget.pure.ts` states the asymmetry: "a measurement
          postponed costs a stale number, while an apply postponed costs a
          clone sitting a migration behind the prime." A nightly security
          sweep of the fleet is the first of those — tomorrow's run covers the
          same ground — and it is the heaviest single burst in the system, so
          it is the one that should stand down first.

          The sweep below is inside that decision rather than judged
          separately, because it is PREPARATION for the nightly: its own
          comment says a target stuck in `queued` would trip the dedup window
          and skip tonight's scan too. Running it when the scan it prepares
          for will not happen spends the window for nothing. The dedicated
          sweep lane keeps its own, lower floor ten minutes later.
        */
        const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
        if (!spend.proceed) {
          return new Response(JSON.stringify({ success: true, skipped: spend.why }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          // Clear stranded jobs first: a target stuck in `queued` would
          // otherwise trip the dedup window and skip tonight's scan too.
          const swept = await sweepStalledScans().catch((err) => {
            console.error("codex-nightly sweep failed:", err);
            return null;
          });
          const result = await runNightlyScans();
          return new Response(JSON.stringify({ success: true, ...result, swept }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "nightly_failed";
          console.error("codex-nightly failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
