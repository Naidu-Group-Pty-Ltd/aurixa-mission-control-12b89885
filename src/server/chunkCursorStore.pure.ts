/**
 * Reading a stored chunk cursor back out of untyped JSON.
 *
 * `applyPrimeMigrations` takes `{ migrationId, statementsDone }` and both lanes
 * that can stream an oversized seed persist it — the self-healing lane on its
 * run row, the fleet sync on the clone's. Both columns are `jsonb`, so both
 * reads come back as `unknown` and both have to be narrowed.
 *
 * This is the one narrowing. The self-healing lane used a bare
 * `as { migrationId: string; statementsDone: number } | null`, which is a
 * promise to the compiler rather than a check — a half-written or
 * hand-edited row would have satisfied it and then been used as a number of
 * statements to SKIP.
 *
 * ## What it deliberately does not do
 *
 * It does not check the cursor against the migration being sent.
 * `applyChunkedSeed` already does that —
 * `oversize.cursor?.migrationId === m.id ? oversize.cursor.statementsDone : 0` —
 * so a cursor naming a different file skips nothing. Repeating it here would be
 * a second spelling of one rule, and the two would eventually disagree about
 * which file a cursor belongs to.
 *
 * ## Why a bad value is null and never a partial
 *
 * Every field of this cursor means "the first N statements of THAT file have
 * landed". A value missing either half cannot support that claim, and the only
 * safe reading of "I cannot tell how many landed" is zero — which re-sends
 * statements the clone already holds, and the seed carries its own ON CONFLICT
 * clause precisely so that costs nothing. Guessing high skips statements that
 * never landed, and nothing downstream would ever notice.
 */
export type StoredChunkCursor = { migrationId: string; statementsDone: number };

export function chunkCursorFor(raw: unknown): StoredChunkCursor | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { migrationId, statementsDone } = raw as Record<string, unknown>;
  if (typeof migrationId !== "string" || migrationId.length === 0) return null;
  // `statementsDone` arrives from JSON, so a float or a negative is possible and
  // neither is a count of statements that landed.
  if (typeof statementsDone !== "number" || !Number.isInteger(statementsDone)) return null;
  if (statementsDone < 0) return null;
  return { migrationId, statementsDone };
}

/**
 * Whether a stored cursor claims more statements than the file actually has.
 *
 * `chunkCursorFor` can tell a well-formed cursor from a malformed one; it
 * cannot tell a cursor of 9,000 from a seed of forty statements, because the
 * only way to know a stream's length is to walk it. So this is asked AFTER the
 * walk, with the count it produced.
 *
 * ## Why it matters more than it looks
 *
 * `applyChunkedSeed` skips while `index < skip`. A cursor past the end skips
 * every statement, reaches EOF having applied none, and returns
 * `stoppedEarly: false` — which the replay reads as "the seed went" and
 * follows by writing the migration's ledger row. The clone then records a
 * version whose data it does not hold, and every later pass skips it as
 * applied. The comment beside that call says "the ledger row is written only
 * once every statement has gone, so a half-sent seed is never applied"; that
 * was true of the budget-stop path and not of this one.
 *
 * Raised by an automated review on #225 after it merged. It needs a corrupted
 * or hand-edited row, or a cursor surviving onto a different database — which
 * is exactly what the missing `chunk_cursor: null` on a fresh project ref
 * allowed, so the two findings are one fault seen from both ends.
 *
 * ## Equality is not past the end
 *
 * `skip === statementsSeen` is the ordinary shape of a pass that sent the last
 * statement and died before its ledger row was written. Every statement really
 * did land, and re-deriving that as an error would stop the seed ever being
 * recorded. Only `statementsSeen < skip` is a claim the file cannot support.
 */
export function cursorRanPastEnd(skip: number, statementsSeen: number): boolean {
  return skip > 0 && statementsSeen < skip;
}
