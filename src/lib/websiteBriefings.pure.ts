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
  /** Absent on a row read before the migration that adds it has applied. */
  media_thumbnail?: string | null;
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
    ["thumbnail", b.media_thumbnail ?? null],
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
    /** The 16:9 thumbnail designed for the video: the library and up-next cards. */
    thumbnail: string | null;
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
          thumbnail: b.media_thumbnail ?? null,
        }
      : null,
    duration_seconds: published ? b.duration_seconds : null,
    published_on: published ? b.published_on : null,
  };
}

/**
 * The library positions for a new order: 10, 20, 30 … in the order given, so
 * a listing can later be slotted between two without renumbering the rest.
 * Only the listings whose position changes are returned.
 */
export function reorderPlan(
  rows: ReadonlyArray<{ id: string; sort_order: number }>,
  order: readonly string[],
): { ok: true; changes: Array<{ id: string; sort_order: number }> } | { ok: false } {
  const ids = new Set(rows.map((r) => r.id));
  if (order.length !== ids.size || new Set(order).size !== order.length) return { ok: false };
  if (!order.every((id) => ids.has(id))) return { ok: false };
  const current = new Map(rows.map((r) => [r.id, r.sort_order]));
  const changes = order
    .map((id, index) => ({ id, sort_order: (index + 1) * 10 }))
    .filter((c) => current.get(c.id) !== c.sort_order);
  return { ok: true, changes };
}

/** The live listings' slugs in library order: what the website's library shows, top to bottom. */
export function liveOrder(
  rows: ReadonlyArray<{ slug: string; status: string; sort_order: number }>,
): string[] {
  return rows
    .filter((r) => (LIVE_STATUSES as readonly string[]).includes(r.status))
    .map((r, index) => ({ r, index }))
    .sort((a, b) => a.r.sort_order - b.r.sort_order || a.index - b.index)
    .map(({ r }) => r.slug);
}

/**
 * The code tag the website's library card wears — BRF-01 for the first
 * listing it shows — read from the order the website is served (aurixa-systems
 * `codeFor` in src/pages/Watch.tsx). Null when the listing is not in the library.
 */
export function libraryCode(servedSlugs: readonly string[], slug: string): string | null {
  const index = servedSlugs.indexOf(slug);
  return index < 0 ? null : `BRF-${String(index + 1).padStart(2, "0")}`;
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
    media_thumbnail: pick("thumbnail.jpg"),
  };
}

// ── Pictures ────────────────────────────────────────────────────────────────

/**
 * A listing's three pictures, which can be uploaded on their own, without the
 * stream: the 16:9 thumbnail designed for the video (the website's library and
 * up-next cards), the poster the theatre shows before play (in the video's own
 * shape), and the link-preview card. The browser writes each as a JPEG at
 * exactly its shape's size, so the website never scales a picture it did not
 * expect; the server reads the size back from the uploaded bytes.
 */
export const PICTURES = ["thumbnail", "poster", "card"] as const;
export type Picture = (typeof PICTURES)[number];

export const PICTURE_FILE: Record<Picture, string> = {
  thumbnail: "thumbnail.jpg",
  poster: "poster.jpg",
  card: "card.jpg",
};

export const PICTURE_FIELD = {
  thumbnail: "media_thumbnail",
  poster: "media_poster",
  card: "media_card",
} as const satisfies Record<Picture, keyof BriefingFacts>;

export const PICTURE_LABEL: Record<Picture, string> = {
  thumbnail: "thumbnail",
  poster: "poster",
  card: "link-preview card",
};

export type PictureShape = {
  width: number;
  height: number;
  ratio: string;
  minWidth: number;
  minHeight: number;
};

/**
 * The size each picture is written at. The card is the 1200×630 the website's
 * pages declare as their og:image; the poster takes the video's shape, because
 * the theatre shows it in the player's frame before the first frame plays.
 */
export function pictureShape(picture: Picture, orientation: string): PictureShape {
  if (picture === "card")
    return { width: 1200, height: 630, ratio: "1.91:1", minWidth: 1200, minHeight: 630 };
  if (picture === "poster" && orientation === "portrait")
    return { width: 1080, height: 1920, ratio: "9:16", minWidth: 720, minHeight: 1280 };
  return { width: 1920, height: 1080, ratio: "16:9", minWidth: 1280, minHeight: 720 };
}

/** How far a picked image's shape may stray from its slot's before it is refused rather than cropped. */
export const PICTURE_ASPECT_TOLERANCE = 0.01;

/**
 * Why an image of this size cannot be this picture, or null when it can. A
 * picture is designed for its shape — its type and logo sit where the website
 * leaves room for them — so an image of another shape is refused, never
 * cropped to fit.
 */
export function pictureSizeProblem(
  picture: Picture,
  orientation: string,
  size: { width: number; height: number },
): string | null {
  const shape = pictureShape(picture, orientation);
  const label = PICTURE_LABEL[picture];
  const want = shape.width / shape.height;
  const got = size.width / size.height;
  if (
    !(size.width > 0 && size.height > 0) ||
    Math.abs(got - want) / want > PICTURE_ASPECT_TOLERANCE
  )
    return `This image is ${size.width}×${size.height}; the ${label} is ${shape.ratio} (${shape.width}×${shape.height}).`;
  if (size.width < shape.minWidth || size.height < shape.minHeight)
    return `This image is ${size.width}×${size.height}; the ${label} must be at least ${shape.minWidth}×${shape.minHeight}.`;
  return null;
}

/**
 * The part of a source image that fills a target shape, centred: the whole
 * width or the whole height, whichever runs out first. How the link-preview
 * card is made from the thumbnail (16:9 to 1.91:1 trims 3.4% off the top and
 * the bottom).
 */
export function coverCrop(
  source: { width: number; height: number },
  target: { width: number; height: number },
): { sx: number; sy: number; sw: number; sh: number } {
  const scale = Math.max(target.width / source.width, target.height / source.height);
  const sw = Math.min(source.width, Math.round(target.width / scale));
  const sh = Math.min(source.height, Math.round(target.height / scale));
  return {
    sx: Math.round((source.width - sw) / 2),
    sy: Math.round((source.height - sh) / 2),
    sw,
    sh,
  };
}

/** The files of a pictures-only upload, checked: one or more of thumbnail.jpg, poster.jpg and card.jpg. */
export function planPicturesUpload(
  paths: readonly string[],
): { ok: true; files: UploadFile[] } | { ok: false; problems: string[] } {
  const unique = [...new Set(paths)];
  const allowed = new Set(Object.values(PICTURE_FILE));
  const problems: string[] = [];
  if (unique.length === 0) problems.push("Pick at least one picture.");
  const bad = unique.filter((p) => !allowed.has(p));
  if (bad.length > 0)
    problems.push(
      `Only thumbnail.jpg, poster.jpg and card.jpg are uploaded on their own, not ${bad.slice(0, 3).join(", ")}.`,
    );
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    files: unique.sort().map((path) => ({
      path,
      contentType: CONTENT_TYPES.jpg,
      cacheControl: IMMUTABLE,
      phase: 0,
    })),
  };
}

/** The media fields a pictures-only upload fills: only the pictures it holds. */
export function pictureFieldsFor(
  prefix: string,
  paths: readonly string[],
): Partial<Record<(typeof PICTURE_FIELD)[Picture], string>> {
  const out: Partial<Record<(typeof PICTURE_FIELD)[Picture], string>> = {};
  for (const picture of PICTURES) {
    if (paths.includes(PICTURE_FILE[picture]))
      out[PICTURE_FIELD[picture]] = `${prefix}${PICTURE_FILE[picture]}`;
  }
  return out;
}

type PictureFacts = Pick<
  BriefingFacts,
  "slug" | "media_version" | "media_poster" | "media_card" | "media_thumbnail"
>;

/**
 * Where a listing's picture came from: `own` when it was uploaded on its own,
 * `video` when it came with the stream now playing (or another of its
 * packages), `none` when there is none.
 */
export function pictureSource(row: PictureFacts, picture: Picture): "own" | "video" | "none" {
  const path = row[PICTURE_FIELD[picture]] ?? null;
  if (!path) return "none";
  const stream = row.media_version ? `videos/${row.slug}/${row.media_version}/` : null;
  return stream && path.startsWith(stream) ? "video" : "own";
}

/**
 * The pictures once a new stream lands. A picture that came with the old
 * stream gives way to the new package's. One uploaded on its own was chosen
 * for the listing rather than taken from a render, so it stays — except a
 * poster when the video changed shape, which would no longer fit the frame.
 */
export function picturesAfterPackage(
  before: PictureFacts & { orientation: string },
  incoming: ReturnType<typeof mediaFieldsFor>,
  orientation: string,
): {
  fields: {
    media_poster: string | null;
    media_card: string | null;
    media_thumbnail: string | null;
  };
  kept: Picture[];
} {
  const kept: Picture[] = [];
  const fields = {
    media_poster: incoming.media_poster,
    media_card: incoming.media_card,
    media_thumbnail: incoming.media_thumbnail,
  };
  for (const picture of PICTURES) {
    if (pictureSource(before, picture) !== "own") continue;
    if (picture === "poster" && orientation !== before.orientation) continue;
    fields[PICTURE_FIELD[picture]] = before[PICTURE_FIELD[picture]] ?? null;
    kept.push(picture);
  }
  return { fields, kept };
}

/**
 * The pixel size a JPEG declares in its frame header, or null when these
 * bytes hold none. A browser's encoder writes the frame header within the
 * first few hundred bytes, so the first 64 KB of the file is plenty.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (frame) {
      if (i + 8 >= bytes.length) return null;
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
      };
    }
    i += 2 + length;
  }
  return null;
}

/** A listing holds media once any of it has been uploaded: its slug then names a folder in the bucket. */
export function hasMedia(row: Partial<BriefingFacts>): boolean {
  return Boolean(
    row.media_version ||
    row.media_hls ||
    row.media_mp4 ||
    row.media_poster ||
    row.media_card ||
    row.media_captions ||
    row.media_thumbnail,
  );
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
