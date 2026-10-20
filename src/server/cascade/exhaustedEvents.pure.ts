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
 * kills. The rows say which is which: every pass flushes settled evidence
 * and prepared blobs onto its result rows as it goes, and settles each row it
 * finishes, so a killed tick that progressed leaves a fresh write behind it,
 * and one that learned nothing leaves the rows exactly as old as the previous
 * pass left them.
 *
 * ## "A fresh write" is progress kept, never the row being touched
 *
 * This read the newest `updated_at` across the event's rows, and that is not
 * a ledger write: the engine marks a row `pushing` before any work, and a
 * trigger stamps `updated_at` on every write. So a pass cut before it learned
 * anything read exactly like one cut mid-convergence, and was refunded.
 * Measured 20 Oct 2026 (F21 in the 19 Oct hand-over): five events for the CRM
 * line sat at attempts 3 and cycled — claim, cut at 60 s, the stall reclaim,
 * the refund, the next claim — while the line completed no pass after 17 Oct,
 * because its rows were never written again after the `pushing` mark.
 *
 * So the judgement reads `progressed_at`, which a pass writes in exactly the
 * two places the drain already counts as progress for a pass that RETURNED
 * (`done > 0 || progressed` in `drainOne`): a ledger flush holding an entry
 * the pass did not start with (`ledgerGrew`, by identity), and a row's
 * settlement out of the queue. A pass killed after it finished one clone
 * advanced the event exactly as much as one that returned; only the ledger
 * half would have retired it. The claim cannot move the column, a pass that
 * re-did old work cannot move it, and a row no pass has kept anything on is
 * NULL — "nothing kept", which is a verdict, unlike a read that failed.
 *
 * So an exhausted event is judged by its progress, not its counter:
 *
 *  - **Progress kept recently → refund one attempt.** The passes are
 *    converging; the counter is measuring platform kills, not futility. A
 *    ledger is finite (bounded by the candidate and file counts) and a row
 *    settles once, so this cannot loop for ever: progress stops, and the
 *    next look retires.
 *  - **None, or none lately → retire, visibly.** Mark it failed where the
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
 * How recently progress must have been kept to count as "this event is still
 * getting somewhere". Deliberately wider than the 10-minute stall reclaim: a
 * killed tick's last write is at least that old by the time the reclaim
 * releases its claim and this judgement can see the event at all — a window
 * narrower than the reclaim would retire every kill, progressing or not. And
 * narrower than two reclaims: progress the attempt BEFORE the last one kept
 * is twenty minutes old by then, so only the last attempt's progress refunds.
 */
export const EXHAUSTED_PROGRESS_WINDOW_MS = 15 * 60_000;

/**
 * The column a pass stamps when it keeps progress (a grown ledger, a settled
 * row), and the one this judgement reads. Named once: a literal at each end is
 * how the writer and the reader come to disagree.
 */
export const PROGRESS_COLUMN = "progressed_at";

export function decideExhaustedEvent(input: {
  attempts: number;
  maxAttempts: number;
  /**
   * Newest `progressed_at` across the event's result rows: the last time a
   * pass KEPT progress on one. Null where no row has one.
   */
  lastProgressAt: string | null;
  /** The rows could not be read. A failed read is not a verdict. */
  readFailed: boolean;
  nowMs: number;
}): ExhaustedEventVerdict {
  if (input.attempts < input.maxAttempts) {
    return { act: "leave", why: "under the ceiling — the ordinary claim path owns it" };
  }
  if (input.readFailed) {
    return { act: "leave", why: "the rows could not be read, and a failed read is no verdict" };
  }
  if (input.lastProgressAt === null) {
    return {
      act: "retire",
      why: "no pass on this event kept anything it did not start with",
    };
  }
  const keptAt = Date.parse(input.lastProgressAt);
  if (!Number.isFinite(keptAt)) {
    return { act: "leave", why: "the progress timestamp is unreadable; the next tick looks again" };
  }
  if (input.nowMs - keptAt <= EXHAUSTED_PROGRESS_WINDOW_MS) {
    return {
      act: "refund",
      why: "the last pass kept progress before it was cut — converging, not failing",
    };
  }
  return { act: "retire", why: "three passes and nothing kept lately" };
}

/** The summary a retired event carries, naming the lever rather than the mystery. */
export function retirementSummary(maxAttempts: number): string {
  return (
    `No pass completed within ${maxAttempts} attempts and the last one kept nothing — ` +
    `the ticks that spent them were cut before they could report. The queue will not ` +
    `claim this event again; "Cascade now" runs prime's head fresh.`
  );
}
