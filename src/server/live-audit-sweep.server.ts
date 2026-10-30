// The live audit's sweep: what the callbacks cannot say for themselves.
// Server-only; /hooks/live-audit-sweep runs it every ten minutes.
//
// A run is reported by its own workflow, and three things stop that report
// ever arriving: a dispatch GitHub refused, a workflow that never started, and
// a job that was cancelled or timed out — GitHub runs no `if: failure()` step
// for either. Each leaves a run in flight, and a run in flight blocks the next
// one (`live_audit_runs_one_active`). The sweep retries the first and fails
// the other two, saying which, so nothing waits on a run that is not coming.
//
// Then the fixes: the latest completed run's, once (when automatic fixes are
// on and the Anthropic key is configured); fix workflows that went silent; and
// the fix pull requests the GitHub webhook did not report.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/json-cast";
import { alertOnRunFailed } from "@/server/live-audit-alerts.server";
import { MAX_DISPATCH_ATTEMPTS, dispatchLiveAuditRun } from "@/server/live-audit-dispatch.server";
import {
  dispatchAutomaticLiveAuditFixes,
  failSilentLiveAuditFixes,
  refreshLiveAuditFixPrs,
} from "@/server/live-audit-fix.server";
import { pruneLiveAuditReceipts } from "@/server/live-audit-keys.server";

const admin = supabaseAdmin;

/** A dispatched run whose workflow has not said it started by now never will. */
export const START_TIMEOUT_MINUTES = 45;
/** The audit job's 90-minute limit, the session job before it, and slack. */
export const RUN_TIMEOUT_MINUTES = 110;
/** A queued run whose first dispatch died with the request that made it. */
export const ORPHANED_QUEUE_MINUTES = 10;

export type SweepRun = {
  id: string;
  status: string;
  dispatch_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  dispatched_at: string | null;
  started_at: string | null;
};

export type SweepAction =
  | { act: "redispatch" }
  | { act: "fail"; reason: string; event: string }
  | null;

/** What the sweep does with one run in flight. Pure. */
export function sweepVerdict(run: SweepRun, now: number): SweepAction {
  const ageMin = (iso: string | null) => (iso ? (now - Date.parse(iso)) / 60_000 : Infinity);
  if (run.status === "queued") {
    if (run.dispatch_attempts >= MAX_DISPATCH_ATTEMPTS) {
      return {
        act: "fail",
        event: "run.dispatch_failed",
        reason: `GitHub refused the dispatch ${run.dispatch_attempts} times. Last: ${run.last_error ?? "no detail"}`,
      };
    }
    if (run.next_attempt_at)
      return Date.parse(run.next_attempt_at) <= now ? { act: "redispatch" } : null;
    return ageMin(run.created_at) >= ORPHANED_QUEUE_MINUTES ? { act: "redispatch" } : null;
  }
  if (run.status === "dispatched") {
    if (ageMin(run.dispatched_at ?? run.created_at) < START_TIMEOUT_MINUTES) return null;
    return {
      act: "fail",
      event: "run.never_started",
      reason:
        `The workflow did not report starting within ${START_TIMEOUT_MINUTES} minutes of its dispatch: ` +
        "it was cancelled, is still waiting for a runner, or failed before it could call back. See Prime's Actions.",
    };
  }
  if (run.status === "running") {
    if (ageMin(run.started_at ?? run.dispatched_at ?? run.created_at) < RUN_TIMEOUT_MINUTES)
      return null;
    return {
      act: "fail",
      event: "run.timed_out",
      reason:
        `The runner has not finished ${RUN_TIMEOUT_MINUTES} minutes after it started, past the job's own limit: ` +
        "it was cancelled or timed out. Findings it already reported are kept; nothing was resolved by absence.",
    };
  }
  return null;
}

export type LiveAuditReconcileResult = {
  /** Runs due a re-dispatch, for `advanceLiveAudit` once the budget allows. */
  redispatch: string[];
  failed: Array<{ id: string; reason: string }>;
  errors: string[];
  receiptsPruned: number | null;
  silentFixes: { failed: string[]; error?: string };
};

/**
 * The half that reads and writes only the database: runs that will never
 * report are failed, silent fixes are failed, old receipts go. It runs whether
 * or not GitHub's window has room — a starved window must never look like a
 * healthy queue.
 */
export async function reconcileLiveAudit(now = Date.now()): Promise<LiveAuditReconcileResult> {
  const result: LiveAuditReconcileResult = {
    redispatch: [],
    failed: [],
    errors: [],
    receiptsPruned: null,
    silentFixes: { failed: [] },
  };

  const { data: runs, error } = await admin
    .from("live_audit_runs")
    .select(
      "id, status, dispatch_attempts, next_attempt_at, last_error, created_at, dispatched_at, started_at",
    )
    .in("status", ["queued", "dispatched", "running"])
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) result.errors.push(`runs not read: ${error.message}`);

  for (const run of (runs ?? []) as SweepRun[]) {
    const verdict = sweepVerdict(run, now);
    if (!verdict) continue;
    if (verdict.act === "redispatch") {
      result.redispatch.push(run.id);
      continue;
    }
    // Conditional on the status read: a callback that lands meanwhile wins.
    const { data: moved, error: upErr } = await admin
      .from("live_audit_runs")
      .update({
        status: "failed",
        last_error: verdict.reason.slice(0, 2000),
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .eq("status", run.status)
      .select("id");
    if (upErr) {
      result.errors.push(`${run.id}: not failed: ${upErr.message}`);
      continue;
    }
    if (!moved?.length) continue;
    result.failed.push({ id: run.id, reason: verdict.reason });
    const { error: evErr } = await admin.from("live_audit_events").insert({
      run_id: run.id,
      event_type: verdict.event,
      from_state: run.status,
      to_state: "failed",
      reason: verdict.reason.slice(0, 2000),
      payload: asJson({ swept: true, dispatch_attempts: run.dispatch_attempts }),
    });
    if (evErr) console.warn("[live-audit-sweep] event not recorded:", evErr.message);
    await alertOnRunFailed(run.id);
  }

  result.receiptsPruned = await pruneLiveAuditReceipts().catch((err) => {
    result.errors.push(`receipts not pruned: ${(err as Error).message}`);
    return null;
  });
  result.silentFixes = await failSilentLiveAuditFixes().catch((err) => ({
    failed: [],
    error: err instanceof Error ? err.message : String(err),
  }));
  return result;
}

export type LiveAuditAdvanceResult = {
  redispatched: string[];
  errors: string[];
  autofix: { ran: boolean; reason?: string; dispatched?: number };
  prs: { checked: number; merged: number; closed: number; error?: string };
};

/**
 * The half that spends the App installation's window: re-dispatches, the
 * latest run's automatic fixes, and the fix pull requests the webhook missed.
 * Its caller has already asked the budget.
 */
export async function advanceLiveAudit(redispatch: string[]): Promise<LiveAuditAdvanceResult> {
  const redispatched: string[] = [];
  const errors: string[] = [];
  for (const id of redispatch) {
    const r = await dispatchLiveAuditRun(id);
    if (r.ok) redispatched.push(id);
    else errors.push(`${id}: ${r.error}`);
  }
  const autofix = await dispatchAutomaticLiveAuditFixes().catch((err) => ({
    ran: false,
    reason: err instanceof Error ? err.message : String(err),
  }));
  const prs = await refreshLiveAuditFixPrs().catch((err) => ({
    checked: 0,
    merged: 0,
    closed: 0,
    error: err instanceof Error ? err.message : String(err),
  }));
  return { redispatched, errors, autofix, prs };
}
