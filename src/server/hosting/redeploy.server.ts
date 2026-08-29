/**
 * Asking for a rebuild after code lands in a clone's repository.
 *
 * The decision is `decideRedeploy`; this is the write. Two things about it are
 * deliberate.
 *
 * It never throws. The caller is the cascade engine, mid-loop over every clone
 * in scope, and a cascade that pushed code correctly must not be reported as
 * failed because a hosting row could not be updated. The failure is recorded in
 * `deployment_events` instead, where it belongs.
 *
 * It never creates a row. `upsert` here would enrol every clone a cascade
 * touches into hosting — see the policy module.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asRow } from "@/lib/json-cast";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { decideRedeploy, type RedeploySkipReason } from "./redeployPolicy.pure";
import type { DeploymentStatus } from "./deploymentState.pure";

const admin = supabaseAdmin;

export type RedeployRequest =
  | { queued: true; resumedAt: "pending" | "deploying"; from: DeploymentStatus }
  | { queued: false; reason: RedeploySkipReason | "db_error" };

export async function requestRedeployAfterPush(input: {
  cloneId: string;
  /** Free text for the audit trail — "cascade #123", "module sync", … */
  reason: string;
  sha?: string | null;
}): Promise<RedeployRequest> {
  const { data: row, error: readErr } = await admin
    .from("clone_deployments")
    .select("clone_id, status, project_id, provider_slug")
    .eq("clone_id", input.cloneId)
    .maybeSingle();

  // A read that FAILED is not a row that is ABSENT. Treating an error as "no
  // deployment" would silently stop rebuilding the whole fleet the moment the
  // table became briefly unreadable, and nothing would report it.
  if (readErr) return { queued: false, reason: "db_error" };
  if (!row) return { queued: false, reason: "no_deployment_row" };

  const decision = decideRedeploy({
    status: row.status as DeploymentStatus,
    hasProject: Boolean(row.project_id),
  });
  if (!decision.act) return { queued: false, reason: decision.reason };

  const patch: Record<string, unknown> = {
    status: decision.resumeAt,
    // STAMPED HERE, and this line is load-bearing.
    //
    // `status_since` is what `judgeWait` measures a wait against, and only the
    // drain used to write it — so a rebuild requested from outside the drain
    // moved the status and left the timestamp on whenever the row last changed
    // state there. The next pass then measured "how long has this been
    // deploying" from that stale value and, past STUCK_HOURS, declared a build
    // that had existed for seconds to be stuck for six hours.
    //
    // Observed: a clone was moved live -> deploying at 06:00:16 and marked
    // `failed` at 06:01:04 with "Stuck in deploying for more than 6h: Build
    // queued." Its Turnstile site key had just been published, so the rebuild
    // that would have put that key in the bundle never ran, and the clone was
    // left failing closed on a CAPTCHA its browser could not answer.
    //
    // Entering a status IS the thing being timed; whoever moves the row owns
    // the clock.
    status_since: new Date().toISOString(),
    attempts: 0,
    error_message: null,
    status_detail: `Rebuild requested — ${input.reason}.`,
    next_attempt_at: new Date().toISOString(),
    worker_started_at: null,
    worker_finished_at: null,
  };
  // Cleared so the drain creates a NEW build instead of polling the finished one
  // and concluding it is already ready.
  if (decision.clearDeploymentId) patch.latest_deployment_id = null;

  const { error } = await admin
    .from("clone_deployments")
    .update(asRow<TablesUpdate<"clone_deployments">>(patch))
    .eq("clone_id", input.cloneId);

  await admin.from("deployment_events").insert({
    clone_id: input.cloneId,
    provider_slug: row.provider_slug ?? "vercel",
    action: "request_redeploy",
    from_status: row.status,
    to_status: error ? null : decision.resumeAt,
    success: !error,
    error_message: error?.message ?? null,
    // `payload`, not `detail`. `deployment_events` has no `detail` column, and
    // PostgREST answers 42703 for the WHOLE insert when a name is wrong — so a
    // mistyped column here would lose every redeploy audit row, silently,
    // because this insert's error is deliberately not fatal.
    payload: { reason: input.reason, sha: input.sha ?? null },
  });

  if (error) return { queued: false, reason: "db_error" };
  return { queued: true, resumedAt: decision.resumeAt, from: row.status as DeploymentStatus };
}

/**
 * Rebuild a clone because its ENVIRONMENT changed, not its code.
 *
 * `requestRedeployAfterPush` resumes at `deploying`, which is right for a push:
 * the env is already correct and re-syncing it would spend a rate-limited write
 * to no effect. It is wrong for an environment change, and expensively so —
 * `deploying` SKIPS `syncing_env`, the only step that pushes `buildCloneEnv`'s
 * output to the provider, so the rebuild runs against whatever the project
 * already had.
 *
 * That is not hypothetical. A clone's Turnstile site key was published straight
 * to the hosting project and a rebuild requested from `live`; the build
 * completed READY and emitted a BYTE-IDENTICAL bundle, because Vite inlines
 * `VITE_*` at build time and the value was not in the build's environment. The
 * clone was left failing closed on a CAPTCHA whose site key its own browser had
 * never been given.
 *
 * So an environment change rewinds one step further, and clears `env_digest` so
 * the sync cannot skip itself as unchanged.
 */
export async function requestEnvResync(input: {
  cloneId: string;
  reason: string;
}): Promise<RedeployRequest> {
  const { data: row, error: readErr } = await admin
    .from("clone_deployments")
    .select("clone_id, status, project_id, provider_slug")
    .eq("clone_id", input.cloneId)
    .maybeSingle();

  if (readErr) return { queued: false, reason: "db_error" };
  if (!row) return { queued: false, reason: "no_deployment_row" };

  // The same policy decides WHETHER to act — a declined, detached or
  // unconfigured clone is no more rebuildable for an env change than for a
  // push. Only the resume point differs.
  const decision = decideRedeploy({
    status: row.status as DeploymentStatus,
    hasProject: Boolean(row.project_id),
  });
  if (!decision.act) return { queued: false, reason: decision.reason };

  const nowIso = new Date().toISOString();
  const { error } = await admin
    .from("clone_deployments")
    .update(
      asRow<TablesUpdate<"clone_deployments">>({
        status: "syncing_env",
        status_since: nowIso,
        // Null, not stale: `syncing_env` skips itself when the digest matches
        // what it last pushed, and the whole point of this call is that the
        // environment has changed underneath that digest.
        env_digest: null,
        latest_deployment_id: null,
        attempts: 0,
        error_message: null,
        status_detail: `Environment re-sync requested — ${input.reason}.`,
        next_attempt_at: nowIso,
        worker_started_at: null,
        worker_finished_at: null,
      }),
    )
    .eq("clone_id", input.cloneId);

  await admin.from("deployment_events").insert({
    clone_id: input.cloneId,
    provider_slug: row.provider_slug ?? "vercel",
    action: "request_env_resync",
    from_status: row.status,
    to_status: error ? null : "syncing_env",
    success: !error,
    error_message: error?.message ?? null,
    payload: { reason: input.reason },
  });

  if (error) return { queued: false, reason: "db_error" };
  return { queued: true, resumedAt: "pending", from: row.status as DeploymentStatus };
}
