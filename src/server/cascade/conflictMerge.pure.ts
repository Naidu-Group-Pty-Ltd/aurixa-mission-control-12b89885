/**
 * Resolving a conflicted cascade proposal in the proposal's favour.
 *
 * ## Where this sits beside regeneration
 *
 * `proposalRepair.pure.ts` is still the first answer to a conflict: a branch
 * that is entirely the engine's one statement is REBUILT on the clone's current
 * head, which removes the conflict by construction. This module exists for the
 * conflicts regeneration must refuse — and before it, those refusals were
 * permanent. A proposal held for `human_edits`, one whose repair attempts were
 * spent, or one Mission Control had no cascade record to rebuild from sat open
 * for ever, each with a notification an operator had already learned to filter
 * out. "Whenever there are merge conflicts it never closes" was the owner's
 * exact report, with the standing instruction that resolution always accepts
 * the CURRENT change — the proposal's own side — and then merges.
 *
 * ## What "accept current" means here, precisely
 *
 * A cascade proposal is a statement: "these paths should hold this content."
 * The resolution is a MERGE COMMIT on the proposal branch whose tree is the
 * clone's current default-branch tree with the proposal's statement re-applied
 * on top:
 *
 *     tree    = base branch tree  +  the head's version of every path the
 *                                    pull request touches
 *     parents = [proposal head, base head]
 *
 * Read as a three-way merge, that is exactly "accept current change" on every
 * conflicting hunk — the proposal's side stands for everything it states — and
 * everything the proposal does not state keeps the base branch's content. It
 * is also exactly what a CLEAN cascade merge produces, which is the point: a
 * conflicted file must not land differently from an unconflicted one.
 *
 * ## Why a merge and not a regeneration
 *
 * A merge commit destroys nothing. A branch carrying somebody's commit keeps
 * that commit in its history, and the head's tree — which their commit is part
 * of — is the side that wins, so their work survives in the result as well as
 * in the log. That is what makes it safe precisely where regeneration is not.
 *
 * ## The rules
 *
 * - **The head's tree is the only source of content.** Nothing here fetches
 *   blobs, rewrites text or splices hunks; every entry is a (path, mode, sha)
 *   taken verbatim from the proposal's own tree. There is no half-resolution.
 * - **A deletion is stated only where the base still has the path.** The tree
 *   is built on the base's tree, so a path the base already lacks needs no
 *   entry — and naming it would fail the whole tree.
 * - **A truncated tree is a refusal, never a guess.** GitHub truncates very
 *   large recursive trees; resolving from a partial listing would silently
 *   drop the paths past the cut.
 * - **The commit is not the engine's statement commit.** Its message must
 *   never start with `ENGINE_COMMIT_PREFIX`: `isEngineOnlyBranch` recognises
 *   an untouched proposal by that prefix, and a resolution that wore it would
 *   make a many-commit branch read as pristine.
 *
 * Client-safe: pure, no imports beyond the sibling constant.
 */
import { ENGINE_COMMIT_PREFIX } from "./proposalRepair.pure";

/** GitHub's own cap on a pull request's file listing. Past it the list is a sample. */
export const MAX_RESOLVABLE_FILES = 3000;

/** How many times one proposal may be merge-resolved inside the attempt window. */
export const MAX_RESOLUTIONS = 4;

/** One file as the pull request reports it. */
export type PrFile = {
  filename: string;
  /** added | modified | removed | renamed | changed | copied */
  status: string;
  previous_filename?: string | null;
};

/** One entry of a recursive git tree, as GitHub reports it. */
export type TreeEntry = {
  path: string;
  mode: string;
  type: string;
  sha: string;
};

/** The blob modes git admits; anything else is refused before an entry is made. */
export type BlobMode = "100644" | "100755" | "120000";

export type ResolutionEntry = {
  path: string;
  mode: BlobMode;
  type: "blob";
  /** null deletes the path from the base tree. */
  sha: string | null;
};

const BLOB_MODES: ReadonlySet<string> = new Set(["100644", "100755", "120000"]);

export type ResolutionPlan =
  | {
      ok: true;
      /** Entries for `git.createTree` with `base_tree` = the BASE branch's tree. */
      entries: ResolutionEntry[];
      /** Paths written from the proposal's tree. */
      restated: number;
      /** Paths deleted because the proposal deletes them and the base still had them. */
      deleted: number;
    }
  | {
      ok: false;
      reason:
        | "head_tree_truncated"
        | "base_tree_truncated"
        | "too_many_files"
        | "not_a_blob"
        | "missing_in_head";
      refusal: string;
    };

/**
 * Plan the resolution tree.
 *
 * `prFiles` is the pull request's own file list — the statement, as GitHub
 * holds it, so no Mission Control record is needed. `headTree` and `baseTree`
 * are the two branches' recursive trees; only paths the pull request names are
 * consulted, so everything else keeps the base's content by construction.
 */
export function planResolutionMerge(input: {
  prFiles: readonly PrFile[];
  headTree: { truncated?: boolean; entries: readonly TreeEntry[] };
  baseTree: { truncated?: boolean; entries: readonly TreeEntry[] };
}): ResolutionPlan {
  if (input.headTree.truncated) {
    return {
      ok: false,
      reason: "head_tree_truncated",
      refusal:
        "The proposal branch's tree listing is truncated, so a resolution built from it " +
        "would silently drop every path past the cut. Refusing to guess.",
    };
  }
  if (input.baseTree.truncated) {
    return {
      ok: false,
      reason: "base_tree_truncated",
      refusal:
        "The default branch's tree listing is truncated, so deletions cannot be told from " +
        "paths the base never had. Refusing to guess.",
    };
  }
  if (input.prFiles.length > MAX_RESOLVABLE_FILES) {
    return {
      ok: false,
      reason: "too_many_files",
      refusal:
        `The pull request reports ${input.prFiles.length} files, past GitHub's ${MAX_RESOLVABLE_FILES}-file ` +
        "listing cap — the list may be a sample of the statement rather than the statement. " +
        "Refusing to resolve from a partial list.",
    };
  }

  const headByPath = new Map(input.headTree.entries.map((e) => [e.path, e]));
  const baseHas = new Set(input.baseTree.entries.map((e) => e.path));

  // Last write per path wins, so a rename's delete-then-add composes cleanly
  // even when the listing also carries the paths separately.
  const byPath = new Map<string, ResolutionEntry>();
  let restated = 0;
  let deleted = 0;

  const deleteIfBaseHas = (path: string) => {
    if (!baseHas.has(path)) return;
    byPath.set(path, { path, mode: "100644", type: "blob", sha: null });
    deleted++;
  };

  for (const file of input.prFiles) {
    if (file.status === "removed") {
      deleteIfBaseHas(file.filename);
      continue;
    }
    if (file.status === "renamed" && file.previous_filename) {
      deleteIfBaseHas(file.previous_filename);
    }
    const entry = headByPath.get(file.filename);
    if (!entry) {
      return {
        ok: false,
        reason: "missing_in_head",
        refusal:
          `The pull request lists \`${file.filename}\` as ${file.status}, and the proposal ` +
          "branch's tree does not hold it. The two reads disagree — looking again next pass " +
          "instead of resolving from an inconsistent snapshot.",
      };
    }
    if (entry.type !== "blob" || !BLOB_MODES.has(entry.mode)) {
      return {
        ok: false,
        reason: "not_a_blob",
        refusal:
          `\`${file.filename}\` is a ${entry.type} (mode ${entry.mode}) in the proposal's tree, ` +
          "and this resolution only restates files. A submodule or tree entry needs a person.",
      };
    }
    byPath.set(file.filename, {
      path: file.filename,
      mode: entry.mode as BlobMode,
      type: "blob",
      sha: entry.sha,
    });
    restated++;
  }

  return {
    ok: true,
    entries: Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path)),
    restated,
    deleted,
  };
}

/**
 * The resolution commit's message.
 *
 * Deliberately NOT the engine's statement prefix: `isEngineOnlyBranch`
 * recognises an untouched proposal by `ENGINE_COMMIT_PREFIX`, and a resolution
 * commit that wore it would make a many-commit branch read as pristine. A test
 * pins the distinction rather than trusting it.
 */
export function resolutionCommitMessage(input: {
  prNumber: number;
  baseShort: string;
  restated: number;
  deleted: number;
}): string {
  const message =
    `chore(aurixa): restate proposal #${input.prNumber} over ${input.baseShort}\n\n` +
    `Conflict resolution by standing instruction: the proposal's side stands for every path ` +
    `it states (${input.restated} restated, ${input.deleted} deleted); everything else keeps ` +
    `the default branch's content. A merge commit, so nothing on this branch is rewritten.`;
  if (message.startsWith(ENGINE_COMMIT_PREFIX)) {
    // Unreachable by construction; the throw keeps it that way if the prefix
    // or this message ever changes shape.
    throw new Error("A resolution commit must not wear the engine's statement prefix");
  }
  return message;
}
