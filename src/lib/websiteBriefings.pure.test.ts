import { describe, expect, it } from "vitest";
import {
  affectsWebsite,
  chaptersOf,
  coverCrop,
  formatChapterTime,
  hasMedia,
  jpegSize,
  libraryCode,
  liveOrder,
  mediaFieldsFor,
  nextVersion,
  orientationOf,
  paragraphsOf,
  parseChapterTime,
  parseMasterPlaylist,
  pictureFieldsFor,
  pictureShape,
  pictureSizeProblem,
  pictureSource,
  picturesAfterPackage,
  planPicturesUpload,
  planUpload,
  playlistDuration,
  premiereProblems,
  publishProblems,
  reorderPlan,
  resolveWithin,
  slugify,
  sydneyDate,
  toPublicListing,
  type BriefingFacts,
} from "./websiteBriefings.pure";

const listing = (over: Partial<BriefingFacts> = {}): BriefingFacts => ({
  slug: "borrowing-capacity",
  status: "draft",
  title: "Borrowing Capacity, in Moments",
  kicker: "From one client questionnaire to an indicative assessment, scenarios and a report.",
  summary:
    "Your client has found the property; can they afford it? From one client questionnaire, Aurixa produces an indicative borrowing capacity assessment and a report.",
  series: "platform",
  artwork: "/brand/layer-03-financial-modelling.webp",
  artwork_position: "30% 25%",
  takeaways: ["One questionnaire.", "An indicative assessment."],
  explore_label: "See the serviceability engine",
  explore_to: "/platform#serviceability",
  orientation: "portrait",
  disclaimer: "Illustrative example only.",
  transcript: ["Your client has found the property."],
  chapters: [
    { at: 0, label: "Can they afford it?" },
    { at: 6, label: "Chasing documents" },
  ],
  media_version: "v1",
  media_hls: "videos/borrowing-capacity/v1/master.m3u8",
  media_mp4: "videos/borrowing-capacity/v1/fallback-720p.mp4",
  media_poster: "videos/borrowing-capacity/v1/poster.jpg",
  media_card: "videos/borrowing-capacity/v1/card-2.jpg",
  media_captions: null,
  duration_seconds: 147,
  published_on: "2026-10-28",
  ...over,
});

describe("the website's publishing rules, restated", () => {
  it("a complete listing publishes", () => {
    expect(publishProblems(listing())).toEqual([]);
  });

  it("refuses the summary the website would drop", () => {
    expect(publishProblems(listing({ summary: "Too short." })).join()).toMatch(/70 to 320/);
    expect(publishProblems(listing({ summary: "x".repeat(321) })).join()).toMatch(/70 to 320/);
  });

  it("holds the takeaways to 2–4, none blank", () => {
    expect(publishProblems(listing({ takeaways: ["One."] })).join()).toMatch(/2 to 4/);
    expect(publishProblems(listing({ takeaways: ["One.", " "] })).join()).toMatch(/blank takeaway/);
  });

  it("sends viewers only to a page the website has", () => {
    expect(publishProblems(listing({ explore_to: "/pricing" })).join()).toMatch(/website page/);
  });

  it("will not publish with nothing to play, no poster, or no running time", () => {
    const problems = publishProblems(
      listing({ media_hls: null, media_mp4: null, media_poster: null, duration_seconds: null }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "Upload the video first.",
        "The upload has no poster (poster.jpg).",
        "The running time is unknown — upload the video again.",
      ]),
    );
  });

  it("checks chapters against the running time", () => {
    expect(publishProblems(listing({ chapters: [{ at: 5, label: "Late start" }] })).join()).toMatch(
      /0:00/,
    );
    expect(
      publishProblems(
        listing({
          chapters: [
            { at: 0, label: "A" },
            { at: 0, label: "B" },
          ],
        }),
      ).join(),
    ).toMatch(/run forward/);
    expect(
      publishProblems(
        listing({
          chapters: [
            { at: 0, label: "A" },
            { at: 200, label: "Z" },
          ],
        }),
      ).join(),
    ).toMatch(/after the video ends/);
  });

  it("keeps media inside the listing's own folder", () => {
    expect(publishProblems(listing({ media_poster: "videos/other/v1/poster.jpg" })).join()).toMatch(
      /own folder/,
    );
  });

  it("a disclaimer is a complete sentence", () => {
    expect(publishProblems(listing({ disclaimer: "No full stop" })).join()).toMatch(
      /complete sentence/,
    );
  });

  it("a premiere needs the copy but no media", () => {
    expect(
      premiereProblems(listing({ media_hls: null, media_poster: null, duration_seconds: null })),
    ).toEqual([]);
    expect(premiereProblems(listing({ kicker: "" })).length).toBeGreaterThan(0);
  });
});

describe("what the website reads", () => {
  it("serves a published listing with its media", () => {
    const wire = toPublicListing(listing({ status: "published" }))!;
    expect(wire.media?.hls).toBe("videos/borrowing-capacity/v1/master.m3u8");
    expect(wire.duration_seconds).toBe(147);
    expect(wire.chapters).toHaveLength(2);
  });

  it("serves a premiere with no media, even when some was uploaded early", () => {
    const wire = toPublicListing(listing({ status: "premiere" }))!;
    expect(wire.media).toBeNull();
    expect(wire.duration_seconds).toBeNull();
    expect(wire.published_on).toBeNull();
    expect(wire.chapters).toEqual([]);
  });

  it("serves nothing for a draft or an archived listing", () => {
    expect(toPublicListing(listing({ status: "draft" }))).toBeNull();
    expect(toPublicListing(listing({ status: "archived" }))).toBeNull();
  });

  it("only changes that touch a live listing rebuild the website", () => {
    expect(affectsWebsite({ status: "draft" }, { status: "draft" })).toBe(false);
    expect(affectsWebsite({ status: "draft" }, { status: "published" })).toBe(true);
    expect(affectsWebsite({ status: "published" }, { status: "archived" })).toBe(true);
    expect(affectsWebsite(null, { status: "premiere" })).toBe(true);
  });
});

describe("uploads", () => {
  const encoded = [
    "master.m3u8",
    "poster.jpg",
    "card.jpg",
    "fallback-720p.mp4",
    "v240/playlist.m3u8",
    "v240/init.mp4",
    "v240/seg-00000.m4s",
    "aud-lo/playlist.m3u8",
    "aud-lo/seg-00000.m4s",
  ];

  it("orders media first, rendition playlists next, the master last", () => {
    const plan = planUpload(encoded);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const phases = plan.files.map((f) => f.phase);
    expect(phases).toEqual([...phases].sort((a, b) => a - b));
    expect(plan.files.at(-1)?.path).toBe("master.m3u8");
    expect(plan.files.find((f) => f.path === "v240/seg-00000.m4s")?.cacheControl).toMatch(
      /immutable/,
    );
    expect(plan.files.find((f) => f.path === "master.m3u8")?.cacheControl).toMatch(/max-age=300/);
    expect(plan.files.find((f) => f.path === "v240/seg-00000.m4s")?.contentType).toBe(
      "video/iso.segment",
    );
  });

  it("refuses a folder that is not an encoder package, and says why", () => {
    const plan = planUpload(["notes.txt", "v240/seg-00000.m4s"]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.problems.join(" ")).toMatch(/notes\.txt/);
    expect(plan.problems.join(" ")).toMatch(/master\.m3u8/);
    expect(plan.problems.join(" ")).toMatch(/poster\.jpg/);
  });

  it("refuses paths that climb or nest", () => {
    expect(planUpload(["master.m3u8", "poster.jpg", "../x.m4s"]).ok).toBe(false);
    expect(planUpload(["master.m3u8", "poster.jpg", "a/b/c.m4s"]).ok).toBe(false);
  });

  it("never reuses a version folder", () => {
    expect(nextVersion([])).toBe("v1");
    expect(nextVersion(["v1", null, "v3", "v2"])).toBe("v4");
    expect(nextVersion(["junk"])).toBe("v1");
  });

  it("fills the media fields from what was uploaded", () => {
    expect(mediaFieldsFor("videos/x/v2/", encoded)).toEqual({
      media_hls: "videos/x/v2/master.m3u8",
      media_mp4: "videos/x/v2/fallback-720p.mp4",
      media_poster: "videos/x/v2/poster.jpg",
      media_card: "videos/x/v2/card.jpg",
      media_captions: null,
      media_thumbnail: null,
    });
    expect(mediaFieldsFor("videos/x/v2/", [...encoded, "thumbnail.jpg"]).media_thumbnail).toBe(
      "videos/x/v2/thumbnail.jpg",
    );
  });
});

/** The first bytes of a baseline JPEG of this size, as a browser's encoder writes them. */
function jpegHead(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(1)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 255, width >> 8, width & 255, 3];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...dqt, ...sof, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
}

describe("pictures", () => {
  it("each picture has the size the website expects, the poster in the video's shape", () => {
    expect(pictureShape("thumbnail", "portrait")).toMatchObject({ width: 1920, height: 1080 });
    expect(pictureShape("poster", "portrait")).toMatchObject({ width: 1080, height: 1920 });
    expect(pictureShape("poster", "landscape")).toMatchObject({ width: 1920, height: 1080 });
    expect(pictureShape("card", "portrait")).toMatchObject({ width: 1200, height: 630 });
  });

  it("takes a 4K master, refuses another shape or too few pixels, never crops to fit", () => {
    expect(pictureSizeProblem("thumbnail", "portrait", { width: 3840, height: 2160 })).toBeNull();
    expect(pictureSizeProblem("poster", "portrait", { width: 2160, height: 3840 })).toBeNull();
    expect(pictureSizeProblem("thumbnail", "portrait", { width: 1080, height: 1920 })).toMatch(
      /16:9/,
    );
    expect(pictureSizeProblem("poster", "portrait", { width: 1920, height: 1080 })).toMatch(/9:16/);
    expect(pictureSizeProblem("thumbnail", "landscape", { width: 1024, height: 576 })).toMatch(
      /at least 1280×720/,
    );
    expect(pictureSizeProblem("card", "landscape", { width: 1200, height: 630 })).toBeNull();
    expect(pictureSizeProblem("thumbnail", "landscape", { width: 0, height: 0 })).toMatch(/16:9/);
    // Within 1% of the shape is taken (and trimmed by a pixel or two when drawn).
    expect(pictureSizeProblem("thumbnail", "landscape", { width: 1920, height: 1090 })).toBeNull();
    expect(
      pictureSizeProblem("thumbnail", "landscape", { width: 1920, height: 1100 }),
    ).not.toBeNull();
  });

  it("makes the card from the thumbnail's centre, the full width kept", () => {
    expect(coverCrop({ width: 3840, height: 2160 }, { width: 1200, height: 630 })).toEqual({
      sx: 0,
      sy: 72,
      sw: 3840,
      sh: 2016,
    });
    expect(coverCrop({ width: 1920, height: 1080 }, { width: 1920, height: 1080 })).toEqual({
      sx: 0,
      sy: 0,
      sw: 1920,
      sh: 1080,
    });
    expect(coverCrop({ width: 2000, height: 1080 }, { width: 1920, height: 1080 })).toMatchObject({
      sx: 40,
      sw: 1920,
    });
  });

  it("uploads only the three pictures on their own, each a JPEG cached for good", () => {
    const plan = planPicturesUpload(["thumbnail.jpg", "card.jpg"]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.files.map((f) => f.path)).toEqual(["card.jpg", "thumbnail.jpg"]);
    expect(plan.files.every((f) => f.contentType === "image/jpeg")).toBe(true);
    expect(plan.files.every((f) => /immutable/.test(f.cacheControl))).toBe(true);
    expect(planPicturesUpload([]).ok).toBe(false);
    const bad = planPicturesUpload(["poster.jpg", "master.m3u8"]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.join()).toMatch(/master\.m3u8/);
  });

  it("fills only the pictures an upload holds", () => {
    expect(pictureFieldsFor("videos/x/v3/", ["thumbnail.jpg", "poster.jpg"])).toEqual({
      media_thumbnail: "videos/x/v3/thumbnail.jpg",
      media_poster: "videos/x/v3/poster.jpg",
    });
  });

  it("knows a picture uploaded on its own from one that came with the video", () => {
    const row = listing({
      media_version: "v1",
      media_poster: "videos/borrowing-capacity/v2/poster.jpg",
      media_card: "videos/borrowing-capacity/v1/card-2.jpg",
      media_thumbnail: null,
    });
    expect(pictureSource(row, "poster")).toBe("own");
    expect(pictureSource(row, "card")).toBe("video");
    expect(pictureSource(row, "thumbnail")).toBe("none");
    // Before any video, every picture was uploaded on its own.
    expect(
      pictureSource(
        listing({
          media_version: null,
          media_thumbnail: "videos/borrowing-capacity/v1/thumbnail.jpg",
        }),
        "thumbnail",
      ),
    ).toBe("own");
  });

  it("a new video keeps the pictures uploaded on their own, and replaces its own", () => {
    const before = listing({
      media_version: "v1",
      media_poster: "videos/borrowing-capacity/v2/poster.jpg",
      media_card: "videos/borrowing-capacity/v1/card-2.jpg",
      media_thumbnail: "videos/borrowing-capacity/v2/thumbnail.jpg",
    });
    const incoming = mediaFieldsFor("videos/borrowing-capacity/v3/", [
      "master.m3u8",
      "poster.jpg",
      "card.jpg",
    ]);
    expect(picturesAfterPackage(before, incoming, "portrait")).toEqual({
      fields: {
        media_poster: "videos/borrowing-capacity/v2/poster.jpg",
        media_card: "videos/borrowing-capacity/v3/card.jpg",
        media_thumbnail: "videos/borrowing-capacity/v2/thumbnail.jpg",
      },
      kept: ["thumbnail", "poster"],
    });
    // A video that changed shape takes its own poster: the old one would not fit the frame.
    const reshaped = picturesAfterPackage(before, incoming, "landscape");
    expect(reshaped.fields.media_poster).toBe("videos/borrowing-capacity/v3/poster.jpg");
    expect(reshaped.kept).toEqual(["thumbnail"]);
  });

  it("reads a JPEG's size from its frame header", () => {
    expect(jpegSize(jpegHead(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(jpegSize(jpegHead(1080, 1920))).toEqual({ width: 1080, height: 1920 });
    expect(jpegSize(new TextEncoder().encode("<html>not found</html>"))).toBeNull();
    expect(jpegSize(jpegHead(1200, 630).slice(0, 30))).toBeNull();
  });

  it("any media at all fixes the slug", () => {
    expect(
      hasMedia(
        listing({
          media_version: null,
          media_hls: null,
          media_mp4: null,
          media_poster: null,
          media_card: null,
        }),
      ),
    ).toBe(false);
    expect(
      hasMedia(
        listing({
          media_version: null,
          media_hls: null,
          media_mp4: null,
          media_poster: null,
          media_card: null,
          media_thumbnail: "videos/borrowing-capacity/v1/thumbnail.jpg",
        }),
      ),
    ).toBe(true);
  });

  it("serves the thumbnail of a published listing, and none for a premiere", () => {
    const thumb = "videos/borrowing-capacity/v2/thumbnail.jpg";
    expect(
      toPublicListing(listing({ status: "published", media_thumbnail: thumb }))?.media?.thumbnail,
    ).toBe(thumb);
    expect(toPublicListing(listing({ status: "published" }))?.media?.thumbnail).toBeNull();
    expect(
      toPublicListing(listing({ status: "premiere", media_thumbnail: thumb }))?.media,
    ).toBeNull();
  });

  it("holds the thumbnail to the listing's own folder", () => {
    expect(
      publishProblems(listing({ media_thumbnail: "videos/another-video/v1/thumbnail.jpg" })).join(),
    ).toMatch(/thumbnail file is outside/);
  });
});

describe("library order", () => {
  const rows = [
    { id: "a", slug: "a", status: "published", sort_order: 10 },
    { id: "b", slug: "b", status: "draft", sort_order: 20 },
    { id: "c", slug: "c", status: "premiere", sort_order: 100 },
  ];

  it("renumbers in tens, and writes only the listings that move", () => {
    expect(reorderPlan(rows, ["c", "a", "b"])).toEqual({
      ok: true,
      changes: [
        { id: "c", sort_order: 10 },
        { id: "a", sort_order: 20 },
        { id: "b", sort_order: 30 },
      ],
    });
    expect(reorderPlan(rows, ["a", "b", "c"])).toEqual({
      ok: true,
      changes: [{ id: "c", sort_order: 30 }],
    });
  });

  it("refuses an order that is not every listing exactly once", () => {
    expect(reorderPlan(rows, ["a", "b"]).ok).toBe(false);
    expect(reorderPlan(rows, ["a", "b", "b"]).ok).toBe(false);
    expect(reorderPlan(rows, ["a", "b", "z"]).ok).toBe(false);
  });

  it("the website's order is the live listings', and its code tags count them", () => {
    expect(liveOrder(rows)).toEqual(["a", "c"]);
    expect(liveOrder([...rows].reverse())).toEqual(["a", "c"]);
    expect(libraryCode(["a", "c"], "c")).toBe("BRF-02");
    expect(libraryCode(["a", "c"], "b")).toBeNull();
  });
});

describe("reading the stream back", () => {
  const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-lo",NAME="lo",URI="aud-lo/playlist.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=240x426,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud-lo"
v240/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1080x1920,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud-lo"
v1080/playlist.m3u8
`;

  it("parses variants, resolutions and alternate renditions", () => {
    const parsed = parseMasterPlaylist(master);
    expect(parsed.variants.map((v) => v.uri)).toEqual([
      "v240/playlist.m3u8",
      "v1080/playlist.m3u8",
    ]);
    expect(parsed.variants[1]).toMatchObject({ width: 1080, height: 1920, bandwidth: 6000000 });
    expect(parsed.media).toEqual(["aud-lo/playlist.m3u8"]);
    expect(orientationOf(parsed)).toBe("portrait");
  });

  it("sums a media playlist's segments", () => {
    expect(
      playlistDuration(
        "#EXTM3U\n#EXTINF:4.000,\na.m4s\n#EXTINF:4.000,\nb.m4s\n#EXTINF:3.2,\nc.m4s\n",
      ),
    ).toBeCloseTo(11.2);
  });

  it("only follows URIs that stay in the version folder", () => {
    expect(resolveWithin("videos/x/v1/", "v240/playlist.m3u8")).toBe(
      "videos/x/v1/v240/playlist.m3u8",
    );
    expect(resolveWithin("videos/x/v1/", "https://evil.example/p.m3u8")).toBeNull();
    expect(resolveWithin("videos/x/v1/", "../v2/playlist.m3u8")).toBeNull();
    expect(resolveWithin("videos/x/v1/", "/videos/y/v1/playlist.m3u8")).toBeNull();
  });
});

describe("editor helpers", () => {
  it("slugifies titles into URL segments", () => {
    expect(slugify("Borrowing Capacity, in Moments")).toBe("borrowing-capacity-in-moments");
    expect(slugify("Inside the Compliance Passport™")).toBe("inside-the-compliance-passport");
    expect(slugify("Tax & Structuring")).toBe("tax-and-structuring");
  });
  it("reads and writes chapter times", () => {
    expect(parseChapterTime("1:05")).toBe(65);
    expect(parseChapterTime("0:00")).toBe(0);
    expect(parseChapterTime("75")).toBe(75);
    expect(parseChapterTime("1:75")).toBeNull();
    expect(parseChapterTime("soon")).toBeNull();
    expect(formatChapterTime(65)).toBe("1:05");
  });
  it("splits a transcript on blank lines", () => {
    expect(paragraphsOf("One line.\nstill one.\n\nTwo.\n\n\n")).toEqual([
      "One line. still one.",
      "Two.",
    ]);
  });
  it("reads chapters defensively", () => {
    expect(chaptersOf([{ at: 0, label: "A" }, { at: "x" }, null])).toEqual([{ at: 0, label: "A" }]);
    expect(chaptersOf("nope")).toEqual([]);
  });
  it("stamps a first publish with the Sydney date", () => {
    // 28 Oct 2026 14:00 UTC is already the 29th in Sydney (UTC+11).
    expect(sydneyDate(new Date("2026-10-28T14:00:00Z"))).toBe("2026-10-29");
  });
});
