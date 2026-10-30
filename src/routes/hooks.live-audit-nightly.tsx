// The nightly live audit of Prime — invoked by pg_cron with Bearer(cron_secret)
// auth, at the time on the Live Audit page (`live_audit_set_nightly_schedule`).
//
// Off until a person turns it on: the switch is `live_audit_settings.
// nightly_enabled`, read here rather than by unscheduling the job, so turning
// it on is one click and never a migration. One nightly run a night, and none
// while another run of Prime is in flight (`live_audit_runs_one_active`).
//
// It spends the App installation: queueing a run dispatches it, a
// `workflow_dispatch` on Prime (live-audit-dispatch.server.ts).
import { createFileRoute } from "@tanstack/react-router";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";
import { beginGithubLane } from "@/server/githubUsageMeter";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueueLiveAuditRun, loadLiveAuditSettings } from "@/server/live-audit-dispatch.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A second firing inside this window is the same night. */
const NIGHTLY_DEDUP_HOURS = 20;

export const Route = createFileRoute("/hooks/live-audit-nightly")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        beginGithubLane("live-audit-nightly");

        try {
          const settings = await loadLiveAuditSettings("prime");
          if (!settings) return json({ success: true, skipped: "no settings row for Prime" });
          if (!settings.nightly_enabled)
            return json({ success: true, skipped: "the nightly audit is off" });

          const since = new Date(Date.now() - NIGHTLY_DEDUP_HOURS * 3_600_000).toISOString();
          const { data: recent, error } = await supabaseAdmin
            .from("live_audit_runs")
            .select("id, status")
            .eq("target_key", "prime")
            .eq("kind", "nightly")
            .gte("created_at", since)
            .limit(1)
            .maybeSingle();
          // A failed read is not "no run tonight": stand down and say so.
          if (error)
            return json({ success: false, error: `recent runs not read: ${error.message}` }, 500);
          if (recent)
            return json({
              success: true,
              skipped: "tonight's run already exists",
              runId: recent.id,
            });

          /*
            A MEASUREMENT, so it yields first. A night's audit postponed costs
            a day-old picture of Prime; tomorrow's run covers the same ground.
          */
          const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
          if (!spend.proceed) return json({ success: true, skipped: spend.why });

          const result = await enqueueLiveAuditRun({ kind: "nightly", requestedBy: null });
          return json({ success: result.ok, ...result });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "nightly_failed";
          console.error("live-audit-nightly failed:", msg);
          return json({ success: false, error: msg }, 500);
        }
      },
    },
  },
});
