/**
 * Whether queuing a clone's backend again re-arms its deployment.
 *
 * A deployment waits on its backend before it creates a hosting project, and
 * when the backend gives up the wait is judged terminal: the deployment is
 * failed `blocked_dependency` and "will not retry without an operator". That
 * is right at the time. It stays right only while the backend stays failed,
 * and nothing re-armed it when the backend was queued again. Measured on
 * `tutorial-demo-orrimere-c158c7`: the deployment failed at 20:58 on 29 Oct
 * with the backend, and three backend retries later it still read failed.
 *
 * So re-queuing a backend re-arms the deployment that failed on its account,
 * and nothing else: a deployment failed for its own reasons, or for being
 * stuck, keeps its failure for an operator, exactly as before.
 */

/** The error a deployment carries when it failed waiting on a backend that gave up. */
export const BLOCKED_ON_BACKEND = "blocked_dependency";

export type DeploymentRearm = {
  /** The status it resumes at. */
  readonly status: "pending" | "syncing_env";
  readonly why: string;
};

/**
 * The status a deployment resumes at, or null when it is not this lane's to re-arm.
 *
 * Resumed where an operator's retry resumes it (`retryCloneDeployment`): from
 * the start when it never got a hosting project, at `syncing_env` when it did.
 */
export function rearmAfterBackendRequeue(row: {
  status: string | null;
  error_message: string | null;
  project_id: string | null;
}): DeploymentRearm | null {
  if (row.status !== "failed" || row.error_message !== BLOCKED_ON_BACKEND) return null;
  return row.project_id
    ? {
        status: "syncing_env",
        why: "its backend was queued again; it has a project, so it resumes at syncing_env",
      }
    : {
        status: "pending",
        why: "its backend was queued again; it never got a project, so it starts over",
      };
}
