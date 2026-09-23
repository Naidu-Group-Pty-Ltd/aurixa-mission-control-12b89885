/**
 * Whether the prime has already run a migration's BYTES, asked of the bytes
 * rather than of the filename.
 *
 * ## The hole this closes
 *
 * `fleetCorpusScope.pure.ts` decides what a clone may be sent by exact
 * membership of the prime's ledger — by VERSION STRING. That is the right
 * rule and the wrong key. Measured on this prime (22 Sep 2026): 1,002 files
 * in `supabase/migrations/`, 1,012 rows in
 * `supabase_migrations.schema_migrations`, and **180 versions in common**.
 * Eighteen per cent. Everything else was withheld from every clone, and
 * because `partitionByDependency` treats a withheld version as a barrier,
 * one hole orphans every runnable migration behind it.
 *
 * The ledger is not wrong about what ran; it is keyed differently. Lovable
 * stamps the ledger with the moment it APPLIED a file, not with the version
 * in the filename, so the repo's `20250831091525` appears as `…091523`. That
 * is two seconds, and it is enough to make a version match fail. Measured on
 * that exact pair: the repo file and the ledger row are **byte-identical**,
 * 151 bytes, `md5 d6725d25bb2616357d9d65f8ccbc0145`.
 *
 * So the evidence was there the whole time and nothing read it. The ledger
 * stores the SQL it ran. A body that matches is proof the prime ran those
 * exact bytes — which is strictly stronger than a version match, because
 * versions in this corpus are not even unique: `MIGRATION_VERSION_COLLISIONS.json`
 * records the files that share one — 25 groups over 61 files on 23 Sep 2026,
 * 32 over 77 on 20 Sep.
 *
 * ## The rule
 *
 * **A migration has been applied when the prime's ledger holds a body whose
 * EXECUTABLE bytes are exactly its own.** Bytes that cannot execute — trailing
 * whitespace, a leading comment block — may differ, and nothing else may.
 *
 * With it, `runnable` on this prime goes from 180 to 785.
 *
 * ## Why the ladder is on this side only
 *
 * The ledger's digest is computed by {@link LEDGER_BODY_DIGEST_SQL} — one
 * expression, over the body exactly as stored, that cannot drift because it
 * does nothing. Every normalisation lives here, in TypeScript, in one
 * function. Normalising in SQL as well would be two statements of one rule,
 * which is how the two come to disagree.
 *
 * ## Why over-normalising cannot promote anything
 *
 * The obvious objection: strip enough and two different migrations look
 * alike. Five `refresh_active_masters_from_library_vN` files in this corpus
 * differ ONLY in a header comment, and rung 3 collapses them.
 *
 * That is safe, and not by luck. Every rung removes only bytes that do not
 * execute, so two bodies that collide anywhere on the ladder have identical
 * executable bytes — provably, for all inputs, not just today's corpus:
 *
 * - rung 3 ≡ rung 3 — both are `executableBody`, equal by definition.
 * - rung 1 or 2 ≡ rung 3 — the left side EQUALS some body's executable form,
 *   so its own first line is neither blank nor a comment (or the body is
 *   empty, excluded below), so stripping it again is a no-op and `.trimEnd()`
 *   is idempotent.
 * - rung 1 or 2 ≡ rung 1 or 2 — the two differ at most in trailing
 *   whitespace, so they strip to the same leading structure and the same tail.
 *
 * Measured against that: of the 11 corpus-internal digest collisions on this
 * prime, **0 have differing executable bytes**. So "which of these files did
 * the prime run" is a question with no consequence — it ran these bytes, and
 * these are the bytes.
 *
 * What the collision DOES cost is attribution, so it is recorded rather than
 * acted on: a clearance names every corpus file sharing its digest, and the
 * page says the ledger cannot tell them apart.
 *
 * ## An empty body is never evidence
 *
 * 15 ledger rows store `statements = '{}'` and 91 store NULL — a row that
 * records a version and no SQL. Their digest is the digest of the empty
 * string, and a corpus file that is nothing but comments normalises to the
 * same thing. Both sides are excluded by name: {@link EMPTY_BODY_SHA256} is
 * never admitted as an applied digest, and a rung that normalises to nothing
 * is dropped before it is hashed.
 */

/**
 * The prime ledger's body digest, as ONE SQL expression.
 *
 * Named once so the query that reads it and the code that compares against it
 * cannot drift. `statements` is a `text[]`; measured on this prime, every one
 * of the 906 rows that has a body has exactly ONE element — the whole file as
 * the CLI sent it — so the join is a formality that costs nothing and is
 * correct if that ever stops being true.
 *
 * sha256 rather than md5 because this decides what executes on a tenant
 * database, and the cost of the stronger digest is nil. Verified by effect
 * against `node:crypto` on a real pair, rather than assumed: Postgres
 * `encode(sha256(convert_to(…,'UTF8')),'hex')` and Node
 * `createHash("sha256").update(sql,"utf8")` agree byte for byte.
 */
export const LEDGER_BODY_DIGEST_SQL =
  "encode(sha256(convert_to(array_to_string(statements, E'\\n'), 'UTF8')), 'hex')";

/** sha256 of the empty string. Never evidence that anything ran. */
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * A migration body with every byte that cannot execute removed.
 *
 * Exactly two things go: a leading run of blank and `--` lines, and trailing
 * whitespace. Internal comments stay — they are inside the statement stream
 * the ledger also stores, and removing them would make this a parser rather
 * than a normaliser.
 */
export function executableBody(sql: string): string {
  const lines = sql.split("\n");
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === "" || t.startsWith("--")) i += 1;
    else break;
  }
  return lines.slice(i).join("\n").trimEnd();
}

/**
 * Every form of one migration's body that could be what the ledger stored,
 * most literal first — so the INDEX of a match IS the rung that produced it
 * and {@link bodyFormLabel} can name what actually differs.
 *
 * Ordered because "byte-identical" and "identical once a comment is
 * discounted" are different readings and an operator should be told which one
 * they have.
 *
 * Measured on this prime (22 Sep 2026), 690 body-matched files: 619 at rung 0,
 * 56 at rung 1, 15 at rung 2.
 *
 * ## Why identical rungs are kept rather than deduped
 *
 * They were deduped once, and that quietly made the index an index into a
 * SHORTER list. A body carrying a leading comment and no trailing whitespace
 * has rung 1 equal to rung 0, so rung 1 vanished and a leading-comment match
 * reported itself at index 1 — "identical but for trailing whitespace", about
 * a file whose whitespace is identical.
 *
 * Measured on the prime the day it was found: **0 files affected**, because
 * every leading-comment match in that corpus happens also to carry trailing
 * whitespace. So nothing on the page was wrong — it was right by coincidence,
 * and a reading that is true by coincidence is what this repository has had to
 * fix twice already. Keeping the duplicates costs at most two extra sha256
 * over a body already in memory and buys `index === rung` for every input.
 *
 * ## Dropping an empty rung cannot shift a surviving one
 *
 * An empty rung can only ever be followed by empty rungs: rung 1 empty means
 * the whole body is whitespace, and then rung 2 is empty too. So the drop
 * removes a suffix and never moves an index.
 */
export function migrationBodyForms(sql: string): string[] {
  return [sql, sql.trimEnd(), executableBody(sql)].filter((form) => form !== "");
}

/**
 * Human name for a rung index, for a reading a person has to act on.
 *
 * Rung 2 is `executableBody`, which discounts a leading comment block AND
 * trailing whitespace, so it is named for what it ASSERTS rather than for one
 * of the two things it ignores.
 */
export const BODY_FORM_LABELS = [
  "byte-identical",
  "identical but for trailing whitespace",
  "identical in what executes",
] as const;

export function bodyFormLabel(index: number): string {
  return BODY_FORM_LABELS[index] ?? "identical once non-executing bytes are discounted";
}

/**
 * Is this filename's version a real instant, or a sequence number wearing a
 * date's clothes?
 *
 * The prime's corpus is written by two generators and the difference decides
 * whether any time-based reading may speak at all:
 *
 * - **Machine-stamped** `<YYYYMMDDHHMMSS>_<uuid>.sql` — Lovable's own, 626 of
 *   1,002 files. The version IS the moment, and comparing it to a ledger
 *   timestamp is a comparison of two clocks.
 * - **Hand-named** `<digits>_<words>.sql` — 376 files. The digits are chosen
 *   to order the file, not to state when anything happened: this corpus holds
 *   `…096000`, `…097000` and `…098000` — minute 96 of an hour — and thirty
 *   files whose whole time component is `000000`.
 *
 * Measured, and this is the point: of the hand-named files the prime HAS run,
 * **every one** sat outside the ten-second skew window, because the window is
 * a time test and there is no time in the input. Asking it produces a
 * confident `never_applied` about a file that ran.
 */
const MACHINE_STAMPED = /^\d{14}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sql$/i;

export function isMachineStampedMigration(fileName: string): boolean {
  return MACHINE_STAMPED.test(fileName);
}
