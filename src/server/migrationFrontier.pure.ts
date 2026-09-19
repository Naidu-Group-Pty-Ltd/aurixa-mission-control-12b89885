/**
 * What `clone_backends.migration_version` is allowed to say.
 *
 * ## The fault this exists to make impossible
 *
 * Both introspection branches of `provisionCloneBackend` set the frontier to
 *
 * ```ts
 * latestApplied = [...snapshot.migrations].sort((a, b) => a.name.localeCompare(b.name)).at(-1)?.id
 * ```
 *
 * — the newest migration **file in the prime's repository**. That is not a
 * reading of the clone, and it is not even a reading of the prime: the prime's
 * `apply-migration.yml` is `workflow_dispatch` on a named file, so its ledger
 * records what somebody remembered to dispatch rather than what merged, and
 * four files sit on `main` that the prime has never run.
 *
 * Measured 19 September 2026 on `npc-crm-independent-6505dc`: the row reads
 * `migration_version = 20261204010000` while the clone's own
 * `supabase_migrations.schema_migrations` tops out at `20261203010000`. The
 * recorded frontier is **two versions ahead of what the clone holds**, and a
 * frontier ahead of the truth is the one direction that loses data silently —
 * `migration-sync` computes `corpus − frontier`, so both versions are skipped
 * as applied and nothing will ever send them again.
 *
 * It is the same shape as `cursorRanPastEnd` in `chunkCursorStore.pure.ts`: a
 * recorded position past the end of what actually happened, believed because
 * nothing ever compared it against the thing it describes.
 *
 * ## The rule
 *
 * **A version column is a reading of the thing it names.** This resolver is
 * given readings and never a corpus, which is the structural reason it cannot
 * reintroduce the fault: there is no file list in its input to reach for.
 *
 * Precedence, and why each step is where it is:
 *
 * 1. **The clone's own ledger.** The column names the clone, so the clone
 *    decides. This also catches a stamp that half-succeeded, which a reading
 *    taken from the source never could.
 * 2. **The prime's ledger**, only when the clone could not be read. This is
 *    what `stampMigrationLedgerFromPrime` copies row for row, so it is a
 *    defensible derivation rather than a guess — but it is a statement about
 *    the source, so it is second and it is labelled.
 * 3. **Nothing.** Where neither can be read the column is left exactly as it
 *    was. This is the half that matters: writing `null` would mean "this clone
 *    has applied no migrations", which sends the next sync to replay the whole
 *    corpus against a populated database — the failure
 *    `stampMigrationLedgerFromPrime`'s own guard was written to prevent, dressed
 *    as an ordinary status write.
 *
 * ## `null` is not the same as unreadable
 *
 * A clone whose ledger answers with no rows genuinely has an empty ledger, and
 * that IS worth recording — it is the state a full replay is the right answer
 * to. So `{ read: true, version: null }` writes, and only `read: false` with no
 * derivation withholds. Collapsing the two is how "we could not check" comes to
 * mean "there is nothing there", which this codebase has paid for twice.
 */

export type MigrationFrontierSource = "clone_ledger" | "prime_ledger" | "migration_replay";

export type LedgerReading =
  | { read: true; version: string | null }
  | { read: false; reason: string };

export type MigrationFrontier = {
  /** What to record. Meaningless unless `write` is true. */
  version: string | null;
  /** False means: leave `migration_version` exactly as it is. */
  write: boolean;
  /** Which reading this came from, for the row's own status line. */
  source: MigrationFrontierSource | "unreadable";
  /** One sentence naming the reading, safe to show an operator. */
  why: string;
};

/**
 * Resolve the frontier from readings alone.
 *
 * `clone` is what the clone's ledger answered. `primeLedgerTop` is the highest
 * version `stampMigrationLedgerFromPrime` copied — pass `undefined` where no
 * stamp ran this pass, which is different from a stamp that copied nothing.
 */
export function resolveMigrationFrontier(args: {
  clone: LedgerReading;
  primeLedgerTop?: string | null;
}): MigrationFrontier {
  if (args.clone.read) {
    return {
      version: args.clone.version,
      write: true,
      source: "clone_ledger",
      why: args.clone.version
        ? `Read from the clone's own migration ledger (${args.clone.version}).`
        : "The clone's migration ledger is empty — recorded as such, which is what a full replay answers.",
    };
  }
  if (typeof args.primeLedgerTop === "string" && args.primeLedgerTop.length > 0) {
    return {
      version: args.primeLedgerTop,
      write: true,
      source: "prime_ledger",
      why:
        `The clone's ledger could not be read (${args.clone.reason}); recorded from the prime's ` +
        `ledger, which this pass copied onto it (${args.primeLedgerTop}).`,
    };
  }
  return {
    version: null,
    write: false,
    source: "unreadable",
    why:
      `The clone's migration ledger could not be read (${args.clone.reason}) and no stamp ran ` +
      "this pass, so the recorded frontier is left untouched rather than cleared.",
  };
}

/**
 * No frontier at all — the starting position of a pass.
 *
 * Exists so that EVERY assignment to the provisioner's frontier is a call to
 * one of these three constructors and never a hand-written literal. That is
 * not tidiness: it is what lets a test state the rule as "the frontier comes
 * from a constructor" instead of pinning one spelling of the expression it
 * replaced. A planted `latestApplied = { version: [...snapshot.migrations]...,
 * write: true }` passed a regex that forbade the old spelling, because the old
 * spelling was `latestApplied = [...` and the plant put the spread one level
 * deeper. A rule that names a shape is a rule something can walk around.
 */
export function frontierUnreadable(reason: string): MigrationFrontier {
  return { version: null, write: false, source: "unreadable", why: reason };
}

/**
 * The frontier a migration replay establishes.
 *
 * `applyPrimeMigrations` returns the last version it actually applied, which is
 * a reading of the clone by construction — it is what the pass did to it. It is
 * given its own constructor rather than being poured into `clone` so that the
 * source survives onto the row, and so that a replay that applied nothing says
 * so instead of looking like an unreadable ledger.
 */
export function frontierFromReplay(latestApplied: string | null): MigrationFrontier {
  return {
    version: latestApplied,
    write: true,
    source: "migration_replay",
    why: latestApplied
      ? `Applied by this pass, up to ${latestApplied}.`
      : "This pass applied no migrations; the frontier is recorded as empty.",
  };
}
