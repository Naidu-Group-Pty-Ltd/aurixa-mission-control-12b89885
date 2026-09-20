// Codex Security stalled-scan sweeper — invoked by pg_cron every 10 minutes
// with Bearer(cron_secret) auth.
//
// Scans are dispatched to an external executor (GitHub Actions) and reported
// back over a webhook, so any lost dispatch or dead workflow run would sit
// in `queued`/`running` forever — and the dedup window would then suppress
// every subsequent scan of that target. This endpoint reconciles both.
//
// THE HEAVIEST SPENDER NOBODY HAD COUNTED.
//
// Reconciling a stranded job means re-dispatching it, and a dispatch is a
// `workflow_dispatch` against the App installation. `sweepStalledScans` takes
// up to 50 stranded jobs a run and this runs `*/10 * * * *` — 144 runs a day,
// so a backlog turns this into 7,200 calls a day against a 5,000-an-hour
// window shared with every other lane.
//
// It consulted nothing until #234. `everyGithubLaneYields.contract.test.ts`
// followed ONE import hop and the `getAppOctokit` is two away, through
// `codex-scheduling.server.ts` into `codex-security-client.server.ts`.
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { sweepStalledScans } from "@/server/codex-scheduling.server";

export const Route = createFileRoute("/hooks/codex-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        beginGithubLane("codex-sweep");

        /*
          AN ACTOR, NOT A SCAN — and the two floors differ by 1,250 calls.

          This does not measure anything. It re-dispatches work somebody
          already decided on, and a job left stranded does not merely go
          unreported: the dedup window keys on the target, so one stuck job
          suppresses every subsequent scan of that repository until this lane
          clears it. Postponing that is the "apply postponed" half of
          `githubBudget.pure.ts`'s asymmetry, so it yields at the reserve that
          keeps the next actor able to start rather than at the scan floor.

          Deliberately not `cascade_claim`: that floor is the cascade's own,
          and this is not it.
        */
        const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
        if (!spend.proceed) {
          return new Response(JSON.stringify({ success: true, skipped: spend.why }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          const result = await sweepStalledScans();
          return new Response(
            JSON.stringify({
              success: true,
              retried: result.retried.length,
              failed: result.failed.length,
              timedOut: result.timedOut.length,
              detail: result,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : "sweep_failed";
          console.error("codex-sweep failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
