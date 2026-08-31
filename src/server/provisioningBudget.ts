/**
 * The invocation budget for long-running provisioning work.
 *
 * Backend provisioning runs inside a pg_cron-invoked HTTP request whose
 * lifetime is NOT the pipeline's: pg_net stops waiting at 60 seconds and the
 * hosting runtime reclaims the worker soon after. The pipeline takes minutes.
 * The first engine-provisioned clone (30 Aug 2026 dry run) proved what that
 * mismatch does: three consecutive invocations died mid
 * "Snapshotting backend architecture", each one restarted from zero, and the
 * job exhausted its attempts having made no forward progress at all.
 *
 * The prime already owns this pattern — its investment-report pipeline
 * "survives by stopping at a wall-clock budget and being resumed"
 * (docs/reports/INVESTMENT_REPORT_RESUME.md). This module is that rule for
 * provisioning: work checks the deadline BETWEEN units, and when it is due it
 * throws `BudgetPause` instead of dying mid-flight. The drain treats a pause
 * as forward progress (requeue, attempts reset), a crash as an attempt
 * (requeue, attempts kept), and only repeated no-progress crashes exhaust.
 *
 * Its own module so both `backend-provisioning.server.ts` and
 * `schema-introspection.server.ts` can import it without creating a cycle —
 * the former already dynamic-imports the latter.
 */
export class BudgetPause extends Error {
  /** What the pipeline was about to do when the budget ran out. */
  readonly detail: string;

  /**
   * Where to pick the schema build up next time, when the pause happened
   * inside introspection. Carried on the pause rather than parsed back out of
   * `detail`, because prose is for the operator and control state is not.
   *
   * Undefined when the pause happened somewhere with no stage to name (the
   * health wait, the edge-function deploys); the caller then leaves the stored
   * marker alone rather than guessing.
   */
  readonly resumeStage?: string;

  constructor(detail: string, resumeStage?: string) {
    super(`Provisioning paused at the invocation budget — ${detail}`);
    this.name = "BudgetPause";
    this.detail = detail;
    this.resumeStage = resumeStage;
  }
}

/** True when `deadlineAt` is set and the clock has passed it. */
export function pastDeadline(deadlineAt: number | null | undefined): boolean {
  return typeof deadlineAt === "number" && Date.now() >= deadlineAt;
}
