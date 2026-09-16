/**
 * Which prime revision a clone's sync pointer may advance to.
 *
 * `clones.last_synced_sha` is a PRIME revision — `runDriftRefresh` measures
 * commits-behind FROM it, in the prime repository — so the only honest value
 * is the head a pass actually DELIVERED. The merge drain used to advance it
 * from `cascade_events.source_sha`, which is provenance: the push that
 * created the carrier event, permanent by the fold's own rule, and equal to
 * the delivered head only when nothing folded between the push and the run.
 *
 * Measured 16 Sep 2026, 15:15: npc-test-76b3b3 merged a cascade whose tree
 * was prime@7674f46's, was stamped with the folded carrier's provenance
 * fa292ce7 — 84 commits earlier — and the drift scan read "84 commits behind
 * Prime" on a clone whose content matched prime's head outside its designed
 * exclusions. The clones that happened to sync through a fresh event, whose
 * provenance equalled the delivered head, read correctly. A reading that
 * depends on how the event came to exist is not a reading of the clone.
 *
 * Rules:
 * - **Only a `succeeded` row asserts content on the clone's branch.** By the
 *   time the drain derives the pointer, reconciliation has flipped every row
 *   whose pull request landed — the engine's "already proposed" skip rows
 *   included, because they carry the pull request's URL and
 *   `reconcileResultToPr` transitions every row that names it.
 * - **Any delivered row outranks every provenance row — not merely the ones
 *   on its own event.** A delivered value is the head a pass resolved at run
 *   time; a provenance value is only the push that created a carrier, and an
 *   event's creation order does not bound its label: an event created LATER
 *   can carry provenance OLDER than what an earlier pass delivered, because
 *   the earlier pass executed after the later event's creating push. Ranked
 *   by event recency alone, a legacy row reconciled late could walk the
 *   pointer backwards over an engine-stamped delivered head. Delivered rows
 *   all postdate every legacy row in execution (the column shipped after the
 *   last legacy pass ran, and the claim fence serialises passes), so the
 *   newest delivered row is never older in content than any provenance
 *   label, and preferring the partition is what makes regression
 *   unspellable rather than merely unlikely.
 * - **Within a partition the newest event wins, not the newest merge**, so
 *   two proposals landing out of order still cannot walk the pointer
 *   backwards — the rule `advanceClone` has always had.
 * - **Provenance is a total fallback, never a rival.** It decides only for a
 *   clone whose whole succeeded history predates the column: an
 *   understatement inside a folded window, never an overstatement, and the
 *   first pass that writes the column retires it for that clone for good.
 */

export type PointerRow = {
  status: string;
  /** The prime head the pass resolved and delivered. Null on legacy rows. */
  delivered_sha: string | null;
  /** The carrier event: provenance sha and creation time. */
  event: { source_sha: string | null; created_at: string } | null;
};

export type PointerAdvance = {
  sha: string;
  basis: "delivered" | "provenance";
  eventCreatedAt: string;
};

type Qualified = PointerRow & { event: { source_sha: string | null; created_at: string } };

function newestFirst(a: Qualified, b: Qualified): number {
  return a.event.created_at < b.event.created_at ? 1 : -1;
}

export function choosePointerAdvance(rows: readonly PointerRow[]): PointerAdvance | null {
  const succeeded = rows.filter(
    (r): r is Qualified => r.status === "succeeded" && r.event !== null,
  );

  const delivered = succeeded
    .filter((r) => Boolean(r.delivered_sha))
    .sort(newestFirst)[0];
  if (delivered) {
    return {
      sha: delivered.delivered_sha as string,
      basis: "delivered",
      eventCreatedAt: delivered.event.created_at,
    };
  }

  const legacy = succeeded.filter((r) => Boolean(r.event.source_sha)).sort(newestFirst)[0];
  if (!legacy) return null;
  return {
    sha: legacy.event.source_sha as string,
    basis: "provenance",
    eventCreatedAt: legacy.event.created_at,
  };
}
