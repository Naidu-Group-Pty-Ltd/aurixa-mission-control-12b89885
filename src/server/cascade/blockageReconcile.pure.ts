/**
 * What one clone's open blockage set must become, given what a pass detected.
 *
 * The ledger's writes are three kinds — refresh a row whose condition still
 * holds, open a row for a condition that has none, clear a row nothing
 * detected — and deciding which is which is pure. It lives here so it can be
 * tested without a database, and so the one rule that keeps the set sound is
 * stated where it is enforced:
 *
 * **One open row per identity.** The open set is read as a map keyed on the
 * fingerprint. A second open row carrying the same fingerprint — opened by a
 * pass that raced this one, or by facts that repeated a condition — is not in
 * that map, so no later pass would ever refresh it or clear it: it would stand
 * open for ever, reporting a condition long gone. So a detection is taken once
 * per fingerprint, the first open row read for a fingerprint is the one kept
 * (the ledger reads oldest first, so the kept row carries the true start), and
 * every other open row with that fingerprint is cleared. Cleared, never
 * deleted: a blockage records that a condition existed.
 */
import type { DetectedBlockage } from "./blockageTaxonomy.pure";

/** An open `clone_sync_blockages` row, as the reconciler reads it. */
export type OpenBlockageRow = { id: string; fingerprint: string };

export type BlockageReconcilePlan = {
  /** Open rows whose condition still holds: bump `last_seen_at`, refresh the detail. */
  refresh: Array<{ id: string; detected: DetectedBlockage }>;
  /** Conditions with no open row: open one each. */
  open: DetectedBlockage[];
  /** Open rows to clear: nothing detected them, or an older open row carries their identity. */
  clear: string[];
};

export function planBlockageReconcile(
  openRows: ReadonlyArray<OpenBlockageRow>,
  detected: ReadonlyArray<DetectedBlockage>,
): BlockageReconcilePlan {
  const detectedByFingerprint = new Map<string, DetectedBlockage>();
  for (const d of detected) {
    if (!detectedByFingerprint.has(d.fingerprint)) detectedByFingerprint.set(d.fingerprint, d);
  }

  const kept = new Map<string, string>();
  const clear: string[] = [];
  for (const row of openRows) {
    if (kept.has(row.fingerprint)) {
      clear.push(row.id);
      continue;
    }
    kept.set(row.fingerprint, row.id);
  }

  const refresh: BlockageReconcilePlan["refresh"] = [];
  const open: DetectedBlockage[] = [];
  for (const [fingerprint, d] of detectedByFingerprint) {
    const id = kept.get(fingerprint);
    if (id) refresh.push({ id, detected: d });
    else open.push(d);
  }
  for (const [fingerprint, id] of kept) {
    if (!detectedByFingerprint.has(fingerprint)) clear.push(id);
  }

  return { refresh, open, clear };
}
