/**
 * Reading and recording how a clone came to hold each migration version.
 *
 * The policy — what counts as evidence of an execution, what counts as an
 * assertion, and why a name is almost never either — lives in
 * `migrationProvenance.pure.ts`. This module is the round trips.
 *
 * ## Why the classifier is not written in SQL
 *
 * A `WHERE name LIKE …` backfill would be one statement instead of a read, a
 * classify and a write. It would also be a SECOND implementation of the rule,
 * and this codebase has paid for that shape more than once — the test double
 * that emulated `.or()` with a regex so code and test agreed while the server
 * disagreed, the review cycle written twice so completing one booked the next
 * on a policy the rest of the product had abandoned. One implementation,
 * imported at both ends, is the house rule. The cost is two round trips per
 * clone on a pass that already makes dozens.
 */

import {
  BASELINE_ASSERTION_NAME,
  composeCoverage,
  provenanceFromCanonicalName,
  provenanceFromLedgerName,
  type CoverageComposition,
  type MigrationProvenance,
  type ProvenanceRow,
} from "@/server/migrationProvenance.pure";
import {
  PROVENANCE_TABLE_SQL,
  runSqlOnProject,
  sqlLiteral,
} from "@/server/backend-provisioning.server";
import { toRows } from "@/server/schema-introspection.server";

/** What one backfill pass did, or why it could not. */
export type ProvenanceBackfill =
  | {
      ok: true;
      considered: number;
      recorded: number;
      alreadyKnown: number;
      /** Rows whose note was upgraded off the baseline. See `upgradeNote`. */
      upgraded: number;
    }
  | { ok: false; error: string };

/** A clone's coverage composition, or why it could not be read. */
export type CoverageReading =
  | { ok: true; composition: CoverageComposition }
  | { ok: false; error: string };

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Chunked so one clone's backfill is not a single statement megabytes long. */
const WRITE_CHUNK = 200;

/**
 * Record provenance for every row whose provenance can be READ, and nothing
 * else.
 *
 * Idempotent by construction: `on conflict do nothing`, so a row the lane
 * itself wrote as `applied` is never overwritten by this inference. That
 * ordering is deliberate — the lane knows, this only reads — and it is why the
 * backfill can run on every pass without eroding what the writer recorded.
 *
 * Rows it cannot classify are LEFT ALONE rather than defaulted. On the clone
 * this was written for that is the large majority, and reporting them as
 * `unclassified` is the honest reading: nothing in the database says whether
 * they ran.
 */
export async function recordKnownProvenance(projectRef: string): Promise<ProvenanceBackfill> {
  let legacy: Array<Record<string, unknown>>;
  let canonical: Array<Record<string, unknown>>;
  try {
    [legacy, canonical] = await Promise.all([
      runSqlOnProject(projectRef, `select version, name from aurixa.schema_migrations`).then(
        toRows,
      ),
      runSqlOnProject(
        projectRef,
        `select version, name from supabase_migrations.schema_migrations`,
      ).then(toRows),
    ]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not read the ledgers" };
  }

  // One decision per version. The legacy ledger is read first because it is
  // the only one whose name can evidence an execution; a canonical row can
  // then only add an assertion for a version the legacy pass left unknown.
  //
  // `from` is carried because the two ledgers are not interchangeable on a
  // re-run. A legacy name is a REASON somebody recorded; the canonical
  // `aurixa-baseline` is a stamp the repair wrote so the lane could see past a
  // version. Where both exist the reason is the one worth keeping, and 59 of
  // the 775 rows that carry one on npc-client-dashboard say `OWED` or
  // `UNVERIFIED` rather than "already level".
  type Decision = { provenance: MigrationProvenance; note: string; from: "legacy" | "canonical" };
  const decided = new Map<string, Decision>();
  for (const row of legacy) {
    const version = str(row.version);
    const name = str(row.name);
    const p = provenanceFromLedgerName(name, version);
    if (p) decided.set(version, { provenance: p, note: name, from: "legacy" });
  }
  for (const row of canonical) {
    const version = str(row.version);
    if (decided.has(version)) continue;
    const name = str(row.name);
    const p = provenanceFromCanonicalName(name);
    if (p) decided.set(version, { provenance: p, note: name, from: "canonical" });
  }

  const considered = new Set([
    ...legacy.map((r) => str(r.version)),
    ...canonical.map((r) => str(r.version)),
  ]).size;

  if (decided.size === 0)
    return { ok: true, considered, recorded: 0, alreadyKnown: 0, upgraded: 0 };

  const entries = [...decided.entries()];
  const legacyEntries = entries.filter(([, d]) => d.from === "legacy");
  const canonicalEntries = entries.filter(([, d]) => d.from === "canonical");

  let recorded = 0;
  let upgraded = 0;
  try {
    // Ensure the table here rather than relying on the replay to have done it.
    // The lane returns early when a clone has nothing pending and so never
    // reaches `applyPrimeMigrations` — which is the state most clones are in
    // most of the time, and exactly the state whose coverage is worth
    // describing. One DDL, shared, so this cannot drift from the replay's.
    await runSqlOnProject(projectRef, PROVENANCE_TABLE_SQL);

    for (const [entriesForPass, conflict] of [
      [legacyEntries, upgradeNote()] as const,
      [canonicalEntries, "do nothing"] as const,
    ]) {
      for (let i = 0; i < entriesForPass.length; i += WRITE_CHUNK) {
        const chunk = entriesForPass.slice(i, i + WRITE_CHUNK);
        const values = chunk
          .map(
            ([version, d]) =>
              `(${sqlLiteral(version)}, ${sqlLiteral(d.provenance)}, ${sqlLiteral(d.note)})`,
          )
          .join(", ");
        // `xmax = 0` distinguishes a row this statement INSERTED from one it
        // updated. Without it an upsert's RETURNING cannot tell the two apart,
        // and a report that counts an upgrade as a new record is the kind of
        // number nobody can act on.
        const raw = await runSqlOnProject(
          projectRef,
          `insert into aurixa.migration_provenance (version, provenance, note)
           values ${values}
           on conflict (version) ${conflict}
           returning version, (xmax = 0) as inserted;`,
        );
        for (const row of toRows(raw)) {
          if (row.inserted === true || row.inserted === "t") recorded += 1;
          else upgraded += 1;
        }
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not write provenance" };
  }

  return {
    ok: true,
    considered,
    recorded,
    alreadyKnown: entries.length - recorded - upgraded,
    upgraded,
  };
}

/**
 * The one case in which this inference may overwrite what is already recorded.
 *
 * Everything else here is `do nothing`, and that ordering is the whole safety
 * of the module: the lane KNOWS and this only reads, so a row the lane wrote as
 * `applied` must never be rewritten by a guess.
 *
 * This clause is narrow enough to preserve that. It fires only on a row this
 * same function wrote — `asserted`, noted {@link BASELINE_ASSERTION_NAME} —
 * and only replaces that note with the REASON the legacy ledger carries for the
 * same version. The provenance value never changes, an `applied` row is never
 * touched, and nothing is destroyed: `supabase_migrations.schema_migrations`
 * still holds the baseline stamp, which is where that fact was written.
 *
 * It exists because `do nothing` is why the note is wrong. The backfill ran
 * before the seven 2026-09-02 rationales were on {@link KNOWN_ASSERTION_NAMES},
 * so the canonical pass supplied `aurixa-baseline` for all 775 of them and the
 * legacy pass could not replace it afterwards. 52 of those rows actually read
 * `OWED: … Never replay this file onto a tenant` and 7 read `UNVERIFIED`.
 */
export function upgradeNote(): string {
  return (
    `do update set note = excluded.note ` +
    `where aurixa.migration_provenance.provenance = 'asserted' ` +
    `and aurixa.migration_provenance.note = ${sqlLiteral(BASELINE_ASSERTION_NAME)} ` +
    `and excluded.note <> ${sqlLiteral(BASELINE_ASSERTION_NAME)}`
  );
}

/**
 * What a clone's recorded coverage rests on.
 *
 * `recordedVersions` is passed in rather than re-read so this answers about the
 * SAME union the caller is reporting on — a second read could disagree with the
 * first and the page would then show a composition of a set it is not showing.
 *
 * A missing provenance table is not a failure: it is a clone that has not been
 * through a pass since this shipped, and every version reads `unclassified`,
 * which is exactly true.
 */
export async function readCloneCoverage(
  projectRef: string,
  recordedVersions: readonly string[],
): Promise<CoverageReading> {
  let rows: ProvenanceRow[];
  try {
    const raw = await runSqlOnProject(
      projectRef,
      `select version, provenance from aurixa.migration_provenance`,
    );
    rows = toRows(raw)
      .map((r) => ({ version: str(r.version), provenance: str(r.provenance) }))
      .filter((r): r is ProvenanceRow => r.provenance === "applied" || r.provenance === "asserted");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The one error that is a state rather than a fault.
    if (/migration_provenance/i.test(message) && /does not exist|undefined table/i.test(message)) {
      return { ok: true, composition: composeCoverage(recordedVersions, []) };
    }
    return { ok: false, error: message };
  }

  return { ok: true, composition: composeCoverage(recordedVersions, rows) };
}
