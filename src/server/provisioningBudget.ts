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

/**
 * Whether a thrown error is an upstream API refusing us on a QUOTA, rather
 * than anything about this job.
 *
 * The 31 Aug 2026 dry run died here. Backend provisioning reads the prime's
 * repository through the GitHub App installation, and a resumed pass re-reads
 * it — so after a night of recycling, GitHub answered
 * "API rate limit exceeded for installation ID …". The pipeline treated that
 * as a hard death, spent the attempt, and the third one terminated a job whose
 * own work had never failed: `attempts: 3`, `status: failed`, 640 of 648
 * tables already replicated and standing.
 *
 * That is the wrong charge. An attempt is meant to measure "this job cannot
 * make progress"; a quota measures how much OTHER work the installation has
 * done this hour, resets on somebody else's clock, and says nothing about
 * whether the pipeline would succeed. Retrying is exactly right, and it must
 * be free.
 *
 * It is deliberately NOT a `BudgetPause`: a pause means this invocation
 * carried work forward and the next one resumes after it. Nothing was carried
 * here. The distinction matters because a pause resets `attempts` to zero
 * while this one hands back the single attempt it took, so a genuine failure
 * that happened earlier still counts.
 *
 * The recycling is bounded by the wall-clock ceiling in `reclaimStalled`, not
 * by attempts — which is the reason that ceiling exists.
 *
 * A 403 alone is not enough: GitHub answers 403 for "you may not read this
 * repository" too, and requeuing that for three hours would hide a permission
 * fault behind a quota message. The message has to name the limit.
 */
export function isUpstreamRateLimit(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const status = (error as { status?: unknown }).status;
  // 429 is unambiguous wherever it comes from.
  if (status === 429) return true;

  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") return false;

  // GitHub's two spellings, plus the generic one. Anchored on the phrase
  // rather than on a vendor, because Supabase's Management API answers the
  // same way and this pipeline calls both.
  return (
    /\brate limit\b/i.test(message) &&
    /\b(exceed|exceeded|hit|reached|too many requests)\b/i.test(message)
  );
}
