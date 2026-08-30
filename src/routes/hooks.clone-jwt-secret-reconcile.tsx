import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 30 minutes.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Gives every clone the one secret only its own backend can supply. A clone's
// custom auth mints Supabase access tokens itself and its own project
// validates them, so `JWT_SECRET` is `tenant_scoped`: never inherited from the
// prime (that would let a clone mint tokens the PRIME's database accepts) and
// never generated (a random value produces tokens the project rejects).
//
// Provisioning writes it now, but only for clones provisioned after that
// existed. This is what covers the rest of the fleet, and what makes a project
// adopted rather than created here set itself without anybody pressing a
// button — the alternative being a person opening the clone's Supabase
// settings and pasting a signing key into a box, for a value Mission Control
// can read itself.
//
// It can only ever write to a clone: the ref comes from
// `resolveCloneSecretTarget`, which refuses the prime and Mission Control's
// own, and the SAME ref is what the key was read from. See
// `cloneSecretRepair.server.ts`.
export const Route = createFileRoute("/hooks/clone-jwt-secret-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        try {
          const { reconcileCloneJwtSecrets } = await import("@/server/cloneSecretRepair.server");
          const report = await reconcileCloneJwtSecrets(supabaseAdmin);

          // Only a breadcrumb when the run did something or refused. A job that
          // files an identical row every half hour is one people stop reading,
          // and this one settles: once the fleet holds its keys every pass is
          // `already_set`.
          if (report.repaired || report.refused.length) {
            await writeAuditLog({
              action: "clone_jwt_secret_reconcile_cron",
              entityType: "cron",
              metadata: report as unknown as Record<string, unknown>,
            });
          }

          // 200 with the refusals in the body rather than 500: one clone whose
          // project config the Management API will not return is a state, not a
          // failed run.
          return new Response(JSON.stringify({ success: true, ...report }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "JWT secret reconcile failed";
          console.error("[hooks/clone-jwt-secret-reconcile]", message);
          await writeAuditLog({
            action: "clone_jwt_secret_reconcile_cron",
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
