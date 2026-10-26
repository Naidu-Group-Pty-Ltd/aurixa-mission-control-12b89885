/**
 * Finds the compressed bundle of a function that the repository its source
 * comes from built, or asks that repository to build one: the prime, for the
 * functions every clone takes from it, and a CRM line's own repository, for a
 * function the line deploys from its own tree (`cloneOwnedFunctions.server.ts`).
 * The rules are `compressedEdgeBundle.pure.ts`; this is the GitHub half: the
 * runs of `edge-function-bundles.yml`, their artifacts, and the dispatch.
 *
 * Only a dispatch on the source's own branch is read, newest first, and only
 * its `edge-function-bundles` artifact. A bundle is used where `judgeBundle`
 * says it was built from the bytes this deploy would send, which is the whole
 * of its provenance: the run proves nothing on its own.
 *
 * Reads are kept for the life of the isolate for a short while, so one pass
 * that deploys several functions lists the runs once and downloads an artifact
 * once. A failed read is never cached and never read as "no bundle": it is
 * reported, and the deploy that needed it fails and is tried again.
 */
import { withRetry, isTransientHttpError } from "@/lib/with-retry";
import { readCentralDirectory, readZipEntry } from "@/lib/email/zip.pure";
import { getAppOctokit, type RepoRef } from "./github-app.server";
import { readGitHubRemaining } from "./githubAllowance.server";
import { decideSpend } from "./cascade/githubBudget.pure";
import {
  BUNDLE_ARTIFACT_NAME,
  BUNDLE_WORKFLOW_FILE,
  judgeBundle,
  OPEN_IMPORTS,
  parseBundleManifest,
  planBuildRequest,
  type BundleManifest,
  type BundleRun,
  type DeployableFunction,
} from "./compressedEdgeBundle.pure";

/** The slice of Octokit this module calls, so a test can stand in for GitHub. */
export type BundleOctokit = {
  request: (
    route: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: unknown; headers?: Record<string, string | number | undefined> }>;
};

export type CompressedBundle = {
  manifest: BundleManifest;
  ezbr: Uint8Array;
  runUrl: string;
};

export type CompressedBundleLookup =
  | ({ state: "ready" } & CompressedBundle)
  /** No bundle may stand in for this deploy at all; nothing was asked of GitHub. */
  | { state: "refused"; why: string }
  /** No bundle this deploy may send; `why` says what was found and what was asked for. */
  | { state: "awaiting"; why: string };

/** How many of the newest successful runs are searched for a bundle that fits. */
const RUNS_SEARCHED = 5;
const RUNS_TTL_MS = 60_000;
const ARTIFACTS_KEPT = 4;

const runsCache = new Map<string, { at: number; runs: BundleRun[] }>();
const archiveCache = new Map<number, Uint8Array>();

/** For tests: forget every read. */
export function forgetBundleReads(): void {
  runsCache.clear();
  archiveCache.clear();
}

async function listBundleRuns(
  octokit: BundleOctokit,
  source: RepoRef,
  nowMs: number,
): Promise<BundleRun[]> {
  const key = `${source.owner}/${source.repo}@${source.branch}`;
  const hit = runsCache.get(key);
  if (hit && nowMs - hit.at < RUNS_TTL_MS) return hit.runs;
  const res = await withRetry(
    () =>
      octokit.request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
        owner: source.owner,
        repo: source.repo,
        workflow_id: BUNDLE_WORKFLOW_FILE,
        branch: source.branch,
        event: "workflow_dispatch",
        per_page: 20,
      }),
    { attempts: 3, shouldRetry: isTransientHttpError },
  );
  const raw = (res.data as { workflow_runs?: Array<Record<string, unknown>> })?.workflow_runs ?? [];
  const runs: BundleRun[] = raw
    // The query asks for these; checked again so a reply that ignored a filter
    // cannot hand over a run started anywhere else.
    .filter((r) => r.head_branch === source.branch && r.event === "workflow_dispatch")
    .map((r) => ({
      id: Number(r.id),
      status: (r.status as string | null) ?? null,
      conclusion: (r.conclusion as string | null) ?? null,
      createdAt: String(r.created_at ?? ""),
      htmlUrl: String(r.html_url ?? ""),
      title: String(r.display_title ?? ""),
    }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  runsCache.set(key, { at: nowMs, runs });
  return runs;
}

async function readArchive(
  octokit: BundleOctokit,
  source: RepoRef,
  runId: number,
): Promise<Uint8Array | null> {
  const listed = await withRetry(
    () =>
      octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", {
        owner: source.owner,
        repo: source.repo,
        run_id: runId,
        name: BUNDLE_ARTIFACT_NAME,
      }),
    { attempts: 3, shouldRetry: isTransientHttpError },
  );
  const artifact = (
    (listed.data as { artifacts?: Array<Record<string, unknown>> })?.artifacts ?? []
  ).find((a) => a.name === BUNDLE_ARTIFACT_NAME && a.expired !== true);
  if (!artifact) return null;
  const id = Number(artifact.id);
  const kept = archiveCache.get(id);
  if (kept) return kept;
  const res = await withRetry(
    () =>
      octokit.request(
        "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
        {
          owner: source.owner,
          repo: source.repo,
          artifact_id: id,
          archive_format: "zip",
          // GitHub answers with a redirect to a signed storage URL. It is
          // followed here, without the App's credentials: a client that
          // carried them across would hand the installation token to the
          // storage host, which refuses a request bearing one anyway.
          request: { redirect: "manual" },
        },
      ),
    { attempts: 3, shouldRetry: isTransientHttpError },
  );
  const location = res.headers?.location;
  let bytes: Uint8Array;
  if (typeof location === "string" && location.length > 0) {
    const stored = await fetch(location);
    if (!stored.ok) throw new Error(`the bundle archive could not be read: ${stored.status}`);
    bytes = new Uint8Array(await stored.arrayBuffer());
  } else {
    bytes = new Uint8Array(res.data as ArrayBuffer);
  }
  if (archiveCache.size >= ARTIFACTS_KEPT)
    archiveCache.delete(archiveCache.keys().next().value as number);
  archiveCache.set(id, bytes);
  return bytes;
}

async function bundleIn(
  archive: Uint8Array,
  slug: string,
): Promise<{ manifestJson: unknown; ezbr: Uint8Array } | null> {
  const entries = readCentralDirectory(archive);
  const manifestEntry = entries.find((e) => e.name === `${slug}.manifest.json`);
  const ezbrEntry = entries.find((e) => e.name === `${slug}.ezbr`);
  if (!manifestEntry || !ezbrEntry) return null;
  const manifestText = new TextDecoder().decode(await readZipEntry(archive, manifestEntry));
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestText);
  } catch {
    manifestJson = null;
  }
  return { manifestJson, ezbr: await readZipEntry(archive, ezbrEntry) };
}

async function requestBuild(
  octokit: BundleOctokit,
  source: RepoRef,
  slug: string,
  runs: readonly BundleRun[],
  nowMs: number,
): Promise<string> {
  const plan = planBuildRequest({ runs, slug, nowMs });
  if (!plan.dispatch) return plan.why;
  try {
    await withRetry(
      () =>
        octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner: source.owner,
          repo: source.repo,
          workflow_id: BUNDLE_WORKFLOW_FILE,
          ref: source.branch,
          inputs: { functions: slug },
        }),
      { attempts: 3, shouldRetry: isTransientHttpError },
    );
  } catch (e) {
    const status = (e as { status?: number })?.status;
    return status === 404
      ? `asking ${source.owner}/${source.repo} for a build answered 404: .github/workflows/${BUNDLE_WORKFLOW_FILE} is not on ${source.branch}, or the GitHub App lacks Actions: read & write`
      : `asking ${source.owner}/${source.repo} for a build failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  // The next pass must see the run this started, not a listing from before it.
  runsCache.delete(`${source.owner}/${source.repo}@${source.branch}`);
  return `asked ${source.owner}/${source.repo} to build it (${BUNDLE_WORKFLOW_FILE} on ${source.branch})`;
}

/**
 * The newest bundle `source` built that `fn` may be deployed as, or why there
 * is none and what was done about it. `source` is the repository `fn`'s files
 * were read from: a bundle built anywhere else carries other bytes, and
 * `judgeBundle` would refuse it.
 */
export async function compressedBundleFor(input: {
  source: RepoRef;
  fn: DeployableFunction;
  /** The App installation; a test stands in for GitHub here. */
  octokit?: BundleOctokit;
  nowMs?: number;
}): Promise<CompressedBundleLookup> {
  const { source, fn } = input;
  const nowMs = input.nowMs ?? Date.now();
  // Asked first, and of nobody: a deploy whose own imports did not close can
  // be matched by no bundle, so there is nothing worth a call or a build.
  if (fn.importsClosed !== true) return { state: "refused", why: OPEN_IMPORTS };
  // Every lane that deploys a function can reach this, provisioning included,
  // so the spend asks the installation's window first, as an actor: a few
  // calls that land finished work. Refused, the deploy waits for a pass with
  // room rather than spend the floor the cascade needs.
  const spend = decideSpend({ role: "actor", remaining: await readGitHubRemaining() });
  if (!spend.proceed) {
    return { state: "awaiting", why: `GitHub was not asked: ${spend.why}` };
  }
  const octokit = input.octokit ?? (getAppOctokit() as unknown as BundleOctokit);
  let runs: BundleRun[];
  try {
    runs = await listBundleRuns(octokit, source, nowMs);
  } catch (e) {
    // The listing answers 404 for a workflow the repository does not hold.
    // That is a named reason, not "no bundle", and nothing is dispatched to a
    // workflow that is not there. Any other failure is thrown as before.
    if ((e as { status?: number })?.status !== 404) throw e;
    return {
      state: "awaiting",
      why: `${source.owner}/${source.repo} holds no .github/workflows/${BUNDLE_WORKFLOW_FILE} on ${source.branch} to build it with (or the GitHub App lacks Actions: read)`,
    };
  }
  const built = runs
    .filter((r) => r.status === "completed" && r.conclusion === "success")
    .slice(0, RUNS_SEARCHED);
  let found = "no build of it was found";
  for (const run of built) {
    const archive = await readArchive(octokit, source, run.id);
    if (!archive) continue;
    const bundle = await bundleIn(archive, fn.slug);
    if (!bundle) continue;
    const parsed = parseBundleManifest(bundle.manifestJson);
    if (!parsed.ok) {
      found = `the newest build's manifest was refused: ${parsed.reason}`;
      break;
    }
    const verdict = judgeBundle({ manifest: parsed.manifest, ezbr: bundle.ezbr, fn });
    if (verdict.ok)
      return { state: "ready", manifest: parsed.manifest, ezbr: bundle.ezbr, runUrl: run.htmlUrl };
    if (!verdict.stale) {
      // A bundle that is not what it says is not a reason to look further
      // back: an older one from the same workflow is no more trustworthy.
      found = `the newest build was refused: ${verdict.reason}`;
      break;
    }
    if (found === "no build of it was found")
      found = `the newest build is out of date: ${verdict.reason}`;
  }
  const asked = await requestBuild(octokit, source, fn.slug, runs, nowMs);
  return { state: "awaiting", why: `${found}; ${asked}` };
}
