/**
 * The webhook is the cascade's only ignition, and a webhook is a delivery.
 *
 * Measured through the September 2026 freeze: prime moves ~50 commits a day
 * and every one of them reaches the queue as a `push` delivery — when one is
 * lost (Mission Control down for a deploy, GitHub retiring an undelivered
 * hook, an outage on either side), the fleet simply stops following prime
 * until the NEXT push happens to arrive. Nothing reports the gap, because a
 * quiet queue and a starved queue look identical from inside.
 *
 * The beacon makes the drain level-triggered where the webhook is
 * edge-triggered: on a tick with nothing to do, it asks the one question the
 * queue cannot answer about itself — does prime's CURRENT head have a
 * cascade event? — and synthesizes the event a lost delivery would have
 * created. It goes through `createCascadeForAllClones` like any push, so the
 * SHA dedupe, the pending-carrier stand-down and the unique-index race
 * backstop all apply; firing is therefore once per prime SHA, ever, however
 * many ticks pass.
 *
 * This module decides; the drain acts. Three refusals carry it:
 *
 *  - **A claimable carrier waits** → silent. That event delivers prime's
 *    head at run time, whatever SHA created it. (A pending event past the
 *    attempt ceiling is NOT a carrier — no claim will ever take it, and a
 *    zombie must not stand the beacon down.)
 *  - **A read failed** → silent. A beacon that fires because a QUERY failed
 *    turns a database blip into a fleet-wide cascade; a read that failed is
 *    not an absence, here as everywhere.
 *  - **The head already has an event**, whatever its status → silent. A
 *    completed event for the head means the fleet followed this push; a
 *    failed one means a person is owed a look, and re-firing over their
 *    head would retry what was refused.
 */

export type DriftBeaconVerdict = { fire: true } | { fire: false; why: string };

export function decideDriftBeacon(input: {
  /** Pending, unclaimed commit events still under the attempt ceiling. */
  claimableCommitEvents: number | null;
  /** Prime's current head, or null when the read failed. */
  headSha: string | null;
  /** Whether ANY commit event exists for that head, or null when unreadable. */
  headEventExists: boolean | null;
}): DriftBeaconVerdict {
  if (input.claimableCommitEvents === null) {
    return { fire: false, why: "the queue could not be read, and a failed read is not an absence" };
  }
  if (input.claimableCommitEvents > 0) {
    return {
      fire: false,
      why: "a claimable commit event already waits and will deliver prime's head",
    };
  }
  if (input.headSha === null) {
    return { fire: false, why: "prime's head could not be read; a beacon never fires blind" };
  }
  if (input.headEventExists === null) {
    return {
      fire: false,
      why: "the event ledger could not be read, and a failed read is not an absence",
    };
  }
  if (input.headEventExists) {
    return { fire: false, why: "prime's head already has a cascade event" };
  }
  return { fire: true };
}

/** The summary the synthesized event carries, so its origin is never a mystery. */
export function beaconSummary(headSha: string): string {
  return (
    `Raised by the drain's drift beacon — prime@${headSha.slice(0, 7)} has no cascade event ` +
    `and nothing claimable waits. A push delivery was missed or lost; the fleet follows anyway.`
  );
}
