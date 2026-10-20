import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CARRIER_SETTLED_PREFIX,
  carrierSettledMessage,
  settledByCarrier,
} from "./carrierSettlement.pure";
import { cascadeEventStatus, countResults, summariseCascade } from "./prReconcile.pure";
import { summaryOwesReconcile } from "./syncExclusions.pure";

/**
 * F24 in the 19 Oct 2026 hand-over: the merge drain's recount rewrote a retired
 * event as `completed`, because it read a row the carrier never reached as a
 * deliberate skip. The rows below are production's, verbatim, from the two
 * shapes the recount rewrote on 20 Oct 2026 between 08:30 and 08:35 UTC.
 */

const RETIRED = carrierSettledMessage(
  "was retired after 3 attempts without processing this clone.",
);

// Event cc61ed81: every clone skipped, one of them because the event was
// retired before it was reached. The recount wrote `completed`.
const RETIRED_NOTHING_OPENED = [
  {
    status: "skipped",
    diff_summary:
      "Nothing to cascade: all 65 differing path(s) are withheld by this clone's exclusion policy",
    error_message: "",
  },
  {
    status: "skipped",
    diff_summary:
      "Paused at the invocation budget — 4 of 1360 file(s) prepared; the rest resume next tick",
    error_message: RETIRED,
  },
  {
    status: "skipped",
    diff_summary: "Already proposed — PR #228 carries this exact tree (1042 file(s))",
    error_message: "",
  },
  {
    status: "skipped",
    diff_summary: "Already proposed — PR #227 carries this exact tree (1109 file(s))",
    error_message: "",
  },
];

// Event 58333aed: two pull requests opened, one clone never reached.
const RETIRED_TWO_OPENED = [
  RETIRED_NOTHING_OPENED[0],
  { status: "skipped", diff_summary: "", error_message: RETIRED },
  {
    status: "pr_opened",
    diff_summary:
      "Open · Not merging — 1 check(s) failing: security (failure). PR #228 opened: .claude/skills/steward/SKILL.md",
    error_message: "",
  },
  {
    status: "pr_opened",
    diff_summary:
      "Open · Not merging — 1 check(s) failing: security (failure). PR #227 opened: .claude/skills/steward/SKILL.md",
    error_message: "",
  },
];

describe("a row its carrier settled says so in one sentence", () => {
  it("is composed from the fate and read back by its beginning", () => {
    const message = carrierSettledMessage("was rejected by a reviewer — wrong week.");
    expect(message).toBe("Skipped: the carrier event was rejected by a reviewer — wrong week.");
    expect(message.startsWith(CARRIER_SETTLED_PREFIX)).toBe(true);
    expect(settledByCarrier(message)).toBe(true);
  });

  it("never reads a deliberate skip as one the carrier abandoned", () => {
    for (const notAbandoned of [
      null,
      undefined,
      "",
      "Parent NPC Client Dashboard carries prime@881e7e0; this pass delivers prime@6629006",
      "Already proposed — PR #228 carries this exact tree (1042 file(s))",
      "Superseded: folded into queued cascade 0b329741",
    ]) {
      expect(settledByCarrier(notAbandoned)).toBe(false);
    }
  });
});

describe("the recount keeps a retired event failed (F24)", () => {
  it("counts the clone the event never reached, and calls the event failed", () => {
    const counts = countResults(RETIRED_NOTHING_OPENED, summaryOwesReconcile);
    expect(counts.undelivered).toBe(1);
    expect(counts.skipped).toBe(3);
    expect(cascadeEventStatus(counts)).toBe("failed");
    expect(summariseCascade(counts)).toBe(
      "0 merged · 0 PRs · 0 failed · 3 skipped (of 4) · 1 never reached",
    );
  });

  it("calls it partial where the event opened something before it was retired", () => {
    const counts = countResults(RETIRED_TWO_OPENED, summaryOwesReconcile);
    expect(counts.undelivered).toBe(1);
    expect(counts.opened).toBe(2);
    expect(cascadeEventStatus(counts)).toBe("partial");
  });

  it("is the defect when the abandoned row is read as a skip", () => {
    // The rows without the message the recount never selected: what the
    // recount derived, and wrote, on 20 Oct 2026.
    const blind = RETIRED_NOTHING_OPENED.map(({ status, diff_summary }) => ({
      status,
      diff_summary,
    }));
    const counts = countResults(blind, summaryOwesReconcile);
    expect(cascadeEventStatus(counts)).toBe("completed");
    expect(summariseCascade(counts)).toBe("0 merged · 0 PRs · 0 failed · 4 skipped (of 4)");
  });

  it("changes nothing for an event whose every clone was reached", () => {
    const counts = countResults(
      [RETIRED_NOTHING_OPENED[0], RETIRED_NOTHING_OPENED[2]],
      summaryOwesReconcile,
    );
    expect(counts.undelivered).toBe(0);
    expect(cascadeEventStatus(counts)).toBe("completed");
    expect(summariseCascade(counts)).toBe("0 merged · 0 PRs · 0 failed · 2 skipped (of 2)");
  });
});

describe("the wiring", () => {
  const engine = readFileSync("src/server/cascade-engine.server.ts", "utf8");
  const drain = readFileSync("src/routes/hooks.cascade-drain.tsx", "utf8");
  const approvals = readFileSync("src/server/cascade-approvals.functions.ts", "utf8");
  const merge = readFileSync("src/server/cascadeMergeDrain.server.ts", "utf8");

  it("composes the sentence in one place: no writer spells its beginning", () => {
    for (const source of [engine, drain, approvals]) {
      expect(source).not.toContain(CARRIER_SETTLED_PREFIX.trim());
    }
    const at = engine.indexOf("export async function terminaliseOrphanedRows(");
    expect(at).toBeGreaterThan(-1);
    expect(engine.slice(at, at + 900)).toContain("error_message: carrierSettledMessage(fate),");
  });

  it("the recount reads each row's message and never rewrites a verdict others key on", () => {
    const at = merge.indexOf("async function recountEvent(");
    expect(at).toBeGreaterThan(-1);
    const fn = merge.slice(at, at + 2_500);
    expect(fn).toContain('.select("status, diff_summary, error_message")');
    const write = fn.indexOf(".update({ summary, status })");
    expect(write).toBeGreaterThan(-1);
    for (const guard of [
      "if (isReviewerRejection(current.data?.summary ?? null)) return false;",
      "if (isSupersededSummary(current.data?.summary ?? null)) return false;",
    ]) {
      const g = fn.indexOf(guard);
      expect(g, guard).toBeGreaterThan(-1);
      expect(g).toBeLessThan(write);
    }
  });
});
