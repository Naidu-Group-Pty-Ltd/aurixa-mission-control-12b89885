// Server-only helper that creates a cascade_event + queued cascade_results
// for every clone. Used both by the user-facing trigger flow (via a server fn)
// and by the GitHub webhook receiver when prime is pushed.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { assessBlastRadius } from "./cascade-approvals.server";
import { FOLD_MAX_ATTEMPTS } from "./cascade/eventFold.pure";

type CascadeMode = Database["public"]["Enums"]["cascade_mode"];
type CascadeTrigger = Database["public"]["Enums"]["cascade_trigger"];
type SupabaseLike = SupabaseClient<Database>;

/**
 * One automatic cascade per prime commit.
 *
 * A merged pull request delivers TWO webhooks that both mean "prime moved":
 * `pull_request.closed` with `merged: true`, and the `push` the merge itself
 * makes. They carry the same head SHA. Without this, every merge would open two
 * cascade pull requests on every clone, and the second would conflict with the
 * first.
 *
 * The SHA is what decides, not the event kind, so it does not matter which
 * delivery GitHub sends first or whether one is lost. A direct push -- this
 * prime takes them from Lovable constantly -- simply finds no earlier event and
 * proceeds.
 *
 * `uq_cascade_events_commit_sha` is the backstop underneath this for two
 * deliveries racing; a violation there is read as "already cascaded" rather
 * than as an error, because it means the other delivery won.
 */
export async function findCommitCascadeForSha(
  supabase: SupabaseLike,
  sourceSha: string,
): Promise<{ eventId: string | null; failed: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("cascade_events")
    .select("id")
    .eq("source_sha", sourceSha)
    .eq("trigger", "commit")
    .limit(1)
    .maybeSingle();
  // A read that FAILED is not an absence. Reporting "no existing cascade" on a
  // database fault is how you get the duplicate this function exists to stop.
  if (error) return { eventId: null, failed: true, error: error.message };
  return { eventId: data?.id ?? null, failed: false };
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "23505" || /duplicate key value/i.test(error.message ?? "");
}

export async function createCascadeForAllClones(args: {
  supabase: SupabaseLike;
  mode: CascadeMode;
  trigger: CascadeTrigger;
  sourceBranch: string | null;
  sourceSha: string | null;
  initiatedBy: string | null;
  summary?: string | null;
}): Promise<{
  eventId: string | null;
  cloneCount: number;
  requiresApproval: boolean;
  error?: string;
  /** True when an automatic cascade for this prime SHA already existed. */
  alreadyExisted?: boolean;
  /**
   * True when a pending, unclaimed commit cascade already waits: that event
   * reads prime's head when it runs, so it will deliver this push's content
   * and a second event would only repeat the work at full cost.
   */
  foldedIntoPending?: boolean;
}> {
  const { supabase, mode, trigger, sourceBranch, sourceSha, initiatedBy, summary } = args;

  // Automatic triggers are deduplicated by prime SHA. Manual ones are not: an
  // operator re-running the same SHA is how you retry a cascade after fixing an
  // exclusion, and refusing that would turn a repair into an error.
  if (trigger === "commit" && sourceSha) {
    const existing = await findCommitCascadeForSha(supabase, sourceSha);
    if (existing.failed) {
      return {
        eventId: null,
        cloneCount: 0,
        requiresApproval: false,
        error: `Could not check for an existing cascade: ${existing.error}`,
      };
    }
    if (existing.eventId) {
      return {
        eventId: existing.eventId,
        cloneCount: 0,
        requiresApproval: false,
        alreadyExisted: true,
      };
    }

    // One queued commit cascade carries every prime commit behind it.
    //
    // `executeCascade` reads the branch HEAD at run time — an event delivers
    // prime as prime stands when the pass runs, never the commit that created
    // it — so while an UNCLAIMED commit event waits, a second one is the same
    // work twice at ~300 file reads per clone. Prime merges ~50 times a day;
    // through the September 2026 freeze the duplicates outran the drain and
    // the App's hourly budget went to repeating passes for superseded trees.
    //
    // Only a pending, unclaimed, unfiltered, approval-free event of the SAME
    // MODE stands this push down: a running event may already have read an
    // older head (its next attempt re-reads), a gated one may be rejected,
    // and a scoped one delivers a module rather than prime's head. A read
    // that FAILED creates the event as before — a duplicate is a cost, a push
    // that silently cascades nowhere is the webhook's original sin.
    const { data: pendingRows, error: pendingErr } = await supabase
      .from("cascade_events")
      .select("id, scope_filter, requires_approval, mode")
      .eq("status", "pending")
      .eq("trigger", "commit")
      .is("worker_started_at", null)
      // A pending row at the drain's claim ceiling is one no claim will ever
      // take. Standing pushes down for a carrier nothing will run would stop
      // the fleet cascading behind one dead row.
      .lt("attempts", FOLD_MAX_ATTEMPTS)
      .order("created_at", { ascending: true })
      .limit(10);
    if (!pendingErr) {
      const carrier = (pendingRows ?? []).find(
        (e) =>
          e.mode === mode &&
          e.requires_approval === false &&
          (e.scope_filter == null ||
            (typeof e.scope_filter === "object" &&
              !Array.isArray(e.scope_filter) &&
              Object.keys(e.scope_filter as Record<string, unknown>).length === 0)),
      );
      if (carrier) {
        return {
          eventId: carrier.id,
          cloneCount: 0,
          requiresApproval: false,
          alreadyExisted: true,
          foldedIntoPending: true,
        };
      }
    }
  }

  const { data: clones, error: cloneErr } = await supabase.from("clones").select("id");
  if (cloneErr)
    return { eventId: null, cloneCount: 0, requiresApproval: false, error: cloneErr.message };
  if (!clones || clones.length === 0) {
    return { eventId: null, cloneCount: 0, requiresApproval: false, error: "No clones registered" };
  }

  const blast = assessBlastRadius(mode, clones.length);

  const { data: event, error: eventErr } = await supabase
    .from("cascade_events")
    .insert({
      mode,
      trigger,
      source_branch: sourceBranch,
      source_sha: sourceSha,
      initiated_by: initiatedBy,
      summary: summary ?? null,
      status: "pending",
      requires_approval: blast.requiresApproval,
    })
    .select()
    .single();
  if (eventErr || !event) {
    // The other delivery won the race. That is the intended outcome, not a
    // failure -- report the event it created rather than a duplicate error.
    if (trigger === "commit" && sourceSha && isUniqueViolation(eventErr)) {
      const winner = await findCommitCascadeForSha(supabase, sourceSha);
      if (!winner.failed && winner.eventId) {
        return {
          eventId: winner.eventId,
          cloneCount: 0,
          requiresApproval: false,
          alreadyExisted: true,
        };
      }
    }
    return {
      eventId: null,
      cloneCount: 0,
      requiresApproval: blast.requiresApproval,
      error: eventErr?.message ?? "Event insert failed",
    };
  }

  const rows = clones.map((c) => ({
    cascade_event_id: event.id,
    clone_id: c.id,
    status: "queued" as const,
  }));
  const { error: resErr } = await supabase.from("cascade_results").insert(rows);
  if (resErr) {
    return {
      eventId: event.id,
      cloneCount: 0,
      requiresApproval: blast.requiresApproval,
      error: resErr.message,
    };
  }

  if (blast.requiresApproval) {
    await supabase.from("notifications").insert({
      kind: "cascade_awaiting_approval",
      severity: "warning",
      title: `Approval needed · ${trigger} ${mode.replace("_", " ")} cascade`,
      body: blast.reason ?? "High-blast-radius cascade — awaiting second-operator approval.",
      cascade_event_id: event.id,
      url: `/cascades/${event.id}`,
      metadata: { mode, trigger, clone_count: clones.length },
    });
    await supabase.from("audit_log").insert({
      action: "cascade.awaiting_approval",
      entity_type: "cascade_event",
      entity_id: event.id,
      actor_user_id: initiatedBy,
      metadata: { mode, trigger, clone_count: clones.length, reason: blast.reason },
    });
  }

  return { eventId: event.id, cloneCount: clones.length, requiresApproval: blast.requiresApproval };
}
