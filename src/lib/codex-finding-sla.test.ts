import { describe, expect, it } from "vitest";
import { FINDING_SLA_DAYS, ageInDays, overdueCutoffs, slaStatus } from "./codex-finding-sla";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe("ageInDays", () => {
  it("counts whole days and never goes negative", () => {
    expect(ageInDays(daysAgo(3.9), NOW)).toBe(3);
    expect(ageInDays(daysAgo(-2), NOW)).toBe(0);
    expect(ageInDays(null, NOW)).toBe(0);
    expect(ageInDays("not a date", NOW)).toBe(0);
  });
});

describe("slaStatus", () => {
  it("is overdue only once the severity's response time has passed", () => {
    expect(
      slaStatus({ severity: "critical", state: "open", first_seen_at: daysAgo(7) }, NOW),
    ).toEqual({
      ageDays: 7,
      dueInDays: 0,
      overdue: false,
    });
    expect(
      slaStatus({ severity: "critical", state: "open", first_seen_at: daysAgo(8) }, NOW),
    ).toMatchObject({
      dueInDays: -1,
      overdue: true,
    });
    expect(
      slaStatus({ severity: "high", state: "triaging", first_seen_at: daysAgo(31) }, NOW).overdue,
    ).toBe(true);
  });

  it("stops the clock once someone has decided", () => {
    for (const state of ["resolved", "dismissed", "false_positive", "pr_open", "fix_merged"]) {
      expect(
        slaStatus({ severity: "critical", state, first_seen_at: daysAgo(400) }, NOW),
      ).toMatchObject({
        dueInDays: null,
        overdue: false,
      });
    }
  });

  it("sets no deadline for info", () => {
    expect(
      slaStatus({ severity: "info", state: "open", first_seen_at: daysAgo(999) }, NOW).overdue,
    ).toBe(false);
  });
});

describe("overdueCutoffs", () => {
  it("gives one cutoff per severity with a deadline, matching slaStatus", () => {
    const cutoffs = overdueCutoffs(NOW);
    expect(cutoffs.map((c) => c.severity)).toEqual(["critical", "high", "medium", "low"]);
    for (const c of cutoffs) {
      const limit = FINDING_SLA_DAYS[c.severity] as number;
      const before = Date.parse(c.before);
      // Just past the cutoff is overdue; the cutoff day itself is not.
      expect(
        slaStatus(
          {
            severity: c.severity,
            state: "open",
            first_seen_at: new Date(before - 1).toISOString(),
          },
          NOW,
        ).overdue,
      ).toBe(true);
      expect(
        slaStatus({ severity: c.severity, state: "open", first_seen_at: daysAgo(limit) }, NOW)
          .overdue,
      ).toBe(false);
    }
  });
});
