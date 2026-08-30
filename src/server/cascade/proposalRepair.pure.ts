/**
 * A conflicted cascade proposal is REGENERATED, never resolved.
 *
 * ## Why there is nothing to resolve
 *
 * A cascade branch holds exactly one commit. It is authored by nobody — the
 * engine builds it by taking the clone's current tree and overwriting whole
 * files with prime's blobs, then commits that tree with the clone's default
 * branch as its parent:
 *
 *     447b508  aurixa-mission-control[bot]
 *              chore(aurixa): cascade 17 file(s) from prime@fc01e33
 *
 * There is no history in it, nothing hand-written, and no second line of
 * development that has to be reconciled with the first. It is a STATEMENT —
 * "these files should hold prime's content" — and a statement does not need
 * merging, it needs restating.
 *
 * So when the clone's default branch moves under an open proposal and GitHub
 * reports a conflict, the repair is to build the statement again against the
 * branch as it now is. Rebuilt that way the conflict cannot exist, by
 * construction rather than by luck:
 *
 *     base_tree = the clone's CURRENT tree
 *     parent    = the clone's CURRENT head
 *     ⇒ the proposal's merge base IS the branch head, so it fast-forwards.
 *
 * That is what makes this scale. Resolving conflicts means a judgement per
 * conflict, which across hundreds of clones is a full-time job nobody can do
 * correctly. Regenerating means no judgement at all: there is never a side to
 * pick, so there is never a wrong side to pick.
 *
 * ## What it must never do
 *
 * **Never regenerate a branch a person has touched.** This is the rule the
 * whole design turns on. The cascade pull request body invites exactly that —
 * "Repair the held file in the same merge", "Add the import and its use to the
 * held file in the same merge" — because a held file is the one thing a cascade
 * cannot deliver and a human must. Regenerating force-overwrites the branch, so
 * doing it to a branch carrying someone's commit destroys their work with no
 * warning and no recovery through the UI.
 *
 * The test is exact rather than heuristic: the engine writes ONE commit with a
 * known message shape. One such commit and nothing else means the branch is
 * still entirely the engine's. Anything else — a second commit, a different
 * author, a different message — means hands off and say so.
 *
 * **Never re-scope.** A repair rebases a proposal onto a newer head; it does
 * not quietly upgrade which prime SHA it delivers. If prime has moved on, the
 * next real cascade updates the proposal through the ordinary path and records
 * that against ITS event. A repair that swapped the payload would make
 * `cascade_events.source_sha` describe something the event never delivered,
 * and a record that misdescribes itself is the failure this whole area has
 * been fixing all day.
 *
 * **Never loop.** A proposal still conflicting after several regenerations is
 * telling you something a repair cannot fix — most likely a clone whose default
 * branch is being written faster than a cascade can complete. Past the cap it
 * stops and reports, because a repair loop burns CI on every clone at once and
 * is far worse than one stuck pull request.
 *
 * Client-safe: pure, no imports.
 */

/** The one commit shape the cascade engine writes. */
export const ENGINE_COMMIT_PREFIX = "chore(aurixa): cascade ";

/** How many times one proposal may be regenerated before a human is asked. */
export const MAX_REPAIRS = 3;

/** A commit on the proposal branch, as GitHub reports it. */
export type ProposalCommit = {
  message: string;
  /** The login of the commit's GitHub author, when there is one. */
  authorLogin?: string | null;
};

/**
 * Whether this branch is still entirely the engine's own work.
 *
 * Deliberately strict, and deliberately not a heuristic: the engine writes
 * exactly one commit whose message it controls, so anything else is somebody
 * else's. Erring strict costs an operator notification; erring loose deletes
 * their commit.
 */
export function isEngineOnlyBranch(commits: readonly ProposalCommit[]): boolean {
  if (commits.length !== 1) return false;
  return commits[0].message.startsWith(ENGINE_COMMIT_PREFIX);
}

export type RepairAct =
  /** Nothing is wrong, or nothing is known yet. */
  | { act: "none"; why: string }
  /** Rebuild the proposal on the clone's current head. */
  | { act: "regenerate"; why: string }
  /** A person has to look at this. */
  | { act: "hold"; reason: "human_edits" | "attempts_exhausted"; why: string };

/**
 * What to do about one open proposal.
 *
 * `mergeable` is GitHub's, and it is THREE-valued. `null` means "not computed
 * yet" — GitHub works mergeability out asynchronously after a push — and
 * treating that as a conflict would regenerate a healthy proposal on every
 * tick, resetting its CI each time. Unknown means look again, never act.
 */
export function decideProposalRepair(input: {
  /** GitHub's `mergeable`: true, false, or null while it is being computed. */
  mergeable: boolean | null | undefined;
  /** Commits on the proposal branch, ahead of the base. */
  commits: readonly ProposalCommit[];
  /** How many times this proposal has already been regenerated. */
  attempts: number;
  maxAttempts?: number;
}): RepairAct {
  const max = input.maxAttempts ?? MAX_REPAIRS;

  if (input.mergeable !== false) {
    return {
      act: "none",
      why:
        input.mergeable === true
          ? "The proposal merges cleanly."
          : "GitHub has not finished computing mergeability; looking again next pass.",
    };
  }

  if (!isEngineOnlyBranch(input.commits)) {
    return {
      act: "hold",
      reason: "human_edits",
      why:
        "This proposal carries work that is not the engine's, so it will not be rebuilt — " +
        "regenerating force-overwrites the branch and would destroy it. Resolve the conflict " +
        "by hand, or close the pull request and let the next cascade open a fresh one.",
    };
  }

  if (input.attempts >= max) {
    return {
      act: "hold",
      reason: "attempts_exhausted",
      why:
        `Rebuilt ${input.attempts} time(s) and still conflicting. Something is changing this ` +
        `clone's default branch faster than a cascade can finish, and no further rebuild will ` +
        `settle it.`,
    };
  }

  return {
    act: "regenerate",
    why:
      "The clone's default branch moved under this proposal. Rebuilding it on the current " +
      "head, which removes the conflict by construction rather than resolving it.",
  };
}

/** One line for an operator, naming what was done and to which pull request. */
export function describeRepair(prNumber: number, act: RepairAct): string {
  const lead =
    act.act === "regenerate"
      ? `PR #${prNumber} rebuilt on the clone's current head`
      : act.act === "hold"
        ? `PR #${prNumber} needs a person (${act.reason.replace("_", " ")})`
        : `PR #${prNumber} needs nothing`;
  return `${lead} — ${act.why}`;
}
