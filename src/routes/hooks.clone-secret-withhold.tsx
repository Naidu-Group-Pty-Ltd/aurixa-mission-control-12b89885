import { createFileRoute } from "@tanstack/react-router";
import { writeAuditLog } from "@/server/audit.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// Operator-invoked endpoint. Auth: the shared CRON_SECRET as a Bearer token.
//
// Takes ONE forwarded credential off ONE clone and keeps it off.
//
// Deliberately not on a schedule. Every other hook here is a reconcile that
// converges the fleet on a policy; this performs a decision about a single
// tenant that nothing can derive, so it is invoked once, by hand, with the
// reason recorded — and the reason is what the next operator reads when
// deciding whether to undo it.
//
// Nothing here decides WHAT may be withheld. `decideCloneWithhold` does, and
// its protective rule is that only a name the fleet forward DELIVERED
// (`inherited`) may be taken away — a clone's own peppers, push keys, signing
// secret and CAPTCHA pair are `set` or `generated`, and deleting one would
// break the clone in a way no forward could have caused.
//
// The response carries the outcome verbatim, including a refusal, because a
// withdrawal that quietly did nothing is indistinguishable from one that
// worked until somebody looks at the tenant's project.
export const Route = createFileRoute("/hooks/clone-secret-withhold")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        let body: { cloneId?: unknown; name?: unknown; reason?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return new Response(JSON.stringify({ success: false, error: "body must be JSON" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const cloneId = typeof body.cloneId === "string" ? body.cloneId.trim() : "";
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const reason = typeof body.reason === "string" ? body.reason : "";
        if (!cloneId || !name) {
          return new Response(
            JSON.stringify({ success: false, error: "cloneId and name are required" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        try {
          const { withholdCloneSecret } = await import("@/server/fleetSecretForward.server");
          const result = await withholdCloneSecret(supabaseAdmin, cloneId, name, reason);

          // Audited either way. A refused withdrawal is a decision somebody
          // made and is worth as much in the record as one that went through.
          await writeAuditLog({
            action: "clone_secret_withheld",
            entityType: "clone",
            entityId: cloneId,
            metadata: { name, reason, result } as unknown as Record<string, unknown>,
          });

          return new Response(JSON.stringify({ success: result.ok, ...result }), {
            status: result.ok ? 200 : 409,
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : "withdrawal failed";
          console.error("[hooks/clone-secret-withhold]", message);
          return new Response(JSON.stringify({ success: false, error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
