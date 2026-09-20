/**
 * What the prime's ledger is short of, as the clone's own row records it.
 *
 * ## The two things this module exists for
 *
 * **A hole with nothing behind it was invisible.** `partitionByDependency`
 * accumulates a `holes` array for a corpus walk and returns `{send, orphaned}`
 * — the holes themselves are discarded. So a hole is reported only as the
 * `blockedBy` of an orphan sitting AFTER it, and `blockageLedger.server.ts`
 * opens a `prime_ledger_hole` row only from those `blockedBy` entries. A hole
 * at the TAIL of the corpus — the prime's repo carries a migration its ledger
 * does not record, with no runnable migration after it — withholds nothing,
 * so it produces no orphan, so it produces no entry, so nothing anywhere says
 * the prime is behind its own repository. That is the condition that opened
 * this engagement: four migrations unrecorded on the prime, found by hand.
 *
 * A hole is a fact about the PRIME. Whether anything is queued behind it is a
 * separate fact about the corpus, and reporting only the second is how the
 * first came to be unobservable.
 *
 * **A discharged blockage kept its sentence.** The fleet pass writes the
 * clone-facts only when it changed something (`didNothing`), which is right —
 * a no-op pass that wrote them once nulled `migration_version`, emptied
 * `migrations_applied` and replaced a parity verdict with "Synced to null".
 * But it means the record of a blockage is written by the pass that FOUND it
 * and never by the pass that disproves it, so `migrations_applied` keeps
 * `blockedBy` entries for a hole the prime has since recorded, and the
 * blockage ledger keeps the row open for ever.
 *
 * ## Why a pass that changed nothing may still be believed about this
 *
 * Not because `didNothing` implies the replay finished — it does not, and
 * assuming so is a mistake this module was written with and corrected.
 * `applyChunkedSeed` returns `{applied: 0, stoppedEarly: true,
 * upstreamRefusal: null}` when a stored cursor names more statements than the
 * seed has (`cursorRanPastEnd`), and the caller breaks on it having pushed no
 * result entry at all. So a pass can change nothing, examine almost nothing,
 * and still report `didNothing`.
 *
 * The warrant is structural instead, and stronger for it: **the blockage
 * classification is computed BEFORE the replay loop and over the whole
 * corpus.** `partitionByDependency` walks every corpus version against the
 * prime's runnable set and this clone's own ledger, and `rescueScopedOrphans`
 * then re-examines every orphan — both of them once, ahead of the first
 * migration being sent. Where the loop stops afterwards changes what was
 * APPLIED and cannot change what was CLASSIFIED.
 *
 * So the holes and the held-back versions are a complete, current reading on
 * every pass, including one the budget stopped and one that broke on a cursor
 * it could not honour. They are the only thing a no-op pass may be believed
 * about, which is why this module reconciles those entries alone and carries
 * every other entry on the row through exactly as it found it.
 *
 * ## Why the sentence is retracted by prefix and not by rewriting the field
 *
 * `clone_backends.status_detail` has more than one writer and the last one
 * wins. The migration lanes write it (`fleet-migration.server.ts`,
 * `migration-sync.functions.ts`, `self-healing.server.ts`); so do provisioning
 * and the parity sweep, whose verdict — "Backend provisioned but DOES NOT
 * MATCH the prime — missing_secrets:58" — is a fact about the clone that no
 * migration pass has any standing to retract. Overwriting it is the defect the
 * `didNothing` guard was built to stop, and re-introducing it in the course of
 * fixing the opposite defect would be a poor trade.
 *
 * So a lane retracts only a sentence it WROTE. The prefixes are declared here,
 * once, and read by both ends — the composer and the retraction — because a
 * literal at each end is how two ends drift. `fleetBlockageRecord.test.ts`
 * asserts every migration-lane sentence is recognised AND that every
 * provisioning and parity sentence is not; the second half is the assertion
 * that actually protects the verdict.
 */

/**
 * One entry of `clone_backends.migrations_applied`.
 *
 * Deliberately open: the column is JSONB written by two subsystems over
 * several schema generations, and this module's whole contract is that it
 * touches the entries it recognises and carries every other one through
 * untouched, byte for byte.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue | undefined }
  | JsonValue[];

export type AppliedRecordEntry = {
  id?: JsonValue;
  name?: JsonValue;
  blockedBy?: JsonValue;
  primeLedgerHole?: JsonValue;
  [key: string]: JsonValue | undefined;
};

/**
 * The openings of every sentence a MIGRATION lane writes into `status_detail`.
 *
 * Nothing else may appear here. A prefix that also matches a provisioning or
 * parity sentence hands this lane permission to erase a verdict it cannot
 * re-derive.
 */
export const MIGRATION_LANE_DETAIL_PREFIXES: readonly string[] = [
  // fleet-migration.server.ts, migration-sync.functions.ts, self-healing.server.ts
  "Synced to ",
  "Migration failed at ",
  // fleet-migration.server.ts, the chunked-seed heartbeat
  "Sending ",
  // migration-sync.functions.ts
  "Syncing migrations from ",
  "Migration sync refused: ",
  "Migration error: ",
  "Migrations up to date (",
  // self-healing.server.ts, the level reading with no version to name
  "Verified level with the prime's recorded migrations",
  // This module's own sentences, so a retraction can retract a retraction.
  "The prime's ledger is short of ",
];

/**
 * Did a migration lane write the sentence standing on this row?
 *
 * An absent or blank detail is nobody's, and filling it takes nothing from
 * anyone — so it answers true. Anything this module does not recognise belongs
 * to another writer and is left alone.
 */
export function migrationLaneWroteDetail(detail: string | null | undefined): boolean {
  if (detail === null || detail === undefined) return true;
  const trimmed = detail.trim();
  if (trimmed === "") return true;
  return MIGRATION_LANE_DETAIL_PREFIXES.some((p) => trimmed.startsWith(p));
}

/** Is this entry one of the blockage notes this module owns? */
export function isBlockageNote(entry: AppliedRecordEntry | null | undefined): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.primeLedgerHole === true) return true;
  return Array.isArray(entry.blockedBy) && entry.blockedBy.length > 0;
}

/**
 * The prime versions an existing record names as short, in the order found.
 *
 * Both shapes are read: a `primeLedgerHole` note names the hole as its own id,
 * and a `blockedBy` entry names the holes that are withholding it.
 */
export function holesNamedBy(stored: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entriesOf(stored)) {
    if (entry.primeLedgerHole === true && typeof entry.id === "string" && entry.id !== "") {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        out.push(entry.id);
      }
    }
    if (Array.isArray(entry.blockedBy)) {
      for (const v of entry.blockedBy) {
        if (typeof v !== "string" || v === "") continue;
        if (seen.has(v)) continue;
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

/**
 * How many holes are filed as notes on one pass.
 *
 * A display bound, exactly like `ORPHAN_BLOCKED_BY_DISPLAY_CAP`: the blockage
 * ledger opens one row per version and a person reads them, so a prime that is
 * three hundred versions behind its own repo should not open three hundred
 * rows. The true count travels in the sentence rather than being lost — the
 * number is the message, the list is not. Measured on this fleet the real
 * value is eleven.
 */
export const PRIME_LEDGER_HOLE_NOTE_CAP = 50;

/** A note that says the prime's ledger does not record this version. */
export function primeLedgerHoleNote(version: string): AppliedRecordEntry {
  return {
    id: version,
    name: version,
    // Nothing was sent and nothing refused anything: this is a note about the
    // PRIME, recorded on the clone's row because that is where the blockage
    // ledger reads. `skipped` keeps it out of `successes`, which is filtered
    // `success && !skipped`, so a hole can never read as a migration applied.
    success: true,
    skipped: true,
    primeLedgerHole: true,
  };
}

export type BlockageReconciliation = {
  /**
   * The array to write, or null when the blockage record already says exactly
   * what this pass measured — in which case nothing is written at all and the
   * row is left as found. A healthy fleet reaches this branch on every pass.
   */
  entries: AppliedRecordEntry[] | null;
  /** Versions the stored record named that this pass disproved. */
  discharged: string[];
  /** Versions this pass measured that the stored record did not name. */
  opened: string[];
  /** Every version this pass measured, in corpus order. */
  holes: string[];
};

/**
 * Reconcile the row's blockage record against what this pass measured.
 *
 * ONLY for a pass that changed nothing. A pass that changed something writes
 * its own `results` wholesale, which is already a complete fresh reading; this
 * exists because a no-op pass has no `results` to write and yet holds the only
 * current answer about the holes.
 *
 * Entries that are not blockage notes are carried through in their original
 * order, untouched — they are provisioning's record of what it applied, and
 * emptying that is one of the three things the `didNothing` guard was built to
 * stop.
 */
export function reconcileBlockageRecord(args: {
  /** `clone_backends.migrations_applied` as read. Any shape is tolerated. */
  stored: unknown;
  /** The holes this pass measured, in corpus order. */
  measured: readonly string[];
}): BlockageReconciliation {
  const measured: string[] = [];
  const measuredSet = new Set<string>();
  for (const v of args.measured) {
    if (typeof v !== "string" || v === "") continue;
    if (measuredSet.has(v)) continue;
    measuredSet.add(v);
    measured.push(v);
  }

  const stored = entriesOf(args.stored);
  const named = holesNamedBy(args.stored);
  const namedSet = new Set(named);

  const discharged = named.filter((v) => !measuredSet.has(v));
  const opened = measured.filter((v) => !namedSet.has(v));

  /*
    WHAT IS COMPARED IS THE RECORD, NOT THE HOLE SET.

    A first version returned early when no hole id had opened or discharged,
    which is a weaker test than it looks: the entries carry more than the set
    of holes. A stored `blockedBy` entry names a migration being WITHHELD, and
    this function is only ever called from a pass where `blocked` is empty by
    construction — so every stored `blockedBy` entry is already disproved,
    whatever the hole set does.

    The case that makes it bite: a clone acquires a formerly withheld
    migration by another route (the per-clone sync, self-healing, a repair
    applied by hand) while the hole that withheld it is still a hole. The hole
    set is unchanged, the old entry survives, and `blockageLedger` goes on
    reporting a `heldCount` and a `firstHeld` for a migration nothing is
    holding — for ever, because no later pass changes the hole set either.

    So the test is whether the stored notes ALREADY ARE the notes this pass
    would write. A legacy `blockedBy` entry never is one, so it is always
    replaced; an unchanged healthy row still writes nothing.
  */
  const storedNotes = stored.filter(isBlockageNote);
  const settled =
    storedNotes.length === measured.length &&
    storedNotes.every((e, i) => e.primeLedgerHole === true && e.id === measured[i]);
  if (settled) {
    return { entries: null, discharged, opened, holes: measured };
  }

  const kept = stored.filter((e) => !isBlockageNote(e));
  return {
    entries: [...kept, ...measured.map(primeLedgerHoleNote)],
    discharged,
    opened,
    holes: measured,
  };
}

/**
 * What a no-op pass may say about a row whose blockage record it just changed.
 *
 * Returns null when this lane may not speak — the sentence standing belongs to
 * another writer. A caller that gets null writes `migrations_applied` and
 * leaves `status_detail` alone: the blockage reaches an operator through the
 * blockage ledger either way, and a verdict erased does not come back.
 */
export function blockageDetailFor(args: {
  /** The sentence currently on the row. */
  standing: string | null | undefined;
  /** The holes this pass filed as notes — capped, so possibly not all of them. */
  holes: readonly string[];
  /**
   * How many holes the pass actually measured. Defaults to what it filed, and
   * differs from it only past `PRIME_LEDGER_HOLE_NOTE_CAP` — where the count
   * is the whole message and must not be the capped one.
   */
  total?: number;
  /**
   * True when the replay stopped with more to send.
   *
   * A pass that changed nothing can still have stopped early: `applyChunkedSeed`
   * returns `stoppedEarly` with `applied: 0` when a stored cursor names more
   * statements than the seed has, and the caller breaks on it having pushed no
   * result at all. Such a pass measures the holes correctly — the
   * classification runs before the replay loop — and knows NOTHING about
   * whether the clone is level, because it never finished looking.
   *
   * So it is passed in rather than inferred. Writing `Synced to X` there is a
   * claim no pass that stopped early is entitled to make, and it is the one
   * thing this lane must never say about a clone dozens of migrations behind.
   */
  pausedMidReplay?: boolean;
  /** What the level reading calls the version, when there are no holes. */
  syncedTo: string;
}): string | null {
  if (!migrationLaneWroteDetail(args.standing)) return null;
  if (args.pausedMidReplay) {
    /*
      COMPOSED, NEVER DELEGATED.

      A first version returned null here when there were no holes, on the
      assumption that the sentence already standing was the pause one. It need
      not be. `clearStaleMigrationFailure` (self-healing.server.ts) writes a
      bare `Synced to X` and does NOT touch `migrations_applied`, so a row can
      carry hole notes under a level sentence; discharge the last hole on a
      paused pass and that level claim would be left standing over a clone
      with more to send — which is the exact invariant this branch exists for.

      An invariant that depends on what another writer happened to leave
      behind is not an invariant. This composes the qualified reading every
      time, and the holes, where there are any, ride it.
    */
    const andHoles =
      args.holes.length === 0 ? "" : `, and ${primeLedgerHoleSentence(args.holes, args.total)}`;
    return (
      `Synced to ${args.syncedTo} so far — this pass stopped at its time budget with more ` +
      `to send${andHoles}`
    );
  }
  if (args.holes.length === 0) return `Synced to ${args.syncedTo}`;
  return `Synced to ${args.syncedTo} — ${primeLedgerHoleSentence(args.holes, args.total)}`;
}

/**
 * How a hole is named to an operator.
 *
 * One composer, read by the pass that measured the hole and by the pass that
 * retracts it, because the two sentences describe one condition and a literal
 * at each end is how two ends drift.
 *
 * It says what is owed and by WHOM: the versions are the prime's to record,
 * and no clone can be sent them until it does. A sentence that read as a fault
 * on the clone would send an operator to repair a tenant that is behaving
 * exactly correctly — which is the mistake this whole area keeps making.
 */
export function primeLedgerHoleSentence(holes: readonly string[], total?: number): string {
  const first = holes[0] ?? "a version";
  const rest = Math.max(total ?? holes.length, holes.length) - 1;
  return (
    `the prime's ledger is short of ${first}` +
    (rest > 0 ? ` and ${rest} other version(s)` : "") +
    ", which this clone is level without; they cannot be sent to any clone until the " +
    "prime records them"
  );
}

function entriesOf(stored: unknown): AppliedRecordEntry[] {
  if (!Array.isArray(stored)) return [];
  return stored.filter(
    (e): e is AppliedRecordEntry => typeof e === "object" && e !== null && !Array.isArray(e),
  );
}
