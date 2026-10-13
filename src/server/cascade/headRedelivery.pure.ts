/**
 * Prime's head is owed a delivery until a pass has actually made one.
 *
 * ## The hole the beacon could not see
 *
 * The drift beacon (driftBeacon.pure.ts) fires when prime's head has NO
 * cascade event, and it is deliberately silent once one exists — "whatever
 * its status", because a failed event may be a reviewer's refusal and
 * re-firing over their head would retry what was refused. That silence is
 * exactly how the fleet stopped following prime in October 2026, twice:
 *
 *  - **The head's own event failed automatically.** Five commit events in a
 *    row (adca3c7e, 9aea274a, d6334800, 211c4329, 050dedb7) were retired at
 *    the attempt ceiling while one clone's variant merges re-ran every tick
 *    without persisting a verdict. Nobody rejected anything; the counter ran
 *    out. The beacon saw "the head has an event" and said nothing.
 *  - **The head's event was folded into a carrier that then failed.** The
 *    claim-time fold closes a newer commit event as `completed` with a
 *    summary naming the survivor — correct while the survivor lives, because
 *    the survivor reads prime's head when it runs. When the survivor was
 *    retired, ec155f6's event still read `completed`, nothing owed it, and
 *    the beacon was silent over a head no pass had ever delivered.
 *
 * Both read, from inside the queue, as an idle fleet that is up to date.
 *
 * ## Why a new delivery rather than a revival
 *
 * A settled event is a true record: that delivery was attempted, on that
 * day, and it failed. Rewriting it to `pending` to run it again destroys the
 * record of what happened in order to make it happen again, and it breaks the
 * attempt accounting — `decideExhaustedEvent` refunds an attempt whenever the
 * event's result rows were written recently, so an in-place retry rewrites
 * its own evidence of failure. `requeueDroppedClone.pure.ts` and
 * `carrierRefresh.pure.ts` both state the same rule, and this follows it: the
 * failed event is untouched, and a NEW fleet delivery is minted that names it
 * (`scope_filter.retry_of`, which the lineage panel already walks). A cascade
 * reads prime's head when it RUNS, so the new delivery carries whatever prime
 * is when it is claimed — no SHA is re-stamped and no unique index is raced.
 *
 * ## The rule
 *
 * On an idle tick, a head event whose delivery FAILED AUTOMATICALLY — its own
 * failure, or the failure of the carrier it was folded into — earns one new
 * delivery. Four things bound it:
 *
 *  - **A person's refusal is never undone.** `rejectCascade` writes `failed`
 *    too; its summary is `Rejected by reviewer…` and that is final, on the
 *    head, on its carrier and on a redelivery alike. A head still awaiting a
 *    second operator is theirs, not the drain's.
 *  - **Nothing else in flight.** A pending or running delivery the drain owns
 *    already reads prime's head when it runs; minting beside it would push the
 *    same tree twice and leave two proposals to reconcile.
 *  - **A cooldown.** The commonest automatic failure is GitHub's hourly
 *    budget, which only time repairs — so a redelivery waits an hour from the
 *    failure, from the last redelivery's minting, and from its settling.
 *  - **A ceiling.** Three redeliveries per head event. After that the failure
 *    is not transient, the notification the failure raised stands, and an
 *    operator is owed a look. Redeliveries are counted from the audit log,
 *    which is written BEFORE the new event — a redelivery that cannot be
 *    counted is one that cannot be bounded, so a failed count refuses.
 *
 * A `partial` outcome counts as a failure: some clone it owed is still behind,
 * and nothing else will ask again until prime moves. A clone that landed is
 * cheap to re-ask — its pass finds nothing owed.
 *
 * ## Two ticks, one redelivery
 *
 * The drain holds no lock, so two idle ticks can overlap: both read no live
 * delivery and the same prior count, and both decide redelivery N. Nothing in
 * the audit log is unique, so a counter alone cannot stop both minting. The
 * EVENT id is what stops it: `redeliveryEventId` derives it from the head
 * event and N, so both ticks name the same row, and `cascade_events`' primary
 * key admits exactly one. The tick that loses reads 23505 and stops before it
 * arms a single clone. The loser's audit row still lands, so the count is
 * taken over distinct redelivery ids (`priorRedeliveriesFrom`): a second row
 * for the same redelivery is the same redelivery, and it never spends the
 * ceiling. No migration is needed for any of it.
 *
 * Client-safe: pure. It decides whether to mint and what to mint; the drain
 * owns every read and write.
 */
import { supersededSummary } from "./eventFold.pure";

/** What `rejectCascade` writes. A summary beginning so is a person's "no". */
export const REJECTION_SUMMARY_PREFIX = "Rejected by reviewer";

/** The prefix `supersededSummary` composes, so a folded event is recognised. */
export const SUPERSEDED_SUMMARY_PREFIX = "Superseded: folded into queued cascade ";

/** An hour: GitHub's budget window, the commonest automatic failure. */
export const HEAD_REDELIVERY_COOLDOWN_MS = 60 * 60_000;

/** Redeliveries per head event before the failure is a person's problem. */
export const HEAD_REDELIVERY_MAX = 3;

/** The audit action every redelivery writes, and the one the ceiling counts. */
export const HEAD_REDELIVERY_AUDIT_ACTION = "cascade.head_redelivered";

/** The `scope_filter.scope` a redelivery carries, so it reads as what it is. */
export const HEAD_REDELIVERY_SCOPE = "head_redelivery";

export type CascadeModeWord = "pr" | "auto_merge" | "notify";

export type RedeliveryEventReading = {
  id: string;
  status: string;
  mode: string;
  summary: string | null;
  requires_approval: boolean;
  approved_at: string | null;
  worker_finished_at: string | null;
  completed_at: string | null;
  updated_at: string;
  created_at: string;
};

export type HeadRedeliveryCause = "head_failed" | "carrier_failed";

/** What the audit log says about the redeliveries already minted for a head. */
export type PriorRedeliveries = {
  count: number;
  /** When the newest was minted. */
  lastAt: string | null;
  /** The newest redelivery's event id, as its audit row recorded it. */
  lastEventId: string | null;
};

/**
 * The prior redeliveries of one head, read from its audit rows NEWEST FIRST.
 *
 * Counted by distinct `redelivery_event_id`, because two overlapping ticks can
 * both write a row for the same redelivery and only one of them minted it. A
 * row that names no id — none this module writes, but the log is not ours
 * alone — counts on its own: an uncountable row must make the ceiling nearer,
 * never further.
 */
export function priorRedeliveriesFrom(
  rows: readonly { created_at: string | null; metadata: unknown }[],
): PriorRedeliveries {
  const ids = new Set<string>();
  let unnamed = 0;
  for (const row of rows) {
    const id = redeliveryIdOf(row.metadata);
    if (id === null) unnamed += 1;
    else ids.add(id);
  }
  const newest = rows[0];
  return {
    count: ids.size + unnamed,
    lastAt: newest?.created_at ?? null,
    lastEventId: newest ? redeliveryIdOf(newest.metadata) : null,
  };
}

function redeliveryIdOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const id = (metadata as Record<string, unknown>).redelivery_event_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * The namespace every redelivery id is derived in. Changing it changes every
 * id this module will ever mint, so a tick running the old build and one
 * running the new would no longer collide on the same redelivery. Never
 * change it.
 */
export const HEAD_REDELIVERY_ID_NAMESPACE = "4b98edb5-2039-4c6c-b63c-ba17a08acf71";

/**
 * The event id of redelivery `redelivery` of head event `headEventId`: the
 * same pair always names the same row, so two ticks that both decide it
 * insert one event between them. A version-5 (name-based, SHA-1) UUID, per
 * RFC 9562 §5.5, so it is an ordinary `uuid` to Postgres and to every reader.
 */
export async function redeliveryEventId(headEventId: string, redelivery: number): Promise<string> {
  return nameBasedUuid(HEAD_REDELIVERY_ID_NAMESPACE, `${headEventId}#redelivery-${redelivery}`);
}

/** RFC 9562 §5.5: SHA-1 over namespace bytes and the UTF-8 name. */
export async function nameBasedUuid(namespace: string, name: string): Promise<string> {
  const ns = namespace.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(ns)) throw new Error(`not a UUID namespace: ${namespace}`);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(new ArrayBuffer(16 + nameBytes.length));
  for (let i = 0; i < 16; i += 1) input[i] = Number.parseInt(ns.slice(i * 2, i * 2 + 2), 16);
  input.set(nameBytes, 16);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type HeadRedeliveryVerdict =
  | {
      redeliver: true;
      cause: HeadRedeliveryCause;
      /** The settled delivery that failed: the head's event, or its carrier. */
      failedDeliveryId: string;
      mode: CascadeModeWord;
      /** Which redelivery of this head this is, 1-based. */
      redelivery: number;
    }
  | { redeliver: false; why: string };

export function isReviewerRejection(summary: string | null): boolean {
  return (summary ?? "").startsWith(REJECTION_SUMMARY_PREFIX);
}

export function isSupersededSummary(summary: string | null): boolean {
  return (summary ?? "").startsWith(SUPERSEDED_SUMMARY_PREFIX);
}

function awaitingApproval(e: RedeliveryEventReading): boolean {
  return e.requires_approval && e.approved_at === null;
}

function inFlight(e: RedeliveryEventReading): boolean {
  return e.status === "pending" || e.status === "running";
}

function failedAutomatically(e: RedeliveryEventReading): boolean {
  return (e.status === "failed" || e.status === "partial") && !isReviewerRejection(e.summary);
}

function isModeWord(mode: string): mode is CascadeModeWord {
  return mode === "pr" || mode === "auto_merge" || mode === "notify";
}

/** When the event stopped, for the cooldown. Falls back to its last write. */
export function settledAt(e: RedeliveryEventReading): string {
  return e.worker_finished_at ?? e.completed_at ?? e.updated_at;
}

/**
 * The carrier a superseded event names. `supersededSummary` carries only an
 * 8-character prefix of the survivor's id, so the summary is recomposed for
 * each candidate and compared whole — never parsed. The newest match wins,
 * which is the one the fold could have chosen: a survivor is never younger
 * than the event folded into it.
 */
export function findSupersedingCarrier<T extends { id: string; created_at: string }>(
  summary: string | null,
  candidates: readonly T[],
): T | null {
  if (!isSupersededSummary(summary)) return null;
  const matches = candidates
    .filter((c) => supersededSummary(c.id) === summary)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return matches[0] ?? null;
}

/**
 * Decide whether prime's head is owed a new delivery, or refuse and say why.
 *
 * Every refusal is fail-closed: an unreadable fact refuses. A drain that
 * mints on "I could not check" mints on every tick a database hiccups.
 */
export function decideHeadRedelivery(input: {
  head: RedeliveryEventReading;
  /** The carrier the head was folded into, when its summary names one. */
  carrier: RedeliveryEventReading | null;
  /** True when the carrier could not be read; a failed read is no verdict. */
  carrierUnreadable: boolean;
  /**
   * Deliveries the drain still owns — pending and not waiting on a person,
   * or running — on ANY event. Null when the count could not be read.
   */
  liveDeliveries: number | null;
  /** Prior redeliveries of this head, or null when the audit log was unreadable. */
  prior: PriorRedeliveries | null;
  /**
   * The newest prior redelivery's event, when `prior.lastEventId` names one.
   * Null when there is none or when it no longer exists.
   */
  lastRedelivery: RedeliveryEventReading | null;
  /** True when the newest redelivery could not be read. */
  lastRedeliveryUnreadable: boolean;
  nowMs: number;
}): HeadRedeliveryVerdict {
  const { head } = input;
  if (input.prior === null) {
    return {
      redeliver: false,
      why: "the redelivery count could not be read, and a redelivery that cannot be counted cannot be bounded",
    };
  }
  if (input.liveDeliveries === null) {
    return {
      redeliver: false,
      why: "the queue could not be read, and a failed read is not an idle fleet",
    };
  }
  if (input.liveDeliveries > 0) {
    return {
      redeliver: false,
      why: "a delivery is already in the drain's hands, and it reads prime's head when it runs",
    };
  }
  if (inFlight(head)) {
    return { redeliver: false, why: "the head's event is still in the queue's hands" };
  }
  if (awaitingApproval(head)) {
    return { redeliver: false, why: "the head's event awaits a second operator" };
  }
  if (isReviewerRejection(head.summary)) {
    return { redeliver: false, why: "a reviewer rejected the head's event, and that is final" };
  }

  let cause: HeadRedeliveryCause;
  let failed: RedeliveryEventReading;
  if (head.status === "completed" && isSupersededSummary(head.summary)) {
    if (input.carrierUnreadable) {
      return {
        redeliver: false,
        why: "the carrier could not be read, and a failed read is no verdict",
      };
    }
    const carrier = input.carrier;
    if (!carrier) {
      return {
        redeliver: false,
        why: "the carrier the head was folded into could not be found",
      };
    }
    if (inFlight(carrier)) {
      return { redeliver: false, why: "the carrier is still queued and will deliver prime's head" };
    }
    if (awaitingApproval(carrier)) {
      return { redeliver: false, why: "the carrier awaits a second operator" };
    }
    if (!failedAutomatically(carrier)) {
      return {
        redeliver: false,
        why:
          carrier.status === "completed"
            ? "the carrier completed, and it read prime's head when it ran"
            : "a reviewer rejected the carrier, and the head's delivery with it",
      };
    }
    cause = "carrier_failed";
    failed = carrier;
  } else if (failedAutomatically(head)) {
    cause = "head_failed";
    failed = head;
  } else {
    return { redeliver: false, why: "the head's event delivered" };
  }

  if (!isModeWord(failed.mode)) {
    return {
      redeliver: false,
      why: "the failed delivery's mode could not be read, and a repair may not choose how a tenant's code lands",
    };
  }

  // The newest redelivery decides before the ceiling does: one that is still
  // running is the delivery, one that landed means the head is delivered, and
  // one a reviewer refused is a refusal of the head.
  let lastSettledAt: string | null = null;
  if (input.prior.lastEventId !== null) {
    if (input.lastRedeliveryUnreadable) {
      return {
        redeliver: false,
        why: "the last redelivery could not be read, and a failed read is no verdict",
      };
    }
    const last = input.lastRedelivery;
    if (last) {
      if (inFlight(last) || awaitingApproval(last)) {
        return { redeliver: false, why: "the last redelivery is still in the queue's hands" };
      }
      if (last.status === "completed") {
        return { redeliver: false, why: "the last redelivery delivered prime's head" };
      }
      if (isReviewerRejection(last.summary)) {
        return {
          redeliver: false,
          why: "a reviewer rejected the last redelivery, and that is final",
        };
      }
      lastSettledAt = settledAt(last);
    }
    // A redelivery the audit names and the table does not hold was deleted or
    // never armed. Either way it delivered nothing, and the ceiling and the
    // cooldown below still count it.
  }

  if (input.prior.count >= HEAD_REDELIVERY_MAX) {
    return {
      redeliver: false,
      why: `redelivered ${input.prior.count} times already — the failure is not transient, and an operator is owed a look`,
    };
  }
  const since = [settledAt(failed), input.prior.lastAt, lastSettledAt]
    .map((t) => (t ? Date.parse(t) : Number.NaN))
    .filter((t) => Number.isFinite(t));
  if (since.length === 0) {
    return { redeliver: false, why: "no readable time for the failure; the next tick looks again" };
  }
  if (input.nowMs - Math.max(...since) < HEAD_REDELIVERY_COOLDOWN_MS) {
    return {
      redeliver: false,
      why: "cooling down — the commonest cause is GitHub's hourly budget",
    };
  }
  return {
    redeliver: true,
    cause,
    failedDeliveryId: failed.id,
    mode: failed.mode,
    redelivery: input.prior.count + 1,
  };
}

/**
 * The event row a redelivery inserts, minus the id the caller assigns.
 *
 * `trigger: "scheduled"` because no push minted it and no person pressed
 * anything — and because `commit` is the one trigger whose `source_sha` the
 * unique index binds, which the head's own event already holds.
 * `requires_approval: false` is the blast-radius rule's own answer for what
 * this is: prime's history arriving (`origin: "automatic"`), not a proposal.
 * The non-empty `scope_filter` keeps the claim-time fold and the carrier
 * refresh — both commit-only and unscoped-only — from treating it as a
 * carrier, and the engine reads nothing from it but `module_globs`, which it
 * does not carry: the pass is the full tree at prime's head.
 */
export function redeliveryEvent(input: {
  headEventId: string;
  failedDeliveryId: string;
  cause: HeadRedeliveryCause;
  mode: CascadeModeWord;
  redelivery: number;
  headSha: string;
  sourceBranch: string;
}): {
  trigger: "scheduled";
  mode: CascadeModeWord;
  status: "pending";
  requires_approval: false;
  initiated_by: null;
  source_sha: string;
  source_branch: string;
  scope_filter: {
    scope: typeof HEAD_REDELIVERY_SCOPE;
    retry_of: string;
    redelivers_head_event: string;
    redelivery: number;
  };
  summary: string;
} {
  return {
    trigger: "scheduled",
    mode: input.mode,
    status: "pending",
    requires_approval: false,
    // The drain is machinery, not a person, and saying otherwise would put a
    // name on an act nobody took.
    initiated_by: null,
    source_sha: input.headSha,
    source_branch: input.sourceBranch,
    scope_filter: {
      scope: HEAD_REDELIVERY_SCOPE,
      retry_of: input.failedDeliveryId,
      redelivers_head_event: input.headEventId,
      redelivery: input.redelivery,
    },
    summary: redeliverySummary(input),
  };
}

/** The summary a redelivery carries until its pass writes its own. */
export function redeliverySummary(input: {
  headEventId: string;
  failedDeliveryId: string;
  cause: HeadRedeliveryCause;
  redelivery: number;
  headSha: string;
}): string {
  const what =
    input.cause === "carrier_failed"
      ? `its event (${input.headEventId.slice(0, 8)}) was folded into cascade ` +
        `${input.failedDeliveryId.slice(0, 8)}, which failed without delivering it`
      : `its event (${input.headEventId.slice(0, 8)}) failed without a reviewer refusing it`;
  return (
    `Redelivery ${input.redelivery} of ${HEAD_REDELIVERY_MAX} raised by the drain — ` +
    `prime@${input.headSha.slice(0, 7)} was owed a delivery: ${what}. ` +
    `The failed event is untouched; this pass delivers prime's head as it stands.`
  );
}
