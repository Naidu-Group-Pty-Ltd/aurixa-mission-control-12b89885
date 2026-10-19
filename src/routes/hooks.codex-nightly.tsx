// Codex Security nightly scan — invoked by pg_cron with Bearer(cron_secret)
// auth. Enqueues the one scheduled scan there is: Prime's, with a dedup
// window so overlapping cron runs (or manual re-runs) don't stack duplicates.
// Clones are not scanned (src/lib/codex-scan-policy.ts); the fixes the scan
// leads to are dispatched by the sweep once it completes (codex-autofix.server.ts).
// Before the scan it writes Mission Control's current Codex keys into Prime's
// repository and takes any Codex secret out of the clones'
// (codex-repo-secrets.server.ts).
// It also puts back the ruleset that protects Mission Control's own default
// branch, if a person deleted it or it lost a rule
// (mission-control-branch-protection.server.ts) — Mission Control's repository,
// never Prime's.
//
// IT SPENDS THE APP INSTALLATION, AND FOR A YEAR IT NEVER SAID SO.
//
// `enqueueScanNoAuth` dispatches as it enqueues — `dispatchJob` →
// `dispatchCodexScan` → `workflow_dispatch` — so this is a GitHub call. It
// used to be one per enabled clone as well: "a 40-clone fleet used to
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
import { notifyOverdueFindings } from "@/server/codex-finding-sla.server";
import { ensureMissionControlBranchProtection } from "@/server/mission-control-branch-protection.server";
import { retractStrayDigestProposal } from "@/server/applied-digests-proposal.server";
import { reconcileCodexRepoSecrets } from "@/server/codex-repo-secrets.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";

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

        // The daily overdue digest reads only the database, so it is not part
        // of the GitHub budget decision below: a night the scans stand down is
        // still a day the findings aged.
        const overdue = await notifyOverdueFindings().catch((err) => {
          console.error("codex-nightly overdue digest failed:", err);
          return null;
        });

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
          return new Response(JSON.stringify({ success: true, skipped: spend.why, overdue }), {
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
          // The keys tonight's scan and fixes read, in Prime's repository and
          // in no clone's (codex-repo-secrets.server.ts) — before the scan, so
          // a key rotated in Mission Control is the one the scan runs with.
          // Its own outcome, never the scan's: a sync that fails leaves the
          // keys Prime already holds, and the night goes on.
          const secrets = await reconcileCodexRepoSecrets({
            triggerSource: "nightly",
            recordClean: false,
          }).catch((err) => {
            console.error("codex-nightly secret sync failed:", err);
            return null;
          });
          const result = await runNightlyScans();
          // Mission Control's own default branch, put back the way it should
          // be: a ruleset a person deleted is back by morning
          // (mission-control-branch-protection.server.ts). Its own outcome,
          // never the scan's — a missing App permission is reported on engine
          // health, not as a failed night.
          const protection = await ensureMissionControlBranchProtection({ apply: true }).catch(
            (err) => ({
              ok: false,
              status: "error" as const,
              detail: err instanceof Error ? err.message : String(err),
            }),
          );
          // What the misdirected first digest refresh opened on Prime, taken
          // back (applied-digests-proposal.server.ts). A no-op once it is gone.
          const retracted = await retractStrayDigestProposal(supabaseAdmin).catch((err) => {
            console.warn("codex-nightly: stray digest proposal not retracted:", err);
            return null;
          });
          if (retracted && (retracted.closed.length > 0 || retracted.branchDeleted)) {
            await writeAuditLog({
              action: "prime.stray_digest_proposal.retracted",
              entityType: "github_repository",
              entityId: retracted.repo,
              metadata: retracted as unknown as Record<string, unknown>,
            });
          }
          if (
            protection.status === "created" ||
            protection.status === "updated" ||
            ("autoMerge" in protection && protection.autoMerge === "turned_on")
          ) {
            await writeAuditLog({
              action:
                protection.status === "created" || protection.status === "updated"
                  ? `mission_control.branch_protection.${protection.status}`
                  : "mission_control.branch_protection.auto_merge_allowed",
              entityType: "github_ruleset",
              entityId: "repo" in protection ? (protection.repo ?? null) : null,
              metadata: protection as Record<string, unknown>,
            });
          } else if (!protection.ok) {
            console.warn(
              `codex-nightly: main is not protected (${protection.status}): ${protection.detail}`,
            );
          }
          return new Response(
            JSON.stringify({
              success: true,
              ...result,
              swept,
              overdue,
              secrets,
              protection,
              retracted,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
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
