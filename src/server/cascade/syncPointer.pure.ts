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
 * - **`delivered_sha` outranks provenance on the same row.** It is the head
 *   the pass resolved at run time; provenance is the push that created the
 *   event.
 * - **The newest event wins, not the newest merge.** Two proposals landing
 *   out of order must not walk the pointer backwards, so candidates are
 *   ordered by the EVENT's creation — the rule `advanceClone` has always
 *   had — and within that order the first row carrying any usable revision
 *   decides.
 * - **A legacy row falls back to provenance.** Rows written before the
 *   column existed can understate inside a folded window, never overstate,
 *   and the first pass that writes the column corrects them.
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

export function choosePointerAdvance(rows: readonly PointerRow[]): PointerAdvance | null {
  const candidates = rows
    .filter(
      (r): r is PointerRow & { event: { source_sha: string | null; created_at: string } } =>
        r.status === "succeeded" &&
        r.event !== null &&
        Boolean(r.delivered_sha ?? r.event.source_sha),
    )
    .sort((a, b) => (a.event.created_at < b.event.created_at ? 1 : -1));
  const chosen = candidates[0];
  if (!chosen) return null;
  if (chosen.delivered_sha) {
    return { sha: chosen.delivered_sha, basis: "delivered", eventCreatedAt: chosen.event.created_at };
  }
  return {
    sha: chosen.event.source_sha as string,
    basis: "provenance",
    eventCreatedAt: chosen.event.created_at,
  };
}
