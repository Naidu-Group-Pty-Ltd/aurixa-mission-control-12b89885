import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getCloneHealth } from "@/server/clone-health.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 5 minutes.
// Auth: requires Bearer DRIFT_REFRESH_TOKEN.
//
// Each pass probes every clone and writes TWO records of the same reading: the
// five-minute cache that makes `/health` instant, and a row on the append-only
// probe series that the SLO is computed from. `clone-health.server.ts` writes
// both, from one `probed_at`, so they can never disagree about when a reading
// was taken.
//
// The series is pruned HERE rather than on a schedule of its own. This
// platform's own record — `THE_CLONING_ENGINE.md`, six pg_cron jobs never
// scheduled at all, silently — is the argument against adding a seventh: a
// prune that rides a job already proven to run cannot be the one nobody
// noticed had stopped. It is one indexed delete against a table that grows by
// 288 rows per clone per day.
export const Route = createFileRoute("/hooks/warm-health")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        const startedAt = Date.now();
        try {
          const { data: clones } = await supabaseAdmin.from("clones").select("id");
          const list = clones ?? [];
          const results = await Promise.allSettled(
            // The ONLY caller that appends to the uptime series. Every other
            // probe in the product is triggered by a person looking at a page,
            // and an SLO built from a mix of scheduled and worried-operator
            // samples is not a measurement of anything.
            list.map((c) =>
              getCloneHealth(supabaseAdmin, c.id, { skipCache: true, recordSample: true }),
            ),
          );
          const ok = results.filter((r) => r.status === "fulfilled").length;
          const failed = results.length - ok;

          // Best-effort, and after the probes: losing a prune costs disk, and
          // losing a probe costs a hole in the series. The reading the page
          // draws is the one that must not be sacrificed to housekeeping.
          let pruned: number | string = 0;
          try {
            const { HEALTH_HISTORY_RETENTION_DAYS } =
              await import("@/server/health/uptimeSlo.pure");
            const cutoff = new Date(
              Date.now() - HEALTH_HISTORY_RETENTION_DAYS * 86_400_000,
            ).toISOString();
            const { data: gone, error } = await supabaseAdmin
              .from("clone_health_history")
              .delete()
              .lt("probed_at", cutoff)
              .select("id");
            // Reported rather than swallowed. A prune that has silently failed
            // for a month is a table nobody is watching grow.
            pruned = error ? `failed: ${error.message}` : (gone?.length ?? 0);
          } catch (e) {
            pruned = `failed: ${e instanceof Error ? e.message : "prune threw"}`;
          }

          const durationMs = Date.now() - startedAt;

          await supabaseAdmin.from("audit_log").insert({
            action: "warm_health_cron",
            entity_type: "cron",
            metadata: { total: list.length, ok, failed, pruned, durationMs },
          });

          return new Response(
            JSON.stringify({ success: true, total: list.length, ok, failed, pruned, durationMs }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Health pre-warm failed";
          console.error("Health pre-warm failed:", msg);
          await supabaseAdmin.from("audit_log").insert({
            action: "warm_health_cron",
            entity_type: "cron",
            metadata: { error: msg, durationMs: Date.now() - startedAt },
          });
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
