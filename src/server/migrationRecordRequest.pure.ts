/**
 * A migration and its ledger record travel in ONE request.
 *
 * ## The window this closes
 *
 * The replay sent a migration's body to the clone in one Management API
 * request and recorded its version in a second (`recordReplayedVersion`). A
 * pass the platform ended between the two — the cut every pass here is
 * written to survive — left the change applied and unrecorded. The next pass
 * then sent the whole file again, and a file that is not idempotent (a
 * `create table` with no `if not exists`, the ordinary shape) fails the second
 * time on the object it created the first: the clone is marked
 * `migration_blocked` and held out of the fleet for a fault it never had.
 * Measured 27 Oct 2026 it had not happened yet; the window was real
 * (`docs/DELIVERY_SYSTEM_PLAN.md` §4.3 and W7).
 *
 * ## What one request buys, and what it does not
 *
 * The endpoint runs a request's statements as one implicit transaction unless
 * the text controls its own (PostgreSQL's "multiple statements in a simple
 * query"). So:
 *
 * - **A body with no transaction control of its own** is applied and recorded
 *   in one transaction: both, or neither. A body the clone refuses records
 *   nothing, exactly as before. A record that failed now takes the body with
 *   it, where it used to leave the body applied and unrecorded.
 * - **A body that commits its own transaction** (40 of the 1,129 migrations
 *   in the prime's tree wrap themselves in `BEGIN … COMMIT`, measured 27 Oct
 *   2026, reading top-level statements only) is
 *   recorded straight after its COMMIT, in the same request. No pass can end
 *   between the two any more, but the record is its own transaction: were the
 *   record refused, the committed body would stand unrecorded, as it always
 *   could. The body is never edited to move the record inside it. A clone is
 *   sent the file's own bytes, and the record follows them.
 * - **A body holding a statement PostgreSQL refuses inside a transaction
 *   block** (`CREATE INDEX CONCURRENTLY`, `VACUUM`, …) cannot share a request
 *   with anything: alone it runs, and beside the record it fails. It keeps the
 *   two requests. {@link transactionBlockRefusal} is a plain word match over
 *   the raw text, comments and strings included, so it can only be wrong by
 *   keeping two requests where one would have done, never by sending one that
 *   fails. Three of the prime's files match it (27 Oct 2026) and none of them
 *   for a statement that refuses a block: `REFRESH … CONCURRENTLY` inside a
 *   function body, twice, and the word "cluster" in a comment.
 *
 * A chunked seed is not this module's. It is many requests by construction,
 * and its record follows its last statement. A pass ended between them
 * resumes at the cursor, finds no statement left to send, and records it
 * (`applyChunkedSeed`).
 *
 * Pure: no network, no database.
 */

/**
 * What separates a body from the record that follows it in one request.
 *
 * The leading newline ends a line comment the body may finish on, and the
 * `;` ends a last statement written without one. An empty statement is
 * harmless where the body did end on `;`. The comment says, in the query log a
 * person may read, what the statements after it are.
 */
export const LEDGER_RECORD_SEPARATOR =
  "\n;\n-- Mission Control: this version's ledger record, in the request that applied it.\n";

/**
 * The statements PostgreSQL refuses to run inside a transaction block, as
 * words. Broad on purpose: a word that only LOOKS like one of these keeps a
 * body on two requests, which is today's behaviour and costs nothing.
 */
const REFUSES_A_BLOCK: readonly RegExp[] = [
  // CREATE / DROP / REINDEX … CONCURRENTLY, DETACH PARTITION … CONCURRENTLY.
  /\bconcurrently\b/i,
  /\bvacuum\b/i,
  /\breindex\b/i,
  /\bcluster\b/i,
  /\balter\s+system\b/i,
  /\b(?:create|alter|drop)\s+database\b/i,
  /\btablespace\b/i,
  /\b(?:create|alter|drop)\s+subscription\b/i,
  /\bdiscard\s+all\b/i,
  /\b(?:commit|rollback)\s+prepared\b/i,
];

/**
 * The first phrase in `sql` naming a statement that refuses a transaction
 * block, whitespace collapsed, or null where there is none.
 */
export function transactionBlockRefusal(sql: string): string | null {
  for (const re of REFUSES_A_BLOCK) {
    const hit = re.exec(sql);
    if (hit) return hit[0].replace(/\s+/g, " ").toLowerCase();
  }
  return null;
}

/**
 * The one request that applies `body` and records it, or why the two must
 * stay apart.
 *
 * `record` is the ledger write for the body's version, built by the replay's
 * one writer of it, so this never spells a ledger statement itself.
 */
export function bodyWithLedgerRecord(
  body: string,
  record: string,
): { together: true; sql: string } | { together: false; why: string } {
  const refusal = transactionBlockRefusal(body);
  if (refusal) {
    return {
      together: false,
      why:
        `it names \`${refusal}\`, which PostgreSQL may refuse inside a transaction block, ` +
        "so it is sent alone and recorded in a second request",
    };
  }
  return { together: true, sql: `${body}${LEDGER_RECORD_SEPARATOR}${record}` };
}
