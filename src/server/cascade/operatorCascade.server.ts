/**
 * Arming a cascade a person started.
 *
 * The decisions are in `operatorCascade.pure.ts` and `@/lib/cascadeTargets.pure`,
 * with the reasoning beside them. This is the reads before them and the
 * writes after.
 *
 * Everything runs as the caller. `supabase` is the user-scoped client the
 * server function was handed, so row-level security still decides who may
 * write a cascade, exactly as it did when the pages wrote these rows from the
 * browser.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { assessBlastRadius } from "@/lib/blast-radius";
import {
  confirmCascadeTargets,
  resolveCascadeTargets,
  type CascadeScope,
} from "@/lib/cascadeTargets.pure";
import {
  UNREADABLE,
  approvalNotice,
  fireScopeFilter,
  planSpawn,
  type CascadeMode,
  type OperatorScopeFilter,
  type SpawnRequest,
} from "./operatorCascade.pure";

type Db = SupabaseClient<Database>;

/** What a page is told. Plain JSON, so it crosses the server-function boundary as is. */
export type OperatorCascadeAnswer =
  | {
      ok: true;
      eventId: string;
      cloneCount: number;
      /** True when the cascade waits for a second operator and nothing will run until one approves. */
      awaitingApproval: boolean;
      /** Why a second operator is needed, when one is. */
      reason: string | null;
    }
  | {
      ok: false;
      error: string;
      /** The delivery already in flight, when that is why nothing was created. */
      liveEventId: string | null;
    };

function refused(error: string, liveEventId: string | null = null): OperatorCascadeAnswer {
  return { ok: false, error, liveEventId };
}

/**
 * Fire a cascade from `/cascades`.
 *
 * The fleet is read here, as the caller, and the targets are resolved from it
 * rather than taken from the page: the page sends the scope and the selection
 * the operator made, and the count it showed them, never a list of rows to
 * arm. A selection that reaches nothing is refused here even if a page sent
 * it, so an empty "By tag" or "Manual select" can never arrive as "all".
 */
export async function fireOperatorCascade(
  supabase: Db,
  args: {
    userId: string;
    mode: CascadeMode;
    scope: CascadeScope;
    tags: readonly string[];
    cloneIds: readonly string[];
    confirmedCount: number;
  },
): Promise<OperatorCascadeAnswer> {
  // The order `useClones` draws the fleet in, so "All clones" arms its rows in
  // the order the operator saw them.
  const { data, error } = await supabase
    .from("clones")
    .select("id, tags")
    .order("created_at", { ascending: false });
  // A fleet that could not be read is not an empty one.
  if (error) return refused(`Could not read the fleet: ${error.message}`);

  const targets = confirmCascadeTargets(
    resolveCascadeTargets(
      { scope: args.scope, tags: args.tags, cloneIds: args.cloneIds },
      data ?? [],
    ),
    args.confirmedCount,
  );
  if (!targets.ok) return refused(targets.reason);

  return createOperatorCascade(supabase, {
    userId: args.userId,
    mode: args.mode,
    cloneIds: targets.cloneIds,
    scopeFilter: fireScopeFilter(args.scope, args.tags, targets.cloneIds),
    summary: null,
  });
}

/**
 * Start a delivery to named clones: a retry or rollback from the cascade
 * detail page, or "Cascade now" from a clone's own page.
 */
export async function spawnOperatorCascade(
  supabase: Db,
  args: { userId: string; request: SpawnRequest },
): Promise<OperatorCascadeAnswer> {
  const { request } = args;
  const named = request.intent === "rollback" ? request.cloneIds : [request.cloneId];
  const [clones, parent, liveDelivery] = await Promise.all([
    readNamedClones(supabase, named),
    request.intent === "redeliver" ? Promise.resolve(undefined) : readParent(supabase, request.of),
    request.intent === "redeliver"
      ? readLiveDelivery(supabase, request.cloneId)
      : Promise.resolve(undefined),
  ]);

  const plan = planSpawn(request, { clones, parent, liveDelivery });
  if (!plan.ok) return refused(plan.reason, plan.liveEventId);

  return createOperatorCascade(supabase, {
    userId: args.userId,
    mode: request.mode,
    cloneIds: plan.cloneIds,
    scopeFilter: plan.scopeFilter,
    summary: plan.summary,
  });
}

async function readNamedClones(
  supabase: Db,
  ids: readonly string[],
): Promise<Array<{ id: string; name: string }> | typeof UNREADABLE> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  const { data, error } = await supabase.from("clones").select("id, name").in("id", wanted);
  if (error) return UNREADABLE;
  return data ?? [];
}

async function readParent(
  supabase: Db,
  eventId: string,
): Promise<{ status: string; mode: CascadeMode } | null | typeof UNREADABLE> {
  const { data, error } = await supabase
    .from("cascade_events")
    .select("status, mode")
    .eq("id", eventId)
    .maybeSingle();
  if (error) return UNREADABLE;
  return data ?? null;
}

/**
 * More unsettled events than this is a queue in trouble, and the check fails
 * closed rather than asking about a list it cannot hold in one request.
 */
const LIVE_EVENT_CEILING = 200;

/**
 * The unsettled event already carrying a delivery to this clone, if any.
 *
 * Asked of the queue first and the clone's rows second. Read the other way
 * round, the first read would be every queued or pushing row this clone has
 * ever had, and rows stranded under settled events are ledger debt that
 * nothing bounds. The unsettled queue is small by construction: the drain
 * folds, claims and retires it every minute.
 *
 * Two plain reads rather than an embedded filter, so each failure is its own
 * and either one refuses.
 */
async function readLiveDelivery(
  supabase: Db,
  cloneId: string,
): Promise<{ eventId: string } | null | typeof UNREADABLE> {
  const events = await supabase
    .from("cascade_events")
    .select("id")
    .in("status", ["pending", "running"])
    .limit(LIVE_EVENT_CEILING + 1);
  if (events.error) return UNREADABLE;
  const unsettled = (events.data ?? []).map((e) => e.id);
  if (unsettled.length > LIVE_EVENT_CEILING) return UNREADABLE;
  if (unsettled.length === 0) return null;

  const rows = await supabase
    .from("cascade_results")
    .select("cascade_event_id")
    .eq("clone_id", cloneId)
    .in("status", ["queued", "pushing"])
    .in("cascade_event_id", unsettled)
    .limit(1);
  if (rows.error) return UNREADABLE;
  const hit = (rows.data ?? [])[0];
  return hit ? { eventId: hit.cascade_event_id } : null;
}

/**
 * Write the event and arm it.
 *
 * The blast-radius gate is asked here for every cascade a person starts,
 * whichever page started it. One clone never crosses either threshold, so a
 * retry and "Cascade now" run as they always did. A rollback wide enough to
 * cross one now waits for a second operator, as the same reach fired from
 * `/cascades` always has.
 */
async function createOperatorCascade(
  supabase: Db,
  args: {
    userId: string;
    mode: CascadeMode;
    cloneIds: readonly string[];
    scopeFilter: OperatorScopeFilter;
    summary: string | null;
  },
): Promise<OperatorCascadeAnswer> {
  const cloneIds = [...new Set(args.cloneIds)];
  // Never "all": every caller resolved its targets already, and an empty list
  // reaching this point is a fault to refuse, not a scope to widen.
  if (cloneIds.length === 0) return refused("No clones to act on.");
  const cloneCount = cloneIds.length;
  const blast = assessBlastRadius(args.mode, cloneCount);

  const { data: ev, error: evErr } = await supabase
    .from("cascade_events")
    .insert({
      trigger: "manual",
      mode: args.mode,
      status: "pending",
      requires_approval: blast.requiresApproval,
      scope_filter: args.scopeFilter,
      summary: args.summary,
      initiated_by: args.userId,
    })
    .select("id")
    .single();
  if (evErr || !ev) {
    return refused(`Could not create the cascade: ${evErr?.message ?? "no row came back"}`);
  }

  // The prime commit each clone was synced to when the cascade was started:
  // the target of the bulk card's rollback, which sets `last_synced_sha` back
  // to it. A prime commit, not one in the clone's repository, so the cascade's
  // page diffs a delivery's own commit instead. The engine never writes it, so
  // it was set only where the bulk card inserted its own rows. Read, never
  // invented: a clone this read does not answer for carries none, and a failed
  // read costs the rollback target, not the cascade.
  const { data: before } = await supabase
    .from("clones")
    .select("id, last_synced_sha")
    .in("id", cloneIds);
  const previousSha = new Map(
    ((before ?? []) as Array<{ id: string; last_synced_sha: string | null }>).map((c) => [
      c.id,
      c.last_synced_sha,
    ]),
  );

  // ARMED IN THE SAME ACT, as the custodian's re-queue is. One statement, so
  // the rows land together or not at all.
  const { error: rowsErr } = await supabase.from("cascade_results").insert(
    cloneIds.map((clone_id) => ({
      cascade_event_id: ev.id,
      clone_id,
      status: "queued" as const,
      previous_sha: previousSha.get(clone_id) ?? null,
    })),
  );
  if (rowsErr) {
    // An event with no rows is one the engine holds `unarmed` on every claim
    // until the attempt ceiling retires it. It never ran and never will, so it
    // is settled now with the reason rather than left to read as pending work.
    const { error: settleErr } = await supabase
      .from("cascade_events")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        summary: `Not started: its clones could not be queued (${rowsErr.message}).`,
      })
      .eq("id", ev.id);
    if (settleErr) {
      console.error(
        `[operator-cascade] ${ev.id} has no rows and could not be settled: ${settleErr.message}`,
      );
    }
    return refused(`Could not queue the cascade's clones: ${rowsErr.message}`);
  }

  if (blast.requiresApproval) {
    const reason = blast.reason ?? "This cascade needs a second operator to approve it.";
    const { error: noticeErr } = await supabase
      .from("notifications")
      .insert(approvalNotice({ eventId: ev.id, mode: args.mode, cloneCount, reason }));
    if (noticeErr) {
      console.error(
        `[operator-cascade] ${ev.id} awaits approval but its notice did not land: ${noticeErr.message}`,
      );
    }
    const { error: auditErr } = await supabase.from("audit_log").insert({
      action: "cascade.awaiting_approval",
      entity_type: "cascade_event",
      entity_id: ev.id,
      actor_user_id: args.userId,
      metadata: {
        mode: args.mode,
        clone_count: cloneCount,
        reason,
        scope: args.scopeFilter.scope,
      },
    });
    if (auditErr) {
      console.error(
        `[operator-cascade] ${ev.id} awaits approval but its audit row did not land: ${auditErr.message}`,
      );
    }
    return { ok: true, eventId: ev.id, cloneCount, awaitingApproval: true, reason };
  }

  return { ok: true, eventId: ev.id, cloneCount, awaitingApproval: false, reason: null };
}
