import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { RequestError } from "@octokit/request-error";
import {
  describeNeverStartedRerun,
  NEVER_STARTED_RERUN_WINDOWS_MS,
  planNeverStartedRerun,
  rerunForbidden,
  rerunsSpent,
  workflowRunIdOf,
} from "./neverStartedRerun.pure";
import { checkNeverStarted, decideCascadeMerge, REQUIRED_CHECKS } from "./autoMergeGate.pure";
import { openSentence, durableSummary } from "./prReconcile.pure";
import { stripComments } from "../sourceComments.pure";

/*
  The shape measured on NPC Client Dashboard's cascade head bbf2f91, run
  37566131354, at 03:18Z on 7 Oct 2026: every job created, started and
  failed within three seconds, with no step run.
*/
const RUN = 37566131354;
const declinedAt = "2026-10-07T03:18:30Z";
const declinedCheck = (name: string, job: number) => ({
  name,
  status: "completed",
  conclusion: "failure",
  started_at: "2026-10-07T03:18:27Z",
  completed_at: declinedAt,
  details_url: `https://github.com/Naidu-Group-Pty-Ltd/npc-client-dashboard/actions/runs/${RUN}/job/${job}`,
});
const headChecks = [
  declinedCheck("verify", 112614154211),
  declinedCheck("security", 112614154194),
  declinedCheck("supply-chain", 112614154200),
];
const at = (iso: string, plusMs: number) => Date.parse(iso) + plusMs;

describe("the measured head", () => {
  it("is a never_started verdict, so it is the case this module serves", () => {
    const verdict = decideCascadeMerge(headChecks, REQUIRED_CHECKS);
    expect(verdict.merge).toBe(false);
    expect(!verdict.merge && verdict.reason).toBe("never_started");
    expect(headChecks.every(checkNeverStarted)).toBe(true);
  });
});

describe("workflowRunIdOf", () => {
  it("reads the run out of an Actions check run's link", () => {
    expect(workflowRunIdOf(headChecks[0].details_url)).toBe(RUN);
    expect(workflowRunIdOf(`https://github.com/o/r/actions/runs/${RUN}`)).toBe(RUN);
    expect(workflowRunIdOf(`https://github.com/o/r/actions/runs/${RUN}?pr=81`)).toBe(RUN);
  });

  it("names nothing for a check another app reported", () => {
    expect(workflowRunIdOf("https://vercel.com/team/project/abc")).toBeNull();
    expect(workflowRunIdOf(null)).toBeNull();
    expect(workflowRunIdOf(undefined)).toBeNull();
    expect(workflowRunIdOf("https://github.com/o/r/actions/runs/notanumber")).toBeNull();
  });
});

describe("rerunsSpent — GitHub's own count, per head", () => {
  it("is zero on a head that has only its first attempt", () => {
    expect(rerunsSpent(headChecks, headChecks)).toBe(0);
  });

  it("counts the attempts a declined check has, less one", () => {
    const twice = [...headChecks, ...headChecks.map((c) => ({ name: c.name }))];
    expect(rerunsSpent(headChecks, twice)).toBe(1);
  });

  it("takes the most any declined check has, so a duplicated name only stops it sooner", () => {
    const all = [...headChecks, { name: "verify" }, { name: "verify" }];
    expect(rerunsSpent(headChecks, all)).toBe(2);
  });

  it("ignores checks that were not declined", () => {
    const all = [
      ...headChecks,
      { name: "Vercel Preview Comments" },
      { name: "Vercel Preview Comments" },
    ];
    expect(rerunsSpent(headChecks, all)).toBe(0);
  });
});

describe("planNeverStartedRerun", () => {
  it("waits out the first window after the decline", () => {
    const plan = planNeverStartedRerun({
      declined: headChecks,
      allRuns: headChecks,
      now: at(declinedAt, 60_000),
    });
    expect(plan).toEqual({
      act: "wait",
      until: new Date(at(declinedAt, NEVER_STARTED_RERUN_WINDOWS_MS[0])).toISOString(),
      retry: 1,
      of: NEVER_STARTED_RERUN_WINDOWS_MS.length,
    });
  });

  it("re-runs the head's one workflow run, once, when the window has passed", () => {
    const plan = planNeverStartedRerun({
      declined: headChecks,
      allRuns: headChecks,
      now: at(declinedAt, NEVER_STARTED_RERUN_WINDOWS_MS[0]),
    });
    expect(plan).toEqual({ act: "rerun", runIds: [RUN], retry: 1, of: 4 });
  });

  it("names each distinct run when the declined checks belong to several", () => {
    const other = {
      ...declinedCheck("pdf-import-regression", 1),
      details_url: "https://github.com/o/r/actions/runs/37566080090/job/1",
    };
    const plan = planNeverStartedRerun({
      declined: [...headChecks, other],
      allRuns: [...headChecks, other],
      now: at(declinedAt, 24 * 3_600_000),
    });
    expect(plan.act === "rerun" && plan.runIds).toEqual([RUN, 37566080090]);
  });

  it("grows the window with each attempt and counts from the newest decline", () => {
    const secondDecline = "2026-10-07T04:00:00Z";
    const latest = headChecks.map((c) => ({ ...c, completed_at: secondDecline }));
    const allRuns = [...headChecks, ...latest];
    const early = planNeverStartedRerun({
      declined: latest,
      allRuns,
      now: at(secondDecline, NEVER_STARTED_RERUN_WINDOWS_MS[0]),
    });
    expect(early.act).toBe("wait");
    expect(early.act === "wait" && early.retry).toBe(2);
    const due = planNeverStartedRerun({
      declined: latest,
      allRuns,
      now: at(secondDecline, NEVER_STARTED_RERUN_WINDOWS_MS[1]),
    });
    expect(due).toEqual({ act: "rerun", runIds: [RUN], retry: 2, of: 4 });
  });

  it("stops once every window is spent on this head", () => {
    const allRuns = Array.from(
      { length: NEVER_STARTED_RERUN_WINDOWS_MS.length + 1 },
      () => headChecks,
    ).flat();
    const plan = planNeverStartedRerun({
      declined: headChecks,
      allRuns,
      now: at(declinedAt, 30 * 24 * 3_600_000),
    });
    expect(plan).toEqual({ act: "exhausted", of: 4 });
  });

  it("re-runs nothing when the earlier attempts could not be counted", () => {
    const plan = planNeverStartedRerun({
      declined: headChecks,
      allRuns: null,
      now: at(declinedAt, 24 * 3_600_000),
    });
    expect(plan.act).toBe("unaddressable");
  });

  it("re-runs nothing that is not a GitHub Actions run", () => {
    const foreign = headChecks.map((c) => ({
      ...c,
      details_url: "https://ci.example.com/build/7",
    }));
    const plan = planNeverStartedRerun({
      declined: foreign,
      allRuns: foreign,
      now: at(declinedAt, 24 * 3_600_000),
    });
    expect(plan.act).toBe("unaddressable");
  });

  it("waits a whole window when the decline carries no readable time", () => {
    const now = at(declinedAt, 24 * 3_600_000);
    const untimed = headChecks.map((c) => ({ ...c, completed_at: null }));
    const plan = planNeverStartedRerun({ declined: untimed, allRuns: untimed, now });
    expect(plan.act).toBe("wait");
  });

  it("refuses an empty hand-in rather than guessing", () => {
    expect(planNeverStartedRerun({ declined: [], allRuns: [] }).act).toBe("unaddressable");
  });
});

describe("rerunForbidden", () => {
  const forbidden = new RequestError("Resource not accessible by integration", 403, {
    request: {
      method: "POST",
      url: `https://api.github.com/repos/o/r/actions/runs/${RUN}/rerun-failed-jobs`,
      headers: {},
    },
  });

  it("recognises the App lacking Actions: write", () => {
    expect(rerunForbidden(forbidden)).toBe(true);
  });

  it("does not read another refusal as a missing permission", () => {
    const old = new RequestError(
      "Unable to re-run this workflow run because it was created over a month ago",
      403,
      {
        request: {
          method: "POST",
          url: "https://api.github.com/repos/o/r/actions/runs/1/rerun-failed-jobs",
          headers: {},
        },
      },
    );
    expect(rerunForbidden(old)).toBe(false);
    expect(rerunForbidden(new Error("Resource not accessible by integration"))).toBe(false);
  });
});

describe("describeNeverStartedRerun", () => {
  const rerun = { act: "rerun" as const, runIds: [RUN], retry: 1, of: 4 };

  it("says a re-run was made and what it proves", () => {
    expect(describeNeverStartedRerun(rerun, { ok: true })).toMatch(/re-run them \(retry 1 of 4\)/);
  });

  it("names the missing permission when GitHub refused for it", () => {
    const words = describeNeverStartedRerun(rerun, {
      ok: false,
      forbidden: true,
      why: "GitHub answered 403",
    });
    expect(words).toMatch(/Actions: Read and write/);
    expect(words).toMatch(/by hand/);
  });

  it("says when the next re-run is due, and that nothing is owed by hand yet", () => {
    expect(
      describeNeverStartedRerun({
        act: "wait",
        until: "2026-10-07T03:33:30.000Z",
        retry: 1,
        of: 4,
      }),
    ).toBe("Mission Control re-runs them itself after 2026-10-07T03:33:30Z (retry 1 of 4).");
  });

  it("says plainly when it has stopped", () => {
    expect(describeNeverStartedRerun({ act: "exhausted", of: 4 })).toMatch(/has stopped/);
  });

  it("rides on the hold's one sentence, so a second pass replaces it rather than adding to it", () => {
    const verdict = decideCascadeMerge(headChecks, REQUIRED_CHECKS);
    const why = `${verdict.why} ${describeNeverStartedRerun(rerun, { ok: true })}`;
    const files = "PR #67 opened: 75 file(s)";
    const first = `${openSentence(why)} ${files}`;
    expect(durableSummary(first)).toBe(files);
    const second = `${openSentence(why)} ${durableSummary(first)}`;
    expect(second).toBe(first);
  });
});

describe("the merge drain re-runs a never-started head, and only that", () => {
  const drain = stripComments(readFileSync("src/server/cascadeMergeDrain.server.ts", "utf8"));

  it("asks only on a never_started verdict", () => {
    expect(drain).toMatch(
      /if \(!verdict\.merge && verdict\.reason === "never_started"\) \{\s*const rerun = await rerunDeclinedChecks\(/,
    );
  });

  it("carries the Actions link the planner reads the run from", () => {
    expect(drain).toMatch(/details_url: c\.details_url,/);
  });

  it("re-runs only what the planner names, failed jobs only", () => {
    expect(drain).toMatch(/const plan = planNeverStartedRerun\(\{ declined, allRuns \}\);/);
    expect(drain).toMatch(/for \(const runId of plan\.runIds\)/);
    expect(drain).toMatch(
      /octokit\.actions\.reRunWorkflowFailedJobs\(\{ owner, repo, run_id: runId \}\)/,
    );
    expect(drain).not.toMatch(/reRunWorkflow\(/);
  });

  it("counts every attempt on the head, not the latest only", () => {
    expect(drain).toMatch(/filter: "all",/);
  });

  it("puts the outcome on the hold's reason", () => {
    expect(drain).toMatch(/verdict = \{ \.\.\.verdict, why: `\$\{verdict\.why\} \$\{rerun\}` \};/);
  });
});
