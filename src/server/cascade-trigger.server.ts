// Server-only helper that creates a cascade_event + queued cascade_results
// for every clone. Used both by the user-facing trigger flow (via a server fn)
// and by the GitHub webhook receiver when prime is pushed.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { assessBlastRadius, type CascadeOrigin } from "./cascade-approvals.server";
import { FOLD_MAX_ATTEMPTS } from "./cascade/eventFold.pure";
import { parseCascadeSecurityGate, securityGateDecision } from "@/lib/cascade-security-gate";

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

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error && (error.code === "42703" || /column .* does not exist/i.test(error.message ?? ""))
  );
}

/**
 * Whether Prime's open security findings hold automatic cascades
 * (`prime_config.codex_cascade_gate`). Fails OPEN on a read error: a database
 * fault must not freeze the whole fleet, and the fault is logged.
 */
export async function evaluateCascadeSecurityGate(
  supabase: SupabaseLike,
): Promise<{ hold: boolean; reason: string | null }> {
  const { data: cfg, error: cfgErr } = await supabase
    .from("prime_config")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (cfgErr || !cfg) return { hold: false, reason: null };
  const gate = parseCascadeSecurityGate((cfg as Record<string, unknown>).codex_cascade_gate);
  if (gate === "off") return { hold: false, reason: null };

  const countOpen = async (severity: "critical" | "high") => {
    const { count, error } = await supabase
      .from("codex_findings")
      .select("id", { count: "exact", head: true })
      .is("clone_id", null)
      .is("pr_number", null)
      .eq("state", "open")
      .eq("severity", severity);
    if (error) {
      console.error(
        `[cascade-trigger] security gate could not count ${severity} findings:`,
        error.message,
      );
      return null;
    }
    return count ?? 0;
  };
  const critical = await countOpen("critical");
  const high = gate === "high" ? await countOpen("high") : 0;
  if (critical == null || high == null) return { hold: false, reason: null };
  return securityGateDecision(gate, { critical, high });
}

/**
 * Hold every pending, unclaimed, unheld commit cascade.
 *
 * A commit cascade delivers Prime's head as it stands when the pass RUNS, so
 * holding only the newest event would let any older pending one carry the
 * same content out unheld. Approving any one of them releases it.
 */
export async function holdPendingCommitCascades(
  supabase: SupabaseLike,
  reason: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("cascade_events")
    .update({ requires_approval: true, hold_reason: reason })
    .eq("status", "pending")
    .eq("trigger", "commit")
    .eq("requires_approval", false)
    .is("approved_at", null)
    .is("worker_started_at", null)
    .select("id");
  if (error) {
    // Without `hold_reason` the drain would discharge the hold on its next
    // tick, so holding without it would be theatre — say so instead.
    if (isMissingColumn(error)) {
      console.error("[cascade-trigger] cannot hold cascades before migration 20261018090000.");
    } else {
      console.error("[cascade-trigger] could not hold pending cascades:", error.message);
    }
    return 0;
  }
  return data?.length ?? 0;
}

export async function createCascadeForAllClones(args: {
  supabase: SupabaseLike;
  mode: CascadeMode;
  trigger: CascadeTrigger;
  sourceBranch: string | null;
  sourceSha: string | null;
  initiatedBy: string | null;
  summary?: string | null;
  /**
   * Hold this cascade for a person's approval whatever its blast radius —
   * e.g. it carries an unattended self-healing merge.
   */
  holdReason?: string | null;
  /**
   * Skip the Prime security gate. Only for a reviewed security fix, which
   * must reach the fleet precisely because Prime has open findings.
   */
  skipSecurityGate?: boolean;
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

  // Automatic commit cascades wait on Prime's security posture when the gate
  // is on; an explicit hold reason waits regardless. Decided before the fold:
  // a held push must never be stood down into an unheld carrier.
  const securityHold =
    trigger === "commit" && !initiatedBy && !args.skipSecurityGate
      ? await evaluateCascadeSecurityGate(supabase)
      : { hold: false, reason: null };
  const holdReason =
    [args.holdReason ?? null, securityHold.hold ? securityHold.reason : null]
      .filter(Boolean)
      .join(" · ") || null;

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
      // A held push never folds into an unheld carrier: the carrier would
      // deliver this push's tree with nobody asked.
      const carrier = (holdReason ? [] : (pendingRows ?? [])).find(
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

  // A `commit` cascade is prime's own history arriving, not a proposal: the
  // webhook minted it, `initiatedBy` is null, and it reads prime's head when
  // it runs. `assessBlastRadius` is where the reasoning lives, and why the
  // fleet-size count binds only what a person started.
  const origin: CascadeOrigin = trigger === "commit" ? "automatic" : "operator";
  const blast = assessBlastRadius(mode, clones.length, origin);
  const requiresApproval = blast.requiresApproval || !!holdReason;
  const approvalReason = [blast.requiresApproval ? blast.reason : null, holdReason]
    .filter(Boolean)
    .join(" · ");

  const eventRow = {
    mode,
    trigger,
    source_branch: sourceBranch,
    source_sha: sourceSha,
    initiated_by: initiatedBy,
    summary: summary ?? null,
    status: "pending" as const,
    requires_approval: requiresApproval,
    ...(holdReason ? { hold_reason: holdReason } : {}),
  };
  let { data: event, error: eventErr } = await supabase
    .from("cascade_events")
    .insert(eventRow)
    .select()
    .single();
  if (eventErr && holdReason && isMissingColumn(eventErr)) {
    // Unmigrated: the event is still gated, though the drain may re-derive it.
    const { hold_reason: _omit, ...legacyRow } = eventRow as typeof eventRow & {
      hold_reason?: string;
    };
    void _omit;
    ({ data: event, error: eventErr } = await supabase
      .from("cascade_events")
      .insert(legacyRow)
      .select()
      .single());
  }
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
      requiresApproval,
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
      requiresApproval,
      error: resErr.message,
    };
  }

  // Older pending commit events deliver the same head when they run; a hold
  // on this one alone would be routed around.
  if (holdReason) await holdPendingCommitCascades(supabase, holdReason);

  if (requiresApproval) {
    await supabase.from("notifications").insert({
      kind: "cascade_awaiting_approval",
      severity: "warning",
      title: `Approval needed · ${trigger} ${mode.replace("_", " ")} cascade`,
      body: approvalReason || "High-blast-radius cascade — awaiting second-operator approval.",
      cascade_event_id: event.id,
      url: `/cascades/${event.id}`,
      metadata: { mode, trigger, clone_count: clones.length },
    });
    await supabase.from("audit_log").insert({
      action: "cascade.awaiting_approval",
      entity_type: "cascade_event",
      entity_id: event.id,
      actor_user_id: initiatedBy,
      metadata: { mode, trigger, clone_count: clones.length, reason: approvalReason || null },
    });
  }

  return { eventId: event.id, cloneCount: clones.length, requiresApproval };
}
