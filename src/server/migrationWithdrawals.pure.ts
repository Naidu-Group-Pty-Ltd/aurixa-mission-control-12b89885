/**
 * The prime's declared withdrawals: which migration FILES are deliberately
 * absent from every database, read from the prime's own
 * `supabase/migrations/MIGRATION_WITHDRAWN.json`.
 *
 * ## Why Mission Control reads it
 *
 * A migration file can stay in the prime's tree for good while its effect is
 * deliberately absent everywhere: withdrawn at the owner's direction, or
 * superseded by a later file whose work it would undo. The file cannot be
 * deleted (an applied migration's bytes are part of the record of what ran),
 * so the prime declares it instead, and its own drift check asserts the
 * declaration by effect on every run.
 *
 * Undeclared, such a file is a HOLE on every clone: the prime never records
 * it, the clone never has it, and `partitionByDependency` treats it as a
 * barrier. Measured 23 Sep 2026, the withdrawn AML verification file
 * (`20260728120000`) held the v16, v17 and v18 template-library seeds back
 * from `npc-test-76b3b3` and `preflight-property-group`, because a seed has no
 * readable dependency facts and so waits behind every hole in front of it.
 *
 * ## What a listing means here
 *
 * A listed file is removed from the corpus before anything else looks at it.
 * It is never sent to a clone, never counted as a hole, never offered as a
 * repair or a dry run, and never listed as owed. The declaration is
 * authoritative: the prime says how to reverse one ("remove its entry in the
 * same pull request that records the decision, then apply the file"), and
 * until then a clone does not receive it even if the prime's ledger were to
 * record its version. That case is a contradiction for a person to settle,
 * and `withdrawnButRecorded` names it rather than resolving it either way.
 *
 * ## Reading is fail-safe towards the status quo
 *
 * Only a manifest read in full is acted on. A missing manifest, one that is
 * not JSON, one with a schema version this reader does not know, or one with
 * an entry that does not name a migration file all exclude NOTHING: Mission
 * Control then behaves exactly as it did before this module existed, and says
 * why. Excluding on a partial reading could stop a clone receiving a file the
 * prime ran, which is a silent divergence; excluding nothing costs, at worst,
 * the hole this module exists to close.
 *
 * Mission Control needs only each entry's `file`. The prime's own gate
 * (`scripts/security/check-migration-withdrawals.mjs`) validates the rest of
 * the entry, and restating those rules here would make two standards for one
 * document.
 *
 * Pure: no network, no database. The caller hands over the text it read.
 */

/** Where the prime keeps the declaration. Named once; the corpus reader uses it. */
export const WITHDRAWALS_PATH = "supabase/migrations/MIGRATION_WITHDRAWN.json";

/** A migration file name as the prime writes them: fourteen digits, a name, `.sql`. */
const MIGRATION_FILE = /^\d{14}_[^/\\]+\.sql$/;

export type WithdrawalReading =
  /** The prime's tree carries no manifest. Nothing is withdrawn. */
  | { state: "absent"; files: ReadonlySet<string> }
  /** Read in full. `files` is every file name the manifest lists. */
  | { state: "read"; files: ReadonlySet<string> }
  /** Present but not usable. `files` is EMPTY, and `why` says what was wrong. */
  | { state: "unreadable"; files: ReadonlySet<string>; why: string };

const NONE: ReadonlySet<string> = new Set<string>();

/** The reading for a manifest that exists but cannot be used. Excludes nothing. */
export function unreadableWithdrawals(why: string): WithdrawalReading {
  return { state: "unreadable", files: NONE, why };
}

/**
 * Parse the manifest text, or `null` when the tree carries no manifest.
 *
 * Never throws: a malformed manifest is a reading to report, not a crash that
 * would take the corpus (and every clone's delivery) down with it.
 */
export function readWithdrawalManifest(text: string | null): WithdrawalReading {
  if (text === null) return { state: "absent", files: NONE };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return unreadableWithdrawals(
      `MIGRATION_WITHDRAWN.json is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return unreadableWithdrawals("MIGRATION_WITHDRAWN.json is not a JSON object");
  }
  const { schema_version: version, withdrawn } = doc as {
    schema_version?: unknown;
    withdrawn?: unknown;
  };
  if (version !== 1) {
    return unreadableWithdrawals(
      `MIGRATION_WITHDRAWN.json declares schema_version ${JSON.stringify(version)}; this reader knows 1`,
    );
  }
  if (!Array.isArray(withdrawn)) {
    return unreadableWithdrawals('MIGRATION_WITHDRAWN.json has no "withdrawn" array');
  }
  const files = new Set<string>();
  for (const [i, entry] of withdrawn.entries()) {
    const file = (entry as { file?: unknown } | null)?.file;
    if (typeof file !== "string" || !MIGRATION_FILE.test(file)) {
      // One unreadable entry makes the whole declaration unreadable. Acting on
      // the entries that happen to parse would be acting on a document nobody
      // wrote.
      return unreadableWithdrawals(
        `MIGRATION_WITHDRAWN.json withdrawn[${i}] does not name a migration file (${JSON.stringify(file)})`,
      );
    }
    files.add(file);
  }
  return { state: "read", files };
}

/**
 * Split corpus entries into the ones a clone may be offered and the ones the
 * manifest withdraws. Matched by FILE NAME, never by version: a version can be
 * shared by two files (the prime's `20260724000000` is one withdrawn file and
 * one live one), and keying a withdrawal by version would withdraw both.
 *
 * `unmatched` is every listed name the corpus does not carry, reported rather
 * than ignored, because a declaration about a file that is not there is a
 * declaration nothing enforces.
 */
export function partitionWithdrawn<T extends { name: string }>(
  entries: readonly T[],
  reading: WithdrawalReading,
): { kept: T[]; withdrawn: T[]; unmatched: string[] } {
  if (reading.files.size === 0) return { kept: [...entries], withdrawn: [], unmatched: [] };
  const kept: T[] = [];
  const withdrawn: T[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (reading.files.has(e.name)) {
      withdrawn.push(e);
      seen.add(e.name);
    } else kept.push(e);
  }
  const unmatched = [...reading.files].filter((f) => !seen.has(f)).sort();
  return { kept, withdrawn, unmatched };
}

/**
 * Versions the prime's ledger records whose ONLY files are withdrawn.
 *
 * The declaration says the effect is absent; the ledger says it ran. One of
 * them is wrong, and which one is a person's call — the prime's drift check
 * measures the objects. Nothing here acts on the answer: a withdrawn file stays
 * excluded either way, because sending a withdrawn change to a tenant is the
 * harm that cannot be undone by a later correction.
 *
 * A version shared with a kept file is not reported: the ledger row can be the
 * kept file's.
 */
export function withdrawnButRecorded(
  withdrawn: ReadonlyArray<{ id: string; name: string }>,
  keptIds: ReadonlySet<string>,
  primeApplied: ReadonlySet<string>,
): Array<{ id: string; name: string }> {
  return withdrawn.filter((m) => primeApplied.has(m.id) && !keptIds.has(m.id));
}

/**
 * What an operator is told about the manifest, as sentences. One wording for
 * every surface that reads the corpus, so the health page and a sync report
 * cannot describe the same manifest two ways.
 *
 * Silent when there is nothing to say: no manifest, or a manifest that lists
 * nothing. An unreadable manifest is always said, because it is the one state
 * in which a withdrawn file quietly becomes a hole on every clone again.
 */
export function withdrawalNotes(report: {
  state: WithdrawalReading["state"];
  why?: string;
  excluded: ReadonlyArray<{ name: string }>;
  unmatched: readonly string[];
}): string[] {
  const notes: string[] = [];
  if (report.state === "unreadable") {
    notes.push(
      `The prime's ${WITHDRAWALS_PATH} could not be used (${report.why ?? "no reason was recorded"}), ` +
        `so nothing is treated as withdrawn: every file it lists is owed by every clone again, ` +
        `and waits as a hole, until the manifest reads.`,
    );
  }
  const n = report.excluded.length;
  if (n > 0) {
    notes.push(
      `${n} migration file${n === 1 ? " is" : "s are"} declared withdrawn in the prime's ` +
        `${WITHDRAWALS_PATH}, so ${n === 1 ? "it is" : "they are"} never sent to a clone, ` +
        `repaired or counted as owed: ${report.excluded.map((f) => f.name).join(", ")}.`,
    );
  }
  if (report.unmatched.length > 0) {
    notes.push(
      `${WITHDRAWALS_PATH} lists ${report.unmatched.length === 1 ? "a file" : "files"} the prime's ` +
        `tree does not carry, so the declaration is enforced on nothing: ` +
        `${report.unmatched.join(", ")}.`,
    );
  }
  return notes;
}

/**
 * The sentence an operator reads when they ask about a withdrawn version by
 * number — a diagnosis or a repair — instead of "no such migration".
 */
export function withdrawnVersionMessage(
  version: string,
  files: ReadonlyArray<{ name: string }>,
): string {
  const names = files.map((f) => f.name).join(" and ");
  return (
    `${names} ${files.length === 1 ? "is" : "are"} declared withdrawn in the prime's ` +
    `${WITHDRAWALS_PATH}: ${files.length === 1 ? "its" : "their"} effect is deliberately ` +
    `absent from every database, so Mission Control does not send, dry-run, repair or count ` +
    `version ${version} as owed. To reverse a withdrawal, remove its entry on the prime in the ` +
    `same pull request that records the decision.`
  );
}
