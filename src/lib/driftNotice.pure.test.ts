import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { driftNoticesToRaise, type DriftSuggestionLike } from "./driftNotice.pure";

type Suggestion = DriftSuggestionLike & { rationale: string; recommended_action: string };

/** The answers the model gave NPC CRM Independent on 20 Oct 2026, verbatim. */
const CRM_SCANS: Suggestion[][] = [
  [
    {
      severity: "high",
      title: "Diagnose Stalled Cascade Sync",
      rationale:
        "The clone is nearly 1,000 commits behind the prime repository and the last sync attempt was over 24 hours ago, indicating the automated cascade is failing or stuck.",
      recommended_action: "review",
    },
  ],
  [
    {
      severity: "high",
      title: "Urgent Sync: Clone 939 Commits Behind Prime",
      rationale:
        "The clone is 939 commits behind prime, indicating a significant lag that could lead to merge conflicts or API incompatibilities across the 100+ installed modules.",
      recommended_action: "cascade_pr",
    },
  ],
  [
    {
      severity: "high",
      title: "Deep Lag in Cascading Sync",
      rationale:
        "The clone is significantly behind (939 commits) despite being in a cascading sync state. The last successful cascade was recently, suggesting a blockage or large volume of manual conflicts preventing the automatic catch-up.",
      recommended_action: "review",
    },
  ],
  [
    {
      severity: "high",
      title: "Critical Divergence: 939 Commits Behind Prime",
      rationale:
        "The clone is 939 commits behind prime, which represents a massive divergence. This poses a high risk of merge conflicts and breaking changes during the automated sync process. A manual review of the diff is critical before further automated cascading.",
      recommended_action: "review",
    },
    {
      severity: "high",
      title: "Draft Integration PR for NPC CRM Independent",
      rationale:
        "The 'cascading' status indicates the system is currently attempting to bridge a large gap. To prevent the main branch from becoming unstable, a dedicated PR should be created to merge the prime changes into the clone, allowing for CI/CD validation.",
      recommended_action: "cascade_pr",
    },
  ],
  [
    {
      severity: "high",
      title: "High Commit Delta Review",
      rationale:
        "The clone is nearly 1,000 commits behind prime and the last successful cascade was recently completed. A manual review is necessary to ensure the high volume of incoming changes doesn't break the extensive list of custom modules.",
      recommended_action: "review",
    },
  ],
];

/** Runs the scans in order, as the cron does, storing each answer for the next. */
function replay(
  status: string,
  scans: Suggestion[][],
  rule: typeof driftNoticesToRaise = driftNoticesToRaise,
  start: Suggestion[] = [],
) {
  let stored: Suggestion[] = start;
  const raised: string[] = [];
  for (const current of scans) {
    raised.push(...rule({ syncStatus: status, previous: stored, current }).map((s) => s.title));
    stored = current;
  }
  return raised;
}

/** The guard as it stood: `sync_status` alone, and titles the model never repeats. */
const OLD_RULE: typeof driftNoticesToRaise = ({ syncStatus, previous, current }) => {
  const wasAlreadyBehind = syncStatus === "behind" || syncStatus === "failed";
  const previousHighTitles = new Set(
    (previous ?? []).filter((s) => s.severity === "high").map((s) => s.title),
  );
  return wasAlreadyBehind
    ? []
    : current.filter((s) => s.severity === "high" && !previousHighTitles.has(s.title));
};

describe("a clone that stays behind is announced once", () => {
  it("is the defect: the old guard raised every scan of a clone held at `cascading`", () => {
    expect(replay("cascading", CRM_SCANS, OLD_RULE)).toHaveLength(6);
  });

  it("raises the first scan of the episode and nothing after it", () => {
    expect(replay("cascading", CRM_SCANS)).toEqual(["Diagnose Stalled Cascade Sync"]);
  });

  it("raises nothing for a clone whose last scan already announced it", () => {
    expect(replay("cascading", CRM_SCANS.slice(1), driftNoticesToRaise, CRM_SCANS[0])).toEqual([]);
  });

  it("announces a new episode once the clone has caught up in between", () => {
    const caughtUp: Suggestion[] = [];
    const scans = [CRM_SCANS[0], CRM_SCANS[1], caughtUp, CRM_SCANS[2], CRM_SCANS[3]];
    expect(replay("cascading", scans)).toEqual([
      "Diagnose Stalled Cascade Sync",
      "Deep Lag in Cascading Sync",
    ]);
  });

  it("raises every high suggestion of the scan that opens the episode, as before", () => {
    expect(replay("in_sync", [CRM_SCANS[3]])).toEqual([
      "Critical Divergence: 939 Commits Behind Prime",
      "Draft Integration PR for NPC CRM Independent",
    ]);
  });

  it("counts only a high suggestion as an announcement", () => {
    const medium: Suggestion[] = [{ ...CRM_SCANS[0][0], severity: "medium" }];
    expect(replay("cascading", [medium, CRM_SCANS[1]])).toEqual([
      "Urgent Sync: Clone 939 Commits Behind Prime",
    ]);
  });

  it("raises nothing that the old guard did not", () => {
    for (const status of ["behind", "failed"]) {
      expect(replay(status, CRM_SCANS)).toEqual([]);
      expect(replay(status, CRM_SCANS, OLD_RULE)).toEqual([]);
    }
    for (const status of ["cascading", "in_sync", "diverged", ""]) {
      const now = new Set(replay(status, CRM_SCANS));
      for (const title of now) expect(replay(status, CRM_SCANS, OLD_RULE)).toContain(title);
    }
  });

  it("reads an unset store as nothing announced", () => {
    expect(
      driftNoticesToRaise({ syncStatus: null, previous: null, current: CRM_SCANS[0] }),
    ).toHaveLength(1);
  });
});

describe("the wiring", () => {
  const scan = readFileSync("src/server/fleet-drift.functions.ts", "utf8");

  it("decides what to raise with the rule and nothing else", () => {
    expect(scan).toContain("driftNoticesToRaise({");
    expect(scan).toContain("previous: previousSuggestions,");
    expect(scan).not.toMatch(/previousHighTitles/);
    expect(scan).not.toMatch(/const wasAlreadyBehind/);
  });

  it("stores this scan's answer for the next one to read", () => {
    expect(scan).toContain("drift_suggestions: suggestions,");
  });
});
