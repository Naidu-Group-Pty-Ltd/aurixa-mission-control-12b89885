/**
 * How a clone came to record a migration version — executed, or asserted.
 *
 * ## The gap this closes
 *
 * A clone's applied-set is a UNION of two ledgers:
 *
 * ```sql
 * SELECT version FROM supabase_migrations.schema_migrations
 * UNION SELECT version FROM aurixa.schema_migrations
 * ```
 *
 * and `applyPrimeMigrations` skips every version in it. That is right, and
 * nothing here changes it. What was missing is that the rows in those tables
 * are not all the same KIND of fact:
 *
 *   - some were written by the lane after it ran the file — the clone
 *     demonstrably holds what the file produces;
 *   - some were written to assert that the clone is already level without
 *     anything being run — catalogue introspection built the schema, or a
 *     person reconciled by hand.
 *
 * Measured on `plisdzywzleljorrphxv` (2026-09-12): of 805 rows in
 * `aurixa.schema_migrations`, 22 record an execution and 783 were written in a
 * single 34-second burst on 2026-09-02 carrying prose in the `name` column.
 * `supabase_migrations` holds 1,745 rows there, 797 of them a baseline written
 * by hand on 2026-09-12. Nothing in either table distinguishes any of it.
 *
 * ## Why the name cannot answer it
 *
 * It is tempting to read the `name` column. It does not carry the answer, in
 * either direction:
 *
 *   - `stampMigrationLedgerFromPrime` writes `coalesce(name, version)` and the
 *     prime's own rows are mostly nameless, so **862 of 948** rows on that
 *     clone name the VERSION rather than a file. `cloneMigrationStanding`
 *     already records this and treats such a name as no evidence at all.
 *   - the inverse heuristic — "a name that is not a filename is an assertion" —
 *     is the one this module was written after watching fail. It classified six
 *     genuine hand-carried applies (`seed_template_library_v9_…` and friends,
 *     recorded under their slug) as assertions, and would have invited an
 *     operator to re-run work the clone already holds.
 *
 * So the classifier below recognises exactly ONE thing: the format the lane
 * itself writes. Everything else is `null` — not "asserted", not "applied", but
 * **unknown**, which is its own answer and the only honest one for a row
 * written before anybody was recording the difference.
 *
 * ## Three rules
 *
 * **Provenance describes; it never decides.** The applied-set stays the union
 * of both ledgers whatever the provenance says, because an assertion and an
 * execution both mean "do not send this". Filtering the union to executions
 * would turn every assertion into a HOLE, and `partitionByDependency` sends
 * nothing after a hole: on the clone measured above that is 776 holes and a
 * lane that delivers nothing, for ever. `migrationProvenance.test.ts` pins
 * that the union is unaffected.
 *
 * **Absence is unknown, never a claim.** A version with no provenance row is
 * reported as `unclassified` and counted separately. Defaulting it either way
 * would relabel one of the two populations wholesale — and both defaults were
 * available and both would have been wrong on real data.
 *
 * **Only the writer may assert.** Nothing here infers `asserted` from anything.
 * That value is written by the code path that performs the assertion, at the
 * moment it performs it, which is the only place that actually knows.
 */

/** How a recorded version came to be recorded. */
export type MigrationProvenance = "applied" | "asserted";

/** The two values the column accepts, for the check constraint and for tests. */
export const MIGRATION_PROVENANCE_VALUES: readonly MigrationProvenance[] = [
  "applied",
  "asserted",
] as const;

/** One provenance record read back from a clone. */
export type ProvenanceRow = { version: string; provenance: MigrationProvenance };

/**
 * What a clone's recorded coverage actually rests on.
 *
 * `recorded` is the union the replay skips; the other three partition it and
 * always sum to it.
 */
export type CoverageComposition = {
  /** Versions the clone records at all — the set `applyPrimeMigrations` skips. */
  recorded: number;
  /** Recorded, and something ran the file here. */
  applied: number;
  /** Recorded because somebody asserted the clone was already level. */
  asserted: number;
  /** Recorded before anybody was writing this down. Unknown, not a kind. */
  unclassified: number;
};

/**
 * The filename `applyPrimeMigrations` writes: the corpus meta's own name, which
 * is `<version>_<slug>.sql`.
 *
 * Anchored at both ends and required to carry the row's own version, so a row
 * naming some OTHER migration's file cannot be read as this one's execution.
 */
function isLaneWrittenFilename(name: string, version: string): boolean {
  const trimmed = name.trim();
  if (!trimmed.toLowerCase().endsWith(".sql")) return false;
  const prefix = `${version}_`;
  return trimmed.startsWith(prefix) && trimmed.length > prefix.length + 4;
}

/**
 * Read provenance off a legacy ledger row, or answer that it cannot be read.
 *
 * Returns `"applied"` ONLY for the lane's own filename format. Never returns
 * `"asserted"`: no shape of name is evidence that nothing ran, and guessing it
 * is what misread six real applies. See the header.
 */
export function provenanceFromLedgerName(
  name: string | null | undefined,
  version: string,
): MigrationProvenance | null {
  if (!name || !version) return null;
  if (name.trim() === version) return null; // the `coalesce(name, version)` case
  return isLaneWrittenFilename(name, version) ? "applied" : null;
}

/**
 * Ledger names whose WRITER is known, and known to have asserted rather than
 * run anything.
 *
 * This is not a heuristic and must never grow into one. `aurixa-baseline` is on
 * the list because the run that wrote it is known: on 2026-09-12 the repo and
 * the prime's ledger shared only 142 of 980 version stamps, so 838 corpus
 * versions read as holes and no clone could be sent anything; the repair
 * stamped the versions whose schema each clone demonstrably already had, under
 * that name, in `supabase_migrations.schema_migrations`. 797 rows on
 * npc-client-dashboard, 839 each on NPC Test and Preflight. Nothing ran.
 *
 * A name reaches this list only when somebody can say who wrote it and why.
 */
export const KNOWN_ASSERTION_NAMES: readonly string[] = ["aurixa-baseline"] as const;

/**
 * Read provenance off a canonical-ledger row.
 *
 * Symmetric with {@link provenanceFromLedgerName} and just as narrow: it
 * recognises only names whose writer is on {@link KNOWN_ASSERTION_NAMES}, and
 * answers null — unknown — for everything else, including every filename.
 * The canonical ledger's `name` is `coalesce(name, version)` from the prime, so
 * a filename there says nothing about what happened on the CLONE.
 */
export function provenanceFromCanonicalName(
  name: string | null | undefined,
): MigrationProvenance | null {
  if (!name) return null;
  return KNOWN_ASSERTION_NAMES.includes(name.trim()) ? "asserted" : null;
}

/**
 * Partition a clone's recorded versions by what is known about each.
 *
 * `recorded` drives the totals rather than the provenance table, so a
 * provenance row for a version the clone no longer records cannot inflate a
 * count — the table annotates the ledgers and is never a second opinion on
 * what they contain.
 */
export function composeCoverage(
  recordedVersions: readonly string[],
  provenance: readonly ProvenanceRow[],
): CoverageComposition {
  const recorded = new Set(recordedVersions);
  const byVersion = new Map<string, MigrationProvenance>();
  for (const row of provenance) {
    if (recorded.has(row.version)) byVersion.set(row.version, row.provenance);
  }

  let applied = 0;
  let asserted = 0;
  for (const kind of byVersion.values()) {
    if (kind === "applied") applied += 1;
    else asserted += 1;
  }

  return {
    recorded: recorded.size,
    applied,
    asserted,
    unclassified: recorded.size - applied - asserted,
  };
}

/**
 * One sentence an operator can act on, or silence when there is nothing to say.
 *
 * Returns null when every recorded version is a known execution — the state
 * that needs no caveat. Anything else names what the coverage rests on, in the
 * order that matters to somebody deciding whether to trust it.
 */
export function describeCoverage(c: CoverageComposition): string | null {
  if (c.recorded === 0) return null;
  if (c.applied === c.recorded) return null;

  const parts: string[] = [];
  if (c.asserted > 0) {
    parts.push(`${c.asserted} rest on an assertion that the clone was already level`);
  }
  if (c.unclassified > 0) {
    parts.push(`${c.unclassified} were recorded before this was written down`);
  }
  if (parts.length === 0) return null;

  return (
    `Of ${c.recorded} recorded versions, ${c.applied} were applied here and ` +
    `${parts.join(", and ")}.`
  );
}
