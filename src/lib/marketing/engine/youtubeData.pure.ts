/**
 * The YouTube Data API v3, read with an API key: a channel's public counters
 * and its uploads.
 *
 * WHAT AN API KEY CAN AND CANNOT SAY
 * ----------------------------------
 * The Data API answers LIFETIME counters — subscribers, total views, a
 * video's views since it was published. It has no notion of "views in
 * September". So the engine is explicit about which question each figure
 * answers:
 *
 * - the channel's subscribers and views are a reading taken NOW, and growth
 *   over a range is the difference between two readings the deployment
 *   recorded itself (`channelGrowth`) — never estimated;
 * - an upload's views are its lifetime views, labelled as such;
 * - views, watch time and subscribers gained IN a range come only from the
 *   YouTube Analytics API (`youtubeAnalytics.pure.ts`), which needs the
 *   channel owner's OAuth consent.
 *
 * A channel can hide its subscriber count. The API then answers
 * `hiddenSubscriberCount: true` and a `subscriberCount` of "0" — which is not
 * a channel with no subscribers, so it is read as `null`.
 *
 * The key is sent as `X-Goog-Api-Key`, never in the URL.
 */
import type { DateRange, EntityRow, Measured, SourceErrorReason } from './marketingTypes.pure.ts';
import { emptyMetrics, readNumber } from './marketingMetrics.pure.ts';
import { rangeContains, ymdOfInstant } from './marketingRange.pure.ts';
import { googleErrorOf } from './googleApi.pure.ts';
import { queryString, type VendorRequest } from './vendorRequest.pure.ts';

export const YOUTUBE_DATA_API_BASE = 'https://youtube.googleapis.com/youtube/v3';

/** A channel id: `UC` and 22 URL-safe base64 characters. */
export const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

/** At most this many pages of 50 uploads are read for one range — 200 uploads, 4 quota units. */
export const MAX_UPLOAD_PAGES = 4;

/** The newest uploads shown whatever the range, so a quiet month still shows the catalogue. */
export const RECENT_UPLOAD_COUNT = 12;

/** YouTube has accepted Shorts up to three minutes since October 2024. Judged by duration alone. */
export const SHORT_FORM_MAX_SECONDS = 180;

export function isYouTubeChannelId(value: unknown): value is string {
  return typeof value === 'string' && YOUTUBE_CHANNEL_ID_PATTERN.test(value.trim());
}

/** A channel's uploads playlist is its id with `UC` replaced by `UU`. Used when the API omits it. */
export function uploadsPlaylistOf(channelId: string): string | null {
  return isYouTubeChannelId(channelId) ? `UU${channelId.trim().slice(2)}` : null;
}

function keyed(apiKey: string): Record<string, string> {
  return { 'X-Goog-Api-Key': apiKey, Accept: 'application/json' };
}

export function youtubeChannelRequest(channelId: string, apiKey: string): VendorRequest {
  return {
    method: 'GET',
    url: `${YOUTUBE_DATA_API_BASE}/channels${queryString({ part: 'snippet,statistics,contentDetails', id: channelId.trim() })}`,
    headers: keyed(apiKey),
  };
}

export function youtubeUploadsRequest(playlistId: string, apiKey: string, pageToken?: string | null): VendorRequest {
  return {
    method: 'GET',
    url: `${YOUTUBE_DATA_API_BASE}/playlistItems${queryString({
      part: 'contentDetails',
      playlistId,
      maxResults: 50,
      pageToken: pageToken || undefined,
    })}`,
    headers: keyed(apiKey),
  };
}

/** One request covers at most fifty videos; the caller batches. */
export function youtubeVideosRequest(videoIds: readonly string[], apiKey: string): VendorRequest {
  const ids = videoIds.slice(0, 50);
  return {
    method: 'GET',
    url: `${YOUTUBE_DATA_API_BASE}/videos${queryString({ part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50 })}`,
    headers: keyed(apiKey),
  };
}

export interface YouTubeChannelInfo {
  id: string;
  title: string;
  customUrl: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  country: string | null;
  /** Null where the channel hides its count. */
  subscribers: Measured;
  subscribersHidden: boolean;
  totalViews: Measured;
  videoCount: Measured;
  uploadsPlaylistId: string | null;
  url: string;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  /** Lifetime, as of the read. */
  views: Measured;
  /** Null where the owner hides likes. */
  likes: Measured;
  /** Null where comments are off. */
  comments: Measured;
  thumbnailUrl: string | null;
  /** `none`, `live` or `upcoming`, verbatim. */
  liveBroadcastContent: string | null;
  /** True for three minutes or less; null where the duration is unknown. */
  isShortForm: boolean | null;
  url: string;
}

export type YouTubeFailure = { ok: false; reason: SourceErrorReason; message: string; status: number };

function failure(status: number, body: unknown): YouTubeFailure {
  const { reason, message } = googleErrorOf(status, body);
  return { ok: false, reason, message, status };
}

function bestThumbnail(thumbnails: unknown): string | null {
  const t = (thumbnails ?? {}) as Record<string, { url?: unknown } | undefined>;
  for (const size of ['high', 'medium', 'standard', 'default', 'maxres']) {
    const url = t[size]?.url;
    if (typeof url === 'string' && url.startsWith('https://')) return url;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function parseYouTubeChannel(
  status: number,
  body: unknown,
): { ok: true; channel: YouTubeChannelInfo } | YouTubeFailure {
  if (status < 200 || status >= 300) return failure(status, body);
  const items = (body as { items?: unknown } | null)?.items;
  const item = Array.isArray(items) ? (items[0] as Record<string, unknown> | undefined) : undefined;
  if (!item || typeof item.id !== 'string') {
    return {
      ok: false,
      reason: 'not_found',
      message: 'YouTube found no channel with that id. Check the Channel ID on the Integrations page (it starts with "UC").',
      status,
    };
  }
  const snippet = (item.snippet ?? {}) as Record<string, unknown>;
  const stats = (item.statistics ?? {}) as Record<string, unknown>;
  const content = (item.contentDetails ?? {}) as { relatedPlaylists?: Record<string, unknown> };
  const hidden = stats.hiddenSubscriberCount === true;
  const customUrl = text(snippet.customUrl);
  return {
    ok: true,
    channel: {
      id: item.id,
      title: text(snippet.title) ?? item.id,
      customUrl,
      thumbnailUrl: bestThumbnail(snippet.thumbnails),
      publishedAt: text(snippet.publishedAt),
      country: text(snippet.country),
      subscribers: hidden ? null : readNumber(stats.subscriberCount),
      subscribersHidden: hidden,
      totalViews: readNumber(stats.viewCount),
      videoCount: readNumber(stats.videoCount),
      uploadsPlaylistId: text(content.relatedPlaylists?.uploads) ?? uploadsPlaylistOf(item.id),
      url: customUrl
        ? `https://www.youtube.com/${customUrl.startsWith('@') ? customUrl : `@${customUrl}`}`
        : `https://www.youtube.com/channel/${item.id}`,
    },
  };
}

export interface UploadItem {
  videoId: string;
  publishedAt: string | null;
}

export function parseUploadsPage(
  status: number,
  body: unknown,
): { ok: true; items: UploadItem[]; nextPageToken: string | null } | YouTubeFailure {
  if (status < 200 || status >= 300) {
    // An uploads playlist that does not exist is a channel with no uploads, not a fault.
    if (status === 404) return { ok: true, items: [], nextPageToken: null };
    return failure(status, body);
  }
  const b = (body ?? {}) as { items?: unknown; nextPageToken?: unknown };
  const items: UploadItem[] = [];
  for (const raw of Array.isArray(b.items) ? b.items : []) {
    const cd = ((raw as Record<string, unknown>)?.contentDetails ?? {}) as Record<string, unknown>;
    if (typeof cd.videoId !== 'string' || cd.videoId === '') continue;
    items.push({ videoId: cd.videoId, publishedAt: text(cd.videoPublishedAt) });
  }
  return { ok: true, items, nextPageToken: text(b.nextPageToken) };
}

/**
 * Whether another page of uploads could still hold a video published inside
 * the range. The uploads playlist is newest first; once a page reaches back
 * past the range's first day there is nothing older worth a quota unit.
 */
export function shouldReadNextUploadsPage(items: readonly UploadItem[], range: DateRange, timeZone: string): boolean {
  if (items.length === 0) return false;
  const days = items.map((i) => ymdOfInstant(i.publishedAt, timeZone)).filter((d): d is string => d !== null);
  if (days.length === 0) return true;
  const oldest = days.reduce((a, b) => (a < b ? a : b));
  return oldest >= range.since;
}

/** ISO 8601 durations as YouTube writes them: `PT1H2M3S`, `P1DT2H`, `PT45S`. */
export function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!m || value.trim() === 'P' || value.trim() === 'PT') return null;
  const [, w, d, h, mi, s] = m;
  const total = Number(w ?? 0) * 604_800 + Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(mi ?? 0) * 60 + Number(s ?? 0);
  return Number.isFinite(total) ? total : null;
}

export function parseYouTubeVideos(
  status: number,
  body: unknown,
): { ok: true; videos: YouTubeVideo[] } | YouTubeFailure {
  if (status < 200 || status >= 300) return failure(status, body);
  const videos: YouTubeVideo[] = [];
  for (const raw of Array.isArray((body as { items?: unknown } | null)?.items) ? (body as { items: unknown[] }).items : []) {
    const item = (raw ?? {}) as Record<string, unknown>;
    if (typeof item.id !== 'string') continue;
    const snippet = (item.snippet ?? {}) as Record<string, unknown>;
    const stats = (item.statistics ?? {}) as Record<string, unknown>;
    const content = (item.contentDetails ?? {}) as Record<string, unknown>;
    const durationSeconds = parseIsoDuration(content.duration);
    videos.push({
      id: item.id,
      title: text(snippet.title) ?? item.id,
      publishedAt: text(snippet.publishedAt),
      durationSeconds,
      views: readNumber(stats.viewCount),
      likes: readNumber(stats.likeCount),
      comments: readNumber(stats.commentCount),
      thumbnailUrl: bestThumbnail(snippet.thumbnails),
      liveBroadcastContent: text(snippet.liveBroadcastContent),
      // A zero-length duration is how YouTube describes a live stream that has not ended.
      isShortForm: durationSeconds === null || durationSeconds === 0 ? null : durationSeconds <= SHORT_FORM_MAX_SECONDS,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(item.id)}`,
    });
  }
  return { ok: true, videos };
}

/** An upload as a report entity. Its metrics are LIFETIME figures, which the report's notes say. */
export function youtubeVideoEntity(video: YouTubeVideo): EntityRow {
  const metrics = emptyMetrics();
  metrics.views = video.views;
  metrics.likes = video.likes;
  metrics.comments = video.comments;
  return {
    id: video.id,
    name: video.title,
    level: 'video',
    parentId: null,
    parentName: null,
    status: video.liveBroadcastContent && video.liveBroadcastContent !== 'none' ? video.liveBroadcastContent : null,
    objective: video.isShortForm === null ? null : video.isShortForm ? 'short_form' : 'long_form',
    metrics,
    publishedAt: video.publishedAt,
    durationSeconds: video.durationSeconds,
    thumbnailUrl: video.thumbnailUrl,
    url: video.url,
  };
}

/** The uploads among `videos` published inside the range, newest first. */
export function uploadsInRange(videos: readonly YouTubeVideo[], range: DateRange, timeZone: string): YouTubeVideo[] {
  return videos
    .filter((v) => {
      const day = ymdOfInstant(v.publishedAt, timeZone);
      return day !== null && rangeContains(range, day);
    })
    .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
}

/** Uploads per week over the range, or null for a range shorter than a day. */
export function uploadsPerWeek(uploadCount: number, rangeDays: number): Measured {
  if (!(rangeDays > 0)) return null;
  return (uploadCount / rangeDays) * 7;
}

/** One reading of the channel's lifetime counters, as the snapshot table stores it. */
export interface ChannelCounterReading {
  /** YYYY-MM-DD, the day the reading was taken in the report's zone. */
  date: string;
  subscribers: Measured;
  totalViews: Measured;
  videoCount: Measured;
}

export interface ChannelGrowth {
  /** The first and last readings inside the window. Null when fewer than two exist. */
  from: ChannelCounterReading | null;
  to: ChannelCounterReading | null;
  netSubscribers: Measured;
  netViews: Measured;
  netUploads: Measured;
  /** How many days the readings span — growth over 3 days is not growth over 30. */
  spanDays: number | null;
  readings: number;
}

/**
 * Growth across a window, from the deployment's own readings.
 *
 * The first reading may be taken on the day before the range starts (the
 * opening balance) and the last on the range's final day. Growth is stated
 * only where two readings exist, and `spanDays` says how much of the range
 * they actually cover — a deployment that began recording on the 25th has
 * five days of growth to show for "Last 30 Days", and says so.
 */
export function channelGrowth(readings: readonly ChannelCounterReading[], range: DateRange, openingDay: string): ChannelGrowth {
  const inWindow = readings
    .filter((r) => r.date >= openingDay && r.date <= range.until)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (inWindow.length < 2) {
    return { from: inWindow[0] ?? null, to: null, netSubscribers: null, netViews: null, netUploads: null, spanDays: null, readings: inWindow.length };
  }
  const from = inWindow[0];
  const to = inWindow[inWindow.length - 1];
  const diff = (a: Measured, b: Measured): Measured => (a === null || b === null ? null : b - a);
  const span = Math.round((Date.parse(`${to.date}T00:00:00Z`) - Date.parse(`${from.date}T00:00:00Z`)) / 86_400_000);
  return {
    from,
    to,
    netSubscribers: diff(from.subscribers, to.subscribers),
    netViews: diff(from.totalViews, to.totalViews),
    netUploads: diff(from.videoCount, to.videoCount),
    spanDays: span,
    readings: inWindow.length,
  };
}
