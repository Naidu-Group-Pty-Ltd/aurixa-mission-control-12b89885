/**
 * A function too large for the raw-source deploy, deployed as the CLI's own
 * compressed bundle instead.
 *
 * ## Why
 *
 * `deployEdgeFunction` posts a function's source to the Management API's
 * `/functions/deploy`, which bundles it on Supabase's side. Two of the prime's
 * functions outgrew that route and have reached no clone since:
 *
 *   ai-dashboard-agent          8.2 MB  413 "request entity too large"   from 20 Oct 2026
 *   generate-investment-report  4.8 MB  "exceeds the maximum deployment  from 21 Oct 2026
 *                                        size (5 MB)"
 *
 * 159 runs of the redeploy lane failed on them before anyone looked. The
 * prime deploys both without trouble, because its own workflow runs the CLI,
 * and the CLI bundles locally in the edge-runtime container, compresses the
 * eszip with brotli behind an `EZBR` header and uploads THAT, through the
 * function create and update calls, under a 20 MB limit. The two compress to
 * about 1.8 MB and 1.3 MB.
 *
 * This deployment runs on Cloudflare Workers, where no container runs, so the
 * bundle is built on the prime: `edge-function-bundles.yml`, dispatched here,
 * runs the CLI the prime's deploys install against a stand-in API that keeps
 * what it uploads, and publishes the bundle and a manifest as a run artifact.
 *
 * ## The rule that makes a bundle safe to send: the bytes, not the run
 *
 * The manifest names the git blob id of every file the function's entry point
 * loads, as the prime's `deploy-scope.mjs` proves that set (a static closure
 * that over-approximates: comments and type imports count, a computed import
 * refuses). The bundle may be sent in place of a raw deploy only where every
 * file it names that this deploy carries has the same blob id here, and the
 * entry point is one of them.
 *
 * That is enough, by induction from the entry point: the entry point is the
 * same file, so it imports the same modules; each of those is in what this
 * deploy carries (`pruneBundleToReachable` also over-approximates the graph),
 * so it was compared, and is the same file too; and so on. The graph the
 * bundle was built from is the graph this deploy would have sent. A file the
 * manifest names that this deploy does not carry is one nothing loads, and is
 * not compared. Configuration the CLI reads beside a function (a `deno.json`,
 * an import map) is not imported, so it must be carried and equal.
 *
 * So a bundle built at one commit is good for a later one that changed nothing
 * the function loads, and never for one that did. Which run built it, and
 * when, decides nothing.
 *
 * Pure: no network, no clock of its own. The reads and the dispatch are
 * `compressedEdgeBundle.server.ts`; the upload is `deployEdgeFunction`.
 */
import { createHash } from "node:crypto";

/** The prime workflow that builds bundles, and the artifact each run publishes. */
export const BUNDLE_WORKFLOW_FILE = "edge-function-bundles.yml";
export const BUNDLE_ARTIFACT_NAME = "edge-function-bundles";

/** What the CLI prefixes to a brotli-compressed eszip, and the type it sends one as. */
export const COMPRESSED_ESZIP_MAGIC = "EZBR";
export const ESZIP_CONTENT_TYPE = "application/vnd.denoland.eszip";

/** The manifest shape this reader knows; a later one is refused, never guessed at. */
export const BUNDLE_MANIFEST_SCHEMA = 1;

/**
 * Above this many bytes of source, a function goes straight to the compressed
 * route rather than trying the raw one first.
 *
 * The raw route's real limit is the API's, and it is not stated as a source
 * size: 4,552,526 bytes of `generate-investment-report` deployed, and
 * 4,700,141 bytes of it (PR #3347) were refused as "exceeds the maximum
 * deployment size (5 MB)", which is the size AFTER Supabase bundles it. So
 * this is set below the last size seen to pass, and a smaller bundle that is
 * refused for its size anyway takes the compressed route too
 * (`isRawSizeRefusal`).
 */
export const RAW_DEPLOY_CEILING_BYTES = 4_000_000;

/** The create and update calls refuse a compressed bundle above this. */
export const COMPRESSED_UPLOAD_LIMIT_BYTES = 20_000_000;

/**
 * How long a build request waits before it is made again, after a build that
 * failed or one that finished without a bundle this deploy could use. A
 * redeploy pass runs every minute or two and the build takes a few, so
 * without it every pass would dispatch another.
 */
export const BUILD_REQUEST_COOLDOWN_MS = 15 * 60_000;

/** A run still building is waited on for at most this long, then asked past. */
export const BUILD_RUN_PATIENCE_MS = 60 * 60_000;

const FUNCTIONS_PREFIX = "supabase/functions/";
const CONFIG_BASENAMES = new Set(["deno.json", "deno.jsonc", "import_map.json"]);

export type BundleManifest = {
  schema: number;
  slug: string;
  commit: string;
  upload: {
    entrypoint_path: string;
    import_map_path: string | null;
    ezbr_sha256: string;
    bytes: number;
  };
  /** Repository path → git blob id. */
  files: Record<string, string>;
};

/** What `deployEdgeFunction` is given: paths relative to `supabase/functions/`. */
export type DeployableFunction = {
  slug: string;
  entrypointPath: string;
  importMapPath: string | null;
  files: ReadonlyArray<{ path: string; contentBase64: string }>;
};

/** The bytes a bundle would send, read from its base64 without decoding it. */
export function rawBundleBytes(files: ReadonlyArray<{ contentBase64: string }>): number {
  let n = 0;
  for (const f of files) {
    const b64 = f.contentBase64;
    const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    n += Math.floor((b64.length * 3) / 4) - pad;
  }
  return n;
}

/** A raw deploy the API refused for its size, as it says so on the wire. */
export function isRawSizeRefusal(message: string): boolean {
  return /\b413\b|request entity too large|maximum deployment size/i.test(message);
}

/** The id git gives a file's bytes. */
export function gitBlobId(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The manifest, or why it is not one this reader can trust. */
export function parseBundleManifest(
  raw: unknown,
): { ok: true; manifest: BundleManifest } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (!raw || typeof raw !== "object") return bad("the manifest is not an object");
  const m = raw as Record<string, unknown>;
  if (m.schema !== BUNDLE_MANIFEST_SCHEMA) {
    return bad(
      `the manifest is schema ${String(m.schema)}, and this reads ${BUNDLE_MANIFEST_SCHEMA}`,
    );
  }
  if (typeof m.slug !== "string" || typeof m.commit !== "string") {
    return bad("the manifest names no function or commit");
  }
  const u = m.upload as Record<string, unknown> | undefined;
  if (
    !u ||
    typeof u.entrypoint_path !== "string" ||
    typeof u.ezbr_sha256 !== "string" ||
    typeof u.bytes !== "number" ||
    !(u.import_map_path === null || typeof u.import_map_path === "string")
  ) {
    return bad("the manifest does not say what was uploaded");
  }
  const files = m.files as Record<string, unknown> | undefined;
  if (!files || typeof files !== "object" || Object.keys(files).length === 0) {
    return bad("the manifest names no source files");
  }
  for (const [path, id] of Object.entries(files)) {
    if (typeof id !== "string" || !/^[0-9a-f]{40}$/.test(id)) {
      return bad(`the manifest gives ${path} no blob id`);
    }
  }
  return {
    ok: true,
    manifest: {
      schema: m.schema as number,
      slug: m.slug,
      commit: m.commit,
      upload: {
        entrypoint_path: u.entrypoint_path,
        import_map_path: (u.import_map_path as string | null) ?? null,
        ezbr_sha256: u.ezbr_sha256,
        bytes: u.bytes,
      },
      files: files as Record<string, string>,
    },
  };
}

export type BundleJudgement =
  | { ok: true }
  /** `stale`: a real bundle, built from source this deploy no longer sends. */
  | { ok: false; stale: boolean; reason: string };

/**
 * Whether this bundle may be sent in place of `fn`'s raw source. See the
 * header for why comparing the files the manifest names is enough.
 */
export function judgeBundle(input: {
  manifest: BundleManifest;
  ezbr: Uint8Array;
  fn: DeployableFunction;
}): BundleJudgement {
  const { manifest, ezbr, fn } = input;
  const refuse = (reason: string) => ({ ok: false as const, stale: false, reason });
  if (manifest.slug !== fn.slug) return refuse(`the bundle is ${manifest.slug}'s`);

  const magic = new TextDecoder("latin1").decode(ezbr.subarray(0, COMPRESSED_ESZIP_MAGIC.length));
  if (magic !== COMPRESSED_ESZIP_MAGIC) return refuse("the bundle is not a compressed eszip");
  if (ezbr.length !== manifest.upload.bytes || sha256Hex(ezbr) !== manifest.upload.ezbr_sha256) {
    return refuse("the bundle is not the one its manifest describes");
  }
  if (ezbr.length > COMPRESSED_UPLOAD_LIMIT_BYTES) {
    return refuse(
      `the bundle is ${ezbr.length} bytes, over the ${COMPRESSED_UPLOAD_LIMIT_BYTES}-byte limit of a compressed upload`,
    );
  }
  const entry = `${FUNCTIONS_PREFIX}${fn.entrypointPath}`;
  if (
    !manifest.upload.entrypoint_path.startsWith("file:///") ||
    !decodeURIComponent(manifest.upload.entrypoint_path).endsWith(`/${entry}`)
  ) {
    return refuse(`the bundle's entry point is not ${entry}`);
  }
  if (!(entry in manifest.files)) return refuse(`the manifest does not name ${entry}`);
  if (fn.importMapPath && !(`${FUNCTIONS_PREFIX}${fn.importMapPath}` in manifest.files)) {
    return refuse(`the manifest does not name the import map ${fn.importMapPath}`);
  }

  const carried = new Map(fn.files.map((f) => [f.path, f.contentBase64]));
  for (const [path, id] of Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.startsWith(FUNCTIONS_PREFIX)) {
      return refuse(`the manifest names ${path}, outside ${FUNCTIONS_PREFIX}`);
    }
    const rel = path.slice(FUNCTIONS_PREFIX.length);
    const content = carried.get(rel);
    if (content === undefined) {
      const base = rel.slice(rel.lastIndexOf("/") + 1);
      if (CONFIG_BASENAMES.has(base)) {
        return refuse(`the bundle was built with ${path}, which this deploy does not carry`);
      }
      continue; // loaded by nothing this deploy sends: see the header
    }
    if (gitBlobId(Buffer.from(content, "base64")) !== id) {
      return { ok: false, stale: true, reason: `${path} has changed since the bundle was built` };
    }
  }
  return { ok: true };
}

/**
 * The create or update call that uploads a bundle: the one the CLI makes,
 * with the flag this deployment decides (`deployedVerifyJwt`), never the one
 * the bundle was built with.
 */
export function compressedUploadRequest(input: {
  projectRef: string;
  slug: string;
  verifyJwt: boolean;
  manifest: BundleManifest;
  exists: boolean;
}): { method: "PATCH" | "POST"; path: string } {
  const { projectRef, slug, verifyJwt, manifest, exists } = input;
  const query = new URLSearchParams();
  if (!exists) {
    query.set("slug", slug);
    query.set("name", slug);
  }
  query.set("verify_jwt", String(verifyJwt));
  query.set("entrypoint_path", manifest.upload.entrypoint_path);
  if (manifest.upload.import_map_path)
    query.set("import_map_path", manifest.upload.import_map_path);
  query.set("ezbr_sha256", manifest.upload.ezbr_sha256);
  return exists
    ? {
        method: "PATCH",
        path: `/projects/${projectRef}/functions/${encodeURIComponent(slug)}?${query}`,
      }
    : { method: "POST", path: `/projects/${projectRef}/functions?${query}` };
}

export type BundleRun = {
  id: number;
  status: string | null;
  conclusion: string | null;
  createdAt: string;
  htmlUrl: string;
  /** The run's title: the workflow names the functions a dispatch asked for in it. */
  title: string;
};

const RUNNING = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

/** The functions a dispatch asked for, read back from the title the workflow gives its run. */
export function functionsAskedOf(run: Pick<BundleRun, "title">): string[] {
  const at = run.title.indexOf(":");
  return at === -1
    ? []
    : run.title
        .slice(at + 1)
        .split(/\s+/)
        .filter(Boolean);
}

/**
 * Whether to ask the prime to build `slug`'s bundle now, given its recent runs
 * of the workflow (dispatches on the prime's branch, newest first).
 *
 * One build at a time: a run still building is waited on, whichever functions
 * it was asked for, because the workflow's own concurrency group would queue a
 * second behind it anyway. A run that built this function and finished within
 * the cooldown is not followed by another until the cooldown passes: if it
 * failed, a person needs to look, and if it succeeded and this deploy still
 * has no bundle it can use, the prime moved on under it and a few minutes'
 * wait costs nothing. A run for other functions holds nothing back.
 */
export function planBuildRequest(input: {
  runs: readonly BundleRun[];
  slug: string;
  nowMs: number;
}): { dispatch: true } | { dispatch: false; why: string } {
  const { runs, slug, nowMs } = input;
  const age = (r: BundleRun) => nowMs - Date.parse(r.createdAt);
  const building = runs.find((r) => RUNNING.has(r.status ?? "") && age(r) < BUILD_RUN_PATIENCE_MS);
  if (building) return { dispatch: false, why: `a build is running (${building.htmlUrl})` };
  const last = runs.find((r) => r.status === "completed" && functionsAskedOf(r).includes(slug));
  if (last && age(last) < BUILD_REQUEST_COOLDOWN_MS) {
    const again = new Date(Date.parse(last.createdAt) + BUILD_REQUEST_COOLDOWN_MS).toISOString();
    return last.conclusion === "success"
      ? {
          dispatch: false,
          why: `the last build (${last.htmlUrl}) has no bundle for this source; another is asked for after ${again}`,
        }
      : {
          dispatch: false,
          why: `the last build failed (${last.htmlUrl}); another is asked for after ${again}`,
        };
  }
  return { dispatch: true };
}
