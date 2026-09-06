import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here twice an hour, offset from the
// signing-pair sweep. Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Three sweeps, one hook, because they are one question — "does this clone's
// function environment hold what belongs to it?" — asked of three classes:
//
//   1. The clone-OWNED secrets: the reset and CSRF peppers and the VAPID pair,
//      minted once and mirrored in the clone's vault so a pass re-asserts
//      rather than rotates. Every clone was without a pepper (no password
//      reset could be issued) and without a VAPID pair (every push answered
//      503) on 6 Sep 2026.
//   2. The Mission Control LINK: the URL, the API key, the agency name and the
//      webhook secret, written to the environment that reads them. The key
//      used to be committed to a repository file nothing reads, and no clone
//      had ever presented one.
//   3. The DERIVED deployment config — public URL, WebAuthn relying party,
//      web-push host — re-computed from the clone's current origins, so a
//      domain going live after provisioning is reflected rather than frozen.
//
// Each can only ever write to a clone: the ref comes from
// `resolveCloneSecretTarget`, which refuses the prime and Mission Control's
// own. See `cloneOwnedSecrets.server.ts`, `cloneMissionControlLink.server.ts`
// and `cloneDerivedConfig.server.ts`.
export const Route = createFileRoute("/hooks/clone-secrets-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { reconcileCloneOwnedSecrets } = await import("@/server/cloneOwnedSecrets.server");
          const { reconcileCloneMissionControlLinks } = await import(
            "@/server/cloneMissionControlLink.server"
          );
          const { reconcileCloneDerivedConfig } = await import("@/server/cloneDerivedConfig.server");
          const owned = await reconcileCloneOwnedSecrets(supabaseAdmin);
          const link = await reconcileCloneMissionControlLinks(supabaseAdmin);
          const derived = await reconcileCloneDerivedConfig(supabaseAdmin);
          // 200 with the refusals in the body: one clone that cannot be
          // repaired is not a failed sweep.
          return new Response(JSON.stringify({ success: true, owned, link, derived }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Clone secrets reconcile failed";
          console.error("Clone secrets reconcile failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
