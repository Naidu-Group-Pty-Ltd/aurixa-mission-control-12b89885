/**
 * WHICH CLONE A NEW CLONE IS CREATED UNDER, judged before anything is created.
 *
 * Provisioning a CRM-dependent or CRM-independent clone means creating its
 * repository FROM that line's parent clone and recording the parent, so that
 * every cascade afterwards reaches the new clone through it (see
 * `cloneCascadeSource.pure.ts`). The parent is named on `prime_config`, one
 * column per line, and this module decides whether the row those columns name
 * can actually be created from.
 *
 * ## Refused by name, never substituted
 *
 * Every failure here refuses the whole provision BEFORE a repository exists,
 * and the refusal says which of five different things is wrong, because each
 * sends an operator somewhere different:
 *
 *  - the configuration could not be READ (a transient fault: retry),
 *  - no parent is recorded for the line (Settings),
 *  - the recorded parent no longer exists (Settings),
 *  - the recorded parent runs the OTHER CRM, or nobody has said which (fix the
 *    parent's `crm_mode`, or point the line at the right clone),
 *  - the parent has no repository or branch to copy (the parent's own page).
 *
 * Falling back to the prime in any of those cases would create a clone whose
 * tree does not match the line the operator chose — a CRM-independent choice
 * silently producing a GoHighLevel deployment is exactly the fault the choice
 * exists to prevent. A read that FAILED is not a parent that is ABSENT, and
 * the conservative side of this question is to create nothing.
 *
 * ## What the child records
 *
 * `crmChildFields` is the one place the lineage columns of a new clone are
 * written from, so provisioning and the conversion cannot disagree about what
 * "a clone under this parent" means:
 *
 *  - `parent_clone_id` — the parent; the cascade reads the parent's tree.
 *  - `sync_scope: "mirror"` — a child receives its parent's WHOLE tree. A
 *    module-scoped child would receive only its installed globs of a tree
 *    that differs from the prime's in exactly the files a CRM line owns.
 *  - `crm_mode` — recorded, never inferred.
 *  - `last_synced_sha` — the PARENT's, which is a PRIME commit: the engine
 *    writes the prime sha there on every delivery whatever repository the
 *    bytes came from, so "the parent carries prime@X" is one equality at every
 *    depth, and a child copied from the parent's branch carries the same X.
 *    Reading the parent's branch head instead would store a commit of the
 *    parent's repository, which the prime answers 404 to for ever — the
 *    defect `provisionCloneCore` already records for the template path.
 */

import type { CrmMode } from "@/lib/crmMode.pure";
import { CRM_MODE_COPY, crmModeLabel } from "@/lib/crmMode.pure";

/** The parent row, as much of it as provisioning reads. */
export interface CrmParentRow {
  id: string;
  name: string | null;
  github_owner: string | null;
  github_repo: string | null;
  github_url?: string | null;
  default_branch: string | null;
  /** The PRIME commit the parent's branch carries. */
  last_synced_sha: string | null;
  crm_mode: string | null;
  sync_scope?: string | null;
  parent_clone_id?: string | null;
}

/** A parent that has passed every check, with the fields provisioning needs. */
export interface CrmParent {
  id: string;
  name: string;
  githubOwner: string;
  githubRepo: string;
  defaultBranch: string;
  lastSyncedSha: string | null;
  mode: CrmMode;
}

export type CrmParentJudgement =
  | { ok: true; parent: CrmParent }
  | {
      ok: false;
      /** Which of the five refusals this is — the page and the tests key on it. */
      kind: "unreadable" | "unset" | "missing" | "wrong_mode" | "no_repository";
      reason: string;
    };

export interface JudgeCrmParentInput {
  mode: CrmMode;
  /** The id `prime_config` names for this line, or null when none is recorded. */
  parentId: string | null;
  /** The row that id resolves to, or null when none was returned. */
  parent: CrmParentRow | null;
  /** True when a read that should have answered errored instead. */
  readFailed: boolean;
  readError?: string | null;
}

export function judgeCrmParent(input: JudgeCrmParentInput): CrmParentJudgement {
  const line = CRM_MODE_COPY[input.mode].title;

  if (input.readFailed) {
    return {
      ok: false,
      kind: "unreadable",
      reason:
        `Could not read the ${line} parent clone${input.readError ? ` (${input.readError})` : ""}. ` +
        `Nothing was created: a read that failed is not a parent that is absent, and creating the ` +
        `clone from the prime instead would give it the wrong CRM.`,
    };
  }

  if (!input.parentId) {
    return {
      ok: false,
      kind: "unset",
      reason:
        `No ${line} parent clone is recorded in Settings, so there is no tree to create this clone ` +
        `from. Choose the clone that heads the ${line} line in Settings, then provision again.`,
    };
  }

  const parent = input.parent;
  if (!parent) {
    return {
      ok: false,
      kind: "missing",
      reason:
        `The ${line} parent recorded in Settings (${input.parentId}) no longer exists. Choose the ` +
        `clone that heads the ${line} line in Settings, then provision again.`,
    };
  }

  const parentName = parent.name?.trim() || parent.github_repo || parent.id;

  if (parent.crm_mode !== input.mode) {
    return {
      ok: false,
      kind: "wrong_mode",
      reason:
        `${parentName} is recorded as the ${line} parent, but its own record says ` +
        `"${crmModeLabel(parent.crm_mode)}". A clone created from it would not run the CRM you ` +
        `chose. Correct the parent's CRM, or point the ${line} line at the right clone in Settings.`,
    };
  }

  const owner = parent.github_owner?.trim();
  const repo = parent.github_repo?.trim();
  const branch = parent.default_branch?.trim();
  if (!owner || !repo || !branch) {
    return {
      ok: false,
      kind: "no_repository",
      reason:
        `${parentName} has no repository${owner && repo ? " branch" : ""} recorded, so there is ` +
        `nothing to create the new clone from. Wire up its repository on its own page first.`,
    };
  }

  return {
    ok: true,
    parent: {
      id: parent.id,
      name: parentName,
      githubOwner: owner,
      githubRepo: repo,
      defaultBranch: branch,
      lastSyncedSha: parent.last_synced_sha ?? null,
      mode: input.mode,
    },
  };
}

/**
 * The lineage columns of a clone created under, or moved under, `parent`.
 *
 * `defaultBranch` is the branch the NEW repository actually has — GitHub copies
 * the source's default branch name, and it is read back from the created
 * repository where one exists rather than assumed.
 */
export function crmChildFields(
  parent: CrmParent,
  defaultBranch?: string | null,
): {
  parent_clone_id: string;
  sync_scope: "mirror";
  crm_mode: CrmMode;
  last_synced_sha: string | null;
  default_branch: string;
} {
  return {
    parent_clone_id: parent.id,
    sync_scope: "mirror",
    crm_mode: parent.mode,
    last_synced_sha: parent.lastSyncedSha,
    default_branch: defaultBranch?.trim() || parent.defaultBranch,
  };
}

/** The sentence the new clone's creation notification carries. */
export function describeCrmPlacement(parent: CrmParent): string {
  return (
    `${crmModeLabel(parent.mode)}, created from ${parent.name} ` +
    `(${parent.githubOwner}/${parent.githubRepo}) and receiving every cascade through it.`
  );
}
