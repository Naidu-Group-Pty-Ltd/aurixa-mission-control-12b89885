/**
 * One version, several files: how a shared migration version reaches a clone.
 *
 * ## The defect
 *
 * `supabase_migrations.schema_migrations.version` is the primary key, and the
 * replay records a version as soon as it has sent a file carrying it. The
 * prime's tree carries versions that more than one file shares — 25 versions
 * over 61 files on 23 Sep 2026 (32 over 77 on 20 Sep, before nine were renamed
 * apart), 24 over 59 once the withdrawn ones are taken out — and every layer
 * between the corpus and the clone treated a FILE as if its version named it:
 *
 * - The corpus resolved a version to one file, whichever sorted last, so
 *   `loadSql(id)` handed every sibling that one file's SQL. The fleet sync ran
 *   the last sibling's body once per sibling and never ran the others.
 * - The version was recorded after the FIRST sibling, and the clone's ledger
 *   was read once before the loop, so a budget stop, a failure or a hold
 *   between siblings left the rest behind a recorded version, where nothing
 *   will ever send them.
 * - The scope handed the replay its runnable set BY VERSION, so a file the
 *   prime never ran read as runnable whenever a sibling of it had been.
 *
 * ## The rule
 *
 * A version is delivered WHOLE or not at all. Every file the corpus carries at
 * that version is sent, each with its own SQL, in ONE request; the version is
 * recorded once, after that request succeeded. Where that cannot be done — a
 * file of the version was not cleared, or one is too large to travel in a
 * single request — nothing at that version is sent and the replay HOLDS, naming
 * the rule, because recording the version after sending part of it would claim
 * that the rest ran.
 *
 * A version carried by one file — every version but these — is exactly the
 * migration the replay always handled, and nothing about it changes.
 *
 * ## What one request does and does not buy
 *
 * It buys three things: each file's own body is what runs; the version is
 * recorded only when every file at it has run; and no budget check can fall
 * between two siblings. It does NOT buy atomicity across files that manage
 * their own transactions — a file carrying an explicit `BEGIN … COMMIT` commits
 * its own work whatever follows it — so a failure part-way leaves the version
 * unrecorded and the next pass sends every file again, which is the same thing
 * a single file that fails part-way already asks of its own statements.
 *
 * ## What it cannot settle
 *
 * A version the prime's ledger RECORDS clears every file at it, because the
 * ledger says the version ran and cannot say which file ran. Nothing here can
 * repair that: it is a fact about the prime's ledger, and the prime's own CI
 * refuses a new shared version. Measured 23 Sep 2026, the four versions the
 * prime records this way are held by every clone already.
 *
 * Pure: no network, no database.
 */

/** A file of the prime's corpus: its version and its full file name. */
export type MigrationFile = { id: string; name: string };

/** One version, and every file carrying it, in the order they were given. */
export type VersionUnit<T extends MigrationFile> = { version: string; members: T[] };

/**
 * Group files by version, keeping the order the versions first appear in and
 * the order of the files within each.
 *
 * The replay sorts by file name, and a shared version's files share a
 * fifteen-character prefix, so its members arrive adjacent — but this does not
 * rely on it: a member arriving later still joins its version's unit, because
 * a unit split in two would be recorded after its first half.
 */
export function versionUnits<T extends MigrationFile>(files: readonly T[]): VersionUnit<T>[] {
  const units = new Map<string, VersionUnit<T>>();
  for (const f of files) {
    const unit = units.get(f.id);
    if (unit) unit.members.push(f);
    else units.set(f.id, { version: f.id, members: [f] });
  }
  return [...units.values()];
}

/** A version some of whose files the scope cleared and some it withheld. */
export type SplitVersion = { version: string; cleared: string[]; withheld: string[] };

/**
 * The versions a scoped replay may treat as runnable: those whose EVERY corpus
 * file the scope cleared.
 *
 * The scope clears FILES — by the prime's ledger recording the version, or by
 * the prime's ledger holding the file's own body — and the replay records
 * VERSIONS. Collapsing the first into the second with `runnable.map(m => m.id)`
 * clears a whole version on the strength of one of its files, so a file the
 * prime never ran is sent because its sibling was.
 *
 * A version that is split is not runnable here, so it stands as a hole: nothing
 * at it is sent, and `partitionByDependency` decides what behind it has to wait.
 * `split` names each one, because a version the prime ran half of is a finding
 * about the prime, not merely a gap on a clone.
 */
export function wholeRunnableVersions(
  corpus: readonly MigrationFile[],
  runnable: readonly MigrationFile[],
): { runnableIds: Set<string>; split: SplitVersion[] } {
  const cleared = new Set(runnable.map((m) => m.name));
  const runnableIds = new Set<string>();
  const split: SplitVersion[] = [];
  for (const unit of versionUnits(corpus)) {
    const yes = unit.members.filter((m) => cleared.has(m.name)).map((m) => m.name);
    if (yes.length === 0) continue;
    if (yes.length === unit.members.length) {
      runnableIds.add(unit.version);
      continue;
    }
    split.push({
      version: unit.version,
      cleared: yes,
      withheld: unit.members.filter((m) => !cleared.has(m.name)).map((m) => m.name),
    });
  }
  return { runnableIds, split };
}

/**
 * What goes between two files' SQL when they travel as one request.
 *
 * A newline first, so a file ending in a `--` comment has its comment closed
 * before the separator rather than swallowing it; a semicolon, so a file whose
 * last statement carries no terminator is terminated; and a newline after, so
 * the next file starts on a line of its own. An empty statement between two
 * semicolons is legal SQL and runs nothing.
 */
export const SHARED_VERSION_SEPARATOR = "\n;\n";

/**
 * The one request a version's files travel in.
 *
 * A single body is returned byte-for-byte, so a version carried by one file
 * sends exactly what it always sent.
 */
export function joinSharedVersionSql(bodies: readonly string[]): string {
  if (bodies.length === 0) throw new Error("A version with no files has nothing to send");
  return bodies.length === 1 ? bodies[0] : bodies.join(SHARED_VERSION_SEPARATOR);
}

/**
 * The provenance note a shared version is recorded with: every file that ran,
 * in the order they ran. A version carried by one file keeps its file name.
 */
export function sharedVersionNote(members: readonly MigrationFile[]): string {
  return members.map((m) => m.name).join(" + ");
}

/** Why a shared version was held rather than sent. */
export type SharedVersionHold =
  /** The corpus carries files at this version that were not cleared to send. */
  | { reason: "incomplete"; version: string; sending: string[]; missing: string[] }
  /** One of its files is too large to travel in the single request it needs. */
  | { reason: "too_large"; version: string; file: string; files: string[] };

/**
 * The files of `unit` the corpus carries but the replay was not handed.
 *
 * `corpusFiles` is every file the corpus carries at the unit's version — the
 * whole scoped corpus for a scoped caller, or the list handed to the replay for
 * one that replays a snapshot, which carries every file by construction.
 */
export function missingMembers(
  unit: VersionUnit<MigrationFile>,
  corpusFiles: readonly MigrationFile[],
): string[] {
  const sending = new Set(unit.members.map((m) => m.name));
  return corpusFiles
    .filter((f) => f.id === unit.version && !sending.has(f.name))
    .map((f) => f.name);
}

/**
 * The sentence a hold is recorded under. It says what was NOT done, why doing
 * part of it would be worse, and where the remedy is — the prime, because the
 * repair for a shared version is to give each file a version of its own.
 */
export function sharedVersionHoldMessage(hold: SharedVersionHold): string {
  if (hold.reason === "incomplete") {
    return (
      `Version ${hold.version} is carried by ${hold.sending.length + hold.missing.length} files on ` +
      `the prime and only ${hold.sending.length} ${hold.sending.length === 1 ? "was" : "were"} cleared ` +
      `to send here (${hold.sending.join(", ")}); ${hold.missing.join(", ")} ` +
      `${hold.missing.length === 1 ? "was" : "were"} not. Nothing at this version was sent, because ` +
      `recording the version after sending part of it would claim the rest ran and nothing would ` +
      `ever send it. The remedy is on the prime: give each file a version of its own.`
    );
  }
  return (
    `Version ${hold.version} is carried by ${hold.files.length} files (${hold.files.join(", ")}) and ` +
    `${hold.file} is too large to travel in the one request that records the version. Nothing at ` +
    `this version was sent, because sending the files apart would record the version after the ` +
    `first of them. The remedy is on the prime: give each file a version of its own.`
  );
}
