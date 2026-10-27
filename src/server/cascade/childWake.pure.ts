/**
 * Which held events to wake when a parent clone's delivery merges.
 *
 * A clone that reads its parent's branch (lineage, `cloneCascadeSource.pure.ts`)
 * is held until the parent's pointer equals the prime commit the pass
 * delivers, and a held event is re-polled on a five-minute pace
 * (`LINEAGE_HOLD_RETRY_MS`). The parent's pointer moves at exactly one place —
 * the merge drain's `advanceClone` — so waiting out the pace after it moved is
 * waiting for nothing. Measured 27 Oct 2026: 2.5–5 minutes from the dashboard's
 * merge to its two children's next pass, on every delivery.
 *
 * Only an event whose next attempt is no further away than one lineage pace is
 * woken. That is the shape a lineage hold writes. A longer wait is somebody
 * else's clock — a rate-limit window names GitHub's reset, which can be most of
 * an hour — and is left alone. Waking a shorter wait that turns out to be
 * something else costs one claim, which the drain refunds as a deferral, and
 * the drain's own budget gate refuses the claim outright when the installation
 * is short.
 *
 * Client-safe: pure.
 */
import { LINEAGE_HOLD_RETRY_MS } from "./cloneCascadeSource.pure";

/** Clock skew between the engine that wrote the pace and the drain that reads it. */
export const WAKE_SLACK_MS = 30_000;

/**
 * Whether a pending event due at `nextAttemptAt` should be brought forward to
 * now: due in the future, and no further than one lineage pace away. An
 * unreadable time is left alone.
 */
export function shouldWakeHeldEvent(nextAttemptAt: string | null, nowMs: number): boolean {
  if (!nextAttemptAt) return false;
  const due = Date.parse(nextAttemptAt);
  if (!Number.isFinite(due)) return false;
  return due > nowMs && due - nowMs <= LINEAGE_HOLD_RETRY_MS + WAKE_SLACK_MS;
}
