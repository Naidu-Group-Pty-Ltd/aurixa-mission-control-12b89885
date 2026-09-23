/**
 * A migration never writes a migration ledger — and a clone is never sent one
 * that does.
 *
 * ## What a clone's ledger is
 *
 * Three tables on a clone record what reached it: Supabase's own
 * `supabase_migrations.schema_migrations`, and the two Mission Control keeps
 * beside it in the `aurixa` schema — the legacy `schema_migrations` mirror and
 * `migration_provenance`, which says HOW each version came to be there. All
 * three are written by the replay that delivers to the clone, in
 * `recordReplayedVersion`, and by nothing else. The module ledger,
 * `aurixa.module_installations`, lives in the same schema and is written the
 * same way. Everything that decides what a clone is still owed reads them.
 *
 * ## Why a migration that writes one is held
 *
 * A migration runs on every database it is delivered to, and on each it edits
 * rows the database's OWN deliveries wrote. `20260921100000` is the case that
 * happened: on the prime it deleted five versions' ledger rows so that the
 * record matched the prime's database, which was true there. On a clone the
 * same DELETE removed rows the clone's own deliveries had written, for files
 * whose state there nobody had measured — and two of those five files are
 * still in the tree, so the next pass saw them as never delivered. After it
 * the five databases disagreed about `finance_portal_documents` by delivery
 * order rather than by any decision (measured 23 Sep 2026: two clones carried
 * the Quick Send columns and two did not).
 *
 * So a file that writes a ledger is HELD: nothing at its version is sent, the
 * replay halts, and the clone is exactly as it was. The remedy is on the
 * prime, whose `MIGRATION_WITHDRAWN.json` is where a file whose effect is
 * deliberately absent is declared — a declaration every reader understands and
 * no database has to be edited to express.
 *
 * ## The rule, and where it comes from
 *
 * The statement shapes are the prime's own gate's,
 * `scripts/security/check-migration-ledger-writes.mjs`, which refuses a new
 * ledger write before it can be applied there; this is the same rule at the
 * other end, for anything that gets past it. It covers the `aurixa` schema as
 * well as `supabase_migrations`, because on a clone that schema IS ledger and
 * the prime has no reason to name it: no prime migration refers to it at all
 * (measured 23 Sep 2026).
 *
 * It reads text. Comments are stripped — they hold example SQL and prose —
 * and strings are KEPT, so a write inside an `EXECUTE` string or a function
 * body is seen: a function that writes the ledger writes it whenever it is
 * called. A statement assembled from parts at run time, such as a schema name
 * passed through `format('%I')`, is invisible to it, as it is to the prime's
 * gate; that shape has never been written in this corpus.
 *
 * ## The one file frozen as history
 *
 * `20260921100000` is applied on the prime and recorded on every clone
 * (measured 23 Sep 2026), so no sync ever sends it again. It is frozen here by
 * name for the one reader left: a clone built by replaying the whole corpus
 * from nothing, where it runs exactly as it ran on the prime and leaves the
 * prime's end state. Holding it there instead would halt every such replay at
 * it for ever. Its bytes cannot change — the prime's applied-body guard fails
 * CI if they do — so the name cannot come to cover anything new, and the
 * prime's gate freezes the same file for the same reason.
 *
 * Pure: no network, no database.
 */

import { stripSqlComments } from "./sqlComments.pure";

/**
 * Applied before either guard existed; frozen as history, never extended.
 * The prime's gate carries the same one entry.
 */
export const LEDGER_WRITE_FROZEN: ReadonlyMap<string, string> = new Map([
  [
    "20260921100000_withdraw_builder_aml_partner_portal_changes.sql",
    "Deleted five ledger rows on the prime on 21 Sep 2026. Applied, and recorded on every " +
      "clone, so no sync sends it; a replay from nothing runs it as the prime did.",
  ],
]);

const SCHEMA = String.raw`"?(?:supabase_migrations|aurixa)"?`;

/** Every statement shape that writes into either ledger schema. Reads are allowed. */
const WRITES: readonly RegExp[] = [
  new RegExp(String.raw`\binsert\s+into\s+${SCHEMA}\s*\.`, "i"),
  new RegExp(String.raw`\bupdate\s+(?:only\s+)?${SCHEMA}\s*\.`, "i"),
  new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?${SCHEMA}\s*\.`, "i"),
  new RegExp(String.raw`\btruncate\s+(?:table\s+)?(?:only\s+)?${SCHEMA}\s*\.`, "i"),
  new RegExp(String.raw`\bmerge\s+into\s+${SCHEMA}\s*\.`, "i"),
  new RegExp(String.raw`\bcopy\s+${SCHEMA}\s*\.`, "i"),
  new RegExp(
    String.raw`\b(?:alter|drop)\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${SCHEMA}\s*\.`,
    "i",
  ),
  new RegExp(String.raw`\b(?:alter|drop)\s+schema\s+(?:if\s+exists\s+)?${SCHEMA}(?![\w$])`, "i"),
];

/**
 * The first statement shape in `sql` that writes a ledger, whitespace
 * collapsed — or null where there is none.
 *
 * Says nothing about the freeze, so the frozen file's write stays observable
 * and a test can prove the freeze is what lets it through.
 */
export function ledgerWriteIn(sql: string): string | null {
  const code = stripSqlComments(sql);
  for (const re of WRITES) {
    const hit = re.exec(code);
    if (hit) return hit[0].replace(/\s+/g, " ").trim();
  }
  return null;
}

/**
 * Why `file` must not be sent, or null where it may be.
 *
 * `shared` names the version and every file carrying it, where there is more
 * than one — nothing at the version is sent, and the sentence says so.
 */
export function ledgerWriteRefusal(
  file: string,
  sql: string,
  shared?: { version: string; files: readonly string[] },
): string | null {
  if (LEDGER_WRITE_FROZEN.has(file)) return null;
  const statement = ledgerWriteIn(sql);
  if (statement === null) return null;
  const scope =
    shared && shared.files.length > 1
      ? `Nothing at version ${shared.version} was sent (${shared.files.join(", ")} share it).`
      : "It was not sent.";
  return (
    `${file} writes a migration ledger (\`${statement} …\`). ${scope} A clone's ledger is ` +
    `written by the replay that delivers to it and by nothing else: this would edit the rows ` +
    `that record what reached the clone, for files whose state there nobody has measured. The ` +
    `remedy is on the prime: declare a file whose effect is deliberately absent in ` +
    `supabase/migrations/MIGRATION_WITHDRAWN.json rather than editing the ledger, and give the ` +
    `rest of this file's work a migration of its own.`
  );
}
