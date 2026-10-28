/**
 * Upload an encoded Briefing Room package from the operator's browser
 * straight into the website's `marketing-media` bucket.
 *
 * The browser never holds a storage key. It holds a grant — a single-use
 * token Mission Control minted for one listing's next version folder — and
 * trades it at the website's `briefing-upload-sign` function for create-only
 * signed URLs, which it PUTs each file to. Files go in phases (media, then
 * rendition playlists, then the master playlist last), so nothing points at a
 * file that has not landed, and a file already there from an earlier,
 * interrupted attempt is skipped rather than refused.
 *
 * `fetch` is injected so the whole sequence is tested without a network.
 */
import { planUpload, type UploadFile } from "./websiteBriefings.pure";

export type UploadGrant = { token: string; signerUrl: string };

export type UploadProgress = {
  stage: "signing" | "uploading";
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
};

export type UploadOutcome =
  | { ok: true; uploaded: number; skipped: number }
  | { ok: false; error: string; failed: Array<{ path: string; reason: string }> };

const SIGN_BATCH = 200;
const CONCURRENCY = 6;
const ATTEMPTS = 3;

type Fetch = typeof fetch;
type Blobish = { size: number };

/** The path of a file picked with a folder input, relative to the folder itself. */
export function relativePathOf(file: { name: string; webkitRelativePath?: string }): string {
  const full = file.webkitRelativePath || file.name;
  const parts = full.split("/");
  return parts.length > 1 ? parts.slice(1).join("/") : full;
}

/** Hidden files a desktop leaves in a folder (.DS_Store and the like) are not part of a package. */
export function isHiddenFile(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function uploadPackage(input: {
  files: ReadonlyMap<string, Blobish & BodyInit>;
  grant: UploadGrant;
  onProgress?: (progress: UploadProgress) => void;
  fetchImpl?: Fetch;
  retryDelayMs?: number;
}): Promise<UploadOutcome> {
  const doFetch = input.fetchImpl ?? fetch;
  const retryDelay = input.retryDelayMs ?? 1500;
  const plan = planUpload([...input.files.keys()]);
  if (!plan.ok) return { ok: false, error: plan.problems.join(" "), failed: [] };

  const bytesTotal = plan.files.reduce((sum, f) => sum + (input.files.get(f.path)?.size ?? 0), 0);
  const progress: UploadProgress = {
    stage: "signing",
    filesDone: 0,
    filesTotal: plan.files.length,
    bytesDone: 0,
    bytesTotal,
  };
  const report = () => input.onProgress?.({ ...progress });
  report();

  // 1. Signed URLs, a batch at a time.
  const urls = new Map<string, string>();
  const already = new Set<string>();
  for (let i = 0; i < plan.files.length; i += SIGN_BATCH) {
    const paths = plan.files.slice(i, i + SIGN_BATCH).map((f) => f.path);
    let body: {
      ok?: boolean;
      error?: string;
      uploads?: Array<{ path: string; url?: string; exists?: boolean; error?: string }>;
    };
    try {
      const response = await doFetch(input.grant.signerUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: input.grant.token, paths }),
      });
      body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) {
        return {
          ok: false,
          error: `The website refused the upload: ${body.error ?? `HTTP ${response.status}`}`,
          failed: [],
        };
      }
    } catch (err) {
      return {
        ok: false,
        error: `The website could not be reached: ${(err as Error).message}`,
        failed: [],
      };
    }
    const failed: Array<{ path: string; reason: string }> = [];
    for (const entry of body.uploads ?? []) {
      if (entry.url) urls.set(entry.path, entry.url);
      else if (entry.exists) already.add(entry.path);
      else failed.push({ path: entry.path, reason: entry.error ?? "not signed" });
    }
    const missing = paths.filter(
      (p) => !urls.has(p) && !already.has(p) && !failed.some((f) => f.path === p),
    );
    for (const path of missing) failed.push({ path, reason: "not signed" });
    if (failed.length > 0)
      return { ok: false, error: "Some files could not be signed for upload.", failed };
  }

  // 2. The files, phase by phase.
  progress.stage = "uploading";
  let uploaded = 0;
  let skipped = 0;
  const failures: Array<{ path: string; reason: string }> = [];

  const send = async (file: UploadFile): Promise<"uploaded" | "skipped" | string> => {
    if (already.has(file.path)) return "skipped";
    const blob = input.files.get(file.path)!;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await doFetch(urls.get(file.path)!, {
          method: "PUT",
          headers: {
            "content-type": file.contentType,
            "cache-control": file.cacheControl,
            "x-upsert": "false",
          },
          body: blob,
        });
        if (response.ok) return "uploaded";
        const text = await response.text().catch(() => "");
        if (
          (response.status === 400 || response.status === 409) &&
          /duplicate|already exists/i.test(text)
        ) {
          return "skipped";
        }
        if (response.status < 500 || attempt >= ATTEMPTS) return `HTTP ${response.status}`;
      } catch (err) {
        if (attempt >= ATTEMPTS) return (err as Error).message || "network error";
      }
      await sleep(retryDelay * attempt);
    }
  };

  for (const phase of [0, 1, 2] as const) {
    const batch = plan.files.filter((f) => f.phase === phase);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
        while (next < batch.length) {
          const file = batch[next++];
          const result = await send(file);
          if (result === "uploaded") uploaded += 1;
          else if (result === "skipped") skipped += 1;
          else failures.push({ path: file.path, reason: result });
          progress.filesDone += 1;
          progress.bytesDone += input.files.get(file.path)?.size ?? 0;
          report();
        }
      }),
    );
    // Never start the playlists that point at files that did not land.
    if (failures.length > 0) {
      return { ok: false, error: `${failures.length} file(s) did not upload.`, failed: failures };
    }
  }
  return { ok: true, uploaded, skipped };
}
