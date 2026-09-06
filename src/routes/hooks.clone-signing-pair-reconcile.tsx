import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 30 minutes.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Brings every clone's internal signing PAIR into agreement: the vault's
// `internal_edge_secret`, which `cron_signed_internal_headers` signs every
// scheduled call with, and the function environment's `INTERNAL_EDGE_SECRET`,
// which `auth_v2.ts` verifies against. They are one secret in two places, and
// provisioning wrote only the environment half — as a random it kept nowhere —
// so every clone's background layer was refused from the day it was built
// (~13,900 failed cron runs a day per clone, 6 Sep 2026).
//
// Provisioning writes the pair now. This is what covers the fleet as it
// stands, and what makes a clone whose environment write once failed converge
// on the next pass rather than rotate: the vault is the side that can be read,
// so the sweep reads it and re-asserts the environment with the same value.
//
// It can only ever write to a clone: the ref comes from
// `resolveCloneSecretTarget`, which refuses the prime and Mission Control's
// own, and the SAME ref is what the service-role key and the vault value are
// read from. See `cloneSigningPair.server.ts`.
export const Route = createFileRoute("/hooks/clone-signing-pair-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { reconcileCloneSigningPairs } = await import("@/server/cloneSigningPair.server");
          const result = await reconcileCloneSigningPairs(supabaseAdmin);
          // 200 with the refusals in the body: one clone that cannot be
          // repaired is not a failed sweep, and a job that reports failure for
          // a state it handled correctly is one people stop reading.
          return new Response(JSON.stringify({ success: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Signing pair reconcile failed";
          console.error("Signing pair reconcile failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
