// Backend provisioning worker — drains queued clone_backends jobs.
//
// This route exists because backend provisioning takes minutes and must
// NOT depend on the browser request staying open. The wizard enqueues a
// row (status='pending', queued_admin_password_enc set) and this drainer,
// invoked by pg_cron every minute (Bearer via verifyCronAuth), claims and
// processes it.
//
// Concurrency safety:
//  - Atomic claim: UPDATE ... WHERE status='pending' AND worker_started_at IS NULL
//  - Stall reclaim: unfinished rows whose worker_started_at is older than
//    STALL_MINUTES are reset to pending — STATUS and timestamp both, because
//    the claim reads status (previous Worker invocation likely timed out).
//    A stall on the final attempt is terminated as failed instead of queued.
//  - Serial per invocation (CONCURRENCY=1): provisioning is heavy, we'd
//    rather burn wall clock than saturate the Supabase Management API.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import { decryptSecret } from "@/server/crypto.server";
import { runQueuedBackendProvisioning } from "@/lib/backend-provisioning.functions";

const admin = supabaseAdmin;
const STALL_MINUTES = 15;
const MAX_JOBS_PER_RUN = 2;
const MAX_ATTEMPTS = 3;

// How long ONE invocation of this route may work before the pipeline pauses
// at a stage boundary. pg_net stops waiting at 60s and the hosting runtime
// reclaims the worker soon after, so an unbudgeted run dies mid-write with no
// record — which is exactly how the first engine-provisioned clone burned all
// three attempts on one step. A pause is requeued as forward progress
// (attempts reset to 0); only a hard death costs an attempt.
const INVOCATION_BUDGET_MS = 50_000;

// The global bound the attempt-neutral recycling answers to: a backend that
// has been in flight this long is not "still going", whatever each individual
// invocation reports. Judged on PARKED rows only (worker_started_at null) so
// a live invocation is never failed under its own feet — the next tick
// catches it parked. clone_deployments has the same idea as STUCK_HOURS.
const CEILING_HOURS = 3;

const IN_FLIGHT_STATUSES = ["provisioning", "migrating", "seeding_admin"] as const;

async function reclaimStalled() {
  const cutoff = new Date(Date.now() - STALL_MINUTES * 60 * 1000).toISOString();
  const requeue = {
    status: "pending" as const,
    worker_started_at: null,
    status_detail: "Worker stalled — requeued",
  };

  // A requeue is a STATUS, not a sentence. Until 30 Aug 2026 this update
  // reset `worker_started_at` alone and wrote "requeued" while leaving
  // `status` wherever the dead worker had moved it — and claimOne() takes
  // only `status = 'pending'`, so a run that died at 'provisioning',
  // 'migrating' or 'seeding_admin' was requeued in words and frozen in
  // state: the first engine-provisioned clone stalled mid "Snapshotting
  // backend architecture" and sat untouched for an hour against a
  // one-minute drain. The cascade drain's reclaim already resets both
  // fields, for this exact reason. Re-entry from pending is safe by
  // design: drainOne's retry branch already does it, and the pipeline
  // resumes onto an existing `supabase_project_ref` rather than creating
  // a second project.
  //
  // Each update is checked and THROWS, for the same reason the claim
  // does: a reclaim that half-happened is invisible exactly when it
  // matters, and the route's catch turns a throw into a non-200 that
  // `cron_delivery_health()` can see.
  const { error: stalledErr } = await admin
    .from("clone_backends")
    .update(requeue)
    .lt("worker_started_at", cutoff)
    .is("worker_finished_at", null)
    .in("status", ["pending", ...IN_FLIGHT_STATUSES]);
  if (stalledErr) {
    throw new Error(`backend-provisioning reclaim: stalled claims: ${stalledErr.message}`);
  }

  // Rows the pre-fix reclaim already touched are out of reach of the
  // update above — it nulled `worker_started_at`, and NULL is never
  // `.lt()` anything — so they are recognised by shape instead: an
  // in-flight status with no claim timestamp belongs to no live worker
  // (claimOne stamps `worker_started_at` before any status moves, and
  // only a requeue nulls it). Idempotent noise once the damaged rows
  // are gone.
  const { error: orphanErr } = await admin
    .from("clone_backends")
    .update(requeue)
    .is("worker_started_at", null)
    .is("worker_finished_at", null)
    .in("status", IN_FLIGHT_STATUSES);
  if (orphanErr) {
    throw new Error(`backend-provisioning reclaim: orphaned rows: ${orphanErr.message}`);
  }

  // A stall on the final attempt TERMINATES rather than queues: claimOne's
  // `attempts < MAX_ATTEMPTS` filter would skip the row for ever, which is
  // the same lie — "requeued" on a row nothing will take — one step later.
  // The failure path already terminates exhaustion (drainOne stamps
  // worker_finished_at, the pipeline's catch writes 'failed'); this is the
  // stall path's copy of that rule, clearing the queued password exactly
  // as drainOne's terminal branch does. Enqueueing again from the clone
  // page resets attempts to 0, so the remedy in the message is real.
  const { error: exhaustedErr } = await admin
    .from("clone_backends")
    .update({
      status: "failed",
      worker_finished_at: new Date().toISOString(),
      queued_admin_password_enc: null,
      error_message:
        `Provisioning worker stalled ${MAX_ATTEMPTS} times — each run died before finishing. ` +
        `Check the drain's delivery health, then retry from the clone page (retrying re-queues with fresh attempts).`,
      status_detail: "Worker stalled — attempts exhausted",
    })
    .eq("status", "pending")
    .is("worker_started_at", null)
    .is("worker_finished_at", null)
    .gte("attempts", MAX_ATTEMPTS);
  if (exhaustedErr) {
    throw new Error(`backend-provisioning reclaim: exhausted rows: ${exhaustedErr.message}`);
  }

  // The ceiling. Budget pauses recycle attempt-neutrally on purpose, so
  // `attempts` no longer bounds a job that keeps proving liveness without
  // finishing — wall clock does. Parked rows only (see CEILING_HOURS).
  const ceilingCutoff = new Date(Date.now() - CEILING_HOURS * 3600 * 1000).toISOString();
  const { error: ceilingErr } = await admin
    .from("clone_backends")
    .update({
      status: "failed",
      worker_finished_at: new Date().toISOString(),
      queued_admin_password_enc: null,
      error_message:
        `Provisioning has been in flight for over ${CEILING_HOURS} hours without finishing. ` +
        `Check the drain's delivery health and the clone's status history, then retry from the clone page.`,
      status_detail: "Provisioning ceiling exceeded",
    })
    .lt("queued_at", ceilingCutoff)
    .is("worker_started_at", null)
    .is("worker_finished_at", null)
    .in("status", ["pending", ...IN_FLIGHT_STATUSES]);
  if (ceilingErr) {
    throw new Error(`backend-provisioning reclaim: ceiling: ${ceilingErr.message}`);
  }
}

/**
 * Claim one job.
 *
 * A READ THAT FAILED IS NOT A QUEUE THAT IS EMPTY, and a CLAIM that failed is
 * not a race that was lost. PostgREST resolves to `{ data: null, error }` on any
 * failure, and `data: null` is also what both of those normal outcomes look
 * like — so a database fault returned "nothing to do", the worker reported
 * success, and `clone_backends` stayed at `pending` showing the operator
 * "Queued — background worker will start within ~60 seconds" for ever. That is
 * the same sentence this worker's absence produced, which is exactly why it
 * must not be reachable a second way. Inert until now only because the job was
 * never scheduled.
 *
 * A genuine failure THROWS: the route's catch turns it into a non-200 that
 * lands in `net._http_response`, where `cron_delivery_health()` can see it.
 */
async function claimOne(): Promise<null | {
  clone_id: string;
  queued_admin_password_enc: string | null;
  queued_module_ids: string[] | null;
  admin_email: string | null;
  region: string | null;
  enqueued_by: string | null;
  attempts: number;
}> {
  const nowIso = new Date().toISOString();
  const { data: candidates, error: selectError } = await admin
    .from("clone_backends")
    .select("clone_id, attempts")
    .eq("status", "pending")
    .is("worker_started_at", null)
    .not("queued_admin_password_enc", "is", null)
    .lt("attempts", MAX_ATTEMPTS)
    .order("queued_at", { ascending: true, nullsFirst: false })
    .limit(1);
  if (selectError) {
    throw new Error(`backend-provisioning claim: could not read the queue: ${selectError.message}`);
  }
  if (!candidates?.length) return null;
  const target = candidates[0];
  const { data: claimed, error: claimError } = await admin
    .from("clone_backends")
    .update({
      worker_started_at: nowIso,
      attempts: (target.attempts ?? 0) + 1,
      status_detail: "Worker claimed job",
    })
    .eq("clone_id", target.clone_id)
    .eq("status", "pending")
    .is("worker_started_at", null)
    .select(
      "clone_id, queued_admin_password_enc, queued_module_ids, admin_email, region, enqueued_by, attempts",
    )
    .maybeSingle();
  // Losing the race returns no row and no error. A fault is not that.
  if (claimError) {
    throw new Error(
      `backend-provisioning claim: could not claim ${target.clone_id}: ${claimError.message}`,
    );
  }
  return claimed ?? null;
}

async function drainOne(
  deadlineAt: number,
): Promise<{ processed: boolean; ok?: boolean; error?: string; budgetPaused?: boolean }> {
  const claimed = await claimOne();
  if (!claimed) return { processed: false };

  const { data: clone } = await admin
    .from("clones")
    .select("name")
    .eq("id", claimed.clone_id)
    .maybeSingle();

  if (!clone) {
    await admin
      .from("clone_backends")
      .update({
        status: "failed",
        error_message: "Clone row not found",
        worker_finished_at: new Date().toISOString(),
      })
      .eq("clone_id", claimed.clone_id);
    return { processed: true, ok: false, error: "clone_not_found" };
  }

  let adminPassword: string;
  try {
    adminPassword = decryptSecret(claimed.queued_admin_password_enc!);
  } catch (e) {
    await admin
      .from("clone_backends")
      .update({
        status: "failed",
        error_message: "Could not decrypt queued admin password",
        worker_finished_at: new Date().toISOString(),
        queued_admin_password_enc: null,
      })
      .eq("clone_id", claimed.clone_id);
    return { processed: true, ok: false, error: "decrypt_failed" };
  }

  const result = await runQueuedBackendProvisioning({
    cloneId: claimed.clone_id,
    cloneName: clone.name,
    region: claimed.region ?? undefined,
    adminEmail: claimed.admin_email ?? "",
    adminPassword,
    moduleIds: claimed.queued_module_ids ?? [],
    actorUserId: claimed.enqueued_by ?? null,
    deadlineAt,
  });

  // A budget pause is forward progress, not a failed attempt: the pipeline
  // exited cleanly at a stage boundary and everything done so far survives a
  // resume. Requeue with attempts RESET, so only consecutive hard deaths —
  // runs that never reach a boundary — accumulate towards MAX_ATTEMPTS. The
  // wall-clock ceiling in reclaimStalled() bounds the recycling.
  const budgetPaused = !result.ok && result.retryable === true && result.progressed === true;

  // Clear the queued password whether we succeeded or exhausted retries.
  const isTerminal = result.ok || (!budgetPaused && claimed.attempts >= MAX_ATTEMPTS);
  await admin
    .from("clone_backends")
    .update({
      worker_finished_at: isTerminal ? new Date().toISOString() : null,
      queued_admin_password_enc: isTerminal ? null : claimed.queued_admin_password_enc,
      // If we failed but still have retries left, allow another worker to claim.
      worker_started_at: !result.ok && !isTerminal ? null : undefined,
      status: !result.ok && !isTerminal ? "pending" : undefined,
      ...(budgetPaused ? { attempts: 0 } : {}),
    })
    .eq("clone_id", claimed.clone_id);

  return {
    processed: true,
    ok: result.ok,
    budgetPaused,
    error: result.ok ? undefined : result.error,
  };
}

export const Route = createFileRoute("/hooks/backend-provisioning-drain")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = verifyCronAuth(request);
        if (!auth.ok) return auth.response;
        try {
          await reclaimStalled();
          // One deadline for the whole invocation: job 2 gets whatever job 1
          // left, and a budget pause ends the invocation — starting another
          // job past the deadline would just die mid-claim.
          const deadlineAt = Date.now() + INVOCATION_BUDGET_MS;
          const results: Array<{ ok?: boolean; error?: string; budgetPaused?: boolean }> = [];
          for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
            if (Date.now() >= deadlineAt) break;
            const r = await drainOne(deadlineAt);
            if (!r.processed) break;
            results.push({ ok: r.ok, error: r.error, budgetPaused: r.budgetPaused });
            if (r.budgetPaused) break;
          }
          return new Response(
            JSON.stringify({ success: true, processed: results.length, results }),
            { headers: { "Content-Type": "application/json" } },
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "drain_failed";
          console.error("backend-provisioning-drain failed:", msg);
          return new Response(JSON.stringify({ success: false, error: msg }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
