/**
 * What the attempt ceiling actually measures.
 *
 * `claimOne` refuses an event at MAX_ATTEMPTS, and the terminal write in
 * `drainOne` runs only when a CLAIM comes back empty-handed — a tick the
 * platform kills returns nothing at all. Three kills and the event is a
 * zombie: `pending` for ever, claimable by nothing, foldable by nothing
 * (a carrier past the ceiling stands nothing down), and reported nowhere.
 * Measured 16 Sep 2026 at 09:23: the first post-window tick was cut by the
 * 60-second isolate limit mid-probe, spent its attempt, and left no trace
 * but a claim the reclaim would clear ten minutes later.
 *
 * The ceiling exists to stop a pass that LEARNS NOTHING from being retried
 * for ever — not to stop a convergence that happens to be advancing through
 * kills. The ledger says which is which: every pass flushes settled evidence
 * and prepared blobs onto its result rows as it goes, so a killed tick that
 * progressed leaves a fresh write behind it, and one that learned nothing
 * leaves the rows exactly as old as the previous pass left them.
 *
 * So an exhausted event is judged by its ledger, not its counter:
 *
 *  - **A recent ledger write → refund one attempt.** The passes are
 *    converging; the counter is measuring platform kills, not futility. The
 *    ledger is finite (bounded by the candidate and file counts), so this
 *    cannot loop for ever: growth stops, and the next look retires.
 *  - **No recent write → retire, visibly.** Mark it failed where the
 *    operator lever (Cascade now) can be pulled on purpose, and raise the
 *    notification — a row sitting quiet is the September freeze's shape.
 *  - **Nothing to read → leave it alone.** A failed read is not a verdict,
 *    here as everywhere; the next tick looks again.
 */

export type ExhaustedEventVerdict =
  | { act: "refund"; why: string }
  | { act: "retire"; why: string }
  | { act: "leave"; why: string };

/**
 * How recently a ledger write counts as "this event is still learning".
 * Deliberately wider than the 10-minute stall reclaim: a killed tick's last
 * flush is at least that old by the time the reclaim releases its claim and
 * this judgement can see the event at all — a window narrower than the
 * reclaim would retire every kill, progressing or not.
 */
export const EXHAUSTED_PROGRESS_WINDOW_MS = 15 * 60_000;

export function decideExhaustedEvent(input: {
  attempts: number;
  maxAttempts: number;
  /** Newest `updated_at` across the event's result rows, or null when unreadable. */
  lastResultWriteAt: string | null;
  nowMs: number;
}): ExhaustedEventVerdict {
  if (input.attempts < input.maxAttempts) {
    return { act: "leave", why: "under the ceiling — the ordinary claim path owns it" };
  }
  if (input.lastResultWriteAt === null) {
    return { act: "leave", why: "the ledger could not be read, and a failed read is no verdict" };
  }
  const wroteAt = Date.parse(input.lastResultWriteAt);
  if (!Number.isFinite(wroteAt)) {
    return { act: "leave", why: "the ledger timestamp is unreadable; the next tick looks again" };
  }
  if (input.nowMs - wroteAt <= EXHAUSTED_PROGRESS_WINDOW_MS) {
    return {
      act: "refund",
      why: "the last pass grew the ledger before it was cut — converging, not failing",
    };
  }
  return { act: "retire", why: "three passes and the ledger has stopped moving" };
}

/** The summary a retired event carries, naming the lever rather than the mystery. */
export function retirementSummary(maxAttempts: number): string {
  return (
    `No pass completed within ${maxAttempts} attempts and the ledger stopped moving — ` +
    `the ticks that spent them were cut before they could report. The queue will not ` +
    `claim this event again; "Cascade now" runs prime's head fresh.`
  );
}
