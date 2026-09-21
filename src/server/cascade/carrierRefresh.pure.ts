/**
 * A carrier may only stand a push down if it can still deliver it.
 *
 * ## The deadlock this closes
 *
 * `eventFold` enforces "at most one commit cascade waits", and the reason it
 * gives is exact: *"that event will deliver this push's content anyway,
 * because it reads prime's head when it runs"*. `createCascadeForAllClones`
 * acts on it — a push arriving while an unclaimed pending commit event exists
 * creates nothing at all and returns the carrier's id with `cloneCount: 0`.
 *
 * That premise is true of a clone whose result row is still `queued`. It is
 * false of every clone the carrier has already finished, because
 * `executeCascade` reads its work with `.eq("status", "queued")`: a terminal
 * row is never visited again by that event. While a carrier always ran to
 * completion the gap did not show — the event settled, the next push created
 * a fresh one, and the fresh one queued every clone. A carrier that does NOT
 * settle has no such relief.
 *
 * `cascade_follows_lineage` was thrown on 20 September 2026 and gave carriers
 * a reason not to settle. A child is held until its parent carries the commit
 * being delivered, the held event goes back to `pending` with *"Waiting on
 * lineage"*, and it is re-claimed every five minutes for as long as the wait
 * lasts — which in `pr` mode is a person's merge.
 *
 * ## What that cost, measured
 *
 * 20 Sep 2026 17:59:22Z prime merged `c4ceeeb`. At 18:00:26Z the carrier
 * delivered it to the two clones that read prime directly — pull requests
 * #228 on `npc-client-dashboard` and #13 on `npc-crm-independent` — and held
 * `preflight-property-group` and `npc-test-76b3b3` behind their parent.
 *
 * Both proposals went red within eleven minutes. #228's `security` job failed
 * on two Deno type errors in `urban-centre-register-ingest/index.ts`, which
 * were real: `c4ceeeb`'s own CI run on prime was CANCELLED rather than green,
 * superseded 84 seconds later by the push that fixed them (`62f42c3`,
 * confirmed green at `7f9ffc3`).
 *
 * Prime then pushed **nine** further commits. Every one stood down into the
 * held carrier. Neither proposal was touched again: both carry exactly one
 * commit, `cascade … from prime@c4ceeeb`, authored 18:00:26Z. Neither child
 * has a cascade pull request at all. Before 18:00 the same fleet had merged
 * four cascades that day on a roughly hourly cadence.
 *
 * So the repair prime had already shipped could not reach the clone whose
 * pull request the defect was blocking, and the two clones below it were
 * held behind that pull request. Four of four clones, frozen, with every
 * component reporting normal operation: the fold was folding, the hold was
 * holding, the drain was draining, and no row anywhere said "stuck".
 *
 * ## The rule
 *
 * **A claim re-queues every clone this carrier finished against a prime head
 * that is no longer the head it is about to deliver.** A clone already
 * finished against the current head is left exactly as it is, so a carrier
 * that has caught up refreshes nothing and the pass is a no-op.
 *
 * That is what makes the fold's sentence true again, and it is bounded by the
 * same fact: a refresh can only fire when prime's head has MOVED, so it costs
 * one pass per prime commit — precisely what the fleet paid before carriers
 * could hold, and never one per five-minute tick.
 *
 * ## What it will not touch
 *
 * **A settled event.** `completed_at` means the tally was written, the
 * notification raised and the audit row filed; those rows are history, and
 * re-running one by rewriting its status destroys the record of what happened
 * in order to make it happen again. `requeueDroppedClone` owns that case and
 * mints a new delivery rather than reviving a settled one. This module acts
 * only on a carrier that is still mid-flight — `pending`, never completed —
 * whose rows the engine already expects later passes to re-stamp.
 *
 * **A row that failed.** A failure is the drain's attempt accounting and
 * `requeueDroppedClone`'s judgement; silently re-queueing it here would
 * refund an attempt every pass and the ceiling that retires a bad event would
 * never be reached.
 *
 * **A row that delivered nothing.** `delivered_sha` is null on a skip that
 * decided about no content — a clone that was not found, a pin that failed
 * validation — and re-queueing one re-runs a refusal rather than a delivery.
 *
 * **Anything but a `commit` carrier.** A `manual` event is an operator's
 * explicit act and a `scheduled` one is a policy's; nothing stands down into
 * either, so neither is owed this, and refreshing one would re-run somebody's
 * named decision against content they did not name. A scoped event delivers a
 * module rather than prime's head and is excluded for the same reason
 * `eventFold` excludes it.
 *
 * Client-safe: pure, no imports.
 */

import type { ReconciledStatus } from "./prReconcile.pure";

/** The result row, as much of it as this decision reads. */
export type CarrierResultRow = {
  id: string;
  /** The clone the row is about. Used only to describe the refresh. */
  clone_name: string | null;
  status: string;
  /** The prime head the pass that wrote this row delivered. */
  delivered_sha: string | null;
};

/** The carrier, as much of it as this decision reads. */
export type CarrierEventFacts = {
  trigger: string;
  /** Non-null once the event has settled. A settled event is history. */
  completed_at: string | null;
  scope_filter: unknown;
};

export type CarrierRefreshDecision =
  /** Nothing to re-offer. `why` is for the log, never for an operator. */
  | { kind: "none"; why: string }
  /** These rows go back to `queued` before the pass reads its work. */
  | { kind: "refresh"; rowIds: string[]; clones: string[]; why: string };

/**
 * The statuses a delivery can settle a row at.
 *
 * **Read off the table, not off the code that writes it.** The first version
 * of this set was `succeeded | skipped`, inferred from `executeCascade`'s
 * return shapes — and it would have refused to re-offer the very carrier this
 * module was written for. Both of its finished rows carry **`pr_opened`**,
 * which is the stamp a FRESHLY opened or updated proposal holds until the
 * merge drain reconciles it. Measured over the whole ledger on 21 Sep 2026:
 *
 *     succeeded  631   skipped  396   failed  42   pr_opened  3   queued  2
 *
 * All three `pr_opened` rows carry a `delivered_sha` and a `pull_request` URL.
 * It is rare only because it is transient, and transient is exactly the state
 * a held carrier's rows sit in.
 *
 * So the set is anchored to `ReconciledStatus` — the three statuses
 * `prReconcile` declares a settled row may hold — and the assignment below is
 * a compile-time exhaustiveness check, so a fourth terminal status cannot be
 * added to the pipeline without this module being made to have an opinion
 * about it.
 *
 * `failed` is deliberately absent; see the module header. It is not a
 * `ReconciledStatus` either, which is the same statement from the other side.
 */
const DELIVERED: Record<ReconciledStatus, true> = {
  succeeded: true,
  pr_opened: true,
  skipped: true,
};

export const DELIVERED_STATUSES: ReadonlySet<string> = new Set(Object.keys(DELIVERED));

/** Whether a scope filter narrows anything. `{}` and null do not. */
function scopeIsEmpty(scopeFilter: unknown): boolean {
  if (scopeFilter == null) return true;
  if (typeof scopeFilter !== "object" || Array.isArray(scopeFilter)) return false;
  return Object.keys(scopeFilter as Record<string, unknown>).length === 0;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Whether this EVENT is the kind that may re-offer anything, before its rows
 * are read at all.
 *
 * Separate from the row decision for one reason: it lets the caller refuse
 * without a query. Every refusal here is a property of the event, and none of
 * them can change by reading rows — so a manual event, a scoped one or a
 * settled one costs no round trip, and a five-minute claim loop over a carrier
 * this module has no opinion about spends nothing.
 */
export function carrierMayRefresh(
  event: CarrierEventFacts,
  head: string,
): { ok: true } | { ok: false; why: string } {
  if (!head.trim()) {
    return { ok: false, why: "no prime head was resolved for this pass" };
  }
  if (event.trigger !== "commit") {
    return {
      ok: false,
      why: `a ${event.trigger} event is a named act about a named moment; nothing stands down into it`,
    };
  }
  if (event.completed_at !== null) {
    return {
      ok: false,
      why: "the event has settled, and a settled delivery is a record rather than work in flight",
    };
  }
  if (!scopeIsEmpty(event.scope_filter)) {
    return { ok: false, why: "a scoped event delivers a named module rather than prime's head" };
  }
  return { ok: true };
}

export function planCarrierRefresh(input: {
  event: CarrierEventFacts;
  rows: readonly CarrierResultRow[];
  /** The prime head this pass resolved and is about to deliver. */
  head: string;
}): CarrierRefreshDecision {
  const head = input.head.trim();
  const gate = carrierMayRefresh(input.event, input.head);
  if (!gate.ok) return { kind: "none", why: gate.why };

  const stale = input.rows.filter(
    (r) => DELIVERED_STATUSES.has(r.status) && Boolean(r.delivered_sha) && r.delivered_sha !== head,
  );
  if (stale.length === 0) {
    return { kind: "none", why: `every delivered row already names prime@${shortSha(head)}` };
  }

  const clones = stale.map((r) => r.clone_name?.trim() || "an unnamed clone");
  const behind = [...new Set(stale.map((r) => shortSha(r.delivered_sha as string)))].sort();
  return {
    kind: "refresh",
    rowIds: stale.map((r) => r.id),
    clones,
    why:
      `${stale.length} clone(s) were delivered prime@${behind.join(", prime@")} by an earlier ` +
      `pass of this carrier and are re-offered prime@${shortSha(head)}: a commit cascade stands ` +
      `every later push down on the promise that it delivers prime's head at run time, and a ` +
      `finished row is one this event would otherwise never visit again.`,
  };
}

/**
 * The one sentence a refresh adds to the pass's own story.
 *
 * Composed here rather than at the call site because the engine already has
 * two summary writers and a third spelling of the same fact is how two ends
 * come to disagree about what happened.
 */
export function describeCarrierRefresh(decision: CarrierRefreshDecision): string | null {
  if (decision.kind !== "refresh") return null;
  const names = [...new Set(decision.clones)].sort();
  return `Re-offered to ${names.join(", ")} — ${decision.why}`;
}
