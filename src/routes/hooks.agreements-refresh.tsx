import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// How many non-terminal envelopes one sweep polls. DocuSign's resource
// limits are generous, but a sweep is not a backfill: at 25 per 10 minutes
// the whole realistic in-flight population clears in one pass.
const REFRESH_BATCH = 25;

// Cron-invoked agreements sweep: polls every sent/delivered envelope through
// the same JWT credentials the send path uses and folds the status in via
// applyDocusignStatus — which is also where provision-on-signature fires. So
// a signed agreement provisions its clone within ten minutes even with NO
// Connect webhook configured; the webhook only makes it instant.
// Auth: requires Bearer DRIFT_REFRESH_TOKEN. Scheduled by the
// `agreements-refresh` pg_cron job (see 20260828070000_agreement_provisioning.sql).
export const Route = createFileRoute("/hooks/agreements-refresh")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        const { docusignConfig, refreshEnvelopeStatus } =
          await import("@/server/agreements.server");
        const config = docusignConfig();
        if (!config.ready) {
          // Dormant, not broken: nothing to poll with until the DocuSign
          // secrets exist. A 200 keeps the cron ledger green — the missing
          // configuration is already surfaced on /agreements itself.
          return new Response(
            JSON.stringify({
              success: true,
              skipped: "docusign_not_configured",
              missing: config.missing,
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        }

        const { data: pending, error } = await supabaseAdmin
          .from("client_agreements")
          .select("id, client_name")
          .not("docusign_envelope_id", "is", null)
          .in("status", ["sent", "delivered"])
          // Oldest first: an envelope that has been out longest is the one
          // whose signature we are most likely already late on.
          .order("docusign_sent_at", { ascending: true })
          .limit(REFRESH_BATCH);
        if (error) {
          return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        let refreshed = 0;
        let transitioned = 0;
        const failures: Array<{ id: string; error: string }> = [];
        for (const row of pending ?? []) {
          try {
            const result = await refreshEnvelopeStatus(row.id);
            refreshed += 1;
            if (result.status !== "sent" && result.status !== "delivered") transitioned += 1;
          } catch (e) {
            // One stuck envelope must not stop the sweep for the others.
            failures.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            polled: pending?.length ?? 0,
            refreshed,
            transitioned,
            failures,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    },
  },
});
