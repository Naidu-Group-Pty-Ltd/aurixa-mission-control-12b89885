import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here hourly. Auth: requires the shared
// CRON_SECRET as a Bearer token.
//
// Pairs the PRIME's two cron secrets — `FINANCE_PORTAL_CRON_SECRET` with the
// vault's `finance_portal_cron_secret`, and `MARKET_INGESTION_CRON_SECRET`
// with the database setting `app.market_ingestion_cron_secret` — by the
// owner's decision on 6 Sep 2026. Converges and never rotates: a pass over a
// prime whose mirror already agrees writes nothing. The ref is resolved by
// `resolvePrimeBackendRef` alone; see `primeSecretPairs.server.ts`.
export const Route = createFileRoute("/hooks/prime-secret-pairs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { ensurePrimeSecretPairs } = await import("@/server/primeSecretPairs.server");
          const result = await ensurePrimeSecretPairs(supabaseAdmin);
          // 200 either way: a prime that cannot be paired is reported in the
          // body, and the audit row already carries the reason.
          return new Response(JSON.stringify({ success: result.ok, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Prime secret pairs failed";
          console.error("Prime secret pairs failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
