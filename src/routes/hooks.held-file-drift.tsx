import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here hourly.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Looks at every clone's held files with no cascade running.
//
// A `manual_reconcile` path is one the cascade must never write, and the two
// guards that stand behind that hold both run INSIDE a cascade, over the files
// that cascade delivers. One of the two failures they catch is loud — a held
// file importing a symbol a delivered module stopped exporting fails the build.
// The other is silent: wiring prime's copy has and the clone's copy never
// received compiles perfectly, and the clone simply does not have the feature.
//
// Both are invisible on a module no cascade has touched since the drift
// appeared. This is the part that comes back and looks anyway.
//
// It reports and never repairs — a held file is held precisely because this
// platform is forbidden to write it — and it is quiet by design: a finding is
// recorded and announced when the set of gaps CHANGES, never once an hour for
// the same unfixed thing.
export const Route = createFileRoute("/hooks/held-file-drift")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { sweepHeldFileDrift } = await import("@/server/heldFileDriftSweep.server");
          const report = await sweepHeldFileDrift(supabaseAdmin);

          // Per-clone findings are already written against the clone they
          // belong to, and only when they change. A run-level row is worth
          // filing only when something went wrong across the fleet — a sweep
          // that files an identical "0 drifted" row every hour is how an audit
          // log stops being read.
          if (report.failed > 0 || report.skipped > 0) {
            await writeAuditLog({
              action: "held_file_drift_sweep_run",
              entityType: "cron",
              metadata: report as unknown as Record<string, unknown>,
            });
          }

          return new Response(JSON.stringify({ success: true, ...report }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Held file drift sweep failed";
          console.error("[hooks/held-file-drift]", message);
          await writeAuditLog({
            action: "held_file_drift_sweep_run",
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
