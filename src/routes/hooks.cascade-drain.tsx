// Cascade worker — drains queued cascade_events that were enqueued but never
// executed synchronously (e.g. provision-time module cascades). Runs every
// minute via pg_cron with Bearer(cron_secret) auth.
//
// The claim takes ungated events first, then gated events whose approval is
// already recorded. A gate is never bypassed — `requires_approval = false`
// OR a stamped `approved_at` is what the two passes jointly enforce — and
// the second pass is the rescue path: `approveCascade` runs the engine
// inline exactly once, and when that run dies (the 60s hook ceiling has
// taken three mirror cascades), the reclaim reverts the event to
// pending-unclaimed, where a single ungated-only pass would never offer it
// to anyone again.
//
// Concurrency safety mirrors hooks.backend-provisioning-drain:
//  - Atomic claim: UPDATE ... WHERE status='pending' AND worker_started_at IS NULL
//  - Stall reclaim: rows stuck in 'running' past STALL_MINUTES are requeued.
import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { verifyCronAuth } from "@/server/cron-auth.server";
import {
  executeCascade,
  terminaliseOrphanedRows,
  type CascadeBudget,
} from "@/server/cascade-engine.server";
import {
  decideEventFold,
  supersededSummary,
  type FoldableEvent,
} from "@/server/cascade/eventFold.pure";
import { CREATION_ARM_GRACE_MS } from "@/server/cascade/armGrace.pure";
import { beaconSummary, decideDriftBeacon } from "@/server/cascade/driftBeacon.pure";
import { decideExhaustedEvent, retirementSummary } from "@/server/cascade/exhaustedEvents.pure";
import {
  createCascadeForAllClones,
  findCommitCascadeForSha,
} from "@/server/cascade-trigger.server";
import { getAppOctokit } from "@/server/github-app.server";
import { decideSpend } from "@/server/cascade/githubBudget.pure";
import { readGitHubRemaining } from "@/server/githubAllowance.server";

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
  //
  // Keyed on the ROW's own age, not the event's `started_at`. Measured 2 Sep
  // 2026 14:24:02: event e3e2af73 was revived by the rule above on the tick
  // its claim went stale, but its `started_at` — rewritten by the engine at
  // the start of the same pass — sat a second inside the cutoff, so the
  // result the dead pass had left at `pushing` stayed there. The next claim
  // found nothing queued and wrote the event `completed · (of 0)`. A pending,
  // unclaimed event cannot legitimately hold a `pushing` row older than the
  // cutoff, whatever its own timestamps say.
  const { data: revived, error: revivedErr } = await admin
    .from("cascade_events")
    .select("id")
    .eq("status", "pending")
    .is("completed_at", null)
    .is("worker_started_at", null);
  if (revivedErr) {
    throw new Error(`cascade-drain reclaim: could not list revived events: ${revivedErr.message}`);
  }
  const ids = (revived ?? []).map((r) => r.id);
  if (ids.length > 0) {
    const { error: resultsErr } = await admin
      .from("cascade_results")
      .update({ status: "queued", started_at: null })
      .in("cascade_event_id", ids)
      .in("status", ["pushing"])
      .lt("started_at", cutoff);
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
 * Fold the queued commit backlog into one event.
 *
 * Every commit cascade delivers prime's head at run time, so two pending
 * commit events are the same work twice — at ~300 file reads and blob
 * creates per clone each, against the App's hourly budget. Creation now
 * stands a duplicate down (`createCascadeForAllClones`), and this is the
 * other half: whatever backlog predates that rule, or slipped through its
 * race, is folded here before anything is claimed. The OLDEST foldable event
 * survives; the rest are closed with a summary naming it, and their queued
 * results are `skipped` with the same story.
 *
 * `decideEventFold` (cascade/eventFold.pure.ts) owns what may fold: never a
 * manual or scheduled event, never one awaiting approval, never one a worker
 * holds, never one carrying a scope filter, never across modes. The updates
 * below re-check `pending` + unclaimed so a concurrent claim wins the race
 * and the fold simply misses that event this tick.
 */
async function foldQueuedCommitEvents(): Promise<number> {
  const { data, error } = await admin
    .from("cascade_events")
    .select(
      "id, trigger, mode, status, requires_approval, worker_started_at, scope_filter, created_at, attempts",
    )
    .eq("status", "pending")
    .eq("trigger", "commit")
    .is("worker_started_at", null);
  if (error) {
    throw new Error(`cascade-drain fold: could not read the queue: ${error.message}`);
  }
  const fold = decideEventFold((data ?? []) as FoldableEvent[]);
  if (!fold.keep || fold.supersede.length === 0) return 0;

  const now = new Date().toISOString();
  const { data: closed, error: closeErr } = await admin
    .from("cascade_events")
    .update({
      status: "completed",
      completed_at: now,
      worker_finished_at: now,
      summary: supersededSummary(fold.keep),
    })
    .in("id", fold.supersede)
    .eq("status", "pending")
    .is("worker_started_at", null)
    .select("id");
  if (closeErr) {
    throw new Error(`cascade-drain fold: could not close superseded events: ${closeErr.message}`);
  }
  const closedIds = (closed ?? []).map((e) => e.id);
  if (closedIds.length > 0) {
    const { error: resultsErr } = await admin
      .from("cascade_results")
      .update({
        status: "skipped",
        completed_at: now,
        diff_summary: supersededSummary(fold.keep),
      })
      .in("cascade_event_id", closedIds)
      .eq("status", "queued");
    if (resultsErr) {
      throw new Error(
        `cascade-drain fold: could not skip superseded results: ${resultsErr.message}`,
      );
    }
  }
  return closedIds.length;
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
 *
 * `excluded` is the tick's own failure memory: an event whose pass failed in
 * THIS invocation is not offered again by it. Without that, the loop's next
 * iteration re-claims the reverted event immediately — measured twice on
 * 16 Sep 2026 (10:24:02 and 10:45:03), the same carrier burned all three
 * attempts in under a second on one error, leaving no tick boundary for a
 * transient fault (a mid-publish build, a database blip) to clear. One
 * failure per event per tick turns three seconds of death into three
 * minutes of readable, separately-reported attempts.
 */
async function claimOne(
  excluded: ReadonlySet<string>,
): Promise<{ id: string; attempts: number; fence: string } | null> {
  const nowIso = new Date().toISOString();
  // Armed before claimable: every creation site commits the event and its
  // result rows in two separate statements, and this claim once landed
  // inside that gap (807ms, event dd7180c7 — completed "(of 0)" with its
  // three rows stranded a second behind it). The age floor is enforced
  // HERE, once, so a creation site nobody remembers to grace is covered by
  // construction; the engine's unarmed hold is the belt to this brace.
  const armedBefore = new Date(Date.now() - CREATION_ARM_GRACE_MS).toISOString();
  // Two passes over the same predicates, differing only in how the approval
  // gate reads. Pass one is the ordinary queue: no gate. Pass two is the
  // RESCUE path: a gate that a second operator has already discharged.
  // `approveCascade` runs the engine inline exactly once, and when that run
  // dies mid-flight the reclaim reverts the event to pending-unclaimed —
  // where a single `requires_approval = false` pass would never offer it to
  // anyone again, silently and for ever (found by the 16 Sep 2026 gate
  // drill; the gate had never fired naturally, because it needs a fleet
  // larger than three). Two queries, not one `.or()` string — a filter is
  // never composed as a string here.
  //
  // Ungated first: an approved gated event is the rare case and waits behind
  // the ordinary queue rather than jumping it.
  const selectCandidate = async (approvedGated: boolean) => {
    let queue = admin
      .from("cascade_events")
      .select("id, attempts")
      .eq("status", "pending");
    queue = approvedGated
      ? queue.eq("requires_approval", true).not("approved_at", "is", null)
      : queue.eq("requires_approval", false);
    queue = queue
      // Any mode, not just auto_merge.
      //
      // The original filter was justified as "so we never bypass approvals",
      // but the gate predicates above are what actually enforce that, and the
      // mode filter left `pr` cascades with no retry at all: a webhook-driven
      // cascade that died mid-flight was reclaimed to `pending` by the sweep
      // and then skipped for ever by this claim. A `pr` cascade opens a pull
      // request on the clone -- it is the SAFER of the two to retry.
      .is("worker_started_at", null)
      // Not yet: an event a rate limit deferred names the reset it waits for,
      // and one paused at its budget names now(). NOT NULL with a default, so
      // this is one comparison and never an `.or()` string.
      .lte("next_attempt_at", nowIso)
      .lt("attempts", MAX_ATTEMPTS)
      .lt("created_at", armedBefore);
    if (excluded.size > 0) {
      queue = queue.not("id", "in", `(${[...excluded].join(",")})`);
    }
    const { data: candidates, error: selectError } = await queue
      .order("created_at", { ascending: true })
      .limit(1);
    if (selectError) {
      throw new Error(`cascade-drain claim: could not read the queue: ${selectError.message}`);
    }
    return candidates?.[0] ?? null;
  };
  const target = (await selectCandidate(false)) ?? (await selectCandidate(true));
  if (!target) return null;
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
  // The claim's own timestamp is the FENCE: every event write this
  // invocation makes carries it, so a pass the platform abandoned at 60 s
  // that finishes minutes later — after the reclaim or a newer claim rewrote
  // the column — matches nothing and moves nothing. Measured 16 Sep 2026,
  // 09:22–09:45: working ticks routinely outlived the pg_cron wait and their
  // late writes were landing unfenced on live claims.
  return claimed ? { ...claimed, fence: nowIso } : null;
}

/**
 * Judge events at the attempt ceiling by their ledger, not their counter.
 *
 * A tick the platform kills spends an attempt and returns nothing, so the
 * terminal write in `drainOne` — which needs a claim to come back
 * empty-handed — never runs for it. Three kills and the event is a zombie:
 * `pending` for ever, claimable by nothing, reported nowhere.
 * `decideExhaustedEvent` (cascade/exhaustedEvents.pure.ts) reads the
 * event's result rows for the verdict: a recent ledger write means the
 * kills were CONVERGING and one attempt is refunded; a still ledger means
 * three passes learned nothing, and the event is retired visibly with the
 * operator's lever named. Every write is guarded on `pending` + unclaimed
 * so a racing claim wins and this tick simply misses the event.
 */
async function judgeExhaustedEvents(): Promise<{ retired: number; refunded: number }> {
  const out = { retired: 0, refunded: 0 };
  const { data: exhausted, error } = await admin
    .from("cascade_events")
    .select("id, mode, attempts")
    .eq("status", "pending")
    .is("worker_started_at", null)
    .gte("attempts", MAX_ATTEMPTS);
  if (error) {
    throw new Error(`cascade-drain: could not read exhausted events: ${error.message}`);
  }
  for (const event of exhausted ?? []) {
    const { data: newest, error: newestErr } = await admin
      .from("cascade_results")
      .select("updated_at")
      .eq("cascade_event_id", event.id)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const verdict = decideExhaustedEvent({
      attempts: event.attempts ?? 0,
      maxAttempts: MAX_ATTEMPTS,
      lastResultWriteAt: newestErr ? null : (newest?.updated_at ?? null),
      nowMs: Date.now(),
    });
    if (verdict.act === "refund") {
      const { error: refundErr } = await admin
        .from("cascade_events")
        .update({ attempts: MAX_ATTEMPTS - 1 })
        .eq("id", event.id)
        .eq("status", "pending")
        .is("worker_started_at", null);
      if (refundErr) {
        throw new Error(`cascade-drain: could not refund ${event.id}: ${refundErr.message}`);
      }
      out.refunded += 1;
    } else if (verdict.act === "retire") {
      const now = new Date().toISOString();
      const { data: retired, error: retireErr } = await admin
        .from("cascade_events")
        .update({
          status: "failed",
          worker_finished_at: now,
          summary: retirementSummary(MAX_ATTEMPTS),
        })
        .eq("id", event.id)
        .eq("status", "pending")
        .is("worker_started_at", null)
        .select("id");
      if (retireErr) {
        throw new Error(`cascade-drain: could not retire ${event.id}: ${retireErr.message}`);
      }
      if ((retired ?? []).length > 0) {
        // The retirement settles the event; this settles the rows it never
        // reached. Left `queued` under a failed carrier they are invisible to
        // every sweeper — the reclaim reads pending events — and sit in the
        // ledger for ever as work that looks owed.
        await terminaliseOrphanedRows(
          admin,
          event.id,
          `Skipped: the carrier event was retired after ${MAX_ATTEMPTS} attempts without processing this clone.`,
        );
        const { error: notifyError } = await admin.from("notifications").insert({
          kind: "cascade_failed",
          severity: "error",
          title: `Cascade retired after ${MAX_ATTEMPTS} attempts (${event.mode})`,
          body: retirementSummary(MAX_ATTEMPTS),
          cascade_event_id: event.id,
          url: `/cascades/${event.id}`,
          metadata: { retired_by: "cascade-drain", attempts: event.attempts },
        });
        if (notifyError) {
          console.error(
            "[cascade-drain] could not raise the retirement notification:",
            notifyError.message,
          );
        }
        out.retired += 1;
      }
    }
  }
  return out;
}

/**
 * The level trigger under the edge trigger.
 *
 * Runs only on a tick that claimed nothing — the queue is idle — and asks
 * whether prime's head has a cascade event at all. A lost `push` delivery is
 * the one hole every other mechanism here shares: fold, claim, defer and
 * reclaim all operate on events that EXIST, and a delivery that never
 * arrived created none. `decideDriftBeacon` (cascade/driftBeacon.pure.ts)
 * owns the refusals; the synthesis goes through `createCascadeForAllClones`
 * so the SHA dedupe and the unique index make the beacon once-per-SHA even
 * against a webhook racing it in either order.
 *
 * Never fails the tick: the beacon is insurance, and insurance that can
 * take down the drain it protects is a second webhook problem. Every
 * failure is logged and answered `null`.
 */
async function raiseDriftBeacon(): Promise<string | null> {
  try {
    const { data: pendingRows, error: pendingErr } = await admin
      .from("cascade_events")
      .select("id")
      .eq("status", "pending")
      .eq("trigger", "commit")
      .is("worker_started_at", null)
      .lt("attempts", MAX_ATTEMPTS)
      .limit(1);
    const claimableCommitEvents = pendingErr ? null : (pendingRows ?? []).length;

    // Prime and its head, read only once the queue is known idle — the
    // beacon's steady-state cost is one branch read a tick, and only on
    // ticks that did nothing else.
    const { data: prime, error: primeErr } = await admin
      .from("prime_config")
      .select("github_owner, github_repo, default_branch, default_cascade_mode")
      .limit(1)
      .maybeSingle();
    if (primeErr || !prime) {
      return null;
    }
    let headSha: string | null = null;
    if (claimableCommitEvents === 0) {
      try {
        const octokit = getAppOctokit();
        const { data: br } = await octokit.repos.getBranch({
          owner: prime.github_owner,
          repo: prime.github_repo,
          branch: prime.default_branch || "main",
        });
        headSha = br.commit.sha;
      } catch (e) {
        console.warn(
          "[cascade-drain] beacon could not read prime's head:",
          e instanceof Error ? e.message : String(e),
        );
        headSha = null;
      }
    }
    let headEventExists: boolean | null = null;
    if (headSha) {
      const existing = await findCommitCascadeForSha(admin, headSha);
      headEventExists = existing.failed ? null : existing.eventId !== null;
    }

    const verdict = decideDriftBeacon({ claimableCommitEvents, headSha, headEventExists });
    if (!verdict.fire || !headSha) return null;

    const created = await createCascadeForAllClones({
      supabase: admin,
      mode: prime.default_cascade_mode,
      trigger: "commit",
      sourceBranch: prime.default_branch || "main",
      sourceSha: headSha,
      initiatedBy: null,
      summary: beaconSummary(headSha),
    });
    if (!created.eventId || created.alreadyExisted) return null;

    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "cascade.drift_beacon",
      entityType: "cascade_event",
      entityId: created.eventId,
      metadata: { source_sha: headSha, reason: "no event for prime's head on an idle tick" },
    });
    return created.eventId;
  } catch (e) {
    console.error(
      "[cascade-drain] drift beacon failed:",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

async function drainOne(
  budget: CascadeBudget,
  excluded: ReadonlySet<string>,
): Promise<{ processed: boolean; ok?: boolean; held?: string; error?: string; id?: string }> {
  const claimed = await claimOne(excluded);
  if (!claimed) return { processed: false };

  try {
    const res = await executeCascade(supabaseAdmin, claimed.id, { budget, fence: claimed.fence });
    if (
      res.ok &&
      (res.status === "deferred" || res.status === "resuming" || res.status === "unarmed")
    ) {
      // The engine has already put the event back to `pending` with the
      // moment it may next be claimed. What is decided here is the ATTEMPT.
      //
      // A deferral never spends one: the limit is GitHub's window, not this
      // event's fault, and `next_attempt_at` already paces the retry. A pause
      // that landed at least one clone is refunded too — a pass that is
      // progressing is not a pass that is failing, which is the rule the
      // provisioning ceiling learned the hard way. A pause that landed NOTHING
      // keeps its attempt: a single clone that cannot fit inside the budget
      // would otherwise be retried for ever, quietly, and after the last
      // attempt it has to be said rather than left `pending` with no claim
      // that will ever take it. An UNARMED claim keeps its attempt for the
      // same reason — an event whose rows never arrive must end at a story,
      // not loop on the claim for ever.
      const refund =
        res.status === "unarmed"
          ? false
          : res.status === "deferred" ||
            res.done > 0 ||
            (res.status === "resuming" && res.progressed);
      if (refund) {
        // Guarded on the counter this claim wrote: a zombie whose event a
        // newer claim has since moved would otherwise refund the wrong pass.
        const { error } = await admin
          .from("cascade_events")
          .update({ attempts: Math.max(0, claimed.attempts - 1) })
          .eq("id", claimed.id)
          .eq("attempts", claimed.attempts);
        if (error) {
          throw new Error(
            `cascade-drain: could not refund the attempt on ${claimed.id}: ${error.message}`,
          );
        }
      } else if (claimed.attempts >= MAX_ATTEMPTS) {
        // Two different exhaustions, two different stories. The budget one
        // has rows still queued under it, and the unarmed one may have rows
        // that raced in after its final hold — either way, the act that
        // settles the event settles its rows, or they read as live work for
        // ever under a failed carrier.
        const summary =
          res.status === "unarmed"
            ? `Claimed ${MAX_ATTEMPTS} times before any result row appeared. The trigger that ` +
              `created this event never finished arming it — its row insert died after the ` +
              `event insert.`
            : `No clone completed inside the invocation budget in ${MAX_ATTEMPTS} attempts ` +
              `(${res.total} queued). One clone's pass is larger than one tick; it needs splitting.`;
        const { error } = await admin
          .from("cascade_events")
          .update({
            status: "failed",
            worker_finished_at: new Date().toISOString(),
            summary,
          })
          .eq("id", claimed.id)
          .eq("attempts", claimed.attempts);
        if (error) {
          throw new Error(`cascade-drain: could not fail ${claimed.id}: ${error.message}`);
        }
        await terminaliseOrphanedRows(
          admin,
          claimed.id,
          res.status === "unarmed"
            ? "Skipped: the carrier event was retired after being claimed with no armed rows; this row arrived too late to be part of any pass."
            : "Skipped: the carrier event was failed at the attempt ceiling — one clone's pass is larger than one tick.",
        );
      }
      return { processed: true, ok: true, held: res.status };
    }
    // Fenced: a superseded invocation stamping `worker_finished_at` onto a
    // LIVE claim would exempt it from the stall reclaim — the stuck-forever
    // shape this whole file exists to prevent.
    await admin
      .from("cascade_events")
      .update({ worker_finished_at: new Date().toISOString() })
      .eq("id", claimed.id)
      .eq("worker_started_at", claimed.fence);
    return { processed: true, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[cascade-drain] execute failed for ${claimed.id}:`, msg);
    const terminal = claimed.attempts >= MAX_ATTEMPTS;
    const { data: settled } = await admin
      .from("cascade_events")
      .update({
        worker_started_at: terminal ? undefined : null,
        worker_finished_at: terminal ? new Date().toISOString() : null,
        status: terminal ? "failed" : "pending",
      })
      .eq("id", claimed.id)
      .eq("worker_started_at", claimed.fence)
      .select("id");
    // The act that settles the event settles its rows — and only the act:
    // a fenced-out write means a newer claim owns this event, and a zombie
    // settling that claim's rows is worse than the strand it would prevent.
    if (terminal && (settled ?? []).length > 0) {
      await terminaliseOrphanedRows(
        admin,
        claimed.id,
        `Skipped: the carrier event was failed at the attempt ceiling after a pass error — ${msg}`.slice(
          0,
          500,
        ),
      );
    }
    return { processed: true, ok: false, error: msg, id: claimed.id };
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
          const folded = await foldQueuedCommitEvents();
          const exhausted = await judgeExhaustedEvents();
          // One free call before any paid one: a claim into an empty window
          // spends an attempt, two tree listings and a probe chunk to learn
          // what `/rate_limit` — uncounted — already knew, then defers
          // anyway. `null` proceeds: the deferral machinery still catches a
          // real 403, and a gate trippable by its own telemetry is a second
          // outage.
          const remaining = await readGitHubRemaining();
          const spend = decideSpend({ role: "cascade_claim", remaining });
          const results: Array<{ ok?: boolean; held?: string; error?: string }> = [];
          // One failure per event per tick: a failed pass is remembered and
          // its event is not offered to this tick's remaining claims, so the
          // loop moves on to OTHER queued work instead of spending the whole
          // attempt ceiling on one fault in one second.
          const failedThisTick = new Set<string>();
          if (spend.proceed) {
            for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
              if (Date.now() >= deadlineAt) break;
              const r = await drainOne(budget, failedThisTick);
              if (!r.processed) break;
              if (r.ok === false && r.id) failedThisTick.add(r.id);
              results.push({ ok: r.ok, held: r.held, error: r.error });
            }
          }
          // Only an idle tick with budget asks the drift question: a tick
          // that claimed work is following prime already, a deferred carrier
          // waiting out a rate-limit window counts as claimed-later, and a
          // starved tick must not spend its last calls on a branch read.
          const beacon = results.length === 0 && spend.proceed ? await raiseDriftBeacon() : null;
          return new Response(
            JSON.stringify({
              success: true,
              processed: results.length,
              folded,
              exhausted,
              starved: spend.proceed ? null : spend.why,
              beacon,
              results,
            }),
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
