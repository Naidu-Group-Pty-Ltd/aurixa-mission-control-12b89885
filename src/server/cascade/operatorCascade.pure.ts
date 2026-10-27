/**
 * A cascade a person started, decided before anything is written.
 *
 * ## Why one module
 *
 * Three surfaces start a cascade by hand: `/cascades` ("Fire cascade"), the
 * cascade detail page ("Retry as", "Roll back") and the clone page ("Cascade
 * now"). The first two composed their own events in the browser and wrote
 * `cascade_events` and `cascade_results` straight from the client, so whether
 * a narrowing scope stayed narrow, and whether the approval gate was asked at
 * all, depended on which page the button was on. The detail page's spawn never
 * asked the gate, so a rollback reaching more clones than `assessBlastRadius`
 * allows would run with no second operator, while the same reach fired from
 * `/cascades` waited for one. The third only navigated to `/cascades`, and so
 * delivered nothing.
 *
 * Now the server composes every one of them here and arms it in one place
 * (`operatorCascade.server.ts`), and the pages render the answer.
 *
 * ## What the drain expects of what this makes
 *
 * A `manual` event, `pending`, never claimed (`worker_started_at` null), with
 * `attempts`, `next_attempt_at` and `created_at` left to their defaults, and
 * one `queued` result row per clone written straight after it. That is the
 * shape `/hooks/cascade-drain` claims once the arming grace has passed. The
 * provisioning module cascade already writes it, and the custodian's re-queue
 * writes the same under a `scheduled` trigger. The page still runs the engine
 * inline as it always did; the drain is what carries the event if that run
 * dies or the tab closes first.
 *
 * The `scope_filter` never carries `module_globs`, the one key the engine
 * reads from it, so every delivery made here is the clone's full installed
 * tree at its source's head when the pass runs. Its other keys are provenance:
 * `retry_of` and `rollback_of` are what the lineage panel walks.
 *
 * Client-safe: pure. The server owns every read and write.
 */
import type { Database } from "@/integrations/supabase/types";
import { countClones, type CascadeScope } from "@/lib/cascadeTargets.pure";

export type CascadeMode = Database["public"]["Enums"]["cascade_mode"];
type NotificationInsert = Database["public"]["Tables"]["notifications"]["Insert"];

/** "pr", "auto merge", "notify": how the pages have always spelt a mode in a sentence. */
function modeWords(mode: CascadeMode): string {
  return mode.replace("_", " ");
}

/** What a scope filter written here may hold. Every value is plain JSON. */
export type OperatorScopeFilter = {
  scope: CascadeScope;
  tags?: string[];
  clone_ids?: string[];
  retry_of?: string;
  rollback_of?: string;
  source_mode?: CascadeMode;
  origin?: "clone_page";
};

/**
 * The scope filter of a cascade fired from `/cascades`.
 *
 * "All clones" keeps the shape it has always had. A narrowing scope records the
 * clones it resolved to beside the selection that produced them, so the event
 * says which clones were meant even after their tags change.
 */
export function fireScopeFilter(
  scope: CascadeScope,
  tags: readonly string[],
  cloneIds: readonly string[],
): OperatorScopeFilter {
  if (scope === "all") return { scope: "all" };
  if (scope === "tagged") {
    // The tags the resolver read: trimmed, blank-free, each once.
    const chosen = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    return { scope: "tagged", tags: chosen, clone_ids: [...cloneIds] };
  }
  return { scope: "selected", clone_ids: [...cloneIds] };
}

/**
 * The cascade detail page and the clone page start a delivery to named clones.
 *
 * - `retry`: one clone of a settled cascade, again, in a mode the operator picks.
 * - `rollback`: every clone a settled cascade touched, again, in a picked mode.
 * - `redeliver`: one clone, fresh, from its own page ("Cascade now").
 */
export type SpawnRequest =
  | { intent: "retry"; mode: CascadeMode; of: string; cloneId: string }
  | { intent: "rollback"; mode: CascadeMode; of: string; cloneIds: string[] }
  | { intent: "redeliver"; mode: CascadeMode; cloneId: string };

/** A read that failed. Never read as "no", and never as "yes". */
export const UNREADABLE = "unreadable" as const;
type Unreadable = typeof UNREADABLE;

/** What the server read before deciding. */
export type SpawnFacts = {
  /** The named clones the fleet holds, with their names. */
  clones: ReadonlyArray<{ id: string; name: string }> | Unreadable;
  /** The cascade a retry or rollback names. Null when it does not exist. */
  parent?: { status: string; mode: CascadeMode } | null | Unreadable;
  /** For a redelivery: the unsettled event already carrying this clone, or null. */
  liveDelivery?: { eventId: string } | null | Unreadable;
};

export type SpawnPlan =
  | {
      ok: true;
      cloneIds: string[];
      scopeFilter: OperatorScopeFilter;
      summary: string;
    }
  | {
      ok: false;
      reason: string;
      /** The delivery already in flight, so the page can link to it. */
      liveEventId: string | null;
    };

/** Statuses of an event a pass may still be working. */
const IN_FLIGHT: ReadonlySet<string> = new Set(["pending", "running"]);

/** The statuses the detail page offers "Roll back" on. */
const ROLLBACK_FROM: ReadonlySet<string> = new Set(["completed", "partial"]);

function refuse(reason: string, liveEventId: string | null = null): SpawnPlan {
  return { ok: false, reason, liveEventId };
}

function requestedIds(request: SpawnRequest): string[] {
  const raw = request.intent === "rollback" ? request.cloneIds : [request.cloneId];
  return [...new Set(raw.map((id) => id.trim()).filter(Boolean))];
}

/**
 * Plan a delivery to named clones, or refuse and say why.
 *
 * The guards are the ones the detail page already applied, now asked by the
 * server too so a stale page cannot step round them:
 *
 * - **No clones, no cascade.** The detail page's spawn refused an empty list
 *   ("No clones to act on"), and a refusal here is never read as "all".
 * - **A retry or rollback waits for its parent to settle.** "Retry as" and
 *   "Roll back" are offered only while the parent is neither pending nor
 *   running, and "Roll back" only on a completed or partial parent.
 *
 * And one the fresh delivery needs, because it has no parent to wait on:
 *
 * - **One delivery per clone at a time.** A clone with a queued or pushing row
 *   under an event that is still pending or running is already owed prime's
 *   head: that pass reads it when it runs. A second delivery beside it pushes
 *   the same tree twice and leaves two proposals to reconcile, which is the
 *   rule `requeueDroppedClone` and `headRedelivery` already keep. The refusal
 *   names the event that is in flight.
 *
 * Every guard fails closed: a fact that could not be read refuses.
 */
export function planSpawn(request: SpawnRequest, facts: SpawnFacts): SpawnPlan {
  const ids = requestedIds(request);
  if (ids.length === 0) return refuse("No clones to act on.");

  if (facts.clones === UNREADABLE) {
    return refuse("Could not read the fleet, and an unreadable check is not a yes.");
  }
  const names = new Map(facts.clones.map((c) => [c.id, c.name]));
  const missing = ids.filter((id) => !names.has(id));
  if (missing.length > 0) {
    return refuse(
      `${countClones(missing.length)} named here ${missing.length === 1 ? "is" : "are"} no longer in the fleet.`,
    );
  }

  if (request.intent === "retry" || request.intent === "rollback") {
    const parent = facts.parent;
    if (parent === undefined || parent === UNREADABLE) {
      return refuse(
        "Could not read the cascade this acts on, and an unreadable check is not a yes.",
      );
    }
    if (parent === null) return refuse("The cascade this acts on no longer exists.");
    if (IN_FLIGHT.has(parent.status)) {
      return refuse(
        `The cascade this acts on is still ${parent.status}. Wait for it to settle, then try again.`,
      );
    }
    if (request.intent === "rollback" && !ROLLBACK_FROM.has(parent.status)) {
      return refuse(
        `Only a completed or partial cascade can be rolled back; this one is ${parent.status}.`,
      );
    }

    if (request.intent === "retry") {
      return {
        ok: true,
        cloneIds: ids,
        scopeFilter: { scope: "selected", clone_ids: ids, retry_of: request.of },
        summary: `Retry of cascade ${request.of.slice(0, 8)} for one clone in ${modeWords(request.mode)} mode`,
      };
    }
    return {
      ok: true,
      cloneIds: ids,
      scopeFilter: {
        scope: "selected",
        clone_ids: ids,
        rollback_of: request.of,
        source_mode: parent.mode,
      },
      summary: `Rollback of cascade ${request.of.slice(0, 8)} (${ids.length} clones, ${modeWords(request.mode)})`,
    };
  }

  const live = facts.liveDelivery;
  if (live === undefined || live === UNREADABLE) {
    return refuse(
      "Could not check whether a delivery is already in flight for this clone, and an unreadable check is not a no.",
    );
  }
  const name = names.get(ids[0]) ?? "this clone";
  if (live !== null) {
    return refuse(
      `A delivery to ${name} is already in flight (cascade ${live.eventId.slice(0, 8)}). It reads prime's head when it runs, so a second one would push the same tree twice.`,
      live.eventId,
    );
  }
  return {
    ok: true,
    cloneIds: ids,
    scopeFilter: { scope: "selected", clone_ids: ids, origin: "clone_page" },
    summary: `Cascade now for ${name} in ${modeWords(request.mode)} mode, started from its page`,
  };
}

/**
 * The notification that asks a second operator to approve.
 *
 * `cascade_event_id` is load-bearing: the drain's gate reassessment and
 * `approveCascade` both find this row by it to mark it answered.
 */
export function approvalNotice(args: {
  eventId: string;
  mode: CascadeMode;
  cloneCount: number;
  reason: string;
}): NotificationInsert {
  return {
    kind: "cascade_awaiting_approval",
    severity: "warning",
    title: `Approval needed · ${modeWords(args.mode)} cascade`,
    body: `${args.reason} The operator who started it cannot approve it; a second operator must.`,
    cascade_event_id: args.eventId,
    url: `/cascades/${args.eventId}`,
    metadata: { mode: args.mode, clone_count: args.cloneCount },
  };
}
