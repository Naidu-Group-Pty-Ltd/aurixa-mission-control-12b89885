import { describe, expect, it } from "vitest";
import {
  GOOGLE_ADS_DEFAULT_VERSION,
  deriveRates,
  googleAdsDaily,
  googleAdsEntities,
  googleAdsReport,
  googleAdsRowMetrics,
  googleAdsSearchRequest,
  googleAdsVersion,
  googleErrorOf,
  normaliseCustomerId,
  parseGoogleAdsSearch,
  youtubeAdsQuery,
} from "../marketingEngine";

const RANGE = { since: "2026-09-01", until: "2026-09-30" };

function row(over: {
  id: string;
  name?: string;
  date?: string;
  cost?: string;
  impressions?: string;
  clicks?: string;
  views?: string;
  p100?: number;
  conversions?: number;
}) {
  return {
    customer: { currencyCode: "AUD", descriptiveName: "NPC Services" },
    campaign: {
      id: over.id,
      name: over.name ?? `C${over.id}`,
      status: "ENABLED",
      advertisingChannelType: "VIDEO",
    },
    segments: { adNetworkType: "YOUTUBE", ...(over.date ? { date: over.date } : {}) },
    metrics: {
      ...(over.cost !== undefined ? { costMicros: over.cost } : {}),
      ...(over.impressions !== undefined ? { impressions: over.impressions } : {}),
      ...(over.clicks !== undefined ? { clicks: over.clicks } : {}),
      ...(over.views !== undefined ? { videoTrueviewViews: over.views } : {}),
      ...(over.p100 !== undefined ? { videoQuartileP100Rate: over.p100 } : {}),
      ...(over.conversions !== undefined ? { conversions: over.conversions } : {}),
    },
  };
}

describe("Google Ads — YouTube placements", () => {
  it("asks for TrueView views, never the removed video_views, and only YouTube placements", () => {
    const q = youtubeAdsQuery("campaign", RANGE, { withDate: true });
    expect(q).toContain("metrics.video_trueview_views");
    expect(q).not.toMatch(/metrics\.video_views\b/);
    expect(q).toContain("segments.ad_network_type = 'YOUTUBE'");
    // A segment in WHERE must be selected.
    expect(q).toMatch(/SELECT .*segments\.ad_network_type.* FROM campaign/);
    expect(q).toContain("segments.date BETWEEN '2026-09-01' AND '2026-09-30'");
    expect(q).toContain("segments.date,");
  });

  it("builds ad group and ad queries from their own resources, narrowed by validated ids only", () => {
    expect(youtubeAdsQuery("adgroup", RANGE, { campaignId: "123" })).toMatch(
      /FROM ad_group WHERE .* AND campaign\.id = 123$/,
    );
    expect(youtubeAdsQuery("ad", RANGE, { adGroupId: "456" })).toMatch(
      /FROM ad_group_ad WHERE .*ad_group\.id = 456$/,
    );
    // An id that is not a number never reaches the query.
    expect(youtubeAdsQuery("adgroup", RANGE, { campaignId: "1 OR 1=1" })).not.toContain("OR 1=1");
    expect(() =>
      youtubeAdsQuery("campaign", { since: "2026-09-01' OR '", until: "2026-09-30" }),
    ).toThrow();
  });

  it("normalises customer ids and versions", () => {
    expect(normaliseCustomerId("123-456-7890")).toBe("1234567890");
    expect(normaliseCustomerId("12345")).toBeNull();
    expect(googleAdsVersion("v26")).toBe("v26");
    expect(googleAdsVersion("../v1")).toBe(GOOGLE_ADS_DEFAULT_VERSION);
    expect(GOOGLE_ADS_DEFAULT_VERSION).toBe("v25");
  });

  it("sends the developer token and login customer as headers", () => {
    const req = googleAdsSearchRequest(
      {
        developerToken: "DEV",
        customerId: "1234567890",
        loginCustomerId: "111-222-3333",
        accessToken: "ya29.T",
      },
      "SELECT 1",
      { pageToken: "P2" },
    );
    expect(req.url).toBe(
      "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search",
    );
    expect(req.headers["developer-token"]).toBe("DEV");
    expect(req.headers["login-customer-id"]).toBe("1112223333");
    expect(JSON.parse(req.body as string)).toEqual({ query: "SELECT 1", pageToken: "P2" });
  });

  it("reads micros as money, a selected-but-absent metric as zero, and quartile rates as counts", () => {
    const metrics = googleAdsRowMetrics(
      row({ id: "1", cost: "12500000", impressions: "2000", views: "400", p100: 0.25 }),
    );
    expect(metrics.spend).toBe(12.5);
    expect(metrics.clicks).toBe(0); // selected, omitted by proto3 JSON = zero
    expect(metrics.quartile100).toBe(500);
    expect(metrics.reach).toBeNull(); // never selected = not measured
    expect(deriveRates(metrics).completionRate).toBeCloseTo(0.25);
  });

  it("sums an entity across days and a day across entities", () => {
    const rows = [
      row({ id: "1", date: "2026-09-01", cost: "1000000", impressions: "100", p100: 0.5 }),
      row({ id: "1", date: "2026-09-02", cost: "3000000", impressions: "300", p100: 0.1 }),
      row({ id: "2", date: "2026-09-02", cost: "2000000", impressions: "100" }),
    ];
    const entities = googleAdsEntities(rows, "campaign");
    expect(entities.map((e) => [e.id, e.metrics.spend])).toEqual([
      ["1", 4],
      ["2", 2],
    ]);
    // Weighted by impressions: (50 + 30) / 400 = 20%, not the mean of 50% and 10%.
    expect(deriveRates(entities[0].metrics).completionRate).toBeCloseTo(0.2);
    const daily = googleAdsDaily(rows);
    expect(daily.map((d) => [d.date, d.metrics.spend])).toEqual([
      ["2026-09-01", 1],
      ["2026-09-02", 5],
    ]);
  });

  it("builds a report that names its currency and what a view is", () => {
    const rows = [
      row({
        id: "1",
        date: "2026-09-03",
        cost: "5000000",
        impressions: "1000",
        views: "200",
        conversions: 2,
      }),
    ];
    const report = googleAdsReport({
      customerId: "1234567890",
      range: RANGE,
      level: "campaign",
      entityRows: rows,
      dailyRows: rows,
    });
    expect(report.channel).toBe("youtube_ads");
    expect(report.currency).toBe("AUD");
    expect(report.totals.spend).toBe(5);
    expect(report.totals.conversions).toBe(2);
    expect(report.viewDefinition).toMatch(/TrueView/);
  });

  it("reads Google Ads failures by their own error codes", () => {
    const failure = {
      error: {
        code: 403,
        message: "The caller does not have permission",
        status: "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
            errors: [
              {
                errorCode: { authorizationError: "DEVELOPER_TOKEN_NOT_APPROVED" },
                message: "The developer token is only approved for use with test accounts.",
              },
            ],
          },
        ],
      },
    };
    expect(googleErrorOf(403, failure)).toEqual({
      reason: "permission_denied",
      message: "The developer token is only approved for use with test accounts.",
    });
    const parsed = parseGoogleAdsSearch(403, failure);
    expect(parsed.ok).toBe(false);
    const ok = parseGoogleAdsSearch(200, { results: [row({ id: "9" })], nextPageToken: "" });
    expect(ok).toMatchObject({ ok: true, nextPageToken: null });
  });
});
