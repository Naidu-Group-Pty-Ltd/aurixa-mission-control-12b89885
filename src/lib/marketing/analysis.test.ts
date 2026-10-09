import { describe, expect, it } from "vitest";
import { adAnalysis, metaRunning, pacingFor, tiktokRunning } from "./analysis.pure";
import { emptyMetrics, type ChannelReport } from "./marketingEngine";

function report(daily: Array<[string, number]>): ChannelReport {
  return {
    channel: "tiktok_ads",
    accountRef: "7000000000000000001",
    accountName: null,
    currency: "AUD",
    range: { since: "2026-10-01", until: "2026-10-09" },
    totals: { ...emptyMetrics(), spend: daily.reduce((s, [, v]) => s + v, 0) },
    daily: daily.map(([date, spend]) => ({ date, metrics: { ...emptyMetrics(), spend } })),
    entities: [],
    measures: ["spend"],
    viewDefinition: null,
    notes: [],
  };
}

describe("marketing analysis", () => {
  it("concludes nothing from a channel that did not answer", () => {
    expect(adAnalysis(null, null)).toEqual({
      signals: [],
      health: [],
      budget: null,
      comparison: [],
      forecast: null,
    });
  });

  it("answers pacing for This Month only, counted to the end of yesterday", () => {
    const r = report([
      ["2026-10-01", 10],
      ["2026-10-02", 10],
      ["2026-10-09", 999],
    ]);
    expect(pacingFor(r, "last_30d", "2026-10-09", [{ dailyBudget: 20, running: true }])).toBeNull();
    const p = pacingFor(r, "this_month", "2026-10-09", [{ dailyBudget: 20, running: true }]);
    expect(p).not.toBeNull();
    // Today's 999 is still being spent and is not in the month-to-date figure.
    expect(p!.monthToDateSpend).toBe(20);
    expect(p!.monthBudget).toBe(20 * 31);
  });

  it("has nothing to pace on the first of the month", () => {
    expect(
      pacingFor(report([["2026-10-01", 5]]), "this_month", "2026-10-01", [
        { dailyBudget: 20, running: true },
      ]),
    ).toBeNull();
  });

  it("counts only running campaigns' daily budgets, and says so when there are none", () => {
    const r = report([["2026-10-01", 10]]);
    const paused = pacingFor(r, "this_month", "2026-10-03", [{ dailyBudget: 50, running: false }]);
    expect(paused!.monthBudget).toBeNull();
  });

  it("reads each platform's own running word", () => {
    expect(tiktokRunning("ENABLE")).toBe(true);
    expect(tiktokRunning("CAMPAIGN_STATUS_ENABLE")).toBe(true);
    expect(tiktokRunning("DISABLE")).toBe(false);
    expect(metaRunning("ACTIVE")).toBe(true);
    expect(metaRunning("PAUSED")).toBe(false);
  });
});
