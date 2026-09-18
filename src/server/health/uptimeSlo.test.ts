import { describe, expect, it } from "vitest";
import {
  averageOf,
  daySeriesFor,
  HEALTH_HISTORY_RETENTION_DAYS,
  summariseUptime,
  type UptimeDayRow,
  type UptimeStatus,
} from "./uptimeSlo.pure";

const NOW = new Date("2026-09-18T15:00:00.000Z");

function day(
  cloneId: string,
  date: string,
  counts: { up?: number; down?: number; unmeasured?: number; lastStatus?: UptimeStatus },
): UptimeDayRow {
  return {
    cloneId,
    day: date,
    up: counts.up ?? 0,
    down: counts.down ?? 0,
    unmeasured: counts.unmeasured ?? 0,
    firstProbedAt: `${date}T00:05:00.000Z`,
    lastProbedAt: `${date}T23:55:00.000Z`,
    lastStatus:
      counts.lastStatus ??
      ((counts.up ?? 0) > 0 ? "up" : (counts.down ?? 0) > 0 ? "down" : "unknown"),
  };
}

describe("absent is never zero", () => {
  it("an unmeasured probe is in neither side of the fraction", () => {
    const r = summariseUptime({
      now: NOW,
      requestedWindowDays: 30,
      rows: [day("a", "2026-09-18", { up: 2, unmeasured: 1 })],
    });
    const a = r.byClone[0];
    expect(a.up).toBe(2);
    expect(a.unmeasured).toBe(1);
    expect(a.measured).toBe(2);
    // Not 66.67. The third probe measured nothing, so it weighs nothing.
    expect(a.uptimePct).toBe(100);
  });

  it("a clone with nothing to ping reads null, never 0%", () => {
    // The old arithmetic put every `unknown` in the denominator, so a clone
    // with no deploy URL — which the health card correctly draws grey — read
    // 0% uptime on the SLO page beside it.
    const r = summariseUptime({
      now: NOW,
      requestedWindowDays: 30,
      rows: [day("b", "2026-09-18", { unmeasured: 288 })],
    });
    expect(r.byClone[0].uptimePct).toBeNull();
    expect(r.byClone[0].unmeasured).toBe(288);
    expect(r.fleetUptimePct).toBeNull();
  });

  it("no rows at all is null, and says nothing about anybody", () => {
    const r = summariseUptime({ now: NOW, requestedWindowDays: 30, rows: [] });
    expect(r.fleetUptimePct).toBeNull();
    expect(r.measuredTotal).toBe(0);
    expect(r.byClone).toEqual([]);
    expect(r.observedFrom).toBeNull();
  });

  it("a reached-and-empty probe still counts — down is a measurement", () => {
    const r = summariseUptime({
      now: NOW,
      requestedWindowDays: 30,
      rows: [day("c", "2026-09-18", { up: 1, down: 3 })],
    });
    expect(r.byClone[0].uptimePct).toBe(25);
  });
});

describe("the fleet reading", () => {
  it("is sample-weighted across every measured probe", () => {
    const r = summariseUptime({
      now: NOW,
      requestedWindowDays: 30,
      rows: [day("a", "2026-09-18", { up: 3 }), day("b", "2026-09-18", { down: 1, unmeasured: 1 })],
    });
    // 3 up of 4 measured. The `unknown` is excluded from both sides, so this
    // is not 3/5.
    expect(r.fleetUptimePct).toBe(75);
    expect(r.measuredTotal).toBe(4);
    expect(r.unmeasuredTotal).toBe(1);
  });

  it("sums a clone's days rather than averaging their percentages", () => {
    // A day with four probes must not weigh the same as a day with 288.
    const r = summariseUptime({
      now: NOW,
      requestedWindowDays: 30,
      rows: [
        day("a", "2026-09-17", { up: 0, down: 4 }),
        day("a", "2026-09-18", { up: 288, down: 0 }),
      ],
    });
    // 288 of 292, not the mean of 0% and 100%.
    expect(r.byClone[0].uptimePct).toBe(98.63);
  });

  it("rounds to two places rather than showing a float", () => {
    const r = summariseUptime({
      now: NOW,
      requestedWindowDays: 30,
      rows: [day("a", "2026-09-18", { up: 1, down: 2 })],
    });
    expect(r.fleetUptimePct).toBe(33.33);
  });
});

describe("a window asked for is not a window measured", () => {
  it("reports the span it actually observed", () => {
    const r = summariseUptime({
      now: NOW,
      requestedWindowDays: 30,
      rows: [day("a", "2026-09-17", { up: 1 }), day("a", "2026-09-18", { up: 1 })],
    });
    expect(r.observedFrom).toBe("2026-09-17T00:05:00.000Z");
    expect(r.observedTo).toBe("2026-09-18T23:55:00.000Z");
    expect(r.observedHours).toBe(47.8);
  });

  it("says a young history does not cover the window it was asked for", () => {
    // The first weeks after this ships are exactly this case: a few hours of
    // probes wearing a thirty-day label.
    const r = summariseUptime({
      now: NOW,
      requestedWindowDays: 30,
      rows: [day("a", "2026-09-18", { up: 3 })],
    });
    expect(r.coversRequestedWindow).toBe(false);
  });

  it("says a long history does cover it", () => {
    const r = summariseUptime({
      now: NOW,
      requestedWindowDays: 7,
      rows: [day("a", "2026-09-01", { up: 1 }), day("a", "2026-09-18", { up: 1 })],
    });
    expect(r.coversRequestedWindow).toBe(true);
  });

  it("an empty history covers nothing", () => {
    const r = summariseUptime({ now: NOW, requestedWindowDays: 1, rows: [] });
    expect(r.coversRequestedWindow).toBe(false);
  });
});

describe("what it is right now", () => {
  it("is the newest day's closing probe, whatever order the rows arrive in", () => {
    // 99.9% over ninety days says nothing about whether the clone is answering
    // now. The two readings are drawn beside each other and neither stands in
    // for the other.
    const r = summariseUptime({
      now: NOW,
      requestedWindowDays: 30,
      rows: [
        day("a", "2026-09-18", { up: 100, down: 1, lastStatus: "down" }),
        day("a", "2026-09-16", { up: 288, lastStatus: "up" }),
        day("a", "2026-09-17", { up: 288, lastStatus: "up" }),
      ],
    });
    expect(r.byClone[0].lastStatus).toBe("down");
    expect(r.byClone[0].lastProbedAt).toBe("2026-09-18T23:55:00.000Z");
    // …while the window reading stays what it was.
    expect(r.byClone[0].uptimePct).toBe(99.85);
  });
});

describe("the per-clone series", () => {
  it("comes back in date order with the same exclusion", () => {
    const series = daySeriesFor([
      day("a", "2026-09-18", { unmeasured: 4 }),
      day("a", "2026-09-16", { up: 2, down: 2 }),
      day("a", "2026-09-17", { up: 3, down: 1 }),
    ]);
    expect(series.map((d) => d.date)).toEqual(["2026-09-16", "2026-09-17", "2026-09-18"]);
    expect(series[0].pct).toBe(50);
    expect(series[1].pct).toBe(75);
    // A day of nothing but unknowns draws a gap, not a floor.
    expect(series[2].pct).toBeNull();
    expect(series[2].measured).toBe(0);
  });

  it("averages by sample and never over a day that measured nothing", () => {
    const series = daySeriesFor([
      day("a", "2026-09-17", { up: 90, down: 10 }),
      day("a", "2026-09-18", { unmeasured: 100 }),
    ]);
    expect(averageOf(series)).toBe(90);
  });

  it("an all-unmeasured series has no average at all", () => {
    expect(averageOf(daySeriesFor([day("a", "2026-09-18", { unmeasured: 5 })]))).toBeNull();
    expect(averageOf([])).toBeNull();
  });
});

describe("retention", () => {
  it("keeps more than the widest window anyone may ask for", () => {
    // A 90-day reading computed against a tail already being pruned would
    // quietly shrink its own evidence.
    expect(HEALTH_HISTORY_RETENTION_DAYS).toBeGreaterThan(90);
  });
});
