/**
 * A recorded gate is a fact about the past. Ask the question again.
 *
 * ## What went wrong
 *
 * `cascade_events.requires_approval` is written once, at insert, from a clone
 * count read in that instant. Nothing ever reads it again except to refuse.
 *
 * Measured 19 September 2026. The fourth clone was registered at 05:20:23; the
 * next eight prime commit cascades — 06:59 through 11:29 — each counted four
 * clones against `AUTO_MERGE_THRESHOLD = 3` and stamped `requires_approval`
 * true. By noon all eight stood `pending`, `approved_at` null, `attempts` 0,
 * carrying 32 queued result rows, and all four tenants sat 69 commits behind
 * prime. Nothing was wrong with any of them except the answer frozen on the
 * row.
 *
 * Fixing `assessBlastRadius` does not move one of those rows. That is the
 * point of this module, and the reason it is not a migration: a data fix
 * repairs eight rows once, and the next time the rule moves — or a clone is
 * decommissioned, or a threshold is retuned — the queue strands again with
 * nothing reporting it. **The gate is re-read where it is enforced.**
 *
 * ## Three rules, and the first is the one that makes this safe
 *
 * **It never approves.** No `cascade_approvals` row is written, no
 * `approved_at` is stamped, no operator is impersonated. Those say *a second
 * person looked*. This says something different and weaker: *the question was
 * answered from inputs that have moved, and the rule as it stands today asks
 * nothing of anybody.* An event a person HAS approved is never touched here —
 * the approval is the record, and re-deriving over it would overwrite a human
 * act with a computation.
 *
 * **It only ever relaxes.** A gate this finds no longer owed is cleared; a
 * gate the current rule WOULD impose on an event that never carried one is
 * not added. Re-gating mid-queue would stop work somebody is waiting on, at a
 * moment nobody chose, with no notification — and the count that assessed an
 * operator's cascade when they pressed it is that decision's own input, not a
 * live reading.
 *
 * **It says why, on the row.** A `requires_approval` that flips with no story
 * is indistinguishable from a gate somebody bypassed. {@link dischargeSummary}
 * is what the event carries afterwards, and it names the rule rather than the
 * outcome.
 *
 * Client-safe: pure, and its only import is the isomorphic assessment in
 * `@/lib/blast-radius`.
 */
import { assessBlastRadius, type CascadeOrigin } from "@/lib/blast-radius";
import type { Database } from "@/integrations/supabase/types";

type CascadeMode = Database["public"]["Enums"]["cascade_mode"];

/** The columns this decision reads. Nothing else on the row matters to it. */
export type RecordedGate = {
  readonly id: string;
  readonly trigger: string;
  readonly mode: string;
  readonly requires_approval: boolean;
  readonly approved_at: string | null;
};

export type GateVerdict =
  /** No gate was ever recorded on this event. Nothing to re-ask. */
  | { readonly act: "ungated" }
  /** A person discharged it. Their act stands; this never re-derives over it. */
  | { readonly act: "approved" }
  /** The current rule still asks for an approval. The event waits, correctly. */
  | { readonly act: "stands"; readonly reason: string }
  /** The current rule asks nothing. Clear the gate and record why. */
  | { readonly act: "discharge"; readonly summary: string };

/**
 * Which origin a stored trigger word means.
 *
 * One place, because the trigger-to-origin mapping now exists at the creation
 * site too and two copies of it is how an event is minted under one rule and
 * re-read under another.
 */
export function originForTrigger(trigger: string): CascadeOrigin {
  return trigger === "commit" ? "automatic" : "operator";
}

/**
 * The summary a discharged event carries.
 *
 * It names the rule and the reading, so the row explains itself without the
 * reader having to know what the threshold was on the day it was minted.
 */
export function dischargeSummary(cloneCount: number, origin: CascadeOrigin): string {
  return (
    `Gate re-read at claim: with ${cloneCount} clone(s) and an ${origin} origin, the ` +
    "blast-radius rule as it stands asks for no second-operator approval. No approval " +
    "was recorded and none was owed — the gate was assessed from a clone count taken " +
    "when the event was created."
  );
}

/**
 * Re-ask the gate question for one pending event against the fleet as it is.
 *
 * `cloneCount` is the live count, read once per tick by the caller — a count
 * per event would make eight events eight reads of a number that cannot change
 * between them.
 */
export function reassessGate(event: RecordedGate, cloneCount: number): GateVerdict {
  if (!event.requires_approval) return { act: "ungated" };
  // An approval is a person's act. This module is not one, and never overwrites one.
  if (event.approved_at) return { act: "approved" };

  const origin = originForTrigger(event.trigger);
  const blast = assessBlastRadius(event.mode as CascadeMode, cloneCount, origin);
  if (blast.requiresApproval) {
    return { act: "stands", reason: blast.reason ?? "Approval still required." };
  }
  return { act: "discharge", summary: dischargeSummary(cloneCount, origin) };
}

/**
 * The events to discharge, given the pending gated queue as it stands.
 *
 * Returned as ids plus one summary each rather than as whole rows: the caller
 * writes `requires_approval = false` and the summary, and nothing else.
 */
export function planGateReassessment(
  events: readonly RecordedGate[],
  cloneCount: number,
): { readonly discharge: ReadonlyArray<{ id: string; summary: string }>; readonly stood: number } {
  const discharge: Array<{ id: string; summary: string }> = [];
  let stood = 0;
  for (const e of events) {
    const verdict = reassessGate(e, cloneCount);
    if (verdict.act === "discharge") discharge.push({ id: e.id, summary: verdict.summary });
    else if (verdict.act === "stands") stood += 1;
  }
  return { discharge, stood };
}
