import { describe, expect, it } from "vitest";
import {
  BUILD_REQUEST_COOLDOWN_MS,
  BUILD_RUN_PATIENCE_MS,
  COMPRESSED_UPLOAD_LIMIT_BYTES,
  compressedUploadRequest,
  functionsAskedOf,
  gitBlobId,
  isRawSizeRefusal,
  judgeBundle,
  parseBundleManifest,
  planBuildRequest,
  rawBundleBytes,
  sha256Hex,
  type BundleManifest,
  type BundleRun,
  type DeployableFunction,
  OPEN_IMPORTS,
} from "./compressedEdgeBundle.pure";
import { pruneBundleToReachable } from "./functionBundlePrune.pure";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const blob = (text: string) => gitBlobId(Buffer.from(text));
const ezbrOf = (text: string) =>
  new Uint8Array(Buffer.concat([Buffer.from("EZBR"), Buffer.from(text)]));

const SOURCES = {
  "big-fn/index.ts": 'import "../_shared/a.ts";\nserve();',
  "_shared/a.ts": 'import "./b.ts";',
  "_shared/b.ts": "export const b = 1;",
};

/** What a deploy of `big-fn` carries, pruned as `pruneBundleToReachable` would. */
function fnWith(overrides: Partial<Record<string, string>> = {}): DeployableFunction {
  const files = { ...SOURCES, ...overrides } as Record<string, string | undefined>;
  return {
    slug: "big-fn",
    entrypointPath: "big-fn/index.ts",
    importMapPath: null,
    files: Object.entries(files)
      .filter((e): e is [string, string] => e[1] !== undefined)
      .map(([path, text]) => ({ path, contentBase64: b64(text) })),
    // What `pruneBundleToReachable` says of this tree, never assumed.
    importsClosed: pruneBundleToReachable({
      entrypointPath: "big-fn/index.ts",
      files: Object.keys(files)
        .filter((p) => files[p] !== undefined)
        .map((path) => ({ path })),
      importMapPath: null,
      textOf: (path) => files[path] ?? null,
    }).pruned,
  };
}

/** The manifest the prime's workflow writes for the same sources. */
function manifestFor(ezbr: Uint8Array, extra: Record<string, string> = {}): BundleManifest {
  return {
    schema: 1,
    slug: "big-fn",
    commit: "c0ffee",
    upload: {
      entrypoint_path: "file:///home/runner/work/p/p/supabase/functions/big-fn/index.ts",
      import_map_path: null,
      ezbr_sha256: sha256Hex(ezbr),
      bytes: ezbr.length,
    },
    files: {
      ...Object.fromEntries(
        Object.entries(SOURCES).map(([p, t]) => [`supabase/functions/${p}`, blob(t)]),
      ),
      ...extra,
    },
  };
}

describe("what goes to the compressed route", () => {
  it("counts the bytes a bundle would send without decoding it", () => {
    expect(
      rawBundleBytes([
        { contentBase64: b64("") },
        { contentBase64: b64("a") },
        { contentBase64: b64("ab") },
        { contentBase64: b64("abc") },
      ]),
    ).toBe(6);
  });

  it("reads a refusal for size the way the API words it on the wire", () => {
    expect(
      isRawSizeRefusal(
        'Deploy failed for ai-dashboard-agent: 413 — {"message":"request entity too large"}',
      ),
    ).toBe(true);
    expect(
      isRawSizeRefusal(
        'Deploy failed for generate-investment-report: 400 — {"message":"Function generate-investment-report exceeds the maximum deployment size (5 MB)"}',
      ),
    ).toBe(true);
    expect(isRawSizeRefusal('Deploy failed for x: 500 — {"message":"internal error"}')).toBe(false);
    expect(isRawSizeRefusal("Deploy failed for x: 4130 — boot error")).toBe(false);
  });

  it("computes the id git gives a file", () => {
    expect(gitBlobId(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(gitBlobId(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("parseBundleManifest", () => {
  it("takes the manifest the prime writes", () => {
    const m = manifestFor(ezbrOf("x"));
    expect(parseBundleManifest(JSON.parse(JSON.stringify(m)))).toEqual({ ok: true, manifest: m });
  });

  it("refuses a schema it does not know, and anything incomplete", () => {
    const m = manifestFor(ezbrOf("x"));
    expect(parseBundleManifest({ ...m, schema: 2 })).toEqual({
      ok: false,
      reason: "the manifest is schema 2, and this reads 1",
    });
    expect(parseBundleManifest({ ...m, files: {} }).ok).toBe(false);
    expect(
      parseBundleManifest({ ...m, files: { "supabase/functions/x.ts": "not-an-id" } }).ok,
    ).toBe(false);
    expect(parseBundleManifest({ ...m, upload: { ...m.upload, ezbr_sha256: undefined } }).ok).toBe(
      false,
    );
    expect(parseBundleManifest(null).ok).toBe(false);
  });
});

describe("judgeBundle: a bundle is sent only where it was built from these bytes", () => {
  const ezbr = ezbrOf("bundle");

  it("refuses where this deploy imports a module the tree no longer holds", () => {
    // Codex on #360: `_shared/b.ts` deleted while `a.ts` still imports it. The
    // pruner cannot close the walk and carries every file that exists, so the
    // deleted one is simply absent, and the old bundle that still holds it
    // would otherwise pass every comparison.
    const deleted = fnWith({ "_shared/b.ts": undefined });
    expect(deleted.importsClosed).toBe(false);
    expect(judgeBundle({ manifest: manifestFor(ezbr), ezbr, fn: deleted })).toEqual({
      ok: false,
      stale: false,
      reason: OPEN_IMPORTS,
    });
  });

  it("refuses where nothing says whether the deploy's imports closed", () => {
    const unknown = { ...fnWith(), importsClosed: undefined };
    expect(judgeBundle({ manifest: manifestFor(ezbr), ezbr, fn: unknown })).toMatchObject({
      ok: false,
      stale: false,
    });
  });

  it("accepts a bundle built from exactly what this deploy carries", () => {
    expect(fnWith().importsClosed).toBe(true);
    expect(judgeBundle({ manifest: manifestFor(ezbr), ezbr, fn: fnWith() })).toEqual({ ok: true });
  });

  it("is out of date where a file the function loads has changed", () => {
    const r = judgeBundle({
      manifest: manifestFor(ezbr),
      ezbr,
      fn: fnWith({ "_shared/b.ts": "export const b = 2;" }),
    });
    expect(r).toEqual({
      ok: false,
      stale: true,
      reason: "supabase/functions/_shared/b.ts has changed since the bundle was built",
    });
  });

  it("is still good for a later commit that changed nothing the function loads", () => {
    // A shared file this function does not import, changed: the deploy does
    // not carry it, and the manifest's file it does not carry is not compared.
    const manifest = manifestFor(ezbr, { "supabase/functions/_shared/unrelated.ts": blob("old") });
    expect(judgeBundle({ manifest, ezbr, fn: fnWith() })).toEqual({ ok: true });
  });

  it("refuses configuration it was built with that this deploy does not carry", () => {
    const manifest = manifestFor(ezbr, { "supabase/functions/big-fn/deno.json": blob("{}") });
    const r = judgeBundle({ manifest, ezbr, fn: fnWith() });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.stale).toBe(false);
    expect(manifest.files).toHaveProperty(["supabase/functions/big-fn/deno.json"]);
    expect(judgeBundle({ manifest, ezbr, fn: fnWith({ "big-fn/deno.json": "{}" }) })).toEqual({
      ok: true,
    });
  });

  it("refuses a bundle that is not the one described, or not a bundle at all", () => {
    const manifest = manifestFor(ezbr);
    expect(judgeBundle({ manifest, ezbr: ezbrOf("other"), fn: fnWith() })).toMatchObject({
      ok: false,
      stale: false,
    });
    const plain = new Uint8Array(Buffer.from("ESZIP2.3"));
    expect(judgeBundle({ manifest: manifestFor(plain), ezbr: plain, fn: fnWith() })).toEqual({
      ok: false,
      stale: false,
      reason: "the bundle is not a compressed eszip",
    });
  });

  it("refuses another function's bundle, or one whose entry point is not this function's", () => {
    expect(
      judgeBundle({ manifest: { ...manifestFor(ezbr), slug: "other-fn" }, ezbr, fn: fnWith() }),
    ).toMatchObject({ ok: false });
    const elsewhere = manifestFor(ezbr);
    elsewhere.upload.entrypoint_path = "file:///w/supabase/functions/other-fn/index.ts";
    expect(judgeBundle({ manifest: elsewhere, ezbr, fn: fnWith() })).toEqual({
      ok: false,
      stale: false,
      reason: "the bundle's entry point is not supabase/functions/big-fn/index.ts",
    });
    const noEntry = manifestFor(ezbr);
    delete noEntry.files["supabase/functions/big-fn/index.ts"];
    expect(judgeBundle({ manifest: noEntry, ezbr, fn: fnWith() })).toMatchObject({
      ok: false,
      stale: false,
    });
  });

  it("refuses a manifest that names a file outside the functions tree", () => {
    const manifest = manifestFor(ezbr, { "src/lib/x.ts": blob("x") });
    expect(judgeBundle({ manifest, ezbr, fn: fnWith() })).toEqual({
      ok: false,
      stale: false,
      reason: "the manifest names src/lib/x.ts, outside supabase/functions/",
    });
  });

  it("refuses a bundle over the compressed upload's limit", () => {
    const huge = new Uint8Array(COMPRESSED_UPLOAD_LIMIT_BYTES + 1);
    huge.set(Buffer.from("EZBR"));
    expect(judgeBundle({ manifest: manifestFor(huge), ezbr: huge, fn: fnWith() })).toMatchObject({
      ok: false,
      stale: false,
    });
  });
});

describe("compressedUploadRequest: the call the CLI makes", () => {
  const manifest = manifestFor(ezbrOf("x"));

  it("updates a function the project holds, with this deployment's flag", () => {
    const r = compressedUploadRequest({
      projectRef: "abcdefghijklmnopqrst",
      slug: "big-fn",
      verifyJwt: false,
      manifest,
      exists: true,
    });
    expect(r.method).toBe("PATCH");
    const url = new URL(`https://api.supabase.com/v1${r.path}`);
    expect(url.pathname).toBe("/v1/projects/abcdefghijklmnopqrst/functions/big-fn");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      verify_jwt: "false",
      entrypoint_path: manifest.upload.entrypoint_path,
      ezbr_sha256: manifest.upload.ezbr_sha256,
    });
  });

  it("creates one it does not, named by its slug", () => {
    const r = compressedUploadRequest({
      projectRef: "abcdefghijklmnopqrst",
      slug: "big-fn",
      verifyJwt: true,
      manifest,
      exists: false,
    });
    expect(r.method).toBe("POST");
    const url = new URL(`https://api.supabase.com/v1${r.path}`);
    expect(url.pathname).toBe("/v1/projects/abcdefghijklmnopqrst/functions");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      slug: "big-fn",
      name: "big-fn",
      verify_jwt: "true",
    });
  });
});

describe("planBuildRequest: one build at a time, and not again at once", () => {
  const now = Date.parse("2026-10-26T10:00:00Z");
  const run = (over: Partial<BundleRun>): BundleRun => ({
    id: 1,
    status: "completed",
    conclusion: "success",
    createdAt: new Date(now - 60 * 60_000).toISOString(),
    htmlUrl: "https://github.com/o/r/actions/runs/1",
    title: "Edge function bundles: big-fn",
    ...over,
  });

  it("reads which functions a dispatch asked for from its title", () => {
    expect(functionsAskedOf(run({ title: "Edge function bundles: a b" }))).toEqual(["a", "b"]);
    expect(functionsAskedOf(run({ title: "Edge function bundles" }))).toEqual([]);
  });

  it("asks when nothing is building and nothing recent built it", () => {
    expect(planBuildRequest({ runs: [], slug: "big-fn", nowMs: now })).toEqual({ dispatch: true });
    expect(planBuildRequest({ runs: [run({})], slug: "big-fn", nowMs: now })).toEqual({
      dispatch: true,
    });
  });

  it("waits on a run still building, whatever it was asked for", () => {
    const r = planBuildRequest({
      runs: [
        run({
          status: "in_progress",
          conclusion: null,
          createdAt: new Date(now - 60_000).toISOString(),
          title: "Edge function bundles: other",
        }),
      ],
      slug: "big-fn",
      nowMs: now,
    });
    expect(r).toEqual({
      dispatch: false,
      why: "a build is running (https://github.com/o/r/actions/runs/1)",
    });
  });

  it("asks past a run that has been building longer than it could", () => {
    const stuck = run({
      status: "queued",
      conclusion: null,
      createdAt: new Date(now - BUILD_RUN_PATIENCE_MS - 1).toISOString(),
    });
    expect(planBuildRequest({ runs: [stuck], slug: "big-fn", nowMs: now })).toEqual({
      dispatch: true,
    });
  });

  it("does not ask again within the cooldown after a build of this function, failed or not", () => {
    const recent = new Date(now - 60_000).toISOString();
    const failed = planBuildRequest({
      runs: [run({ conclusion: "failure", createdAt: recent })],
      slug: "big-fn",
      nowMs: now,
    });
    expect(failed.dispatch).toBe(false);
    expect(failed.dispatch === false && failed.why).toMatch(/^the last build failed/);
    const built = planBuildRequest({
      runs: [run({ createdAt: recent })],
      slug: "big-fn",
      nowMs: now,
    });
    expect(built.dispatch === false && built.why).toMatch(/has no bundle for this source/);
    const later = new Date(now - BUILD_REQUEST_COOLDOWN_MS - 1).toISOString();
    expect(
      planBuildRequest({
        runs: [run({ conclusion: "failure", createdAt: later })],
        slug: "big-fn",
        nowMs: now,
      }),
    ).toEqual({ dispatch: true });
  });

  it("is not held back by a recent build of another function", () => {
    const other = run({
      createdAt: new Date(now - 60_000).toISOString(),
      title: "Edge function bundles: other-fn",
    });
    expect(planBuildRequest({ runs: [other], slug: "big-fn", nowMs: now })).toEqual({
      dispatch: true,
    });
  });
});
