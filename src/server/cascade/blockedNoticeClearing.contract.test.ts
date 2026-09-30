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
import { stripComments } from "../sourceComments.pure";

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
const clear = drain.slice(
  drain.indexOf("async function clearBlockedNotifications("),
  drain.indexOf("async function clearNoticesForClosedProposals("),
);

describe("a proposal the drain reads closed clears its own alarm", () => {
  it("clears on every close, not only on a merge this drain performed", () => {
    // The clear used to sit inside `if (mergedNow)`, so a proposal merged by a
    // person, or declined, left its notice standing for ever.
    expect(handleOne).toMatch(
      /if \(facts\.state === "closed"\) \{\s*if \(await clearBlockedNotifications\(supabase, cloneId, number\)\) noticeCleared\(\);\s*\}/,
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

describe("a clear on the per-proposal path is counted like the sweep's", () => {
  it("hands every read a callback that adds to the run's count", () => {
    // Counting only the sweep's clears reported `noticesCleared: 0` for the
    // ordinary case — a proposal closed while still recorded as open — and a
    // pull request that closed between the list and the read cleared its
    // notice with no audit row at all.
    expect(perClone).toMatch(/noticeCleared: \(\) => \{\s*report\.noticesCleared \+= 1;\s*\}/);
  });

  it("adds to the run's count only after the await, never across it", () => {
    // `x += await f()` reads x before the await and writes it after, and the
    // per-clone worker runs for several clones at once — so two clones'
    // counts overwrite each other. Measured on the first production run: four
    // pull requests' notices cleared, `noticesCleared: 3` reported.
    expect(perClone).toMatch(/report\.noticesCleared \+= cleared;/);
    // Code only: the comment beside the fix quotes the form it replaced.
    expect(stripComments(perClone)).not.toMatch(/[-+*/]=\s*await\b/);
    expect(drain).toMatch(/mapWithConcurrencyUntil\(\s*eligible,/);
  });

  it("counts a notice taken down, never an update that matched nothing", () => {
    // Most closed proposals never raised a notice. An update that matched no
    // row succeeds just the same, so the rows that came back are the answer.
    expect(clear).toMatch(/\.is\("read_at", null\)\s*\.select\("id"\);/);
    expect(clear).toMatch(/return \(data \?\? \[\]\)\.length > 0;/);
    expect(clear).not.toMatch(/return true;/);
  });
});

describe("an alarm this pass did not read is looked up once", () => {
  it("runs for every clone, after the pull-request loop and before the visit stamp", () => {
    const loopEndAt = perClone.lastIndexOf("report.detail.push({ clone: label, pr: number");
    const sweepAt = perClone.indexOf("await clearNoticesForClosedProposals(");
    const stampAt = perClone.indexOf("merge_drain_at:");
    expect(sweepAt).toBeGreaterThan(loopEndAt);
    expect(stampAt).toBeGreaterThan(sweepAt);
  });

  it("is asked only inside the budget, and skips what the work list will read anyway", () => {
    expect(perClone).toMatch(
      /if \(!isPastDeadline\(\)\) \{[\s\S]*?const cleared = await clearNoticesForClosedProposals\(/,
    );
    // What was READ, never `all`: a proposal the cap left out is on the work
    // list and unread, and passing `all` let its alarm stand for as long as
    // twenty-five newer proposals stayed open ahead of it.
    expect(perClone).toMatch(/alreadyRead: read,/);
    expect(perClone).not.toMatch(/new Set\(all\)/);
    // Recorded as read only once `handleOne` has returned — it reads the pull
    // request first, and a call that threw may not have got that far.
    const callAt = perClone.indexOf("await handleOne(");
    const readAt = perClone.indexOf("read.add(number);");
    const pushAt = perClone.indexOf("report.detail.push(outcome);");
    expect(readAt).toBeGreaterThan(callAt);
    expect(pushAt).toBeGreaterThan(readAt);
    expect(sweep).toMatch(/if \(isPastDeadline\(\)\) break;/);
  });

  it("clears only a pull request it READ as closed", () => {
    expect(sweep).toMatch(/blockedNoticesToRecheck\(notices, \{ owner, repo, alreadyRead \}\)/);
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
