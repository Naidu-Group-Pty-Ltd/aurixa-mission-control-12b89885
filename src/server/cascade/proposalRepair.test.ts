import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decideProposalRepair,
  describeRepair,
  ENGINE_COMMIT_PREFIX,
  isEngineOnlyBranch,
  MAX_REPAIRS,
} from "./proposalRepair.pure";

/** Verbatim: the only commit on PR #71's branch, as GitHub reported it. */
const ENGINE_COMMIT = {
  message: "chore(aurixa): cascade 17 file(s) from prime@fc01e33",
  authorLogin: "aurixa-mission-control[bot]",
};

describe("telling the engine's own branch from one somebody has touched", () => {
  it("recognises the single generated commit a cascade writes", () => {
    expect(isEngineOnlyBranch([ENGINE_COMMIT])).toBe(true);
    expect(ENGINE_COMMIT.message.startsWith(ENGINE_COMMIT_PREFIX)).toBe(true);
  });

  it("refuses a branch carrying a second commit", () => {
    // The pull request body asks for exactly this: "Add the import and its use
    // to the held file in the same merge." Regenerating force-overwrites the
    // branch, so doing it here destroys an operator's work with no warning and
    // no way back through the UI.
    expect(isEngineOnlyBranch([ENGINE_COMMIT, { message: "Wire up the AUSTRAC routes" }])).toBe(
      false,
    );
  });

  it("refuses a commit that is not the engine's, even alone", () => {
    expect(isEngineOnlyBranch([{ message: "fix: bring the routes across" }])).toBe(false);
  });

  it("refuses an empty branch rather than guessing", () => {
    expect(isEngineOnlyBranch([])).toBe(false);
  });
});

describe("deciding what to do with an open proposal", () => {
  const engine = [ENGINE_COMMIT];

  it("does nothing to a proposal that merges cleanly", () => {
    expect(decideProposalRepair({ mergeable: true, commits: engine, attempts: 0 }).act).toBe("none");
  });

  it("does nothing while GitHub is still computing mergeability", () => {
    // `null` is not `false`. GitHub works mergeability out asynchronously after
    // a push, and reading unknown as conflicted would regenerate a healthy
    // proposal on every tick — resetting its CI each time, on every clone.
    for (const unknown of [null, undefined]) {
      const d = decideProposalRepair({ mergeable: unknown, commits: engine, attempts: 0 });
      expect(d.act).toBe("none");
      expect(d.why).toContain("not finished computing");
    }
  });

  it("regenerates a conflicted proposal that is still all the engine's", () => {
    const d = decideProposalRepair({ mergeable: false, commits: engine, attempts: 0 });
    expect(d.act).toBe("regenerate");
    // The reason names the ACT as a rebuild and says the conflict goes away by
    // construction — it must not offer resolution as the thing being done. A
    // bare "does not contain resolv" would fail on the sentence that disclaims
    // it, which is the sentence worth keeping.
    expect(d.why).toContain("Rebuilding it on the current head");
    expect(d.why).toContain("by construction rather than resolving it");
  });

  it("never regenerates a branch a person has committed to", () => {
    const d = decideProposalRepair({
      mergeable: false,
      commits: [ENGINE_COMMIT, { message: "Bring the AUSTRAC routes across by hand" }],
      attempts: 0,
    });
    expect(d).toMatchObject({ act: "hold", reason: "human_edits" });
    expect(d.why).toContain("destroy");
  });

  it("puts the human check BEFORE the attempt cap", () => {
    // A branch somebody edited must be held for THAT reason, whatever the
    // attempt count says — "attempts exhausted" would send an operator looking
    // for a flapping branch instead of at their own commit.
    const d = decideProposalRepair({
      mergeable: false,
      commits: [ENGINE_COMMIT, { message: "hand fix" }],
      attempts: 99,
    });
    expect(d).toMatchObject({ act: "hold", reason: "human_edits" });
  });

  it("stops after the cap rather than looping", () => {
    // A repair loop burns CI on every clone at once, which is far worse than
    // one stuck pull request.
    const d = decideProposalRepair({ mergeable: false, commits: engine, attempts: MAX_REPAIRS });
    expect(d).toMatchObject({ act: "hold", reason: "attempts_exhausted" });
    expect(d.why).toContain("faster than a cascade can finish");
  });

  it("still regenerates on the last attempt below the cap", () => {
    expect(
      decideProposalRepair({ mergeable: false, commits: engine, attempts: MAX_REPAIRS - 1 }).act,
    ).toBe("regenerate");
  });

  it("honours a caller-supplied cap", () => {
    expect(
      decideProposalRepair({ mergeable: false, commits: engine, attempts: 1, maxAttempts: 1 }).act,
    ).toBe("hold");
  });
});

describe("what an operator is told", () => {
  it("names the pull request and what happened to it", () => {
    const line = describeRepair(
      71,
      decideProposalRepair({ mergeable: false, commits: [ENGINE_COMMIT], attempts: 0 }),
    );
    expect(line).toContain("PR #71");
    expect(line).toContain("rebuilt");
  });

  it("names the reason a held proposal is held", () => {
    const line = describeRepair(
      71,
      decideProposalRepair({
        mergeable: false,
        commits: [ENGINE_COMMIT, { message: "hand fix" }],
        attempts: 0,
      }),
    );
    expect(line).toContain("needs a person");
    expect(line).toContain("human edits");
  });
});

describe("the rule the repair path may never break", () => {
  const repair = readFileSync(
    join(process.cwd(), "src/server/cascadeProposalRepair.server.ts"),
    "utf8",
  );

  it("checks the branch is the engine's before it rebuilds anything", () => {
    // Asserted against the source: exercising it would need a token that can
    // force-push to production repositories, which is what a test must not
    // hold. The ordering is the safety property — a rebuild that happened
    // before the check would already have overwritten the commit it protects.
    const decideAt = repair.indexOf("decideProposalRepair(");
    const buildAt = repair.indexOf("regenerateCloneProposal(");
    expect(decideAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(decideAt);
  });

  it("reads the branch's commits rather than assuming", () => {
    expect(repair).toContain("listCommits");
  });

  it("never resolves a conflict itself", () => {
    // No side-picking, anywhere. The whole point is that regeneration removes
    // the conflict by construction, so there is never a side to choose.
    for (const forbidden of ["theirs", "ours", "-X ", "conflictResolution", "mergeStrategy"]) {
      expect(repair).not.toContain(forbidden);
    }
  });
});
