import { describe, expect, it } from "vitest";
import {
  channelGrowth,
  googleErrorOf,
  googleTokenRequest,
  isYouTubeChannelId,
  parseGoogleToken,
  parseIsoDuration,
  parseResultTable,
  parseUploadsPage,
  parseYouTubeChannel,
  parseYouTubeVideos,
  shouldReadNextUploadsPage,
  trafficSourceLabel,
  uploadsInRange,
  uploadsPerWeek,
  uploadsPlaylistOf,
  youtubeAnalyticsRequest,
  youtubeChannelRequest,
  youtubeDailyQuery,
  youtubeDailySeries,
  youtubeTopVideos,
  youtubeTrafficSources,
  youtubeVideoEntity,
  youtubeVideosRequest,
} from "../marketingEngine";

const CHANNEL_ID = "UCabcdefghijklmnopqrstuv";

describe("YouTube Data API", () => {
  it("sends the key as a header and never in the URL", () => {
    const req = youtubeChannelRequest(CHANNEL_ID, "AIzaSECRETKEYVALUE");
    expect(req.url).not.toContain("AIzaSECRETKEYVALUE");
    expect(req.url).toContain("youtube.googleapis.com/youtube/v3/channels");
    expect(req.url).toContain("part=snippet%2Cstatistics%2CcontentDetails");
    expect(req.headers["X-Goog-Api-Key"]).toBe("AIzaSECRETKEYVALUE");
  });

  it("caps a videos request at fifty ids", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `v${i}`);
    const req = youtubeVideosRequest(ids, "k");
    const idParam = new URL(req.url).searchParams.get("id") ?? "";
    expect(idParam.split(",")).toHaveLength(50);
  });

  it("recognises a channel id and derives its uploads playlist", () => {
    expect(isYouTubeChannelId(CHANNEL_ID)).toBe(true);
    expect(isYouTubeChannelId("@npcservices")).toBe(false);
    expect(uploadsPlaylistOf(CHANNEL_ID)).toBe("UUabcdefghijklmnopqrstuv");
  });

  it("reads a channel, and a hidden subscriber count as unknown rather than zero", () => {
    const body = {
      items: [
        {
          id: CHANNEL_ID,
          snippet: {
            title: "NPC Services",
            customUrl: "@npcservices",
            publishedAt: "2019-01-01T00:00:00Z",
            thumbnails: { high: { url: "https://yt3.ggpht.com/x" } },
          },
          statistics: {
            viewCount: "120345",
            subscriberCount: "0",
            hiddenSubscriberCount: true,
            videoCount: "87",
          },
          contentDetails: { relatedPlaylists: { uploads: "UUabcdefghijklmnopqrstuv" } },
        },
      ],
    };
    const parsed = parseYouTubeChannel(200, body);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.channel.subscribers).toBeNull();
    expect(parsed.channel.subscribersHidden).toBe(true);
    expect(parsed.channel.totalViews).toBe(120345);
    expect(parsed.channel.url).toBe("https://www.youtube.com/@npcservices");
  });

  it("says an unknown channel id names nothing", () => {
    const parsed = parseYouTubeChannel(200, { items: [] });
    expect(parsed.ok).toBe(false);
    expect((parsed as { reason?: string }).reason).toBe("not_found");
  });

  it("tells a spent quota from a bad key from a disabled API", () => {
    const quota = {
      error: {
        code: 403,
        message: "The request cannot be completed because you have exceeded your quota.",
        errors: [{ reason: "quotaExceeded", domain: "youtube.quota" }],
      },
    };
    expect(googleErrorOf(403, quota).reason).toBe("quota_exhausted");
    const badKey = {
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" },
        ],
      },
    };
    expect(googleErrorOf(400, badKey).reason).toBe("credentials_rejected");
    const disabled = {
      error: {
        code: 403,
        message: "YouTube Data API v3 has not been used in project 123 before or it is disabled.",
        status: "PERMISSION_DENIED",
        details: [{ reason: "SERVICE_DISABLED" }],
      },
    };
    expect(googleErrorOf(403, disabled).reason).toBe("permission_denied");
    expect(googleErrorOf(503, {}).reason).toBe("vendor_unavailable");
    expect(googleErrorOf(400, { error: { message: "Invalid value" } }).reason).toBe(
      "request_rejected",
    );
  });

  it("pages uploads only while they can still fall inside the range", () => {
    const page = parseUploadsPage(200, {
      items: [
        { contentDetails: { videoId: "a", videoPublishedAt: "2026-10-05T01:00:00Z" } },
        { contentDetails: { videoId: "b", videoPublishedAt: "2026-09-20T01:00:00Z" } },
      ],
      nextPageToken: "NEXT",
    });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.nextPageToken).toBe("NEXT");
    expect(
      shouldReadNextUploadsPage(
        page.items,
        { since: "2026-09-08", until: "2026-10-07" },
        "Australia/Sydney",
      ),
    ).toBe(true);
    expect(
      shouldReadNextUploadsPage(
        page.items,
        { since: "2026-10-01", until: "2026-10-07" },
        "Australia/Sydney",
      ),
    ).toBe(false);
    expect(parseUploadsPage(404, {})).toEqual({ ok: true, items: [], nextPageToken: null });
  });

  it("parses ISO 8601 durations as YouTube writes them", () => {
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("PT1M5S")).toBe(65);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("P1DT2H")).toBe(93600);
    expect(parseIsoDuration("P0D")).toBe(0);
    expect(parseIsoDuration("PT")).toBeNull();
    expect(parseIsoDuration("nonsense")).toBeNull();
  });

  it("reads videos with lifetime counters, hidden likes left unknown", () => {
    const parsed = parseYouTubeVideos(200, {
      items: [
        {
          id: "v1",
          snippet: { title: "Short one", publishedAt: "2026-10-02T00:00:00Z" },
          statistics: { viewCount: "900", commentCount: "4" },
          contentDetails: { duration: "PT58S" },
        },
        {
          id: "v2",
          snippet: {
            title: "Long one",
            publishedAt: "2026-09-01T00:00:00Z",
            liveBroadcastContent: "none",
          },
          statistics: { viewCount: "5000", likeCount: "120", commentCount: "10" },
          contentDetails: { duration: "PT12M" },
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [short, long] = parsed.videos;
    expect(short.likes).toBeNull();
    expect(short.isShortForm).toBe(true);
    expect(long.isShortForm).toBe(false);
    const entity = youtubeVideoEntity(long);
    expect(entity.level).toBe("video");
    expect(entity.metrics.views).toBe(5000);
    expect(entity.metrics.spend).toBeNull();
    expect(entity.url).toBe("https://www.youtube.com/watch?v=v2");
    const inRange = uploadsInRange(
      parsed.videos,
      { since: "2026-10-01", until: "2026-10-07" },
      "Australia/Sydney",
    );
    expect(inRange.map((v) => v.id)).toEqual(["v1"]);
  });

  it("states uploads per week over the range", () => {
    expect(uploadsPerWeek(4, 28)).toBe(1);
    expect(uploadsPerWeek(1, 0)).toBeNull();
  });

  it("states growth only between two readings, and how long they span", () => {
    const range = { since: "2026-09-08", until: "2026-10-07" };
    const one = channelGrowth(
      [{ date: "2026-10-07", subscribers: 1000, totalViews: 5000, videoCount: 10 }],
      range,
      "2026-09-07",
    );
    expect(one.netSubscribers).toBeNull();
    const two = channelGrowth(
      [
        { date: "2026-10-02", subscribers: 990, totalViews: 4800, videoCount: 9 },
        { date: "2026-10-07", subscribers: 1000, totalViews: 5000, videoCount: 10 },
        { date: "2026-08-01", subscribers: 500, totalViews: 1000, videoCount: 2 },
      ],
      range,
      "2026-09-07",
    );
    expect(two.netSubscribers).toBe(10);
    expect(two.netViews).toBe(200);
    expect(two.spanDays).toBe(5);
    expect(two.readings).toBe(2);
    const hidden = channelGrowth(
      [
        { date: "2026-10-02", subscribers: null, totalViews: 4800, videoCount: 9 },
        { date: "2026-10-07", subscribers: 1000, totalViews: 5000, videoCount: 10 },
      ],
      range,
      "2026-09-07",
    );
    expect(hidden.netSubscribers).toBeNull();
  });
});

describe("YouTube Analytics API", () => {
  it("asks for MINE with a bearer token and only additive daily metrics", () => {
    const req = youtubeAnalyticsRequest(
      "ya29.TOKEN",
      youtubeDailyQuery({ since: "2026-09-01", until: "2026-09-30" }),
    );
    const url = new URL(req.url);
    expect(url.origin).toBe("https://youtubeanalytics.googleapis.com");
    expect(url.searchParams.get("ids")).toBe("channel==MINE");
    expect(url.searchParams.get("startDate")).toBe("2026-09-01");
    expect(url.searchParams.get("dimensions")).toBe("day");
    expect(url.searchParams.get("metrics")).not.toContain("averageViewDuration");
    expect(req.headers.Authorization).toBe("Bearer ya29.TOKEN");
  });

  it("reads a result table into a daily series", () => {
    const parsed = parseResultTable(200, {
      columnHeaders: [
        { name: "day" },
        { name: "views" },
        { name: "estimatedMinutesWatched" },
        { name: "likes" },
        { name: "comments" },
        { name: "shares" },
        { name: "subscribersGained" },
        { name: "subscribersLost" },
      ],
      rows: [
        ["2026-09-02", 140, 300, 8, 1, 2, 5, 1],
        ["2026-09-01", 100, 200, 5, 0, 1, 3, 2],
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const daily = youtubeDailySeries(parsed.table);
    expect(daily.map((d) => d.date)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(daily[0].metrics.follows).toBe(3);
    expect(daily[0].metrics.unfollows).toBe(2);
    expect(daily[1].metrics.watchTimeMinutes).toBe(300);
    expect(daily[0].metrics.spend).toBeNull();
  });

  it("reads a table with no rows as a quiet range, not an error", () => {
    const parsed = parseResultTable(200, { columnHeaders: [{ name: "day" }, { name: "views" }] });
    expect(parsed.ok && parsed.table.rows).toEqual([]);
  });

  it("names traffic sources in YouTube Studio’s words and shares them", () => {
    const parsed = parseResultTable(200, {
      columnHeaders: [
        { name: "insightTrafficSourceType" },
        { name: "views" },
        { name: "estimatedMinutesWatched" },
      ],
      rows: [
        ["YT_SEARCH", 30, 60],
        ["RELATED_VIDEO", 70, 120],
        ["SOMETHING_NEW", 0, 0],
      ],
    });
    if (!parsed.ok) throw new Error("expected a table");
    const sources = youtubeTrafficSources(parsed.table);
    expect(sources[0]).toMatchObject({
      key: "RELATED_VIDEO",
      label: "Suggested videos",
      share: 0.7,
    });
    expect(trafficSourceLabel("SOMETHING_NEW")).toBe("Something new");
  });

  it("reads top videos", () => {
    const parsed = parseResultTable(200, {
      columnHeaders: [
        { name: "video" },
        { name: "views" },
        { name: "estimatedMinutesWatched" },
        { name: "averageViewDuration" },
        { name: "subscribersGained" },
        { name: "likes" },
      ],
      rows: [["abc", 500, 900, 108, 7, 20]],
    });
    if (!parsed.ok) throw new Error("expected a table");
    expect(youtubeTopVideos(parsed.table)[0]).toEqual({
      videoId: "abc",
      views: 500,
      watchTimeMinutes: 900,
      averageViewDurationSeconds: 108,
      subscribersGained: 7,
      likes: 20,
    });
  });
});

describe("Google OAuth", () => {
  it("exchanges a refresh token with a form body", () => {
    const req = googleTokenRequest({ clientId: "id", clientSecret: "secret", refreshToken: "rt" });
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://oauth2.googleapis.com/token");
    expect(new URLSearchParams(req.body).get("grant_type")).toBe("refresh_token");
  });

  it("reads a token, and a revoked refresh token as a credential problem", () => {
    expect(parseGoogleToken(200, { access_token: "ya29.x", expires_in: 3599 })).toEqual({
      ok: true,
      accessToken: "ya29.x",
      expiresInSeconds: 3599,
      scope: null,
    });
    const revoked = parseGoogleToken(400, {
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    });
    expect(revoked).toEqual({
      ok: false,
      reason: "credentials_rejected",
      message: "Token has been expired or revoked.",
    });
  });
});
