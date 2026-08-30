import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 5 minutes.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Merges the cascade pull requests whose checks have gone green.
//
// `auto_merge` cannot merge at the moment it opens a pull request and does not
// try: check runs appear asynchronously, and `verify` — install, typecheck,
// build and ~19,000 tests — takes about seventeen minutes to report while
// `Vercel Preview Comments` completes in the same second. GitHub's own
// auto-merge is the mechanism built for that wait and cannot be armed on a
// repository with no required status checks, which is every clone here.
//
// So without this the honest gate becomes the old symptom by another route:
// pull requests opened, nothing merged, `0 merged` for ever. This is the part
// that comes back and looks again.
//
// It merges only branches this engine names and only through
// `decideCascadeMerge`, so "green" has one definition rather than two that can
// drift.
//
// It also reconciles Mission Control's record to what GitHub actually did.
// A cascade result used to stop at `pr_opened` for ever: this drain merged the
// pull request and wrote an audit row, a person merging one by hand wrote
// nothing, and neither reached `cascade_results`, `cascade_events.summary` or
// `clones`. #66 and #67 were merged at 07:55 and 08:35 on 30 Aug 2026 and both
// still read `0 merged · 1 PRs` an hour later, on a clone reporting itself 140
// commits behind. The pull request's own state is read on every pass, so a
// record that is behind is always brought forward — however it fell behind.
export const Route = createFileRoute("/hooks/cascade-merge-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { drainCascadeMerges } = await import("@/server/cascadeMergeDrain.server");
          const report = await drainCascadeMerges(supabaseAdmin);

          // Only write a breadcrumb when something actually happened: a drain
          // that files an identical "held: pending" row every five minutes is
          // how an audit log stops being read. Anything that CHANGED counts,
          // not merges alone — a pull request somebody merged by hand, or a
          // proposal somebody closed, corrects a record that was wrong, which
          // is exactly as worth filing as a merge this drain performed itself.
          if (
            report.merged > 0 ||
            report.reconciled > 0 ||
            report.recounted > 0 ||
            report.advanced > 0 ||
            report.foreignRepo > 0 ||
            report.failed > 0
          ) {
            await writeAuditLog({
              action: "cascade_merge_drain",
              entityType: "cron",
              metadata: report as unknown as Record<string, unknown>,
            });
          }

          return new Response(JSON.stringify({ success: true, ...report }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Cascade merge drain failed";
          console.error("[hooks/cascade-merge-drain]", message);
          await writeAuditLog({
            action: "cascade_merge_drain",
            entityType: "cron",
            metadata: { error: message },
          });
          return new Response(JSON.stringify({ success: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
