import type { TablesUpdate } from "@/integrations/supabase/types";
import { asRow } from "@/lib/json-cast";
import { rearmAfterBackendRequeue, BLOCKED_ON_BACKEND } from "./deploymentRearm.pure";

/**
 * Re-arm the clone's deployment if it failed only because its backend had.
 *
 * Called by every path that queues a backend again, after the queue row is
 * written. Never fails its caller: the backend is queued either way, and a
 * deployment left failed is what an operator's retry was always for. It says
 * what it did, so a caller can report it.
 */
export async function rearmDeploymentBlockedOnBackend(
  cloneId: string,
): Promise<{ rearmed: false; why: string } | { rearmed: true; status: string }> {
  const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
  const { data: row, error: readErr } = await admin
    .from("clone_deployments")
    .select("status, error_message, project_id")
    .eq("clone_id", cloneId)
    .maybeSingle();
  if (readErr) {
    console.error(`[deployment-rearm] could not read ${cloneId}'s deployment:`, readErr.message);
    return { rearmed: false, why: `its deployment could not be read: ${readErr.message}` };
  }
  if (!row) return { rearmed: false, why: "the clone has no deployment" };
  const rearm = rearmAfterBackendRequeue(row);
  if (!rearm)
    return { rearmed: false, why: "its deployment did not fail on the backend's account" };

  const nowIso = new Date().toISOString();
  const { data: updated, error: writeErr } = await admin
    .from("clone_deployments")
    .update(
      asRow<TablesUpdate<"clone_deployments">>({
        status: rearm.status,
        // Whoever moves the status owns its clock (redeployStatusSince): the
        // wait it is about to start is measured from now, not from the hour
        // it failed, or the first wait on the backend reads as six hours stuck.
        status_since: nowIso,
        status_detail: `Re-armed: ${rearm.why}.`,
        error_message: null,
        attempts: 0,
        next_attempt_at: nowIso,
        worker_started_at: null,
        worker_finished_at: null,
      }),
    )
    .eq("clone_id", cloneId)
    // Fenced on what was judged, so a deployment an operator moved meanwhile is left alone.
    .eq("status", "failed")
    .eq("error_message", BLOCKED_ON_BACKEND)
    .select("clone_id");
  if (writeErr) {
    console.error(`[deployment-rearm] could not re-arm ${cloneId}'s deployment:`, writeErr.message);
    return { rearmed: false, why: `its deployment could not be re-armed: ${writeErr.message}` };
  }
  if (!updated || updated.length === 0) {
    return { rearmed: false, why: "its deployment changed before it could be re-armed" };
  }
  return { rearmed: true, status: rearm.status };
}
