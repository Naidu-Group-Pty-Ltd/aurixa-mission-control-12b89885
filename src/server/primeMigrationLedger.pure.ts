/**
 * What the prime's repository holds in SQL, and what the prime has actually
 * run — the two halves, never collapsed.
 *
 * ## Why this belongs on the prime page
 *
 * The page's stated purpose is that faulty code must not reach the clones. On
 * the code half a bad commit travels IMMEDIATELY: a push fans out to every
 * clone with no check-run read anywhere on the path. On the migration half the
 * failure is the exact opposite and far quieter — **good SQL does not travel
 * at all**, and nothing on the prime says so.
 *
 * `scopeCorpusToPrime` is the rule: a clone is never sent a migration the
 * prime's own `supabase_migrations.schema_migrations` does not record. That
 * rule is right — it is what stopped two `rollback_*` scripts undoing an RLS
 * fix on a tenant — but the prime's `apply-migration.yml` is
 * `workflow_dispatch` on a named file, so its ledger records **what somebody
 * remembered to dispatch**, not what merged. A migration that lands on `main`
 * and is never dispatched holds every clone at the version before it, and
 * every migration after it too.
 *
 * Measured 19 September 2026: four migrations sat on prime's `main`
 * unrecorded, and two tenants had been held at `20261201100000` behind them.
 * The condition's only trace anywhere was free text in
 * `clone_backends.status_detail`, while both clones read `status: ready`.
 *
 * So the prime page shows the SQL ledger for the same reason it shows the
 * check runs: it is the state of the tree the whole fleet is copied from, and
 * a hole here is a hole in every clone.
 *
 * ## Two halves, two readings, two failures
 *
 * `PRIME_HAS_TWO_HALVES.md` records what it cost to conflate the prime's REPO
 * with the prime's BACKEND. The same split is structural here:
 *
 *   - the **corpus** is `supabase/migrations/*.sql` at prime's head, read from
 *     GitHub;
 *   - the **ledger** is `supabase_migrations.schema_migrations` on
 *     `prime_config.supabase_project_ref`, read over the Management API.
 *
 * Either can fail on its own, so each arrives as its own `LedgerHalf` and a
 * failure in one never produces a number about the other. A corpus read that
 * failed is not a repository with no migrations; a ledger read that failed is
 * not a prime that has run nothing. Both of those mistakes have a name in this
 * codebase and both of them are expensive.
 *
 * ## What it refuses to do
 *
 * It classifies and counts. It stamps nothing, sends nothing and recommends no
 * stamp — `buildPrimeLedgerReconciliation` is where object-level evidence
 * lives, and even that is evidence rather than permission. The remedy this
 * module names is always the same act and it is always on the prime: dispatch
 * the file, or decide it should not exist.
 */

import { scopeCorpusToPrime, type CorpusMeta, type WithheldEntry } from "./fleetCorpusScope.pure";
import type { SafetyTone } from "./primeHealth.pure";

/**
 * One half of the reading.
 *
 * `read: false` carries a reason and NO values. There is deliberately no
 * `versions: []` on the failure branch: a caller that destructures `versions`
 * off an unread half would be counting a fault as an empty repository, which
 * is the one mistake this shape exists to make impossible to write.
 */
export type LedgerHalf<T> = { read: true; entries: T[] } | { read: false; why: string };

export type PrimeLedgerStanding =
  /** Every migration on `main` is recorded as run. Nothing is held back. */
  | "aligned"
  /** The repo carries migrations the prime's ledger does not record. */
  | "holding"
  /** One half could not be read, so the comparison was never made. */
  | "unreadable";

/** Why one repo migration is not deliverable, in the operator's words. */
export type WithheldRow = {
  id: string;
  name: string;
  /** `never_applied` or `skew_suspected` — the scope's own vocabulary. */
  reason: WithheldEntry<CorpusMeta>["reason"];
  /** The nearest ledger version inside the skew window, when there is one. */
  nearestPrimeVersion: string | null;
  skewSeconds: number | null;
};

export type PrimeLedgerReading = {
  standing: PrimeLedgerStanding;
  /**
   * Computed here rather than on the page, for the reason the gate's tone is:
   * a route may not import this module for a value, so a tone derived in the
   * browser would be a second copy of this judgement.
   */
  tone: SafetyTone;
  /** One sentence. Never database vocabulary. */
  headline: string;
  /** The act that clears it, or null when nothing is owed. */
  remedy: string | null;

  /** Migration files on prime's default branch. Null when the corpus is unread. */
  corpusCount: number | null;
  /** Rows in the prime backend's ledger. Null when the ledger is unread. */
  ledgerCount: number | null;

  /** Repo migrations the prime has run — the set a clone may be sent. */
  runnableCount: number | null;
  /** Repo migrations it has not. The fleet's standing blocker. */
  withheldCount: number | null;
  neverApplied: number | null;
  skewSuspected: number | null;

  /**
   * The newest runnable version: the frontier every clone is measured against.
   *
   * Deliberately NOT the newest file in the repo. That expression is the fault
   * `migrationFrontier.pure.ts` was written to make unspellable — a recorded
   * position past the end of what actually happened, believed because nothing
   * compared it against the thing it describes.
   */
  frontier: string | null;

  /**
   * Ledger rows carrying a version no repo file has.
   *
   * Counted and never listed. On this prime it is 481 of 890 rows — Lovable
   * stamps its own apply timestamp, so the repo holds `20250912170521` where
   * the ledger holds `20250912050519`, twelve hours apart with no column
   * relating them. A list of 481 is noise; the COUNT is the thing worth
   * knowing, because it is why the ledger is a poor witness for the question
   * it is being asked.
   */
  unmatchedLedgerRows: number | null;

  /** The withheld set, newest first, capped. Empty when nothing is withheld. */
  withheld: WithheldRow[];
};

/**
 * How many withheld migrations the reading carries.
 *
 * The count is always exact; this bounds only the list. Newest first, because
 * the recent gap is what holds clones today — an old withheld rollback script
 * is withheld correctly and for ever, and reading it first buries the four
 * that matter.
 */
export const WITHHELD_ROWS = 25;

function unreadable(why: string): PrimeLedgerReading {
  return {
    standing: "unreadable",
    tone: "idle",
    headline: why,
    // No remedy. "We could not check" names no act, and inventing one here
    // would send an operator to dispatch a file nobody has established is
    // owed.
    remedy: null,
    corpusCount: null,
    ledgerCount: null,
    runnableCount: null,
    withheldCount: null,
    neverApplied: null,
    skewSuspected: null,
    frontier: null,
    unmatchedLedgerRows: null,
    withheld: [],
  };
}

/**
 * The reading, and the set the clone comparison measures against.
 *
 * They are one return value because they are one computation. Splitting them
 * into two exported functions would mean scoping the corpus twice and, worse,
 * would admit a caller that took the frontier from one and the runnable set
 * from another — two answers to one question, which is how they come to
 * disagree.
 *
 * `runnableVersions` deliberately does NOT ride the `PrimeLedgerReading` that
 * reaches the browser: it is ~900 version strings on this prime, and the page
 * draws counts. The comparison needs it server-side and nothing else does.
 */
export type PrimeLedgerAssessment = {
  reading: PrimeLedgerReading;
  /**
   * Every version the prime has run and the repo still carries, ascending.
   * Null exactly when the comparison could not be made.
   */
  runnableVersions: string[] | null;
};

/**
 * Compare the prime's repository against the prime's own ledger.
 *
 * `corpus` entries are `{ id, name }` in corpus (ascending version) order,
 * exactly as `openPrimeMigrationCorpus` yields them. `ledger` entries are the
 * raw `version` strings the prime's `schema_migrations` reports.
 */
export function assessPrimeMigrationLedger(args: {
  corpus: LedgerHalf<CorpusMeta>;
  ledger: LedgerHalf<string>;
}): PrimeLedgerAssessment {
  if (!args.corpus.read) {
    return {
      reading: unreadable(`The prime's migration files could not be read: ${args.corpus.why}`),
      runnableVersions: null,
    };
  }
  if (!args.ledger.read) {
    return {
      reading: unreadable(`The prime's migration ledger could not be read: ${args.ledger.why}`),
      runnableVersions: null,
    };
  }

  const corpus = args.corpus.entries;
  const applied = new Set(args.ledger.entries);

  /*
    An empty ledger is unreadable rather than aligned.

    `assertPrimeLedgerUsable` refuses a sync on exactly this reading, and for
    the same reason it must not render as a clean bill of health here: with no
    authority for what the prime has run, every repo file — rollback scripts
    and future-dated work included — would qualify. A page that said "aligned"
    over it would be agreeing with the one state the fleet lane refuses to act
    on.
  */
  if (applied.size === 0) {
    return {
      reading: unreadable(
        "The prime backend reports no applied migrations. That is not a prime that has run " +
          "nothing — it is a reading with no authority behind it, and the fleet sync refuses " +
          "to act on it for the same reason.",
      ),
      runnableVersions: null,
    };
  }

  const scope = scopeCorpusToPrime(corpus, applied);

  const corpusVersions = new Set(corpus.map((m) => m.id));
  const unmatchedLedgerRows = [...applied].filter((v) => !corpusVersions.has(v)).length;

  // The scope preserves corpus order, so the last runnable entry is the newest
  // version the prime both HAS and has RUN.
  const frontier = scope.runnable.length > 0 ? scope.runnable[scope.runnable.length - 1].id : null;

  const withheld: WithheldRow[] = [...scope.withheld]
    .reverse()
    .slice(0, WITHHELD_ROWS)
    .map((w) => ({
      id: w.meta.id,
      name: w.meta.name,
      reason: w.reason,
      nearestPrimeVersion: w.nearestPrimeVersion ?? null,
      skewSeconds: typeof w.skewSeconds === "number" ? w.skewSeconds : null,
    }));

  const counts = {
    corpusCount: corpus.length,
    ledgerCount: applied.size,
    runnableCount: scope.runnable.length,
    withheldCount: scope.withheld.length,
    neverApplied: scope.breakdown.neverApplied,
    skewSuspected: scope.breakdown.skewSuspected,
    frontier,
    unmatchedLedgerRows,
  };

  const runnableVersions = scope.runnable.map((m) => m.id);

  if (scope.withheld.length === 0) {
    return {
      runnableVersions,
      reading: {
        standing: "aligned",
        tone: "ok",
        headline:
          `Every one of the ${corpus.length} migrations on this branch is recorded as run on the ` +
          "prime, so nothing in the repository is holding a clone back.",
        remedy: null,
        ...counts,
        withheld: [],
      },
    };
  }

  /*
    `skew_suspected` is a HYPOTHESIS and never a clearance.

    A ledger row within ten seconds of the repo version is consistent with
    Lovable stamping its apply time rather than the filename — but two
    genuinely different migrations authored seconds apart look identical to
    that test. So a skew suspicion is reported beside the count and never
    subtracted from it: the headline states what is withheld, and the
    breakdown says how much of it might be bookkeeping.
  */
  const n = scope.withheld.length;
  const newest = withheld[0];
  return {
    runnableVersions,
    reading: {
      standing: "holding",
      tone: "warn",
      headline:
        `${n} migration${n === 1 ? "" : "s"} on this branch ${n === 1 ? "is" : "are"} absent from the ` +
        `prime's own ledger, so no clone may run ${n === 1 ? "it" : "them"} — or anything after ` +
        `${n === 1 ? "it" : "them"}` +
        (newest ? `. The newest is ${newest.name}` : "") +
        ".",
      remedy:
        "The act is on the prime and it is a person's: dispatch the file there, or decide it " +
        "should not exist. Nothing in this console can apply DDL to the prime, and stamping its " +
        "ledger instead would send clones a migration whose prerequisite does not exist. " +
        "Whether the prime ran one of these untracked is a separate reading, against its " +
        "catalogue rather than its ledger — Fleet Manager → Prime Ledger Reconciliation.",
      ...counts,
      withheld,
    },
  };
}

/**
 * Is this reading safe to measure a clone against?
 *
 * The comparison quotes `frontier` at an operator as "the version every clone
 * should hold". That sentence is only true when the comparison was actually
 * made, so a caller asks here rather than testing `frontier !== null` — which
 * is also true of an aligned prime whose repo has no migrations at all, and
 * would quietly compare every clone against nothing.
 */
export function frontierIsEstablished(reading: PrimeLedgerReading): boolean {
  return reading.standing !== "unreadable" && reading.frontier !== null;
}
