// Converge an ALREADY-READY clone backend onto the engine as it now stands.
//
// The retry hook beside this one re-queues a FAILED backend. Nothing re-queued
// a ready one, and `enqueueCloneBackendProvisioning` refused it outright
// ("This clone already has a provisioned backend") — a guard that is right
// about what it guards, the wizard provisioning the same clone twice, and that
// between the two levers left the most ordinary state of all with no lever.
//
// Because the engine gets FIXED. Every clone provisioned before a fix is
// frozen holding the gaps that fix closed, and until now the only remedy the
// product offered was to destroy a tenant's Supabase project and build a new
// one. Measured 3 Sep 2026: two clones sat at `ready` holding 0 of the prime's
// 32 storage buckets and 9 of its 86 secrets, because the two fixes for that
// landed after they finished.
//
// What a repair is, precisely: the same pipeline, resumed onto the SAME
// project, with every replication step doing what it already does — check the
// target, carry what is missing, reconcile what is not. What it is NOT is a
// re-onboarding: the admin seed is skipped, because it rewrites
// `password_hash` and clears `failed_login_attempts` / `locked_until` whether
// or not the tenant has since signed in and changed them.
//
// Auth: CRON_SECRET bearer, the credential every scheduled worker here uses.
// Deliberately NOT on a timer. A convergence pass costs vendor calls against
// a live tenant's project; it happens because somebody decided it should.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { enqueueCloneBackendProvisioning } from "@/server/backend-provisioning.server";
import { writeAuditLog } from "@/server/audit.server";

const admin = supabaseAdmin;

export const Route = createFileRoute("/hooks/backend-provisioning-repair")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;

        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          });

        let body: { cloneId?: string };
        try {
          body = (await request.json()) as { cloneId?: string };
        } catch {
          return json({ success: false, error: "body must be JSON" }, 400);
        }
        const cloneId = typeof body?.cloneId === "string" ? body.cloneId.trim() : "";
        if (!cloneId) return json({ success: false, error: "cloneId is required" }, 400);

        try {
          const { data: row, error: rowErr } = await admin
            .from("clone_backends")
            .select(
              "clone_id, status, region, admin_email, queued_module_ids, enqueued_by, supabase_project_ref",
            )
            .eq("clone_id", cloneId)
            .maybeSingle();
          if (rowErr) throw new Error(`could not read clone_backends: ${rowErr.message}`);
          if (!row) return json({ success: false, error: "no backend row for this clone" }, 404);

          // Stated here as well as in the enqueue, because this is the message
          // an operator reads and it should name the right lever rather than
          // repeat a generic refusal.
          if (row.status !== "ready") {
            return json(
              {
                success: false,
                error:
                  `backend is '${row.status}', not 'ready' — repair converges a finished backend. ` +
                  (row.status === "failed"
                    ? "Use the retry hook for a failed one."
                    : "One still in flight is already being worked; wait for it to settle."),
              },
              409,
            );
          }
          if (!row.supabase_project_ref) {
            return json(
              {
                success: false,
                error:
                  "this backend names no Supabase project, so there is nothing to converge onto",
              },
              409,
            );
          }
          // Same rule as the retry hook: `enqueued_by` is a uuid column and
          // the enqueue writes its actor verbatim, so the pass is attributed
          // to the original enqueuer. A literal "system" is refused by the
          // column itself.
          if (!row.enqueued_by) {
            return json(
              {
                success: false,
                error:
                  "backend row records no original enqueuer to attribute the repair to — re-provision from the clone page instead",
              },
              409,
            );
          }

          const { data: clone, error: cloneErr } = await admin
            .from("clones")
            .select("id, name")
            .eq("id", cloneId)
            .maybeSingle();
          if (cloneErr) throw new Error(`could not read clones: ${cloneErr.message}`);
          if (!clone) return json({ success: false, error: "clone not found" }, 404);

          const enq = await enqueueCloneBackendProvisioning(admin, row.enqueued_by, {
            cloneId,
            cloneName: clone.name,
            region: row.region ?? undefined,
            adminEmail: row.admin_email ?? "",
            // No credential travels with a repair: nothing is seeded, and
            // minting one here would be minting a password for an account that
            // already belongs to somebody.
            adminPassword: null,
            repair: true,
            moduleIds: (row.queued_module_ids as string[] | null) ?? [],
          });
          if (!enq.ok) return json({ success: false, error: enq.error }, 409);

          await writeAuditLog({
            action: "clone_backend.repair_enqueued",
            entityType: "clone",
            entityId: cloneId,
            metadata: {
              via: "hooks/backend-provisioning-repair",
              project_ref: row.supabase_project_ref,
            },
          });

          return json({ success: true, queued: true, repair: true, cloneId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "repair_failed";
          console.error("backend-provisioning-repair failed:", msg);
          return json({ success: false, error: msg }, 500);
        }
      },
    },
  },
});
