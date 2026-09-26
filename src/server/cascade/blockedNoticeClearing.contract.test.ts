/**
 * A blocked notice clears when its pull request closes — however it closes.
 *
 * Structural, like the drain's other contracts: exercising the drain for real
 * needs a token that can merge in production repositories, which is exactly
 * what a test must not hold. The decision about WHICH notices to read is pure
 * and exercised in `blockedEscalation.test.ts`.
 *
 * Measured before this: unread `cascade_blocked` notices over #115 (NPC
 * Test) and #114 (Preflight), both closed unmerged on 20 Sep 2026, over #23
 * on the independent, closed unmerged on 24 Sep, and over #11 there, merged
 * outside the drain on 20 Sep — and the blockage ledger reporting `ci_red` on
 * all three clones for as long as those notices stood.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const drain = read("src/server/cascadeMergeDrain.server.ts");
const hook = read("src/routes/hooks.cascade-merge-drain.tsx");

const handleOne = drain.slice(
  drain.indexOf("async function handleOne("),
  drain.indexOf("async function raiseBlockedNotification("),
);
const perClone = drain.slice(drain.indexOf("const perClone ="), drain.indexOf("const pass ="));
const sweep = drain.slice(
  drain.indexOf("async function clearNoticesForClosedProposals("),
  drain.indexOf("async function writeReconciliation("),
);

describe("a proposal the drain reads closed clears its own alarm", () => {
  it("clears on every close, not only on a merge this drain performed", () => {
    // The clear used to sit inside `if (mergedNow)`, so a proposal merged by a
    // person, or declined, left its notice standing for ever.
    expect(handleOne).toMatch(
      /if \(facts\.state === "closed"\) \{\s*await clearBlockedNotifications\(supabase, cloneId, number\);\s*\}/,
    );
    // `mergedNow` sets `facts.state` to closed, so the merge is still covered.
    expect(handleOne).toMatch(/facts = \{ state: "closed", merged: true/);
    // And the clear is not nested under the merge any longer.
    const mergedBranch = handleOne.slice(handleOne.indexOf("if (mergedNow) {"));
    expect(mergedBranch.slice(0, mergedBranch.indexOf("}"))).not.toMatch(
      /clearBlockedNotifications/,
    );
  });
});

describe("an alarm the work list no longer carries is looked up once", () => {
  it("runs for every clone, after the pull-request loop and before the visit stamp", () => {
    const loopEndAt = perClone.lastIndexOf("report.detail.push({ clone: label, pr: number");
    const sweepAt = perClone.indexOf("await clearNoticesForClosedProposals(");
    const stampAt = perClone.indexOf("merge_drain_at:");
    expect(sweepAt).toBeGreaterThan(loopEndAt);
    expect(stampAt).toBeGreaterThan(sweepAt);
  });

  it("is asked only inside the budget, and skips what the work list will read anyway", () => {
    expect(perClone).toMatch(
      /if \(!isPastDeadline\(\)\) \{\s*report\.noticesCleared \+= await clearNoticesForClosedProposals\(/,
    );
    // `all`, not the capped `numbers`: a proposal beyond this run's cap is
    // still the per-proposal handling's to read on a later run.
    expect(perClone).toMatch(/workList: new Set\(all\)/);
    expect(sweep).toMatch(/if \(isPastDeadline\(\)\) break;/);
  });

  it("clears only a pull request it READ as closed", () => {
    expect(sweep).toMatch(/blockedNoticesToRecheck\(notices, \{ owner, repo, workList \}\)/);
    expect(sweep).toMatch(/octokit\.pulls\.get\(\{ owner, repo, pull_number: number \}\)/);
    const readAt = sweep.indexOf("octokit.pulls.get(");
    const guardAt = sweep.indexOf('if (pr.state !== "closed") continue;');
    const clearAt = sweep.indexOf(
      "if (await clearBlockedNotifications(supabase, cloneId, number)) cleared += 1;",
    );
    expect(readAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(readAt);
    expect(clearAt).toBeGreaterThan(guardAt);
  });

  it("never fails the drain", () => {
    // Every GitHub read is caught per pull request, and the whole sweep is
    // caught too — the raise and the clear beside it follow the same rule.
    expect(sweep).toMatch(/let cleared = 0;\s*try \{/);
    expect(sweep).toMatch(/\} catch \(e\) \{\s*console\.error\("\[merge-drain\] could not read/);
    expect(sweep).toMatch(
      /\} catch \(e\) \{\s*console\.error\("\[merge-drain\] standing-notice sweep failed:", e\);\s*\}\s*return cleared;/,
    );
    expect(sweep).not.toMatch(/\bthrow\b/);
  });

  it("reads only unread notices of this kind, for this clone", () => {
    expect(sweep).toMatch(/\.eq\("kind", "cascade_blocked"\)/);
    expect(sweep).toMatch(/\.eq\("clone_id", cloneId\)/);
    expect(sweep).toMatch(/\.is\("read_at", null\)/);
  });
});

describe("a cleared alarm is on the record", () => {
  it("files an audit row when the drain took a standing notice down", () => {
    expect(hook).toMatch(/report\.noticesCleared > 0 \|\|/);
  });
});
