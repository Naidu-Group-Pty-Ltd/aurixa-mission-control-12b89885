import { describe, expect, it } from "vitest";
import {
  addMeasured,
  completeDailySeries,
  deriveRates,
  emptyMetrics,
  formatChange,
  formatCount,
  formatMoney,
  formatPercent,
  formatSeconds,
  measuredKeys,
  median,
  mergeDaily,
  ratio,
  readNumber,
  relativeChange,
  sumMetrics,
  type MetricSet,
} from "../marketingEngine";

function m(over: Partial<MetricSet>): MetricSet {
  return { ...emptyMetrics(), ...over };
}

describe("absent is never zero", () => {
  it("reads vendor numbers and refuses everything else", () => {
    expect(readNumber("1234")).toBe(1234);
    expect(readNumber("12.50")).toBe(12.5);
    expect(readNumber("1,234")).toBe(1234);
    expect(readNumber(7)).toBe(7);
    expect(readNumber("")).toBeNull();
    expect(readNumber("-")).toBeNull();
    expect(readNumber(undefined)).toBeNull();
    expect(readNumber(null)).toBeNull();
    expect(readNumber(Number.NaN)).toBeNull();
    expect(readNumber("abc")).toBeNull();
  });

  it("adds only what was measured", () => {
    expect(addMeasured(null, null)).toBeNull();
    expect(addMeasured(null, 3)).toBe(3);
    expect(addMeasured(2, 3)).toBe(5);
    const total = sumMetrics([m({ spend: 10, results: null }), m({ spend: 5, results: null })]);
    expect(total.spend).toBe(15);
    expect(total.results).toBeNull();
    expect(sumMetrics([]).spend).toBeNull();
  });

  it("states a rate only over a measured, positive denominator", () => {
    expect(ratio(5, 0)).toBeNull();
    expect(ratio(5, null)).toBeNull();
    expect(ratio(null, 10)).toBeNull();
    expect(ratio(5, 10)).toBe(0.5);
    const r = deriveRates(m({ spend: 100, impressions: 20000, clicks: 300, results: null }));
    expect(r.ctr).toBeCloseTo(0.015);
    expect(r.cpm).toBeCloseTo(5);
    expect(r.cpc).toBeCloseTo(100 / 300);
    expect(r.costPerResult).toBeNull();
  });

  it("derives rates from summed counts, never by averaging rates", () => {
    const a = m({ impressions: 1000, clicks: 100 }); // 10%
    const b = m({ impressions: 9000, clicks: 90 }); // 1%
    // The mean of the two CTRs is 5.5%; the account's CTR is 1.9%.
    expect(deriveRates(sumMetrics([a, b])).ctr).toBeCloseTo(0.019);
  });

  it("has no net follower figure without both sides", () => {
    expect(deriveRates(m({ follows: 10, unfollows: null })).netFollows).toBeNull();
    expect(deriveRates(m({ follows: 10, unfollows: 4 })).netFollows).toBe(6);
  });

  it("measures completion against plays where plays exist, impressions where they do not", () => {
    expect(
      deriveRates(m({ quartile100: 50, videoPlays: 200, impressions: 1000 })).completionRate,
    ).toBeCloseTo(0.25);
    expect(deriveRates(m({ quartile100: 50, impressions: 1000 })).completionRate).toBeCloseTo(0.05);
  });

  it("merges and completes daily series, filling gaps only for a complete read", () => {
    const points = [
      { date: "2026-10-02", metrics: m({ spend: 2 }) },
      { date: "2026-10-01", metrics: m({ spend: 1 }) },
      { date: "2026-10-02", metrics: m({ spend: 3 }) },
    ];
    expect(mergeDaily(points).map((p) => [p.date, p.metrics.spend])).toEqual([
      ["2026-10-01", 1],
      ["2026-10-02", 5],
    ]);
    const days = ["2026-10-01", "2026-10-02", "2026-10-03"];
    const filled = completeDailySeries(points, days, { zeroFill: true, measures: ["spend"] });
    expect(filled[2].metrics.spend).toBe(0);
    expect(filled[2].metrics.results).toBeNull();
    const gapped = completeDailySeries(points, days, { zeroFill: false, measures: ["spend"] });
    expect(gapped[2].metrics.spend).toBeNull();
  });

  it("lists which keys a source measured", () => {
    expect(measuredKeys([m({ spend: 1 }), m({ views: 2 })])).toEqual(["spend", "views"]);
  });

  it("computes change and median without inventing", () => {
    expect(relativeChange(110, 100)).toBeCloseTo(0.1);
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(0, 0)).toBe(0);
    expect(relativeChange(null, 3)).toBeNull();
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("formatting", () => {
  it("writes null as a dash, never as zero", () => {
    expect(formatMoney(null, "AUD")).toBe("—");
    expect(formatCount(null)).toBe("—");
    expect(formatPercent(null)).toBe("—");
    expect(formatChange(null)).toBe("—");
    expect(formatSeconds(null)).toBe("—");
  });

  it("writes money in its currency", () => {
    expect(formatMoney(1234.5, "AUD")).toBe("$1,234.50");
    expect(formatMoney(1234.5, "USD", { showCode: true })).toContain("USD");
    expect(formatMoney(12, null)).toBe("12.00");
  });

  it("writes changes with a true minus sign", () => {
    expect(formatChange(0.124)).toBe("+12.4%");
    expect(formatChange(-0.03)).toBe("−3.0%");
    expect(formatPercent(0.0123)).toBe("1.23%");
    expect(formatSeconds(65)).toBe("1:05");
    expect(formatSeconds(3725)).toBe("1h 02m");
  });
});
