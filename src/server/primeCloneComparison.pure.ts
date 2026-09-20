/**
 * One clone, held against the prime — and the question this page exists to
 * ask about it: **is the prime the reason it is stuck?**
 *
 * ## Why the comparison is here and not on the clone's own page
 *
 * The convergence card on a clone answers "is this clone healthy". It is the
 * right question there and it is the wrong one here. This page is the source
 * of the fleet, so the question it owes an operator is the inverse: of
 * everything wrong with this clone, how much of it did the prime cause, and
 * how much would survive a perfect prime?
 *
 * Nothing answered that. `clone_sync_blockages` already carries an OWNER on
 * every row — `blockageTaxonomy.pure.ts` declares it once and calls it "the
 * field everything else turns on" — but no surface has ever grouped by it. An
 * operator looking at six open blockages had six sentences and no way to see
 * that two of them were theirs to fix on the prime and four were the
 * machinery's.
 *
 * ## The side is DERIVED, never listed
 *
 * `sideOfBlockage` reads `BLOCKAGE_POLICY[cls].owner`. It does not carry its
 * own list of prime-side classes, because a second list is how the two come to
 * disagree — and the disagreement would be silent, since a class missing from
 * a hand-written list simply lands on the other side and looks deliberate.
 * Adding a `prime_author` class to the taxonomy therefore puts it on the prime
 * side here with no edit, and a test asserts the derivation rather than the
 * strings it currently produces.
 *
 * The one class named explicitly is `prime_ledger_hole`, and the comment at
 * its declaration says why: its owner is `operator`, because clearing it is a
 * person's decision — but the person is standing at the PRIME, dispatching a
 * migration there. By owner alone it would file as the clone's problem, which
 * is precisely backwards for a condition the prime caused and only the prime
 * can clear.
 *
 * ## Three rules
 *
 * **A read that failed is `null`, never `[]`.** "Nothing is blocking this
 * clone" is a claim, and a query that did not answer cannot make it. Every
 * absent reading here carries its reason instead.
 *
 * **Every number names its basis.** `commits_behind` and `migration_version`
 * are Mission Control's own records of a pass, not readings of the clone.
 * `cloneMigrationStanding.pure.ts`'s entire header is the bill for treating a
 * cursor as a ledger — it offered "5 PENDING" where two were already applied
 * and one could never be sent. So the comparison labels a stored cursor as a
 * stored cursor and never as the clone's position.
 *
 * **A cursor ahead of the prime is a finding, not a pass.** A clone recorded
 * past the prime's own frontier is the fault `migrationFrontier.pure.ts`
 * exists to make unspellable: a position past the end of what happened, which
 * makes `corpus − frontier` skip real migrations for ever. It reads `ahead`
 * and it is drawn as a problem, because the direction that loses data
 * silently must never render as the direction that is fine.
 */

import {
  BLOCKAGE_POLICY,
  type BlockageClass,
  type BlockageOwner,
} from "./cascade/blockageTaxonomy.pure";
import type { SafetyTone } from "./primeHealth.pure";

/** Who has to act: the prime's author, or this clone's own machinery. */
export type BlockerSide = "prime" | "clone";

/**
 * Classes whose remedy is an act performed ON THE PRIME even though the
 * taxonomy files their owner elsewhere.
 *
 * Exactly one member, and it is named rather than inferred because the reason
 * is not in the policy table: `prime_ledger_hole` is `operator`-owned because
 * a person decides, and the person is at the prime. See the header.
 */
const PRIME_SIDE_BY_REMEDY: ReadonlySet<BlockageClass> = new Set<BlockageClass>([
  "prime_ledger_hole",
]);

/**
 * Which side of the copy this blockage lives on.
 *
 * `prime_author` is the taxonomy's own word for "prime shipped something the
 * clone's checks refuse", so it is read straight off the policy rather than
 * restated.
 */
export function sideOfBlockage(cls: BlockageClass): BlockerSide {
  const policy = BLOCKAGE_POLICY[cls];
  // An unknown class is the clone's until somebody classifies it. Claiming a
  // condition nobody has named is the prime's fault would put a finding on
  // this page that no act here can discharge.
  if (!policy) return "clone";
  if (policy.owner === "prime_author") return "prime";
  return PRIME_SIDE_BY_REMEDY.has(cls) ? "prime" : "clone";
}

export type ComparedBlocker = {
  id: string;
  cls: BlockageClass;
  owner: BlockageOwner;
  side: BlockerSide;
  selfHeals: boolean;
  /** The taxonomy's standing sentence for the class. */
  what: string;
  /** This occurrence's own sentence, naming the specific thing. */
  detail: string;
  firstSeenAt: string;
};

/** The raw row, as `clone_sync_blockages` stores it. */
export type BlockageRow = {
  id: string;
  class: string;
  owner: string;
  detail: string;
  first_seen_at: string;
  self_heals: boolean;
};

export function compareBlockers(rows: readonly BlockageRow[]): ComparedBlocker[] {
  return rows.map((row) => {
    const cls = row.class as BlockageClass;
    const policy = BLOCKAGE_POLICY[cls];
    return {
      id: row.id,
      cls,
      owner: (policy?.owner ?? row.owner) as BlockageOwner,
      side: sideOfBlockage(cls),
      selfHeals: policy ? policy.selfHeals : row.self_heals,
      /*
        A class this build has never heard of falls back to the row's own
        detail rather than to an empty string or a placeholder. The row was
        written by a classifier that DID know the class, so its sentence is
        the best description available — and a blank line beside a live
        blockage reads as a broken page.
      */
      what: policy?.what ?? row.detail,
      detail: row.detail,
      firstSeenAt: row.first_seen_at,
    };
  });
}

/* ───────────────────────────── the code half ───────────────────────────── */

export type CodeStanding =
  /** The clone's recorded sync SHA is the prime's current head. */
  | "carrying"
  /** It is an earlier commit. */
  | "behind"
  /** Mission Control has never recorded a synced commit for this clone. */
  | "never_synced"
  /** The prime's head could not be read, so there is nothing to compare to. */
  | "unknown";

export type CodeReading = {
  standing: CodeStanding;
  tone: SafetyTone;
  /** The clone's last recorded sync commit, as Mission Control stores it. */
  syncedSha: string | null;
  /** Mission Control's own count, which is a record of a pass. */
  commitsBehind: number | null;
  sentence: string;
};

/** `YYYYMMDDHHMMSS` — the only shape two migration versions can be ordered in. */
const VERSION_SHAPE = /^\d{14}$/;

/** Prefix match, minimum seven characters — the same rule the commit ledger uses. */
function sameCommit(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length);
  if (n < 7) return false;
  return a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

export function readCodeStanding(args: {
  primeHeadSha: string | null;
  syncedSha: string | null;
  commitsBehind: number | null;
  label: string;
}): CodeReading {
  const { primeHeadSha, syncedSha, commitsBehind, label } = args;

  if (!primeHeadSha) {
    return {
      standing: "unknown",
      tone: "idle",
      syncedSha,
      commitsBehind,
      sentence:
        "The prime's head could not be read on this pass, so there is nothing to hold this clone against.",
    };
  }
  if (!syncedSha) {
    return {
      standing: "never_synced",
      tone: "warn",
      syncedSha: null,
      commitsBehind,
      sentence: `Mission Control has no record of a commit ever being synced to ${label}.`,
    };
  }
  if (sameCommit(primeHeadSha, syncedSha)) {
    return {
      standing: "carrying",
      tone: "ok",
      syncedSha,
      commitsBehind,
      sentence: `${label} is recorded as carrying the prime's current head.`,
    };
  }
  return {
    standing: "behind",
    tone: "warn",
    syncedSha,
    commitsBehind,
    sentence:
      `${label} last synced ${syncedSha.slice(0, 7)}, which is not the prime's head` +
      (typeof commitsBehind === "number" && commitsBehind > 0
        ? ` — Mission Control records it ${commitsBehind} commit${commitsBehind === 1 ? "" : "s"} behind.`
        : "."),
  };
}

/* ────────────────────────── the migration half ────────────────────────── */

export type MigrationStanding =
  /** The clone's recorded version is the prime's deliverable frontier. */
  | "at_frontier"
  /** It is an earlier version. */
  | "behind"
  /**
   * It is LATER than anything the prime has run. See the header: this is the
   * direction that loses migrations silently, so it is never "fine".
   */
  | "ahead"
  /** No version recorded, or no frontier to compare against. */
  | "unknown";

export type MigrationReading = {
  standing: MigrationStanding;
  tone: SafetyTone;
  /** `clone_backends.migration_version` — a cursor, not the clone's ledger. */
  recordedVersion: string | null;
  frontier: string | null;
  /** Runnable prime versions above the clone's cursor. Null when unknown. */
  owed: number | null;
  sentence: string;
  /** Present only where the clone's own pass recorded a reason it stopped. */
  blockedReason: string | null;
};

export function readMigrationStanding(args: {
  frontier: string | null;
  /** Every runnable version, ascending. Empty or absent means: cannot count. */
  runnableVersions: readonly string[] | null;
  recordedVersion: string | null;
  blockedReason: string | null;
  label: string;
}): MigrationReading {
  const { frontier, runnableVersions, recordedVersion, blockedReason, label } = args;

  const base = { frontier, recordedVersion, blockedReason };

  if (!frontier) {
    return {
      ...base,
      standing: "unknown",
      tone: "idle",
      owed: null,
      sentence:
        "The prime's deliverable frontier was not established on this pass, so there is no version to hold this clone against.",
    };
  }
  if (!recordedVersion) {
    return {
      ...base,
      standing: "unknown",
      tone: "warn",
      owed: null,
      sentence:
        `Mission Control records no migration version for ${label}. That is not an empty ledger — ` +
        "it is an absent record, and the two are only the same if somebody has checked.",
    };
  }

  /*
    A COMPARISON IS ONLY MEANINGFUL BETWEEN TWO VERSIONS OF THE SAME SHAPE.

    Versions are fixed-width `YYYYMMDDHHMMSS`, so between two of those a string
    comparison IS an ordering comparison — which is why nothing here parses
    them to numbers, and why the prime keeps a frozen inventory of colliding
    versions rather than normalising the format away.

    A cursor that is not that shape cannot be ordered against one that is.
    Lexicographically `"9"` sorts above `"20261204010000"`, so a malformed
    value would read as `ahead` — the loudest verdict this module has, about a
    clone whose position is simply unknown. `migrationEpochSeconds` answers
    null for the same class of input for the same reason: an id this cannot
    parse is one the test has no opinion about.
  */
  if (!VERSION_SHAPE.test(recordedVersion) || !VERSION_SHAPE.test(frontier)) {
    return {
      ...base,
      standing: "unknown",
      tone: "warn",
      owed: null,
      sentence:
        `${label} records its migration position as ${recordedVersion}, which is not a version ` +
        "this can order against the prime's. Nothing is claimed about how far behind it is.",
    };
  }

  if (recordedVersion > frontier) {
    return {
      ...base,
      standing: "ahead",
      tone: "bad",
      owed: null,
      sentence:
        `${label} is recorded at ${recordedVersion}, which is LATER than anything the prime has ` +
        `run (${frontier}). A frontier past the truth is the one direction that loses data ` +
        "silently: the next sync computes what is owed from this number, so every version " +
        "between the two is skipped as applied and nothing will offer them again.",
    };
  }

  const owed =
    runnableVersions === null ? null : runnableVersions.filter((v) => v > recordedVersion).length;

  if (recordedVersion === frontier) {
    return {
      ...base,
      standing: "at_frontier",
      tone: "ok",
      owed: owed ?? 0,
      sentence: `${label} is recorded at the prime's own frontier, ${frontier}.`,
    };
  }

  return {
    ...base,
    standing: "behind",
    tone: "warn",
    owed,
    sentence:
      `${label} is recorded at ${recordedVersion} against the prime's frontier of ${frontier}` +
      (typeof owed === "number"
        ? ` — ${owed} runnable migration${owed === 1 ? "" : "s"} above it.`
        : "."),
  };
}

/* ──────────────────────────── the whole reading ──────────────────────────── */

export type ComparisonVerdict =
  /** Carrying prime's head, at its frontier, nothing open. */
  | "converged"
  /** Open blockages the prime caused. */
  | "prime_blocked"
  /** Open blockages, none of them the prime's. */
  | "clone_blocked"
  /** No blockages, but behind on code or migrations. */
  | "lagging"
  /** Something material could not be read. */
  | "unreadable";

export type CloneComparison = {
  cloneId: string;
  label: string;
  repoFullName: string | null;
  syncScope: string | null;
  verdict: ComparisonVerdict;
  tone: SafetyTone;
  headline: string;
  code: CodeReading;
  migrations: MigrationReading;
  /**
   * Open blockages, or null when the ledger could not be read — which is not
   * the same as none, and is not drawn as none.
   */
  blockers: ComparedBlocker[] | null;
  /** Why the blockage read produced nothing. Null when it produced rows. */
  blockersError: string | null;
  primeSide: number | null;
  cloneSide: number | null;
};

export function buildCloneComparison(args: {
  cloneId: string;
  label: string;
  repoFullName: string | null;
  syncScope: string | null;
  code: CodeReading;
  migrations: MigrationReading;
  blockers: ComparedBlocker[] | null;
  blockersError: string | null;
}): CloneComparison {
  const { code, migrations, blockers } = args;

  const primeSide = blockers ? blockers.filter((b) => b.side === "prime").length : null;
  const cloneSide = blockers ? blockers.filter((b) => b.side === "clone").length : null;

  const base = { ...args, primeSide, cloneSide };

  /*
    ORDER MATTERS, AND IT IS NOT SEVERITY ORDER.

    An unread blockage ledger comes FIRST, ahead of every reading below it,
    because each of those would otherwise render a clean verdict built on a
    question nobody asked. A clone carrying prime's head at prime's frontier
    with an unreadable blockage table is not converged; it is a clone we
    cannot describe.
  */
  if (blockers === null) {
    return {
      ...base,
      verdict: "unreadable",
      tone: "idle",
      headline:
        "This clone's blockage ledger could not be read, so nothing here can say whether it is blocked.",
    };
  }

  if (primeSide && primeSide > 0) {
    return {
      ...base,
      verdict: "prime_blocked",
      tone: "bad",
      headline:
        `${primeSide} of this clone's ${blockers.length} open blockage${blockers.length === 1 ? "" : "s"} ` +
        `${primeSide === 1 ? "is" : "are"} the prime's: the act that clears ${primeSide === 1 ? "it" : "them"} ` +
        "happens on the source, not here.",
    };
  }

  if (blockers.length > 0) {
    return {
      ...base,
      verdict: "clone_blocked",
      tone: "warn",
      headline:
        `${blockers.length} open blockage${blockers.length === 1 ? "" : "s"}, none of them the prime's — ` +
        "this clone is held by its own machinery or by a decision owed here.",
    };
  }

  if (code.standing === "unknown" || migrations.standing === "unknown") {
    return {
      ...base,
      verdict: "unreadable",
      tone: "idle",
      headline:
        "Nothing is blocking this clone, and one half of the comparison could not be made — so it is not yet safe to call it converged.",
    };
  }

  if (migrations.standing === "ahead") {
    return {
      ...base,
      verdict: "clone_blocked",
      tone: "bad",
      headline:
        "Nothing is blocking this clone, and its recorded migration version is past anything the prime has run — which is worse than being behind.",
    };
  }

  if (code.standing !== "carrying" || migrations.standing !== "at_frontier") {
    return {
      ...base,
      verdict: "lagging",
      tone: "warn",
      headline:
        "Nothing is blocking this clone; it simply has not caught up to the prime yet. A cascade or a migration pass will move it.",
    };
  }

  return {
    ...base,
    verdict: "converged",
    tone: "ok",
    headline: "This clone carries the prime's head, sits at its frontier, and has nothing open.",
  };
}
