/**
 * Refreshing a cascade proposal that somebody has already worked on.
 *
 * ## The loss this ends
 *
 * One cascade proposal is open per clone, and when prime moves the engine
 * updates it in place: a new statement commit on the clone's current head,
 * and the proposal's branch force-moved onto it. That was safe while the
 * engine was the only writer. It stopped being safe the first time somebody
 * reconciled a proposal ON its branch — the commit that turned it green was
 * discarded silently by the next prime merge that changed the tree, and the
 * proposal went red again with nothing reporting why. So reconciles were
 * moved to separate pull requests off `main`, and every cascade on the
 * CRM-independent line grew a second pull request beside it (#82 to #106).
 *
 * ## The rule
 *
 * A refresh may not destroy a commit it did not write. When the branch
 * carries anything besides the engine's statements:
 *
 *   - the human's work is read as a TREE difference — every path whose entry
 *     on the branch head differs from the engine's last statement on it;
 *   - each of those paths keeps the human's version on top of the new
 *     statement, PROVIDED the new statement did not change that same path
 *     again: a path both changed is a conflict, and a conflict is never
 *     resolved here;
 *   - the result is a MERGE COMMIT (parents: the branch head, the new
 *     statement), so the branch only ever moves forward and the human's
 *     commits stay in its history.
 *
 * Anything this cannot decide exactly defers the refresh — the proposal is
 * left exactly as it is, and it lands (or is reconciled) as it stands; the
 * next pass after it merges proposes what is left. Deferring costs a prime
 * revision's latency. Guessing costs somebody's work, which is the loss this
 * module exists to end. It defers when:
 *
 *   - any listing was truncated (an unread path cannot be judged);
 *   - the branch carries no engine statement to measure the human work from;
 *   - the human work includes a merge of some other branch (most often the
 *     base branch: its paths would read as human edits and could restore an
 *     older `main`);
 *   - more paths changed by hand than `MAX_PRESERVED_PATHS`, which is a
 *     rebuild rather than a reconcile;
 *   - any path conflicts.
 *
 * The engine's own preserving merges are recognised by their message
 * (`PRESERVING_MERGE_PREFIX`) and are not "somebody else's merge"; they do
 * not start with `ENGINE_COMMIT_PREFIX`, so `isEngineOnlyBranch` still reads
 * the branch as carrying human work, which it does.
 *
 * Pure: the engine supplies the listings.
 */
import { ENGINE_COMMIT_PREFIX } from "./proposalRepair.pure";

/** The message every preserving merge starts with. Never `ENGINE_COMMIT_PREFIX`. */
export const PRESERVING_MERGE_PREFIX =
  "Merge the refreshed cascade onto this proposal's own commits";

/** Past this, the branch is a rebuild, not a reconcile, and is not overlaid. */
export const MAX_PRESERVED_PATHS = 400;

export type BranchCommit = { sha: string; message: string; parents: number };

/** A flattened tree: blob SHA and mode by path. */
export type Listing = {
  entries: ReadonlyMap<string, string>;
  modes: ReadonlyMap<string, string>;
  truncated: boolean;
};

export type OverlayEntry = { path: string; mode: string; sha: string | null };

export type RefreshPlan =
  /** Only the engine's statements are on the branch: move it, as always. */
  | { kind: "replace" }
  /** Keep the human's paths on top of the new statement, in a merge commit. */
  | { kind: "merge"; overlay: OverlayEntry[]; preserved: string[] }
  /** Leave the proposal exactly as it is. */
  | { kind: "defer"; why: string };

/** The newest engine statement on the branch (commits oldest first, as GitHub lists a pull request's). */
export function lastStatement(commits: readonly BranchCommit[]): BranchCommit | null {
  for (let i = commits.length - 1; i >= 0; i--) {
    if (commits[i].message.startsWith(ENGINE_COMMIT_PREFIX)) return commits[i];
  }
  return null;
}

/** Whether anything on the branch is not the engine's statement or its own preserving merge. */
export function carriesHumanWork(commits: readonly BranchCommit[]): boolean {
  return commits.some(
    (c) =>
      !c.message.startsWith(ENGINE_COMMIT_PREFIX) && !c.message.startsWith(PRESERVING_MERGE_PREFIX),
  );
}

export function planRefreshOverHumanWork(input: {
  commits: readonly BranchCommit[];
  /** The tree of the branch's last engine statement. */
  statement: Listing | null;
  /** The tree of the branch head. */
  head: Listing | null;
  /** The tree of the NEW statement this refresh would propose. */
  next: Listing | null;
}): RefreshPlan {
  if (!carriesHumanWork(input.commits)) return { kind: "replace" };

  const foreignMerge = input.commits.find(
    (c) => c.parents > 1 && !c.message.startsWith(PRESERVING_MERGE_PREFIX),
  );
  if (foreignMerge) {
    return {
      kind: "defer",
      why:
        `the proposal's own commits include a merge (${foreignMerge.sha.slice(0, 7)}), whose paths ` +
        `cannot be told apart from hand edits without risking an older base branch`,
    };
  }
  if (!lastStatement(input.commits)) {
    return {
      kind: "defer",
      why: "the proposal carries no engine statement to measure its own commits from",
    };
  }
  const { statement, head, next } = input;
  if (!statement || !head || !next)
    return { kind: "defer", why: "a tree needed to judge the refresh could not be read" };
  if (statement.truncated || head.truncated || next.truncated) {
    return {
      kind: "defer",
      why: "a tree listing was truncated, so not every path could be judged",
    };
  }

  const changedByHand = new Set<string>();
  for (const [path, sha] of head.entries)
    if (statement.entries.get(path) !== sha) changedByHand.add(path);
  for (const path of statement.entries.keys()) if (!head.entries.has(path)) changedByHand.add(path);

  if (changedByHand.size > MAX_PRESERVED_PATHS) {
    return {
      kind: "defer",
      why: `${changedByHand.size} paths changed by hand — a rebuild, not a reconcile`,
    };
  }

  const conflicts: string[] = [];
  const overlay: OverlayEntry[] = [];
  for (const path of [...changedByHand].sort()) {
    if (next.entries.get(path) !== statement.entries.get(path)) {
      conflicts.push(path);
      continue;
    }
    const sha = head.entries.get(path) ?? null;
    if (sha === null) {
      // A deletion is stated only where the new tree still has the path.
      if (next.entries.has(path))
        overlay.push({ path, mode: next.modes.get(path) ?? "100644", sha: null });
    } else {
      overlay.push({ path, mode: head.modes.get(path) ?? "100644", sha });
    }
  }
  if (conflicts.length > 0) {
    const listed = conflicts
      .slice(0, 5)
      .map((p) => `\`${p}\``)
      .join(", ");
    return {
      kind: "defer",
      why:
        `the refresh would change ${conflicts.length} path(s) the proposal's own commits also changed ` +
        `(${listed}${conflicts.length > 5 ? ", …" : ""})`,
    };
  }
  return { kind: "merge", overlay, preserved: [...changedByHand].sort() };
}
