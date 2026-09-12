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
 * So the classifier below reads a name in exactly two ways, both of them exact
 * MEMBERSHIP tests and neither of them a judgement about shape: the filename
 * format the lane itself writes, and a curated list of names whose writer is
 * known ({@link KNOWN_ASSERTION_NAMES}). Everything else is `null` — not
 * "asserted", not "applied", but **unknown**, which is its own answer and the
 * only honest one for a row nobody can account for.
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
 * **An assertion is accounted for, never inferred.** `asserted` is written by
 * the code path that performs one, at the moment it performs it — or read back
 * from a name on {@link KNOWN_ASSERTION_NAMES}, where a person has said who
 * wrote it and why. It is never derived from a prefix, a keyword or the absence
 * of a file extension. That list is a LIST: 783 legacy rows on one clone are
 * classified by eight exact strings, and the eight slug-named APPLIES sitting
 * beside them are left unknown rather than swept up by a rule that could not
 * tell them apart.
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
 * Ledger names whose WRITER is known, and known to have asserted rather than
 * run anything.
 *
 * This is a LIST, never a pattern, and that is the whole of its safety. A name
 * reaches it only when somebody can say who wrote it and why; nothing here
 * reads a shape, a prefix or a keyword. The seven prose entries below are
 * quoted in full for exactly that reason — a `startsWith("accounted:")` rule
 * would be one edit away from swallowing a name nobody has accounted for.
 *
 * **`aurixa-baseline`** — on 2026-09-12 the prime repo and the prime's ledger
 * shared only 142 of 980 version stamps, so 838 corpus versions read as holes
 * and no clone could be sent anything. The repair stamped, under that name in
 * `supabase_migrations.schema_migrations`, the versions whose schema each clone
 * demonstrably already had. 797 rows on npc-client-dashboard, 839 each on NPC
 * Test and Preflight. Nothing ran.
 *
 * **The seven rationales** — written into `aurixa.schema_migrations` on
 * npc-client-dashboard in a single 34-second burst on 2026-09-02 16:56:53Z by a
 * reconciliation carried out by hand, 775 rows in all. Each says in its own
 * words that the clone was already level and nothing was sent. They are the
 * only surviving record of that run's reasoning, which is why they are quoted
 * rather than summarised.
 *
 * ## Two ledgers can both name the same version, and only one of them is a REASON
 *
 * 775 of those rows are in BOTH: the 2026-09-02 reconciliation wrote a rationale
 * into `aurixa.schema_migrations`, and the 2026-09-12 repair stamped
 * `aurixa-baseline` into `supabase_migrations.schema_migrations`. Both are true
 * and they are not the same fact. The prose says WHY somebody concluded the
 * clone was level; the baseline says a stamp was written so the lane could see
 * past it.
 *
 * The prose is the one worth keeping in `note`, because 59 of those 775 do not
 * say "already level" at all — 52 say `OWED: the prime carries this and this
 * clone does not … Never replay this file onto a tenant`, and 7 say
 * `UNVERIFIED`. Reading them all as `aurixa-baseline` erases exactly the
 * distinction an operator needs. Nothing is lost by preferring the prose:
 * `supabase_migrations` still holds the baseline stamp, unmodified, which is
 * where that fact was written and where it still is.
 *
 * What is deliberately NOT here: the eight slug-named rows on that same clone
 * (`seed_template_library_v9_report_part_numbering` and its siblings). Those
 * are hand-carried APPLIES — `20261112000000`'s two columns were verified
 * present on the prime and the clone — and classifying them as assertions is
 * the precise misreading this module was written after watching happen.
 */
export const BASELINE_ASSERTION_NAME = "aurixa-baseline";

export const KNOWN_ASSERTION_NAMES: readonly string[] = [
  BASELINE_ASSERTION_NAME,
  "accounted: this clone was built by catalog introspection from the prime and already carries what this file creates (objects verified 2026-09-02)",
  "accounted: the prime ran this file under a different ledger timestamp and this clone was mirrored from that schema (verified 2026-09-02)",
  "OWED: the prime carries this and this clone does not — a cron schedule that hardcodes the prime project ref, a storage policy, or a seeded row that catalog introspection does not copy. Never replay this file onto a tenant.",
  "accounted: the observable this file leaves reads the same on the prime and on this clone (verified 2026-09-02) — applied and later superseded, or never run by either",
  "accounted: the feature-flag rows this file seeds were copied from the prime by hand on 2026-09-02 — catalogue introspection carries the table and not its rows",
  "UNVERIFIED: this file leaves no observable this check can read — a data backfill, a grant sweep, a DELETE, or a body inside a dollar-quoted block. Recorded so it cannot block later versions; nothing was sent to this clone. Worth an operator reading these seven files.",
  "accounted: what this file creates is absent from the prime as well, so the prime has never applied it and no clone may be sent it (verified 2026-09-02)",
] as const;

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
 * Two exact tests and no inference. `"applied"` comes only from the lane's own
 * filename format; `"asserted"` only from exact membership of
 * {@link KNOWN_ASSERTION_NAMES}. No SHAPE of a name is evidence in either
 * direction — guessing from shape is what misread six real applies — so an
 * unrecognised name is unknown however confidently it reads.
 */
export function provenanceFromLedgerName(
  name: string | null | undefined,
  version: string,
): MigrationProvenance | null {
  if (!name || !version) return null;
  const trimmed = name.trim();
  if (trimmed === version) return null; // the `coalesce(name, version)` case
  if (KNOWN_ASSERTION_NAMES.includes(trimmed)) return "asserted";
  return isLaneWrittenFilename(trimmed, version) ? "applied" : null;
}

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
