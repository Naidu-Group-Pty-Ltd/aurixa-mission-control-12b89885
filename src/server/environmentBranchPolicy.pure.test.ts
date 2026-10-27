import { describe, expect, it } from "vitest";
import {
  SELECTED_BRANCHES_ONLY,
  branchPolicyRowsOf,
  branchPolicySettingsOf,
  keptRulesOf,
  needsSettingsChange,
  planBranchPolicies,
  restrictingPutBody,
} from "./environmentBranchPolicy.pure";

describe("the environment's settings", () => {
  it("are the prime's shape: selected branches, not protected ones", () => {
    // GitHub refuses the two flags set to the same value with a 422.
    expect(SELECTED_BRANCHES_ONLY).toEqual({
      protected_branches: false,
      custom_branch_policies: true,
    });
  });

  it("need changing when they admit every branch, or every protected one", () => {
    expect(needsSettingsChange(branchPolicySettingsOf({ deployment_branch_policy: null }))).toBe(
      true,
    );
    expect(needsSettingsChange(branchPolicySettingsOf({}))).toBe(true);
    expect(
      needsSettingsChange(
        branchPolicySettingsOf({
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
        }),
      ),
    ).toBe(true);
    expect(
      needsSettingsChange(
        branchPolicySettingsOf({ deployment_branch_policy: SELECTED_BRANCHES_ONLY }),
      ),
    ).toBe(false);
  });
});

describe("what a rewrite keeps", () => {
  it("sends back the reviewers, the self-review rule and the wait timer the environment has", () => {
    const environment = {
      protection_rules: [
        { id: 1, node_id: "a", type: "wait_timer", wait_timer: 15 },
        {
          id: 2,
          node_id: "b",
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: [
            { type: "User", reviewer: { id: 4532992, login: "someone" } },
            { type: "Team", reviewer: { id: 77, slug: "owners" } },
          ],
        },
        { id: 3, node_id: "c", type: "branch_policy" },
      ],
    };
    const kept = keptRulesOf(environment);
    expect(kept).toEqual({
      wait_timer: 15,
      prevent_self_review: true,
      reviewers: [
        { type: "User", id: 4532992 },
        { type: "Team", id: 77 },
      ],
    });
    expect(restrictingPutBody(kept!)).toEqual({
      ...kept,
      deployment_branch_policy: SELECTED_BRANCHES_ONLY,
    });
  });

  it("adds nothing an environment did not have — the prime's carries no reviewer", () => {
    expect(keptRulesOf({ protection_rules: [] })).toEqual({});
    expect(keptRulesOf({})).toEqual({});
    expect(restrictingPutBody({})).toEqual({ deployment_branch_policy: SELECTED_BRANCHES_ONLY });
  });

  it("will not let a rewrite drop a reviewer it could not read", () => {
    expect(
      keptRulesOf({
        protection_rules: [
          { type: "required_reviewers", reviewers: [{ type: "User", reviewer: {} }] },
        ],
      }),
    ).toBeNull();
    expect(keptRulesOf({ protection_rules: "nonsense" })).toBeNull();
  });
});

describe("the policies an environment ends with", () => {
  const row = (id: number, name: string, type: "branch" | "tag" = "branch") => ({ id, name, type });

  it("adds the default branch to an environment that names none", () => {
    expect(planBranchPolicies([], "main")).toEqual({ allow: true, remove: [] });
  });

  it("does nothing on the second pass", () => {
    expect(planBranchPolicies([row(1, "main")], "main")).toEqual({ allow: false, remove: [] });
  });

  it("takes away every other ref, a pattern that also matches the branch included", () => {
    const plan = planBranchPolicies(
      [row(1, "main"), row(2, "release/*"), row(3, "ma*"), row(4, "v*", "tag")],
      "main",
    );
    expect(plan.allow).toBe(false);
    expect(plan.remove.map((r) => r.name)).toEqual(["release/*", "ma*", "v*"]);
  });

  it("does not take a tag named like the branch for the branch", () => {
    const plan = planBranchPolicies([row(9, "main", "tag")], "main");
    expect(plan).toEqual({ allow: true, remove: [row(9, "main", "tag")] });
  });

  it("names the clone's own default branch, whatever it is called", () => {
    expect(planBranchPolicies([row(1, "main")], "trunk")).toEqual({
      allow: true,
      remove: [row(1, "main")],
    });
  });
});

describe("reading the listing", () => {
  it("reads each policy, and a policy without a type as a branch", () => {
    expect(
      branchPolicyRowsOf({
        total_count: 2,
        branch_policies: [
          { id: 1, node_id: "x", name: "main" },
          { id: 2, node_id: "y", name: "v*", type: "tag" },
        ],
      }),
    ).toEqual([
      { id: 1, name: "main", type: "branch" },
      { id: 2, name: "v*", type: "tag" },
    ]);
  });

  it("refuses a listing that is not the whole set, so nothing is removed on a guess", () => {
    expect(
      branchPolicyRowsOf({ total_count: 101, branch_policies: [{ id: 1, name: "main" }] }),
    ).toBeNull();
    expect(branchPolicyRowsOf({ branch_policies: [{ name: "main" }] })).toBeNull();
    expect(branchPolicyRowsOf(null)).toBeNull();
  });
});
