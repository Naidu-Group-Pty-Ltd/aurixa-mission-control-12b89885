// Server-only helper that mints an installation-scoped Octokit client
// for the Aurixa GitHub App. Cached per installation for the life of the
// Worker isolate to avoid re-signing JWTs on every call.
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import forge from "node-forge";
import { withRetry, isTransientHttpError } from "@/lib/with-retry";

const cache = new Map<string, Octokit>();

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Normalize and, if necessary, convert a PEM private key to PKCS#8 format.
 * GitHub's API (via @octokit/auth-app / universal-github-app-jwt) only
 * accepts PKCS#8 (`BEGIN PRIVATE KEY`). Keys downloaded from GitHub App
 * settings are PKCS#1 (`BEGIN RSA PRIVATE KEY`), so we auto-convert.
 */
function normalizePemWhitespace(pem: string): string {
  let p = pem.replace(/\\n/g, "\n").trim();
  // Some secret stores flatten newlines to spaces. If the PEM has no real
  // newlines but does contain BEGIN/END markers, rebuild it: extract the
  // base64 body between the markers and re-wrap at 64 chars per line.
  if (!p.includes("\n")) {
    const m = p.match(/-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]+?)-----END \1-----/);
    if (m) {
      const label = m[1].trim();
      const body = m[2].replace(/\s+/g, "");
      const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
      p = `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
    }
  }
  return p;
}

function ensurePkcs8(pem: string): string {
  const normalized = normalizePemWhitespace(pem);

  // Already PKCS#8 — nothing to do
  if (normalized.includes("-----BEGIN PRIVATE KEY-----")) {
    return normalized;
  }

  // PKCS#1 → PKCS#8 conversion using node-forge
  if (normalized.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    try {
      const privateKey = forge.pki.privateKeyFromPem(normalized);
      const asn1 = forge.pki.privateKeyToAsn1(privateKey);
      const wrapped = forge.pki.wrapRsaPrivateKey(asn1);
      const pkcs8Pem = forge.pki.privateKeyInfoToPem(wrapped);
      console.log("[github-app] Auto-converted private key from PKCS#1 to PKCS#8");
      return pkcs8Pem.trim();
    } catch (e) {
      throw new Error(
        `Failed to convert PKCS#1 private key to PKCS#8: ${e instanceof Error ? e.message : String(e)}. ` +
          `Use the PEM Key Helper on the auth page to convert manually, or run: ` +
          `openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out converted.pem`,
      );
    }
  }

  // Unknown format — pass through and let the auth library report the error
  return normalized;
}

/**
 * Returns an Octokit client authenticated as a specific installation of the
 * Aurixa GitHub App. If installationId is omitted, falls back to the default
 * installation configured via GITHUB_APP_INSTALLATION_ID.
 */
export function getAppOctokit(installationId?: string | number): Octokit {
  const appId = readEnv("GITHUB_APP_ID");
  const privateKey = ensurePkcs8(readEnv("GITHUB_APP_PRIVATE_KEY"));
  const installation = String(installationId ?? readEnv("GITHUB_APP_INSTALLATION_ID"));
  const cacheKey = `${appId}:${installation}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId: Number(installation),
    },
    request: {
      retries: 0, // we handle retry via withRetry hook below
    },
  });
  // Wrap every request in withRetry for transient 429/5xx/network errors.
  octokit.hook.wrap("request", async (request, options) => {
    return withRetry(async () => request(options), {
      attempts: 3,
      baseMs: 400,
      shouldRetry: (err) => isTransientHttpError(err),
      onRetry: (err, attempt, delay) => {
        const status = (err as { status?: number })?.status;
        console.warn(
          `[github] retry ${attempt} after ${Math.round(delay)}ms (status=${status ?? "?"})`,
        );
      },
    });
  });
  cache.set(cacheKey, octokit);
  return octokit;
}

/** Clear cached Octokit instances (e.g. after secret rotation). */
export function clearAppOctokitCache() {
  cache.clear();
}

export type RepoRef = {
  owner: string;
  repo: string;
  branch: string;
};

/** Convert a list of glob patterns into a deterministic file list by walking
 *  the repo tree at a given ref. Supports `*` and `**` globs.
 */
export async function listFilesMatchingGlobs(
  octokit: Octokit,
  ref: RepoRef,
  globs: string[],
): Promise<string[]> {
  if (globs.length === 0) return [];
  // Defence in depth: even if a caller forgets to run validateModuleGlobs,
  // never build a matcher for a pattern that could escape the module scope.
  const { validateModuleGlobs, isSafeRepoPath, globToRegex } = await import("@/lib/module-globs");
  const { valid, invalid } = validateModuleGlobs(globs);
  if (invalid.length > 0) {
    console.warn(
      `[github-app] rejected ${invalid.length} unsafe glob(s):`,
      invalid.map((i) => `${i.glob} (${i.reason})`).join(", "),
    );
  }
  if (valid.length === 0) return [];
  // Get the commit SHA of the branch
  const { data: branch } = await octokit.repos.getBranch({
    owner: ref.owner,
    repo: ref.repo,
    branch: ref.branch,
  });
  const treeSha = branch.commit.commit.tree.sha;
  const { data: tree } = await octokit.git.getTree({
    owner: ref.owner,
    repo: ref.repo,
    tree_sha: treeSha,
    recursive: "true",
  });
  const matchers = valid.map(globToRegex);
  return (tree.tree ?? [])
    .filter((n) => n.type === "blob" && typeof n.path === "string")
    .map((n) => n.path as string)
    .filter((p) => isSafeRepoPath(p) && matchers.some((rx) => rx.test(p)));
}

/**
 * Every blob in a ref's tree, as path -> blob SHA.
 *
 * `listFilesMatchingGlobs` already walks this exact tree and then throws the
 * SHAs away, because a module-scoped cascade re-reads both sides' CONTENT to
 * decide whether a file changed. That is two API calls per file, which is fine
 * for a module and impossible for a mirror: the prime tree is thousands of
 * files, so content-comparing all of them is ~20,000 calls against an hourly
 * budget of 5,000.
 *
 * Git already computed the answer. A blob SHA is a hash of the content, so
 * `prime[path] !== clone[path]` IS "this file differs", for two calls total,
 * and content is then fetched only for the handful that actually changed.
 *
 * Truncated trees are reported rather than silently short — a partial tree read
 * as complete would look exactly like a clone that is already in sync.
 */
export async function listTreeEntries(
  octokit: Octokit,
  ref: RepoRef,
): Promise<{ entries: Map<string, string>; truncated: boolean }> {
  const { isSafeRepoPath } = await import("@/lib/module-globs");
  const { data: branch } = await octokit.repos.getBranch({
    owner: ref.owner,
    repo: ref.repo,
    branch: ref.branch,
  });
  const { data: tree } = await octokit.git.getTree({
    owner: ref.owner,
    repo: ref.repo,
    tree_sha: branch.commit.commit.tree.sha,
    recursive: "true",
  });
  const entries = new Map<string, string>();
  for (const node of tree.tree ?? []) {
    if (node.type !== "blob") continue;
    if (typeof node.path !== "string" || typeof node.sha !== "string") continue;
    if (!isSafeRepoPath(node.path)) continue;
    entries.set(node.path, node.sha);
  }
  return { entries, truncated: Boolean(tree.truncated) };
}

/**
 * A file read out of a repository.
 *
 * `content` is the UTF-8 reading and `base64` is what was actually there. They
 * are not interchangeable, and the difference destroyed a file in production:
 * see `binary` below.
 */
export type RepoFile = {
  sha: string;
  /**
   * The bytes decoded as UTF-8. LOSSY when `binary` is true — every byte
   * sequence that is not valid UTF-8 has become U+FFFD and cannot be recovered.
   * Safe to read, never safe to write back.
   */
  content: string;
  /**
   * The bytes exactly as GitHub returned them. The only thing that may be
   * written back into a repository.
   */
  base64: string;
  /**
   * True when the bytes do not survive a UTF-8 round trip.
   *
   * Decided by performing the round trip rather than by a list of extensions:
   * a file is binary precisely when decoding and re-encoding it does not give
   * back what was there, which is the actual property that matters and cannot
   * go stale the way an extension list does.
   */
  binary: boolean;
  bytes: number;
};

/**
 * Read one file, keeping the bytes as well as the text.
 *
 * ## Why this returns both
 *
 * It used to return the UTF-8 decoding alone, and the cascade engine wrote that
 * back with `Buffer.from(content, "utf8").toString("base64")`. For text that is
 * a faithful round trip. For anything else it is destruction: every byte
 * sequence that is not valid UTF-8 becomes U+FFFD, three bytes where there was
 * one.
 *
 * Measured on 30 Aug 2026. `public/brand/aurixa-emblem-240.png` is 78,450 bytes
 * of valid PNG in prime and 142,140 bytes on the clone — 1.81x, and no longer a
 * PNG at all. The proof is that the clone's copy decodes cleanly as UTF-8,
 * which no PNG does. It had been re-delivered and re-corrupted by every cascade
 * that carried it. 144 binary files are exposed to this: 86 `.docx` partner
 * agreement templates, 11 print fonts, 7 PDFs, 25 images.
 *
 * ## The 1 MB ceiling
 *
 * `repos.getContent` only inlines files up to 1 MB. Past that it answers with
 * an empty `content` and `encoding: "none"`, which the old code read as an
 * empty file — so a large file would have been delivered as ZERO bytes rather
 * than as a corrupted one. Prime carries two: a 3.4 MB font archive and a
 * 1.6 MB PDF. The blobs API has no such limit, so that case is refetched
 * through it rather than silently truncated.
 */
/**
 * A file the caller asked not to read whole.
 *
 * Thrown BEFORE the bytes travel, on the size the contents API reports, so a
 * caller with a ceiling pays one metadata round trip and no download. The
 * cascade engine turns it into a held path; anything else lets it propagate.
 */
export class OversizeFileError extends Error {
  constructor(
    readonly path: string,
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`${path} is ${bytes} bytes, over the ${maxBytes}-byte ceiling this read was given`);
    this.name = "OversizeFileError";
  }
}

export async function getFileContent(
  octokit: Octokit,
  ref: RepoRef,
  path: string,
  opts?: {
    /**
     * Refuse, with `OversizeFileError`, a file larger than this. Judged on
     * the size the contents API reports alongside the metadata, so the
     * refusal costs no download — the contents API itself carries no body
     * past 1 MB, and the blob fetch below is where a 39 MB file used to be
     * read whole into an invocation that could not hold it.
     */
    maxBytes?: number;
  },
): Promise<RepoFile | null> {
  try {
    const res = await octokit.repos.getContent({
      owner: ref.owner,
      repo: ref.repo,
      path,
      ref: ref.branch,
    });
    const data = res.data as {
      type?: string;
      sha?: string;
      content?: string;
      encoding?: string;
      size?: number;
    };
    if (data.type !== "file" || !data.sha) return null;
    if (
      typeof opts?.maxBytes === "number" &&
      typeof data.size === "number" &&
      data.size > opts.maxBytes
    ) {
      throw new OversizeFileError(path, data.size, opts.maxBytes);
    }

    let base64 = data.encoding === "base64" ? (data.content ?? "") : "";
    if (data.encoding !== "base64") {
      // Over the contents API's 1 MB inline ceiling. The blobs API has none,
      // and an empty string here would have been written into the clone as an
      // empty file.
      const { data: blob } = await octokit.git.getBlob({
        owner: ref.owner,
        repo: ref.repo,
        file_sha: data.sha,
      });
      base64 = blob.encoding === "base64" ? blob.content : "";
    }

    const raw = Buffer.from(base64, "base64");
    const content = raw.toString("utf8");
    return {
      sha: data.sha,
      content,
      base64,
      binary: !Buffer.from(content, "utf8").equals(raw),
      bytes: raw.length,
    };
  } catch (e: unknown) {
    if ((e as { status?: number })?.status === 404) return null;
    throw e;
  }
}
