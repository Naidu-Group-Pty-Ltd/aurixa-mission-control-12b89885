import { describe, it, expect } from "vitest";
import {
  cascadeEventStatus,
  countResults,
  durableSummary,
  openSentence,
  parsePrNumber,
  parsePrRepo,
  reconcileResultToPr,
  summariseCascade,
} from "./prReconcile.pure";
import { RECONCILE_MARKER, summaryOwesReconcile } from "./syncExclusions.pure";
import {
  BASE_BROKEN_REMEDY,
  CHECKS_PERMISSION_REMEDY,
  NEVER_STARTED_REMEDY,
  decideCascadeMerge,
  reclassifyAgainstBase,
} from "./autoMergeGate.pure";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

  it("strips the reasons the ENGINE used to bake in", () => {
    // Verbatim from production. Reconciling these rows first time round
    // produced `Merged as 6eaaf5a. No check has reported on this pull
    // request — nothing has built this tree.`, which contradicts itself in
    // one sentence — the exact class of defect this module exists to remove.
    const real =
      "Merged as 6eaaf5a. No check has reported on this pull request — nothing has " +
      "built this tree. .github/workflows/ci.yml, CLAUDE.md · 19 withheld · 6 need reconciling";
    expect(durableSummary(real)).toBe(
      ".github/workflows/ci.yml, CLAUDE.md · 19 withheld · 6 need reconciling",
    );
  });

  it("strips a legacy reason under one of this module's own", () => {
    const real =
      "Open · Not merging yet — 1 check(s) still running: verify. " +
      "No check has reported on this pull request — nothing has built this tree. CLAUDE.md";
    expect(durableSummary(real)).toBe("CLAUDE.md");
  });

  it("strips every shape `decideCascadeMerge` composes", () => {
    // A closed vocabulary this codebase writes — recognising it is recognising
    // our own output, not parsing English.
    const cases = [
      "Not merging — verify, security have not reported yet.",
      "Not merging — 2 check(s) failing: verify (failure), security (failure).",
      "Not merging yet — 1 check(s) still running: verify.",
      "All 4 check(s) passed.",
      "Queued for auto-merge once checks pass:",
      "Merged on green (All 4 check(s) passed.):",
    ];
    for (const reason of cases) {
      expect(durableSummary(`${reason} CLAUDE.md · 19 withheld`)).toBe("CLAUDE.md · 19 withheld");
    }
  });

  it("still refuses to touch prose it cannot identify", () => {
    // The rule that has not changed and must not: a summary this could not
    // identify is a summary it would DELETE, and the file list is the only
    // record of what a cascade carried. Only our own vocabulary is removed.
    const foreign = "Something nobody here ever wrote. CLAUDE.md · 19 withheld";
    expect(durableSummary(foreign)).toBe(foreign);
    const operator = "Skipped by operator";
    expect(durableSummary(operator)).toBe(operator);
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

describe("an open reason that runs to more than one sentence", () => {
  // Measured 8 Oct 2026: 162 merged rows, 3.97 million characters. The old
  // strip ended an open outcome at its first full stop, so a three-sentence
  // verdict left two behind as "detail" and every pass stacked another copy.
  const quick = (name: string) => ({
    name,
    status: "completed",
    conclusion: "failure",
    started_at: "2026-09-04T05:35:00Z",
    completed_at: "2026-09-04T05:35:04Z",
  });
  const slow = (name: string) => ({ ...quick(name), completed_at: "2026-09-04T05:41:00Z" });
  const neverStarted = decideCascadeMerge([quick("verify"), quick("security")]);
  const baseBroken = reclassifyAgainstBase(
    decideCascadeMerge([slow("verify"), slow("security")]),
    [slow("verify"), slow("security")],
    [slow("verify"), slow("security")],
    "main",
  );
  if (neverStarted.merge || baseBroken.merge) throw new Error("unreachable");

  const pass = (summary: string | null, why: string) =>
    reconcileResultToPr({
      pr: { state: "open", merged: false },
      currentSummary: summary,
      openReason: why,
    }).diffSummary;

  it("are really the verdicts the drain hands in", () => {
    expect(neverStarted.reason).toBe("never_started");
    expect(neverStarted.why).toContain(NEVER_STARTED_REMEDY);
    expect(baseBroken.reason).toBe("base_broken");
    expect(baseBroken.why).toContain(BASE_BROKEN_REMEDY);
  });

  for (const [label, why] of [
    ["never_started", neverStarted.why],
    ["base_broken", baseBroken.why],
    ["checks unreadable", CHECKS_PERMISSION_REMEDY],
  ] as const) {
    it(`is written as one sentence, every word kept (${label})`, () => {
      const sentence = openSentence(why);
      // One full stop followed by a space or the end, and it is the last one.
      expect(sentence.match(/\.(?=\s|$)/g)).toEqual(["."]);
      expect(sentence.endsWith(".")).toBe(true);
      const words = (t: string) => t.replace(/[.;]/g, " ").split(/\s+/).filter(Boolean);
      expect(words(sentence)).toEqual(["Open", "·", ...words(why)]);
    });

    it(`is stable across passes, and the file list survives (${label})`, () => {
      let summary: string = REAL_SUMMARY;
      for (let i = 0; i < 12; i++) summary = pass(summary, why);
      expect(summary).toBe(`${openSentence(why)} ${REAL_SUMMARY}`);
      expect(
        reconcileResultToPr({
          pr: { state: "open", merged: false },
          currentSummary: summary,
          openReason: why,
        }).changed,
      ).toBe(false);
    });

    it(`leaves nothing of itself once merged (${label})`, () => {
      const merged = reconcileResultToPr({
        pr: { state: "closed", merged: true, mergeCommitSha: "5d4f73d" },
        currentSummary: pass(REAL_SUMMARY, why),
      });
      expect(merged.diffSummary).toBe(`Merged as 5d4f73d. ${REAL_SUMMARY}`);
    });
  }

  it("shrinks a row the old strip let grow, to its outcome and its file list", () => {
    // Verbatim shape of row 8aee2e6c (279 copies) and ecec745f (two remedies,
    // interleaved), as the old strip left them.
    const files =
      "PR #13 opened: docs/reports/SECTION_OWNERSHIP_MATRIX.md · 2 withheld · 1 need reconciling";
    const grown = `Merged as 5d4f73d. ${`${BASE_BROKEN_REMEDY} `.repeat(279)}${files}`;
    expect(durableSummary(grown)).toBe(files);
    const mixed =
      `Merged as 51fc8bc. ${`${BASE_BROKEN_REMEDY} `.repeat(22)}` +
      `${`${NEVER_STARTED_REMEDY} `.repeat(137)}${files}`;
    expect(durableSummary(mixed)).toBe(files);
    const stillOpen =
      `${"Open · Not merging — 2 check(s) failing (verify, security), and every one of them is ALSO failing on `main`. "}` +
      `${`${BASE_BROKEN_REMEDY} `.repeat(5)}${files}`;
    expect(durableSummary(stillOpen)).toBe(files);
  });

  it("recognises every trailing run of their sentences, and nothing shorter", () => {
    const files = "CLAUDE.md · 19 withheld";
    const sentences = CHECKS_PERMISSION_REMEDY.split(/(?<=\.)\s+/);
    expect(sentences.length).toBeGreaterThan(1);
    for (let i = 0; i < sentences.length; i++) {
      expect(durableSummary(`${sentences.slice(i).join(" ")} ${files}`)).toBe(files);
    }
    // A sentence of ours that is not the END of one of these constants is
    // not something the old strip could have stranded, so it is kept.
    const head = BASE_BROKEN_REMEDY.split(/(?<=\.)\s+/)[0];
    expect(durableSummary(`${head} ${files}`)).toBe(`${head} ${files}`);
  });

  it("keeps a full stop inside a word, which is not a sentence break", () => {
    const sentence = openSentence("Not merging yet — 1 check(s) still running: lint.ts");
    expect(sentence).toBe("Open · Not merging yet — 1 check(s) still running: lint.ts.");
    expect(durableSummary(`${sentence} ${REAL_SUMMARY}`)).toBe(REAL_SUMMARY);
  });

  it("strips an outcome that has no file list behind it", () => {
    // Previously `\s+` was required after the outcome, so a bare one was kept
    // as detail and the next pass wrote `Merged as x. Merged as x.`.
    expect(durableSummary("Merged as abc1234.")).toBe("");
    expect(durableSummary(openSentence(BASE_BROKEN_REMEDY))).toBe("");
    const bare = reconcileResultToPr({
      pr: { state: "open", merged: false },
      currentSummary: openSentence("verify is still running"),
      openReason: "verify is still running",
    });
    expect(bare.changed).toBe(false);
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

describe("a row whose pull request lives somewhere else", () => {
  // Both real. This clone was re-pointed from a personal fork to the
  // organisation's own repository, and 48 historical cascade results still
  // carry the old URL.
  const OLD = "https://github.com/lavan96/npc-client-dashboard/pull/42";
  const NEW = "https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/pull/42";

  it("has the same number in both repositories", () => {
    // Which is the whole danger: `pull/42` in the new repository is a real,
    // unrelated pull request — a Dependabot one — and reconciling a cascade
    // from it would stamp a stranger's outcome onto this record.
    expect(parsePrNumber(OLD)).toBe(parsePrNumber(NEW));
  });

  it("is told apart by the repository the URL names", () => {
    expect(parsePrRepo(OLD)).toEqual({ owner: "lavan96", repo: "npc-client-dashboard" });
    expect(parsePrRepo(NEW)?.owner).toBe("Naidu-Group-Pty-Ltd");
  });

  it("is checked by the drain BEFORE it reads a pull request", () => {
    // Asserted against the source: exercising it would need a token that can
    // read production repositories, which is what a test must not hold.
    const drain = readFileSync(
      join(process.cwd(), "src/server/cascadeMergeDrain.server.ts"),
      "utf8",
    );
    const guardAt = drain.indexOf("parsePrRepo(");
    const readAt = drain.indexOf("octokit.pulls.get(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(readAt).toBeGreaterThan(guardAt);
    // And the guard has to compare BOTH halves; owner alone would let a
    // different repository under the same owner through.
    const guard = drain.slice(guardAt, guardAt + 400);
    expect(guard).toContain("at.owner !== owner");
    expect(guard).toContain("at.repo !== repo");
  });
});

describe("several rows sharing one pull request", () => {
  it("is the ordinary case, not an edge case", () => {
    // `pr` mode moves ONE proposal forward across many prime commits, so one
    // pull request accumulates a cascade result per commit — #55 carries
    // eleven and #62 eight. All of them landed when it merged.
    const drain = readFileSync(
      join(process.cwd(), "src/server/cascadeMergeDrain.server.ts"),
      "utf8",
    );
    // The map is number -> LIST, and the writer loops.
    expect(drain).toContain("rowsByPr = new Map<number, ResultRow[]>()");
    const writer = drain.slice(drain.indexOf("async function writeReconciliation"));
    expect(writer.slice(0, 1200)).toContain("for (const row of rows)");
  });

  it("reconciles each row against its own summary", () => {
    // They share a pull request and not a history: each carries the file list
    // of the cascade that wrote it, and a shared outcome must not flatten them
    // into one sentence.
    const a = reconcileResultToPr({
      pr: { state: "closed", merged: true, mergeCommitSha: "abc1234" },
      currentSummary: "PR #55 opened: alpha.ts",
    });
    const b = reconcileResultToPr({
      pr: { state: "closed", merged: true, mergeCommitSha: "abc1234" },
      currentSummary: "PR #55 updated: beta.ts",
    });
    expect(a.diffSummary).toContain("alpha.ts");
    expect(b.diffSummary).toContain("beta.ts");
    expect(a.status).toBe("succeeded");
    expect(b.status).toBe("succeeded");
  });
});
