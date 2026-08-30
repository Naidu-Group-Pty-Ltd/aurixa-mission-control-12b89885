/**
 * The held-file gap nobody is standing in front of.
 *
 * ## What this is for
 *
 * `findMissingHeldReferences` answers a real question — "what does prime's copy
 * of this held file use, from a module this cascade delivers, that the clone's
 * copy does not?" — and it answers it *during a cascade*, about the files that
 * cascade touches. That is the right moment to ask, and it is not the only one.
 *
 * A held file that drifted last month, on a module no cascade has touched
 * since, is invisible to it. The guard never runs, because the module is not in
 * this run's delivery; the gap does not fail a build, because an import that is
 * simply absent compiles perfectly; and the clone quietly does not have the
 * feature. That is how `src/App.tsx` came to be missing two AUSTRAC routes on a
 * clone whose CI was green — found only because a source test happened to
 * assert them, which is not a mechanism, it is luck.
 *
 * So this module carries what a periodic sweep needs and the cascade did not:
 * how to find the gaps without a cascade to hang them on, how to decide whether
 * what it found is NEWS, and how to spend as few GitHub calls as possible doing
 * it.
 *
 * ## The three rules
 *
 * **The clone's own tree decides what exists.** `planHeldFileDrift` resolves
 * prime's import specifiers against the paths the CLONE actually has, and a
 * module the clone does not have at all is not a finding. That is ordinary
 * cascade lag — the module is on its way, and when it lands the cascade's own
 * guard will fire. Reporting it here would turn every in-flight cascade into an
 * operator notification.
 *
 * **A standing finding is not news.** The sweep runs on a schedule and a gap
 * persists until a person edits a file the platform is forbidden to write. A
 * notification per hour for the same unfixed thing is how a notification list
 * stops being read, so `decideDriftReport` compares a fingerprint of the whole
 * finding set against what was last observed and is silent when they match.
 * The fingerprint is ORDER-INDEPENDENT: reordering the imports in prime's file
 * is not a new gap.
 *
 * **The plan decides what to FETCH; it never decides what to REPORT.** Every
 * finding this sweep announces comes back out of `findMissingHeldReferences`,
 * the same function the cascade uses, over the content actually fetched. The
 * plan below is a cheaper pre-filter that exists only so a held file importing
 * from forty modules costs one blob read instead of forty. Two implementations
 * of "what is missing" is how they come to disagree.
 *
 * Client-safe: pure, and imports only the sibling parser.
 */
import {
  type MissingHeldReference,
  namedImportsOf,
  resolveSpecifier,
} from "./heldFileStaleness.pure";

/**
 * One module worth fetching, because prime's held file takes something from it
 * that the clone's held file does not.
 */
export type DriftFetchPlan = {
  /** The held file, e.g. `src/App.tsx`. */
  heldPath: string;
  /** The path IN THE CLONE'S TREE that would have to provide these symbols. */
  target: string;
  /** Symbols prime's copy imports from it and the clone's copy does not. */
  symbols: string[];
};

/**
 * Which of the modules prime's held file imports from are worth reading out of
 * the clone, to decide whether the clone's held file is behind.
 *
 * `clonePaths` is the clone's own file list — from one tree read, not one
 * request per candidate extension. It does two jobs: it says which of
 * `resolveSpecifier`'s candidates is the real file, and it says when there is
 * no real file, which is the case this sweep deliberately stays quiet about.
 *
 * The symbol comparison here is the same shape as the one in
 * `findMissingHeldReferences` and deliberately errs the same way: every
 * candidate path of a CLONE-side import is recorded as satisfied, so an
 * unresolvable specifier on the clone's side suppresses a claim rather than
 * inventing one.
 */
export function planHeldFileDrift(input: {
  heldPath: string;
  /** The held file as PRIME has it — the copy the cascade declines to write. */
  primeSource: string;
  /** The held file as the CLONE keeps it. */
  cloneSource: string;
  /** Every path in the clone's tree. */
  clonePaths: ReadonlySet<string>;
}): DriftFetchPlan[] {
  const { heldPath, primeSource, cloneSource, clonePaths } = input;

  // What the clone's copy already takes, keyed by module-plus-symbol. Recorded
  // against EVERY candidate path so an import we cannot resolve counts as
  // satisfied — the safe direction, because the cost of a false silence is a
  // gap found on the next run and the cost of a false claim is an operator
  // sent to fix nothing.
  const cloneHas = new Set<string>();
  for (const imp of namedImportsOf(cloneSource)) {
    for (const target of resolveSpecifier(heldPath, imp.specifier)) {
      for (const name of imp.names) cloneHas.add(`${target} ${name}`);
    }
  }

  const byTarget = new Map<string, string[]>();
  for (const imp of namedImportsOf(primeSource)) {
    // The module has to be one the clone actually holds. If it is not, the
    // clone is behind on the MODULE, which is a cascade's job and not a held
    // file's — see the header.
    const target = resolveSpecifier(heldPath, imp.specifier).find((c) => clonePaths.has(c));
    if (!target) continue;

    const missing = imp.names.filter((n) => !cloneHas.has(`${target} ${n}`));
    if (missing.length === 0) continue;

    const already = byTarget.get(target);
    if (already) {
      for (const n of missing) if (!already.includes(n)) already.push(n);
    } else {
      byTarget.set(target, [...missing]);
    }
  }

  return [...byTarget].map(([target, symbols]) => ({ heldPath, target, symbols }));
}

/**
 * A stable identity for a whole set of findings, so "same gap as last time" is
 * a comparison rather than a judgement.
 *
 * Sorted at both levels on purpose. Two runs over an unchanged pair of files
 * would produce the same order anyway; sorting is what makes a harmless
 * reordering of imports in prime's file not read as a new gap.
 *
 * An empty set fingerprints as the empty string, which is what makes
 * "everything is reconciled" a state the caller can compare against rather than
 * an absence it has to special-case.
 */
export function driftFingerprint(refs: readonly MissingHeldReference[]): string {
  return refs
    .map((r) => `${r.heldPath}>${r.cascadedPath}:${[...r.missing].sort().join(",")}`)
    .sort()
    .join("|");
}

export type DriftReportDecision = {
  /** The fingerprint of what was just observed. Store it with the record. */
  fingerprint: string;
  /** Write the observation down — what this clone owes has changed. */
  record: boolean;
  /** Tell an operator: there is something for a person to do. */
  notify: boolean;
};

/**
 * Whether this run's findings are worth writing down, and worth interrupting
 * somebody for.
 *
 * `previous` is the fingerprint recorded the last time this clone's state
 * changed — `null` when it has never been swept. Comparing against the last
 * OBSERVED state rather than the last ANNOUNCED one is what makes a regression
 * audible: a gap that appeared, was fixed, and came back has a recorded
 * clearance in between, so it is a change again and it is announced again.
 *
 * Nothing is recorded for a clean clone that was already clean, which is almost
 * every clone on almost every run.
 */
export function decideDriftReport(input: {
  previous: string | null;
  findings: readonly MissingHeldReference[];
}): DriftReportDecision {
  const fingerprint = driftFingerprint(input.findings);
  const record = fingerprint !== (input.previous ?? "");
  return {
    fingerprint,
    record,
    // A clearance is worth recording and is not worth a notification: the
    // person who fixed it knows, and the gap it closed was announced when it
    // opened.
    notify: record && fingerprint !== "",
  };
}
