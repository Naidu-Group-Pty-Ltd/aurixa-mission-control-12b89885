// Re-queue a FAILED clone backend for the provisioning drain.
//
// The terminal failure states (attempts exhausted, ceiling exceeded, a named
// pipeline error) clear the queued admin password — correctly, since a
// credential must not sit at rest on a row nobody is working. But that made
// every retry a human's job even for a clone the signed-agreement flow
// provisioned autonomously, where nobody holds a password to retype: the
// engine minted the original itself and nobody is ever shown it — the
// platform's password-reset flow is the front door (see
// agreement-provisioning.server.ts). So the retry mints a fresh one the same
// way and goes through the SAME enqueue as the wizard and the agreement flow
// (`enqueueCloneBackendProvisioning` — one implementation, three callers,
// because the upsert IS the contract with the drain).
//
// Auth: CRON_SECRET bearer, the credential every scheduled worker here uses.
// Deliberately NOT on a timer — an automatic retry of a failed provisioning
// is a decision, not a schedule; this route is the decision's lever.
//
// Guard: only a row at `failed` re-queues. `ready` is refused by the enqueue
// itself; anything in flight must never be clobbered mid-run by a fresh
// upsert resetting its attempts and password.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import {
  enqueueCloneBackendProvisioning,
  generateSecurePassword,
} from "@/server/backend-provisioning.server";
import { writeAuditLog } from "@/server/audit.server";

const admin = supabaseAdmin;

export const Route = createFileRoute("/hooks/backend-provisioning-retry")({
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
            .select("clone_id, status, region, admin_email, queued_module_ids, enqueued_by")
            .eq("clone_id", cloneId)
            .maybeSingle();
          if (rowErr) {
            throw new Error(`could not read clone_backends: ${rowErr.message}`);
          }
          if (!row) return json({ success: false, error: "no backend row for this clone" }, 404);
          if (row.status !== "failed") {
            return json(
              {
                success: false,
                error: `backend is '${row.status}', not 'failed' — retry only re-queues a failed backend`,
              },
              409,
            );
          }
          if (!row.admin_email) {
            return json(
              { success: false, error: "backend row has no admin_email to seed with" },
              409,
            );
          }
          // `enqueued_by` is a uuid column and the enqueue writes its actor
          // verbatim, so a retry is attributed to the ORIGINAL enqueuer — the
          // honest reading of "do that enqueue again". The hook's first live
          // call proved a literal "system" is refused by the column itself.
          //
          // A row carrying NO enqueuer used to be REFUSED here, with the
          // operator pointed at the clone page — whose button routes back to
          // this same hook. So a failed backend with no recorded enqueuer had
          // no lever anywhere in the product. Measured 4 Sep 2026: the NPC
          // Client Dashboard clone sat `failed` holding a complete schema —
          // 649 tables, 624 functions, 2,166 indexes — unrecoverable for want
          // of an audit field.
          //
          // The authority to retry is the CRON_SECRET this handler already
          // verified, not this column. Attribution is a record, not a
          // permission: an unknown enqueuer is carried as null (which the
          // column accepts) and SAID in the audit metadata, rather than
          // blocking the repair.
          const attributedTo = row.enqueued_by ?? null;

          const { data: clone, error: cloneErr } = await admin
            .from("clones")
            .select("id, name")
            .eq("id", cloneId)
            .maybeSingle();
          if (cloneErr) throw new Error(`could not read clones: ${cloneErr.message}`);
          if (!clone) return json({ success: false, error: "clone not found" }, 404);

          const enq = await enqueueCloneBackendProvisioning(admin, attributedTo, {
            cloneId,
            cloneName: clone.name,
            region: row.region ?? undefined,
            adminEmail: row.admin_email,
            adminPassword: generateSecurePassword(),
            moduleIds: (row.queued_module_ids as string[] | null) ?? [],
          });
          if (!enq.ok) return json({ success: false, error: enq.error }, 409);

          await writeAuditLog({
            action: "clone_backend.retry_enqueued",
            entityType: "clone",
            entityId: cloneId,
            metadata: {
              via: "hooks/backend-provisioning-retry",
              // Said rather than silently absent: a reader can tell "nobody
              // recorded who first asked" from "this person asked again".
              attributed_to: attributedTo ?? "unknown — the backend row records no original enqueuer",
            },
          });

          return json({ success: true, queued: true, cloneId });
        } catch (e) {
          const msg = e instanceof Error ? e.message : "retry_failed";
          console.error("backend-provisioning-retry failed:", msg);
          return json({ success: false, error: msg }, 500);
        }
      },
    },
  },
});
