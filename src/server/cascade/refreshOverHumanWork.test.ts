import { describe, expect, it } from "vitest";
import { ENGINE_COMMIT_PREFIX, isEngineOnlyBranch } from "./proposalRepair.pure";
import {
  carriesHumanWork,
  lastStatement,
  planRefreshOverHumanWork,
  PRESERVING_MERGE_PREFIX,
  type BranchCommit,
  type Listing,
} from "./refreshOverHumanWork.pure";

const listing = (entries: Record<string, string>, truncated = false): Listing => ({
  entries: new Map(Object.entries(entries)),
  modes: new Map(Object.keys(entries).map((p) => [p, p.endsWith(".sh") ? "100755" : "100644"])),
  truncated,
});

const statement: BranchCommit = {
  sha: "s1",
  message: `${ENGINE_COMMIT_PREFIX}258 file(s) from prime@6c2180a`,
  parents: 1,
};
const reconcile: BranchCommit = {
  sha: "h1",
  message: "Reconcile the cascade at prime@6c2180a on the CRM line",
  parents: 1,
};

describe("whose work is on the branch", () => {
  it("reads only the engine's statements as the engine's", () => {
    expect(carriesHumanWork([statement])).toBe(false);
    expect(carriesHumanWork([statement, reconcile])).toBe(true);
    expect(lastStatement([statement, reconcile])).toBe(statement);
  });

  it("never lets a preserving merge make a worked branch read as pristine", () => {
    const merge: BranchCommit = {
      sha: "m1",
      message: `${PRESERVING_MERGE_PREFIX} (prime@abc1234)`,
      parents: 2,
    };
    expect(PRESERVING_MERGE_PREFIX.startsWith(ENGINE_COMMIT_PREFIX)).toBe(false);
    expect(isEngineOnlyBranch([statement, reconcile, merge])).toBe(false);
  });
});

describe("refreshing over somebody's reconcile", () => {
  const before = listing({
    "a.ts": "A0",
    "agent.ts": "G0",
    "inventory.json": "I0",
    "gone.ts": "X0",
  });
  const head = listing({
    "a.ts": "A0",
    "agent.ts": "G1-hand",
    "inventory.json": "I1-hand",
    "new-fn.ts": "N1",
  });

  it("moves an engine-only branch exactly as before", () => {
    expect(
      planRefreshOverHumanWork({ commits: [statement], statement: null, head: null, next: null }),
    ).toEqual({
      kind: "replace",
    });
  });

  it("keeps the hand-changed paths on top of the new statement where it did not change them again", () => {
    const next = listing({
      "a.ts": "A2-prime",
      "agent.ts": "G0",
      "inventory.json": "I0",
      "gone.ts": "X0",
    });
    const plan = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: before,
      head,
      next,
    });
    expect(plan).toEqual({
      kind: "merge",
      overlay: [
        { path: "agent.ts", mode: "100644", sha: "G1-hand" },
        { path: "gone.ts", mode: "100644", sha: null },
        { path: "inventory.json", mode: "100644", sha: "I1-hand" },
        { path: "new-fn.ts", mode: "100644", sha: "N1" },
      ],
      preserved: ["agent.ts", "gone.ts", "inventory.json", "new-fn.ts"],
    });
  });

  it("defers — never chooses — where the new statement changed a path the reconcile changed", () => {
    const next = listing({
      "a.ts": "A0",
      "agent.ts": "G2-prime",
      "inventory.json": "I0",
      "gone.ts": "X0",
    });
    const plan = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: before,
      head,
      next,
    });
    expect(plan.kind).toBe("defer");
    if (plan.kind === "defer") expect(plan.why).toContain("`agent.ts`");
  });

  it("defers over a merge of another branch, a truncated listing, or a missing statement", () => {
    const next = listing({ "a.ts": "A2" });
    const mergeMain: BranchCommit = {
      sha: "mm",
      message: "Merge remote-tracking branch 'origin/main' into recon",
      parents: 2,
    };
    expect(
      planRefreshOverHumanWork({ commits: [statement, mergeMain], statement: before, head, next })
        .kind,
    ).toBe("defer");
    expect(
      planRefreshOverHumanWork({
        commits: [statement, reconcile],
        statement: before,
        head: listing({}, true),
        next,
      }).kind,
    ).toBe("defer");
    expect(
      planRefreshOverHumanWork({ commits: [reconcile], statement: null, head, next }).kind,
    ).toBe("defer");
  });

  it("keeps an executable's mode", () => {
    const b = listing({ "run.sh": "S0" });
    const h = listing({ "run.sh": "S1" });
    const plan = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: b,
      head: h,
      next: listing({ "run.sh": "S0" }),
    });
    expect(plan).toMatchObject({
      kind: "merge",
      overlay: [{ path: "run.sh", mode: "100755", sha: "S1" }],
    });
  });
});
