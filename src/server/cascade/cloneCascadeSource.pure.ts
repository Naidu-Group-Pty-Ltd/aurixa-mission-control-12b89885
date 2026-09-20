/**
 * WHERE A CLONE'S CASCADE READS FROM.
 *
 * Until `clones.parent_clone_id` existed there was one answer for the whole
 * fleet: prime. `executeCascade` resolved one `primeRef` and one head SHA
 * before the per-clone loop and handed both to every clone in the event.
 *
 * A recorded parent changes that for its children — they copy the PARENT'S
 * default branch, because a parent may carry clone-authored divergence its
 * children are meant to inherit, and copying prime instead would silently
 * revert it on every cascade.
 *
 * Three things this module exists to get right.
 *
 * ## 1. A child is HELD until its parent carries the commit being delivered
 *
 * The event exists to deliver prime@X. A child that reads its parent's branch
 * before the parent has received prime@X gets prime@X-1 through it, and the
 * event completes claiming it delivered prime@X to four clones when two of
 * them got something older. That is not a stale read the operator can see; it
 * is a lie in the ledger.
 *
 * `clones.last_synced_sha` is exactly the test, and it composes to any depth:
 * the engine writes the PRIME sha there on a successful delivery whatever
 * repository the bytes physically came from, so "the parent carries prime@X"
 * is one equality at every level of the tree.
 *
 * A held child is `queued`, never failed and never skipped. In `pr` mode the
 * parent's delivery is a proposal a person still has to merge, so the hold can
 * outlive several passes — that is the correct outcome, and the event's own
 * attempt ceiling is what eventually puts it in front of somebody.
 *
 * ## 2. A parent that cannot be READ is not a parent that is ABSENT
 *
 * The rule this repository keeps paying for. A failed read of the parent row
 * resolves to a HOLD, never to prime: falling back to prime would deliver
 * prime's whole tree to a clone whose entire configuration says it should
 * receive a filtered subset from somewhere else. The conservative side of this
 * question is to deliver nothing.
 *
 * ## 3. The label travels with the bytes
 *
 * Every human-facing string the engine writes — commit message, pull request
 * title, "already in sync with" — said `prime@<sha>`. For a routed child that
 * sentence would name prime over content prime never held. `label` is what the
 * engine prints, and it names the repository the bytes actually came from.
 *
 * Nothing here reaches the network: resolving the parent's head SHA is the
 * engine's job, because only the engine holds an Octokit. This decides WHICH
 * ref, and whether to ask at all.
 */

/** A GitHub ref the engine can read a tree from. */
export interface CascadeSourceRef {
  owner: string;
  repo: string;
  branch: string;
}

/** The parent row, as much of it as this decision reads. */
export interface ParentCloneRow {
  id: string;
  name: string | null;
  github_owner: string;
  github_repo: string;
  default_branch: string | null;
  /** The PRIME commit this clone's default branch carries. */
  last_synced_sha: string | null;
}

export type CascadeSourceDecision =
  /** Read prime, exactly as every cascade did before lineage existed. */
  | { kind: "prime" }
  /** Read the parent's default branch. The engine resolves its head SHA. */
  | { kind: "parent"; ref: CascadeSourceRef; label: string; parentId: string }
  /** Deliver nothing this pass. The row stays `queued`. */
  | { kind: "hold"; why: string };

export interface ResolveCascadeSourceInput {
  /** `prime_config.cascade_follows_lineage`. False → every clone reads prime. */
  followsLineage: boolean;
  /** `clones.parent_clone_id` for the clone being processed. */
  parentCloneId: string | null;
  /**
   * The parent row, or null when it was not among the rows read. Null is
   * ambiguous on its own, which is why `parentReadFailed` is separate.
   */
  parent: ParentCloneRow | null;
  /** True when the query that should have returned the parent errored. */
  parentReadFailed: boolean;
  /** The prime head this pass resolved — the commit the event is delivering. */
  primeSha: string;
}

export function resolveCascadeSource(input: ResolveCascadeSourceInput): CascadeSourceDecision {
  // Off: one answer for the whole fleet, and this module is a passthrough.
  if (!input.followsLineage) return { kind: "prime" };

  // No recorded parent is not an unknown — it is the recorded statement that
  // this clone receives from prime, which is what every clone says by default.
  if (!input.parentCloneId) return { kind: "prime" };

  if (input.parentReadFailed) {
    return {
      kind: "hold",
      why: "Could not read this clone's parent. A read that failed is not a parent that is absent, and falling back to prime would deliver prime's whole tree to a clone configured to receive its parent's.",
    };
  }

  const parent = input.parent;
  if (!parent) {
    return {
      kind: "hold",
      why: `Parent clone ${input.parentCloneId} is recorded on this clone but no such row was found. Nothing is delivered until the lineage names a clone that exists.`,
    };
  }

  const branch = parent.default_branch?.trim();
  if (!branch) {
    return {
      kind: "hold",
      why: `Parent ${parent.github_owner}/${parent.github_repo} has no default branch recorded, so there is no ref to read a tree from.`,
    };
  }

  const parentLabel = parent.name?.trim() || `${parent.github_owner}/${parent.github_repo}`;

  if (!parent.last_synced_sha) {
    return {
      kind: "hold",
      why: `Parent ${parentLabel} has never recorded a delivered prime commit, so nothing can say its branch carries prime@${shortSha(input.primeSha)} yet.`,
    };
  }

  if (parent.last_synced_sha !== input.primeSha) {
    return {
      kind: "hold",
      why: `Parent ${parentLabel} carries prime@${shortSha(parent.last_synced_sha)}; this pass delivers prime@${shortSha(input.primeSha)}. Reading its branch now would hand this clone the older tree while the event claimed the newer one.`,
    };
  }

  return {
    kind: "parent",
    parentId: parent.id,
    ref: { owner: parent.github_owner, repo: parent.github_repo, branch },
    label: parentLabel,
  };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * How long a held event waits before it is claimable again.
 *
 * A lineage hold is paced like a rate-limit deferral and for the same reason:
 * the wait is somebody else's clock, not this event's fault. In `auto_merge`
 * mode the parent lands within the same pass or the next one; in `pr` mode it
 * lands when a person merges, which can be hours.
 *
 * This is why a hold must NOT retry immediately. The drain spends an attempt
 * on every claim and refunds it only for a deferral or a pass that delivered
 * something (`hooks.cascade-drain`), and `FOLD_MAX_ATTEMPTS` is 3 — so an
 * immediate retry would burn a legitimately-waiting event inside three ticks
 * and report it failed while the parent's pull request sat open and healthy.
 *
 * Five minutes: short enough that a merge is picked up promptly, long enough
 * that a pull request open overnight costs ~288 claims rather than ~17,000.
 */
export const LINEAGE_HOLD_RETRY_MS = 5 * 60 * 1000;

/**
 * The one sentence an event carries while it waits on a parent.
 *
 * Deliberately the shape `describeDeferral` and `describePause` already use: a
 * held event is `pending` with a tally and a reason, never a silent `running`
 * and never a false `completed`. It names the FIRST reason rather than all of
 * them because the summary is one line on a row, and the per-clone detail is
 * on each held result.
 */
export function describeLineageHold(input: {
  held: number;
  done: number;
  total: number;
  firstReason: string;
  until: string;
}): string {
  const plural = input.held === 1 ? "clone is" : "clones are";
  const at = input.until.replace(/\.\d{3}Z$/, "Z");
  return (
    `Waiting on lineage until ${at} — ${input.held} ${plural} held until their parent ` +
    `carries this commit; ${input.done} of ${input.total} clone(s) done. ${input.firstReason}`
  );
}

/**
 * Parents before children, so a pass can deliver a parent and then its child
 * in the same run rather than holding the child for the next tick.
 *
 * Depth is counted through the rows PRESENT in this pass. A clone whose parent
 * is not in the event sorts as a root: it is not waiting on anything here, and
 * sinking it to the bottom would delay it behind work it does not depend on.
 *
 * The walk is bounded and a cycle sorts as a root rather than looping — the
 * database refuses a cycle (`trg_clones_parent_acyclic`), and this does not
 * depend on the database having been right.
 *
 * Stable within a depth: the input order is preserved, so a pass that stops on
 * its budget resumes in the same order it left off.
 */
export function orderByLineageDepth<T extends { id: string; parent_clone_id: string | null }>(
  rows: T[],
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));

  const depthOf = (row: T): number => {
    const seen = new Set<string>([row.id]);
    let depth = 0;
    let cursor = row.parent_clone_id;
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = byId.get(cursor)!.parent_clone_id;
    }
    return depth;
  };

  return rows
    .map((row, index) => ({ row, index, depth: depthOf(row) }))
    .sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.index - b.index))
    .map((entry) => entry.row);
}
