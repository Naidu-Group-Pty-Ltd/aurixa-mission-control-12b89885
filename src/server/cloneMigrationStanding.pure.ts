/**
 * What is a clone still owed, measured against the clone's OWN ledger.
 *
 * ## The reading this replaces
 *
 * `getCloneMigrationStatus` computed "pending" as every runnable prime
 * migration whose version sorts above `clone_backends.migration_version` —
 * Mission Control's own cursor, written by whichever sync last finished. The
 * clone was never asked. Measured 9 Sep 2026 on all three clones, the cursor
 * read `20261111010000` while the ledger's own maximum was `20261112010000`,
 * so the page offered five pending migrations of which:
 *
 *   20261112000000 seed_template_library_v12_guarded_verdict_line  already applied
 *   20261112010000 refresh_active_masters_from_library_v12          already applied
 *   20261112000000 client_deals_agent_fee_receipt                   can never apply
 *   20261114090000 verification_workspace_out_of_tokens             genuinely owed
 *   20261115100000 builder_stock_runtime_version_3                  genuinely owed
 *
 * Two of the five were done, one of them cannot be sent at all, and the badge
 * said "5 PENDING". A cursor is a record of a run; a ledger is a fact about the
 * database, and this page is answering a question about the database.
 *
 * ## Why a version can never be sent
 *
 * `supabase_migrations.schema_migrations.version` is the PRIMARY KEY, so a
 * version carried by more than one file can only ever record ONE of them.
 * `applyPrimeMigrations` skips by VERSION, so every other file at that version
 * is skipped for ever — on this clone and on every future one. The prime keeps
 * the frozen inventory in `supabase/migrations/MIGRATION_VERSION_COLLISIONS.json`
 * (42 groups, 98 files) and fails CI on a new one.
 *
 * Ten of those 42 versions are in the prime's own ledger, so ten reach a clone
 * as runnable and each carries two files — ten files fleet-wide that the sync
 * will skip whatever anybody presses. Counting them as pending offers a button
 * that cannot discharge them; counting them as applied claims the clone holds
 * something it does not. They are their own reading, one line per version.
 *
 * ## The `name` column is not evidence
 *
 * It is tempting to settle a shared version by asking the ledger which file it
 * recorded. It cannot answer. `stampMigrationLedgerFromPrime` writes
 * `coalesce(name, version)`, and the prime's own rows are mostly nameless, so
 * the clone's `name` holds the version string back again: measured on
 * `plisdzywzleljorrphxv`, **862 of 948 rows name the version rather than a
 * file**. A matcher that trusted that column would call almost every migration
 * in the corpus "recorded under another name".
 *
 * So a name equal to the version is treated exactly like a null — no evidence —
 * and the reading falls back to the honest one: the version is recorded, more
 * than one file carries it, and the ledger cannot say which ran.
 *
 * The legacy `aurixa.schema_migrations` mirror is unioned in for membership
 * exactly as `applyPrimeMigrations` unions it, and contributes no name at all.
 */

/** One row of a clone's migration ledger. `name` is very often the version. */
export type LedgerRow = { version: string; name: string | null };

/** A prime corpus entry the scope has cleared for replay. */
export type RunnableMigration = { id: string; name: string };

/** A version carried by more than one runnable file, already recorded here. */
export type SharedVersion = {
  version: string;
  /** Every runnable file at this version, in corpus order. */
  files: string[];
  /**
   * The file the ledger names, when it names one at all. Null is the ordinary
   * case and means the ledger records the version without saying which file
   * produced it — not that something is wrong.
   */
  recordedAs: string | null;
};

export type CloneMigrationStanding = {
  /**
   * Where the reading came from. `clone_ledger` is the clone's own
   * `supabase_migrations ∪ aurixa` membership; `recorded_version` is Mission
   * Control's stored cursor, used only when the clone could not be read.
   */
  basis: "clone_ledger" | "recorded_version";
  /** Runnable migrations whose version this clone does not record. */
  pending: { id: string; description: string }[];
  /** Recorded versions that more than one runnable file claims. */
  sharedVersions: SharedVersion[];
  /**
   * Runnable VERSIONS this clone records, and how many the corpus has.
   *
   * Counted by version rather than by file because that is the unit the ledger
   * and the replay both work in: a version two files share is one row, one
   * skip, and one fact about the clone. Counting files would report a clone
   * holding every version as nine short, which is the confusion this whole
   * module exists to remove. Null on the fallback basis.
   */
  appliedVersionCount: number | null;
  runnableVersionCount: number | null;
  /**
   * The highest runnable version this clone actually records — where it stands,
   * as opposed to where Mission Control's cursor says it was left. On the three
   * clones measured this is `20261112010000` against a cursor of
   * `20261111010000`: the clone was AHEAD of the record kept about it.
   */
  latestAppliedVersion: string | null;
  /** Set only on the fallback basis: why the ledger was not used. */
  note: string | null;
};

/**
 * The two sides spell the same migration differently, and comparing them raw
 * makes every match fail.
 *
 * A corpus entry's `name` is the FULL filename —
 * `20261112000000_seed_template_library_v12_guarded_verdict_line.sql`, which is
 * also what `applyPrimeMigrations` writes when it applies one. The prime's own
 * ledger, and therefore everything `stampMigrationLedgerFromPrime` copies onto
 * a clone, carries the Supabase CLI's form: the base alone,
 * `seed_template_library_v12_guarded_verdict_line`. Both forms are in a live
 * clone's ledger at once.
 */
function migrationKey(value: string): string {
  return value
    .trim()
    .replace(/^\d{8,14}_/, "")
    .replace(/\.sql$/i, "");
}

/**
 * Name evidence, or nothing.
 *
 * A ledger `name` that repeats the version is what the re-stamp writes for a
 * prime row with no name of its own, which is most of them. It says nothing
 * about which file ran, and reading it as a file name is how a correct clone
 * comes to look entirely unapplied.
 */
function nameEvidence(row: LedgerRow): string | null {
  const n = row.name?.trim();
  if (!n) return null;
  if (n === row.version) return null;
  return n;
}

/**
 * A ledger row's name may carry more than one file — the prime records both
 * sides of a collision it applied together, e.g.
 * `builder_admin_blocker_array_fix + market_intelligence_render_path`. Matching
 * every part rather than the whole string is what keeps such a pair reading as
 * applied instead of as two files fighting over one version.
 */
function evidenceNames(evidence: string, file: string): boolean {
  const want = migrationKey(file);
  return evidence.split(/[+,]/).some((part) => migrationKey(part) === want);
}

/**
 * Measure a clone against the prime's runnable corpus.
 *
 * `ledger` is null when the clone could not be read. That is deliberately NOT
 * the same as an empty ledger: a read that failed says nothing about the
 * database, and reporting the whole corpus as pending would put a several
 * hundred migration replay behind a button an operator is looking at because a
 * page said something alarming. The caller's stored cursor answers instead, and
 * `basis` says so.
 */
export function readCloneMigrationStanding(args: {
  runnable: ReadonlyArray<RunnableMigration>;
  /** The clone's own ledger rows, or null when the read did not succeed. */
  ledger: ReadonlyArray<LedgerRow> | null;
  /** Mission Control's stored cursor, for the fallback basis only. */
  recordedVersion: string | null;
  /** Why the ledger is null, when it is. */
  ledgerError?: string | null;
}): CloneMigrationStanding {
  const { runnable, ledger, recordedVersion } = args;

  if (ledger === null) {
    return {
      basis: "recorded_version",
      pending: runnable
        .filter((m) => !recordedVersion || m.id > recordedVersion)
        .map((m) => ({ id: m.id, description: m.name })),
      sharedVersions: [],
      appliedVersionCount: null,
      runnableVersionCount: null,
      latestAppliedVersion: null,
      note:
        (args.ledgerError
          ? `This clone's migration ledger could not be read (${args.ledgerError}). `
          : "This clone's migration ledger could not be read. ") +
        "The list below is measured against the version Mission Control recorded at the last " +
        "sync, which can name work that is already done.",
    };
  }

  // An empty ledger on a clone Mission Control believes it has synced is a
  // contradiction, not a measurement: the tracking table is created by every
  // replay, so zero rows beside a recorded cursor means the read reached
  // somewhere unexpected. Fall back rather than declare the whole corpus owed.
  if (ledger.length === 0 && recordedVersion) {
    return {
      basis: "recorded_version",
      pending: runnable
        .filter((m) => m.id > recordedVersion)
        .map((m) => ({ id: m.id, description: m.name })),
      sharedVersions: [],
      appliedVersionCount: null,
      runnableVersionCount: null,
      latestAppliedVersion: null,
      note:
        `This clone's migration ledger came back empty while Mission Control records it as ` +
        `synced to ${recordedVersion}. The list below is measured against that recorded ` +
        `version; the ledger itself needs a look before it is trusted.`,
    };
  }

  const recorded = new Map<string, LedgerRow[]>();
  for (const row of ledger) {
    const at = recorded.get(row.version);
    if (at) at.push(row);
    else recorded.set(row.version, [row]);
  }

  // How many runnable files each version carries. Only versions with more than
  // one can be shared, and the count comes from the corpus rather than from a
  // list, so a collision that appears tomorrow is read the same way.
  const filesAtVersion = new Map<string, string[]>();
  for (const m of runnable) {
    const at = filesAtVersion.get(m.id);
    if (at) at.push(m.name);
    else filesAtVersion.set(m.id, [m.name]);
  }

  const pending: { id: string; description: string }[] = [];
  const shared = new Map<string, SharedVersion>();
  const appliedVersions = new Set<string>();

  for (const m of runnable) {
    const rows = recorded.get(m.id);
    if (!rows) {
      pending.push({ id: m.id, description: m.name });
      continue;
    }
    appliedVersions.add(m.id);

    const siblings = filesAtVersion.get(m.id) ?? [m.name];
    // One file, one version, recorded. Nothing to disambiguate.
    if (siblings.length === 1) continue;

    const evidence = rows.map(nameEvidence).find((n): n is string => n !== null) ?? null;
    if (evidence && evidenceNames(evidence, m.name)) continue;

    // Either the ledger names a SIBLING — so this file was skipped by version
    // and will be skipped by every future pass — or it names nothing, and one
    // of the files ran with no way to tell which. Both are the same fact to an
    // operator: nothing here is outstanding and nothing they press will send it.
    shared.set(m.id, { version: m.id, files: siblings, recordedAs: evidence });
  }

  return {
    basis: "clone_ledger",
    pending,
    sharedVersions: [...shared.values()].sort((a, b) => a.version.localeCompare(b.version)),
    appliedVersionCount: appliedVersions.size,
    runnableVersionCount: filesAtVersion.size,
    latestAppliedVersion: [...appliedVersions].sort().pop() ?? null,
    note: null,
  };
}

/**
 * The sentence a shared version is rendered with.
 *
 * Kept beside the rule rather than in the component, because the same
 * distinction has to survive being read by somebody who has never heard of a
 * primary key: what it must always say is that nothing is outstanding here and
 * nothing anybody presses will change it.
 */
export function sharedVersionReading(s: SharedVersion): string {
  // Compared through `evidenceNames`, never by string equality: `recordedAs`
  // is the CLI's base form and `files` are full filenames, so `!==` keeps the
  // recorded file in the list and the sentence then says the migration that
  // DID run is one of the ones that never will.
  const others = s.recordedAs
    ? s.files.filter((f) => !evidenceNames(s.recordedAs!, f))
    : [...s.files];
  if (s.recordedAs) {
    return (
      `Recorded as ${s.recordedAs}. ${others.join(", ")} shares this version, and a version ` +
      `can only be recorded once — it is skipped by every sync and cannot be applied here.`
    );
  }
  return (
    `Recorded, but the ledger does not say which of ${s.files.join(" / ")} ran — a version can ` +
    `only be recorded once. Both are skipped by every sync.`
  );
}
