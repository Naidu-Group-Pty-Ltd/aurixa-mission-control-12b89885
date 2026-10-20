/**
 * A result row its carrier settled without ever reaching it.
 *
 * Every act that settles a cascade event without walking its rows — the
 * drain's retirement at the attempt ceiling, a reviewer's rejection, a failed
 * read of prime, a missing GitHub App — also settles the rows it never
 * reached (`terminaliseOrphanedRows`): `skipped`, with a sentence naming the
 * carrier's fate. `skipped` is right for the ROW, because nothing failed in
 * it. It is wrong for the EVENT: a clone the event never reached did not
 * receive what the event carried.
 *
 * The merge drain's recount could not tell the two kinds of skip apart. It
 * re-derives an event's status and summary from its rows, read an abandoned
 * row as a deliberate skip, and rewrote the retired event as `completed`.
 * Measured 20 Oct 2026 (F24 in the 19 Oct hand-over): the drain retired five
 * events between 08:27 and 08:37 UTC, each `failed` with the retirement
 * summary and a `cascade_failed` notification, and within eight minutes four
 * of them read `completed · 0 merged · 0 PRs · 0 failed · 4 skipped (of 4)`.
 * Each held a row linked to an open pull request, which is what puts an event
 * in front of the recount at all, so the common case was the one rewritten.
 *
 * That was not cosmetic. `headRedelivery` redelivers prime's head only for an
 * event that FAILED automatically, and the blockage taxonomy reads a retired
 * event by its status, so both fell silent over a clone that had received
 * nothing.
 *
 * So the sentence is the evidence, and it is composed in one place: every
 * abandoned row's message begins with `CARRIER_SETTLED_PREFIX`, written by
 * `carrierSettledMessage` and read back by `settledByCarrier`. A literal at
 * each end is how a writer and a reader come to disagree.
 *
 * Client-safe: pure.
 */

/** How every row a carrier settled without reaching begins. Never reworded. */
export const CARRIER_SETTLED_PREFIX = "Skipped: the carrier event ";

/**
 * The message for a row its carrier settled. `fate` finishes the sentence,
 * as in "was retired after 3 attempts without processing this clone."
 */
export function carrierSettledMessage(fate: string): string {
  return `${CARRIER_SETTLED_PREFIX}${fate.trim()}`;
}

/** Whether a row's message says its carrier settled it without reaching it. */
export function settledByCarrier(errorMessage: string | null | undefined): boolean {
  return typeof errorMessage === "string" && errorMessage.startsWith(CARRIER_SETTLED_PREFIX);
}
