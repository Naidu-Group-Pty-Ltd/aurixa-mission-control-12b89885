/**
 * Re-offering a clone's part of a delivery that landed for everybody else.
 *
 * ## The condition
 *
 * `cascadeEventStatus` maps a run with `failed > 0` and at least one success
 * to `partial`, and `executeCascade` writes that with `completed_at` — the
 * event's final settle. `partial` is then terminal to every retry path in the
 * system: the drain claims `.eq("status", "pending")`, and its only revival
 * rule matches a result row still at `pushing` past the stall cutoff, which a
 * `failed` row can never be. So the dropped clone's part of that delivery is
 * never re-offered by anything.
 *
 * Measured 19 September 2026: 15 partial events and 17 failed rows across all
 * three cascading clones — Preflight (8, 4–11 Sep), NPC Client Dashboard (4,
 * 8 Sep), NPC Test (1, 16 Sep, still open). None was ever retried.
 *
 * **The measured harm to date is zero, and that is the point.** What rescued
 * every one of them was incidental: a later full-tree commit cascade reads
 * prime's head at run time and happened to carry the same paths. That is a
 * property of today's traffic, not a guarantee — it evaporates exactly when
 * deliveries stop, which is the only time it is needed, and which is the
 * fleet's state right now. It also cannot help a SCOPED delivery at all:
 * fourteen events in the table carry a real `scope_filter`, and nothing
 * fleet-wide supersedes those by construction.
 *
 * ## Why a new delivery rather than a revival
 *
 * The act's own policy text has said since it was catalogued: *"Queue this
 * clone's part again as a NEW scoped delivery, never by reviving a settled
 * one."* A settled `partial` event is a true record — that delivery did land
 * for those clones, on that day, at that SHA — and rewriting its status to
 * re-run it destroys the record of what happened in order to make it happen
 * again. The new delivery names its parent instead, so the pair reads as
 * history plus repair rather than as one event that changed its mind.
 *
 * It also keeps the attempt accounting honest. `decideExhaustedEvent` refunds
 * an attempt whenever the event's result rows were written recently, so an
 * in-place retry loop would rewrite the failed row every pass, refund every
 * time, and never reach the ceiling that retires it. A fresh event has its own
 * attempts and its own ceiling.
 *
 * ## What this module decides, and what it does not
 *
 * It decides WHETHER to mint and WHAT to mint. It performs nothing: the
 * custodian owns the writes, the dry run and the per-clone daily cap. Keeping
 * the judgement here is what lets every refusal below be exercised without a
 * database, and the refusals are most of the value — a custodian that mints a
 * duplicate delivery every tick is worse than one that mints none.
 */

export type DroppedCloneFacts = {
  /** The settled event whose delivery dropped this clone. */
  sourceEventId: string;
  /** The mode that event ran in. A `pr` parent may never become an auto-merge child. */
  sourceMode: "pr" | "auto_merge" | "notify" | null;
  /** The clone that was dropped. */
  cloneId: string;
  /**
   * Whether this clone already has an unsettled delivery waiting — pending,
   * running, or a queued result row on any event. Null when unreadable.
   */
  hasLiveDelivery: boolean | null;
  /**
   * Whether a re-queue for THIS source event has already been minted. Read
   * from `scope_filter.retry_of`, so it survives a restart and a redeploy.
   */
  alreadyRequeued: boolean | null;
};

export type RequeuePlan =
  | {
      mint: true;
      /** The event row to insert, minus the ids the database assigns. */
      event: {
        trigger: "scheduled";
        mode: "pr" | "auto_merge" | "notify";
        status: "pending";
        initiated_by: null;
        scope_filter: { scope: "filtered"; clone_ids: string[]; retry_of: string; requeue: true };
        summary: string;
      };
      why: string;
    }
  | { mint: false; why: string };

/**
 * Plan a re-queue, or refuse and say why.
 *
 * Every refusal is fail-closed: an unreadable fact refuses. A custodian that
 * mints on "I could not check" mints on every tick that a database hiccups.
 */
export function planRequeue(facts: DroppedCloneFacts): RequeuePlan {
  if (facts.alreadyRequeued === null) {
    return {
      mint: false,
      why: "Could not check whether this delivery was already re-queued, and an unreadable check is not a no.",
    };
  }
  if (facts.alreadyRequeued) {
    return {
      mint: false,
      why: "This delivery has already been re-queued for this clone; a second one would deliver the same tree twice.",
    };
  }
  if (facts.hasLiveDelivery === null) {
    return {
      mint: false,
      why: "Could not check whether a delivery is already in flight for this clone.",
    };
  }
  if (facts.hasLiveDelivery) {
    // Not merely wasteful. A cascade reads prime's head when it RUNS, so a
    // delivery already waiting will carry everything this one would — minting
    // beside it buys a second push of the same tree and two proposals to
    // reconcile.
    return {
      mint: false,
      why: "A delivery is already queued for this clone and will carry prime's head when it runs.",
    };
  }
  if (facts.sourceMode === null) {
    return {
      mint: false,
      why: "The dropped delivery's mode could not be read, and a repair may not choose how a tenant's code lands.",
    };
  }

  return {
    mint: true,
    event: {
      trigger: "scheduled",
      mode: facts.sourceMode,
      status: "pending",
      // The custodian is machinery, not a person, and saying otherwise would
      // put a name on an act nobody took.
      initiated_by: null,
      scope_filter: {
        scope: "filtered",
        clone_ids: [facts.cloneId],
        // `retry_of` rather than a new key: the lineage panel already walks
        // this one, so the repair is visible beside its parent with no change
        // to any surface.
        retry_of: facts.sourceEventId,
        requeue: true,
      },
      summary:
        `Re-queued for one clone that was dropped from a partial delivery ` +
        `(${facts.sourceEventId.slice(0, 8)}). The original is untouched and still records what happened.`,
    },
    why: `Minting a scoped ${facts.sourceMode} delivery for this clone.`,
  };
}
