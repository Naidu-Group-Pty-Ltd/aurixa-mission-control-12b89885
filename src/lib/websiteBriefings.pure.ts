/**
 * Website videos: the Briefing Room listings on the Aurixa Systems website
 * (/watch), written and published from Mission Control (docs/WEBSITE_VIDEOS.md).
 *
 * The rules a listing must pass to go live are the WEBSITE'S rules — its build
 * drops any listing that breaks one (`src/lib/videos/validate.ts` in
 * aurixa-systems). They are restated here so the console refuses a publish the
 * website would quietly leave out, rather than reporting success for a video
 * nobody can see. `websiteBriefings.pure.test.ts` pins them case by case.
 *
 * Everything here is pure: the server act and the editor both call it, so the
 * problems an operator reads before pressing Publish are the problems the
 * server refuses on.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const BRIEFING_STATUSES = ["draft", "premiere", "published", "archived"] as const;
export type BriefingStatus = (typeof BRIEFING_STATUSES)[number];

/** On the website: a premiere is a card with no page; published is a watchable page. */
export const LIVE_STATUSES: readonly BriefingStatus[] = ["premiere", "published"];

export const BRIEFING_SERIES = [
  { value: "flagship", label: "Flagship" },
  { value: "platform", label: "Platform" },
  { value: "growth", label: "Growth" },
  { value: "compliance", label: "Compliance" },
] as const;
export type BriefingSeries = (typeof BRIEFING_SERIES)[number]["value"];

/**
 * The website pages a listing may send a viewer on to. The website refuses any
 * other target (its route registry decides what is a public page), so the
 * console offers exactly these. Kept in step with aurixa-systems'
 * `ROUTE_METADATA`; a page added there is added here.
 */
export const WEBSITE_EXPLORE_TARGETS = [
  { to: "/platform", label: "Explore the platform" },
  { to: "/platform#serviceability", label: "See the serviceability engine" },
  { to: "/platform#custom-reporting", label: "See custom reporting" },
  { to: "/platform#voice", label: "Meet Aurixa Voice" },
  { to: "/solutions", label: "See the solutions" },
  { to: "/industries", label: "See who it is for" },
  { to: "/compliance", label: "See compliance and security" },
  { to: "/compliance-passport", label: "Open the Compliance Passport" },
  { to: "/builders", label: "Visit the Builders Network" },
  { to: "/resources", label: "Browse the module library" },
  { to: "/docs", label: "Read the documentation" },
  { to: "/about", label: "Meet the team" },
] as const;

/** The artwork a premiere card shows before a poster exists: the website's own brand images. */
export const WEBSITE_ARTWORK = [
  { path: "/brand/layer-01-operational-intelligence.webp", label: "Operational intelligence" },
  { path: "/brand/layer-02-strategic-intelligence.webp", label: "Strategic intelligence" },
  { path: "/brand/layer-03-financial-modelling.webp", label: "Financial modelling" },
  { path: "/brand/layer-04-client-growth-ecosystem.webp", label: "Client growth ecosystem" },
  { path: "/brand/layer-05-enterprise-governance.webp", label: "Enterprise governance" },
] as const;

export const WEBSITE_ORIGIN = "https://www.aurixasystems.com.au";
export const briefingPageUrl = (slug: string) => `${WEBSITE_ORIGIN}/watch/${slug}`;

// ── The listing ─────────────────────────────────────────────────────────────

export type BriefingChapter = { at: number; label: string };

/** The columns of `website_briefings` the rules read. */
export type BriefingFacts = {
  slug: string;
  status: string;
  title: string;
  kicker: string;
  summary: string;
  series: string;
  artwork: string;
  artwork_position: string | null;
  takeaways: string[];
  explore_label: string;
  explore_to: string;
  orientation: string;
  disclaimer: string | null;
  transcript: string[];
  chapters: unknown;
  media_version: string | null;
  media_hls: string | null;
  media_mp4: string | null;
  media_poster: string | null;
  media_card: string | null;
  media_captions: string | null;
  duration_seconds: number | null;
  published_on: string | null;
};

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A title as a URL segment: "Borrowing Capacity, in Moments" → "borrowing-capacity-in-moments". */
export function slugify(title: string): string {
  return (
    title
      // Marks first: NFKD would spell ™ out as "TM".
      .replace(/[\u2122\u00ae\u00a9]/g, "")
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "")
  );
}

/** Chapters as stored (jsonb), read defensively: anything that is not a chapter is dropped. */
export function chaptersOf(value: unknown): BriefingChapter[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (c): c is BriefingChapter =>
        typeof c === "object" &&
        c !== null &&
        typeof (c as BriefingChapter).at === "number" &&
        typeof (c as BriefingChapter).label === "string",
    )
    .map((c) => ({ at: c.at, label: c.label }));
}

/** "1:05" → 65; "0:00" → 0; "75" → 75. Null for anything else. */
export function parseChapterTime(input: string): number | null {
  const text = input.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const m = /^(\d+):([0-5]\d)$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 65 → "1:05". */
export function formatChapterTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Transcript paragraphs from an editor's text: blank lines separate them. */
export function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function copyProblems(b: BriefingFacts): string[] {
  const problems: string[] = [];
  if (!SLUG_PATTERN.test(b.slug) || b.slug.length > 60)
    problems.push("The slug must be lowercase words joined by hyphens, at most 60 characters.");
  if (!b.title.trim() || b.title.trim().length > 120)
    problems.push("Give it a title of up to 120 characters.");
  const kicker = b.kicker.trim();
  if (!kicker || kicker.length > 120)
    problems.push("The kicker is one line of up to 120 characters.");
  const summary = b.summary.trim();
  if (summary.length < 70 || summary.length > 320) {
    problems.push(
      `The summary is ${summary.length} characters; it must be 70 to 320 (it is the page's search and link-preview description).`,
    );
  }
  if (!BRIEFING_SERIES.some((s) => s.value === b.series)) problems.push("Pick a series.");
  if (!WEBSITE_ARTWORK.some((a) => a.path === b.artwork))
    problems.push("Pick the card artwork from the website's brand images.");
  const takeaways = b.takeaways.map((t) => t.trim()).filter(Boolean);
  if (takeaways.length !== b.takeaways.length) problems.push("Remove the blank takeaway.");
  if (takeaways.length < 2 || takeaways.length > 4)
    problems.push(`Write 2 to 4 takeaways (there are ${takeaways.length}).`);
  if (!WEBSITE_EXPLORE_TARGETS.some((t) => t.to === b.explore_to))
    problems.push("Pick the website page the video sends viewers on to.");
  if (!b.explore_label.trim()) problems.push("Give the explore link a label.");
  if (!["landscape", "portrait"].includes(b.orientation))
    problems.push("Orientation must be landscape or portrait.");
  if (b.disclaimer !== null) {
    const text = b.disclaimer.trim();
    if (!text || text.length > 240)
      problems.push("A disclaimer is one sentence of up to 240 characters.");
    else if (!/[.!?]$/.test(text)) problems.push("End the disclaimer as a complete sentence.");
  }
  if (b.transcript.some((p) => !p.trim())) problems.push("Remove the blank transcript paragraph.");
  return problems;
}

/** Why this listing cannot be shown as a premiere. Empty when it can. */
export function premiereProblems(b: BriefingFacts): string[] {
  return copyProblems(b);
}

/** Why this listing cannot be published. Empty when it can. */
export function publishProblems(b: BriefingFacts): string[] {
  const problems = copyProblems(b);
  if (!b.media_hls && !b.media_mp4) problems.push("Upload the video first.");
  if (!b.media_poster) problems.push("The upload has no poster (poster.jpg).");
  if (!b.duration_seconds || !Number.isInteger(b.duration_seconds) || b.duration_seconds <= 0) {
    problems.push("The running time is unknown — upload the video again.");
  }
  const chapters = chaptersOf(b.chapters);
  if (chapters.length > 0) {
    if (chapters[0].at !== 0) problems.push("The first chapter must start at 0:00.");
    chapters.forEach((c, i) => {
      if (!c.label.trim()) problems.push(`Chapter ${i + 1} needs a label.`);
      if (!Number.isInteger(c.at) || c.at < 0)
        problems.push(`Chapter ${i + 1} must start on a whole second.`);
      if (i > 0 && c.at <= chapters[i - 1].at) problems.push("Chapters must run forward.");
      if (b.duration_seconds && c.at >= b.duration_seconds)
        problems.push(`Chapter "${c.label}" starts after the video ends.`);
    });
  }
  for (const [field, value] of [
    ["hls", b.media_hls],
    ["mp4", b.media_mp4],
    ["poster", b.media_poster],
    ["card", b.media_card],
    ["captions", b.media_captions],
  ] as const) {
    if (value && !value.startsWith(`videos/${b.slug}/v`))
      problems.push(`The ${field} file is outside this video's own folder.`);
  }
  return problems;
}

/** Today in Sydney, as the YYYY-MM-DD a first publish is stamped with. */
export function sydneyDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// ── What the website reads ──────────────────────────────────────────────────

/** One listing on the wire: what `GET /api/public/storefront/briefings` serves. */
export type PublicListing = {
  slug: string;
  status: "published" | "premiere";
  title: string;
  kicker: string;
  summary: string;
  series: string;
  artwork: string;
  artwork_position: string | null;
  takeaways: string[];
  explore_label: string;
  explore_to: string;
  orientation: string;
  disclaimer: string | null;
  transcript: string[];
  chapters: BriefingChapter[];
  media: {
    hls: string | null;
    mp4: string | null;
    poster: string | null;
    card: string | null;
    captions: string | null;
  } | null;
  duration_seconds: number | null;
  published_on: string | null;
};

/**
 * A row as the website reads it. A premiere carries no media at all, even if
 * some has been uploaded ahead of launch: the website would otherwise see a
 * half-published listing and drop it.
 */
export function toPublicListing(b: BriefingFacts): PublicListing | null {
  if (b.status !== "published" && b.status !== "premiere") return null;
  const published = b.status === "published";
  return {
    slug: b.slug,
    status: b.status,
    title: b.title.trim(),
    kicker: b.kicker.trim(),
    summary: b.summary.trim(),
    series: b.series,
    artwork: b.artwork,
    artwork_position: b.artwork_position,
    takeaways: b.takeaways.map((t) => t.trim()),
    explore_label: b.explore_label.trim(),
    explore_to: b.explore_to,
    orientation: b.orientation,
    disclaimer: b.disclaimer?.trim() || null,
    transcript: b.transcript,
    chapters: published ? chaptersOf(b.chapters) : [],
    media: published
      ? {
          hls: b.media_hls,
          mp4: b.media_mp4,
          poster: b.media_poster,
          card: b.media_card,
          captions: b.media_captions,
        }
      : null,
    duration_seconds: published ? b.duration_seconds : null,
    published_on: published ? b.published_on : null,
  };
}

/** Does a change to this listing change what the website shows? */
export function affectsWebsite(
  before: { status: string } | null,
  after: { status: string } | null,
): boolean {
  const live = (s: { status: string } | null) =>
    Boolean(s && (LIVE_STATUSES as readonly string[]).includes(s.status));
  return live(before) || live(after);
}

// ── Uploads ─────────────────────────────────────────────────────────────────

/**
 * What `npm run video:encode` writes, relative to the version folder: files at
 * the root or one rendition folder deep. The website's signing function holds
 * the same rule; a path either side refuses is never uploaded.
 */
export const UPLOAD_PATH =
  /^(?:[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9.-]*\.(?:m3u8|m4s|mp4|jpg|jpeg|webp|vtt)$/;
export const MAX_UPLOAD_FILES = 2000;
/** A grant lives long enough for a slow connection to send a 2-minute 1080p ladder. */
export const UPLOAD_GRANT_HOURS = 3;

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATED = "public, max-age=300, stale-while-revalidate=86400";
const CONTENT_TYPES: Record<string, string> = {
  m3u8: "application/vnd.apple.mpegurl",
  m4s: "video/iso.segment",
  mp4: "video/mp4",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  vtt: "text/vtt",
};

export type UploadFile = {
  path: string;
  contentType: string;
  cacheControl: string;
  phase: 0 | 1 | 2;
};

/**
 * The files of an encoded package, checked and put in upload order.
 *
 * Order matters: media and images first, rendition playlists next, the master
 * playlist last, so the stream is never addressable before everything it
 * points at has landed. A package must hold a master playlist or a progressive
 * MP4, and a poster; anything else wrong is named, file by file.
 */
export function planUpload(
  paths: readonly string[],
): { ok: true; files: UploadFile[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const unique = [...new Set(paths)];
  if (unique.length === 0) problems.push("The folder is empty.");
  if (unique.length > MAX_UPLOAD_FILES)
    problems.push(`A package holds at most ${MAX_UPLOAD_FILES} files.`);
  const bad = unique.filter((p) => !UPLOAD_PATH.test(p));
  if (bad.length > 0) {
    problems.push(
      `These are not files the encoder writes: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` and ${bad.length - 5} more` : ""}.`,
    );
  }
  if (
    !unique.includes("master.m3u8") &&
    !unique.some((p) => !p.includes("/") && p.endsWith(".mp4"))
  ) {
    problems.push(
      "There is no master.m3u8 (or progressive MP4) at the top of the folder — pick the folder `npm run video:encode` wrote.",
    );
  }
  if (!unique.includes("poster.jpg"))
    problems.push("There is no poster.jpg at the top of the folder.");
  if (problems.length > 0) return { ok: false, problems };

  const files = unique.map((path): UploadFile => {
    const ext = path.split(".").pop()!.toLowerCase();
    const phase = path === "master.m3u8" ? 2 : ext === "m3u8" ? 1 : 0;
    return {
      path,
      contentType: CONTENT_TYPES[ext],
      cacheControl: ext === "m3u8" || ext === "vtt" ? REVALIDATED : IMMUTABLE,
      phase,
    };
  });
  files.sort((a, b) => a.phase - b.phase || a.path.localeCompare(b.path));
  return { ok: true, files };
}

/** The next version folder: one past every version this listing has ever used or been granted. */
export function nextVersion(used: readonly (string | null | undefined)[]): string {
  const numbers = used
    .map((v) => /^v(\d+)$/.exec(v ?? "")?.[1])
    .filter((n): n is string => Boolean(n))
    .map(Number);
  return `v${(numbers.length ? Math.max(...numbers) : 0) + 1}`;
}

/** The media fields an uploaded package fills, as paths relative to the bucket. */
export function mediaFieldsFor(prefix: string, paths: readonly string[]) {
  const root = paths.filter((p) => !p.includes("/"));
  const pick = (...candidates: Array<string | undefined>) => {
    const found = candidates.find((c) => c && root.includes(c));
    return found ? `${prefix}${found}` : null;
  };
  return {
    media_hls: pick("master.m3u8"),
    media_mp4: pick(
      "fallback-720p.mp4",
      root.find((p) => p.endsWith(".mp4")),
    ),
    media_poster: pick("poster.jpg"),
    media_card: pick(
      "card.jpg",
      root.find((p) => /^card[a-z0-9-]*\.jpe?g$/.test(p)),
    ),
    media_captions: pick(
      "captions.en.vtt",
      root.find((p) => p.endsWith(".vtt")),
    ),
  };
}

// ── Reading the stream back ─────────────────────────────────────────────────

export type MasterPlaylist = {
  variants: Array<{
    uri: string;
    width: number | null;
    height: number | null;
    bandwidth: number | null;
  }>;
  /** Alternate renditions (audio groups, subtitles) with a URI of their own. */
  media: string[];
};

function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g))
    out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

export function parseMasterPlaylist(text: string): MasterPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: MasterPlaylist["variants"] = [];
  const media: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = attributes(line.slice("#EXT-X-STREAM-INF:".length));
      const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
      if (!uri) continue;
      const [w, h] = (attrs.RESOLUTION ?? "").split("x").map(Number);
      variants.push({
        uri,
        width: Number.isFinite(w) ? w : null,
        height: Number.isFinite(h) ? h : null,
        bandwidth: attrs.BANDWIDTH ? Number(attrs.BANDWIDTH) : null,
      });
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const uri = attributes(line.slice("#EXT-X-MEDIA:".length)).URI;
      if (uri) media.push(uri);
    }
  }
  return { variants, media };
}

/** The running time of a media playlist: the sum of its segments, in seconds. */
export function playlistDuration(text: string): number {
  let total = 0;
  for (const m of text.matchAll(/^#EXTINF:([\d.]+)/gm)) total += Number(m[1]);
  return total;
}

/** Portrait when the tallest rendition is taller than it is wide. */
export function orientationOf(master: MasterPlaylist): "landscape" | "portrait" {
  const sized = master.variants.filter((v) => v.width && v.height);
  if (sized.length === 0) return "landscape";
  const largest = sized.reduce((a, b) => (b.width! * b.height! > a.width! * a.height! ? b : a));
  return largest.height! > largest.width! ? "portrait" : "landscape";
}

/**
 * A playlist URI resolved against the folder holding it. Only relative paths
 * inside the version folder are accepted: the encoder writes nothing else, and
 * anything else would be a stream reaching outside its own upload.
 */
export function resolveWithin(prefix: string, uri: string): string | null {
  if (
    /^[a-z]+:/i.test(uri) ||
    uri.startsWith("/") ||
    uri.includes("\\") ||
    uri.split("/").includes("..")
  ) {
    return null;
  }
  return `${prefix}${uri}`;
}
