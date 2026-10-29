// Module detection engine.
//
// 1. Fetch the real GitHub tree + file contents
// 2. Identify route files (src/routes, src/pages, app/routes)
// 3. Trace each route's imports to build the dependency graph
// 4. Turn that graph into modules, per `config.strategy`:
//      feature-first / hybrid — partition the repo into disjoint product
//        domains, every file owned exactly once (see feature-detection.server)
//      route-first / layer-first — one module per route, closures may overlap
// 5. Resolve each module's backend surface: edge functions, tables, secrets,
//    migrations (see backend-detection.server)
// 6. Persist modules, backend artifacts, import edges and drift alerts

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit, readBlobTextsExact, type RepoRef } from "./github-app.server";
import type { TextWant } from "./cascade/primeTextBatch.pure";
import { CASCADE_MAX_FILE_BYTES } from "./cascade/syncExclusions.pure";
import type { Octokit } from "@octokit/rest";
import { validateModuleGlobs } from "@/lib/module-globs";
import { parseFunctionConfig } from "./prime-backend.server";
import {
  classifyBackendPath,
  parseMigrationObjects,
  parseEdgeFunctionRefs,
  parseFrontendBackendRefs,
  buildBackendInventoryFromAnalysis,
  linkBackendToModules,
  synthesizeBackendModules,
  computeMigrationSharing,
  EMPTY_MANIFEST,
  type DbObject,
  type EdgeFunctionRefs,
  type FrontendBackendRefs,
  type BackendInventory,
  type ModuleBackendManifest,
} from "./backend-detection.server";
import { buildFeatureModules, type PartitionStats } from "./feature-detection.server";
import { describeDbError } from "./libraryApproval.pure";
import crypto from "crypto";

type Supabase = SupabaseClient<Database>;

export type DetectionStrategy = "route-first" | "feature-first" | "layer-first" | "hybrid";

export type DetectionRunConfig = {
  strategy: DetectionStrategy;
  maxModules: number;
  minModules: number;
  sampleFileContent: boolean;
  analyzeImports: boolean;
  deltaMode: boolean;
  /**
   * Scan `supabase/functions`, `supabase/migrations` and infra config, and
   * attach the resolved backend surface to each module. Off = the legacy
   * frontend-only behaviour.
   */
  detectBackend: boolean;
  /**
   * Merge each module's backend globs into `file_globs`, so the cascade
   * engine actually pushes edge functions and migrations to clone repos.
   */
  includeBackendGlobs: boolean;
  /** Emit modules for edge functions no route reaches (cron/webhook workers). */
  synthesizeBackendModules: boolean;
  /** Upper bound on blobs read per run; cache hits don't count against it. */
  maxBackendBlobs: number;
  /**
   * A run of the library follow (`library-follow.server.ts`, D19, 29 Oct
   * 2026). An approved module, and one the follow archived, has its files
   * rewritten from the run as a proposed one does, so every module the run
   * finds names it; one a person archived keeps its files. Every module write
   * is checked, a prime with no route is a failure, and the run stays
   * `running` until the follow has settled the catalogue at its commit.
   */
  follow?: boolean;
};

export const DEFAULT_CONFIG: DetectionRunConfig = {
  strategy: "feature-first",
  maxModules: 30,
  minModules: 1,
  sampleFileContent: true,
  analyzeImports: true,
  deltaMode: false,
  detectBackend: true,
  includeBackendGlobs: true,
  synthesizeBackendModules: true,
  maxBackendBlobs: 4000,
};

/**
 * How long a run that says `running` is taken to be running. On 31 Jul 2026 a
 * reset's run took eleven and a half minutes reading file by file, and two
 * more runs were started while it read. A run that still says `running` after
 * this died with its invocation, and refusing behind it for ever would leave
 * nothing able to detect.
 */
export const RUNNING_RUN_WINDOW_MS = 30 * 60_000;

/**
 * The detection run in progress, if one is: a run started inside
 * `RUNNING_RUN_WINDOW_MS` that has not finished. Asked before a reset wipes
 * anything and before a detection starts, because two at once write the same
 * modules, and a reset beside a run wipes what the run is writing.
 *
 * A failed read is an error, never "none running".
 */
export async function findRunningDetection(
  supabase: Supabase,
  now: number = Date.now(),
  /** The caller's own run, left out when it looks again after creating it. */
  excludeRunId?: string,
): Promise<
  { ok: true; running: { id: string; started_at: string } | null } | { ok: false; error: string }
> {
  let query = supabase
    .from("module_detection_runs")
    .select("id, started_at")
    .eq("status", "running")
    .gt("started_at", new Date(now - RUNNING_RUN_WINDOW_MS).toISOString());
  if (excludeRunId) query = query.neq("id", excludeRunId);
  const { data, error } = await query.order("started_at", { ascending: false }).limit(1);
  if (error) return { ok: false, error: `detection runs unreadable: ${describeDbError(error)}` };
  const row = (data ?? [])[0] as { id: string; started_at: string } | undefined;
  return { ok: true, running: row ?? null };
}

/** The refusal a second run meets, naming the one already running. */
export function runningRefusal(running: { id: string; started_at: string }, what: string): string {
  return (
    `Detection run ${running.id.slice(0, 8)} has been running since ${running.started_at}, ` +
    `so ${what} now would write the same modules beside it. Wait for it to finish.`
  );
}

type ImportEdge = {
  source_file: string;
  target_file: string;
  /**
   * `edge_invoke*` are frontend→backend crossings, not ES imports — the edges
   * the old import-graph walk could never represent because the target of
   * `functions.invoke("slug")` is a deployed function, not a file on disk.
   */
  import_type: "static" | "dynamic" | "re-export" | "edge_invoke" | "edge_invoke_indirect";
};

type RouteModule = {
  name: string;
  slug: string;
  description: string;
  route_path: string;
  entry_file: string;
  resolved_files: string[];
  file_globs: string[];
  routes: string[];
  shared_by_modules: string[];
  cohesion_score: number;
  coupling_score: number;
  ai_confidence: number;
  ai_reasoning: string;
  requires: string[];
  incompatible_with: string[];
  /** "frontend" until the backend pass resolves it. */
  layer: "frontend" | "backend" | "fullstack" | "shared";
  backend: ModuleBackendManifest;
};

type PassResult = {
  pass: number;
  name: string;
  model: string;
  duration_ms: number;
  modules_proposed: number;
  summary: string;
};

export type DetectionProgress = {
  runId: string;
  phase: string;
  detail: string;
  percent: number;
};

// ─── GitHub Tree Fetch ──────────────────────────────────────────────

/**
 * The branch's tree, and the commit it is the tree of.
 *
 * `commitSha` is what the run records (`module_detection_runs.commit_sha`) and
 * what every later read in the run is made at, so the run read one commit and
 * says which: a library entry is approved at the commit its module was
 * detected at (D19). `treeHash` is a hash of the file list, which two commits
 * can share.
 */
async function fetchRepoTree(
  octokit: Octokit,
  ref: RepoRef,
): Promise<{
  files: string[];
  treeHash: string;
  shaByPath: Map<string, string>;
  /** Each blob's size, as the listing gives it: what decides whether it can be held. */
  sizeByPath: Map<string, number>;
  commitSha: string;
}> {
  const { data: branch } = await octokit.repos.getBranch({
    owner: ref.owner,
    repo: ref.repo,
    branch: ref.branch,
  });
  const commitSha = branch.commit.sha;
  const treeSha = branch.commit.commit.tree.sha;
  const { data: tree } = await octokit.git.getTree({
    owner: ref.owner,
    repo: ref.repo,
    tree_sha: treeSha,
    recursive: "true",
  });

  const blobs = (tree.tree ?? []).filter(
    (n) => n.type === "blob" && typeof n.path === "string" && typeof n.sha === "string",
  );

  // Backend artifacts live under dot-directories too (.github/workflows,
  // .env.example), so the old blanket "drop anything starting with ." filter
  // would have hidden them. Keep those, drop only VCS/tooling noise.
  const files = blobs
    .map((n) => n.path as string)
    .filter((p) => !p.includes("node_modules/"))
    .filter((p) => !p.startsWith(".git/"))
    .filter((p) => !ROOT_DOT_NOISE.test(p))
    // Never surface a real env file. Only `.env.example` / `.template` /
    // `.sample` are ever read, and only for secret *names*.
    .filter((p) => !REAL_ENV_FILE.test(p));

  const shaByPath = new Map<string, string>();
  const sizeByPath = new Map<string, number>();
  for (const n of blobs) {
    shaByPath.set(n.path as string, n.sha as string);
    if (typeof n.size === "number") sizeByPath.set(n.path as string, n.size);
  }

  const treeHash = crypto
    .createHash("sha256")
    .update([...files].sort().join("\n"))
    .digest("hex")
    .slice(0, 16);

  return { files, treeHash, shaByPath, sizeByPath, commitSha };
}

/** Dot-paths that are never part of the deployable surface. */
const ROOT_DOT_NOISE =
  /^\.(vscode|idea|husky|cursor|claude|lovable|DS_Store|prettier|eslint|editorconfig|nvmrc|npmrc|gitignore|gitattributes)/;

/** A real env file — as opposed to a committed `.env.example` template. */
const REAL_ENV_FILE = /(^|\/)\.env(\.local|\.development|\.production|\.test)?$/;

/**
 * Upper bound on backend-only modules. These are grouped one per edge-function
 * slug prefix, so the real count is small; the cap only exists to stop a
 * pathological repo emitting hundreds of modules.
 */
const BACKEND_MODULE_CAP = 80;

// ─── Reading files by batch ─────────────────────────────────────────

/** What a read of many files did not bring back, by path. */
export type UnreadFiles = {
  /** Larger than the reader holds: never asked for, and named so nothing reads one as empty. */
  tooLarge: string[];
  /** Asked for and not answered. A fault, never an absence. */
  unread: string[];
};

/** At most this many files, or `READ_CHUNK_BYTES` of them, are read and held at once. */
const READ_CHUNK_WANTS = 400;
const READ_CHUNK_BYTES = 16 * 1024 * 1024;

/**
 * The exact text of each of `wants`, handed to `take` a chunk at a time and
 * then let go, so a scan of thousands of files never holds more than a chunk.
 *
 * Reads go through `readBlobTextsExact`: eighty blobs to a GraphQL query, by
 * the ids the tree listing gave, and a text is kept only where its blob id is
 * that id. A file over `maxBytes` is never asked for. A file asked for and not
 * answered, or one `take` could not parse, is `unread` and named: the caller
 * decides what a missing file costs, and nothing here reads it as empty.
 */
async function readExactInChunks(args: {
  octokit: Octokit;
  ref: RepoRef;
  wants: TextWant[];
  maxBytes: number;
  take: (want: TextWant, text: string) => void;
  onChunk?: (done: number, total: number) => void;
}): Promise<UnreadFiles> {
  const { octokit, ref, wants, maxBytes, take, onChunk } = args;
  const out: UnreadFiles = { tooLarge: [], unread: [] };
  const asked: TextWant[] = [];
  for (const want of wants) {
    if (typeof want.size === "number" && want.size > maxBytes) out.tooLarge.push(want.path);
    else asked.push(want);
  }

  const chunks: TextWant[][] = [];
  let current: TextWant[] = [];
  let currentBytes = 0;
  for (const want of asked) {
    const size = want.size ?? 0;
    if (
      current.length >= READ_CHUNK_WANTS ||
      (current.length > 0 && currentBytes + size > READ_CHUNK_BYTES)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(want);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);

  let done = 0;
  for (const chunk of chunks) {
    const texts = await readBlobTextsExact(octokit, ref, chunk, { maxBytes });
    for (const want of chunk) {
      const text = texts.get(want.path);
      if (text === undefined) {
        out.unread.push(want.path);
        continue;
      }
      try {
        take(want, text);
      } catch {
        out.unread.push(want.path);
      }
    }
    done += chunk.length;
    onChunk?.(done, asked.length);
  }
  return out;
}

/** The files the import trace reads, as it always has. */
const TRACEABLE = /\.(ts|tsx|js|jsx)$/;

/** How much of each file the trace keeps: imports sit at the top, and this is what it always read. */
const TRACE_TEXT_CHARS = 8192;

/**
 * The largest file the trace reads. It used to read each file through the
 * contents API, which serves no text above 1 MB, so it never read a larger
 * one. On the prime that is `src/integrations/supabase/types.ts` (1.3 MB,
 * importing nothing). Held at the same line, a detection traces the files it
 * always traced.
 */
const TRACE_MAX_BYTES = 1024 * 1024;

/**
 * Its own copy of `value`, holding nothing it was cut from. V8 keeps a slice
 * of a long string as a view of the whole, so an 8,192-character cut of a
 * 1 MB file keeps the 1 MB, and a name a parser matched in a migration keeps
 * the migration. Replayed at prime@6dbda61 on 29 Oct 2026, the trace's cuts
 * held every source file it read whole (78 MB) and a cold backend pass's
 * analyses held every migration whole (50 MB more): 142.6 MB live, in an
 * isolate of 128 MB, and the day's two follow runs both died in their second
 * minute. `JSON.parse` builds every string afresh.
 */
function detached<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The files a source file imports, resolved against the tree, in order and
 * with a target twice where two specifiers name it, as the trace walks them;
 * null for a file the trace holds no text of.
 */
type ImportTargets = (file: string) => string[] | null;

/**
 * Each file's import targets, worked out once. The trace walks every route
 * separately and used to read a file's imports again for each route that
 * reached it: 40,804 edges' worth of regular expressions over the same 3,394
 * texts at prime@6dbda61. A file not read yet is not remembered as importing
 * nothing.
 */
function importTargetsFrom(
  contentCache: ReadonlyMap<string, string>,
  allFilesSet: Set<string>,
): ImportTargets {
  const memo = new Map<string, string[]>();
  return (file) => {
    const known = memo.get(file);
    if (known) return known;
    const content = contentCache.get(file);
    if (!content) return null;
    const targets: string[] = [];
    for (const spec of extractImports(file, content)) {
      const target = findActualFile(spec, allFilesSet);
      if (target) targets.push(target);
    }
    memo.set(file, targets);
    return targets;
  };
}

/**
 * Read every source file the import trace can reach, before it walks.
 *
 * The trace asked the contents API for each file as it came to it, one call at
 * a time. Replayed against prime@122b761 on 28 Oct 2026 that was 3,622 calls,
 * 228 of them for `types.ts` again, because a file the API never answered was
 * never remembered. The App's window is 5,000 an hour and the cascade spends
 * from it too, and a call refused there was swallowed, so the file was traced
 * as importing nothing and its domain came out smaller with no word said.
 *
 * This walks the same graph breadth-first from every route at once, to the
 * same depth, and asks each level's files by batch: the same files for a few
 * dozen queries. Each text is cut to the 8,192 characters the trace read, and
 * the cut is the text's own copy (`detached`).
 */
async function prefetchTraceSources(args: {
  octokit: Octokit;
  ref: RepoRef;
  roots: string[];
  shaByPath: Map<string, string>;
  sizeByPath: Map<string, number>;
  contentCache: Map<string, string>;
  importTargets: ImportTargets;
  maxDepth?: number;
}): Promise<UnreadFiles> {
  const { octokit, ref, roots, shaByPath, sizeByPath, contentCache, importTargets } = args;
  const maxDepth = args.maxDepth ?? TRACE_MAX_DEPTH;
  const out: UnreadFiles = { tooLarge: [], unread: [] };
  const seen = new Set<string>();
  let frontier = [...new Set(roots)];

  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    for (const path of frontier) seen.add(path);
    const wants = frontier
      .filter((path) => TRACEABLE.test(path) && !contentCache.has(path))
      .map((path) => ({ path, sha: shaByPath.get(path) ?? "", size: sizeByPath.get(path) }));
    const level = await readExactInChunks({
      octokit,
      ref,
      wants,
      maxBytes: TRACE_MAX_BYTES,
      take: (want, text) => contentCache.set(want.path, detached(text.slice(0, TRACE_TEXT_CHARS))),
    });
    out.tooLarge.push(...level.tooLarge);
    out.unread.push(...level.unread);

    const next = new Set<string>();
    for (const path of frontier) {
      for (const target of importTargets(path) ?? []) {
        if (!seen.has(target)) next.add(target);
      }
    }
    frontier = [...next];
  }
  return out;
}

/**
 * A run that could not read a file it needed writes no module. Read as empty,
 * a source file would be traced as importing nothing and a migration as
 * declaring nothing, and the modules shaped from that would be approved at a
 * commit whose files they do not describe.
 */
/** A follow run's module write that did not land: the run stops, because what it settles would not be what it found. */
function moduleWriteRefusal(slug: string, error: { message: string; code?: string }): Error {
  return new Error(`The module ${slug} was not written: ${describeDbError(error)}`);
}

function unreadRefusal(what: string, unread: string[]): Error {
  const shown = unread.slice(0, 10).join(", ");
  const more = unread.length > 10 ? ` and ${unread.length - 10} more` : "";
  return new Error(
    `${unread.length} ${what} could not be read (${shown}${more}), so this run wrote no module. ` +
      `Run detection again.`,
  );
}

// ─── Cached blob reading ────────────────────────────────────────────

/**
 * Read many blobs by batch, memoised on git blob SHA.
 *
 * A full backend scan of the prime touches ~1,400 files (756 migrations plus
 * 619 edge-function sources). Blobs are content-addressed, so a parse result
 * keyed on SHA is valid forever: after the first run only files that actually
 * changed cost an API call. Without this, every detection run would burn most
 * of the GitHub App's hourly budget.
 *
 * By 28 Oct 2026 it was 3,575 files, and 25 of the migrations were template
 * seeds of 37 to 43 MB. A blob read through the API arrives whole, base64 in
 * JSON, inside a Worker isolate of 128 MB: a cascade pass died on one such
 * seed on every attempt on 2 Sep (`docs/CASCADE_LARGE_FILES.md`), and this
 * read them eight at a time. A blob over `CASCADE_MAX_FILE_BYTES`, what an
 * invocation can hold, is never read, and comes back named in `tooLarge`. The
 * seeds hold rows only, so the catalogue loses nothing by it. A blob that was
 * asked for and not answered comes back in `unread`, where it used to be
 * dropped with its module resolving "with less backend detail".
 */
async function readBlobsCached<T>(args: {
  octokit: Octokit;
  ref: RepoRef;
  supabase: Supabase;
  /** Each blob as the listing gives it: path, sha and size. */
  targets: TextWant[];
  kind: string;
  parse: (content: string, path: string) => T;
  maxBlobs?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<
  {
    results: Map<string, T>;
    fetched: number;
    cached: number;
    skipped: number;
  } & UnreadFiles
> {
  const { octokit, ref, supabase, targets, kind, parse, maxBlobs = 4000, onProgress } = args;

  const results = new Map<string, T>();
  const capped = targets.slice(0, maxBlobs);
  const skipped = targets.length - capped.length;
  if (capped.length === 0) {
    return { results, fetched: 0, cached: 0, skipped, tooLarge: [], unread: [] };
  }

  // ── Cache lookup (chunked; `in` has a practical URL length limit) ──
  const cacheHits = new Map<string, T>();
  const shas = capped.map((t) => t.sha);
  for (let i = 0; i < shas.length; i += 200) {
    const chunk = shas.slice(i, i + 200);
    const { data } = await supabase
      .from("repo_blob_analysis")
      .select("blob_sha, analysis")
      .in("blob_sha", chunk);
    for (const row of (data ?? []) as Array<{ blob_sha: string; analysis: unknown }>) {
      cacheHits.set(row.blob_sha, row.analysis as T);
    }
  }

  const misses: TextWant[] = [];
  for (const t of capped) {
    const hit = cacheHits.get(t.sha);
    if (hit !== undefined) results.set(t.path, hit);
    else misses.push(t);
  }

  // ── Read + parse the misses ──
  const toCache: Array<{
    blob_sha: string;
    path: string;
    kind: string;
    analysis: T;
    byte_size: number;
  }> = [];
  const reads = await readExactInChunks({
    octokit,
    ref,
    wants: misses,
    maxBytes: CASCADE_MAX_FILE_BYTES,
    take: (want, content) => {
      // Its own copy: a parse of a migration otherwise keeps the migration.
      const analysis = detached(parse(content, want.path));
      results.set(want.path, analysis);
      toCache.push({
        blob_sha: want.sha,
        path: want.path,
        kind,
        analysis,
        byte_size: content.length,
      });
    },
    onChunk: onProgress,
  });

  // ── Persist new analyses ──
  for (let i = 0; i < toCache.length; i += 100) {
    const chunk = toCache.slice(i, i + 100).map((r) => ({
      ...r,
      analysis: JSON.parse(JSON.stringify(r.analysis)),
      last_seen_at: new Date().toISOString(),
    }));
    await supabase.from("repo_blob_analysis").upsert(chunk, { onConflict: "blob_sha" });
  }

  // Refresh last_seen_at on cache hits so the pruner keeps live blobs.
  const hitShas = capped.filter((t) => cacheHits.has(t.sha)).map((t) => t.sha);
  for (let i = 0; i < hitShas.length; i += 200) {
    await supabase
      .from("repo_blob_analysis")
      .update({ last_seen_at: new Date().toISOString() })
      .in("blob_sha", hitShas.slice(i, i + 200));
  }

  return {
    results,
    fetched: toCache.length,
    cached: cacheHits.size,
    skipped,
    tooLarge: reads.tooLarge,
    unread: reads.unread,
  };
}

// ─── Import Resolution ──────────────────────────────────────────────

function resolveImportPath(dir: string, specifier: string): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !specifier.startsWith("~/")) {
    return null; // npm package
  }
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    return "src/" + specifier.slice(2);
  }
  const parts = dir.split("/").filter(Boolean);
  for (const seg of specifier.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

function extractImports(filePath: string, content: string): string[] {
  const dir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "";
  const imports: string[] = [];

  // Static imports
  const staticRx = /import\s+(?:[\w{}\s,*]+\s+from\s+)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = staticRx.exec(content)) !== null) {
    const target = resolveImportPath(dir, m[1]);
    if (target) imports.push(target);
  }

  // Dynamic imports
  const dynamicRx = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynamicRx.exec(content)) !== null) {
    const target = resolveImportPath(dir, m[1]);
    if (target) imports.push(target);
  }

  // Re-exports
  const reExportRx = /export\s+(?:[\w{}\s,*]+\s+)?from\s+['"]([^'"]+)['"]/g;
  while ((m = reExportRx.exec(content)) !== null) {
    const target = resolveImportPath(dir, m[1]);
    if (target) imports.push(target);
  }

  return [...new Set(imports)];
}

// Match a resolved import specifier to an actual file in the tree
function findActualFile(specifier: string, allFiles: Set<string>): string | null {
  // Direct match
  if (allFiles.has(specifier)) return specifier;
  // Try extensions
  const exts = [".ts", ".tsx", ".js", ".jsx"];
  for (const ext of exts) {
    if (allFiles.has(specifier + ext)) return specifier + ext;
  }
  // Try index files
  for (const ext of exts) {
    if (allFiles.has(specifier + "/index" + ext)) return specifier + "/index" + ext;
  }
  return null;
}

/** How deep the trace follows imports from a route. */
const TRACE_MAX_DEPTH = 20;

// Recursively trace all imports from a root file, through the texts
// `prefetchTraceSources` read: the walk itself reads nothing.
function traceImports(
  rootFile: string,
  importTargets: ImportTargets,
  maxDepth: number = TRACE_MAX_DEPTH,
): { files: string[]; edges: ImportEdge[] } {
  const visited = new Set<string>();
  const edges: ImportEdge[] = [];
  const queue: Array<{ file: string; depth: number }> = [{ file: rootFile, depth: 0 }];

  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (visited.has(file) || depth > maxDepth) continue;
    visited.add(file);

    for (const actual of importTargets(file) ?? []) {
      if (!visited.has(actual)) {
        edges.push({ source_file: file, target_file: actual, import_type: "static" });
        queue.push({ file: actual, depth: depth + 1 });
      }
    }
  }

  return { files: [...visited], edges };
}

// ─── Route Detection ────────────────────────────────────────────────

function identifyRouteFiles(files: string[]): string[] {
  return files
    .filter((f) => {
      // Match common route patterns
      if (f.match(/src\/routes\/.*\.(tsx|ts|jsx|js)$/)) return true;
      if (f.match(/app\/routes\/.*\.(tsx|ts|jsx|js)$/)) return true;
      if (f.match(/src\/pages\/.*\.(tsx|ts|jsx|js)$/)) return true;
      return false;
    })
    .filter((f) => {
      // Exclude internal files
      const name = f.split("/").pop() ?? "";
      if (name.startsWith("__root")) return false;
      if (name === "routeTree.gen.ts") return false;
      if (name.startsWith("_")) return false;
      return true;
    });
}

function routeFileToPath(file: string): string {
  // Extract route path from file name
  // e.g. src/routes/dashboard.tsx → /dashboard
  // e.g. src/routes/settings.index.tsx → /settings
  // e.g. src/routes/clones.$cloneId.tsx → /clones/:cloneId
  let name = file.split("/").pop() ?? "";
  name = name.replace(/\.(tsx|ts|jsx|js)$/, "");
  if (name === "index") return "/";
  // Replace dots with slashes for nested routes
  let path = "/" + name.replace(/\./g, "/");
  // Convert $param to :param
  path = path.replace(/\$(\w+)/g, ":$1");
  // Handle index suffix
  path = path.replace(/\/index$/, "");
  return path || "/";
}

function routeFileToSlug(file: string): string {
  let name = file.split("/").pop() ?? "";
  name = name.replace(/\.(tsx|ts|jsx|js)$/, "");
  if (name === "index") return "home";
  return (
    name.replace(/\./g, "-").replace(/\$/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "") || "root"
  );
}

function routeFileToName(file: string): string {
  const slug = routeFileToSlug(file);
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ─── Cohesion / Coupling Calculation ────────────────────────────────

function calculateMetrics(
  moduleFiles: Set<string>,
  allEdges: ImportEdge[],
): { cohesion: number; coupling: number } {
  let internal = 0;
  let external = 0;

  for (const e of allEdges) {
    if (!moduleFiles.has(e.source_file)) continue;
    if (moduleFiles.has(e.target_file)) internal++;
    else external++;
  }

  const total = internal + external;
  return {
    cohesion: total === 0 ? 1 : internal / total,
    coupling: total === 0 ? 0 : external / total,
  };
}

// ─── Main Detection Orchestrator ────────────────────────────────────

export async function runDetection(args: {
  supabase: Supabase;
  /** Who started the run; null for the library follow, which nobody starts. */
  userId: string | null;
  config: DetectionRunConfig;
  onProgress?: (p: DetectionProgress) => void;
  /**
   * Asked once this run's row exists, before anything is read: who else is
   * working on the catalogue (`catalogueCompetitor`). An answer stops the run,
   * and the run's row says why. A reset passes none, because it looked after
   * recording itself and before its wipe.
   */
  guard?: (runId: string) => Promise<string | null>;
  /**
   * Asked in follow mode once the run knows every slug it found, before it
   * writes a module: an answer stops the run there, with no module written,
   * and leaves the run `running` for the caller to close
   * (`library-follow.server.ts`, which holds rather than archive the
   * catalogue).
   */
  beforeWriting?: (detectedSlugs: string[]) => Promise<string | null>;
}): Promise<{
  ok: boolean;
  runId: string;
  proposed: number;
  inserted: number;
  updated: number;
  orphanAlerts: number;
  error?: string;
  /** The commit the run read, once it has read the tree. */
  commitSha?: string;
  /** Every slug the run found and wrote a module for (or would have, for one a person archived). */
  detectedSlugs?: string[];
  /** Why `beforeWriting` stopped the run before it wrote a module. */
  stoppedBeforeWriting?: string;
}> {
  const { supabase, userId, config, onProgress } = args;
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey)
    return {
      ok: false,
      runId: "",
      proposed: 0,
      inserted: 0,
      updated: 0,
      orphanAlerts: 0,
      error: "LOVABLE_API_KEY not configured",
    };

  const { data: prime } = await supabase.from("prime_config").select("*").limit(1).maybeSingle();
  if (!prime)
    return {
      ok: false,
      runId: "",
      proposed: 0,
      inserted: 0,
      updated: 0,
      orphanAlerts: 0,
      error: "Configure prime repo first",
    };

  // Find previous run for delta mode
  let previousRunId: string | null = null;
  let previousTreeHash: string | null = null;
  if (config.deltaMode) {
    const { data: prev } = await supabase
      .from("module_detection_runs")
      .select("id, tree_hash")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (prev) {
      previousRunId = prev.id;
      previousTreeHash = prev.tree_hash;
    }
  }

  // Create run record
  const { data: run, error: runErr } = await supabase
    .from("module_detection_runs")
    .insert({
      strategy: config.strategy,
      status: "running",
      delta_mode: config.deltaMode,
      previous_run_id: previousRunId,
      initiated_by: userId,
      started_at: new Date().toISOString(),
      parameters: JSON.parse(JSON.stringify(config)),
    })
    .select()
    .single();
  if (runErr || !run) {
    return {
      ok: false,
      runId: "",
      proposed: 0,
      inserted: 0,
      updated: 0,
      orphanAlerts: 0,
      error: runErr?.message ?? "Failed to create run",
    };
  }

  const runId = run.id;
  const progress = (phase: string, detail: string, percent: number) => {
    onProgress?.({ runId, phase, detail, percent });
  };

  // The commit the run read, for a failure after it read the tree to name.
  let readCommit: string | undefined;
  try {
    const competitor = args.guard ? await args.guard(runId) : null;
    if (competitor) throw new Error(competitor);

    // ── Phase 1: Fetch real tree ──
    progress("tree_fetch", "Fetching repository tree from GitHub…", 5);
    const octokit = getAppOctokit();
    const branchRef: RepoRef = {
      owner: prime.github_owner,
      repo: prime.github_repo,
      branch: prime.default_branch,
    };
    const { files, treeHash, shaByPath, sizeByPath, commitSha } = await fetchRepoTree(
      octokit,
      branchRef,
    );
    readCommit = commitSha;

    // The commit this run read, recorded before anything is changed. A library
    // entry is approved at the commit its module was detected at, so a run
    // that could not say which commit it read must not shape a module: it
    // fails here, with the reason, before it has written one.
    const { error: commitErr } = await supabase
      .from("module_detection_runs")
      .update({ commit_sha: commitSha })
      .eq("id", runId);
    if (commitErr) {
      throw new Error(
        `Could not record the commit this run read (${commitSha}): ${describeDbError(commitErr)}`,
      );
    }

    // Every file read from here on is read at that commit, not at the branch,
    // which can move while a run is still reading it.
    const ref: RepoRef = { ...branchRef, branch: commitSha };

    // Delta check
    if (config.deltaMode && previousTreeHash === treeHash) {
      await supabase
        .from("module_detection_runs")
        .update({
          status: "completed",
          tree_hash: treeHash,
          file_count: files.length,
          completed_at: new Date().toISOString(),
          error_message: "No changes detected since last scan",
        })
        .eq("id", runId);
      return {
        ok: true,
        runId,
        proposed: 0,
        inserted: 0,
        updated: 0,
        orphanAlerts: 0,
        error: "No changes since last scan",
      };
    }

    const allFilesSet = new Set(files);
    progress("tree_fetch", `Found ${files.length} files`, 15);

    // ── Phase 2: Identify route files ──
    progress("route_detection", "Identifying route files…", 20);
    const routeFiles = identifyRouteFiles(files);
    progress("route_detection", `Found ${routeFiles.length} route files`, 25);

    if (routeFiles.length === 0) {
      // A follow that completed here would settle a catalogue of nothing, and
      // its settle archives whatever the run did not find.
      if (config.follow) {
        throw new Error(
          `No route file was found in the prime's tree at ${commitSha}, so the follow does not settle the catalogue at it`,
        );
      }
      await supabase
        .from("module_detection_runs")
        .update({
          status: "completed",
          tree_hash: treeHash,
          file_count: files.length,
          completed_at: new Date().toISOString(),
          error_message: "No route files found in repository",
        })
        .eq("id", runId);
      return {
        ok: true,
        runId,
        proposed: 0,
        inserted: 0,
        updated: 0,
        orphanAlerts: 0,
        error: "No route files found",
      };
    }

    // ── Phase 3: Trace imports for each route ──
    // Runs under every strategy: it is what pulls file contents into the cache,
    // which both the feature partition and the backend pass read from.
    progress("import_tracing", "Reading the source files the routes reach…", 30);
    const contentCache = new Map<string, string>();
    const importTargets = importTargetsFrom(contentCache, allFilesSet);
    const traceReads = await prefetchTraceSources({
      octokit,
      ref,
      roots: routeFiles,
      shaByPath,
      sizeByPath,
      contentCache,
      importTargets,
    });
    if (traceReads.unread.length > 0) {
      throw unreadRefusal("source file(s) the import trace reaches", traceReads.unread);
    }
    progress("import_tracing", "Tracing import trees for each route…", 32);
    const allEdges: ImportEdge[] = [];
    const routeModules: RouteModule[] = [];
    const fileOwnership = new Map<string, string[]>(); // file → [slug, slug, ...]

    // Route-first emits one module per route. Feature-first partitions the repo
    // into disjoint product domains instead — on a large prime, one-module-per
    // -route overlaps ~4x and no module describes a coherent feature.
    const useRouteFirst = config.strategy === "route-first" || config.strategy === "layer-first";

    for (let i = 0; i < routeFiles.length; i++) {
      const rf = routeFiles[i];
      const pct = 30 + Math.round((i / routeFiles.length) * 40);
      progress("import_tracing", `Tracing ${rf} (${i + 1}/${routeFiles.length})…`, pct);

      const { files: resolvedFiles, edges } = traceImports(rf, importTargets);
      allEdges.push(...edges);

      const slug = routeFileToSlug(rf);
      const routePath = routeFileToPath(rf);

      // Track ownership
      for (const f of resolvedFiles) {
        const owners = fileOwnership.get(f) ?? [];
        owners.push(slug);
        fileOwnership.set(f, owners);
      }

      if (!useRouteFirst) continue;

      const moduleFiles = new Set(resolvedFiles);
      const { cohesion, coupling } = calculateMetrics(moduleFiles, edges);

      routeModules.push({
        name: routeFileToName(rf),
        slug,
        description: `Page module rooted at ${routePath} — includes route component and all imported dependencies.`,
        route_path: routePath,
        entry_file: rf,
        resolved_files: resolvedFiles,
        file_globs: [`${rf.substring(0, rf.lastIndexOf("/") + 1)}**/*`],
        routes: [routePath],
        shared_by_modules: [],
        cohesion_score: Math.round(cohesion * 100) / 100,
        coupling_score: Math.round(coupling * 100) / 100,
        ai_confidence: 1, // deterministic
        ai_reasoning: `Route-first detection: traced ${resolvedFiles.length} files from ${rf} via import graph.`,
        requires: [],
        incompatible_with: [],
        layer: "frontend",
        backend: { ...EMPTY_MANIFEST },
      });
    }

    // ── Phase 3b: Feature partition ──
    let partitionStats: PartitionStats | null = null;
    if (!useRouteFirst) {
      progress("feature_partition", "Partitioning repository into feature domains…", 72);

      // Import edges resolved against the cache the trace just filled — no
      // further network reads.
      const importsOf = (file: string): string[] => importTargets(file) ?? [];

      const edgeSlugs = files
        .map((f) => classifyBackendPath(f))
        .filter((i) => i?.kind === "edge_function")
        .map((i) => i!.identifier);

      const { modules: featureModules, stats } = buildFeatureModules({
        files,
        routeFiles,
        edgeFunctionSlugs: [...new Set(edgeSlugs)],
        importsOf,
        routePathOf: routeFileToPath,
      });
      partitionStats = stats;

      for (const fm of featureModules) {
        const owned = new Set(fm.resolvedFiles);
        const { cohesion, coupling } = calculateMetrics(owned, allEdges);
        routeModules.push({
          name: fm.name,
          slug: fm.slug,
          description: fm.description,
          route_path: fm.routePaths[0] ?? "",
          entry_file: fm.entryFile,
          resolved_files: fm.resolvedFiles,
          file_globs: fm.fileGlobs,
          routes: fm.routePaths,
          shared_by_modules: [],
          cohesion_score: Math.round(cohesion * 100) / 100,
          coupling_score: Math.round(coupling * 100) / 100,
          ai_confidence: 1,
          ai_reasoning:
            `Feature-first detection: ${fm.slug} owns ${fm.resolvedFiles.length} file(s) ` +
            `across ${fm.routes.length} route(s), expressed as ${fm.fileGlobs.length} glob(s). ` +
            `Every file has exactly one owning module.`,
          requires: [],
          incompatible_with: [],
          layer: fm.layer,
          backend: { ...EMPTY_MANIFEST },
        });
      }

      progress(
        "feature_partition",
        `Partitioned ${stats.filesPartitioned} files into ${routeModules.length} modules ` +
          `(overlap ${stats.overlapFactor}x)`,
        75,
      );
    }

    // ── Phase 4: Identify shared files ──
    // Route-first only. Feature-first already emits `platform-core` for files
    // more than one domain reaches, so a second shared module would double-claim.
    progress("shared_detection", "Identifying shared files across modules…", 75);
    const sharedFiles: string[] = [];
    for (const [file, owners] of useRouteFirst ? fileOwnership : new Map<string, string[]>()) {
      if (owners.length > 1) {
        sharedFiles.push(file);
        // Tag each module that uses this shared file
        for (const mod of routeModules) {
          if (mod.resolved_files.includes(file)) {
            mod.shared_by_modules = [
              ...new Set([...mod.shared_by_modules, ...owners.filter((o) => o !== mod.slug)]),
            ];
          }
        }
      }
    }

    // Create a "shared" module for files used by 2+ routes
    if (sharedFiles.length > 0) {
      const sharedSet = new Set(sharedFiles);
      const { cohesion, coupling } = calculateMetrics(sharedSet, allEdges);
      const ownerSlugs = [...new Set(sharedFiles.flatMap((f) => fileOwnership.get(f) ?? []))];

      routeModules.push({
        name: "Shared / Core",
        slug: "shared-core",
        description: `Files imported by ${ownerSlugs.length} modules — shared components, hooks, utilities, and types.`,
        route_path: "",
        entry_file: "src/",
        resolved_files: sharedFiles,
        file_globs: ["src/components/**/*", "src/lib/**/*", "src/hooks/**/*"],
        routes: [],
        shared_by_modules: ownerSlugs,
        cohesion_score: Math.round(cohesion * 100) / 100,
        coupling_score: Math.round(coupling * 100) / 100,
        ai_confidence: 1,
        ai_reasoning: `${sharedFiles.length} files are imported by 2 or more route modules. These form the shared infrastructure layer.`,
        requires: [],
        incompatible_with: [],
        layer: "shared",
        backend: { ...EMPTY_MANIFEST },
      });
    }

    // ── Phase 5: Backend architecture ──
    // Everything above this line is frontend-only. This pass reads the
    // repo's backend surface and joins it to the modules, so a module
    // finally describes what it needs to *run*, not just what it renders.
    let inventory: BackendInventory | null = null;
    let backendSummary: Record<string, unknown> = {};
    const backendEdges: ImportEdge[] = [];
    let backendModuleCount = 0;

    if (config.detectBackend) {
      progress("backend_scan", "Scanning backend architecture…", 76);

      const backendPaths = files
        .map((p) => ({ path: p, info: classifyBackendPath(p) }))
        .filter((x): x is { path: string; info: NonNullable<typeof x.info> } => x.info !== null);

      const analysable = (p: string) =>
        /\.(ts|tsx|js|mjs|cjs|sql|toml)$/.test(p) || p.includes(".env.");

      const want = (path: string): TextWant => ({
        path,
        sha: shaByPath.get(path) ?? "",
        size: sizeByPath.get(path),
      });

      const migrationTargets = backendPaths
        .filter((x) => x.info.kind === "migration")
        .map((x) => want(x.path))
        .filter((t) => t.sha);

      const fnTargets = backendPaths
        .filter((x) => x.info.kind === "edge_function" || x.info.kind === "edge_shared")
        .filter((x) => analysable(x.path))
        .map((x) => want(x.path))
        .filter((t) => t.sha);

      // Migration SQL → declared database objects.
      progress(
        "backend_scan",
        `Parsing ${migrationTargets.length} migration(s) for schema objects…`,
        78,
      );
      const migrationAnalysis = await readBlobsCached<{ objects: DbObject[] }>({
        octokit,
        ref,
        supabase,
        targets: migrationTargets,
        kind: "migration",
        maxBlobs: config.maxBackendBlobs,
        parse: (content) => ({ objects: parseMigrationObjects(content) }),
        onProgress: (d, t) =>
          progress("backend_scan", `Parsed ${d}/${t} migration(s)…`, 78 + Math.round((d / t) * 4)),
      });

      // Edge function sources → secrets, tables, rpcs, shared imports, invokes.
      progress("backend_scan", `Parsing ${fnTargets.length} edge function file(s)…`, 82);
      const fnAnalysis = await readBlobsCached<EdgeFunctionRefs>({
        octokit,
        ref,
        supabase,
        targets: fnTargets,
        kind: "edge_function",
        maxBlobs: config.maxBackendBlobs,
        parse: (content) => parseEdgeFunctionRefs(content),
        onProgress: (d, t) =>
          progress(
            "backend_scan",
            `Parsed ${d}/${t} edge function file(s)…`,
            82 + Math.round((d / t) * 4),
          ),
      });

      // config.toml drives per-function verify_jwt; with no config.toml in the
      // tree, verify_jwt defaults to true per function, as the CLI's does.
      // `.env.example` contributes secret names (never values).
      let functionConfig = new Map<string, { verifyJwt: boolean }>();
      const envContents = new Map<string, string>();
      const settingsWants = [
        ...(shaByPath.has("supabase/config.toml") ? [want("supabase/config.toml")] : []),
        ...backendPaths
          .filter((x) => x.info.kind === "env_template" && shaByPath.has(x.path))
          .map((x) => want(x.path)),
      ];
      const settingsReads = await readExactInChunks({
        octokit,
        ref,
        wants: settingsWants,
        maxBytes: CASCADE_MAX_FILE_BYTES,
        take: (w, text) => {
          if (w.path === "supabase/config.toml") functionConfig = parseFunctionConfig(text);
          else envContents.set(w.path, text);
        },
      });

      // A config.toml or a template that could not be read would have every
      // function read as verify_jwt true, or a secret as not needed.
      const backendUnread = [
        ...migrationAnalysis.unread,
        ...fnAnalysis.unread,
        ...settingsReads.unread,
        ...settingsReads.tooLarge,
      ];
      if (backendUnread.length > 0) {
        throw unreadRefusal("backend file(s)", backendUnread);
      }

      // buildBackendInventory works on raw text; feed it the parse results by
      // re-projecting them through a content shim so we never refetch a blob.
      inventory = buildBackendInventoryFromAnalysis({
        files,
        migrationObjects: migrationAnalysis.results,
        functionRefs: fnAnalysis.results,
        functionConfig,
        envContents,
      });

      progress(
        "backend_linking",
        `Linking ${inventory.edgeFunctions.size} edge function(s) to modules…`,
        87,
      );

      // Frontend → backend crossing points. Contents are already in the cache
      // from import tracing, so this costs no extra API calls.
      const knownSlugs = new Set(inventory.edgeFunctions.keys());
      const frontendRefs = new Map<string, FrontendBackendRefs>();
      for (const [file, content] of contentCache) {
        const refs = parseFrontendBackendRefs(content, knownSlugs);
        if (
          refs.edgeFunctions.length ||
          refs.indirectEdgeFunctions.length ||
          refs.tables.length ||
          refs.rpcs.length ||
          refs.buckets.length ||
          refs.envVars.length
        ) {
          frontendRefs.set(file, refs);
        }
      }

      const manifests = linkBackendToModules({
        modules: routeModules.map((m) => ({ slug: m.slug, resolvedFiles: m.resolved_files })),
        frontendRefs,
        inventory,
      });

      for (const m of routeModules) {
        const manifest = manifests.get(m.slug);
        if (!manifest) continue;
        m.backend = manifest;
        const hasBackend = manifest.edgeFunctions.length > 0 || manifest.tables.length > 0;
        if (m.layer !== "shared") m.layer = hasBackend ? "fullstack" : "frontend";
        if (config.includeBackendGlobs && manifest.backendGlobs.length > 0) {
          m.file_globs = [...new Set([...m.file_globs, ...manifest.backendGlobs])];
        }
        if (hasBackend) {
          m.ai_reasoning +=
            ` Backend: ${manifest.edgeFunctions.length} edge function(s), ` +
            `${manifest.tables.length} table(s), ${manifest.secrets.length} secret(s), ` +
            `${manifest.migrations.length} migration(s).`;
        }
        // Record the frontend→edge-function crossings as graph edges so the
        // dependency view shows the full path, not just ES imports.
        for (const link of manifest.links) {
          const fn = inventory.edgeFunctions.get(link.identifier);
          if (!fn?.entryFile) continue;
          const source = link.via.includes(" ") ? m.entry_file : link.via;
          backendEdges.push({
            source_file: source,
            target_file: fn.entryFile,
            import_type:
              link.kind === "edge_function_indirect" ? "edge_invoke_indirect" : "edge_invoke",
          });
        }
      }

      // ── Backend-only modules ──
      // Edge functions no route reaches are still deployable surface: cron
      // workers, webhook receivers, provider callbacks. The old detector filed
      // every one of them under "orphan file" noise.
      if (config.synthesizeBackendModules) {
        const claimed = new Set<string>();
        for (const m of routeModules) {
          for (const slug of m.backend.edgeFunctions) claimed.add(slug);
        }
        // `maxModules` bounds *feature* modules. Backend-only modules are one
        // per slug prefix and are the only route by which cron workers and
        // webhook receivers ever reach a clone — capping them at the feature
        // budget would silently strip deployable surface, so give them their
        // own generous bound and report anything still dropped.
        const synthesized = synthesizeBackendModules({
          inventory,
          claimedFunctions: claimed,
          maxModules: BACKEND_MODULE_CAP,
        });
        backendModuleCount = synthesized.length;

        const covered = new Set([...claimed, ...synthesized.flatMap((s) => s.functions)]);
        const uncovered = [...inventory.edgeFunctions.keys()].filter((s) => !covered.has(s));
        if (uncovered.length > 0) {
          console.warn(
            `[detection] ${uncovered.length} edge function(s) belong to no module — ` +
              `backend module cap (${BACKEND_MODULE_CAP}) reached: ${uncovered.slice(0, 10).join(", ")}`,
          );
          await supabase.from("module_drift_alerts").insert(
            uncovered.slice(0, 50).map((slug) => ({
              detection_run_id: runId,
              alert_type: "unclaimed_edge_function",
              file_path:
                inventory?.edgeFunctions.get(slug)?.entryFile ?? `supabase/functions/${slug}`,
              reasoning: `Edge function "${slug}" is not owned by any module, so no module install will deploy it`,
              severity: "warning",
            })),
          );
        }

        for (const s of synthesized) {
          routeModules.push({
            name: s.name,
            slug: s.slug,
            description: s.description,
            route_path: "",
            entry_file:
              inventory.edgeFunctions.get(s.functions[0])?.entryFile ?? "supabase/functions/",
            resolved_files: s.functions.flatMap(
              (fn) => inventory?.edgeFunctions.get(fn)?.files ?? [],
            ),
            file_globs: config.includeBackendGlobs ? s.manifest.backendGlobs : [],
            routes: [],
            shared_by_modules: [],
            cohesion_score: 1,
            coupling_score: 0,
            ai_confidence: 0.9,
            ai_reasoning:
              `Backend-only detection: ${s.functions.length} edge function(s) not referenced ` +
              `by any route. Needs ${s.manifest.tables.length} table(s) and ` +
              `${s.manifest.secrets.length} secret(s).`,
            requires: [],
            incompatible_with: [],
            layer: "backend",
            backend: s.manifest,
          });
        }
      }

      const totalObjects = inventory.migrations.reduce((n, m) => n + m.objects.length, 0);
      backendSummary = {
        edge_functions: inventory.edgeFunctions.size,
        migrations: inventory.migrations.length,
        database_objects: totalObjects,
        tables_indexed: inventory.tableToMigrations.size,
        rpcs_indexed: inventory.rpcToMigrations.size,
        storage_buckets: inventory.storageBuckets,
        cron_jobs: inventory.cronJobs.length,
        extensions: inventory.extensions,
        shared_edge_files: inventory.sharedFiles.length,
        sidecar_services: [...inventory.sidecarServices.keys()],
        workflows: inventory.workflows.length,
        env_template_names: inventory.envTemplateNames.length,
        blob_reads: {
          migrations_fetched: migrationAnalysis.fetched,
          migrations_cached: migrationAnalysis.cached,
          migrations_skipped: migrationAnalysis.skipped,
          functions_fetched: fnAnalysis.fetched,
          functions_cached: fnAnalysis.cached,
          functions_skipped: fnAnalysis.skipped,
          // Never read, by name: what they declare is unknown, not nothing.
          too_large_to_hold: [...migrationAnalysis.tooLarge, ...fnAnalysis.tooLarge],
        },
      };

      if (migrationAnalysis.skipped > 0 || fnAnalysis.skipped > 0) {
        console.warn(
          `[detection] backend scan capped at ${config.maxBackendBlobs} blobs — ` +
            `${migrationAnalysis.skipped} migration(s) and ${fnAnalysis.skipped} function file(s) unread`,
        );
      }
    }

    // The texts were read for their imports and their crossings into the
    // backend, and both are taken: let them go before the run writes.
    const sampledFileCount = contentCache.size;
    contentCache.clear();

    // ── Phase 6: Find orphan files ──
    const coveredFiles = new Set<string>();
    for (const mod of routeModules) {
      for (const f of mod.resolved_files) coveredFiles.add(f);
    }
    const orphanFiles = files
      .filter((f) => !coveredFiles.has(f))
      .filter((f) => /\.(ts|tsx|js|jsx)$/.test(f))
      .filter((f) => !f.includes("routeTree.gen") && !f.includes("__root"))
      // Backend files are classified, owned and reported by the backend pass.
      // Leaving them in would bury genuine frontend orphans under hundreds of
      // edge-function alerts (the alert list is capped at 100).
      .filter((f) => classifyBackendPath(f) === null);

    // Store import edges. Backend crossings go in first: they are the edges
    // that were missing entirely, and the 1000-row cap must not drop them in
    // favour of yet more intra-frontend imports.
    const combinedEdges = [...backendEdges, ...allEdges];
    if (combinedEdges.length > 0) {
      const uniqueEdges = new Map<string, ImportEdge>();
      for (const e of combinedEdges) {
        uniqueEdges.set(`${e.source_file}→${e.target_file}`, e);
      }
      const edgeRows = [...uniqueEdges.values()].slice(0, 2000).map((e) => ({
        detection_run_id: runId,
        source_file: e.source_file,
        target_file: e.target_file,
        import_type: e.import_type,
      }));
      for (let i = 0; i < edgeRows.length; i += 500) {
        await supabase.from("module_import_edges").insert(edgeRows.slice(i, i + 500));
      }
    }

    // Which modules claim each migration — repo-wide infrastructure migrations
    // get claimed by nearly everything, and must not read as exclusively owned.
    const migrationSharing = computeMigrationSharing(
      new Map(routeModules.map((m) => [m.slug, m.backend])),
    );

    // ── Persist modules ──
    progress("persisting", "Saving detection results…", 85);
    let inserted = 0;
    let updated = 0;
    const globRejections: Array<{ slug: string; reason: string; glob: string }> = [];
    const moduleIdBySlug = new Map<string, string>();

    // Sanitise every module's file_globs before hitting the DB: a bad glob
    // here poisons every downstream cascade / tree-walk / re-sync for this
    // module. The modules that keep a glob are the ones the run found.
    const persisted: RouteModule[] = [];
    for (const m of routeModules) {
      const { valid: safeGlobs, invalid: badGlobs } = validateModuleGlobs(m.file_globs);
      for (const bad of badGlobs) {
        globRejections.push({ slug: m.slug, glob: bad.glob, reason: bad.reason });
      }
      m.file_globs = safeGlobs;
      // Skip modules whose entire glob set was rejected — writing an empty
      // list would silently disable cascades for this module.
      if (safeGlobs.length > 0) persisted.push(m);
    }
    const detectedSlugs = persisted.map((m) => m.slug);

    // A follow is asked before any module is written, so a run it would not
    // settle changes nothing a clone receives.
    if (config.follow && args.beforeWriting) {
      const stop = await args.beforeWriting(detectedSlugs);
      if (stop) {
        return {
          ok: false,
          runId,
          proposed: routeModules.length,
          inserted: 0,
          updated: 0,
          orphanAlerts: 0,
          error: stop,
          commitSha,
          detectedSlugs,
          stoppedBeforeWriting: stop,
        };
      }
    }

    for (const m of persisted) {
      // A follow run reads who archived the module, and stops on a read that
      // failed: read as no module, it would insert a second one of the slug.
      const existingRead = config.follow
        ? await supabase
            .from("modules")
            .select("id, status, archived_by_follow_run_id")
            .eq("slug", m.slug)
            .maybeSingle()
        : await supabase.from("modules").select("id, status").eq("slug", m.slug).maybeSingle();
      if (config.follow && existingRead.error) {
        throw new Error(
          `The module ${m.slug} could not be read: ${describeDbError(existingRead.error)}`,
        );
      }
      const existing = existingRead.data as {
        id: string;
        status: string;
        archived_by_follow_run_id?: string | null;
      } | null;

      // Backend surface resolved for this module. Written on every run so an
      // existing module picks up backend detail the first time it is rescanned.
      const backendFields = {
        edge_functions: m.backend.edgeFunctions,
        database_tables: m.backend.tables,
        database_rpcs: m.backend.rpcs,
        storage_buckets: m.backend.buckets,
        cron_jobs: m.backend.cronJobs,
        required_secrets: m.backend.secrets,
        required_migrations: m.backend.migrations,
        backend_file_globs: m.backend.backendGlobs,
        external_hosts: m.backend.externalHosts,
        layer: m.layer,
        backend_manifest: JSON.parse(
          JSON.stringify({
            // The run that found this backend. An approved module has these
            // fields refreshed while it keeps the run that found its files,
            // so publication compares the two: an entry is approved at ONE
            // commit, and two runs read two (libraryApproval.pure.ts).
            detection_run_id: runId,
            links: m.backend.links.slice(0, 200),
            counts: {
              edge_functions: m.backend.edgeFunctions.length,
              tables: m.backend.tables.length,
              rpcs: m.backend.rpcs.length,
              buckets: m.backend.buckets.length,
              secrets: m.backend.secrets.length,
              migrations: m.backend.migrations.length,
              cron_jobs: m.backend.cronJobs.length,
            },
            // Migrations this module shares with others — high counts mean
            // repo-wide infrastructure, not module-private schema.
            shared_migrations: m.backend.migrations
              .map((p) => ({ path: p, claimed_by: migrationSharing.get(p)?.length ?? 1 }))
              .filter((x) => x.claimed_by > 1)
              .slice(0, 100),
          }),
        ),
      };

      // What the run found of the module, written whole wherever the module is
      // rewritten from this run.
      const shape = {
        file_globs: m.file_globs,
        routes: m.routes,
        route_entry_file: m.entry_file,
        resolved_files: m.resolved_files,
        shared_by_modules: m.shared_by_modules,
        ai_confidence: m.ai_confidence,
        ai_reasoning: m.ai_reasoning,
        cohesion_score: m.cohesion_score,
        coupling_score: m.coupling_score,
        requires: m.requires,
        incompatible_with: m.incompatible_with,
        detection_run_id: runId,
        tree_snapshot_hash: treeHash,
        ...backendFields,
      };
      // A follow rewrites an approved module, and one it archived, from the
      // run, so every module it settles names the run that found its files and
      // its backend at one commit. One a person archived keeps its files.
      const followRewrites =
        config.follow === true &&
        (existing?.status === "approved" ||
          (existing?.status === "archived" && existing.archived_by_follow_run_id != null));

      if (existing) {
        if (existing.status === "proposed" || existing.status === "rejected") {
          const { error: writeError } = await supabase
            .from("modules")
            .update({ name: m.name, description: m.description, ...shape })
            .eq("id", existing.id);
          if (writeError && config.follow) throw moduleWriteRefusal(m.slug, writeError);
          updated++;
          moduleIdBySlug.set(m.slug, existing.id);
        } else if (followRewrites) {
          // Its name and description are kept: a person may have written them.
          const { error: writeError } = await supabase
            .from("modules")
            .update(shape)
            .eq("id", existing.id);
          if (writeError) throw moduleWriteRefusal(m.slug, writeError);
          updated++;
          moduleIdBySlug.set(m.slug, existing.id);
        } else if (config.detectBackend) {
          // An approved/archived module keeps its curated shape, but stale or
          // absent backend metadata is worse than none: it drives cascades and
          // secret provisioning. Refresh only the detected backend fields.
          const { error: writeError } = await supabase
            .from("modules")
            .update(backendFields)
            .eq("id", existing.id);
          if (writeError && config.follow) throw moduleWriteRefusal(m.slug, writeError);
          moduleIdBySlug.set(m.slug, existing.id);
        }
      } else {
        const { data: created, error } = await supabase
          .from("modules")
          .insert({
            name: m.name,
            slug: m.slug,
            description: m.description,
            status: "proposed",
            detected_by_ai: false,
            ...shape,
          })
          .select("id")
          .single();
        if (error && config.follow) throw moduleWriteRefusal(m.slug, error);
        if (!error) {
          inserted++;
          if (created?.id) moduleIdBySlug.set(m.slug, created.id);
        }
      }
    }

    // ── Per-artifact linkage rows ──
    // One row per (module, backend artifact) so the UI can answer both
    // "what does this module need?" and "who else claims this table?".
    if (config.detectBackend) {
      type ArtifactRow = Database["public"]["Tables"]["module_backend_artifacts"]["Insert"];
      const artifactRows: ArtifactRow[] = [];
      for (const m of routeModules) {
        const moduleId = moduleIdBySlug.get(m.slug) ?? null;
        const indirect = new Set(
          m.backend.links
            .filter((l) => l.kind === "edge_function_indirect")
            .map((l) => l.identifier),
        );
        const viaBySlug = new Map(m.backend.links.map((l) => [l.identifier, l.via]));

        const add = (
          kind: string,
          ids: string[],
          reason: string,
          confidence: (id: string) => string = () => "direct",
        ) => {
          for (const id of ids) {
            artifactRows.push({
              detection_run_id: runId,
              module_id: moduleId,
              module_slug: m.slug,
              artifact_kind: kind,
              identifier: id,
              file_path: kind === "migration" ? id : null,
              link_reason: viaBySlug.get(id) ?? reason,
              confidence: confidence(id),
              shared_with_modules:
                kind === "migration"
                  ? (migrationSharing.get(id) ?? []).filter((s) => s !== m.slug).slice(0, 50)
                  : [],
            });
          }
        };

        add("edge_function", m.backend.edgeFunctions, "linked from module source", (id) =>
          indirect.has(id) ? "indirect" : "direct",
        );
        add("table", m.backend.tables, "queried by module or its edge functions");
        add("rpc", m.backend.rpcs, "called via .rpc()");
        add("secret", m.backend.secrets, "required by module's edge functions");
        add("migration", m.backend.migrations, "declares a table/function this module uses");
        add("storage_bucket", m.backend.buckets, "read or written by module");
        add("cron_job", m.backend.cronJobs, "scheduled by module's migrations");
      }

      for (let i = 0; i < artifactRows.length; i += 500) {
        await supabase.from("module_backend_artifacts").insert(artifactRows.slice(i, i + 500));
      }
    }

    // Drift alerts for orphans
    let orphanAlerts = 0;
    if (orphanFiles.length > 0) {
      progress("drift_alerts", "Creating drift alerts for uncovered files…", 90);
      const alerts = orphanFiles.slice(0, 100).map((f) => ({
        detection_run_id: runId,
        alert_type: "orphan_file",
        file_path: f,
        reasoning: `File not reachable from any route's import tree`,
        severity: "info",
      }));
      const { error: alertErr } = await supabase.from("module_drift_alerts").insert(alerts);
      if (!alertErr) orphanAlerts = alerts.length;
    }

    // Finalize run
    progress("complete", "Detection complete!", 100);
    const passes: PassResult[] = [
      {
        pass: 1,
        name: "Route-first import tracing",
        model: "deterministic",
        duration_ms: 0,
        modules_proposed: routeModules.length,
        summary: partitionStats
          ? `Feature-first: partitioned ${partitionStats.filesPartitioned} files into ` +
            `${routeModules.length} disjoint modules (overlap ${partitionStats.overlapFactor}x, ` +
            `${partitionStats.platformCoreFiles} shared into platform-core, ` +
            `${partitionStats.pathCount} paths compacted to ${partitionStats.globCount} globs)`
          : `Traced ${routeModules.length} route modules from ${routeFiles.length} route files, ${sharedFiles.length} shared files, ${orphanFiles.length} orphans`,
      },
    ];

    if (inventory) {
      const totalObjects = inventory.migrations.reduce((n, mm) => n + mm.objects.length, 0);
      const linkedFns = new Set(routeModules.flatMap((m) => m.backend.edgeFunctions));
      passes.push({
        pass: 2,
        name: "Backend architecture linking",
        model: "deterministic",
        duration_ms: 0,
        modules_proposed: backendModuleCount,
        summary:
          `Indexed ${inventory.edgeFunctions.size} edge functions, ${inventory.migrations.length} migrations ` +
          `(${totalObjects} schema objects); linked ${linkedFns.size} function(s) to modules and ` +
          `synthesized ${backendModuleCount} backend-only module(s)`,
      });
    }

    const totalSecrets = new Set(routeModules.flatMap((m) => m.backend.secrets)).size;

    // A follow run stays `running` until the follow has settled the
    // catalogue at it, so a reset or a detection meets it throughout. Its
    // tree hash, written here and nowhere else in follow mode, says the run
    // has written every module it found: a follow whose invocation ended
    // after this settles the run at a later tick rather than detect again
    // (`libraryFollow.pure.ts`). So a follow run that cannot say so stops.
    const { error: finishError } = await supabase
      .from("module_detection_runs")
      .update({
        status: config.follow ? "running" : "completed",
        tree_hash: treeHash,
        file_count: files.length,
        sampled_file_count: sampledFileCount,
        dependency_count: allEdges.length + backendEdges.length,
        pass_count: passes.length,
        passes: JSON.parse(JSON.stringify(passes)),
        proposed_modules: routeModules.length,
        inserted_modules: inserted,
        updated_modules: updated,
        orphan_files_found: orphanAlerts,
        edge_function_count: inventory?.edgeFunctions.size ?? 0,
        migration_count: inventory?.migrations.length ?? 0,
        database_object_count: inventory
          ? inventory.migrations.reduce((n, mm) => n + mm.objects.length, 0)
          : 0,
        secret_count: totalSecrets,
        backend_module_count: backendModuleCount,
        backend_summary: JSON.parse(
          JSON.stringify({ ...backendSummary, trace_too_large_to_hold: traceReads.tooLarge }),
        ),
        completed_at: config.follow ? null : new Date().toISOString(),
      })
      .eq("id", runId);
    if (finishError && config.follow) {
      throw new Error(
        `The run's findings were not recorded on it: ${describeDbError(finishError)}`,
      );
    }

    await supabase.from("audit_log").insert({
      action: "module.route_detection_complete",
      entity_type: "module_detection_run",
      entity_id: runId,
      actor_user_id: userId,
      metadata: {
        strategy: config.strategy,
        file_count: files.length,
        route_files: routeFiles.length,
        proposed: routeModules.length,
        shared_files: sharedFiles.length,
        orphan_files: orphanFiles.length,
        inserted,
        updated,
        rejected_globs: globRejections.slice(0, 50),
        rejected_glob_count: globRejections.length,
        backend_detected: config.detectBackend,
        backend_summary: JSON.parse(JSON.stringify(backendSummary)),
        backend_modules: backendModuleCount,
      },
    });

    return {
      ok: true,
      runId,
      proposed: routeModules.length,
      inserted,
      updated,
      orphanAlerts,
      commitSha,
      detectedSlugs,
    };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    console.error("Detection run failed:", errorMsg);
    await supabase
      .from("module_detection_runs")
      .update({
        status: "failed",
        error_message: errorMsg,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
    return {
      ok: false,
      runId,
      proposed: 0,
      inserted: 0,
      updated: 0,
      orphanAlerts: 0,
      error: errorMsg,
      commitSha: readCommit,
    };
  }
}

// ─── Cross-Clone Intelligence ───────────────────────────────────────

export async function analyzeModuleIntelligence(supabase: Supabase): Promise<{
  coInstallation: Array<{ module_a: string; module_b: string; coInstallRate: number }>;
  healthScores: Array<{
    moduleId: string;
    moduleName: string;
    score: number;
    breakdown: Record<string, number>;
  }>;
}> {
  const { data: cloneModules } = await supabase
    .from("clone_modules")
    .select("clone_id, module_id, modules(name, slug)");

  const byClone = new Map<string, string[]>();
  const moduleNames = new Map<string, string>();
  for (const row of (cloneModules ?? []) as Array<{
    clone_id: string;
    module_id: string;
    modules: { name: string; slug: string } | null;
  }>) {
    if (!row.modules) continue;
    const list = byClone.get(row.clone_id) ?? [];
    list.push(row.module_id);
    byClone.set(row.clone_id, list);
    moduleNames.set(row.module_id, row.modules.name);
  }

  const pairCounts = new Map<string, number>();
  const moduleCounts = new Map<string, number>();
  for (const mods of byClone.values()) {
    for (const m of mods) {
      moduleCounts.set(m, (moduleCounts.get(m) ?? 0) + 1);
    }
    for (let i = 0; i < mods.length; i++) {
      for (let j = i + 1; j < mods.length; j++) {
        const key = [mods[i], mods[j]].sort().join(":");
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const totalClones = byClone.size;
  const coInstallation = [...pairCounts.entries()]
    .map(([key, count]) => {
      const [a, b] = key.split(":");
      return {
        module_a: moduleNames.get(a) ?? a,
        module_b: moduleNames.get(b) ?? b,
        coInstallRate: totalClones > 0 ? count / totalClones : 0,
      };
    })
    .filter((p) => p.coInstallRate > 0.3)
    .sort((a, b) => b.coInstallRate - a.coInstallRate)
    .slice(0, 20);

  const { data: modules } = await supabase
    .from("modules")
    .select("id, name, slug, ai_confidence, cohesion_score, coupling_score");
  const { data: clones } = await supabase.from("clones").select("id, sync_status");

  const cloneStatusMap = new Map<string, string>();
  for (const c of clones ?? []) cloneStatusMap.set(c.id, c.sync_status);

  const healthScores = (modules ?? [])
    .map((m) => {
      const moduleClones = (cloneModules ?? [])
        .filter((cm: { module_id: string }) => cm.module_id === m.id)
        .map((cm: { clone_id: string }) => cm.clone_id);

      const inSync = moduleClones.filter(
        (cid: string) => cloneStatusMap.get(cid) === "in_sync",
      ).length;
      const failed = moduleClones.filter(
        (cid: string) => cloneStatusMap.get(cid) === "failed",
      ).length;

      const syncRate = moduleClones.length > 0 ? inSync / moduleClones.length : 0;
      const failRate = moduleClones.length > 0 ? failed / moduleClones.length : 0;
      const cohesion = Number(m.cohesion_score) || 0.5;
      const coupling = Number(m.coupling_score) || 0.5;
      const confidence = Number(m.ai_confidence) || 0.5;
      const coverage = totalClones > 0 ? moduleClones.length / totalClones : 0;

      const score =
        Math.round(
          (syncRate * 30 +
            (1 - failRate) * 25 +
            cohesion * 20 +
            (1 - coupling) * 15 +
            confidence * 10) *
            100,
        ) / 100;

      return {
        moduleId: m.id,
        moduleName: m.name,
        score,
        breakdown: {
          sync_rate: Math.round(syncRate * 100),
          fail_rate: Math.round(failRate * 100),
          cohesion: Math.round(cohesion * 100),
          coupling: Math.round(coupling * 100),
          confidence: Math.round(confidence * 100),
          coverage: Math.round(coverage * 100),
          clone_count: moduleClones.length,
        },
      };
    })
    .sort((a, b) => b.score - a.score);

  return { coInstallation, healthScores };
}
