/**
 * Website videos against an in-memory database and a fake bucket.
 *
 * The rules are pinned in `websiteBriefings.pure.test.ts`. What only the acts
 * can get wrong is the reading and writing: that a grant is stored as a hash
 * and checked path by path, that an upload is pointed at only after the
 * bucket answers for every file, that publishing stamps a date once, and that
 * a refused act writes nothing. The fake evaluates its filters against stored
 * rows rather than recording them, so a write that lands on the wrong row
 * fails here the way it would against Postgres. A column a migration has not
 * added yet (`db.missing`) is absent from what is read, and a write naming it
 * is answered PGRST204, as PostgREST answers it.
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  audit: [] as Array<{ action: string; metadata?: Record<string, unknown> }>,
  /** "table.column" for each column whose migration has not applied. */
  missing: new Set<string>(),
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let patch: Row = {};
    let inserts: Row[] = [];
    let embedBriefing = false;
    const run = (kind: "many" | "maybe" | "single") => {
      const rows = (db.tables[table] ??= []);
      let result: Row[];
      const written = mode === "insert" ? inserts : mode === "update" ? [patch] : [];
      const absent = written.flatMap(Object.keys).find((c) => db.missing.has(`${table}.${c}`));
      if (absent) {
        return {
          data: null,
          error: {
            code: "PGRST204",
            message: `Could not find the '${absent}' column of '${table}' in the schema cache`,
          },
        };
      }
      if (mode === "insert") {
        for (const r of inserts) {
          if (
            table === "website_briefing_uploads" &&
            rows.some((x) => x.briefing_id === r.briefing_id && x.version === r.version)
          ) {
            return { data: null, error: { code: "23505", message: "duplicate" } };
          }
        }
        const defaults: Row =
          table === "website_briefing_uploads" && !db.missing.has(`${table}.kind`)
            ? { kind: "package" }
            : {};
        result = inserts.map((r) => ({
          id: crypto.randomUUID(),
          completed_at: null,
          ...defaults,
          ...r,
        }));
        rows.push(...result);
      } else {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        if (mode === "update") matched.forEach((r) => Object.assign(r, patch));
        if (mode === "delete") db.tables[table] = rows.filter((r) => !matched.includes(r));
        result = matched.map((r) => ({ ...r }));
      }
      if (embedBriefing) {
        result = result.map((r) => ({
          ...r,
          website_briefings: (db.tables.website_briefings ?? []).find((b) => b.id === r.briefing_id)
            ? {
                slug: (db.tables.website_briefings ?? []).find((b) => b.id === r.briefing_id)!.slug,
              }
            : null,
        }));
      }
      result = result.map((r) =>
        Object.fromEntries(Object.entries(r).filter(([c]) => !db.missing.has(`${table}.${c}`))),
      );
      if (kind === "many") return { data: result, error: null };
      if (kind === "single" && result.length !== 1)
        return { data: null, error: { code: "PGRST116", message: "not one row" } };
      return { data: result[0] ?? null, error: null };
    };
    const b: Record<string, unknown> = {
      select: (cols?: string) => {
        if (cols?.includes("website_briefings(")) embedBriefing = true;
        return b;
      },
      insert: (r: Row | Row[]) => {
        mode = "insert";
        inserts = Array.isArray(r) ? r : [r];
        return b;
      },
      update: (p: Row) => {
        mode = "update";
        patch = p;
        return b;
      },
      delete: () => {
        mode = "delete";
        return b;
      },
      eq: (c: string, v: unknown) => {
        // `metadata->>env` reads a jsonb key as text, as PostgREST does.
        const [column, key] = c.split("->>");
        filters.push((r) =>
          key === undefined
            ? r[c] === v
            : String((r[column] as Row | null)?.[key] ?? "") === String(v),
        );
        return b;
      },
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
      order: () => b,
      limit: () => b,
      maybeSingle: async () => run("maybe"),
      single: async () => run("single"),
      then: (resolve: (v: unknown) => void) => resolve(run("many")),
    };
    return b;
  }
  return { supabaseAdmin: { from } };
});

vi.mock("./audit.server", () => ({
  writeAuditLog: async (entry: { action: string }) => {
    db.audit.push(entry);
  },
}));

const {
  PICTURES_MIGRATION,
  REBUILD_TIMEOUT_MS,
  buildAnnouncementFrom,
  createUploadGrant,
  deleteDraftWebsiteBriefing,
  finalizePicturesUpload,
  finalizeUpload,
  lastWebsiteBuildRead,
  listPublicListings,
  reorderWebsiteBriefings,
  requestWebsiteRebuild,
  resetBriefingPicture,
  saveWebsiteBriefing,
  setWebsiteBriefingStatus,
  verifyUploadGrant,
} = await import("./website-briefings.server");

const ORIGIN = "https://bucket.test/public";
const ACTOR = "00000000-0000-4000-8000-0000000000aa";

const briefing = (over: Row = {}): Row => ({
  id: "b1",
  slug: "client-reporting",
  status: "draft",
  title: "Client Reporting, Branded",
  kicker: "A report the client can understand, in your firm's own brand.",
  summary:
    "How a property moves from financial analysis into a professional, branded report the client can understand, from the same record the analysis used.",
  series: "platform",
  artwork: "/brand/layer-02-strategic-intelligence.webp",
  artwork_position: null,
  takeaways: ["Branded reports.", "From the client record."],
  explore_label: "See custom reporting",
  explore_to: "/platform#custom-reporting",
  orientation: "landscape",
  disclaimer: null,
  transcript: [],
  chapters: [],
  media_version: null,
  media_hls: null,
  media_mp4: null,
  media_poster: null,
  media_card: null,
  media_captions: null,
  media_thumbnail: null,
  duration_seconds: null,
  published_on: null,
  sort_order: 40,
  ...over,
});

const PACKAGE = [
  "master.m3u8",
  "poster.jpg",
  "card.jpg",
  "fallback-720p.mp4",
  "v240/playlist.m3u8",
  "v240/seg-00000.m4s",
  "v1080/playlist.m3u8",
  "v1080/seg-00000.m4s",
];

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=240x426
v240/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1080x1920
v1080/playlist.m3u8
`;
const VARIANT =
  "#EXTM3U\n#EXTINF:4.000,\nseg-00000.m4s\n#EXTINF:4.000,\nseg-00001.m4s\n#EXTINF:3.4,\nseg-00002.m4s\n";

function bucket(files: Record<string, string | Uint8Array>) {
  vi.stubGlobal("fetch", async (url: string) => {
    const path = String(url).replace(`${ORIGIN}/`, "");
    return path in files
      ? new Response(files[path], { status: 200 })
      : new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  db.tables = { website_briefings: [briefing()], website_briefing_uploads: [] };
  db.audit = [];
  db.missing = new Set();
  vi.stubEnv("WEBSITE_MEDIA_ORIGIN", ORIGIN);
  vi.stubEnv("WEBSITE_DEPLOY_HOOK_URL", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("upload grants", () => {
  it("grant the next version folder, and keep only the token's hash", async () => {
    db.tables.website_briefings[0].media_version = "v1";
    const grant = await createUploadGrant({ briefingId: "b1", paths: PACKAGE, actorId: ACTOR });
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    expect(grant.version).toBe("v2");
    expect(grant.prefix).toBe("videos/client-reporting/v2/");
    const stored = db.tables.website_briefing_uploads[0];
    expect(stored.token_sha256).toBe(crypto.createHash("sha256").update(grant.token).digest("hex"));
    expect(JSON.stringify(stored)).not.toContain(grant.token);
  });

  it("a second upload takes the version after the first, never the same one", async () => {
    const first = await createUploadGrant({ briefingId: "b1", paths: PACKAGE, actorId: ACTOR });
    const second = await createUploadGrant({ briefingId: "b1", paths: PACKAGE, actorId: ACTOR });
    expect(first.ok && first.version).toBe("v1");
    expect(second.ok && second.version).toBe("v2");
  });

  it("refuses a folder that is not a package, and grants nothing", async () => {
    const grant = await createUploadGrant({
      briefingId: "b1",
      paths: ["notes.txt"],
      actorId: ACTOR,
    });
    expect(grant.ok).toBe(false);
    expect(db.tables.website_briefing_uploads).toHaveLength(0);
  });

  it("answers the website's signing function only for a live token and granted paths", async () => {
    const grant = await createUploadGrant({ briefingId: "b1", paths: PACKAGE, actorId: ACTOR });
    if (!grant.ok) throw new Error("no grant");
    expect(
      await verifyUploadGrant({ token: grant.token, paths: ["master.m3u8", "v240/seg-00000.m4s"] }),
    ).toEqual({
      ok: true,
      prefix: "videos/client-reporting/v1/",
    });
    expect(
      await verifyUploadGrant({ token: "x".repeat(43), paths: ["master.m3u8"] }),
    ).toMatchObject({
      ok: false,
      error: "unknown_grant",
    });
    expect(
      await verifyUploadGrant({ token: grant.token, paths: ["v720/seg-00000.m4s"] }),
    ).toMatchObject({
      ok: false,
      error: "path_not_granted",
    });
    expect(
      await verifyUploadGrant({ token: grant.token, paths: ["../escape.m3u8"] }),
    ).toMatchObject({
      ok: false,
      error: "bad_paths",
    });
    db.tables.website_briefing_uploads[0].expires_at = new Date(Date.now() - 1000).toISOString();
    expect(await verifyUploadGrant({ token: grant.token, paths: ["master.m3u8"] })).toMatchObject({
      ok: false,
      error: "grant_expired",
    });
  });
});

describe("finishing an upload", () => {
  async function granted() {
    const grant = await createUploadGrant({ briefingId: "b1", paths: PACKAGE, actorId: ACTOR });
    if (!grant.ok) throw new Error("no grant");
    return grant;
  }
  const v1 = (path: string) => `videos/client-reporting/v1/${path}`;

  it("points the listing at the media only once the bucket answers for all of it", async () => {
    const grant = await granted();
    bucket({
      [v1("master.m3u8")]: MASTER,
      [v1("v240/playlist.m3u8")]: VARIANT,
      [v1("v1080/playlist.m3u8")]: VARIANT,
      [v1("poster.jpg")]: "jpg",
      [v1("card.jpg")]: "jpg",
      [v1("fallback-720p.mp4")]: "mp4",
    });
    const done = await finalizeUpload({ uploadId: grant.uploadId, actorId: ACTOR });
    expect(done).toMatchObject({
      ok: true,
      durationSeconds: 11,
      orientation: "portrait",
      rebuild: null,
    });
    expect(db.tables.website_briefings[0]).toMatchObject({
      media_version: "v1",
      media_hls: v1("master.m3u8"),
      media_poster: v1("poster.jpg"),
      media_card: v1("card.jpg"),
      media_mp4: v1("fallback-720p.mp4"),
      duration_seconds: 11,
      orientation: "portrait",
    });
    expect(db.tables.website_briefing_uploads[0].completed_at).toBeTruthy();
    // A spent grant signs nothing more.
    expect(await verifyUploadGrant({ token: grant.token, paths: ["master.m3u8"] })).toMatchObject({
      ok: false,
      error: "grant_used",
    });
  });

  it("changes nothing when a rendition is missing", async () => {
    const grant = await granted();
    bucket({
      [v1("master.m3u8")]: MASTER,
      [v1("v240/playlist.m3u8")]: VARIANT,
      [v1("poster.jpg")]: "jpg",
      [v1("card.jpg")]: "jpg",
      [v1("fallback-720p.mp4")]: "mp4",
    });
    const done = await finalizeUpload({ uploadId: grant.uploadId, actorId: ACTOR });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.problems?.join(" ")).toMatch(/v1080\/playlist\.m3u8 does not answer/);
    expect(db.tables.website_briefings[0].media_version).toBeNull();
    expect(db.tables.website_briefing_uploads[0].completed_at).toBeNull();
  });

  it("refuses a master playlist that reaches outside its folder", async () => {
    const grant = await granted();
    bucket({
      [v1("master.m3u8")]:
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1x1\nhttps://elsewhere.test/p.m3u8\n",
      [v1("poster.jpg")]: "jpg",
      [v1("card.jpg")]: "jpg",
      [v1("fallback-720p.mp4")]: "mp4",
    });
    const done = await finalizeUpload({ uploadId: grant.uploadId, actorId: ACTOR });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.problems?.join(" ")).toMatch(/outside its folder/);
  });
});

describe("going live", () => {
  it("refuses to publish a listing with nothing to play, and writes nothing", async () => {
    const result = await setWebsiteBriefingStatus({
      id: "b1",
      status: "published",
      actorId: ACTOR,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContain("Upload the video first.");
    expect(db.tables.website_briefings[0].status).toBe("draft");
  });

  it("stamps a first publish with a date, keeps it on a republish, and says the rebuild is not connected", async () => {
    Object.assign(db.tables.website_briefings[0], {
      media_version: "v1",
      media_hls: "videos/client-reporting/v1/master.m3u8",
      media_poster: "videos/client-reporting/v1/poster.jpg",
      duration_seconds: 95,
    });
    const first = await setWebsiteBriefingStatus({ id: "b1", status: "published", actorId: ACTOR });
    expect(first).toMatchObject({
      ok: true,
      rebuild: { requested: false, reason: "not_configured" },
    });
    const stamped = db.tables.website_briefings[0].published_on;
    expect(stamped).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await setWebsiteBriefingStatus({ id: "b1", status: "draft", actorId: ACTOR });
    db.tables.website_briefings[0].published_on = "2026-10-28";
    await setWebsiteBriefingStatus({ id: "b1", status: "published", actorId: ACTOR });
    expect(db.tables.website_briefings[0].published_on).toBe("2026-10-28");
  });

  it("asks the website to rebuild through the deploy hook", async () => {
    vi.stubEnv("WEBSITE_DEPLOY_HOOK_URL", "https://hooks.test/deploy");
    const hooks: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      hooks.push(`${init?.method} ${url}`);
      return new Response('{"job":{"id":"job_1","state":"PENDING"}}', { status: 201 });
    });
    const result = await setWebsiteBriefingStatus({ id: "b1", status: "premiere", actorId: ACTOR });
    expect(result).toMatchObject({ ok: true, rebuild: { requested: true, job: "job_1" } });
    expect(hooks).toEqual(["POST https://hooks.test/deploy"]);
    expect(db.audit.map((a) => a.action)).toContain("website.rebuild_requested");
  });

  it("sends the hook a body of stated, empty length", async () => {
    // A POST of unstated length leaves the other end to wait for a body.
    vi.stubEnv("WEBSITE_DEPLOY_HOOK_URL", "https://hooks.test/deploy");
    let sent: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sent = init;
      return new Response("{}", { status: 201 });
    });
    await requestWebsiteRebuild({ reason: "test", actorId: ACTOR });
    expect(sent?.body).toBe("");
    expect(sent?.signal).toBeInstanceOf(AbortSignal);
  });

  it("calls a hook Vercel did not answer in time unconfirmed — not failed", async () => {
    // 29 Oct 2026: Vercel answered after the wait ran out, and started the build.
    vi.stubEnv("WEBSITE_DEPLOY_HOOK_URL", "https://hooks.test/deploy");
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const result = await requestWebsiteRebuild({ reason: "test", actorId: ACTOR });
    expect(result).toEqual({
      requested: false,
      reason: "unconfirmed",
      detail: `Vercel had not answered after ${REBUILD_TIMEOUT_MS / 1000} seconds`,
    });
    expect(db.audit.at(-1)).toMatchObject({
      action: "website.rebuild_unconfirmed",
      metadata: { reason: "test", elapsed_ms: expect.any(Number) },
    });
  });

  it("calls a refusal or an unreachable hook a failure", async () => {
    vi.stubEnv("WEBSITE_DEPLOY_HOOK_URL", "https://hooks.test/deploy");
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
    expect(await requestWebsiteRebuild({ reason: "test", actorId: ACTOR })).toEqual({
      requested: false,
      reason: "failed",
      detail: "HTTP 404",
    });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await requestWebsiteRebuild({ reason: "test", actorId: ACTOR })).toMatchObject({
      reason: "failed",
      detail: "fetch failed",
    });
    expect(db.audit.at(-1)).toMatchObject({ action: "website.rebuild_failed" });
  });

  it("reads a website build's announcement, and nothing that is not one", () => {
    const headers = (h: Record<string, string>) => new Headers(h);
    expect(
      buildAnnouncementFrom(
        headers({ "x-aurixa-build-env": "Production", "x-aurixa-build-id": "dpl_3BgjqP16QD7" }),
      ),
    ).toEqual({ env: "production", build: "dpl_3BgjqP16QD7" });
    expect(buildAnnouncementFrom(headers({}))).toBeNull();
    expect(
      buildAnnouncementFrom(
        headers({ "x-aurixa-build-env": "prod", "x-aurixa-build-id": "dpl_1" }),
      ),
    ).toBeNull();
    expect(
      buildAnnouncementFrom(
        headers({ "x-aurixa-build-env": "production", "x-aurixa-build-id": "<script>" }),
      ),
    ).toBeNull();
  });

  it("the website reads premiere and published listings only, and a premiere without media", async () => {
    db.tables.website_briefings.push(
      briefing({ id: "b2", slug: "archived-one", status: "archived" }),
      briefing({
        id: "b3",
        slug: "soon",
        status: "premiere",
        media_hls: "videos/soon/v1/master.m3u8",
      }),
    );
    const listed = await listPublicListings();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.listings.map((l) => l.slug)).toEqual(["soon"]);
    expect(listed.listings[0].media).toBeNull();
  });
});

describe("the last production build that read the listings", () => {
  const read = (created_at: string, metadata: Row): Row => ({
    action: "website.build_read_listings",
    created_at,
    metadata,
  });

  it("is a production build's, and says whether it was given the listings", async () => {
    db.tables.audit_log = [
      read("2026-10-29T05:00:00.000Z", {
        env: "production",
        build: "dpl_b",
        ok: false,
        listings: 0,
      }),
    ];
    expect(await lastWebsiteBuildRead()).toEqual({
      at: "2026-10-29T05:00:00.000Z",
      build: "dpl_b",
      ok: false,
    });
  });

  it("is not a preview build's", async () => {
    db.tables.audit_log = [
      read("2026-10-29T05:00:00.000Z", { env: "preview", build: "dpl_p", ok: true, listings: 3 }),
    ];
    expect(await lastWebsiteBuildRead()).toBeNull();
  });
});

/** The first bytes of a baseline JPEG of this size, as a browser's encoder writes them. */
function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 255, width >> 8, width & 255, 3];
  return Uint8Array.from([0xff, 0xd8, ...app0, ...sof, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
}

const LIVE_MEDIA = {
  status: "published",
  published_on: "2026-10-28",
  media_version: "v1",
  media_hls: "videos/client-reporting/v1/master.m3u8",
  media_mp4: "videos/client-reporting/v1/fallback-720p.mp4",
  media_poster: "videos/client-reporting/v1/poster.jpg",
  media_card: "videos/client-reporting/v1/card.jpg",
  duration_seconds: 95,
  orientation: "portrait",
};
const at = (version: string, file: string) => `videos/client-reporting/${version}/${file}`;

describe("pictures on their own", () => {
  async function picturesGrant(paths: string[]) {
    const grant = await createUploadGrant({
      briefingId: "b1",
      paths,
      actorId: ACTOR,
      kind: "images",
    });
    if (!grant.ok) throw new Error(grant.error);
    return grant;
  }

  it("grant the next version folder for pictures alone, and nothing else", async () => {
    Object.assign(db.tables.website_briefings[0], LIVE_MEDIA);
    const grant = await picturesGrant(["thumbnail.jpg", "poster.jpg"]);
    expect(grant.version).toBe("v2");
    expect(db.tables.website_briefing_uploads[0]).toMatchObject({ kind: "images" });
    const refused = await createUploadGrant({
      briefingId: "b1",
      paths: ["thumbnail.jpg", "master.m3u8"],
      actorId: ACTOR,
      kind: "images",
    });
    expect(refused.ok).toBe(false);
    expect(db.tables.website_briefing_uploads).toHaveLength(1);
  });

  it("point a live listing at the pictures once their sizes check out, and leave the stream", async () => {
    Object.assign(db.tables.website_briefings[0], LIVE_MEDIA);
    const grant = await picturesGrant(["thumbnail.jpg", "poster.jpg", "card.jpg"]);
    bucket({
      [at("v2", "thumbnail.jpg")]: jpeg(1920, 1080),
      [at("v2", "poster.jpg")]: jpeg(1080, 1920),
      [at("v2", "card.jpg")]: jpeg(1200, 630),
    });
    const done = await finalizePicturesUpload({ uploadId: grant.uploadId, actorId: ACTOR });
    expect(done).toMatchObject({
      ok: true,
      pictures: ["thumbnail", "poster", "card"],
      rebuild: { requested: false, reason: "not_configured" },
    });
    expect(db.tables.website_briefings[0]).toMatchObject({
      media_version: "v1",
      media_hls: at("v1", "master.m3u8"),
      media_thumbnail: at("v2", "thumbnail.jpg"),
      media_poster: at("v2", "poster.jpg"),
      media_card: at("v2", "card.jpg"),
    });
    expect(db.tables.website_briefing_uploads[0].completed_at).toBeTruthy();
    expect(db.audit.find((a) => a.action === "website_briefing.pictures_uploaded")).toMatchObject({
      metadata: { version: "v2", replaced: { poster: at("v1", "poster.jpg") } },
    });
    // The website is served the thumbnail with the stream it already had.
    const listed = await listPublicListings();
    expect(listed.ok && listed.listings[0].media).toMatchObject({
      hls: at("v1", "master.m3u8"),
      thumbnail: at("v2", "thumbnail.jpg"),
    });
  });

  it("change nothing when a picture is the wrong size, is not a JPEG, or did not land", async () => {
    Object.assign(db.tables.website_briefings[0], LIVE_MEDIA);
    const grant = await picturesGrant(["thumbnail.jpg", "poster.jpg", "card.jpg"]);
    bucket({
      [at("v2", "thumbnail.jpg")]: jpeg(1919, 1080),
      // A portrait video's poster in the landscape shape would letterbox in the theatre.
      [at("v2", "poster.jpg")]: jpeg(1920, 1080),
      [at("v2", "card.jpg")]: "<html>not a picture</html>",
    });
    const done = await finalizePicturesUpload({ uploadId: grant.uploadId, actorId: ACTOR });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.problems).toEqual([
      "thumbnail.jpg is 1919×1080; the thumbnail is 1920×1080.",
      "poster.jpg is 1920×1080; the poster is 1080×1920.",
      "card.jpg is not a JPEG.",
    ]);
    bucket({});
    const missing = await finalizePicturesUpload({ uploadId: grant.uploadId, actorId: ACTOR });
    expect(missing.ok || missing.problems?.[0]).toBe("thumbnail.jpg does not answer (HTTP 404).");
    expect(db.tables.website_briefings[0].media_poster).toBe(at("v1", "poster.jpg"));
    expect(db.tables.website_briefing_uploads[0].completed_at).toBeNull();
  });

  it("each kind of upload is finished only by its own act", async () => {
    const pictures = await picturesGrant(["thumbnail.jpg"]);
    const video = await createUploadGrant({ briefingId: "b1", paths: PACKAGE, actorId: ACTOR });
    if (!video.ok) throw new Error("no grant");
    expect(await finalizeUpload({ uploadId: pictures.uploadId, actorId: ACTOR })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/holds pictures/),
    });
    expect(
      await finalizePicturesUpload({ uploadId: video.uploadId, actorId: ACTOR }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/video package/) });
    expect(db.tables.website_briefing_uploads.every((u) => u.completed_at === null)).toBe(true);
  });

  it("before the migration applies, say so — and the video still uploads", async () => {
    db.missing = new Set(["website_briefing_uploads.kind", "website_briefings.media_thumbnail"]);
    const refused = await createUploadGrant({
      briefingId: "b1",
      paths: ["thumbnail.jpg"],
      actorId: ACTOR,
      kind: "images",
    });
    expect(refused).toMatchObject({
      ok: false,
      error: expect.stringContaining(PICTURES_MIGRATION),
    });
    expect(db.tables.website_briefing_uploads).toHaveLength(0);

    const grant = await createUploadGrant({ briefingId: "b1", paths: PACKAGE, actorId: ACTOR });
    if (!grant.ok) throw new Error(grant.error);
    const v1 = (path: string) => at("v1", path);
    bucket({
      [v1("master.m3u8")]: MASTER,
      [v1("v240/playlist.m3u8")]: VARIANT,
      [v1("v1080/playlist.m3u8")]: VARIANT,
      [v1("poster.jpg")]: "jpg",
      [v1("card.jpg")]: "jpg",
      [v1("fallback-720p.mp4")]: "mp4",
    });
    const done = await finalizeUpload({ uploadId: grant.uploadId, actorId: ACTOR });
    expect(done.ok).toBe(true);
    expect(db.tables.website_briefings[0]).toMatchObject({ media_version: "v1" });
  });

  it("a new video keeps the pictures uploaded on their own, and says so", async () => {
    Object.assign(db.tables.website_briefings[0], LIVE_MEDIA, {
      media_thumbnail: at("v2", "thumbnail.jpg"),
      media_poster: at("v2", "poster.jpg"),
    });
    db.tables.website_briefing_uploads.push({
      id: "u-v2",
      briefing_id: "b1",
      version: "v2",
      kind: "images",
      paths: ["thumbnail.jpg", "poster.jpg"],
      completed_at: "2026-10-29T00:00:00Z",
    });
    const grant = await createUploadGrant({ briefingId: "b1", paths: PACKAGE, actorId: ACTOR });
    if (!grant.ok) throw new Error(grant.error);
    expect(grant.version).toBe("v3");
    const v3 = (path: string) => at("v3", path);
    bucket({
      [v3("master.m3u8")]: MASTER,
      [v3("v240/playlist.m3u8")]: VARIANT,
      [v3("v1080/playlist.m3u8")]: VARIANT,
      [v3("poster.jpg")]: "jpg",
      [v3("card.jpg")]: "jpg",
      [v3("fallback-720p.mp4")]: "mp4",
    });
    const done = await finalizeUpload({ uploadId: grant.uploadId, actorId: ACTOR });
    expect(done).toMatchObject({ ok: true, kept: ["thumbnail", "poster"] });
    expect(db.tables.website_briefings[0]).toMatchObject({
      media_version: "v3",
      media_hls: v3("master.m3u8"),
      media_thumbnail: at("v2", "thumbnail.jpg"),
      media_poster: at("v2", "poster.jpg"),
      media_card: v3("card.jpg"),
    });
  });

  it("remove the thumbnail, or go back to the video's own poster once it answers", async () => {
    Object.assign(db.tables.website_briefings[0], LIVE_MEDIA, {
      media_thumbnail: at("v2", "thumbnail.jpg"),
      media_poster: at("v2", "poster.jpg"),
    });
    const removed = await resetBriefingPicture({ id: "b1", picture: "thumbnail", actorId: ACTOR });
    expect(removed).toMatchObject({ ok: true, path: null });
    expect(db.tables.website_briefings[0].media_thumbnail).toBeNull();

    // The seeded listings have no grant for their stream: the encoder's own name is used.
    bucket({});
    const gone = await resetBriefingPicture({ id: "b1", picture: "poster", actorId: ACTOR });
    expect(gone).toMatchObject({ ok: false, error: expect.stringMatching(/not in its folder/) });
    expect(db.tables.website_briefings[0].media_poster).toBe(at("v2", "poster.jpg"));

    bucket({ [at("v1", "poster.jpg")]: "jpg" });
    const back = await resetBriefingPicture({ id: "b1", picture: "poster", actorId: ACTOR });
    expect(back).toMatchObject({ ok: true, path: at("v1", "poster.jpg") });
    expect(db.tables.website_briefings[0].media_poster).toBe(at("v1", "poster.jpg"));
    expect(db.audit.filter((a) => a.action === "website_briefing.picture_reset")).toHaveLength(2);
  });

  it("the video's own card is the one its package held, or none", async () => {
    Object.assign(db.tables.website_briefings[0], LIVE_MEDIA, {
      media_card: at("v2", "card.jpg"),
    });
    db.tables.website_briefing_uploads.push({
      id: "u-v1",
      briefing_id: "b1",
      version: "v1",
      kind: "package",
      paths: ["master.m3u8", "poster.jpg"],
      completed_at: "2026-10-28T00:00:00Z",
    });
    const result = await resetBriefingPicture({ id: "b1", picture: "card", actorId: ACTOR });
    expect(result).toMatchObject({ ok: true, path: null });
    expect(db.tables.website_briefings[0].media_card).toBeNull();
  });

  it("a thumbnail alone fixes the slug and keeps a draft from being deleted", async () => {
    db.tables.website_briefings[0].media_thumbnail = at("v1", "thumbnail.jpg");
    const saved = await saveWebsiteBriefing({
      id: "b1",
      slug: "another-name",
      copy: {} as never,
      actorId: ACTOR,
    });
    expect(saved).toMatchObject({ ok: false, error: expect.stringMatching(/slug is fixed/) });
    expect(await deleteDraftWebsiteBriefing({ id: "b1", actorId: ACTOR })).toMatchObject({
      ok: false,
    });
    expect(db.tables.website_briefings).toHaveLength(1);
  });
});

describe("the library's order", () => {
  beforeEach(() => {
    db.tables.website_briefings = [
      briefing({ id: "a", slug: "a", ...LIVE_MEDIA, sort_order: 10 }),
      briefing({ id: "b", slug: "b", status: "draft", sort_order: 20 }),
      briefing({ id: "c", slug: "c", status: "premiere", sort_order: 30 }),
    ];
  });
  const order = () =>
    Object.fromEntries(db.tables.website_briefings.map((r) => [r.id, r.sort_order]));

  it("renumbers the listings, and rebuilds when the website's order changed", async () => {
    const result = await reorderWebsiteBriefings({ order: ["c", "a", "b"], actorId: ACTOR });
    expect(result).toMatchObject({ ok: true, rebuild: { reason: "not_configured" } });
    expect(order()).toEqual({ c: 10, a: 20, b: 30 });
    expect(db.audit.find((a) => a.action === "website_briefing.reordered")).toMatchObject({
      metadata: { live_before: ["a", "c"], live_after: ["c", "a"] },
    });
  });

  it("does not rebuild for a draft moving among live listings it is not shown with", async () => {
    const result = await reorderWebsiteBriefings({ order: ["b", "a", "c"], actorId: ACTOR });
    expect(result).toEqual({ ok: true, rebuild: null });
    expect(order()).toEqual({ b: 10, a: 20, c: 30 });
  });

  it("refuses an order that has lost or invented a listing, and writes nothing", async () => {
    const result = await reorderWebsiteBriefings({ order: ["a", "b"], actorId: ACTOR });
    expect(result.ok).toBe(false);
    expect(order()).toEqual({ a: 10, b: 20, c: 30 });
  });
});
