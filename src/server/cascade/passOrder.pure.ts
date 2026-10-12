/**
 * The order a pass offers its clones, before lineage puts parents first.
 *
 * A pass works its queued clones in one loop inside one hook invocation, and
 * a clone that cannot finish inside the window PAUSES — its row goes back to
 * `queued` with its ledger, and the event is handed back for the next tick.
 * The order used to be the query's, and `orderByLineageDepth` keeps it within
 * a depth, so the clone that paused was the clone offered FIRST on the next
 * tick, and on the one after that. Measured 11–12 Oct 2026: the CRM line's
 * row paused on every pass of four consecutive events (re-merging the same
 * held variants each time), and the other line's three clones — the
 * client-dashboard parent and its two children — were never reached once.
 * Their prime commit waited behind a clone that had nothing to do with them.
 *
 * So the pass offers the clone it touched LEAST recently first. Every write to
 * a result row bumps its `updated_at` (a trigger, not this code), so a row the
 * last pass paused on reads as just touched and goes to the back; a row the
 * last pass never reached is still where it was and comes forward. Over
 * successive ticks that is a round robin: every queued clone gets a turn
 * before any clone gets a second one, whatever any one of them costs.
 *
 * Lineage still wins. This runs BEFORE `orderByLineageDepth`, which is stable
 * within a depth, so a parent still precedes its children and the round robin
 * applies among clones at the same depth.
 *
 * A row with no readable timestamp sorts first — it has never been touched,
 * which is exactly the row that has waited longest — and ties keep the input
 * order, so a pass with nothing to separate behaves as it did.
 */
export function leastRecentlyTouchedFirst<T>(
  rows: readonly T[],
  touchedAt: (row: T) => string | null | undefined,
): T[] {
  const at = (row: T): number => {
    const raw = touchedAt(row);
    if (!raw) return Number.NEGATIVE_INFINITY;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
  };
  return rows
    .map((row, index) => ({ row, index, at: at(row) }))
    .sort((a, b) => (a.at !== b.at ? a.at - b.at : a.index - b.index))
    .map((entry) => entry.row);
}
