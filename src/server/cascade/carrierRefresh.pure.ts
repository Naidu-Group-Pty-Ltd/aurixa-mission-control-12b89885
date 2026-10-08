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
 * **A row that failed against the head it is about to deliver.** A failed
 * row IS re-offered, once per prime head and never more; see "A row that
 * failed" below for why it has to be and what bounds it.
 *
 * **A skip that delivered nothing.** `delivered_sha` is null on a skip that
 * decided about no content, such as a clone that was not found, and
 * re-queueing one re-runs a refusal rather than a delivery. A pin that failed
 * validation is written `failed`, not skipped, and is offered once per head
 * like any failure: a pin is something a person edits.
 *
 * **Anything but a `commit` carrier.** A `manual` event is an operator's
 * explicit act and a `scheduled` one is a policy's; nothing stands down into
 * either, so neither is owed this, and refreshing one would re-run somebody's
 * named decision against content they did not name. A scoped event delivers a
 * module rather than prime's head and is excluded for the same reason
 * `eventFold` excludes it.
 *
 * ## A row that failed
 *
 * This module first refused every failed row, on the reasoning that a failure
 * belongs to the drain's attempt accounting and to `requeueDroppedClone`.
 * Neither ever sees it on a carrier that is still mid-flight, and that refusal
 * was the second deadlock of the same shape.
 *
 * Carrier 15d4574f, measured 7–8 Oct 2026. At 16:53Z on 7 Oct both parent
 * rows — `npc-client-dashboard` (e40b1d34) and `npc-crm-independent`
 * (282695be) — failed with an EMPTY error message, while the pull requests
 * they had opened (#315 and #81) stayed open. `executeCascade` reads only
 * `queued` rows, so the event never visited them again. Their children were
 * held by lineage, because neither parent's `last_synced_sha` could now reach
 * the head. A held event goes back to `pending` every five minutes and the
 * hold is refunded as a deferral, so the carrier never settled. A carrier that
 * never settles is never judged by `requeueDroppedClone`, which acts on a
 * settled partial event alone, and the drift beacon stays silent while a
 * claimable carrier waits. Three more prime pushes folded into it. Four
 * clones were held for fourteen hours behind one fault that left no words,
 * until a person re-armed the two rows by hand at 06:58Z on 8 Oct, and every
 * component reported normal operation throughout.
 *
 * So a failed row on a mid-flight carrier is re-offered, and **the bound is
 * the head it failed against**. No column records that head, so every place
 * the engine writes a failed row composes its message through
 * `stampFailedAgainst`, which leads it with `Failed against prime@<sha>`, and
 * this module reads it back through `failedAgainst`. A row that failed against
 * the head this pass is about to deliver is left alone, so a deterministic
 * failure costs one attempt per prime commit — exactly what the fleet paid
 * before carriers could hold — and never one per five-minute tick. A row
 * failed against an older head, or written before the stamp existed, is owed
 * one attempt at the current head, and that attempt stamps it.
 *
 * A failed row needs no `delivered_sha` to qualify, unlike a delivered one: a
 * failure is precisely a pass that delivered nothing, and the rule that
 * excludes an empty `delivered_sha` is about skips that decided about no
 * content, which a failure never did.
 *
 * Client-safe: pure, no imports of runtime code.
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
  /**
   * Read only on a failed row, for the head it failed against
   * (`failedAgainst`). Optional so a caller that reads no failed rows need
   * not select it; absent reads as unstamped.
   */
  error_message?: string | null;
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
 * `failed` is deliberately absent: it is not a delivery and it is not a
 * `ReconciledStatus`. A failed row is re-offered by its own rule, bounded by
 * the head it failed against rather than the head it delivered; see "A row
 * that failed" in the module header.
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

/** `Failed against prime@<7–40 hex> — `, at the start of a message. */
const FAILED_AGAINST_STAMP = /^Failed against prime@([0-9a-f]{7,40}) — /;

/** What a failure with no words of its own says, so the stamp never ends on a dash. */
export const UNEXPLAINED_FAILURE = "no message was returned with the failure";

/**
 * A failed row's `error_message`, led by the prime head the pass that failed
 * was delivering. The one composer every failed-row write goes through; see
 * "A row that failed" in the module header.
 *
 * Idempotent, and it never stacks: an earlier stamp is replaced rather than
 * prefixed, so a row that fails against three heads in turn names the last.
 * An empty message is replaced with `UNEXPLAINED_FAILURE` rather than left
 * blank, because a blank failure is what nobody could diagnose on 15d4574f.
 * With no head resolved there is nothing true to stamp, and the message is
 * returned unstamped — which this module reads as owed one re-offer.
 */
export function stampFailedAgainst(head: string, message: string | null | undefined): string {
  let rest = (message ?? "").trim();
  for (let m = rest.match(FAILED_AGAINST_STAMP); m; m = rest.match(FAILED_AGAINST_STAMP)) {
    rest = rest.slice(m[0].length).trim();
  }
  const body = rest || UNEXPLAINED_FAILURE;
  const sha = head.trim();
  return sha ? `Failed against prime@${shortSha(sha)} — ${body}` : body;
}

/**
 * The prime head a failed row's message says it failed against, as the
 * stamp spelt it (a prefix of the full SHA), or null where it carries none.
 */
export function failedAgainst(errorMessage: string | null | undefined): string | null {
  const m = (errorMessage ?? "").trim().match(FAILED_AGAINST_STAMP);
  return m ? m[1] : null;
}

/**
 * The patch a finished pass writes onto its row, settled for the two things
 * the row's `error_message` must say.
 *
 * **A failure names the head it failed against** (`stampFailedAgainst`),
 * because that is the only record of which head a failed row has had its
 * attempt at.
 *
 * **A delivery carries no note an earlier pass left.** A row held by lineage
 * or deferred by a rate limit is written `Held: …` or `Deferred until …` and
 * stays `queued`; the pass that later delivers it wrote no `error_message`,
 * so the old note survived beside a success. Measured on 8 Oct 2026, 133
 * `succeeded` rows still read "Parent NPC Client Dashboard carries prime@…;
 * this pass delivers prime@…. Reading its branch now would hand this clone
 * the older tree while the event claimed the newer one.", and 14 more still
 * read "Deferred until …". Each stopped being true the moment its row
 * delivered. A patch that names its own `error_message` keeps it.
 *
 * Every other status passes through untouched: `queued` is a pause whose
 * note is current.
 */
export function settledRowPatch<P extends { status?: unknown; error_message?: string | null }>(
  patch: P,
  head: string,
): P & { error_message?: string | null } {
  if (patch.status === "failed") {
    const message = typeof patch.error_message === "string" ? patch.error_message : null;
    return { ...patch, error_message: stampFailedAgainst(head, message) };
  }
  if (
    typeof patch.status === "string" &&
    DELIVERED_STATUSES.has(patch.status) &&
    !("error_message" in patch)
  ) {
    return { ...patch, error_message: null };
  }
  return patch;
}

/** Whether a failed row has already had its attempt at `head`. */
function failedAgainstHead(row: CarrierResultRow, head: string): boolean {
  const stamped = failedAgainst(row.error_message);
  return stamped !== null && head.startsWith(stamped);
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
  const failed = input.rows.filter((r) => r.status === "failed" && !failedAgainstHead(r, head));
  if (stale.length === 0 && failed.length === 0) {
    return {
      kind: "none",
      why: `every delivered row already names prime@${shortSha(head)} and no failed row is owed an attempt at it`,
    };
  }

  const name = (r: CarrierResultRow) => r.clone_name?.trim() || "an unnamed clone";
  const reasons: string[] = [];
  if (stale.length > 0) {
    const behind = [...new Set(stale.map((r) => shortSha(r.delivered_sha as string)))].sort();
    reasons.push(
      `${stale.length} clone(s) were delivered prime@${behind.join(", prime@")} by an earlier ` +
        `pass of this carrier and are re-offered prime@${shortSha(head)}: a commit cascade stands ` +
        `every later push down on the promise that it delivers prime's head at run time, and a ` +
        `finished row is one this event would otherwise never visit again.`,
    );
  }
  if (failed.length > 0) {
    const against = [
      ...new Set(
        failed.map((r) => failedAgainst(r.error_message)).filter((v): v is string => v !== null),
      ),
    ]
      .map(shortSha)
      .sort();
    const when =
      against.length > 0
        ? `against prime@${against.join(", prime@")}`
        : "before the head was recorded";
    reasons.push(
      `${failed.length} clone(s) failed ${when} and are offered prime@${shortSha(head)} once: ` +
        `a failed row on a carrier that has not settled is visited by nothing else, and a ` +
        `parent left there holds every clone below it.`,
    );
  }
  const rows = [...stale, ...failed];
  return {
    kind: "refresh",
    rowIds: rows.map((r) => r.id),
    clones: rows.map(name),
    why: reasons.join(" "),
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
