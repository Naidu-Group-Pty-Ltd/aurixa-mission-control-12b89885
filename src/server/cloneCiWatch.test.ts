import { describe, expect, it } from "vitest";
import {
  FAILING_STREAK,
  STALE_AFTER_DAYS,
  ciFingerprint,
  ciSeverity,
  ciWatchIsNoteworthy,
  decideCiReport,
  describeCiFinding,
  findingKey,
  judgeCloneCi,
  type CiFinding,
  type CloneCiInputs,
  type WorkflowRunFact,
} from "./cloneCiWatch.pure";

const NOW = Date.parse("2026-10-26T22:00:00Z");
const SANCTIONS = ".github/workflows/aml-sanctions-refresh.yml";
const DRIFT = ".github/workflows/migration-drift.yml";

let seq = 0;
function run(
  path: string,
  at: string,
  conclusion: string | null,
  over: Partial<WorkflowRunFact> = {},
): WorkflowRunFact {
  seq += 1;
  return {
    path,
    name: path.replace(".github/workflows/", ""),
    event: "schedule",
    headBranch: "main",
    status: "completed",
    conclusion,
    createdAt: at,
    htmlUrl: `https://github.com/o/r/actions/runs/${seq}`,
    ...over,
  };
}

function inputs(over: Partial<CloneCiInputs> = {}): CloneCiInputs {
  return {
    defaultBranch: "main",
    scheduledRuns: [],
    dispatchedRuns: [],
    workflows: [
      { path: SANCTIONS, name: "Refresh sanctions", state: "active" },
      { path: DRIFT, name: "Migration drift", state: "active" },
    ],
    protectedWorkflows: [],
    now: NOW,
    ...over,
  };
}

function findings(over: Partial<CloneCiInputs>): CiFinding[] {
  const reading = judgeCloneCi(inputs(over));
  if (reading.kind !== "read") throw new Error(`unreadable: ${reading.missing.join(", ")}`);
  return reading.findings;
}

describe("a scheduled workflow", () => {
  it("is failing after FAILING_STREAK scheduled failures with no success since", () => {
    const newest = run(SANCTIONS, "2026-10-25T20:45:00Z", "failure");
    const [f] = findings({
      scheduledRuns: [newest, run(SANCTIONS, "2026-10-24T20:45:00Z", "failure")],
    });
    expect(FAILING_STREAK).toBe(2);
    expect(f).toEqual({
      kind: "failing",
      path: SANCTIONS,
      name: "Refresh sanctions",
      streak: 2,
      lastRunUrl: newest.htmlUrl,
      lastSuccessAt: null,
    });
  });

  it("is not failing on one failure: a runner that died is not a broken job", () => {
    expect(
      findings({
        scheduledRuns: [
          run(SANCTIONS, "2026-10-25T20:45:00Z", "failure"),
          run(SANCTIONS, "2026-10-24T20:45:00Z", "success"),
        ],
      }),
    ).toEqual([]);
  });

  it("is not failing once a dispatch on the default branch has succeeded since (26 Oct 2026)", () => {
    // Every clone's refresh, the day this was written: repaired, proven by
    // hand on main, and still red on its schedule because the next scheduled
    // run had not come round.
    expect(
      findings({
        scheduledRuns: [
          run(SANCTIONS, "2026-10-25T20:45:00Z", "failure"),
          run(SANCTIONS, "2026-10-24T20:45:00Z", "failure"),
          run(SANCTIONS, "2026-10-23T20:45:00Z", "failure"),
        ],
        dispatchedRuns: [
          run(SANCTIONS, "2026-10-26T19:38:00Z", "success", { event: "workflow_dispatch" }),
        ],
      }),
    ).toEqual([]);
  });

  it("does not count a dispatch from another branch as the job working", () => {
    const [f] = findings({
      scheduledRuns: [
        run(SANCTIONS, "2026-10-25T20:45:00Z", "failure"),
        run(SANCTIONS, "2026-10-24T20:45:00Z", "failure"),
      ],
      dispatchedRuns: [
        run(SANCTIONS, "2026-10-26T10:00:00Z", "success", {
          event: "workflow_dispatch",
          headBranch: "some-feature",
        }),
      ],
    });
    expect(f?.kind).toBe("failing");
  });

  it("is not pushed over the line by a failed dispatch: trying by hand is not the schedule failing", () => {
    expect(
      findings({
        scheduledRuns: [
          run(SANCTIONS, "2026-10-25T20:45:00Z", "failure"),
          run(SANCTIONS, "2026-10-23T20:45:00Z", "success"),
        ],
        dispatchedRuns: [
          run(SANCTIONS, "2026-10-26T09:00:00Z", "failure", { event: "workflow_dispatch" }),
        ],
      }),
    ).toEqual([]);
  });

  it("steps over cancelled, skipped and unfinished runs", () => {
    const [f] = findings({
      scheduledRuns: [
        run(DRIFT, "2026-10-26T21:43:00Z", null, { status: "in_progress" }),
        run(DRIFT, "2026-10-25T21:43:00Z", "failure"),
        run(DRIFT, "2026-10-24T21:43:00Z", "cancelled"),
        run(DRIFT, "2026-10-23T21:43:00Z", "startup_failure"),
        run(DRIFT, "2026-10-22T21:43:00Z", "skipped"),
        run(DRIFT, "2026-10-21T21:43:00Z", "success"),
      ],
    });
    expect(f).toMatchObject({ kind: "failing", streak: 2, lastSuccessAt: "2026-10-21T21:43:00Z" });
  });

  it("is not judged once the workflow is gone: its red history is a deleted file's", () => {
    const VCR = ".github/workflows/vcr-prune.yml";
    const failures = [
      run(VCR, "2026-10-25T20:56:00Z", "failure"),
      run(VCR, "2026-10-18T20:56:00Z", "failure"),
      run(VCR, "2026-10-11T20:56:00Z", "failure"),
    ];
    expect(findings({ scheduledRuns: failures })).toEqual([]);
    expect(
      findings({
        scheduledRuns: failures,
        workflows: [{ path: VCR, name: "Prune", state: "deleted" }],
      }),
    ).toEqual([]);
  });

  it("is stopped when GitHub has disabled its schedule, failing or not", () => {
    expect(
      findings({
        scheduledRuns: [run(DRIFT, "2026-09-01T21:43:00Z", "success")],
        workflows: [{ path: DRIFT, name: "Migration drift", state: "disabled_inactivity" }],
      }),
    ).toEqual([
      { kind: "stopped", path: DRIFT, name: "Migration drift", state: "disabled_inactivity" },
    ]);
  });

  it(`is not judged when its newest scheduled run is more than ${STALE_AFTER_DAYS} days old`, () => {
    expect(
      findings({
        scheduledRuns: [
          run(DRIFT, "2026-10-05T21:43:00Z", "failure"),
          run(DRIFT, "2026-10-04T21:43:00Z", "failure"),
        ],
      }),
    ).toEqual([]);
  });
});

describe("a protected workflow", () => {
  it("differs when both sides carry it and the blobs are not the same", () => {
    expect(
      findings({
        protectedWorkflows: [
          {
            path: ".github/workflows/apply-migration.yml",
            primeSha: "a".repeat(40),
            cloneSha: "b".repeat(40),
          },
          {
            path: ".github/workflows/deploy-supabase-functions.yml",
            primeSha: "c".repeat(40),
            cloneSha: "c".repeat(40),
          },
        ],
      }),
    ).toEqual([
      {
        kind: "differs",
        path: ".github/workflows/apply-migration.yml",
        primeSha: "a".repeat(40),
        cloneSha: "b".repeat(40),
      },
    ]);
  });

  it("is not drift when either side does not carry it", () => {
    // The CRM line holds address-service.yml and routing-service.yml protected
    // and absent, by its owner's decision; vcr-prune.yml was never the prime's.
    expect(
      findings({
        protectedWorkflows: [
          {
            path: ".github/workflows/address-service.yml",
            primeSha: "a".repeat(40),
            cloneSha: null,
          },
          { path: ".github/workflows/vcr-prune.yml", primeSha: null, cloneSha: "b".repeat(40) },
        ],
      }),
    ).toEqual([]);
  });
});

describe("a reading that could not be taken", () => {
  it("is unreadable, naming what was missing, and judges nothing", () => {
    expect(judgeCloneCi(inputs({ scheduledRuns: null, protectedWorkflows: null }))).toEqual({
      kind: "unreadable",
      missing: ["scheduled runs", "protected workflows"],
    });
    expect(judgeCloneCi(inputs({ workflows: null })).kind).toBe("unreadable");
    expect(judgeCloneCi(inputs({ dispatchedRuns: null })).kind).toBe("unreadable");
  });
});

describe("what is recorded and what is announced", () => {
  const failing = (path: string, streak: number): CiFinding => ({
    kind: "failing",
    path,
    name: path,
    streak,
    lastRunUrl: "https://github.com/o/r/actions/runs/1",
    lastSuccessAt: null,
  });

  it("announces everything on a clone never watched before", () => {
    const d = decideCiReport({ previous: null, findings: [failing(SANCTIONS, 3)] });
    expect(d.record).toBe(true);
    expect(d.announce.map(findingKey)).toEqual([`failing:${SANCTIONS}`]);
  });

  it("records nothing for a clean clone that was clean", () => {
    expect(decideCiReport({ previous: null, findings: [] })).toEqual({
      fingerprint: "",
      record: false,
      announce: [],
    });
  });

  it("does not announce a job again because it failed one more night", () => {
    const previous = ciFingerprint([failing(SANCTIONS, 3)]);
    const d = decideCiReport({ previous, findings: [failing(SANCTIONS, 4)] });
    expect(d.record).toBe(false);
    expect(d.announce).toEqual([]);
  });

  it("announces only what is new, and nothing when one of two clears", () => {
    const both = ciFingerprint([failing(SANCTIONS, 3), failing(DRIFT, 3)]);
    const shrunk = decideCiReport({ previous: both, findings: [failing(DRIFT, 4)] });
    expect(shrunk.record).toBe(true);
    expect(shrunk.announce).toEqual([]);

    const grown = decideCiReport({
      previous: ciFingerprint([failing(DRIFT, 3)]),
      findings: [failing(DRIFT, 4), failing(SANCTIONS, 2)],
    });
    expect(grown.announce.map(findingKey)).toEqual([`failing:${SANCTIONS}`]);
  });

  it("records a clearance and announces nothing", () => {
    const d = decideCiReport({ previous: ciFingerprint([failing(SANCTIONS, 3)]), findings: [] });
    expect(d).toEqual({ fingerprint: "", record: true, announce: [] });
  });

  it("treats the prime moving a protected workflow as news again", () => {
    const at = (primeSha: string): CiFinding => ({
      kind: "differs",
      path: ".github/workflows/apply-migration.yml",
      primeSha,
      cloneSha: "c".repeat(40),
    });
    const d = decideCiReport({
      previous: ciFingerprint([at("a".repeat(40))]),
      findings: [at("b".repeat(40))],
    });
    expect(d.announce).toHaveLength(1);
  });
});

describe("what an operator reads", () => {
  it("names the file, the streak, the last success and the run", () => {
    expect(
      describeCiFinding({
        kind: "failing",
        path: SANCTIONS,
        name: "Refresh sanctions",
        streak: 18,
        lastRunUrl: "https://github.com/o/r/actions/runs/9",
        lastSuccessAt: null,
      }),
    ).toBe(
      "aml-sanctions-refresh.yml — the last 18 scheduled runs failed; no success on the " +
        "default branch in the window. https://github.com/o/r/actions/runs/9",
    );
    expect(
      describeCiFinding({
        kind: "differs",
        path: ".github/workflows/apply-migration.yml",
        primeSha: "74f631aaaaaaaa",
        cloneSha: "0de1b2bbbbbbbb",
      }),
    ).toContain("this copy (0de1b2b) is not the prime's (74f631a)");
  });

  it("rates a job that does not run above a copy that differs", () => {
    const differs: CiFinding = { kind: "differs", path: "p", primeSha: "a", cloneSha: "b" };
    expect(ciSeverity([differs])).toBe("warning");
    expect(
      ciSeverity([differs, { kind: "stopped", path: "q", name: "q", state: "disabled_manually" }]),
    ).toBe("error");
  });

  it("files a row of its own only when the watch could not look", () => {
    const base = {
      clones: 4,
      attention: 1,
      announced: 2,
      cleared: 0,
      unreadable: 0,
      failed: 0,
      detail: [],
    };
    expect(ciWatchIsNoteworthy(base)).toBe(false);
    expect(ciWatchIsNoteworthy({ ...base, unreadable: 1 })).toBe(true);
    expect(ciWatchIsNoteworthy({ ...base, failed: 1 })).toBe(true);
  });
});
