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
  composeCoverage,
  provenanceFromCanonicalName,
  provenanceFromLedgerName,
  type CoverageComposition,
  type MigrationProvenance,
  type ProvenanceRow,
} from "@/server/migrationProvenance.pure";
import { runSqlOnProject, sqlLiteral } from "@/server/backend-provisioning.server";
import { toRows } from "@/server/schema-introspection.server";

/** What one backfill pass did, or why it could not. */
export type ProvenanceBackfill =
  | { ok: true; considered: number; recorded: number; alreadyKnown: number }
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
  const decided = new Map<string, { provenance: MigrationProvenance; note: string }>();
  for (const row of legacy) {
    const version = str(row.version);
    const name = str(row.name);
    const p = provenanceFromLedgerName(name, version);
    if (p) decided.set(version, { provenance: p, note: name });
  }
  for (const row of canonical) {
    const version = str(row.version);
    if (decided.has(version)) continue;
    const name = str(row.name);
    const p = provenanceFromCanonicalName(name);
    if (p) decided.set(version, { provenance: p, note: name });
  }

  const considered = new Set([
    ...legacy.map((r) => str(r.version)),
    ...canonical.map((r) => str(r.version)),
  ]).size;

  if (decided.size === 0) return { ok: true, considered, recorded: 0, alreadyKnown: 0 };

  const entries = [...decided.entries()];
  let recorded = 0;
  try {
    for (let i = 0; i < entries.length; i += WRITE_CHUNK) {
      const chunk = entries.slice(i, i + WRITE_CHUNK);
      const values = chunk
        .map(
          ([version, d]) =>
            `(${sqlLiteral(version)}, ${sqlLiteral(d.provenance)}, ${sqlLiteral(d.note)})`,
        )
        .join(", ");
      const raw = await runSqlOnProject(
        projectRef,
        `insert into aurixa.migration_provenance (version, provenance, note)
         values ${values}
         on conflict (version) do nothing
         returning version;`,
      );
      recorded += toRows(raw).length;
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not write provenance" };
  }

  return {
    ok: true,
    considered,
    recorded,
    alreadyKnown: entries.length - recorded,
  };
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
