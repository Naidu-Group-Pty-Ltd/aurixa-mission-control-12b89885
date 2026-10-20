import { describe, expect, it } from "vitest";
import { resolutionCommitMessage } from "./conflictMerge.pure";
import { ENGINE_COMMIT_PREFIX, isEngineOnlyBranch } from "./proposalRepair.pure";
import {
  carriesHumanWork,
  completeRefreshPlan,
  decideRefreshTextMerge,
  isResolutionMerge,
  lastStatement,
  MAX_REFRESH_MERGE_CHARS,
  MAX_REFRESH_TEXT_MERGES,
  planRefreshOverHumanWork,
  PRESERVING_MERGE_PREFIX,
  type BranchCommit,
  type Listing,
  type TextMergeCandidate,
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

  describe("the merge drain's own resolution", () => {
    // npc-crm-independent-6505dc #121 on 20 Oct 2026: one statement, then the
    // drain's `f024824`, and the line's refresh deferred on it as a stranger's.
    const resolution: BranchCommit = {
      sha: "f0248243",
      message: resolutionCommitMessage({
        prNumber: 121,
        baseShort: "2a26ddc",
        restated: 939,
        deleted: 6,
      }),
      parents: 2,
    };

    it("is the engine's work on a branch of statements, so the branch moves as before", () => {
      expect(isResolutionMerge(resolution)).toBe(true);
      expect(carriesHumanWork([statement, resolution])).toBe(false);
      expect(
        planRefreshOverHumanWork({
          commits: [statement, resolution],
          statement: null,
          head: null,
          next: null,
        }),
      ).toEqual({ kind: "replace" });
    });

    it("still defers beside a hand commit, where its base paths would read as hand edits", () => {
      const before = listing({ "a.ts": "A0" });
      const head = listing({ "a.ts": "A1" });
      const next = listing({ "a.ts": "A2" });
      for (const commits of [
        [statement, reconcile, resolution],
        [statement, resolution, reconcile],
      ]) {
        expect(carriesHumanWork(commits)).toBe(true);
        const plan = planRefreshOverHumanWork({ commits, statement: before, head, next });
        expect(plan).toEqual({ kind: "defer", why: expect.stringContaining("f024824") });
      }
    });

    it("is recognised only as a merge wearing the drain's message", () => {
      expect(isResolutionMerge({ ...resolution, parents: 1 })).toBe(false);
      expect(carriesHumanWork([statement, { ...resolution, parents: 1 }])).toBe(true);
      const mergeMain: BranchCommit = {
        sha: "mm",
        message: "Merge remote-tracking branch 'origin/main' into recon",
        parents: 2,
      };
      expect(isResolutionMerge(mergeMain)).toBe(false);
      expect(carriesHumanWork([statement, mergeMain])).toBe(true);
    });
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
      agreed: [],
      textMerges: [],
    });
  });

  it("never chooses where both changed a path differently: it is owed a three-way merge", () => {
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
    expect(plan).toMatchObject({
      kind: "merge",
      textMerges: [
        { path: "agent.ts", mode: "100644", base: "G0", ours: "G1-hand", theirs: "G2-prime" },
      ],
    });
    // Nothing is written for it until the merge settles it.
    if (plan.kind === "merge") expect(plan.overlay.map((o) => o.path)).not.toContain("agent.ts");
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

describe("what both sides changed it TO", () => {
  const before = listing({ "ci.yml": "W0", "App.tsx": "A0", "spec.ts": "S0", "old.ts": "O0" });

  it("reads a path both changed to the same entry as agreement, and overlays nothing for it", () => {
    const head = listing({ "ci.yml": "W1-pinned", "App.tsx": "A0", "spec.ts": "S0" });
    const next = listing({ "ci.yml": "W1-pinned", "App.tsx": "A2-prime", "spec.ts": "S0" });
    const plan = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: before,
      head,
      next,
    });
    // ci.yml: both pinned it to the same bytes. old.ts: both deleted it.
    expect(plan).toEqual({
      kind: "merge",
      overlay: [],
      preserved: ["ci.yml", "old.ts"],
      agreed: ["ci.yml", "old.ts"],
      textMerges: [],
    });
  });

  it("does not read the same bytes under a different mode as agreement", () => {
    const b = listing({ "run.sh": "S0" });
    const h: Listing = { ...listing({ "run.sh": "S1" }), modes: new Map([["run.sh", "100644"]]) };
    const n = listing({ "run.sh": "S1" }); // 100755
    const plan = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: b,
      head: h,
      next: n,
    });
    expect(plan.kind).toBe("defer");
  });

  it("defers on a deletion against an edit, and on two different additions", () => {
    const deletedByHand = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: listing({ "x.ts": "X0" }),
      head: listing({}),
      next: listing({ "x.ts": "X2-prime" }),
    });
    expect(deletedByHand.kind).toBe("defer");
    const deletedByPrime = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: listing({ "x.ts": "X0" }),
      head: listing({ "x.ts": "X1-hand" }),
      next: listing({}),
    });
    expect(deletedByPrime.kind).toBe("defer");
    const addedTwice = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: listing({}),
      head: listing({ "new.ts": "N1-hand" }),
      next: listing({ "new.ts": "N2-prime" }),
    });
    expect(addedTwice.kind).toBe("defer");
    if (addedTwice.kind === "defer") expect(addedTwice.why).toContain("no text merge can settle");
  });

  it("defers when more paths need a merge than a refresh merges", () => {
    const n = MAX_REFRESH_TEXT_MERGES + 1;
    const paths = Array.from({ length: n }, (_, i) => `f${i}.ts`);
    const plan = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: listing(Object.fromEntries(paths.map((p) => [p, "B"]))),
      head: listing(Object.fromEntries(paths.map((p) => [p, `H-${p}`]))),
      next: listing(Object.fromEntries(paths.map((p) => [p, `P-${p}`]))),
    });
    expect(plan.kind).toBe("defer");
    if (plan.kind === "defer")
      expect(plan.why).toContain(`more than the ${MAX_REFRESH_TEXT_MERGES}`);
  });
});

describe("merging a path both changed", () => {
  const candidate: TextMergeCandidate = {
    path: ".github/workflows/pdf-extraction-v3-gates.yml",
    mode: "100644",
    base: "b",
    ours: "o",
    theirs: "t",
  };
  // The case that motivated it, in the shape of the real file: a hand commit
  // pinned an action, and prime then pinned it the same way AND changed a
  // later step. (Measured on the real three versions of
  // pdf-extraction-v3-gates.yml, 19 Oct 2026: clean, and exactly prime's text.)
  const lines = (...xs: string[]) => xs.join("\n") + "\n";
  const base = lines(
    "steps:",
    "  - uses: actions/checkout@v7",
    "  - run: npm install --no-audit --no-fund",
    "  - run: npx playwright install chromium",
  );
  const ours = lines(
    "steps:",
    "  - uses: actions/checkout@3d3c42e # v7",
    "  - run: npm install --no-audit --no-fund",
    "  - run: npx playwright install chromium",
  );
  const theirs = lines(
    "steps:",
    "  - uses: actions/checkout@3d3c42e # v7",
    "  - run: npm install --no-audit --no-fund",
    "  - run: npx playwright install --with-deps chromium",
  );

  it("takes prime's text where the hand change is part of prime's", () => {
    expect(decideRefreshTextMerge(candidate, { base, ours, theirs })).toEqual({
      path: candidate.path,
      act: "write",
      text: theirs,
    });
  });

  it("keeps both sides where they changed different lines", () => {
    const handOnly = base + "  - run: echo hand\n";
    const primeOnly = ours;
    expect(decideRefreshTextMerge(candidate, { base, ours: handOnly, theirs: primeOnly })).toEqual({
      path: candidate.path,
      act: "write",
      text: ours + "  - run: echo hand\n",
    });
  });

  it("holds a change that touches the hand's own hunk, as a variant merge would", () => {
    // Adjacent lines are one hunk: the conservative reading, kept on purpose.
    const tight = lines(
      "steps:",
      "  - uses: actions/checkout@v7",
      "  - run: npx playwright install chromium",
    );
    const verdict = decideRefreshTextMerge(candidate, {
      base: tight,
      ours: tight.replace("@v7", "@3d3c42e # v7"),
      theirs: tight
        .replace("@v7", "@3d3c42e # v7")
        .replace("install chromium", "install --with-deps chromium"),
    });
    expect(verdict.act).toBe("hold");
  });

  it("holds a conflicting hunk, an unread text and an oversize one", () => {
    const conflict = decideRefreshTextMerge(candidate, {
      base,
      ours: base.replace("@v7", "@aaaaaaa"),
      theirs: base.replace("@v7", "@bbbbbbb"),
    });
    expect(conflict).toMatchObject({ act: "hold" });
    if (conflict.act === "hold") expect(conflict.why).toContain("1 hunk(s)");
    expect(decideRefreshTextMerge(candidate, { base, ours: null, theirs })).toMatchObject({
      act: "hold",
    });
    const huge = "x".repeat(MAX_REFRESH_MERGE_CHARS + 1);
    expect(
      decideRefreshTextMerge(candidate, { base: huge, ours: huge + "a", theirs: huge + "b" }),
    ).toMatchObject({ act: "hold" });
  });
});

describe("completing the plan", () => {
  const plan = planRefreshOverHumanWork({
    commits: [statement, reconcile],
    statement: listing({ "a.ts": "A0", "m.ts": "M0", "z.ts": "Z0" }),
    head: listing({ "a.ts": "A1-hand", "m.ts": "M1-hand", "z.ts": "Z1-hand" }),
    next: listing({ "a.ts": "A0", "m.ts": "M2-prime", "z.ts": "Z1-hand" }),
  });
  if (plan.kind !== "merge") throw new Error("expected a merge plan");
  const write = { path: "m.ts", act: "write" as const, text: "merged" };

  it("overlays a stored merge beside the kept paths, in path order", () => {
    expect(completeRefreshPlan(plan, [{ verdict: write, stored: "MERGED" }])).toEqual({
      kind: "merge",
      overlay: [
        { path: "a.ts", mode: "100644", sha: "A1-hand" },
        { path: "m.ts", mode: "100644", sha: "MERGED" },
      ],
      preserved: ["a.ts", "m.ts", "z.ts"],
      agreed: ["z.ts"],
      textMerges: [],
    });
  });

  it("defers the whole refresh on a hold, a merge it could not store, or one never settled", () => {
    expect(
      completeRefreshPlan(plan, [
        {
          verdict: { path: "m.ts", act: "hold", why: "2 hunk(s) of `m.ts` changed differently" },
          stored: null,
        },
      ]),
    ).toEqual({ kind: "defer", why: "2 hunk(s) of `m.ts` changed differently" });
    expect(completeRefreshPlan(plan, [{ verdict: write, stored: null }]).kind).toBe("defer");
    expect(completeRefreshPlan(plan, []).kind).toBe("defer");
  });
});

describe("npc-client-dashboard #379, 19 Oct 2026", () => {
  // The shape measured on the live proposal: the hand commits pinned the
  // workflows byte for byte as prime's own pull request did, and reconciled
  // the held App.tsx to exactly what the engine's variant merge then
  // computed. Prime merged the pins, and then changed one pinned workflow
  // again. The refresh used to defer on all of them.
  const workflows = Array.from({ length: 29 }, (_, i) => `.github/workflows/w${i}.yml`);
  const gate = ".github/workflows/pdf-extraction-v3-gates.yml";
  const at = (fn: (p: string) => string) => Object.fromEntries(workflows.map((p) => [p, fn(p)]));
  const statementTree = listing({
    ...at(() => "unpinned"),
    [gate]: "G-unpinned",
    "src/App.tsx": "A-held",
    "README.md": "R",
  });
  const headTree = listing({
    ...at((p) => `pinned-${p}`),
    [gate]: "G-pinned",
    "src/App.tsx": "A-reconciled",
    "README.md": "R",
  });

  it("refreshes onto prime's pins without a merge, where prime landed the same bytes", () => {
    const next = listing({
      ...at((p) => `pinned-${p}`),
      [gate]: "G-pinned",
      "src/App.tsx": "A-reconciled",
      "README.md": "R2",
    });
    const plan = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: statementTree,
      head: headTree,
      next,
    });
    expect(plan).toMatchObject({ kind: "merge", overlay: [], textMerges: [] });
    if (plan.kind === "merge") expect(plan.agreed).toHaveLength(31);
  });

  it("asks for one merge, and only one, once prime changes a pinned workflow again", () => {
    const next = listing({
      ...at((p) => `pinned-${p}`),
      [gate]: "G-pinned-with-deps",
      "src/App.tsx": "A-reconciled",
      "README.md": "R2",
    });
    const plan = planRefreshOverHumanWork({
      commits: [statement, reconcile],
      statement: statementTree,
      head: headTree,
      next,
    });
    expect(plan).toMatchObject({ kind: "merge", overlay: [] });
    if (plan.kind === "merge") {
      expect(plan.agreed).toHaveLength(30);
      expect(plan.textMerges.map((m) => m.path)).toEqual([gate]);
    }
  });
});
