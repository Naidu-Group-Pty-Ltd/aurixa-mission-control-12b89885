/**
 * Which refs may reach a clone's production credentials.
 *
 * `supabase-production` on a clone repository holds that clone's own
 * service-role key and database URL (`cloneCiCredential.pure.ts`). Mission
 * Control created it bare, with no deployment branch policy, so a job naming
 * it could read both from ANY branch: a Claude session's `claude/*` branch, a
 * cascade's `aurixa/cascade-*` branch, anything pushed. The prime closed that
 * hole on its own copy ("deployment branches and tags → selected branches →
 * `main`", `docs/operations/DEPLOYMENT_PROTECTION.md`) after measuring 81 of
 * its 96 function-deploy dispatches coming from other branches. A clone's
 * copy is the same credential class and gets the same rule: only the clone's
 * default branch.
 *
 * Checked before it was applied, 27 Oct 2026, on all four clone repositories:
 * every job that names `supabase-production` runs on `schedule`,
 * `workflow_dispatch` or a push to `main`. The two that run on
 * `pull_request` (`address-service.yml`, `routing-service.yml`) name the
 * environment only for a dispatch with `deploy: true`, and the one with a
 * push trigger on another branch (`maps-credential-remediation.yml`) gates
 * every environment job on `workflow_dispatch`. Nothing a default-branch-only
 * policy refuses was running.
 *
 * Reviewers and wait timers are NOT this module's. The prime deliberately has
 * none ("the environment also carries the scheduled AML and RBA refreshes and
 * the drift report, which must not wait for anybody"), and one an administrator
 * adds to a clone is kept: every rewrite of the branch policy sends back the
 * rules the environment already holds, so a PUT can never be the thing that
 * removed a reviewer.
 */

/** GitHub's "selected branches and tags": the shape of the prime's own policy. */
export const SELECTED_BRANCHES_ONLY = {
  protected_branches: false,
  custom_branch_policies: true,
} as const;

export type BranchPolicySettings = {
  protected_branches: boolean;
  custom_branch_policies: boolean;
} | null;

export type ReviewerRef = { type: "User" | "Team"; id: number };

/** The rules besides the branch policy that an environment PUT must carry back. */
export type KeptRules = {
  wait_timer?: number;
  prevent_self_review?: boolean;
  reviewers?: ReviewerRef[];
};

/** One custom deployment policy, as GitHub lists it. */
export type BranchPolicyRow = { id: number; name: string; type: "branch" | "tag" };

/** `deployment_branch_policy` off a GET of the environment. Absent is GitHub's "every branch". */
export function branchPolicySettingsOf(environment: unknown): BranchPolicySettings {
  const raw = (environment as { deployment_branch_policy?: unknown } | null)
    ?.deployment_branch_policy;
  if (!raw || typeof raw !== "object") return null;
  const { protected_branches, custom_branch_policies } = raw as Record<string, unknown>;
  return {
    protected_branches: protected_branches === true,
    custom_branch_policies: custom_branch_policies === true,
  };
}

/** Whether the environment admits anything but the selected branches. */
export function needsSettingsChange(settings: BranchPolicySettings): boolean {
  return !(
    settings &&
    settings.custom_branch_policies === SELECTED_BRANCHES_ONLY.custom_branch_policies &&
    settings.protected_branches === SELECTED_BRANCHES_ONLY.protected_branches
  );
}

/**
 * What an environment already enforces besides its branch policy, in the
 * shape a PUT takes.
 *
 * GitHub returns reviewers as `{ type, reviewer: { id, … } }` and takes them
 * as `{ type, id }`. A reviewer whose id cannot be read is not dropped
 * quietly: the whole set is reported unreadable (`null`), and the caller
 * declines to rewrite an environment it could only rewrite by losing one.
 */
export function keptRulesOf(environment: unknown): KeptRules | null {
  const rules = (environment as { protection_rules?: unknown } | null)?.protection_rules;
  if (rules === undefined || rules === null) return {};
  if (!Array.isArray(rules)) return null;
  const kept: KeptRules = {};
  for (const rule of rules) {
    const r = (rule ?? {}) as Record<string, unknown>;
    if (r.type === "wait_timer" && typeof r.wait_timer === "number") {
      kept.wait_timer = r.wait_timer;
    } else if (r.type === "required_reviewers") {
      if (typeof r.prevent_self_review === "boolean") {
        kept.prevent_self_review = r.prevent_self_review;
      }
      const reviewers: ReviewerRef[] = [];
      for (const entry of Array.isArray(r.reviewers) ? r.reviewers : []) {
        const e = (entry ?? {}) as { type?: unknown; reviewer?: { id?: unknown } };
        const id = e.reviewer?.id;
        if ((e.type !== "User" && e.type !== "Team") || typeof id !== "number") return null;
        reviewers.push({ type: e.type, id });
      }
      kept.reviewers = reviewers;
    }
  }
  return kept;
}

/** The PUT that restricts an environment, keeping every other rule it has. */
export function restrictingPutBody(kept: KeptRules): KeptRules & {
  deployment_branch_policy: typeof SELECTED_BRANCHES_ONLY;
} {
  return { ...kept, deployment_branch_policy: SELECTED_BRANCHES_ONLY };
}

/**
 * The custom policies off a listing, or null when the listing is not the
 * whole set. Removing "everything but the default branch" from a partial
 * list would be a guess about the rest.
 */
export function branchPolicyRowsOf(listing: unknown): BranchPolicyRow[] | null {
  const l = (listing ?? {}) as { total_count?: unknown; branch_policies?: unknown };
  if (!Array.isArray(l.branch_policies)) return null;
  const rows: BranchPolicyRow[] = [];
  for (const p of l.branch_policies) {
    const r = (p ?? {}) as { id?: unknown; name?: unknown; type?: unknown };
    if (typeof r.id !== "number" || typeof r.name !== "string") return null;
    rows.push({ id: r.id, name: r.name, type: r.type === "tag" ? "tag" : "branch" });
  }
  if (typeof l.total_count === "number" && l.total_count > rows.length) return null;
  return rows;
}

/**
 * Converge the custom policies on exactly one: the default branch, by name.
 *
 * `allow` comes first in whatever applies this, so the default branch is
 * admitted before anything else is taken away and no moment exists in which
 * the scheduled refreshes are refused. A pattern that merely MATCHES the
 * default branch (`ma*`, `*`) is not kept: it admits more than the one branch.
 */
export function planBranchPolicies(
  rows: readonly BranchPolicyRow[],
  branch: string,
): { allow: boolean; remove: BranchPolicyRow[] } {
  const isDefault = (r: BranchPolicyRow) => r.type === "branch" && r.name === branch;
  return {
    allow: !rows.some(isDefault),
    remove: rows.filter((r) => !isDefault(r)),
  };
}
