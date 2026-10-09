import { describe, expect, it } from "vitest";
import {
  TIKTOK_MAX_DAYS_PER_DAILY_REPORT,
  deriveRates,
  isTikTokId,
  judgeTikTokBody,
  parseTikTokAdvertiser,
  parseTikTokCampaigns,
  parseTikTokEnvelope,
  parseTikTokReportPage,
  tiktokDaily,
  tiktokDay,
  tiktokEntities,
  tiktokReport,
  tiktokReportRequest,
  tiktokRowMetrics,
  type TikTokReportRow,
} from "../marketingEngine";

const RANGE = { since: "2026-09-08", until: "2026-10-07" };

function params(url: string) {
  return new URL(url).searchParams;
}

function reportRow(
  dimensions: Record<string, string>,
  metrics: Record<string, string>,
): TikTokReportRow {
  return { dimensions, metrics };
}

describe("TikTok API for Business", () => {
  it("builds the integrated report with JSON-encoded arrays and the token in a header", () => {
    const req = tiktokReportRequest(
      { advertiserId: "7012345678901234567", level: "campaign", range: RANGE, daily: false },
      "TOKEN",
    );
    const p = params(req.url);
    expect(
      req.url.startsWith("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?"),
    ).toBe(true);
    expect(req.url).not.toContain("TOKEN");
    expect(req.headers["Access-Token"]).toBe("TOKEN");
    expect(p.get("report_type")).toBe("BASIC");
    expect(p.get("data_level")).toBe("AUCTION_CAMPAIGN");
    expect(JSON.parse(p.get("dimensions") as string)).toEqual(["campaign_id"]);
    const metrics = JSON.parse(p.get("metrics") as string) as string[];
    expect(metrics).toContain("video_watched_6s");
    expect(metrics).toContain("reach");
    expect(metrics).toContain("campaign_name");
    // Deleted campaigns still spent money.
    expect(JSON.parse(p.get("filtering") as string)).toEqual([
      { field_name: "campaign_status", filter_type: "IN", filter_value: '["STATUS_ALL"]' },
    ]);
  });

  it("never asks for reach per day, because reach is not additive", () => {
    const req = tiktokReportRequest(
      {
        advertiserId: "7012345678901234567",
        level: "advertiser",
        range: { since: "2026-09-08", until: "2026-10-07" },
        daily: true,
      },
      "T",
    );
    const p = params(req.url);
    expect(JSON.parse(p.get("dimensions") as string)).toEqual(["advertiser_id", "stat_time_day"]);
    expect(JSON.parse(p.get("metrics") as string)).not.toContain("reach");
    expect(p.get("filtering")).toBeNull();
    expect(TIKTOK_MAX_DAYS_PER_DAILY_REPORT).toBe(30);
  });

  it("narrows drill-downs by validated ids only", () => {
    const req = tiktokReportRequest(
      {
        advertiserId: "7012345678901234567",
        level: "ad",
        range: RANGE,
        daily: false,
        campaignId: "1700000000000001",
        adGroupId: "not-an-id",
      },
      "T",
    );
    const filtering = JSON.parse(params(req.url).get("filtering") as string) as Array<{
      field_name: string;
    }>;
    expect(filtering.map((f) => f.field_name)).toEqual(["ad_status", "campaign_ids"]);
    expect(isTikTokId("1700000000000001")).toBe(true);
    expect(isTikTokId("17; drop")).toBe(false);
  });

  it("reads HTTP 200 with a non-zero code as a refusal, for the meter and the page", () => {
    const refused = {
      code: 40105,
      message: "Access token is incorrect or has been revoked.",
      request_id: "x",
    };
    expect(judgeTikTokBody(refused)).toBe("error");
    expect(judgeTikTokBody({ code: 0, data: {} })).toBe("success");
    expect(judgeTikTokBody("not json")).toBeNull();
    const env = parseTikTokEnvelope(200, refused);
    expect(env).toMatchObject({ ok: false, reason: "credentials_rejected", code: 40105 });
    expect(parseTikTokEnvelope(200, { code: 40100, message: "Too many requests" })).toMatchObject({
      reason: "rate_limited",
    });
    expect(parseTikTokEnvelope(200, { code: 40001, message: "No permission" })).toMatchObject({
      reason: "permission_denied",
    });
    expect(parseTikTokEnvelope(200, { code: 51004, message: "Internal" })).toMatchObject({
      reason: "vendor_unavailable",
    });
    expect(parseTikTokEnvelope(502, "gateway")).toMatchObject({
      reason: "vendor_unavailable",
      code: null,
    });
  });

  it("reads a suppressed figure as unknown and estimates watch time from average play", () => {
    const m = tiktokRowMetrics(
      reportRow(
        {},
        {
          spend: "20.50",
          impressions: "4000",
          video_play_actions: "1200",
          average_video_play: "3.5",
          video_watched_6s: "300",
          video_views_p100: "60",
          result: "-",
          conversion: "2",
        },
      ),
    );
    expect(m.spend).toBe(20.5);
    expect(m.results).toBeNull();
    expect(m.conversions).toBe(2);
    expect(m.views).toBe(1200);
    expect(m.watchTimeMinutes).toBeCloseTo(70);
    const r = deriveRates(m);
    expect(r.hookRate).toBeCloseTo(0.25);
    expect(r.completionRate).toBeCloseTo(0.05);
  });

  it("reads TikTok’s day stamps", () => {
    expect(tiktokDay("2026-09-01 00:00:00")).toBe("2026-09-01");
    expect(tiktokDay("nope")).toBeNull();
  });

  it("parses a report page and its page count", () => {
    const page = parseTikTokReportPage({
      list: [{ dimensions: { campaign_id: "1" }, metrics: { spend: "1" } }],
      page_info: { page: 1, total_page: 3 },
    });
    expect(page.rows).toHaveLength(1);
    expect(page.totalPages).toBe(3);
  });

  it("builds entities with names from the report and status from the campaign settings", () => {
    const rows = [
      reportRow({ campaign_id: "11" }, { campaign_name: "Lead gen", spend: "30", result: "3" }),
      reportRow({ campaign_id: "22" }, { campaign_name: "Awareness", spend: "70", result: "0" }),
    ];
    const campaigns = parseTikTokCampaigns({
      list: [
        {
          campaign_id: "11",
          campaign_name: "Lead gen",
          objective_type: "LEAD_GENERATION",
          operation_status: "ENABLE",
          budget: "50",
          budget_mode: "BUDGET_MODE_DAY",
        },
      ],
    });
    const entities = tiktokEntities(rows, "campaign", campaigns);
    expect(entities.map((e) => e.id)).toEqual(["22", "11"]);
    expect(entities[1]).toMatchObject({
      name: "Lead gen",
      status: "ENABLE",
      objective: "LEAD_GENERATION",
    });
    expect(campaigns[0]).toMatchObject({ budget: 50, budgetMode: "BUDGET_MODE_DAY" });
  });

  it("reads the advertiser’s own currency", () => {
    expect(
      parseTikTokAdvertiser({
        list: [{ name: "NPC", currency: "AUD", timezone: "Australia/Sydney" }],
      }),
    ).toEqual({ name: "NPC", currency: "AUD", timeZone: "Australia/Sydney" });
    expect(parseTikTokAdvertiser({})).toEqual({ name: null, currency: null, timeZone: null });
  });

  it("takes reach from the whole-range account row, never from summed days", () => {
    const daily = [
      reportRow(
        { advertiser_id: "1", stat_time_day: "2026-09-10 00:00:00" },
        { spend: "10", impressions: "1000" },
      ),
      reportRow(
        { advertiser_id: "1", stat_time_day: "2026-09-11 00:00:00" },
        { spend: "15", impressions: "1500" },
      ),
    ];
    const account = [
      reportRow({ advertiser_id: "1" }, { spend: "25", impressions: "2500", reach: "1800" }),
    ];
    const report = tiktokReport({
      advertiserId: "1",
      advertiserName: "NPC",
      currency: "AUD",
      range: RANGE,
      level: "campaign",
      entityRows: [],
      dailyRows: daily,
      accountRows: account,
      campaigns: [],
    });
    expect(report.totals.reach).toBe(1800);
    expect(report.daily.map((d) => d.metrics.spend)).toEqual([10, 15]);
    const noAccount = tiktokReport({
      advertiserId: "1",
      advertiserName: null,
      currency: "AUD",
      range: RANGE,
      level: "campaign",
      entityRows: [],
      dailyRows: daily,
      accountRows: [],
      campaigns: [],
    });
    expect(noAccount.totals.spend).toBe(25);
    expect(noAccount.totals.reach).toBeNull();
    expect(tiktokDaily(daily)).toHaveLength(2);
  });
});
