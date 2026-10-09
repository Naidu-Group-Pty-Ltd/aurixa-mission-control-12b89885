// The Marketing module's vendor reads — Meta, Google Ads on YouTube, TikTok
// and the YouTube channel — and the probe each connection is verified with.
//
// This is the prime's `_shared/marketingChannelReads.ts` carried across: the
// engine decides what an answer means, this asks the questions. The one
// difference is where credentials come from — `marketing_connections`, never
// the environment — so every read starts by loading its source and answers
// `not_configured` with the missing field names when it is not connected.
//
// A read never throws for a vendor's sake: a refusal, a timeout or an
// unreadable answer becomes a `SourceState` the page can explain.
import {
  MAX_UPLOAD_PAGES,
  META_MAX_PAGES,
  RECENT_UPLOAD_COUNT,
  TIKTOK_MAX_DAYS_PER_DAILY_REPORT,
  TIKTOK_MAX_PAGES,
  GOOGLE_ADS_MAX_PAGES,
  addDays,
  googleAdsDaily,
  googleAdsReport,
  googleAdsSearchRequest,
  googleAdsVersion,
  judgeTikTokBody,
  metaAccountRequest,
  metaCampaignsRequest,
  metaDaily,
  metaErrorOf,
  metaInsightsRequest,
  metaReport,
  metaVersion,
  normaliseAdAccountId,
  normaliseCustomerId,
  parseGoogleAdsSearch,
  parseMetaCampaigns,
  parseMetaPage,
  parseResultTable,
  parseTikTokAdvertiser,
  parseTikTokCampaigns,
  parseTikTokEnvelope,
  parseTikTokReportPage,
  parseUploadsPage,
  parseYouTubeChannel,
  parseYouTubeVideos,
  previousPeriod,
  rangeContains,
  shouldReadNextUploadsPage,
  splitRange,
  sumMetrics,
  tiktokAdvertiserInfoRequest,
  tiktokCampaignsRequest,
  tiktokDaily,
  tiktokReport,
  tiktokReportRequest,
  uploadsPlaylistOf,
  youtubeAdsQuery,
  youtubeAnalyticsRequest,
  youtubeChannelRequest,
  youtubeDailyQuery,
  youtubeDailySeries,
  youtubeTopVideos,
  youtubeTopVideosQuery,
  youtubeTrafficSourceQuery,
  youtubeTrafficSources,
  youtubeUploadsRequest,
  youtubeVideosRequest,
  type ChannelReport,
  type DateRange,
  type MetaCampaignInfo,
  type MetricSet,
  type SourceState,
  type TikTokCampaignInfo,
  type TikTokReportRow,
  type TopVideoRow,
  type TrafficSourceRow,
  type UploadItem,
  type YouTubeChannelInfo,
  type YouTubeVideo,
} from "@/lib/marketing/marketingEngine";
import { SOURCE_DEFINITIONS, type MarketingSource } from "@/lib/marketing/connectionFields.pure";
import { loadConnection, type LoadedConnection, type ProbeResult } from "./connections.server";
import { failed, googleAccessToken, sendVendorRequest, unreachable } from "./vendor.server";

export type AdLevel = "campaign" | "adgroup" | "ad";

function labelOf(source: MarketingSource, key: string): string {
  return SOURCE_DEFINITIONS[source].fields.find((f) => f.key === key)?.label ?? key;
}

/**
 * Load a source, or say it is not connected — naming the fields still needed,
 * in the form's own words. A database failure is a failure, not "not
 * connected": the two send an operator to different places.
 */
async function connectionFor(
  source: MarketingSource,
): Promise<{ ok: true; c: LoadedConnection } | { ok: false; state: SourceState }> {
  try {
    const loaded = await loadConnection(source);
    if (loaded.connection) return { ok: true, c: loaded.connection };
    return {
      ok: false,
      state: { state: "not_configured", missing: loaded.missing.map((k) => labelOf(source, k)) },
    };
  } catch (error) {
    return {
      ok: false,
      state: failed(
        "unknown",
        `The stored connection could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
        null,
      ),
    };
  }
}

// ── YouTube: the channel ──────────────────────────────────────────────────────

export interface YouTubeChannelRead {
  state: SourceState;
  channel: YouTubeChannelInfo | null;
  videos: YouTubeVideo[];
  uploads: UploadItem[];
  quotaUnits: number;
}

async function youtubeChannelWith(
  c: LoadedConnection,
  range: DateRange | null,
  timeZone: string,
): Promise<YouTubeChannelRead> {
  const apiKey = c.secrets.api_key;
  const channelId = c.settings.channel_id;
  const empty: YouTubeChannelRead = {
    state: { state: "ok" },
    channel: null,
    videos: [],
    uploads: [],
    quotaUnits: 0,
  };
  let units = 0;
  const channelAnswer = await sendVendorRequest(youtubeChannelRequest(channelId, apiKey));
  units += 1;
  if (channelAnswer.status === 0)
    return { ...empty, state: unreachable("YouTube"), quotaUnits: units };
  const parsedChannel = parseYouTubeChannel(channelAnswer.status, channelAnswer.body);
  if (!parsedChannel.ok) {
    return {
      ...empty,
      state: failed(parsedChannel.reason, parsedChannel.message, parsedChannel.status),
      quotaUnits: units,
    };
  }
  const channel = parsedChannel.channel;

  const playlistId = channel.uploadsPlaylistId ?? uploadsPlaylistOf(channel.id);
  const uploads: UploadItem[] = [];
  if (playlistId) {
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_UPLOAD_PAGES; page++) {
      const answer = await sendVendorRequest(youtubeUploadsRequest(playlistId, apiKey, pageToken));
      units += 1;
      if (answer.status === 0) break;
      const parsed = parseUploadsPage(answer.status, answer.body);
      if (!parsed.ok)
        return {
          state: failed(parsed.reason, parsed.message, parsed.status),
          channel,
          videos: [],
          uploads,
          quotaUnits: units,
        };
      uploads.push(...parsed.items);
      pageToken = parsed.nextPageToken;
      if (!pageToken) break;
      if (!range || !shouldReadNextUploadsPage(parsed.items, range, timeZone)) break;
    }
  }

  const wanted = new Set<string>(uploads.slice(0, RECENT_UPLOAD_COUNT + 15).map((u) => u.videoId));
  if (range) {
    for (const u of uploads) {
      const day = u.publishedAt ? u.publishedAt.slice(0, 10) : null;
      // A day either side of the range: publishedAt is UTC and the range is local.
      if (day && day >= addDays(range.since, -1) && day <= addDays(range.until, 1))
        wanted.add(u.videoId);
    }
  }
  const ids = [...wanted].slice(0, 100);
  const videos: YouTubeVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const answer = await sendVendorRequest(youtubeVideosRequest(ids.slice(i, i + 50), apiKey));
    units += 1;
    if (answer.status === 0)
      return { state: unreachable("YouTube"), channel, videos, uploads, quotaUnits: units };
    const parsed = parseYouTubeVideos(answer.status, answer.body);
    if (!parsed.ok)
      return {
        state: failed(parsed.reason, parsed.message, parsed.status),
        channel,
        videos,
        uploads,
        quotaUnits: units,
      };
    videos.push(...parsed.videos);
  }
  videos.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  return { state: { state: "ok" }, channel, videos, uploads, quotaUnits: units };
}

export async function readYouTubeChannel(
  range: DateRange | null,
  timeZone: string,
): Promise<YouTubeChannelRead> {
  const conn = await connectionFor("youtube_data");
  if (!conn.ok) return { state: conn.state, channel: null, videos: [], uploads: [], quotaUnits: 0 };
  return youtubeChannelWith(conn.c, range, timeZone);
}

// ── YouTube: analytics (the owner's consent) ─────────────────────────────────

export interface YouTubeAnalyticsRead {
  state: SourceState;
  daily: ChannelReport["daily"];
  totals: MetricSet | null;
  previousTotals: MetricSet | null;
  trafficSources: TrafficSourceRow[];
  topVideos: TopVideoRow[];
}

export async function readYouTubeAnalytics(range: DateRange): Promise<YouTubeAnalyticsRead> {
  const empty: YouTubeAnalyticsRead = {
    state: { state: "ok" },
    daily: [],
    totals: null,
    previousTotals: null,
    trafficSources: [],
    topVideos: [],
  };
  const conn = await connectionFor("youtube_analytics");
  if (!conn.ok) return { ...empty, state: conn.state };
  const { settings, secrets } = conn.c;
  const token = await googleAccessToken(
    {
      clientId: settings.client_id,
      clientSecret: secrets.client_secret,
      refreshToken: secrets.refresh_token,
    },
    "YouTube Analytics",
  );
  if (!token.ok) return { ...empty, state: token.state };

  const previous = previousPeriod(range);
  const both = { since: previous.since, until: range.until };
  const [dailyAnswer, sourcesAnswer, topAnswer] = await Promise.all([
    sendVendorRequest(youtubeAnalyticsRequest(token.token, youtubeDailyQuery(both))),
    sendVendorRequest(youtubeAnalyticsRequest(token.token, youtubeTrafficSourceQuery(range))),
    sendVendorRequest(youtubeAnalyticsRequest(token.token, youtubeTopVideosQuery(range))),
  ]);
  if (dailyAnswer.status === 0) return { ...empty, state: unreachable("YouTube Analytics") };
  const dailyTable = parseResultTable(dailyAnswer.status, dailyAnswer.body);
  if (!dailyTable.ok)
    return { ...empty, state: failed(dailyTable.reason, dailyTable.message, dailyTable.status) };
  const daily = youtubeDailySeries(dailyTable.table);
  const current = daily.filter((d) => rangeContains(range, d.date));
  const before = daily.filter((d) => rangeContains(previous, d.date));
  const sourcesTable =
    sourcesAnswer.status === 0 ? null : parseResultTable(sourcesAnswer.status, sourcesAnswer.body);
  const topTable =
    topAnswer.status === 0 ? null : parseResultTable(topAnswer.status, topAnswer.body);
  return {
    state: { state: "ok" },
    daily: current,
    totals: current.length > 0 ? sumMetrics(current.map((d) => d.metrics)) : null,
    previousTotals: before.length > 0 ? sumMetrics(before.map((d) => d.metrics)) : null,
    trafficSources:
      sourcesTable && sourcesTable.ok ? youtubeTrafficSources(sourcesTable.table) : [],
    topVideos: topTable && topTable.ok ? youtubeTopVideos(topTable.table) : [],
  };
}

// ── Advertising: shared shape ─────────────────────────────────────────────────

export interface AdsRead {
  state: SourceState;
  report: ChannelReport | null;
  previousTotals: MetricSet | null;
}

export interface Drill {
  campaignId?: string | null;
  adGroupId?: string | null;
}

// ── Google Ads on YouTube ─────────────────────────────────────────────────────

async function googleAdsCredentials(c: LoadedConnection) {
  const customerId = normaliseCustomerId(c.settings.customer_id);
  if (!customerId) {
    return {
      ok: false as const,
      state: failed(
        "request_rejected",
        "The Google Ads customer id is not a ten-digit customer id (123-456-7890).",
        null,
      ),
    };
  }
  const token = await googleAccessToken(
    {
      clientId: c.settings.client_id,
      clientSecret: c.secrets.client_secret,
      refreshToken: c.secrets.refresh_token,
    },
    "Google Ads",
  );
  if (!token.ok) return { ok: false as const, state: token.state };
  return {
    ok: true as const,
    credentials: {
      developerToken: c.secrets.developer_token,
      customerId,
      loginCustomerId: c.settings.login_customer_id ?? null,
      accessToken: token.token,
    },
    version: googleAdsVersion(c.settings.api_version),
  };
}

async function googleAdsSearchAll(
  credentials: Parameters<typeof googleAdsSearchRequest>[0],
  query: string,
  version: string,
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; state: SourceState }> {
  const rows: Record<string, unknown>[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < GOOGLE_ADS_MAX_PAGES; page++) {
    const answer = await sendVendorRequest(
      googleAdsSearchRequest(credentials, query, { version, pageToken }),
    );
    if (answer.status === 0) return { ok: false, state: unreachable("Google Ads") };
    const parsed = parseGoogleAdsSearch(answer.status, answer.body);
    if (!parsed.ok)
      return { ok: false, state: failed(parsed.reason, parsed.message, parsed.status) };
    rows.push(...parsed.rows);
    pageToken = parsed.nextPageToken;
    if (!pageToken) break;
  }
  return { ok: true, rows };
}

export async function readYouTubeAds(
  range: DateRange,
  level: AdLevel,
  drill: Drill = {},
): Promise<AdsRead> {
  const empty: AdsRead = { state: { state: "ok" }, report: null, previousTotals: null };
  const conn = await connectionFor("google_ads");
  if (!conn.ok) return { ...empty, state: conn.state };
  const creds = await googleAdsCredentials(conn.c);
  if (!creds.ok) return { ...empty, state: creds.state };

  const previous = previousPeriod(range);
  const both = { since: previous.since, until: range.until };
  // One campaign-by-day question answers the daily series, this period and the last.
  const dailyRead = await googleAdsSearchAll(
    creds.credentials,
    youtubeAdsQuery("campaign", both, { withDate: true }),
    creds.version,
  );
  if (!dailyRead.ok) return { ...empty, state: dailyRead.state };
  let entityRows = dailyRead.rows;
  if (level !== "campaign") {
    const entityRead = await googleAdsSearchAll(
      creds.credentials,
      youtubeAdsQuery(level, range, drill),
      creds.version,
    );
    if (!entityRead.ok) return { ...empty, state: entityRead.state };
    entityRows = entityRead.rows;
  }
  const report = googleAdsReport({
    customerId: creds.credentials.customerId,
    range,
    level,
    entityRows,
    dailyRows: dailyRead.rows.filter((r) => {
      const date = ((r.segments ?? {}) as Record<string, unknown>).date;
      return typeof date === "string" && rangeContains(range, date);
    }),
  });
  const before = googleAdsDaily(dailyRead.rows).filter((p) => rangeContains(previous, p.date));
  return {
    state: { state: "ok" },
    report,
    previousTotals: before.length > 0 ? sumMetrics(before.map((p) => p.metrics)) : null,
  };
}

// ── TikTok ────────────────────────────────────────────────────────────────────

async function tiktokReportAll(
  query: Parameters<typeof tiktokReportRequest>[0],
  accessToken: string,
): Promise<{ ok: true; rows: TikTokReportRow[] } | { ok: false; state: SourceState }> {
  const rows: TikTokReportRow[] = [];
  for (let page = 1; page <= TIKTOK_MAX_PAGES; page++) {
    const answer = await sendVendorRequest(tiktokReportRequest({ ...query, page }, accessToken));
    if (answer.status === 0) return { ok: false, state: unreachable("TikTok") };
    const envelope = parseTikTokEnvelope(answer.status, answer.body);
    if (!envelope.ok)
      return { ok: false, state: failed(envelope.reason, envelope.message, envelope.status) };
    const parsed = parseTikTokReportPage(envelope.data);
    rows.push(...parsed.rows);
    if (parsed.totalPages === null || page >= parsed.totalPages) break;
  }
  return { ok: true, rows };
}

export interface TikTokRead extends AdsRead {
  campaigns: TikTokCampaignInfo[];
}

export async function readTikTokAds(
  range: DateRange,
  level: AdLevel,
  drill: Drill = {},
): Promise<TikTokRead> {
  const empty: TikTokRead = {
    state: { state: "ok" },
    report: null,
    previousTotals: null,
    campaigns: [],
  };
  const conn = await connectionFor("tiktok_ads");
  if (!conn.ok) return { ...empty, state: conn.state };
  const accessToken = conn.c.secrets.access_token;
  const advertiserId = conn.c.settings.advertiser_id;

  const infoAnswer = await sendVendorRequest(
    tiktokAdvertiserInfoRequest(advertiserId, accessToken),
  );
  if (infoAnswer.status === 0) return { ...empty, state: unreachable("TikTok") };
  const infoEnv = parseTikTokEnvelope(infoAnswer.status, infoAnswer.body);
  if (!infoEnv.ok)
    return { ...empty, state: failed(infoEnv.reason, infoEnv.message, infoEnv.status) };
  const advertiser = parseTikTokAdvertiser(infoEnv.data);

  const previous = previousPeriod(range);
  const dailyRows: TikTokReportRow[] = [];
  for (const piece of splitRange(
    { since: previous.since, until: range.until },
    TIKTOK_MAX_DAYS_PER_DAILY_REPORT,
  )) {
    const read = await tiktokReportAll(
      { advertiserId, level: "advertiser", range: piece, daily: true },
      accessToken,
    );
    if (!read.ok) return { ...empty, state: read.state };
    dailyRows.push(...read.rows);
  }
  const [entityRead, accountRead, campaignAnswer] = await Promise.all([
    tiktokReportAll(
      {
        advertiserId,
        level,
        range,
        daily: false,
        campaignId: drill.campaignId,
        adGroupId: drill.adGroupId,
      },
      accessToken,
    ),
    tiktokReportAll({ advertiserId, level: "advertiser", range, daily: false }, accessToken),
    sendVendorRequest(tiktokCampaignsRequest(advertiserId, accessToken)),
  ]);
  if (!entityRead.ok) return { ...empty, state: entityRead.state };
  let campaigns: TikTokCampaignInfo[] = [];
  if (campaignAnswer.status !== 0 && judgeTikTokBody(campaignAnswer.body) !== "error") {
    const campaignEnv = parseTikTokEnvelope(campaignAnswer.status, campaignAnswer.body);
    if (campaignEnv.ok) campaigns = parseTikTokCampaigns(campaignEnv.data);
  }
  const inRange = dailyRows.filter((r) => {
    const day =
      typeof r.dimensions.stat_time_day === "string" ? r.dimensions.stat_time_day.slice(0, 10) : "";
    return rangeContains(range, day);
  });
  const report = tiktokReport({
    advertiserId,
    advertiserName: advertiser.name,
    currency: advertiser.currency,
    range,
    level,
    entityRows: entityRead.rows,
    dailyRows: inRange,
    accountRows: accountRead.ok ? accountRead.rows : [],
    campaigns,
  });
  const before = tiktokDaily(dailyRows).filter((p) => rangeContains(previous, p.date));
  return {
    state: { state: "ok" },
    report,
    previousTotals: before.length > 0 ? sumMetrics(before.map((p) => p.metrics)) : null,
    campaigns,
  };
}

// ── Meta ──────────────────────────────────────────────────────────────────────

async function metaPages(
  build: (after: string | null) => Parameters<typeof sendVendorRequest>[0],
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; state: SourceState }> {
  const rows: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (let page = 0; page < META_MAX_PAGES; page++) {
    const answer = await sendVendorRequest(build(after));
    if (answer.status === 0) return { ok: false, state: unreachable("Meta") };
    const parsed = parseMetaPage(answer.status, answer.body);
    if (!parsed.ok)
      return { ok: false, state: failed(parsed.reason, parsed.message, parsed.status) };
    rows.push(...parsed.rows);
    after = parsed.after;
    if (!after) break;
  }
  return { ok: true, rows };
}

async function metaAccount(
  c: LoadedConnection,
): Promise<
  | { ok: true; account: string; name: string | null; currency: string | null; version: string }
  | { ok: false; state: SourceState }
> {
  const account = normaliseAdAccountId(c.settings.ad_account_id);
  if (!account)
    return {
      ok: false,
      state: failed(
        "request_rejected",
        "The Meta ad account id is not an ad account id (act_ and a number).",
        null,
      ),
    };
  const version = metaVersion(c.settings.api_version);
  const answer = await sendVendorRequest(
    metaAccountRequest(account, c.secrets.access_token, version),
  );
  if (answer.status === 0) return { ok: false, state: unreachable("Meta") };
  if (answer.status < 200 || answer.status >= 300) {
    const { reason, message } = metaErrorOf(answer.status, answer.body);
    return { ok: false, state: failed(reason, message, answer.status) };
  }
  const body = (answer.body ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    account,
    name: typeof body.name === "string" ? body.name : null,
    currency: typeof body.currency === "string" ? body.currency : null,
    version,
  };
}

export interface MetaRead extends AdsRead {
  campaigns: MetaCampaignInfo[];
}

/** Meta calls an ad group an ad set. */
const META_LEVEL = { campaign: "campaign", adgroup: "adset", ad: "ad" } as const;

export async function readMetaAds(
  range: DateRange,
  level: AdLevel,
  drill: Drill = {},
): Promise<MetaRead> {
  const empty: MetaRead = {
    state: { state: "ok" },
    report: null,
    previousTotals: null,
    campaigns: [],
  };
  const conn = await connectionFor("meta_ads");
  if (!conn.ok) return { ...empty, state: conn.state };
  const token = conn.c.secrets.access_token;
  const acct = await metaAccount(conn.c);
  if (!acct.ok) return { ...empty, state: acct.state };

  const previous = previousPeriod(range);
  const both = { since: previous.since, until: range.until };
  const metaLevel = META_LEVEL[level];
  const [dailyRead, entityRead, accountRead, campaignRead] = await Promise.all([
    metaPages((after) =>
      metaInsightsRequest(
        {
          adAccountId: acct.account,
          level: "account",
          range: both,
          daily: true,
          after,
          version: acct.version,
        },
        token,
      ),
    ),
    metaPages((after) =>
      metaInsightsRequest(
        {
          adAccountId: acct.account,
          level: metaLevel,
          range,
          daily: false,
          campaignId: drill.campaignId,
          adSetId: drill.adGroupId,
          after,
          version: acct.version,
        },
        token,
      ),
    ),
    metaPages((after) =>
      metaInsightsRequest(
        {
          adAccountId: acct.account,
          level: "account",
          range,
          daily: false,
          after,
          version: acct.version,
        },
        token,
      ),
    ),
    metaPages((after) => metaCampaignsRequest(acct.account, token, acct.version, after)),
  ]);
  if (!dailyRead.ok) return { ...empty, state: dailyRead.state };
  if (!entityRead.ok) return { ...empty, state: entityRead.state };
  // Campaign settings decorate the report; their absence is not a failure of it.
  const campaigns = campaignRead.ok ? parseMetaCampaigns(campaignRead.rows, acct.currency) : [];
  const report = metaReport({
    adAccountId: acct.account,
    accountName: acct.name,
    currency: acct.currency,
    range,
    level: metaLevel,
    entityRows: entityRead.rows,
    dailyRows: dailyRead.rows,
    accountRows: accountRead.ok ? accountRead.rows : [],
    campaigns,
  });
  const before = metaDaily(dailyRead.rows).filter((p) => rangeContains(previous, p.date));
  return {
    state: { state: "ok" },
    report,
    previousTotals: before.length > 0 ? sumMetrics(before.map((p) => p.metrics)) : null,
    campaigns,
  };
}

export async function readMetaAccountDaily(range: DateRange): Promise<{
  state: SourceState;
  account: string | null;
  currency: string | null;
  daily: ChannelReport["daily"];
}> {
  const conn = await connectionFor("meta_ads");
  if (!conn.ok) return { state: conn.state, account: null, currency: null, daily: [] };
  const acct = await metaAccount(conn.c);
  if (!acct.ok) return { state: acct.state, account: null, currency: null, daily: [] };
  const read = await metaPages((after) =>
    metaInsightsRequest(
      {
        adAccountId: acct.account,
        level: "account",
        range,
        daily: true,
        after,
        version: acct.version,
      },
      conn.c.secrets.access_token,
    ),
  );
  if (!read.ok)
    return { state: read.state, account: acct.account, currency: acct.currency, daily: [] };
  return {
    state: { state: "ok" },
    account: acct.account,
    currency: acct.currency,
    daily: metaDaily(read.rows),
  };
}

// ── Probes: is a set of credentials accepted? ────────────────────────────────

function refusal(state: SourceState): ProbeResult {
  if (state.state === "error")
    return { ok: false, error: `${state.message}${state.status ? ` (HTTP ${state.status})` : ""}` };
  if (state.state === "not_configured")
    return { ok: false, error: `Still needed: ${state.missing.join(", ")}` };
  return { ok: false, error: "The vendor did not confirm the credentials." };
}

/**
 * Ask the vendor the cheapest question that proves the credentials work AND
 * reach the named account. A token that is valid for a different account is a
 * refusal: saving it would draw an empty page for a reason nobody could see.
 */
export async function probeConnection(c: LoadedConnection): Promise<ProbeResult> {
  switch (c.source) {
    case "meta_ads": {
      const acct = await metaAccount(c);
      return acct.ok ? { ok: true, accountName: acct.name } : refusal(acct.state);
    }
    case "google_ads": {
      const creds = await googleAdsCredentials(c);
      if (!creds.ok) return refusal(creds.state);
      const read = await googleAdsSearchAll(
        creds.credentials,
        "SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1",
        creds.version,
      );
      if (!read.ok) return refusal(read.state);
      const customer = (read.rows[0]?.customer ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        accountName: typeof customer.descriptiveName === "string" ? customer.descriptiveName : null,
      };
    }
    case "tiktok_ads": {
      const answer = await sendVendorRequest(
        tiktokAdvertiserInfoRequest(c.settings.advertiser_id, c.secrets.access_token),
      );
      if (answer.status === 0) return refusal(unreachable("TikTok"));
      const env = parseTikTokEnvelope(answer.status, answer.body);
      if (!env.ok) return refusal(failed(env.reason, env.message, env.status));
      const advertiser = parseTikTokAdvertiser(env.data);
      if (!advertiser.name && !advertiser.currency) {
        return {
          ok: false,
          error:
            "TikTok answered, but not for this advertiser id — check that the token was authorised by this advertiser.",
        };
      }
      return { ok: true, accountName: advertiser.name };
    }
    case "youtube_data": {
      const answer = await sendVendorRequest(
        youtubeChannelRequest(c.settings.channel_id, c.secrets.api_key),
      );
      if (answer.status === 0) return refusal(unreachable("YouTube"));
      const parsed = parseYouTubeChannel(answer.status, answer.body);
      return parsed.ok
        ? { ok: true, accountName: parsed.channel.title }
        : refusal(failed(parsed.reason, parsed.message, parsed.status));
    }
    case "youtube_analytics": {
      const token = await googleAccessToken(
        {
          clientId: c.settings.client_id,
          clientSecret: c.secrets.client_secret,
          refreshToken: c.secrets.refresh_token,
        },
        "YouTube Analytics",
      );
      if (!token.ok) return refusal(token.state);
      const day = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
      const answer = await sendVendorRequest(
        youtubeAnalyticsRequest(token.token, youtubeDailyQuery({ since: day, until: day })),
      );
      if (answer.status === 0) return refusal(unreachable("YouTube Analytics"));
      const parsed = parseResultTable(answer.status, answer.body);
      return parsed.ok
        ? { ok: true, accountName: null }
        : refusal(failed(parsed.reason, parsed.message, parsed.status));
    }
  }
}
