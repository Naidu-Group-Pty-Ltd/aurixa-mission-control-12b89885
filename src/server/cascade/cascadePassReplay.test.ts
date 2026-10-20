/**
 * A CASCADE PASS, REPLAYED LOCALLY — opt-in, and skipped unless
 * `CASCADE_REPLAY=1`. See `docs/CASCADE_PASS_REPLAY.md` for how to gather a
 * clone's world and read the report.
 *
 * Runs `processClone` for one clone against local git clones of the source and
 * the clone. Every GitHub request is answered from git and charged a latency
 * modelled on production, and every stage the engine enters is timed, counted
 * and charged its CPU, so a change to the engine can be measured on a real
 * pass before it ships rather than after.
 *
 * Built 20 Oct 2026 for F29: the CRM line's pass was ended in `recount` every
 * time, and the trace could say where but not why. The replay reproduced the
 * production trace to within ~15% stage by stage, then showed what each pass
 * spent and why no pass converged.
 *
 * Nothing here reaches GitHub or Mission Control. Writes (blobs, trees,
 * commits, refs, pull requests) are answered in memory; blobs persist under
 * the replay directory between runs, as they would on GitHub, so successive
 * budgeted passes can be replayed with the ledger each one kept.
 */
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

vi.mock("@/integrations/supabase/client.server", () => {
  // `processClone` reads its tables through the client it is handed; this
  // only satisfies modules that import the admin client at load.
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const m of ["select", "eq", "in", "is", "gt", "lt", "order", "limit", "update", "insert"]) {
    chain[m] = self;
  }
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  return { supabaseAdmin: { from: () => chain } };
});

const env = process.env;
const ENABLED = env.CASCADE_REPLAY === "1";
const DIR = env.REPLAY_DIR ?? "";
/** Real milliseconds slept per modelled millisecond. 0 counts and times CPU only. */
const SCALE = Number(env.REPLAY_SCALE ?? "0");
/** A multiplier on the model, for a production slower than it (1.2 matched the 20 Oct trace). */
const LAT_FACTOR = Number(env.REPLAY_LAT_FACTOR ?? "1");
/** The drain's budget for the pass, measured from 1.5 s before it starts. Unset: none. */
const BUDGET_MS = env.REPLAY_BUDGET_MS ? Number(env.REPLAY_BUDGET_MS) : null;
const TAG = env.REPLAY_TAG ? `-${env.REPLAY_TAG}` : "";

type Repo = { owner: string; name: string; dir: string; head: string; branch: string };

function repoFromEnv(prefix: "PRIME" | "CLONE"): Repo {
  const slug = env[`REPLAY_${prefix}_REPO`] ?? "";
  const [owner, name] = slug.split("/");
  return {
    owner: owner ?? "",
    name: name ?? "",
    dir: env[`REPLAY_${prefix}_DIR`] ?? "",
    head: env[`REPLAY_${prefix}_HEAD`] ?? "",
    branch: env[`REPLAY_${prefix}_BRANCH`] ?? "main",
  };
}
const PRIME = repoFromEnv("PRIME");
const CLONE = repoFromEnv("CLONE");

// ── Git, as GitHub would answer it ─────────────────────────────────────────

function git(repo: Repo, args: string[], input?: string): Buffer {
  const r = spawnSync("git", ["-C", repo.dir, ...args], { input, maxBuffer: 1 << 30 });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().slice(0, 300)}`);
  return r.stdout;
}

const createdDir = (repo: Repo) => `${DIR}/created/${repo.name}`;
function createdBlob(repo: Repo, sha: string): Buffer | null {
  const file = `${createdDir(repo)}/${sha}`;
  return existsSync(file) ? readFileSync(file) : null;
}

const blobCache = new Map<string, Buffer | null>();
function blob(repo: Repo, sha: string): Buffer | null {
  const key = `${repo.name}:${sha}`;
  if (!blobCache.has(key)) {
    const r = spawnSync("git", ["-C", repo.dir, "cat-file", "blob", sha], { maxBuffer: 1 << 30 });
    blobCache.set(key, r.status === 0 ? r.stdout : createdBlob(repo, sha));
  }
  return blobCache.get(key) ?? null;
}

function blobs(repo: Repo, shas: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const r = spawnSync("git", ["-C", repo.dir, "cat-file", "--batch"], {
    input: shas.join("\n") + "\n",
    maxBuffer: 1 << 30,
  });
  let at = 0;
  while (at < r.stdout.length) {
    const nl = r.stdout.indexOf(10, at);
    const [sha, type, size] = r.stdout.subarray(at, nl).toString().split(" ");
    at = nl + 1;
    if (size === undefined) continue;
    const n = Number(size);
    if (type === "blob") out.set(sha, Buffer.from(r.stdout.subarray(at, at + n)));
    at += n + 1;
  }
  for (const sha of shas) {
    const made = out.has(sha) ? null : createdBlob(repo, sha);
    if (made) out.set(sha, made);
  }
  return out;
}

function resolve(repo: Repo, ref: string | undefined): string {
  if (!ref || ref === repo.branch || ref === `heads/${repo.branch}`) return repo.head;
  return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])
    .toString()
    .trim();
}

type Entry = { mode: string; type: string; sha: string; size: number | null; path: string };
function lsTree(repo: Repo, treeish: string, recursive: boolean, path?: string): Entry[] {
  const args = ["ls-tree", "-l", "-z", ...(recursive ? ["-r"] : []), treeish];
  if (path !== undefined) args.push("--", path);
  return git(repo, args)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode, type, sha, size] = line.slice(0, tab).split(/\s+/);
      return {
        mode,
        type,
        sha,
        size: size === "-" ? null : Number(size),
        path: line.slice(tab + 1),
      };
    });
}

function repoOf(owner: unknown, name: unknown): Repo {
  if (name === PRIME.name) return PRIME;
  if (name === CLONE.name) return CLONE;
  throw new Error(`replay: no repository ${String(owner)}/${String(name)}`);
}

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });
const gitBlobId = (bytes: Buffer) =>
  createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest("hex");

// ── What each request costs, in production milliseconds ────────────────────

/** Fitted to the 11:03 UTC trace of 20 Oct 2026; × 1.2 matched it stage by stage. */
const LATENCY: Record<string, (x: { bytes?: number; entries?: number; n?: number }) => number> = {
  "repos.getBranch": () => 300,
  "git.getTree": ({ entries = 0 }) => 300 + entries * 0.2,
  "repos.getContent": ({ bytes = 0 }) => 280 + bytes / 2000,
  "git.getBlob": ({ bytes = 0 }) => 300 + bytes / 2000,
  "git.getCommit": () => 250,
  "repos.getCommit": () => 300,
  "repos.listCommits": () => 450,
  "graphql:blob": ({ bytes = 0 }) => 450 + bytes / 1000,
  "graphql:version": ({ n = 0 }) => 600 + n * 8,
  "git.createBlob": ({ bytes = 0 }) => 350 + bytes / 4000,
  "git.createTree": ({ entries = 0 }) => 300 + entries * 20,
  "git.createCommit": () => 450,
  "pulls.create": () => 1200,
  "pulls.update": () => 600,
};

type Call = { stage: string; method: string; ms: number; detail: string };
const calls: Call[] = [];
let stage = "pre";
let handlerStart = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * SCALE));
const begin = () => {
  handlerStart = Date.now();
};
/** Records one request and waits its latency, less what answering it from git took. */
async function charge(method: string, x: Parameters<(typeof LATENCY)[string]>[0], detail = "") {
  const ms = (LATENCY[method] ?? (() => 350))(x) * LAT_FACTOR;
  const own = Date.now() - handlerStart;
  calls.push({ stage, method, ms, detail });
  await sleep(Math.max(0, ms - (SCALE > 0 ? own / SCALE : 0)));
}

// ── The delivery, as it would land ─────────────────────────────────────────

const delivery = createHash("sha256");
let deliveryEntries = 0;
const proposals: string[] = [];
const commits = new Map<string, { tree: string; parents: string[]; message: string }>();

type A = Record<string, unknown>;
const s = (a: A, k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);

function fakeOctokit(openPr: A | null) {
  const ns = (name: string, impl: Record<string, (a: A) => Promise<unknown>>) =>
    new Proxy(impl, {
      get: (target, prop: string) =>
        prop in target
          ? target[prop]
          : async () => {
              throw new Error(`replay: octokit.${name}.${prop} is not modelled`);
            },
    });
  return {
    repos: ns("repos", {
      async getBranch(a) {
        begin();
        const repo = repoOf(a.owner, a.repo);
        const sha = resolve(repo, s(a, "branch"));
        const tree = git(repo, ["rev-parse", `${sha}^{tree}`])
          .toString()
          .trim();
        await charge("repos.getBranch", {}, `${repo.name}@${s(a, "branch")}`);
        return { data: { name: a.branch, commit: { sha, commit: { tree: { sha: tree } } } } };
      },
      async getContent(a) {
        begin();
        const repo = repoOf(a.owner, a.repo);
        const commit = resolve(repo, s(a, "ref"));
        const path = (s(a, "path") ?? "").replace(/\/$/, "");
        const entry = lsTree(repo, commit, false, path).find((e) => e.path === path);
        if (!entry) {
          await charge("repos.getContent", {}, `${repo.name}:${path} (404)`);
          throw notFound();
        }
        if (entry.type === "tree") {
          const kids = lsTree(repo, commit, false, `${path}/`);
          await charge("repos.getContent", { bytes: kids.length * 200 }, `${repo.name}:${path}/`);
          return {
            data: kids.map((k) => ({
              name: k.path.slice(path.length + 1),
              path: k.path,
              sha: k.sha,
              size: k.size ?? 0,
              type: k.type === "tree" ? "dir" : "file",
            })),
          };
        }
        const bytes = blob(repo, entry.sha) ?? Buffer.alloc(0);
        // Past 1 MB the contents API answers with metadata alone.
        const big = bytes.length > 1_000_000;
        await charge("repos.getContent", { bytes: big ? 0 : bytes.length }, `${repo.name}:${path}`);
        return {
          data: {
            type: "file",
            path,
            sha: entry.sha,
            size: bytes.length,
            encoding: big ? "none" : "base64",
            content: big ? "" : bytes.toString("base64"),
          },
        };
      },
      async getCommit(a) {
        begin();
        const repo = repoOf(a.owner, a.repo);
        await charge("repos.getCommit", {}, `${repo.name}:${s(a, "ref")}`);
        try {
          return { data: { sha: resolve(repo, s(a, "ref")), commit: { message: "" }, files: [] } };
        } catch {
          throw Object.assign(new Error(`No commit found for SHA: ${s(a, "ref")}`), {
            status: 422,
          });
        }
      },
      async listCommits(a) {
        begin();
        const repo = repoOf(a.owner, a.repo);
        const args = ["log", "--format=%H%x1f%B%x1e", "-n", String(a.per_page ?? 30)];
        args.push(resolve(repo, s(a, "sha")));
        const path = s(a, "path");
        if (path) args.push("--", path);
        const out = git(repo, args).toString("utf8");
        await charge("repos.listCommits", {}, `${repo.name}:${path ?? ""}`);
        return {
          data: out
            .split("\x1e")
            .map((r) => r.trim())
            .filter(Boolean)
            .map((r) => {
              const [sha, message] = r.split("\x1f");
              return { sha: sha.trim(), commit: { message: (message ?? "").trim() } };
            }),
        };
      },
    }),
    git: ns("git", {
      async getTree(a) {
        begin();
        const repo = repoOf(a.owner, a.repo);
        const entries = lsTree(repo, s(a, "tree_sha") ?? "", Boolean(a.recursive));
        await charge("git.getTree", { entries: entries.length }, `${repo.name} ${entries.length}`);
        return {
          data: {
            sha: a.tree_sha,
            truncated: false,
            tree: entries.map((e) => ({ ...e, size: e.size ?? undefined })),
          },
        };
      },
      async getBlob(a) {
        begin();
        const repo = repoOf(a.owner, a.repo);
        const bytes = blob(repo, s(a, "file_sha") ?? "");
        await charge("git.getBlob", { bytes: bytes?.length ?? 0 }, repo.name);
        if (!bytes) throw notFound();
        return { data: { sha: a.file_sha, encoding: "base64", content: bytes.toString("base64") } };
      },
      async getCommit(a) {
        begin();
        const repo = repoOf(a.owner, a.repo);
        const sha = s(a, "commit_sha") ?? "";
        await charge("git.getCommit", {}, `${repo.name}:${sha.slice(0, 7)}`);
        const made = commits.get(sha);
        if (made) {
          return {
            data: { sha, tree: { sha: made.tree }, parents: made.parents.map((p) => ({ sha: p })) },
          };
        }
        const raw = git(repo, ["cat-file", "commit", sha]).toString("utf8");
        const tree = /^tree ([0-9a-f]{40})/m.exec(raw)?.[1];
        const parents = [...raw.matchAll(/^parent ([0-9a-f]{40})/gm)].map((m) => ({ sha: m[1] }));
        return {
          data: {
            sha,
            tree: { sha: tree },
            parents,
            message: raw.split("\n\n").slice(1).join("\n\n"),
          },
        };
      },
      async createBlob(a) {
        begin();
        const repo = repoOf(a.owner, a.repo);
        const bytes = Buffer.from(
          s(a, "content") ?? "",
          a.encoding === "base64" ? "base64" : "utf8",
        );
        const sha = gitBlobId(bytes);
        mkdirSync(createdDir(repo), { recursive: true });
        writeFileSync(`${createdDir(repo)}/${sha}`, bytes);
        blobCache.set(`${repo.name}:${sha}`, bytes);
        await charge("git.createBlob", { bytes: bytes.length }, repo.name);
        return { data: { sha } };
      },
      async createTree(a) {
        begin();
        const tree = (a.tree ?? []) as Array<{
          path: string;
          mode: string;
          type: string;
          sha?: string | null;
          content?: string;
        }>;
        for (const e of tree) {
          const content =
            e.content !== undefined ? gitBlobId(Buffer.from(e.content, "utf8")) : (e.sha ?? null);
          delivery.update(JSON.stringify([e.path, e.mode, e.type, content]));
          deliveryEntries += 1;
        }
        await charge("git.createTree", { entries: tree.length }, `${tree.length} entries`);
        return {
          data: {
            sha: createHash("sha1")
              .update(JSON.stringify([a.base_tree, tree]))
              .digest("hex"),
          },
        };
      },
      async createCommit(a) {
        begin();
        const sha = createHash("sha1")
          .update(JSON.stringify([a.tree, a.parents, a.message]))
          .digest("hex");
        commits.set(sha, {
          tree: s(a, "tree") ?? "",
          parents: (a.parents ?? []) as string[],
          message: s(a, "message") ?? "",
        });
        await charge("git.createCommit", {});
        return { data: { sha, tree: { sha: a.tree } } };
      },
      async createRef() {
        begin();
        await charge("git.createRef", {});
        return { data: {} };
      },
      async updateRef() {
        begin();
        await charge("git.updateRef", {});
        return { data: {} };
      },
    }),
    pulls: ns("pulls", {
      async list() {
        begin();
        await charge("pulls.list", {});
        return { data: openPr ? [openPr] : [] };
      },
      async listCommits() {
        begin();
        await charge("pulls.listCommits", {});
        return { data: [] };
      },
      async create(a) {
        begin();
        proposals.push(`${s(a, "title")}\n${s(a, "body")}`);
        await charge("pulls.create", {}, s(a, "title"));
        return {
          data: { number: 999, html_url: "https://example.invalid/pull/999", node_id: null },
        };
      },
      async update(a) {
        begin();
        proposals.push(`${s(a, "title")}\n${s(a, "body")}`);
        await charge("pulls.update", {});
        return {
          data: {
            number: a.pull_number,
            html_url: "https://example.invalid/pull/0",
            node_id: null,
          },
        };
      },
    }),
    checks: ns("checks", {
      async listForRef() {
        begin();
        await charge("checks.listForRef", {});
        return { data: { total_count: 0, check_runs: [] } };
      },
    }),
    issues: ns("issues", {
      async create() {
        begin();
        await charge("issues.create", {});
        return { data: { number: 1, html_url: "https://example.invalid/issues/1" } };
      },
    }),
    async graphql(query: string, vars: Record<string, string>) {
      begin();
      const repo = repoOf(vars.owner, vars.repo);
      const repository: Record<string, unknown> = {};
      const texts = [
        ...query.matchAll(
          /(b\d+): object\(oid: "([0-9a-f]{40})"\) \{ \.\.\. on Blob \{ text isBinary isTruncated \} \}/g,
        ),
      ];
      const versions = [
        ...query.matchAll(
          /(p\d+c\d+): object\(oid: "([0-9a-f]{40})"\) \{ \.\.\. on Commit \{ file\(path: \$(p\d+)\) \{ oid mode type \} \} \}/g,
        ),
      ];
      if (texts.length > 0) {
        const got = blobs(
          repo,
          texts.map((m) => m[2]),
        );
        let bytes = 0;
        for (const [, alias, sha] of texts) {
          const b = got.get(sha);
          if (!b) {
            repository[alias] = null;
            continue;
          }
          bytes += b.length;
          const text = b.toString("utf8");
          const binary = b.includes(0) || !Buffer.from(text, "utf8").equals(b);
          repository[alias] = { text: binary ? null : text, isBinary: binary, isTruncated: false };
        }
        await charge("graphql:blob", { bytes }, `${repo.name} ${texts.length} blobs`);
      } else if (versions.length > 0) {
        for (const [, alias, commit, variable] of versions) {
          const path = vars[variable];
          const e = lsTree(repo, commit, false, path).find((x) => x.path === path);
          repository[alias] = {
            file: e ? { oid: e.sha, mode: Number.parseInt(e.mode, 8), type: e.type } : null,
          };
        }
        await charge("graphql:version", { n: versions.length }, `${repo.name} ${versions.length}`);
      } else {
        throw new Error(`replay: a GraphQL shape that is not modelled: ${query.slice(0, 160)}`);
      }
      return { repository };
    },
  };
}

// ── Mission Control's four tables `processClone` reads ─────────────────────

type World = {
  clone: Record<string, unknown> & { id: string };
  exclusions: unknown[];
  backend: unknown;
  approvals?: unknown[];
  pins?: unknown[];
  modules: Array<{ slug: string; file_globs: string[] | null }>;
  open_pr?: A | null;
};

function fakeSupabase(world: World) {
  const tables: Record<string, unknown[]> = {
    clone_sync_exclusions: world.exclusions,
    clone_backends_safe: world.backend ? [world.backend] : [],
    cascade_path_approvals: world.approvals ?? [],
    clone_modules: world.modules.map((m) => ({ modules: m })),
    clone_library_pins: world.pins ?? [],
    module_library: [],
  };
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const answer = async () => {
        await sleep(60 * LAT_FACTOR);
        return { data: rows, error: null };
      };
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "gt", "lt", "order", "limit"]) q[m] = () => q;
      q.maybeSingle = async () => ({ ...(await answer()), data: rows[0] ?? null });
      q.then = (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
        answer().then(ok, fail);
      return q;
    },
  };
}

// ── The pass ───────────────────────────────────────────────────────────────

describe.skipIf(!ENABLED)("a cascade pass, replayed against local git", () => {
  it(
    "runs processClone and writes what each stage spent",
    async () => {
      for (const [k, v] of Object.entries({
        REPLAY_DIR: DIR,
        PRIME: PRIME.dir,
        CLONE: CLONE.dir,
      })) {
        expect(v, `${k} is not set — see docs/CASCADE_PASS_REPLAY.md`).not.toBe("");
      }
      const { processClone } = await import("@/server/cascade-engine.server");
      const world = JSON.parse(readFileSync(`${DIR}/world.json`, "utf8")) as World;
      const ledgerPath = env.REPLAY_LEDGER ?? `${DIR}/progress.json`;
      const progress = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : null;

      const stages: Array<[string, number]> = [];
      const cpu = new Map<string, number>();
      const flushes: Array<{ at: number; progress: unknown }> = [];
      const warnings: string[] = [];
      const warn = console.warn;
      console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" ").slice(0, 400));
      const started = Date.now();
      let cpuMark = process.cpuUsage().user + process.cpuUsage().system;
      const markCpu = () => {
        const now = process.cpuUsage();
        cpu.set(stage, (cpu.get(stage) ?? 0) + (now.user + now.system - cpuMark) / 1000);
        cpuMark = now.user + now.system;
      };
      let result: Record<string, unknown>;
      try {
        result = (await processClone({
          octokit: fakeOctokit(world.open_pr ?? null) as never,
          primeRef: { owner: PRIME.owner, repo: PRIME.name, branch: PRIME.branch },
          sourceSha: PRIME.head,
          mode: "pr",
          clone: world.clone as never,
          supabase: fakeSupabase(world) as never,
          scopeFilter: { scope: "selected", clone_ids: [world.clone.id] },
          resume: {
            progress,
            onProgress: async (p) => {
              flushes.push({ at: Date.now() - started, progress: JSON.parse(JSON.stringify(p)) });
            },
            budget:
              BUDGET_MS === null
                ? undefined
                : {
                    isPastDeadline: (reserve) => Date.now() + reserve >= started - 1500 + BUDGET_MS,
                  },
            onPhase: (next, atMs) => {
              markCpu();
              stage = next;
              stages.push([next, atMs]);
            },
          },
        })) as Record<string, unknown>;
      } finally {
        markCpu();
        console.warn = warn;
      }

      const byStage = new Map<string, { calls: number; methods: Record<string, number> }>();
      for (const c of calls) {
        const e = byStage.get(c.stage) ?? { calls: 0, methods: {} };
        e.calls += 1;
        e.methods[c.method] = (e.methods[c.method] ?? 0) + 1;
        byStage.set(c.stage, e);
      }
      const { progress: kept, completed_at: _c, started_at: _s, ...outcome } = result;
      const report = {
        wall_ms: Date.now() - started,
        scale: SCALE,
        latency_factor: LAT_FACTOR,
        budget_ms: BUDGET_MS,
        status: result.status,
        diff_summary: result.diff_summary,
        files_changed: result.files_changed,
        stages,
        requests: calls.length,
        by_stage: Object.fromEntries(
          [...byStage].map(([k, v]) => [k, { ...v, cpu_ms: Math.round(cpu.get(k) ?? 0) }]),
        ),
        delivery_entries: deliveryEntries,
        delivery_digest: delivery.digest("hex"),
        proposal_digest: createHash("sha256").update(proposals.join("\n---\n")).digest("hex"),
        outcome_digest: createHash("sha256").update(JSON.stringify(outcome)).digest("hex"),
        ledger_writes: flushes.map((f) => f.at),
        warnings,
      };
      writeFileSync(`${DIR}/report${TAG}.json`, JSON.stringify(report, null, 2));
      writeFileSync(`${DIR}/requests${TAG}.json`, JSON.stringify(calls));
      writeFileSync(`${DIR}/ledger-writes${TAG}.json`, JSON.stringify(flushes));
      const ledger = kept ?? flushes[flushes.length - 1]?.progress ?? null;
      if (ledger) writeFileSync(`${DIR}/ledger${TAG}.json`, JSON.stringify(ledger));
      expect(stages.length).toBeGreaterThan(0);
    },
    60 * 60 * 1000,
  );
});
