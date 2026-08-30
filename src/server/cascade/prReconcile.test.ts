import { describe, it, expect } from "vitest";
import {
  cascadeEventStatus,
  countResults,
  durableSummary,
  parsePrNumber,
  parsePrRepo,
  reconcileResultToPr,
  summariseCascade,
} from "./prReconcile.pure";
import { RECONCILE_MARKER, summaryOwesReconcile } from "./syncExclusions.pure";

// The real row, verbatim, as the engine wrote it for pull request #67 —
// merged by the drain at 08:35 and still reading `pr_opened` an hour later.
const REAL_SUMMARY =
  "PR #67 opened: CLAUDE.md, docs/aml/AUSTRAC_LODGEMENT_PATH.md, " +
  "public/brand/aurixa-emblem-240.png, src/components/aml/AustracReportPathCard.tsx, " +
  "src/lib/aml/austracBundleRecord.pure.ts (+4 more) · 19 withheld · 6 need reconciling";

describe("finding the pull request a row is about", () => {
  it("reads the number out of the URL the engine stores", () => {
    expect(parsePrNumber("https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/67")).toBe(
      67,
    );
  });

  it("reads the owner and repo too", () => {
    expect(parsePrRepo("https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/67")).toEqual(
      { owner: "Naidu-Group-Pty-Ltd", repo: "npc-client-dashboard" },
    );
  });

  it("tolerates a trailing path, query or fragment", () => {
    expect(parsePrNumber("https://github.com/o/r/pull/12/files")).toBe(12);
    expect(parsePrNumber("https://github.com/o/r/pull/12?w=1")).toBe(12);
    expect(parsePrNumber("https://github.com/o/r/pull/12#issuecomment-1")).toBe(12);
  });

  it("returns null rather than guessing", () => {
    // Reconciling the WRONG pull request would stamp a merge onto a record
    // that never had one, so anything unparseable has to be left alone.
    for (const bad of [null, undefined, "", "not a url", "https://github.com/o/r/issues/12"]) {
      expect(parsePrNumber(bad)).toBeNull();
    }
  });
});

describe("a merged pull request", () => {
  const merged = reconcileResultToPr({
    pr: { state: "closed", merged: true, mergeCommitSha: "b3453d0ffffffffffffffffffffffffffffffff" },
    currentSummary: REAL_SUMMARY,
  });

  it("becomes a succeeded result carrying the merge commit", () => {
    expect(merged.status).toBe("succeeded");
    expect(merged.commitSha).toBe("b3453d0");
    expect(merged.changed).toBe(true);
  });

  it("moves the clone's pointer, because code reached its default branch", () => {
    expect(merged.advanceClone).toBe(true);
  });

  it("keeps every word of what the cascade actually carried", () => {
    expect(merged.diffSummary).toContain("Merged as b3453d0.");
    expect(merged.diffSummary).toContain("PR #67 opened:");
    expect(merged.diffSummary).toContain("19 withheld");
    expect(merged.diffSummary).toContain("6 need reconciling");
  });

  it("still owes a hand-reconcile, because merging did not do that work", () => {
    // The held files are exactly the ones the merge did NOT carry, so a merge
    // must never clear this marker.
    expect(summaryOwesReconcile(merged.diffSummary)).toBe(true);
    expect(merged.diffSummary).toContain(RECONCILE_MARKER);
  });

  it("says so even when GitHub gives no merge commit", () => {
    const m = reconcileResultToPr({
      pr: { state: "closed", merged: true, mergeCommitSha: null },
      currentSummary: REAL_SUMMARY,
    });
    expect(m.status).toBe("succeeded");
    expect(m.commitSha).toBeNull();
    expect(m.diffSummary.startsWith("Merged.")).toBe(true);
  });
});

describe("a pull request somebody closed", () => {
  const closed = reconcileResultToPr({
    pr: { state: "closed", merged: false },
    currentSummary: REAL_SUMMARY,
  });

  it("is skipped and never failed", () => {
    // Nothing failed. Colouring the fleet red over a decision an operator made
    // on purpose is worse than useless.
    expect(closed.status).toBe("skipped");
    expect(closed.diffSummary).toContain("declined");
  });

  it("does not move the clone's pointer", () => {
    expect(closed.advanceClone).toBe(false);
  });
});

describe("a pull request that is still open", () => {
  it("keeps its status and takes the CURRENT reason", () => {
    const open = reconcileResultToPr({
      pr: { state: "open", merged: false },
      currentSummary: REAL_SUMMARY,
      openReason: "verify is still running",
    });
    expect(open.status).toBe("pr_opened");
    expect(open.diffSummary).toContain("Open · verify is still running.");
    expect(open.diffSummary).toContain("PR #67 opened:");
    expect(open.advanceClone).toBe(false);
  });

  it("replaces the reason rather than stacking reasons", () => {
    // The defect this closes: the row kept "No check has reported on this pull
    // request" long after every check had reported.
    const first = reconcileResultToPr({
      pr: { state: "open", merged: false },
      currentSummary: REAL_SUMMARY,
      openReason: "no check has reported yet",
    });
    const second = reconcileResultToPr({
      pr: { state: "open", merged: false },
      currentSummary: first.diffSummary,
      openReason: "verify is still running",
    });
    expect(second.diffSummary).not.toContain("no check has reported yet");
    expect(second.diffSummary).toContain("Open · verify is still running.");
    expect(second.diffSummary).toContain("PR #67 opened:");
  });

  it("writes nothing when the reason has not changed", () => {
    // Every clone page holds a realtime subscription on this table. An
    // identical rewrite every five minutes is churn nobody asked for.
    const first = reconcileResultToPr({
      pr: { state: "open", merged: false },
      currentSummary: REAL_SUMMARY,
      openReason: "verify is still running",
    });
    const again = reconcileResultToPr({
      pr: { state: "open", merged: false },
      currentSummary: first.diffSummary,
      openReason: "verify is still running",
    });
    expect(again.changed).toBe(false);
  });

  it("has something to say even with no reason offered", () => {
    const open = reconcileResultToPr({
      pr: { state: "open", merged: false },
      currentSummary: REAL_SUMMARY,
    });
    expect(open.diffSummary).toContain("Open · awaiting checks.");
  });

  it("merging after that leaves no trace of the open reason", () => {
    const open = reconcileResultToPr({
      pr: { state: "open", merged: false },
      currentSummary: REAL_SUMMARY,
      openReason: "verify is still running",
    });
    const merged = reconcileResultToPr({
      pr: { state: "closed", merged: true, mergeCommitSha: "abc1234" },
      currentSummary: open.diffSummary,
    });
    expect(merged.diffSummary).not.toContain("still running");
    expect(merged.diffSummary.startsWith("Merged as abc1234.")).toBe(true);
    expect(merged.diffSummary).toContain("PR #67 opened:");
  });
});

describe("the durable half of a summary", () => {
  it("leaves a row this module has never touched exactly as it is", () => {
    // Every row written before this shipped. Losing the file list to a parser
    // that did not recognise it would destroy the only record of what a
    // cascade carried.
    expect(durableSummary(REAL_SUMMARY)).toBe(REAL_SUMMARY);
  });

  it("leaves the engine's own volatile-looking prose alone", () => {
    const legacy =
      "No check has reported on this pull request — nothing has built this tree. CLAUDE.md · 19 withheld";
    expect(durableSummary(legacy)).toBe(legacy);
  });

  it("is idempotent", () => {
    const once = durableSummary(`Merged as abc1234. ${REAL_SUMMARY}`);
    expect(durableSummary(once)).toBe(once);
    expect(once).toBe(REAL_SUMMARY);
  });

  it("clears a stack of outcomes an earlier version could have left", () => {
    expect(durableSummary(`Merged as abc1234. Open · verify is running. ${REAL_SUMMARY}`)).toBe(
      REAL_SUMMARY,
    );
  });

  it("handles an empty or absent summary", () => {
    expect(durableSummary(null)).toBe("");
    expect(durableSummary("")).toBe("");
    expect(
      reconcileResultToPr({
        pr: { state: "closed", merged: true, mergeCommitSha: "abc1234" },
        currentSummary: null,
      }).diffSummary,
    ).toBe("Merged as abc1234.");
  });
});

describe("the event summary, recounted", () => {
  const rows = [
    { status: "succeeded", diff_summary: `Merged as abc1234. x · 6 ${RECONCILE_MARKER}` },
    { status: "pr_opened", diff_summary: "Open · verify is still running. y" },
    { status: "skipped", diff_summary: "Already proposed" },
  ];

  it("is composed in one place, so two writers cannot disagree", () => {
    const counts = countResults(rows, summaryOwesReconcile);
    expect(summariseCascade(counts)).toBe(
      "1 merged · 1 PRs · 0 failed · 1 skipped (of 3) · 1 awaiting manual reconcile",
    );
  });

  it("reproduces the shape the engine has always written", () => {
    expect(
      summariseCascade({ succeeded: 0, opened: 1, failed: 0, skipped: 0, total: 1, owedReconcile: 1 }),
    ).toBe("0 merged · 1 PRs · 0 failed · 0 skipped (of 1) · 1 awaiting manual reconcile");
  });

  it("drops the reconcile clause when nothing is owed", () => {
    expect(
      summariseCascade({ succeeded: 1, opened: 0, failed: 0, skipped: 0, total: 1, owedReconcile: 0 }),
    ).toBe("1 merged · 0 PRs · 0 failed · 0 skipped (of 1)");
  });

  it("keeps counting the reconcile debt after a merge", () => {
    // A merge carries the files it was allowed to carry. The held ones are
    // exactly the files it did NOT, so landing must never clear the debt.
    const counts = countResults([rows[0]], summaryOwesReconcile);
    expect(counts.owedReconcile).toBe(1);
  });

  it("derives the event status the engine's rule gives", () => {
    expect(cascadeEventStatus({ succeeded: 1, opened: 0, failed: 0 })).toBe("completed");
    expect(cascadeEventStatus({ succeeded: 0, opened: 0, failed: 1 })).toBe("failed");
    expect(cascadeEventStatus({ succeeded: 1, opened: 0, failed: 1 })).toBe("partial");
    // A run that opened a pull request and failed elsewhere is partial, not
    // failed: something is live and waiting.
    expect(cascadeEventStatus({ succeeded: 0, opened: 1, failed: 1 })).toBe("partial");
  });
});
