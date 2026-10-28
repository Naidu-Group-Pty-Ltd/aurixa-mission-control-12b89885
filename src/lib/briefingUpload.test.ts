import { describe, expect, it } from "vitest";
import { isHiddenFile, relativePathOf, uploadPackage } from "./briefingUpload";

const PACKAGE = [
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

function files(paths = PACKAGE) {
  return new Map(paths.map((p) => [p, new Blob([p]) as Blob]));
}

type Call = { url: string; method: string; headers: Record<string, string> };

function fakeWebsite(
  options: { exists?: string[]; failOnce?: string[]; failAlways?: string[] } = {},
) {
  const calls: Call[] = [];
  const flaky = new Set(options.failOnce ?? []);
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method ?? "GET", headers });
    if (url === "https://signer.test") {
      const { paths } = JSON.parse(String(init.body)) as { paths: string[] };
      return new Response(
        JSON.stringify({
          ok: true,
          prefix: "videos/x/v2/",
          uploads: paths.map((path) =>
            options.exists?.includes(path)
              ? { path, exists: true }
              : { path, url: `https://put.test/${path}` },
          ),
        }),
        { status: 200 },
      );
    }
    const path = url.replace("https://put.test/", "");
    if (options.failAlways?.includes(path)) return new Response("boom", { status: 500 });
    if (flaky.has(path)) {
      flaky.delete(path);
      return new Response("boom", { status: 503 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const grant = { token: "t".repeat(43), signerUrl: "https://signer.test" };

describe("uploadPackage", () => {
  it("puts every file, with its type and cache header, and the master playlist last", async () => {
    const site = fakeWebsite();
    const outcome = await uploadPackage({
      files: files(),
      grant,
      fetchImpl: site.fetchImpl,
      retryDelayMs: 0,
    });
    expect(outcome).toEqual({ ok: true, uploaded: PACKAGE.length, skipped: 0 });
    const puts = site.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(PACKAGE.length);
    expect(puts.at(-1)?.url).toBe("https://put.test/master.m3u8");
    const playlistIndex = puts.findIndex((c) => c.url.endsWith("v240/playlist.m3u8"));
    const segmentIndex = puts.findIndex((c) => c.url.endsWith("v240/seg-00000.m4s"));
    expect(segmentIndex).toBeLessThan(playlistIndex);
    const segment = puts.find((c) => c.url.endsWith(".m4s"))!;
    expect(segment.headers["content-type"]).toBe("video/iso.segment");
    expect(segment.headers["cache-control"]).toMatch(/immutable/);
    expect(segment.headers["x-upsert"]).toBe("false");
  });

  it("skips files an earlier attempt already uploaded", async () => {
    const site = fakeWebsite({ exists: ["v240/seg-00000.m4s", "poster.jpg"] });
    const outcome = await uploadPackage({
      files: files(),
      grant,
      fetchImpl: site.fetchImpl,
      retryDelayMs: 0,
    });
    expect(outcome).toEqual({ ok: true, uploaded: PACKAGE.length - 2, skipped: 2 });
  });

  it("retries a flaky file and carries on", async () => {
    const site = fakeWebsite({ failOnce: ["v240/init.mp4"] });
    const outcome = await uploadPackage({
      files: files(),
      grant,
      fetchImpl: site.fetchImpl,
      retryDelayMs: 0,
    });
    expect(outcome.ok).toBe(true);
  });

  it("stops before the playlists when media did not land", async () => {
    const site = fakeWebsite({ failAlways: ["v240/seg-00000.m4s"] });
    const outcome = await uploadPackage({
      files: files(),
      grant,
      fetchImpl: site.fetchImpl,
      retryDelayMs: 0,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failed).toEqual([{ path: "v240/seg-00000.m4s", reason: "HTTP 500" }]);
    const puts = site.calls.filter((c) => c.method === "PUT").map((c) => c.url);
    expect(puts.some((u) => u.endsWith(".m3u8"))).toBe(false);
  });

  it("refuses a folder that is not a package without contacting the website", async () => {
    const site = fakeWebsite();
    const outcome = await uploadPackage({
      files: files(["notes.txt"]),
      grant,
      fetchImpl: site.fetchImpl,
      retryDelayMs: 0,
    });
    expect(outcome.ok).toBe(false);
    expect(site.calls).toHaveLength(0);
  });
});

describe("folder picking", () => {
  it("strips the folder's own name from picked paths", () => {
    expect(
      relativePathOf({
        name: "seg-00000.m4s",
        webkitRelativePath: "borrowing-capacity/v240/seg-00000.m4s",
      }),
    ).toBe("v240/seg-00000.m4s");
    expect(
      relativePathOf({ name: "poster.jpg", webkitRelativePath: "borrowing-capacity/poster.jpg" }),
    ).toBe("poster.jpg");
    expect(relativePathOf({ name: "poster.jpg" })).toBe("poster.jpg");
  });
  it("ignores desktop clutter", () => {
    expect(isHiddenFile(".DS_Store")).toBe(true);
    expect(isHiddenFile("v240/._seg.m4s")).toBe(true);
    expect(isHiddenFile("v240/seg-00000.m4s")).toBe(false);
  });
});
