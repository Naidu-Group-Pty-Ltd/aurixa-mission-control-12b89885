import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 10 minutes.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Gives every eligible clone its OWN Turnstile widget. The deployment drain
// mints one in `syncing_env`, which covers every clone provisioned from now on
// and none provisioned before that step existed — including the only clone in
// the fleet, which was built by hand and went live months earlier. A per-tenant
// security credential that only new tenants get is not a feature the fleet has,
// which is exactly why `allowed-origins-reconcile` exists beside it.
//
// It also publishes the site key and asks for the rebuild that puts it in the
// bundle, because Vite inlines `VITE_*` at build time and a published key no
// browser has ever seen is indistinguishable from no key at all.
//
// The response is deliberately the run's own diagnosis: it names whether
// Mission Control can see `CLOUDFLARE_API_TOKEN` and the account id, rather
// than returning an empty success that reads the same as a healthy fleet.
export const Route = createFileRoute("/hooks/turnstile-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { reconcileTurnstileIdentities } =
            await import("@/server/turnstile-identity.server");
          const report = await reconcileTurnstileIdentities(supabaseAdmin);

          // Recorded so the answer to "is the Cloudflare token live yet?" is a
          // row an operator can read, not a log line in a worker they cannot
          // reach. `audit_log` is where every other scheduled worker reports.
          await writeAuditLog({
            action: "turnstile_reconcile_cron",
            entityType: "cron",
            metadata: report as unknown as Record<string, unknown>,
          });

          // 200 with the refusals in the body, not 500: an unconfigured
          // credential is a state, not a crash, and a job that reports failure
          // for something it correctly refused is one people stop reading.
          return new Response(JSON.stringify({ success: true, ...report }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Turnstile reconcile failed";
          console.error("Turnstile reconcile failed:", msg);
          await writeAuditLog({
            action: "turnstile_reconcile_cron",
            entityType: "cron",
            metadata: { error: msg },
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
