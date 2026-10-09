import { describe, expect, it } from "vitest";
import {
  adReportFacts,
  adviseBudget,
  comparePeriods,
  daysInMonthOf,
  detectAdSignals,
  detectYouTubeChannelSignals,
  digestPrompt,
  emptyMetrics,
  fitLine,
  forecastMetric,
  headlineOf,
  monthPacing,
  scoreAdEntities,
  spendConcentration,
  summariseChannels,
  sumMetrics,
  youtubeChannelFacts,
  type ChannelReport,
  type EntityRow,
  type MetricSet,
  type YouTubeVideo,
} from "../marketingEngine";

function m(over: Partial<MetricSet>): MetricSet {
  return { ...emptyMetrics(), ...over };
}

function entity(id: string, metrics: Partial<MetricSet>): EntityRow {
  return {
    id,
    name: `Campaign ${id}`,
    level: "campaign",
    parentId: null,
    parentName: null,
    status: "ENABLE",
    objective: null,
    metrics: m(metrics),
    publishedAt: null,
    durationSeconds: null,
    thumbnailUrl: null,
    url: null,
  };
}

function report(
  entities: EntityRow[],
  channel: ChannelReport["channel"] = "tiktok_ads",
): ChannelReport {
  return {
    channel,
    accountRef: "1",
    accountName: "Test",
    currency: "AUD",
    range: { since: "2026-09-01", until: "2026-09-30" },
    totals: sumMetrics(entities.map((e) => e.metrics)),
    daily: [],
    entities,
    measures: ["spend", "impressions", "clicks", "results"],
    viewDefinition: "Video plays — every time an ad started playing.",
    notes: ["A note the model must not contradict."],
  };
}

describe("advertising findings", () => {
  const r = report([
    entity("good", {
      spend: 200,
      impressions: 40000,
      clicks: 800,
      results: 20,
      videoPlays: 10000,
      views6s: 4000,
      quartile100: 1500,
    }),
    entity("pricey", {
      spend: 300,
      impressions: 30000,
      clicks: 300,
      results: 3,
      videoPlays: 8000,
      views6s: 900,
      quartile100: 200,
    }),
    entity("dud", {
      spend: 120,
      impressions: 9000,
      clicks: 40,
      results: 0,
      videoPlays: 2000,
      views6s: 500,
      quartile100: 50,
    }),
  ]);

  it("fires only rules whose inputs were measured, with the threshold it compared against", () => {
    const signals = detectAdSignals(r);
    const rules = signals.map((s) => `${s.rule}:${s.entityId}`);
    expect(rules).toContain("zero_outcome:dud");
    expect(rules).toContain("cost_per_result_spike:pricey");
    expect(rules).toContain("weak_hook:pricey");
    expect(signals[0].severity).toBe("critical");
    const spike = signals.find((s) => s.rule === "cost_per_result_spike");
    // Account: $620 / 23 results = $26.96; pricey: $100 per result.
    expect(spike?.threshold).toBeCloseTo(620 / 23);
    expect(spike?.value).toBeCloseTo(100);
  });

  it("says nothing about results when results were never measured", () => {
    const unmeasured = report([
      entity("a", { spend: 500, impressions: 20000 }),
      entity("b", { spend: 10, impressions: 20000 }),
    ]);
    expect(
      detectAdSignals(unmeasured).filter(
        (s) => s.rule.includes("outcome") || s.rule.includes("cost_per_result"),
      ),
    ).toEqual([]);
  });

  it("flags an account that spent and recorded no results at all", () => {
    const none = report([entity("a", { spend: 80, impressions: 4000, results: 0 })]);
    expect(detectAdSignals(none).map((s) => s.rule)).toContain("account_zero_outcome");
  });

  it("scores against the account, and refuses to score on fewer than two factors", () => {
    const health = scoreAdEntities(r);
    expect(health[0].entityId).toBe("good");
    expect(health[0].status).toBe("healthy");
    expect(health.find((h) => h.entityId === "dud")?.status).toBe("action_needed");
    const thin = scoreAdEntities(report([entity("x", { spend: 5, impressions: 10 })]));
    expect(thin[0]).toMatchObject({ score: null, status: "not_scored" });
  });

  it("moves at most a fifth of a donor’s spend toward a proven, cheaper campaign", () => {
    const advice = adviseBudget(r);
    expect(advice.moves.length).toBeGreaterThan(0);
    for (const move of advice.moves) {
      expect(move.toId).toBe("good");
      const donor = r.entities.find((e) => e.id === move.fromId);
      expect(move.amount).toBeLessThanOrEqual((donor?.metrics.spend ?? 0) * 0.2 + 0.01);
    }
    expect(advice.notes.join(" ")).toMatch(/upper bound/);
    expect(adviseBudget(report([entity("a", { spend: 10 })])).moves).toEqual([]);
  });

  it("names the fewest entities that carry a share of the spend", () => {
    // $300 of $620 is 48% — short of half, so the next-largest is needed too.
    expect(spendConcentration(r.entities, 0.5).map((e) => e.id)).toEqual(["pricey", "good"]);
    expect(spendConcentration(r.entities, 0.4).map((e) => e.id)).toEqual(["pricey"]);
  });
});

describe("YouTube channel findings", () => {
  const upload = (id: string, publishedAt: string, views: number): YouTubeVideo => ({
    id,
    title: `Upload ${id}`,
    publishedAt,
    durationSeconds: 600,
    views,
    likes: 10,
    comments: 1,
    thumbnailUrl: null,
    liveBroadcastContent: "none",
    isShortForm: false,
    url: `https://www.youtube.com/watch?v=${id}`,
  });

  it("flags a long gap since the last upload, and a net subscriber loss", () => {
    const signals = detectYouTubeChannelSignals({
      uploads: [upload("a", "2026-08-20T00:00:00Z", 100)],
      today: "2026-10-08",
      timeZone: "Australia/Sydney",
      netSubscribers: -12,
      netSubscribersSpanDays: 30,
    });
    expect(signals.map((s) => s.rule)).toEqual(["upload_gap", "subscriber_decline"]);
    expect(signals[0].severity).toBe("critical");
  });

  it("compares a mature upload with the uploads before it, never a young one", () => {
    const uploads = [
      upload("young", "2026-10-01T00:00:00Z", 1),
      upload("weak", "2026-09-01T00:00:00Z", 50),
      upload("o1", "2026-08-01T00:00:00Z", 1000),
      upload("o2", "2026-07-01T00:00:00Z", 1200),
      upload("o3", "2026-06-01T00:00:00Z", 900),
    ];
    const signals = detectYouTubeChannelSignals({
      uploads,
      today: "2026-10-08",
      timeZone: "Australia/Sydney",
      netSubscribers: null,
      netSubscribersSpanDays: null,
    });
    const flagged = signals
      .filter((s) => s.rule === "underperforming_upload")
      .map((s) => s.entityId);
    expect(flagged).toEqual(["weak"]);
  });
});

describe("forecast, pacing and periods", () => {
  it("fits a line exactly through a straight series", () => {
    const fit = fitLine([1, 3, 5, 7]);
    expect(fit?.slope).toBeCloseTo(2);
    expect(fit?.intercept).toBeCloseTo(1);
    expect(fit?.residualSd).toBeCloseTo(0);
  });

  it("refuses to draw a line through too few days, and floors projections at zero", () => {
    const short = forecastMetric([{ date: "2026-09-01", metrics: m({ spend: 1 }) }], "spend", 7);
    expect(short.forecast).toEqual([]);
    expect(short.note).toMatch(/at least 7 days/);
    const falling = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      metrics: m({ spend: 100 - i * 12 }),
    }));
    const f = forecastMetric(falling, "spend", 14);
    expect(f.trend).toBe("falling");
    expect(f.forecast).toHaveLength(14);
    expect(Math.min(...f.forecast.map((p) => p.value))).toBe(0);
    expect(f.note).toMatch(/not a confidence interval/);
  });

  it("ignores unmeasured days rather than reading them as zero", () => {
    const days = Array.from({ length: 8 }, (_, i) => ({
      date: `2026-09-0${i + 1}`,
      metrics: m({ spend: i === 3 ? null : 50 }),
    }));
    const f = forecastMetric(days, "spend", 3);
    expect(f.history).toHaveLength(7);
    expect(f.dailyAverage).toBe(50);
    expect(f.trend).toBe("flat");
  });

  it("paces month-to-date spend against daily budgets only", () => {
    expect(daysInMonthOf("2026-02-10")).toBe(28);
    const p = monthPacing({ asOf: "2026-09-15", monthToDateSpend: 750, dailyBudgetTotal: 40 });
    expect(p.projectedMonthSpend).toBe(1500);
    expect(p.monthBudget).toBe(1200);
    expect(p.status).toBe("over");
    expect(
      monthPacing({ asOf: "2026-09-15", monthToDateSpend: 750, dailyBudgetTotal: null }).status,
    ).toBeNull();
  });

  it("compares periods with the right good direction for each figure", () => {
    const rows = comparePeriods(
      m({ spend: 110, impressions: 1000, results: 10 }),
      m({ spend: 100, impressions: 800, results: 5 }),
    );
    const cost = rows.find((r) => r.key === "costPerResult");
    expect(cost?.goodDirection).toBe("down");
    expect(cost?.change).toBeCloseTo(-0.45);
    expect(rows.find((r) => r.key === "spend")?.goodDirection).toBe("neutral");
    expect(rows.find((r) => r.key === "views")).toBeUndefined();
  });
});

describe("digest facts and the cross-channel line", () => {
  it("hands the model only measured figures, formatted as the page prints them", () => {
    const r = report([entity("a", { spend: 120, impressions: 10000, clicks: 100, results: null })]);
    const facts = adReportFacts({ report: r, signals: [], health: [], attributedLeads: 4 });
    const labels = facts.totals.map((f) => f.label);
    expect(labels).toContain("Spend");
    expect(labels).not.toContain("Results");
    expect(labels).not.toContain("Cost per result");
    expect(facts.totals.find((f) => f.label === "Spend per attributed CRM lead")?.value).toBe(
      "$30.00",
    );
    const prompt = digestPrompt(facts, "a property buyers’ agency in Australia");
    expect(prompt.system).toMatch(/never state a figure that is not in the facts/);
    expect(prompt.user).toContain(":::metric");
    expect(prompt.user).toContain("A note the model must not contradict.");
    expect(prompt.user).not.toMatch(/\bN\/A\b/);
  });

  it("writes YouTube facts without inventing period figures", () => {
    const facts = youtubeChannelFacts({
      channelTitle: "NPC",
      period: "1 Sept 2026 – 30 Sept 2026",
      subscribers: 1200,
      totalViews: 50000,
      uploadsInPeriod: 3,
      uploadsPerWeek: 0.7,
      periodViews: null,
      periodWatchMinutes: null,
      averageViewSeconds: null,
      netSubscribers: 15,
      netSubscribersBasis: "from 2 daily readings over 12 days",
      topTrafficSources: [],
      topUploads: [{ title: "Tour", views: 900, ageDays: 10 }],
      signals: [],
      notes: [],
    });
    const labels = facts.totals.map((f) => f.label);
    expect(labels).not.toContain("Views in the period");
    expect(facts.totals.find((f) => f.label.startsWith("Net subscribers"))?.value).toBe("+15");
  });

  it("never adds money across currencies, and marks a partial total", () => {
    const tiktok = report([entity("a", { spend: 100, results: 2 })]);
    const usd: ChannelReport = {
      ...report([entity("b", { spend: 50, results: 1 })], "youtube_ads"),
      currency: "USD",
    };
    const mixed = summariseChannels([
      headlineOf("tiktok", "TikTok", "ok", tiktok, 3),
      headlineOf("youtube", "YouTube", "ok", usd, 1),
      headlineOf("meta", "Meta", "error", null),
    ]);
    expect(mixed.totalSpend).toBeNull();
    expect(mixed.spendByCurrency.map((s) => s.currency)).toEqual(["AUD", "USD"]);
    expect(mixed.partial).toBe(true);
    expect(mixed.costPerAttributedLead).toBeNull();
    const single = summariseChannels([
      headlineOf("tiktok", "TikTok", "ok", tiktok, 4),
      headlineOf("x", "X", "not_configured", null),
    ]);
    expect(single.totalSpend).toEqual({ currency: "AUD", amount: 100 });
    expect(single.costPerAttributedLead).toBe(25);
    expect(single.notConfigured).toBe(1);
    expect(single.partial).toBe(false);
  });
});
