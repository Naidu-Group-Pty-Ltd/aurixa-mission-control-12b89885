import { describe, expect, it } from "vitest";
import {
  addDays,
  dayCount,
  eachDay,
  formatRange,
  isValidYmd,
  previousPeriod,
  resolvePreset,
  resolveRange,
  safeTimeZone,
  splitRange,
  todayIn,
  ymdOfInstant,
} from "../marketingEngine";

/**
 * The presets must mean what the Meta tab's presets mean, or "Last 30 Days"
 * describes two different months on two tabs of one page.
 */
describe("marketing ranges", () => {
  it("reads presets the way Meta does: last_Nd excludes today, this_month includes it", () => {
    expect(resolvePreset("last_7d", "2026-10-08")).toEqual({
      since: "2026-10-01",
      until: "2026-10-07",
    });
    expect(resolvePreset("last_30d", "2026-10-08")).toEqual({
      since: "2026-09-08",
      until: "2026-10-07",
    });
    expect(resolvePreset("today", "2026-10-08")).toEqual({
      since: "2026-10-08",
      until: "2026-10-08",
    });
    expect(resolvePreset("yesterday", "2026-10-01")).toEqual({
      since: "2026-09-30",
      until: "2026-09-30",
    });
    expect(resolvePreset("this_month", "2026-10-08")).toEqual({
      since: "2026-10-01",
      until: "2026-10-08",
    });
    expect(resolvePreset("last_month", "2026-03-15")).toEqual({
      since: "2026-02-01",
      until: "2026-02-28",
    });
    expect(resolvePreset("last_month", "2026-01-04")).toEqual({
      since: "2025-12-01",
      until: "2025-12-31",
    });
  });

  it("counts a leap February", () => {
    expect(resolvePreset("last_month", "2028-03-02")).toEqual({
      since: "2028-02-01",
      until: "2028-02-29",
    });
  });

  it("refuses dates that are not dates", () => {
    expect(isValidYmd("2026-02-30")).toBe(false);
    expect(isValidYmd("2026-2-3")).toBe(false);
    expect(isValidYmd("2028-02-29")).toBe(true);
    expect(isValidYmd(20260101)).toBe(false);
  });

  it("prefers a custom range and refuses one that ends in the future", () => {
    expect(
      resolveRange(
        { datePreset: "last_7d", timeRange: { since: "2026-09-01", until: "2026-09-30" } },
        "2026-10-08",
      ),
    ).toEqual({
      ok: true,
      range: { since: "2026-09-01", until: "2026-09-30" },
      preset: null,
      days: 30,
    });
    const future = resolveRange(
      { timeRange: { since: "2026-10-01", until: "2026-10-09" } },
      "2026-10-08",
    );
    expect(future.ok).toBe(false);
    const backwards = resolveRange(
      { timeRange: { since: "2026-10-05", until: "2026-10-01" } },
      "2026-10-08",
    );
    expect(backwards.ok).toBe(false);
    const tooLong = resolveRange(
      { timeRange: { since: "2024-01-01", until: "2026-10-01" } },
      "2026-10-08",
    );
    expect(tooLong.ok).toBe(false);
  });

  it("defaults to the last 30 days and refuses an unknown preset by name", () => {
    const r = resolveRange({}, "2026-10-08");
    expect(r.ok && r.preset).toBe("last_30d");
    const bad = resolveRange({ datePreset: "last_31d" }, "2026-10-08");
    expect(bad).toEqual({ ok: false, error: 'Unknown date preset "last_31d".' });
  });

  it("splits a long range into pieces TikTok will answer", () => {
    const parts = splitRange({ since: "2026-07-10", until: "2026-10-07" }, 30);
    expect(parts).toEqual([
      { since: "2026-07-10", until: "2026-08-08" },
      { since: "2026-08-09", until: "2026-09-07" },
      { since: "2026-09-08", until: "2026-10-07" },
    ]);
    expect(parts.reduce((s, p) => s + dayCount(p), 0)).toBe(
      dayCount({ since: "2026-07-10", until: "2026-10-07" }),
    );
    expect(splitRange({ since: "2026-10-01", until: "2026-10-01" }, 30)).toEqual([
      { since: "2026-10-01", until: "2026-10-01" },
    ]);
  });

  it("builds the previous period of the same length", () => {
    expect(previousPeriod({ since: "2026-09-08", until: "2026-10-07" })).toEqual({
      since: "2026-08-09",
      until: "2026-09-07",
    });
  });

  it("walks every day and crosses month ends on calendar dates", () => {
    expect(eachDay({ since: "2026-02-27", until: "2026-03-02" })).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("reads today and instants in the named zone, not UTC", () => {
    // 23:30 UTC on 7 Oct is 10:30 on 8 Oct in Sydney (AEDT, UTC+11).
    const instant = new Date("2026-10-07T23:30:00Z");
    expect(todayIn("Australia/Sydney", instant)).toBe("2026-10-08");
    expect(todayIn("UTC", instant)).toBe("2026-10-07");
    expect(ymdOfInstant("2026-10-07T23:30:00Z", "Australia/Sydney")).toBe("2026-10-08");
    expect(ymdOfInstant("not a date", "Australia/Sydney")).toBeNull();
  });

  it("falls back from an unknown time zone instead of throwing on a read path", () => {
    expect(safeTimeZone("Mars/Olympus_Mons")).toBe("Australia/Sydney");
    expect(safeTimeZone("Australia/Perth")).toBe("Australia/Perth");
  });

  it("prints a range in Australian English", () => {
    expect(formatRange({ since: "2026-09-01", until: "2026-09-30" })).toBe(
      "1 Sept 2026 – 30 Sept 2026",
    );
    expect(formatRange({ since: "2026-09-01", until: "2026-09-01" })).toBe("1 Sept 2026");
  });
});
