// The live audit's sweep — invoked by pg_cron every ten minutes with
// Bearer(cron_secret) auth (migration 20261030133100_live_audit.sql).
//
// Runs that will never report are failed and silent fixes are failed first,
// from the database alone, whatever GitHub's window holds: a starved window
// must not keep a dead run blocking the next one. Then, if the budget allows,
// the GitHub half: re-dispatches, the latest run's automatic fixes, and the
// fix pull requests the webhook did not report (live-audit-sweep.server.ts).
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { advanceLiveAudit, reconcileLiveAudit } from "@/server/live-audit-sweep.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const Route = createFileRoute("/hooks/live-audit-sweep")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        beginGithubLane("live-audit-sweep");

        try {
          const reconciled = await reconcileLiveAudit();

          // An ACTOR, like the Codex sweep: it re-dispatches work somebody
          // already decided on, and a run left queued blocks every later run
          // of Prime. It yields at the actor's reserve, not the scan floor.
          const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
          if (!spend.proceed) return json({ success: true, reconciled, skipped: spend.why });

          const advanced = await advanceLiveAudit(reconciled.redispatch);
          return json({ success: true, reconciled, advanced });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "sweep_failed";
          console.error("live-audit-sweep failed:", msg);
          return json({ success: false, error: msg }, 500);
        }
      },
    },
  },
});
