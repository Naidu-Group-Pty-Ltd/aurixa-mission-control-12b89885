import { describe, expect, it } from "vitest";
import {
  affectsWebsite,
  chaptersOf,
  formatChapterTime,
  mediaFieldsFor,
  nextVersion,
  orientationOf,
  paragraphsOf,
  parseChapterTime,
  parseMasterPlaylist,
  planUpload,
  playlistDuration,
  premiereProblems,
  publishProblems,
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
    });
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
