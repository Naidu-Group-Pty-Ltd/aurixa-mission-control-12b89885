import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";

// Cron-invoked endpoint. pg_cron POSTs here every 30 minutes.
// Auth: requires the shared CRON_SECRET as a Bearer token.
//
// Gives every clone the prime's function EXECUTE grants and view options. The
// catalogue clone path wrote every function with `pg_get_functiondef`, which
// carries no ACL, so a function on a clone started callable by PUBLIC whatever
// the prime had revoked — 238 to 247 SECURITY DEFINER functions per clone
// reachable with the anon key, `cron_service_role_headers` among them. The
// provisioner now converges this in its grants stage; this sweep reaches the
// clones whose schema was verified before it did. See
// `clonePrivilegeRepair.server.ts` and `routinePrivileges.pure.ts`.
//
// Body (all optional): `{ "dryRun": true }` plans without writing and returns
// a sample of the statements; `{ "cloneId": "…" }` limits the run to one clone.
const INVOCATION_BUDGET_MS = 45_000;

export const Route = createFileRoute("/hooks/clone-privilege-reconcile")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        let body: { dryRun?: unknown; cloneId?: unknown } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          body = {};
        }
        const dryRun = body.dryRun === true;
        const cloneId =
          typeof body.cloneId === "string" && /^[0-9a-f-]{36}$/i.test(body.cloneId)
            ? body.cloneId
            : undefined;

        try {
          const { reconcileClonePrivileges } = await import("@/server/clonePrivilegeRepair.server");
          const report = await reconcileClonePrivileges(supabaseAdmin, {
            deadlineAt: Date.now() + INVOCATION_BUDGET_MS,
            dryRun,
            cloneId,
          });

          // A breadcrumb only when the run changed something, was stopped, or
          // refused a clone. Once the fleet is aligned every pass is two reads
          // a side and nothing to say.
          const wrote = report.changed.some((c) => c.applied > 0 || c.failed > 0);
          if (wrote || report.refused.length || (report.pausedAt && !dryRun)) {
            await writeAuditLog({
              action: "clone_privilege_reconcile_cron",
              entityType: "cron",
              metadata: report as unknown as Record<string, unknown>,
            });
          }

          // 200 with refusals in the body: one clone whose catalogue cannot be
          // read is a state, not a failed run.
          return new Response(JSON.stringify({ success: true, ...report }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Privilege reconcile failed";
          console.error("[hooks/clone-privilege-reconcile]", message);
          await writeAuditLog({
            action: "clone_privilege_reconcile_cron",
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
