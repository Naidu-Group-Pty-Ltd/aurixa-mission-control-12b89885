/**
 * What the backend drain does with a provisioning pass that died.
 *
 * A pass is claimed, works at most one invocation and either finishes, pauses
 * at a stage boundary (`BudgetPause`, attempts reset) or is killed by the
 * runtime with no record at all. A kill was costed as one of the job's three
 * attempts, wherever it happened, and noticed fifteen minutes later.
 *
 * Measured on `tutorial-demo-orrimere-c158c7`, 29–30 Oct 2026: passes were
 * killed at 23:46, 00:02, 00:19, 00:35 and 00:51. The one at 00:35 finished
 * the pg_cron stage every pass before it had died in and reached the realtime
 * publication, and its death still spent an attempt, so the job failed at 01:06
 * while it was converging. Each kill cost a quarter of an hour before the next
 * claim, and the failure said only "Worker stalled — attempts exhausted": where
 * the passes were dying had to be read off the row by hand.
 *
 * Three rules, pure so they can be pinned:
 *
 *  - A death counts only where the job has died before. A pass that dies at a
 *    point this job has never died at got further, or at least somewhere else,
 *    so its attempt is handed back. The points are compared, never parsed: the
 *    point is the last `status_detail` the pass wrote, which is the only record
 *    a killed pass leaves.
 *  - The hand-backs are capped, so a job that keeps dying at new points cannot
 *    recycle for ever on that alone (the drain's 24-hour ceiling still bounds
 *    the rest). Anything that cannot be confirmed — an unreadable history, a
 *    point that was never written — counts, which is the old rule.
 *  - A claim is judged dead once nothing can still be running it. See
 *    `isDeadPass`.
 */

/** The audit action recording one dead pass: where it died, and how it was costed. */
export const PASS_DIED_ACTION = "clone_backend.pass_died";

/**
 * How many deaths at new points one job may have handed back.
 *
 * Six is room for a pipeline that dies a stage further on each pass through
 * the long tail of stages after the schema, and small enough that a job dying
 * at varying points without getting anywhere still fails within the hour at
 * the reclaim cadence below.
 */
export const MAX_PROGRESS_HANDBACKS = 6;

/**
 * A claim this old, whose row has not been written for as long, has no pass.
 *
 * A pass cannot outlive its request: pg_net stops waiting at 150 seconds
 * (`timeout_milliseconds := 150000` on `backend-provisioning-drain-1min`, since
 * `20261031090000_backend_drain_http_patience.sql`) and the hosting runtime
 * cancels a request's work once its client disconnects. Five minutes is twice
 * that, and the silence condition means a row that is still being written is
 * never taken from under a live pass. `backendDrainPatience.contract.test.ts`
 * holds the two apart.
 */
export const DEAD_PASS_SILENT_MINUTES = 5;

/** A claim older than this is dead whatever its row says: the old bound, kept as the backstop. */
export const DEAD_PASS_MAX_MINUTES = 15;

/** What `claimOne` writes, and what a pass that died before its first stage leaves. */
export const CLAIMED_DETAIL = "Worker claimed job";

export type PassDeath = {
  /** The point the pass died at, or null when it left none. */
  readonly point: string | null;
  /** Whether the drain handed that death's attempt back. */
  readonly handedBack: boolean;
};

/**
 * Whether a claimed row has no live pass.
 *
 * `updatedAt` is null only when it could not be read; the claim's age then
 * decides alone, against the backstop.
 */
export function isDeadPass(input: {
  workerStartedAt: string;
  updatedAt: string | null;
  now: number;
}): boolean {
  const started = Date.parse(input.workerStartedAt);
  if (Number.isNaN(started)) return false;
  const age = input.now - started;
  if (age >= DEAD_PASS_MAX_MINUTES * 60_000) return true;
  if (age < DEAD_PASS_SILENT_MINUTES * 60_000) return false;
  if (input.updatedAt === null) return false;
  const written = Date.parse(input.updatedAt);
  if (Number.isNaN(written)) return false;
  return input.now - written >= DEAD_PASS_SILENT_MINUTES * 60_000;
}

/**
 * The point a dead pass stopped at: the last thing it reported.
 *
 * Null when it reported nothing of its own — the claim's own sentence, or the
 * drain's requeue sentence still standing — because "died before its first
 * stage" is not a place a job can make progress past.
 */
export function deathPointOf(statusDetail: string | null | undefined): string | null {
  const point = (statusDetail ?? "").replace(/\s+/g, " ").trim();
  if (point === "" || point === CLAIMED_DETAIL) return null;
  if (point.startsWith("Worker stalled")) return null;
  return point.length > 300 ? point.slice(0, 300) : point;
}

/**
 * Whether this death's attempt is handed back.
 *
 * `history` is every earlier death of the same job, oldest first, or null when
 * it could not be read — which counts the death, because a history nobody
 * could read cannot show that the point is new.
 */
export function judgeDeadPass(input: {
  point: string | null;
  history: readonly PassDeath[] | null;
}): { handBack: boolean; why: string } {
  if (input.point === null) {
    return { handBack: false, why: "it died before reporting a stage" };
  }
  if (input.history === null) {
    return { handBack: false, why: "the job's earlier deaths could not be read" };
  }
  if (input.history.some((d) => d.point === input.point)) {
    return { handBack: false, why: "the job has died at this point before" };
  }
  const handedBack = input.history.filter((d) => d.handedBack).length;
  if (handedBack >= MAX_PROGRESS_HANDBACKS) {
    return {
      handBack: false,
      why: `${handedBack} deaths at new points have already been handed back`,
    };
  }
  return { handBack: true, why: "it died at a point this job had not reached before" };
}

/** The sentence a requeued row carries until the next claim: where its pass died. */
export function requeueDetail(point: string | null): string {
  return point === null
    ? "Worker stalled before its first stage — requeued"
    : `Worker stalled during “${point}” — requeued`;
}

/** The error a job is failed with once its deaths have spent its attempts. */
export function exhaustedMessage(point: string | null, maxAttempts: number): string {
  const where =
    point === null
      ? "The last one died before reporting a stage."
      : `The last one died during “${point}”.`;
  return (
    `Provisioning worker stalled ${maxAttempts} times without getting further — each run died before finishing. ` +
    `${where} Check the drain's delivery health, then retry from the clone page ` +
    `(retrying re-queues with fresh attempts).`
  );
}

/** The deaths recorded in audit metadata, oldest first; malformed rows are skipped. */
export function passDeathsFrom(rows: readonly { metadata: unknown }[]): PassDeath[] {
  const out: PassDeath[] = [];
  for (const row of rows) {
    const m = row.metadata;
    if (!m || typeof m !== "object" || Array.isArray(m)) continue;
    const rec = m as Record<string, unknown>;
    const point = typeof rec.point === "string" ? rec.point : null;
    out.push({ point, handedBack: rec.handed_back === true });
  }
  return out;
}
