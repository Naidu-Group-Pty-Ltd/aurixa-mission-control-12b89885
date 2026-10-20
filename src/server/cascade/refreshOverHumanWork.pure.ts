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
 *     statement where the new statement did not change that same path again;
 *   - a path the new statement ALSO changed, to exactly the human's entry
 *     (same blob, same mode, or both deleted), is AGREEMENT, not a conflict:
 *     the new statement already carries the human's version, so nothing is
 *     overlaid and nothing is lost;
 *   - a path both changed differently is three-way merged by the engine —
 *     the last statement is the base, the head is ours, the new statement is
 *     theirs — with `threeWayMerge`, the merge held line variants already use
 *     (`variantMerge.pure.ts`). Only a CLEAN merge is overlaid; one
 *     conflicting hunk, a text that cannot be read, a deletion against an
 *     edit, an add against an add or a mode change defers the refresh;
 *   - the result is a MERGE COMMIT (parents: the branch head, the new
 *     statement), so the branch only ever moves forward and the human's
 *     commits stay in its history.
 *
 * ## Why agreement had to be named
 *
 * The rule used to call every path both sides changed a conflict, without
 * asking what either side changed it TO. That made the house rule — fix it at
 * prime and let the cascade carry it — deadlock on the proposals it was meant
 * to free. Measured on npc-client-dashboard #379, 19 Oct 2026: the proposal
 * carried three hand commits (every workflow pinned to a commit, Deno and the
 * Supabase CLI installed from their releases, and a held `App.tsx` reconcile),
 * written byte for byte from prime's own pull request so the clone could run
 * CI under the organisation's new Actions policy. Prime then merged that pull
 * request, and the refresh deferred on "29 path(s) the proposal's own commits
 * also changed": all 29 were workflow files the new statement carried with
 * EXACTLY the bytes the hand commits had written. The proposal could not go
 * green without prime's next change, and prime's next change could not reach
 * it. The next one, adding `--with-deps` to a workflow the hand commit had
 * also pinned, needs the three-way merge: the hand's change is a subset of
 * prime's, and the merge takes prime's text.
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
 *   - a path both changed differently cannot be three-way merged here: a
 *     deletion against an edit, two different additions, a mode either side
 *     changed, more such paths than `MAX_REFRESH_TEXT_MERGES`, or, once the
 *     engine has read the texts, a text it could not read or a merge that
 *     conflicts (`completeRefreshPlan`).
 *
 * The engine's own preserving merges are recognised by their message
 * (`PRESERVING_MERGE_PREFIX`) and are not "somebody else's merge"; they do
 * not start with `ENGINE_COMMIT_PREFIX`, so `isEngineOnlyBranch` still reads
 * the branch as carrying human work, which it does.
 *
 * ## The merge drain's own resolution is not human work
 *
 * A conflicted proposal is resolved by the merge drain in one merge commit
 * (`conflictMerge.pure.ts`): the base branch's tree with the proposal's own
 * paths restated, parents `[head, base]`. Its tree is two things the next
 * statement regenerates — the base branch, and the statement's paths — so
 * where every other commit on the branch is a statement, the branch carries
 * nothing but the engine's work and is moved as an engine-only branch.
 * Measured on npc-crm-independent-6505dc #121, 20 Oct 2026: its commits were
 * one statement and the drain's `f024824`, and the first pass to deliver the
 * line's 1,375 files since 17 Oct deferred on that merge as somebody else's,
 * so no later pass could have refreshed the proposal either.
 *
 * Beside a hand commit it is still a merge of the base branch, and reading
 * its base paths as hand edits could restore an older `main`, so it defers
 * there as before.
 *
 * Pure: the engine supplies the listings, and the texts a merge needs.
 */
import { RESOLUTION_MERGE_PREFIX } from "./conflictMerge.pure";
import { ENGINE_COMMIT_PREFIX } from "./proposalRepair.pure";
import { threeWayMerge } from "./variantMerge.pure";

/** The message every preserving merge starts with. Never `ENGINE_COMMIT_PREFIX`. */
export const PRESERVING_MERGE_PREFIX =
  "Merge the refreshed cascade onto this proposal's own commits";

/** Past this, the branch is a rebuild, not a reconcile, and is not overlaid. */
export const MAX_PRESERVED_PATHS = 400;

/**
 * Past this, a refresh that would have to merge text is deferred. Each merge
 * costs the engine three blob reads and one write, and a proposal whose
 * reconcile collides with prime on more files than this is being rebuilt, not
 * followed.
 */
export const MAX_REFRESH_TEXT_MERGES = 8;

/** A text longer than this is not merged here: the line matcher's cost grows with it. */
export const MAX_REFRESH_MERGE_CHARS = 1_000_000;

/** The two modes a text file can carry. A link or a submodule is never merged as text. */
const TEXT_MODES = new Set(["100644", "100755"]);

export type BranchCommit = { sha: string; message: string; parents: number };

/** A flattened tree: blob SHA and mode by path. */
export type Listing = {
  entries: ReadonlyMap<string, string>;
  modes: ReadonlyMap<string, string>;
  truncated: boolean;
};

export type OverlayEntry = { path: string; mode: string; sha: string | null };

/**
 * A path the human and the new statement both changed, differently: the three
 * blobs a merge reads. `base` is the branch's last statement, `ours` the head,
 * `theirs` the new statement. The mode is the one both sides carry.
 */
export type TextMergeCandidate = {
  path: string;
  mode: string;
  base: string;
  ours: string;
  theirs: string;
};

export type RefreshPlan =
  /** Only the engine's statements are on the branch: move it, as always. */
  | { kind: "replace" }
  /**
   * Keep the human's paths on top of the new statement, in a merge commit.
   * `agreed` are paths the new statement already carries exactly as the human
   * left them (nothing to overlay). `textMerges` are owed a three-way merge
   * before anything is written: the engine reads their texts and completes
   * the plan with `completeRefreshPlan`, which defers on any doubt.
   */
  | {
      kind: "merge";
      overlay: OverlayEntry[];
      preserved: string[];
      agreed: string[];
      textMerges: TextMergeCandidate[];
    }
  /** Leave the proposal exactly as it is. */
  | { kind: "defer"; why: string };

type MergePlan = Extract<RefreshPlan, { kind: "merge" }>;

/** The newest engine statement on the branch (commits oldest first, as GitHub lists a pull request's). */
export function lastStatement(commits: readonly BranchCommit[]): BranchCommit | null {
  for (let i = commits.length - 1; i >= 0; i--) {
    if (commits[i].message.startsWith(ENGINE_COMMIT_PREFIX)) return commits[i];
  }
  return null;
}

/** The merge drain's conflict resolution: a merge, by its message (`conflictMerge.pure.ts`). */
export function isResolutionMerge(c: BranchCommit): boolean {
  return c.parents > 1 && c.message.startsWith(RESOLUTION_MERGE_PREFIX);
}

/**
 * Whether anything on the branch is not the engine's statement or its own
 * preserving merge. The merge drain's resolution counts as the engine's only
 * where nothing else on the branch is somebody's (see the module header).
 */
export function carriesHumanWork(commits: readonly BranchCommit[]): boolean {
  const human = (c: BranchCommit) =>
    !c.message.startsWith(ENGINE_COMMIT_PREFIX) && !c.message.startsWith(PRESERVING_MERGE_PREFIX);
  return commits.some((c) => human(c) && !isResolutionMerge(c));
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
  const agreed: string[] = [];
  const textMerges: TextMergeCandidate[] = [];
  for (const path of [...changedByHand].sort()) {
    if (next.entries.get(path) !== statement.entries.get(path)) {
      // Both sides changed it. What matters is what each changed it TO.
      const ours = head.entries.get(path);
      const theirs = next.entries.get(path);
      const base = statement.entries.get(path);
      if (
        ours === theirs &&
        (ours === undefined || head.modes.get(path) === next.modes.get(path))
      ) {
        // The new statement already holds the human's version (or both
        // deleted it): nothing is overlaid, and nothing is lost.
        agreed.push(path);
        continue;
      }
      const mode = head.modes.get(path);
      if (
        ours === undefined ||
        theirs === undefined ||
        base === undefined ||
        mode === undefined ||
        mode !== next.modes.get(path) ||
        mode !== statement.modes.get(path) ||
        !TEXT_MODES.has(mode)
      ) {
        conflicts.push(path);
        continue;
      }
      textMerges.push({ path, mode, base, ours, theirs });
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
        `the refresh would change ${conflicts.length} path(s) the proposal's own commits also changed, ` +
        `in a way no text merge can settle (${listed}${conflicts.length > 5 ? ", …" : ""})`,
    };
  }
  if (textMerges.length > MAX_REFRESH_TEXT_MERGES) {
    return {
      kind: "defer",
      why:
        `${textMerges.length} path(s) changed differently here and in the refresh — more than the ` +
        `${MAX_REFRESH_TEXT_MERGES} a refresh merges`,
    };
  }
  return { kind: "merge", overlay, preserved: [...changedByHand].sort(), agreed, textMerges };
}

/**
 * The verdict on one candidate, from the three texts the engine read. `null`
 * for a text that could not be read as text: a read that FAILED is not a text
 * that is EMPTY, and the safe side of an unread file is the proposal left as
 * it stands.
 */
export type RefreshTextMerge =
  | { path: string; act: "write"; text: string }
  | { path: string; act: "hold"; why: string };

export function decideRefreshTextMerge(
  candidate: TextMergeCandidate,
  texts: { base: string | null; ours: string | null; theirs: string | null },
): RefreshTextMerge {
  const { path } = candidate;
  const { base, ours, theirs } = texts;
  if (base === null || ours === null || theirs === null) {
    return { path, act: "hold", why: `\`${path}\` could not be read as text to merge` };
  }
  if (Math.max(base.length, ours.length, theirs.length) > MAX_REFRESH_MERGE_CHARS) {
    return { path, act: "hold", why: `\`${path}\` is too large to merge here` };
  }
  const merged = threeWayMerge(base, ours, theirs);
  if (!merged.clean) {
    return {
      path,
      act: "hold",
      why: `${merged.conflicts} hunk(s) of \`${path}\` changed differently here and in the refresh`,
    };
  }
  return { path, act: "write", text: merged.text };
}

/**
 * The merge plan with every candidate settled. `stored` is the blob each
 * written merge was stored as (null where the store failed). Any hold, or any
 * merge that could not be stored, defers the whole refresh: half a merge is
 * worse than none, because the overlay is one tree.
 */
export function completeRefreshPlan(
  plan: MergePlan,
  settled: readonly { verdict: RefreshTextMerge; stored: string | null }[],
): RefreshPlan {
  const byPath = new Map(settled.map((s) => [s.verdict.path, s]));
  const overlay = [...plan.overlay];
  for (const candidate of plan.textMerges) {
    const s = byPath.get(candidate.path);
    if (!s) return { kind: "defer", why: `\`${candidate.path}\` was not merged` };
    if (s.verdict.act === "hold") return { kind: "defer", why: s.verdict.why };
    if (s.stored === null) {
      return { kind: "defer", why: `the merge of \`${candidate.path}\` could not be stored` };
    }
    overlay.push({ path: candidate.path, mode: candidate.mode, sha: s.stored });
  }
  overlay.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ...plan, overlay, textMerges: [] };
}
