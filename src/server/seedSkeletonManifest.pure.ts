/**
 * The skeletons of the prime's largest migrations, as the prime publishes them
 * in `supabase/migration-seed-skeletons.json`: every statement a seed's rows
 * are poured into, with the rows left out, pinned to the git blob they were
 * read from.
 *
 * ## Why Mission Control reads it
 *
 * The fleet sync decides what a clone may be sent from what each migration
 * CREATES, REQUIRES and NAMES, and it reads bodies for that only under
 * `MAX_DIGEST_BYTES` (256 KiB): the pass covers the whole corpus every tick.
 * The template-library seeds are ~40 MB each, so for every one of them it knew
 * nothing — and a migration nobody read may create anything, so a seed that is
 * not sent is an OPAQUE barrier and holds every migration after it. Measured
 * 23 Sep 2026 against the prime at 322633eda and the four clones' ledgers read
 * that day: the client dashboard, NPC Test, Preflight and the CRM were sent 1,
 * 3, 3 and 1 versions, each held at the first seed it lacked. With the seeds'
 * statements read, the same ledgers are sent 5, 7, 7 and 25 — and 11, 13, 13
 * and 31 once the prime's ledger records 20261219000000–050000, which without
 * this stay held behind the seeds at 1, 3, 3 and 1. No refresh goes ahead of
 * its seed in any of them.
 *
 * The rows are data. The statements are a few tens of kilobytes, and the
 * prime — which holds the files — can read them cheaply. It publishes them,
 * and this reads them.
 *
 * ## Why the skeleton's facts are the body's facts
 *
 * Measured over all eighteen seeds on 23 Sep 2026: `dependencyFactsOf` gives
 * the SAME creates and requires for the skeleton as for the whole 40 MB body,
 * on every one. `mentionedVersionsOf` gives fewer, and the difference is
 * float artefacts inside the rows' JSON (`0.05000000000007` reads as the
 * fourteen digits `05000000000007`) that name no version in the corpus. The
 * skeleton is the more exact of the two readings.
 *
 * ## Why an entry is used only against its own bytes
 *
 * Every entry carries the git blob id of the file it describes. An entry is
 * used only where that id is the one this corpus's own listing reports for
 * the file — so a seed re-released without the manifest being regenerated has
 * no skeleton here and is read as unread again, which is the behaviour it had
 * before this existed. The prime's CI fails on a stale manifest; the pin is
 * what makes a stale one harmless where CI was not asked.
 *
 * ## Reading is fail-safe towards the status quo
 *
 * Only a manifest read in full is used. A missing manifest, one that is not
 * JSON, one with a schema version this reader does not know, or one with an
 * entry that is not a path, a blob id and a skeleton of the seed shape yields
 * NO skeletons: every large file is then read as unread, exactly as before, and
 * the reading says why. A partial document is not acted on, for the reason
 * `migrationWithdrawals.pure.ts` gives: acting on the entries that happen to
 * parse is acting on a document nobody wrote.
 *
 * The prime publishes the TEXT and not the facts on purpose. The facts are read
 * out of it here, by the extractor that reads every other body, so one reader
 * decides what Mission Control believes.
 *
 * Pure: no network, no database. The caller hands over the text it read.
 */

import { dependencyFactsOf, type MigrationDependencyFacts } from "./migrationDependencyFacts.pure";
import { mentionedVersionsOf } from "./migrationVersionMentions.pure";
import { SEED_ROWS_MARKER } from "./seedChunking.pure";

/** Where the prime publishes the skeletons. Named once; the corpus reader uses it. */
export const SEED_SKELETONS_PATH = "supabase/migration-seed-skeletons.json";

/** A migration file's path as the prime's tree lists it. */
const MIGRATION_PATH = /^supabase\/migrations\/\d{14}_[^/\\]+\.sql$/;

/** A git blob id: forty lowercase hex digits, as a tree listing reports it. */
const BLOB_ID = /^[0-9a-f]{40}$/;

/** One seed the prime described, as it described it. */
export type SeedSkeletonEntry = {
  readonly path: string;
  /** The git blob id of the bytes the skeleton was read from. */
  readonly blob: string;
  readonly skeleton: string;
};

export type SeedSkeletonReading =
  /** The prime's tree carries no manifest. No large file has facts. */
  | {
      state: "absent";
      entries: ReadonlyMap<string, SeedSkeletonEntry>;
      refused: readonly string[];
    }
  /**
   * Read in full. `entries` is keyed by path; `refused` is every file the
   * prime found past its threshold and could not describe, by path.
   */
  | {
      state: "read";
      entries: ReadonlyMap<string, SeedSkeletonEntry>;
      refused: readonly string[];
    }
  /** Present but not usable. Nothing in it is used, and `why` says what was wrong. */
  | {
      state: "unreadable";
      entries: ReadonlyMap<string, SeedSkeletonEntry>;
      refused: readonly string[];
      why: string;
    };

const NO_ENTRIES: ReadonlyMap<string, SeedSkeletonEntry> = new Map();

/** The reading for a manifest that exists but cannot be used. Uses nothing. */
export function unreadableSeedSkeletons(why: string): SeedSkeletonReading {
  return { state: "unreadable", entries: NO_ENTRIES, refused: [], why };
}

/**
 * Why `text` is not a seed skeleton, or null when it is one.
 *
 * The shape the prime's join produces and nothing looser: one row marker, the
 * line `VALUES` directly above it, an `INSERT INTO` somewhere above that, and
 * the `ON CONFLICT` clause that ended the rows directly below it. A skeleton
 * that fails this was not produced by that join — cut short, hand-edited or
 * from a reader that has drifted — and facts read from it would be read from
 * text nobody vouches for.
 */
export function skeletonShapeProblem(text: string): string | null {
  const lines = text.split("\n");
  const at = lines.indexOf(SEED_ROWS_MARKER);
  if (at === -1) return "carries no row marker";
  if (lines.indexOf(SEED_ROWS_MARKER, at + 1) !== -1) return "carries more than one row marker";
  if (lines[at - 1] !== "VALUES") return "does not open its rows with a VALUES line";
  if (!/INSERT INTO\s+/i.test(lines.slice(0, at).join("\n"))) {
    return "names no INSERT INTO before its rows";
  }
  if (!(lines[at + 1] ?? "").startsWith("ON CONFLICT ")) {
    return "does not close its rows with an ON CONFLICT clause";
  }
  return null;
}

/**
 * Parse the manifest text, or `null` when the tree carries no manifest.
 *
 * Never throws: a malformed manifest is a reading to report, not a crash that
 * would take the corpus (and every clone's delivery) down with it.
 */
export function readSeedSkeletonManifest(text: string | null): SeedSkeletonReading {
  if (text === null) return { state: "absent", entries: NO_ENTRIES, refused: [] };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return unreadableSeedSkeletons(
      `it is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return unreadableSeedSkeletons("it is not a JSON object");
  }
  const {
    schema_version: version,
    skeletons,
    refused,
  } = doc as { schema_version?: unknown; skeletons?: unknown; refused?: unknown };
  if (version !== 1) {
    return unreadableSeedSkeletons(
      `it declares schema_version ${JSON.stringify(version)}; this reader knows 1`,
    );
  }
  if (!Array.isArray(skeletons)) return unreadableSeedSkeletons('it has no "skeletons" array');
  if (!Array.isArray(refused)) return unreadableSeedSkeletons('it has no "refused" array');

  const entries = new Map<string, SeedSkeletonEntry>();
  for (const [i, raw] of skeletons.entries()) {
    const { path, blob, skeleton } = (raw ?? {}) as {
      path?: unknown;
      blob?: unknown;
      skeleton?: unknown;
    };
    if (typeof path !== "string" || !MIGRATION_PATH.test(path)) {
      return unreadableSeedSkeletons(
        `skeletons[${i}] does not name a migration file (${JSON.stringify(path)})`,
      );
    }
    if (typeof blob !== "string" || !BLOB_ID.test(blob)) {
      return unreadableSeedSkeletons(`skeletons[${i}] (${path}) carries no git blob id`);
    }
    if (typeof skeleton !== "string") {
      return unreadableSeedSkeletons(`skeletons[${i}] (${path}) carries no skeleton`);
    }
    const problem = skeletonShapeProblem(skeleton);
    if (problem) {
      return unreadableSeedSkeletons(
        `skeletons[${i}] (${path}) is not a seed skeleton: it ${problem}`,
      );
    }
    // Two descriptions of one file say two things about it, and there is no
    // rule here for which to believe.
    if (entries.has(path)) {
      return unreadableSeedSkeletons(`${path} is described twice`);
    }
    entries.set(path, { path, blob, skeleton });
  }

  const refusedPaths: string[] = [];
  for (const [i, raw] of refused.entries()) {
    const path = (raw as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || !MIGRATION_PATH.test(path)) {
      return unreadableSeedSkeletons(
        `refused[${i}] does not name a migration file (${JSON.stringify(path)})`,
      );
    }
    refusedPaths.push(path);
  }
  return { state: "read", entries, refused: refusedPaths };
}

/** A file name from its path in the tree. */
function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * What the manifest contributed to one pass, as an operator reads it. File
 * NAMES throughout, as the withdrawal report gives them.
 */
export type SeedSkeletonReport = {
  state: SeedSkeletonReading["state"];
  /** Set when `state` is `unreadable`. */
  why?: string;
  /** Files whose dependency facts this pass took from the prime's skeleton. */
  used: string[];
  /**
   * Files the manifest describes at bytes other than the ones this corpus
   * carries: changed since the manifest was generated. Read as unread.
   */
  stale: string[];
  /** Files the manifest describes that this corpus does not carry. */
  unmatched: string[];
  /** Files the prime found past its threshold and could not describe. */
  refused: string[];
};

/**
 * The skeleton each corpus file may be read through, and the report.
 *
 * A skeleton is usable for a file only where its blob id is the file's own and
 * the body itself was not read — `alreadyRead` is the digest pass's answer,
 * and a body read in full outranks any description of it.
 */
export function usableSeedSkeletons(
  reading: SeedSkeletonReading,
  files: ReadonlyArray<{ name: string; path: string; sha: string }>,
  alreadyRead: (path: string) => boolean,
): { skeletons: Map<string, string>; report: SeedSkeletonReport } {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const skeletons = new Map<string, string>();
  const used: string[] = [];
  const stale: string[] = [];
  const unmatched: string[] = [];
  for (const entry of reading.entries.values()) {
    const file = byPath.get(entry.path);
    if (!file) {
      unmatched.push(fileNameOf(entry.path));
      continue;
    }
    if (alreadyRead(file.path)) continue;
    if (file.sha !== entry.blob) {
      stale.push(file.name);
      continue;
    }
    skeletons.set(file.path, entry.skeleton);
    used.push(file.name);
  }
  return {
    skeletons,
    report: {
      state: reading.state,
      ...(reading.state === "unreadable" ? { why: reading.why } : {}),
      used: used.sort(),
      stale: stale.sort(),
      unmatched: unmatched.sort(),
      refused: reading.refused.map(fileNameOf).sort(),
    },
  };
}

/**
 * The dependency facts and named versions a pass holds once the prime's
 * skeletons are read for the files it could not read itself.
 *
 * What the pass read is kept exactly as it is; a skeleton only adds the facts
 * of a file the pass did not read. They come out of the skeleton through
 * `dependencyFactsOf` and `mentionedVersionsOf`, the extractors every body goes
 * through, so a skeleton cannot mean anything to the partition that the same
 * statements in a body would not.
 *
 * Facts and names and nothing else. A skeleton is not the body, so nothing
 * here produces a digest: a seed whose version the prime's ledger does not
 * record stays withheld whatever its skeleton says, and what changes is only
 * whether it holds everything behind it.
 */
export function readThroughSeedSkeletons(
  reading: SeedSkeletonReading,
  files: ReadonlyArray<{ name: string; path: string; sha: string }>,
  read: {
    facts: ReadonlyMap<string, MigrationDependencyFacts>;
    mentions: ReadonlyMap<string, string[]>;
  },
): {
  facts: Map<string, MigrationDependencyFacts>;
  mentions: Map<string, string[]>;
  report: SeedSkeletonReport;
} {
  const facts = new Map(read.facts);
  const mentions = new Map(read.mentions);
  const { skeletons, report } = usableSeedSkeletons(
    reading,
    files,
    // A path the pass holds either half for is one it read. A skeleton must
    // not supply the other half from different text.
    (path) => read.facts.has(path) || read.mentions.has(path),
  );
  for (const [path, text] of skeletons) {
    facts.set(path, dependencyFactsOf(text));
    mentions.set(path, mentionedVersionsOf(text));
  }
  return { facts, mentions, report };
}

/**
 * What an operator is told about the manifest, as sentences. One wording for
 * every surface, so the health page and a sync report cannot describe the same
 * manifest two ways.
 *
 * Silent when there is nothing to say. An unreadable manifest is always said,
 * because it is the one state in which every seed quietly becomes a barrier to
 * everything behind it again.
 */
export function seedSkeletonNotes(report: SeedSkeletonReport): string[] {
  const notes: string[] = [];
  if (report.state === "unreadable") {
    notes.push(
      `The prime's ${SEED_SKELETONS_PATH} could not be used (${report.why ?? "no reason was recorded"}), ` +
        `so no migration too large to read has dependency facts: each one that is not sent ` +
        `holds every migration after it, until the manifest reads.`,
    );
  }
  if (report.stale.length > 0) {
    const n = report.stale.length;
    notes.push(
      `${n} migration file${n === 1 ? " has" : "s have"} changed since the prime's ` +
        `${SEED_SKELETONS_PATH} was generated, so ${n === 1 ? "it is" : "they are"} read as ` +
        `unread until it is regenerated: ${report.stale.join(", ")}.`,
    );
  }
  if (report.refused.length > 0) {
    const n = report.refused.length;
    notes.push(
      `The prime could not describe ${n} migration file${n === 1 ? "" : "s"} too large for ` +
        `Mission Control to read, so ${n === 1 ? "it is" : "they are"} still read as unread: ` +
        `${report.refused.join(", ")}.`,
    );
  }
  return notes;
}
