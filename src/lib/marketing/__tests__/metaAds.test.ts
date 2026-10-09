import { describe, expect, it } from "vitest";
import {
  META_DEFAULT_VERSION,
  metaBudget,
  metaDaily,
  metaEntities,
  metaErrorOf,
  metaInsightMetrics,
  metaInsightsRequest,
  metaReport,
  metaVersion,
  normaliseAdAccountId,
  parseMetaCampaigns,
  parseMetaPage,
} from "../marketingEngine";

const RANGE = { since: "2026-09-01", until: "2026-09-30" };

describe("Meta Ads Insights", () => {
  it("sends the token as a bearer header and never names an expired version by default", () => {
    const req = metaInsightsRequest(
      { adAccountId: "act_123456", level: "campaign", range: RANGE, daily: true },
      "EAATOKEN",
    );
    expect(req.url).not.toContain("EAATOKEN");
    expect(req.headers.Authorization).toBe("Bearer EAATOKEN");
    expect(req.url).toContain(`/${META_DEFAULT_VERSION}/act_123456/insights`);
    expect(META_DEFAULT_VERSION).not.toBe("v21.0");
    const p = new URL(req.url).searchParams;
    expect(p.get("time_increment")).toBe("1");
    expect(JSON.parse(p.get("time_range") as string)).toEqual(RANGE);
    // Reach is unique people: never per day.
    expect((p.get("fields") as string).split(",")).not.toContain("reach");
  });

  it("asks for reach over the whole range and narrows drill-downs by numeric id", () => {
    const req = metaInsightsRequest(
      {
        adAccountId: "act_123456",
        level: "ad",
        range: RANGE,
        daily: false,
        campaignId: "42",
        adSetId: "x",
      },
      "T",
    );
    const p = new URL(req.url).searchParams;
    expect((p.get("fields") as string).split(",")).toContain("reach");
    expect(JSON.parse(p.get("filtering") as string)).toEqual([
      { field: "campaign.id", operator: "IN", value: ["42"] },
    ]);
  });

  it("normalises account ids and versions", () => {
    expect(normaliseAdAccountId("123456")).toBe("act_123456");
    expect(normaliseAdAccountId("act_123456")).toBe("act_123456");
    expect(normaliseAdAccountId("act_abc")).toBeNull();
    expect(metaVersion("v26.0")).toBe("v26.0");
    expect(metaVersion("v26")).toBe(META_DEFAULT_VERSION);
  });

  it("reads leads as the first result action present, never a sum of overlapping ones", () => {
    const m = metaInsightMetrics({
      spend: "100.00",
      impressions: "5000",
      clicks: "80",
      actions: [
        { action_type: "lead", value: "4" },
        { action_type: "offsite_conversion.fb_pixel_lead", value: "3" },
        { action_type: "video_view", value: "900" },
        { action_type: "post_reaction", value: "12" },
      ],
      video_play_actions: [{ action_type: "video_view", value: "1200" }],
      video_p100_watched_actions: [{ action_type: "video_view", value: "150" }],
      video_avg_time_watched_actions: [{ action_type: "video_view", value: "6" }],
    });
    expect(m.results).toBe(4);
    expect(m.views).toBe(900);
    expect(m.videoPlays).toBe(1200);
    expect(m.quartile100).toBe(150);
    expect(m.watchTimeMinutes).toBeCloseTo(120);
    expect(m.likes).toBe(12);
    expect(m.comments).toBe(0); // the list was present: a measured zero
  });

  it("leaves actions unmeasured when the row carries no action list", () => {
    const m = metaInsightMetrics({ spend: "10", impressions: "100" });
    expect(m.results).toBeNull();
    expect(m.likes).toBeNull();
  });

  it("reads budgets in minor units, except zero-decimal currencies", () => {
    expect(metaBudget("5000", "AUD")).toBe(50);
    expect(metaBudget("5000", "JPY")).toBe(5000);
    expect(metaBudget("0", "AUD")).toBeNull();
    expect(
      parseMetaCampaigns(
        [{ id: "1", name: "A", effective_status: "ACTIVE", daily_budget: "2500" }],
        "AUD",
      )[0],
    ).toMatchObject({ status: "ACTIVE", dailyBudget: 25 });
  });

  it("pages by cursor only while Meta says there is a next page", () => {
    expect(
      parseMetaPage(200, {
        data: [{ a: 1 }],
        paging: { cursors: { after: "C1" }, next: "https://graph.facebook.com/next" },
      }),
    ).toEqual({ ok: true, rows: [{ a: 1 }], after: "C1" });
    expect(parseMetaPage(200, { data: [], paging: { cursors: { after: "C1" } } })).toEqual({
      ok: true,
      rows: [],
      after: null,
    });
  });

  it("tells an expired token from a rate limit from a missing object", () => {
    expect(
      metaErrorOf(400, { error: { code: 190, message: "Error validating access token" } }).reason,
    ).toBe("credentials_rejected");
    expect(
      metaErrorOf(400, { error: { code: 17, message: "User request limit reached" } }).reason,
    ).toBe("rate_limited");
    expect(
      metaErrorOf(400, {
        error: { code: 100, error_subcode: 33, message: "Object does not exist" },
      }).reason,
    ).toBe("not_found");
    expect(metaErrorOf(403, { error: { code: 200, message: "Permissions error" } }).reason).toBe(
      "permission_denied",
    );
  });

  it("builds entities, a daily series and a report", () => {
    const entityRows = [
      {
        campaign_id: "1",
        campaign_name: "Leads",
        spend: "60",
        impressions: "3000",
        reach: "2000",
        actions: [{ action_type: "lead", value: "3" }],
      },
      {
        campaign_id: "2",
        campaign_name: "Brand",
        spend: "40",
        impressions: "9000",
        reach: "7000",
        actions: [],
      },
    ];
    const entities = metaEntities(
      entityRows,
      "campaign",
      parseMetaCampaigns(
        [{ id: "1", effective_status: "ACTIVE", objective: "OUTCOME_LEADS" }],
        "AUD",
      ),
    );
    expect(entities[0]).toMatchObject({ id: "1", status: "ACTIVE", objective: "OUTCOME_LEADS" });
    const dailyRows = [
      { date_start: "2026-09-02", date_stop: "2026-09-02", spend: "30", actions: [] },
      {
        date_start: "2026-09-01",
        date_stop: "2026-09-01",
        spend: "70",
        actions: [{ action_type: "lead", value: "3" }],
      },
    ];
    expect(metaDaily(dailyRows).map((d) => d.date)).toEqual(["2026-09-01", "2026-09-02"]);
    const report = metaReport({
      adAccountId: "act_1",
      accountName: "NPC",
      currency: "AUD",
      range: RANGE,
      level: "campaign",
      entityRows,
      dailyRows,
      accountRows: [],
      campaigns: [],
    });
    expect(report.totals.spend).toBe(100);
    expect(report.totals.reach).toBeNull();
    expect(report.totals.results).toBe(3);
  });
});
