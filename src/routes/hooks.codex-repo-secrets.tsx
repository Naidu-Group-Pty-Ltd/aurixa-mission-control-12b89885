// Codex repository secrets, put where they belong — POST with Bearer(cron_secret).
// Prime's repository gets the model keys the Codex workflows read, and every
// clone's loses any Codex secret it holds (codex-repo-secrets.server.ts).
//
// The nightly run does the same before Prime's scan. This door is for asking
// Mission Control to do it now, with nobody's session: the two Settings buttons
// it shares an implementation with need an administrator signed in.
//
// Every target it checks gets a history row, a clean clone included, so the
// Settings card shows the whole pass rather than only what it changed.
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { reconcileCodexRepoSecrets } from "@/server/codex-repo-secrets.server";

export const Route = createFileRoute("/hooks/codex-repo-secrets")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        beginGithubLane("codex-repo-secrets");

        // An ACTOR in githubBudget.pure.ts's terms: it lands work somebody
        // decided on, and a sync postponed is a Prime whose fixes fail for a
        // key it does not hold. A handful of calls — a public key and a write
        // per secret on Prime, then one read per clone.
        const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
        if (!spend.proceed) {
          return new Response(JSON.stringify({ success: false, skipped: spend.why }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          const result = await reconcileCodexRepoSecrets({
            triggerSource: "mission-control",
            recordClean: true,
          });
          return new Response(JSON.stringify({ success: result.ok, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "codex repo secrets failed";
          console.error("codex-repo-secrets failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
