// Cascade worker — drains queued cascade_events that were enqueued but never
// executed synchronously (e.g. provision-time module cascades). Runs every
// minute via pg_cron with Bearer(cron_secret) auth.
//
// Only auto-merge events with requires_approval=false are picked up so we
// never bypass approvals. Approval-gated cascades still execute via the
// existing approval UI path.
//
// Concurrency safety mirrors hooks.backend-provisioning-drain:
//  - Atomic claim: UPDATE ... WHERE status='pending' AND worker_started_at IS NULL
//  - Stall reclaim: rows stuck in 'running' past STALL_MINUTES are requeued.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { executeCascade, type CascadeBudget } from "@/server/cascade-engine.server";

const admin = supabaseAdmin;
const STALL_MINUTES = 10;
const MAX_JOBS_PER_RUN = 3;
/**
 * Wall clock one invocation may spend on cascades, out of the 60,000 ms the
 * pg_cron `net.http_post` that drives it will wait. The engine asks before
 * each clone whether one more pass like its slowest so far still fits, and a
 * pass that stops here is handed back `pending` with the work it did kept —
 * see `executeCascade`. The remainder is headroom for the reclaim, the claim
 * and the bookkeeping around the run.
 */
const INVOCATION_BUDGET_MS = 45_000;
const MAX_ATTEMPTS = 3;

async function reclaimStalled() {
  const cutoff = new Date(Date.now() - STALL_MINUTES * 60 * 1000).toISOString();

  // Every step below is checked, and a failure THROWS rather than being logged
  // past. A reclaim that half-happened leaves the queue in a state this worker
  // cannot reason about — and the specific way it goes wrong is that the event
  // comes back to `pending` while its results stay at `pushing`, so the re-run
  // finds nothing queued and reports "0 of 0": a success message for work that
  // never happened. Failing the tick is recoverable; pg_cron calls again in a
  // minute and `net._http_response` records the non-200.

  // Rows this worker claimed and then died holding.
  const { error: claimedErr } = await admin
    .from("cascade_events")
    .update({ worker_started_at: null, status: "pending" })
    .lt("worker_started_at", cutoff)
    .is("worker_finished_at", null)
    .in("status", ["pending", "running"]);
  if (claimedErr) {
    throw new Error(`cascade-drain reclaim: stalled claims: ${claimedErr.message}`);
  }

  // And rows NOBODY claimed, because the cascade was executed somewhere else.
  //
  // `executeCascade` is called directly by the GitHub webhook and by the
  // schedule runner; neither sets `worker_started_at`, so the reclaim above --
  // which filters on it -- could never see them. When one of those runs is cut
  // short, and a mirror cascade is long enough that it was, the event sits at
  // `running` for ever with nothing to move it and nothing reporting a failure.
  // Three of them did exactly that: `started_at` set, `worker_started_at` null,
  // `net._http_response.timed_out = true` at 60,000 ms.
  const { error: orphanErr } = await admin
    .from("cascade_events")
    .update({ worker_started_at: null, status: "pending" })
    .is("worker_started_at", null)
    .is("completed_at", null)
    .lt("started_at", cutoff)
    .eq("status", "running");
  if (orphanErr) {
    throw new Error(`cascade-drain reclaim: orphaned runs: ${orphanErr.message}`);
  }

  // The results have to come back with them.
  const { data: revived, error: revivedErr } = await admin
    .from("cascade_events")
    .select("id")
    .eq("status", "pending")
    .is("completed_at", null)
    .lt("started_at", cutoff);
  if (revivedErr) {
    throw new Error(`cascade-drain reclaim: could not list revived events: ${revivedErr.message}`);
  }
  const ids = (revived ?? []).map((r) => r.id);
  if (ids.length > 0) {
    const { error: resultsErr } = await admin
      .from("cascade_results")
      .update({ status: "queued", started_at: null })
      .in("cascade_event_id", ids)
      .in("status", ["pushing"]);
    if (resultsErr) {
      throw new Error(`cascade-drain reclaim: could not requeue results: ${resultsErr.message}`);
    }
  }

  // And a pass that died under an event something else had already moved to
  // a finished status.
  //
  // Measured 2 Sep 2026 14:10: the merge drain's recount rewrote a `running`
  // event to `completed` while its pass was still pushing a clone, the
  // invocation was then cut at 60 s, and the clone's row sat at `pushing` —
  // older than any cutoff — under an event neither rule above would ever
  // look at. The recount no longer does that; this is the rule that heals
  // the rows it left, and any other way a result can be orphaned under a
  // finished event. The row itself is the evidence: a `pushing` result older
  // than the cutoff is a pass that is not running any more, whatever its
  // event says.
  const { data: orphanRows, error: orphanRowsErr } = await admin
    .from("cascade_results")
    .select("id, cascade_event_id")
    .eq("status", "pushing")
    .lt("started_at", cutoff);
  if (orphanRowsErr) {
    throw new Error(
      `cascade-drain reclaim: could not list orphaned results: ${orphanRowsErr.message}`,
    );
  }
  const orphanEventIds = [...new Set((orphanRows ?? []).map((r) => r.cascade_event_id))];
  if (orphanEventIds.length > 0) {
    const { data: finishedEvents, error: finishedErr } = await admin
      .from("cascade_events")
      .select("id")
      .in("id", orphanEventIds)
      .in("status", ["completed", "partial", "failed"]);
    if (finishedErr) {
      throw new Error(
        `cascade-drain reclaim: could not read orphaned events: ${finishedErr.message}`,
      );
    }
    const reviveIds = (finishedEvents ?? []).map((e) => e.id);
    if (reviveIds.length > 0) {
      const { error: reviveErr } = await admin
        .from("cascade_events")
        .update({
          status: "pending",
          worker_started_at: null,
          worker_finished_at: null,
          completed_at: null,
          next_attempt_at: new Date().toISOString(),
        })
        .in("id", reviveIds);
      if (reviveErr) {
        throw new Error(
          `cascade-drain reclaim: could not revive orphaned events: ${reviveErr.message}`,
        );
      }
      const { error: requeueErr } = await admin
        .from("cascade_results")
        .update({ status: "queued", started_at: null })
        .in("cascade_event_id", reviveIds)
        .eq("status", "pushing")
        .lt("started_at", cutoff);
      if (requeueErr) {
        throw new Error(
          `cascade-drain reclaim: could not requeue orphaned results: ${requeueErr.message}`,
        );
      }
    }
  }
}

/**
 * Claim one job.
 *
 * A READ THAT FAILED IS NOT A QUEUE THAT IS EMPTY, and a CLAIM that failed is
 * not a race that was lost. PostgREST resolves to `{ data: null, error }` on any
 * failure, and `data: null` is also what both of those normal outcomes look
 * like — so a database fault returned "nothing to do", the worker reported
 * success, and the queue never drained with nothing anywhere to grep. That is
 * the defect `SCREENING_EXECUTION.md` records in the prime, and it was inert
 * here only because this worker had never been scheduled. It is not inert now.
 *
 * A genuine failure THROWS: the route's catch turns it into a non-200 that
 * lands in `net._http_response`, where `cron_delivery_health()` can see it.
 */
async function claimOne(): Promise<{ id: string; attempts: number } | null> {
  const nowIso = new Date().toISOString();
  const { data: candidates, error: selectError } = await admin
    .from("cascade_events")
    .select("id, attempts")
    .eq("status", "pending")
    .eq("requires_approval", false)
    // Any mode, not just auto_merge.
    //
    // The original filter was justified as "so we never bypass approvals", but
    // `requires_approval = false` above is what actually enforces that, and the
    // mode filter left `pr` cascades with no retry at all: a webhook-driven
    // cascade that died mid-flight was reclaimed to `pending` by the sweep and
    // then skipped for ever by this claim. A `pr` cascade opens a pull request
    // on the clone -- it is the SAFER of the two to retry, not the riskier.
    .is("worker_started_at", null)
    // Not yet: an event a rate limit deferred names the reset it waits for,
    // and one paused at its budget names now(). NOT NULL with a default, so
    // this is one comparison and never an `.or()` string.
    .lte("next_attempt_at", nowIso)
    .lt("attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(1);
  if (selectError) {
    throw new Error(`cascade-drain claim: could not read the queue: ${selectError.message}`);
  }
  if (!candidates?.length) return null;
  const target = candidates[0];
  const { data: claimed, error: claimError } = await admin
    .from("cascade_events")
    .update({
      worker_started_at: nowIso,
      attempts: (target.attempts ?? 0) + 1,
    })
    .eq("id", target.id)
    .eq("status", "pending")
    .is("worker_started_at", null)
    .select("id, attempts")
    .maybeSingle();
  // Losing the race returns no row and no error. A fault is not that.
  if (claimError) {
    throw new Error(`cascade-drain claim: could not claim ${target.id}: ${claimError.message}`);
  }
  return claimed ?? null;
}

async function drainOne(
  budget: CascadeBudget,
): Promise<{ processed: boolean; ok?: boolean; held?: string; error?: string }> {
  const claimed = await claimOne();
  if (!claimed) return { processed: false };

  try {
    const res = await executeCascade(supabaseAdmin, claimed.id, { budget });
    if (res.ok && (res.status === "deferred" || res.status === "resuming")) {
      // The engine has already put the event back to `pending` with the
      // moment it may next be claimed. What is decided here is the ATTEMPT.
      //
      // A deferral never spends one: the limit is GitHub's window, not this
      // event's fault, and `next_attempt_at` already paces the retry. A pause
      // that landed at least one clone is refunded too — a pass that is
      // progressing is not a pass that is failing, which is the rule the
      // provisioning ceiling learned the hard way. A pause that landed NOTHING
      // is the one case that keeps its attempt: a single clone that cannot
      // fit inside the budget would otherwise be retried for ever, quietly,
      // and after the last attempt it has to be said rather than left
      // `pending` with no claim that will ever take it.
      const refund = res.status === "deferred" || res.done > 0;
      if (refund) {
        const { error } = await admin
          .from("cascade_events")
          .update({ attempts: Math.max(0, claimed.attempts - 1) })
          .eq("id", claimed.id);
        if (error) {
          throw new Error(
            `cascade-drain: could not refund the attempt on ${claimed.id}: ${error.message}`,
          );
        }
      } else if (claimed.attempts >= MAX_ATTEMPTS) {
        const { error } = await admin
          .from("cascade_events")
          .update({
            status: "failed",
            worker_finished_at: new Date().toISOString(),
            summary:
              `No clone completed inside the invocation budget in ${MAX_ATTEMPTS} attempts ` +
              `(${res.total} queued). One clone's pass is larger than one tick; it needs splitting.`,
          })
          .eq("id", claimed.id);
        if (error) {
          throw new Error(`cascade-drain: could not fail ${claimed.id}: ${error.message}`);
        }
      }
      return { processed: true, ok: true, held: res.status };
    }
    await admin
      .from("cascade_events")
      .update({ worker_finished_at: new Date().toISOString() })
      .eq("id", claimed.id);
    return { processed: true, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cascade-drain] execute failed for ${claimed.id}:`, msg);
    const terminal = claimed.attempts >= MAX_ATTEMPTS;
    await admin
      .from("cascade_events")
      .update({
        worker_started_at: terminal ? undefined : null,
        worker_finished_at: terminal ? new Date().toISOString() : null,
        status: terminal ? "failed" : "pending",
      })
      .eq("id", claimed.id);
    return { processed: true, ok: false, error: msg };
  }
}

export const Route = createFileRoute("/hooks/cascade-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          const deadlineAt = Date.now() + INVOCATION_BUDGET_MS;
          const budget: CascadeBudget = {
            isPastDeadline: (reserveMs) => Date.now() + reserveMs >= deadlineAt,
          };
          await reclaimStalled();
          const results: Array<{ ok?: boolean; held?: string; error?: string }> = [];
          for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
            if (Date.now() >= deadlineAt) break;
            const r = await drainOne(budget);
            if (!r.processed) break;
            results.push({ ok: r.ok, held: r.held, error: r.error });
          }
          return new Response(
            JSON.stringify({ success: true, processed: results.length, results }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "drain_failed";
          console.error("cascade-drain failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
