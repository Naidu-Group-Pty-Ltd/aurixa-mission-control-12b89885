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
 * ## Why it carries the file's shape
 *
 * `applyChunkedSeed` read the blob TWICE per attempt: `readSeedShape` is
 * `walk(chunks, () => {})` — a full walk of the whole file that discards every
 * tuple — and then `chunkSeedStatements` walks it again. On the 41,671,969-byte
 * template seed that is ~80 MB of blob traffic to buy one bounded group of
 * statements inside a 45-second fleet budget.
 *
 * Measured 19 September 2026: three clones sat at `statementsDone` 6, 12 and 1
 * against that seed, and `npc-test-76b3b3` completed a pass at 13:01 having
 * advanced **zero** statements — the budget went on the reading.
 *
 * The second walk is not redundant and is not what was removed: it re-derives
 * the shape and `chunkSeedStatements` refuses when the two disagree ("the blob
 * changed between reads"). What changed is WHERE the first reading comes from.
 * A resumed pass takes it off the cursor, so the file is read once and the
 * comparison now spans PASSES rather than the microseconds between two reads in
 * one — which is where a seed can actually be re-released, over the dozens of
 * passes a 41 MB file takes to land.
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
/**
 * What the file looked like when this pass read it.
 *
 * Carried so a RESUMED pass does not have to read 41 MB to learn it again —
 * see {@link chunkCursorFor}'s note on the second walk.
 *
 * Every field of `SeedShape` is carried, deliberately — `tail` above all.
 * `tail` is the statements that follow the `ON CONFLICT` clause, and
 * `chunkSeedStatements` emits them as a final group; a shape that dropped it
 * would silently stop sending them on every RESUMED pass, which is the half of
 * the seed nothing downstream would ever report missing. Typechecking caught
 * that in the first draft of this file, where the stored shape was three
 * fields.
 */
export type StoredSeedShape = {
  header: string;
  onConflict: string;
  tail: string;
  tupleCount: number;
  target: string | null;
};

export type StoredChunkCursor = {
  migrationId: string;
  statementsDone: number;
  /**
   * Absent on a cursor written before this existed, and on one whose shape
   * could not be narrowed. Absent means "read the file again", which is what
   * every pass did until now — so the worst case is exactly today's cost.
   */
  shape?: StoredSeedShape;
};

/**
 * Narrow a stored shape, whole or not at all.
 *
 * A half-read shape is worse than none: `header` and `onConflict` are
 * concatenated around every statement this pass sends, so a missing half sends
 * malformed SQL, and a wrong `tupleCount` defeats the very check the shape
 * exists to support. Every rejection falls back to reading the file.
 */
function seedShapeFor(raw: unknown): StoredSeedShape | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { header, onConflict, tail, tupleCount, target } = raw as Record<string, unknown>;
  if (typeof header !== "string" || header.length === 0) return undefined;
  // Empty is legitimate for both of these — not every seed carries an
  // `ON CONFLICT` clause, and most carry nothing after it — so they are
  // checked for TYPE and not for length. A length check here would reject
  // every ordinary seed and quietly restore the double read.
  if (typeof onConflict !== "string") return undefined;
  if (typeof tail !== "string") return undefined;
  if (typeof tupleCount !== "number" || !Number.isInteger(tupleCount) || tupleCount < 0) {
    return undefined;
  }
  if (target !== null && typeof target !== "string") return undefined;
  return { header, onConflict, tail, tupleCount, target };
}

export function chunkCursorFor(raw: unknown): StoredChunkCursor | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { migrationId, statementsDone, shape } = raw as Record<string, unknown>;
  if (typeof migrationId !== "string" || migrationId.length === 0) return null;
  // `statementsDone` arrives from JSON, so a float or a negative is possible and
  // neither is a count of statements that landed.
  if (typeof statementsDone !== "number" || !Number.isInteger(statementsDone)) return null;
  if (statementsDone < 0) return null;
  const narrowed = seedShapeFor(shape);
  return narrowed
    ? { migrationId, statementsDone, shape: narrowed }
    : { migrationId, statementsDone };
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
