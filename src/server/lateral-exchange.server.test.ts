/**
 * The lateral lane, run end to end against a GitHub and a ledger it can be
 * watched against.
 *
 * `cascade/lateralExchange.pure.test` asserts every RULE without a token. What
 * it cannot see is the engine around them — which head a read is pinned to,
 * which branch a proposal lands on, whether a second slot re-proposes what the
 * first already did, whether a person's decline or a person's commits survive
 * the next pass, whether a pause holds. Those are properties of the I/O, and
 * the only way to assert them is to run it.
 *
 * So GitHub is an in-memory object store with git's own semantics where the
 * lane depends on them: content-addressed blobs (the sha a proposal is compared
 * on is git's), path history with default simplification (a merge that took
 * the lane's copy does not list itself), a pull request's head following its
 * branch. `listTreeAt` and `getFileContent` are the REAL helpers, run over it.
 * The ledger is `audit_log` as rows.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CRM_DEPENDENT_PARENT as DEP,
  CRM_INDEPENDENT_PARENT as IND,
  FLEET_LATERALS,
} from "@/lib/cascade/membrane/lateralMembranes.pure";
import {
  LATERAL_COMMIT_PREFIX,
  LATERAL_LEDGER_ACTION,
  SUPERSEDED_MARKER,
  lateralBranchName,
  readLateralLedger,
} from "./cascade/lateralExchange.pure";

const current = vi.hoisted(() => ({ octokit: null as unknown }));

vi.mock("./github-app.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-app.server")>();
  return { ...actual, getAppOctokit: () => current.octokit };
});
vi.mock("./githubAllowance.server", () => ({ readGitHubRemaining: async () => 4_000 }));
vi.mock("./githubUsageMeter", () => ({
  beginGithubLane: () => {},
  flushGithubUsage: async () => {},
  countGithubCall: () => {},
}));

import {
  readLateralExchangeLedger,
  runLateralExchange,
  setLateralExchangePaused,
} from "./lateral-exchange.server";

// ─────────────────────────────────────────────────────────────────────────────
// A GitHub with git's semantics where the lane depends on them
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = "o";
const PRIME = "npc-property-dashbord";

type Entry = { sha: string; mode: string };
type Tree = Map<string, Entry>;
type Commit = { sha: string; parents: string[]; treeSha: string; message: string };
type Pull = {
  repo: string;
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  title: string;
  body: string;
  headRef: string;
  baseRef: string;
  node_id: string;
  auto_merge: { enabledAt: string } | null;
};

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
const httpError = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

class FakeGitHub {
  blobs = new Map<string, string>();
  trees = new Map<string, Tree>();
  commits = new Map<string, Commit>();
  refs = new Map<string, Map<string, string>>();
  pulls: Pull[] = [];
  checks = new Map<string, Array<{ name: string; status: string; conclusion: string | null }>>();
  /** GitHub refusing to arm auto-merge, as it does where there is nothing to wait for. */
  armRefused = false;
  /** A status to answer a contents read with, where the test wants one to fail. */
  failContent: ((repo: string, path: string, ref: string) => number | null) | null = null;
  writes: Array<{ op: string; repo: string; detail?: string }> = [];
  private seq = 0;

  putBlob(content: string): string {
    const sha = gitBlobSha(content);
    this.blobs.set(sha, content);
    return sha;
  }
  putTree(tree: Tree): string {
    const canonical = [...tree]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([p, e]) => [p, e.sha, e.mode]);
    const sha = sha1(`tree:${JSON.stringify(canonical)}`);
    this.trees.set(sha, new Map(tree));
    return sha;
  }
  putCommit(treeSha: string, parents: string[], message: string): string {
    const sha = sha1(`commit:${treeSha}:${parents.join(",")}:${message}:${this.seq++}`);
    this.commits.set(sha, { sha, parents, treeSha, message });
    return sha;
  }
  head(repo: string, branch: string): string | undefined {
    return this.refs.get(repo)?.get(branch);
  }
  setRef(repo: string, branch: string, sha: string): void {
    if (!this.refs.has(repo)) this.refs.set(repo, new Map());
    this.refs.get(repo)!.set(branch, sha);
  }
  treeOf(commitSha: string): Tree {
    return this.trees.get(this.commits.get(commitSha)!.treeSha)!;
  }
  /** A ref is a branch name or a commit sha — GitHub accepts both. */
  resolve(repo: string, ref: string): string {
    const sha = this.head(repo, ref) ?? (this.commits.has(ref) ? ref : undefined);
    if (!sha) throw httpError(404, `No commit found for the ref ${ref}`);
    return sha;
  }
  blobAt(commitSha: string, path: string): string | undefined {
    return this.treeOf(commitSha).get(path)?.sha;
  }
  /** `git log -- path` with default history simplification. */
  historyOf(start: string, path: string): string[] {
    const out: string[] = [];
    let cur: string | undefined = start;
    while (cur) {
      const c: Commit = this.commits.get(cur)!;
      const mine = this.blobAt(cur, path);
      if (c.parents.length === 0) {
        if (mine !== undefined) out.push(cur);
        break;
      }
      const same = c.parents.find((p) => this.blobAt(p, path) === mine);
      if (same !== undefined) {
        cur = same;
        continue;
      }
      out.push(cur);
      cur = c.parents[0];
    }
    return out;
  }
  ancestors(sha: string): Set<string> {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...this.commits.get(s)!.parents);
    }
    return seen;
  }

  seed(repo: string, files: Record<string, string>): string {
    const tree: Tree = new Map();
    for (const [path, content] of Object.entries(files))
      tree.set(path, { sha: this.putBlob(content), mode: "100644" });
    const sha = this.putCommit(this.putTree(tree), [], "initial");
    this.setRef(repo, "main", sha);
    return sha;
  }
  commitOn(
    repo: string,
    changes: Record<string, string | null>,
    message = "a person's edit",
    branch = "main",
  ): string {
    const parent = this.head(repo, branch)!;
    const tree: Tree = new Map(this.treeOf(parent));
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) tree.delete(path);
      else tree.set(path, { sha: this.putBlob(content), mode: "100644" });
    }
    const sha = this.putCommit(this.putTree(tree), [parent], message);
    this.setRef(repo, branch, sha);
    return sha;
  }
  pull(repo: string, number: number): Pull {
    const p = this.pulls.find((x) => x.repo === repo && x.number === number);
    if (!p) throw httpError(404, "Not Found");
    return p;
  }
  view(p: Pull) {
    return {
      number: p.number,
      state: p.state,
      merged_at: p.merged_at,
      title: p.title,
      body: p.body,
      html_url: `https://github.com/${OWNER}/${p.repo}/pull/${p.number}`,
      node_id: p.node_id,
      auto_merge: p.auto_merge,
      head: { ref: p.headRef, sha: this.head(p.repo, p.headRef) ?? "" },
      base: { ref: p.baseRef },
    };
  }
  greenAt(sha: string): void {
    this.checks.set(sha, [
      { name: "verify", status: "completed", conclusion: "success" },
      { name: "security", status: "completed", conclusion: "success" },
    ]);
  }
  mergeBase(p: Pull): string {
    const base = this.ancestors(this.head(p.repo, p.baseRef)!);
    let cur: string | undefined = this.head(p.repo, p.headRef);
    while (cur && !base.has(cur)) cur = this.commits.get(cur)!.parents[0];
    return cur!;
  }

  /** The client the engine is handed; `fakeOctokit` holds the endpoints. */
  octokit() {
    return fakeOctokit(this);
  }
}

/** GitHub's REST and GraphQL surface, as far as the lane touches it, over one {@link FakeGitHub}. */
function fakeOctokit(gh: FakeGitHub) {
  const repoOf = (a: { owner: string; repo: string }) => {
    expect(a.owner).toBe(OWNER);
    return a.repo;
  };
  return {
    repos: {
      getBranch: async (a: { owner: string; repo: string; branch: string }) => {
        const sha = gh.head(repoOf(a), a.branch);
        if (!sha) throw httpError(404, "Branch not found");
        return {
          data: { commit: { sha, commit: { tree: { sha: gh.commits.get(sha)!.treeSha } } } },
        };
      },
      listCommits: async (a: {
        owner: string;
        repo: string;
        sha: string;
        path: string;
        per_page?: number;
      }) => {
        const start = gh.resolve(repoOf(a), a.sha);
        return {
          data: gh
            .historyOf(start, a.path)
            .slice(0, a.per_page ?? 30)
            .map((sha) => ({ sha })),
        };
      },
      getContent: async (a: { owner: string; repo: string; path: string; ref: string }) => {
        const repo = repoOf(a);
        const status = gh.failContent?.(repo, a.path, a.ref) ?? null;
        if (status) throw httpError(status, `HTTP ${status}`);
        const entry = gh.treeOf(gh.resolve(repo, a.ref)).get(a.path);
        if (!entry) throw httpError(404, "Not Found");
        const content = gh.blobs.get(entry.sha)!;
        return {
          data: {
            type: "file",
            sha: entry.sha,
            content: Buffer.from(content, "utf8").toString("base64"),
            encoding: "base64",
            size: Buffer.byteLength(content),
          },
        };
      },
    },
    git: {
      getTree: async (a: { owner: string; repo: string; tree_sha: string }) => {
        repoOf(a);
        const tree = gh.trees.get(a.tree_sha)!;
        return {
          data: {
            truncated: false,
            tree: [...tree].map(([path, e]) => ({
              path,
              mode: e.mode,
              type: "blob",
              sha: e.sha,
              size: Buffer.byteLength(gh.blobs.get(e.sha) ?? ""),
            })),
          },
        };
      },
      createBlob: async (a: { owner: string; repo: string; content: string; encoding: string }) => {
        gh.writes.push({ op: "createBlob", repo: repoOf(a) });
        return { data: { sha: gh.putBlob(Buffer.from(a.content, "base64").toString("utf8")) } };
      },
      createTree: async (a: {
        owner: string;
        repo: string;
        base_tree: string;
        tree: Array<{ path: string; mode: string; sha?: string | null; content?: string }>;
      }) => {
        gh.writes.push({ op: "createTree", repo: repoOf(a) });
        const tree: Tree = new Map(gh.trees.get(a.base_tree)!);
        for (const e of a.tree) {
          if (e.content !== undefined)
            tree.set(e.path, { sha: gh.putBlob(e.content), mode: e.mode });
          else if (e.sha === null) tree.delete(e.path);
          else tree.set(e.path, { sha: e.sha!, mode: e.mode });
        }
        return { data: { sha: gh.putTree(tree) } };
      },
      createCommit: async (a: {
        owner: string;
        repo: string;
        message: string;
        tree: string;
        parents: string[];
      }) => {
        gh.writes.push({ op: "createCommit", repo: repoOf(a), detail: a.message });
        return { data: { sha: gh.putCommit(a.tree, a.parents, a.message) } };
      },
      createRef: async (a: { owner: string; repo: string; ref: string; sha: string }) => {
        const repo = repoOf(a);
        const name = a.ref.replace(/^refs\/heads\//, "");
        if (gh.head(repo, name)) throw httpError(422, "Reference already exists");
        gh.writes.push({ op: "createRef", repo, detail: name });
        gh.setRef(repo, name, a.sha);
        return { data: {} };
      },
      updateRef: async (a: { owner: string; repo: string; ref: string; sha: string }) => {
        const repo = repoOf(a);
        const name = a.ref.replace(/^heads\//, "");
        gh.writes.push({ op: "updateRef", repo, detail: name });
        gh.setRef(repo, name, a.sha);
        return { data: {} };
      },
    },
    pulls: {
      list: async (a: {
        owner: string;
        repo: string;
        state: string;
        head: string;
        base: string;
      }) => {
        const repo = repoOf(a);
        return {
          data: gh.pulls
            .filter(
              (p) =>
                p.repo === repo &&
                p.state === a.state &&
                `${OWNER}:${p.headRef}` === a.head &&
                p.baseRef === a.base,
            )
            .sort((x, y) => x.number - y.number)
            .map((p) => gh.view(p)),
        };
      },
      get: async (a: { owner: string; repo: string; pull_number: number }) => ({
        data: gh.view(gh.pull(repoOf(a), a.pull_number)),
      }),
      create: async (a: {
        owner: string;
        repo: string;
        title: string;
        head: string;
        base: string;
        body: string;
      }) => {
        const repo = repoOf(a);
        if (!gh.head(repo, a.head)) throw httpError(422, "head does not exist");
        const number = 100 + gh.pulls.length;
        const p: Pull = {
          repo,
          number,
          state: "open",
          merged_at: null,
          title: a.title,
          body: a.body,
          headRef: a.head,
          baseRef: a.base,
          node_id: `PR_${repo}_${number}`,
          auto_merge: null,
        };
        gh.pulls.push(p);
        gh.writes.push({ op: "createPull", repo, detail: String(number) });
        return { data: gh.view(p) };
      },
      update: async (a: {
        owner: string;
        repo: string;
        pull_number: number;
        state?: "open" | "closed";
        title?: string;
        body?: string;
      }) => {
        const p = gh.pull(repoOf(a), a.pull_number);
        if (a.state) p.state = a.state;
        if (a.title !== undefined) p.title = a.title;
        if (a.body !== undefined) p.body = a.body;
        gh.writes.push({
          op: a.state === "closed" ? "closePull" : "updatePull",
          repo: p.repo,
          detail: String(p.number),
        });
        return { data: gh.view(p) };
      },
      listCommits: async (a: { owner: string; repo: string; pull_number: number }) => {
        const p = gh.pull(repoOf(a), a.pull_number);
        const base = gh.ancestors(gh.head(p.repo, p.baseRef)!);
        const out: Array<{ sha: string; commit: { message: string } }> = [];
        let cur: string | undefined = gh.head(p.repo, p.headRef);
        while (cur && !base.has(cur)) {
          const c: Commit = gh.commits.get(cur)!;
          out.push({ sha: cur, commit: { message: c.message } });
          cur = c.parents[0];
        }
        return { data: out.reverse() };
      },
      listFiles: async (a: { owner: string; repo: string; pull_number: number }) => {
        const p = gh.pull(repoOf(a), a.pull_number);
        const before = gh.treeOf(gh.mergeBase(p));
        const after = gh.treeOf(gh.head(p.repo, p.headRef)!);
        const files: Array<{ filename: string; status: string; sha: string | null }> = [];
        for (const [path, e] of after) {
          const was = before.get(path);
          if (!was) files.push({ filename: path, status: "added", sha: e.sha });
          else if (was.sha !== e.sha)
            files.push({ filename: path, status: "modified", sha: e.sha });
        }
        for (const path of before.keys())
          if (!after.has(path)) files.push({ filename: path, status: "removed", sha: null });
        return { data: files };
      },
      merge: async (a: { owner: string; repo: string; pull_number: number; sha?: string }) => {
        const p = gh.pull(repoOf(a), a.pull_number);
        const headSha = gh.head(p.repo, p.headRef)!;
        if (a.sha && a.sha !== headSha) throw httpError(409, "Head branch was modified");
        const baseHead = gh.head(p.repo, p.baseRef)!;
        const merged = gh.putCommit(
          gh.commits.get(headSha)!.treeSha,
          [baseHead, headSha],
          `Merge #${p.number}`,
        );
        gh.setRef(p.repo, p.baseRef, merged);
        p.state = "closed";
        p.merged_at = new Date().toISOString();
        gh.writes.push({ op: "merge", repo: p.repo, detail: String(p.number) });
        return { data: { sha: merged, merged: true } };
      },
    },
    checks: {
      listForRef: async (a: { owner: string; repo: string; ref: string }) => {
        repoOf(a);
        return { data: { check_runs: gh.checks.get(a.ref) ?? [] } };
      },
    },
    graphql: async (query: string, vars: { id: string }) => {
      const p = gh.pulls.find((x) => x.node_id === vars.id)!;
      if (query.includes("enablePullRequestAutoMerge")) {
        if (gh.armRefused) throw new Error("Pull request is in clean status");
        p.auto_merge = { enabledAt: new Date().toISOString() };
        gh.writes.push({ op: "arm", repo: p.repo, detail: String(p.number) });
      } else {
        p.auto_merge = null;
        gh.writes.push({ op: "disarm", repo: p.repo, detail: String(p.number) });
      }
      return {};
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry and the ledger, as rows
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

class FakeDb {
  rows: Record<string, Row[]> = {};
  /** Tables whose reads answer with an error. */
  failing = new Set<string>();
  private last = 0;

  from(table: string) {
    return new FakeQuery(this, table);
  }
  stamp(): string {
    this.last = Math.max(this.last + 1, Date.now());
    return new Date(this.last).toISOString();
  }
  ledger(): Row[] {
    return (this.rows.audit_log ?? []).filter((r) => r.action === LATERAL_LEDGER_ACTION);
  }
}

class FakeQuery implements PromiseLike<{ data: unknown; error: { message: string } | null }> {
  private preds: Array<(r: Row) => boolean> = [];
  private sortBy: { col: string; asc: boolean } | null = null;
  private cap: number | null = null;
  private single = false;
  private inserting: Row | null = null;
  constructor(
    private db: FakeDb,
    private table: string,
  ) {}
  select() {
    return this;
  }
  eq(col: string, value: unknown) {
    this.preds.push((r) => r[col] === value);
    return this;
  }
  in(col: string, values: unknown[]) {
    this.preds.push((r) => values.includes(r[col]));
    return this;
  }
  not(col: string, op: string, value: unknown) {
    this.preds.push((r) => !(op === "is" && value === null ? r[col] == null : r[col] === value));
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.sortBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.cap = n;
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  insert(row: Row) {
    this.inserting = row;
    return this;
  }
  then<A, B>(
    onfulfilled?:
      | ((v: { data: unknown; error: { message: string } | null }) => A | PromiseLike<A>)
      | null,
    onrejected?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
  private run(): { data: unknown; error: { message: string } | null } {
    if (this.db.failing.has(this.table))
      return { data: null, error: { message: `${this.table} is unavailable` } };
    if (this.inserting) {
      (this.db.rows[this.table] ??= []).push({
        id: randomUUID(),
        created_at: this.db.stamp(),
        ...this.inserting,
      });
      return { data: null, error: null };
    }
    let rows = (this.db.rows[this.table] ?? []).filter((r) => this.preds.every((p) => p(r)));
    if (this.sortBy) {
      const { col, asc } = this.sortBy;
      rows = [...rows].sort(
        (x, y) =>
          (String(x[col]) < String(y[col]) ? -1 : String(x[col]) > String(y[col]) ? 1 : 0) *
          (asc ? 1 : -1),
      );
    }
    if (this.cap !== null) rows = rows.slice(0, this.cap);
    return this.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The world: a prime and the two parents, with the shapes measured between them
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY = `export type Priority = "high" | "low";\nexport function priorityOf(): Priority {\n  return "high";\n}\n`;
const INBOX = `export async function send() {\n  return supabase.functions.invoke("send-ghl-message");\n}\n`;
const FORMAT = `export function formatAud(n: number): string {\n  return n.toFixed(2);\n}\n`;
const ADAPTER = `export const adapter = "native";\n`;
const APP = `export default function App() { return null; }\n`;

const PRIME_FILES = { "src/App.tsx": APP, "package.json": "{}\n", "README.md": "prime\n" };

function world(opts: { mode?: "pr" | "auto_merge" | "notify" } = {}) {
  const gh = new FakeGitHub();
  gh.seed(PRIME, PRIME_FILES);
  // The mirror: the prime's tree, plus the reminders fix and a GoHighLevel call.
  gh.seed(DEP, {
    ...PRIME_FILES,
    "src/lib/reminders/priority.pure.ts": PRIORITY,
    "src/pages/Inbox.tsx": INBOX,
  });
  // The CRM-independent parent: the prime's tree, plus its routing layer and a helper.
  gh.seed(IND, {
    ...PRIME_FILES,
    "src/lib/crm/nativeAdapter.ts": ADAPTER,
    "src/lib/util/format.pure.ts": FORMAT,
  });
  current.octokit = gh.octokit();

  const db = new FakeDb();
  db.rows.clones = [
    {
      id: "dep",
      name: "NPC Client Dashboard",
      github_owner: OWNER,
      github_repo: DEP,
      default_branch: "main",
      sync_scope: "mirror",
    },
    {
      id: "ind",
      name: "NPC CRM Independent",
      github_owner: OWNER,
      github_repo: IND,
      default_branch: "main",
      sync_scope: "modules",
    },
  ];
  db.rows.prime_config = [
    {
      github_owner: OWNER,
      github_repo: PRIME,
      default_branch: "main",
      default_cascade_mode: opts.mode ?? "pr",
      supabase_project_ref: "dduzbchuswwbefdunfct",
    },
  ];
  db.rows.clone_backends_safe = [
    { supabase_project_ref: "plisdzywzleljorrphxv" },
    { supabase_project_ref: null },
  ];
  db.rows.clone_sync_exclusions = [
    { clone_id: "dep", pattern: "supabase/config.toml", reason: "protected", note: "identity" },
  ];
  db.rows.clone_modules = [
    { clone_id: "ind", modules: { slug: "reminders", file_globs: ["src/lib/reminders/**"] } },
    { clone_id: "ind", modules: { slug: "pages", file_globs: ["src/pages/**"] } },
    {
      clone_id: "ind",
      modules: { slug: "crm", file_globs: ["src/lib/crm/**", "src/lib/util/**"] },
    },
    { clone_id: "ind", modules: { slug: "shell", file_globs: ["src/App.tsx"] } },
  ];
  db.rows.clone_library_pins = [];
  db.rows.audit_log = [];

  const run = (o: { force?: boolean; dryRun?: boolean } = {}) =>
    runLateralExchange({
      trigger: o.force ? "operator" : "slot",
      force: o.force,
      dryRun: o.dryRun,
      deadlineAt: Date.now() + 45_000,
      supabase: db as never,
    });
  const boundary = async (o: { force?: boolean; dryRun?: boolean } = {}) => {
    const report = await run(o);
    expect(report.boundaries).toHaveLength(FLEET_LATERALS.length);
    return report.boundaries[0];
  };
  const lastState = () => {
    const rows = db.ledger();
    return readLateralLedger(rows[rows.length - 1]?.metadata);
  };
  return { gh, db, run, boundary, lastState };
}

const INTO_IND = lateralBranchName(DEP);
const INTO_DEP = lateralBranchName(IND);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a first pass: parent-level work proposed both ways, under each destination's rulebook", () => {
  it("proposes each side's own work to the other, and holds what a membrane refuses", async () => {
    const { gh, db, boundary } = world();
    const b = await boundary();

    expect(b.outcome).toBe("ran");
    // Four paths differ and none of them has ever been in the prime.
    expect(b.candidates).toBe(4);
    expect(b.primeOwned).toBe(0);
    expect(b.conflicts).toEqual([]);

    const intoInd = b.directions.find((d) => d.to === IND)!;
    const intoDep = b.directions.find((d) => d.to === DEP)!;
    expect(intoInd).toMatchObject({
      outcome: "proposed",
      writes: ["src/lib/reminders/priority.pure.ts"],
    });
    expect(intoDep).toMatchObject({ outcome: "proposed", writes: ["src/lib/util/format.pure.ts"] });
    // The CRM line holds both ways: a routed name does not enter the
    // independent's browser layer, and its routing layer does not enter the mirror.
    expect(intoInd.held.map((h) => h.path)).toEqual(["src/pages/Inbox.tsx"]);
    expect(intoDep.held.map((h) => h.path)).toEqual(["src/lib/crm/nativeAdapter.ts"]);

    // One proposal per destination, on the lane's own branch, never on main.
    const indPull = gh.pulls.find((p) => p.repo === IND)!;
    const depPull = gh.pulls.find((p) => p.repo === DEP)!;
    expect(indPull).toMatchObject({
      headRef: INTO_IND,
      baseRef: "main",
      state: "open",
      auto_merge: null,
    });
    expect(depPull).toMatchObject({ headRef: INTO_DEP, baseRef: "main", state: "open" });
    expect(gh.writes.filter((w) => w.op === "updateRef" && w.detail === "main")).toEqual([]);

    // The proposal carries exactly the origin's blob, on the destination's head.
    const headSha = gh.head(IND, INTO_IND)!;
    const commit = gh.commits.get(headSha)!;
    expect(commit.message.startsWith(LATERAL_COMMIT_PREFIX)).toBe(true);
    expect(commit.parents).toEqual([gh.head(IND, "main")]);
    expect(gh.blobAt(headSha, "src/lib/reminders/priority.pure.ts")).toBe(gitBlobSha(PRIORITY));
    expect(gh.blobAt(headSha, "src/pages/Inbox.tsx")).toBeUndefined();

    // One ledger row, carrying both proposals for the next slot to find.
    expect(db.ledger()).toHaveLength(1);
    const state = readLateralLedger(db.ledger()[0].metadata);
    expect(state.proposals.map((p) => [p.from, p.to, p.pr]).sort()).toEqual(
      [
        [DEP, IND, indPull.number],
        [IND, DEP, depPull.number],
      ].sort(),
    );
    expect(state.deferred).toBe(0);
  });

  it("a dry run judges everything and writes nothing — no branch, no pull request, no row", async () => {
    const { gh, db, boundary } = world();
    const b = await boundary({ force: true, dryRun: true });
    expect(b.directions.map((d) => d.outcome).sort()).toEqual(["dry_run", "dry_run"]);
    expect(gh.writes).toEqual([]);
    expect(db.ledger()).toEqual([]);
  });

  it("a notify rulebook records what may cross and proposes nothing", async () => {
    const { gh, boundary } = world({ mode: "notify" });
    const b = await boundary();
    expect(b.directions.map((d) => d.outcome).sort()).toEqual(["recorded", "recorded"]);
    expect(gh.writes).toEqual([]);
  });
});

describe("the next slot", () => {
  it("does nothing where nothing moved, and a forced pass does not rebuild an offer already made", async () => {
    const { gh, db, boundary } = world();
    await boundary();
    const writesAfterFirst = gh.writes.length;

    const idle = await boundary();
    expect(idle.outcome).toBe("skipped");
    expect(db.ledger()).toHaveLength(1);
    expect(idle.reconcile.map((r) => r.state)).toEqual(["open", "open"]);

    const forced = await boundary({ force: true });
    expect(forced.directions.map((d) => d.outcome).sort()).toEqual(["unchanged", "unchanged"]);
    expect(gh.writes.length).toBe(writesAfterFirst);
  });

  it("moves the one proposal to a newer copy rather than opening a second", async () => {
    const { gh, boundary } = world();
    await boundary();
    const before = gh.pulls.filter((p) => p.repo === IND);
    const edited = `${PRIORITY}export const LEVELS = 2;\n`;
    gh.commitOn(DEP, { "src/lib/reminders/priority.pure.ts": edited });

    const b = await boundary();
    const intoInd = b.directions.find((d) => d.to === IND)!;
    expect(intoInd.outcome).toBe("updated");
    expect(gh.pulls.filter((p) => p.repo === IND)).toHaveLength(before.length);
    expect(gh.blobAt(gh.head(IND, INTO_IND)!, "src/lib/reminders/priority.pure.ts")).toBe(
      gitBlobSha(edited),
    );
  });

  it("never rebuilds a proposal a person has pushed to", async () => {
    const { gh, boundary } = world();
    await boundary();
    // A person fixes something on the lane's branch…
    gh.commitOn(IND, { "src/lib/reminders/note.md": "reviewer's note\n" }, "review fix", INTO_IND);
    const theirs = gh.head(IND, INTO_IND)!;
    // …and the origin then changes the file again.
    gh.commitOn(DEP, { "src/lib/reminders/priority.pure.ts": `${PRIORITY}// v2\n` });

    const b = await boundary();
    const intoInd = b.directions.find((d) => d.to === IND)!;
    expect(intoInd.outcome).toBe("unchanged");
    expect(intoInd.why).toMatch(/a person pushed/);
    expect(gh.head(IND, INTO_IND)).toBe(theirs);
  });

  it("nor one a person pushes to while its replacement is being built", async () => {
    const { gh, boundary } = world();
    await boundary();
    gh.commitOn(DEP, { "src/lib/reminders/priority.pure.ts": `${PRIORITY}// v2\n` });

    // The push lands AFTER the lane has read the proposal as its own: between
    // building the replacement commit and moving the branch onto it. The
    // ownership check has already passed by then, so only a second look at
    // the branch can see it.
    const octokit = current.octokit as ReturnType<FakeGitHub["octokit"]>;
    const build = octokit.git.createCommit;
    let theirs: string | null = null;
    octokit.git.createCommit = async (a) => {
      const made = await build(a);
      if (a.repo === IND && theirs === null) {
        theirs = gh.commitOn(
          IND,
          { "src/lib/reminders/note.md": "reviewer's note\n" },
          "review fix",
          INTO_IND,
        );
      }
      return made;
    };

    const b = await boundary();
    const intoInd = b.directions.find((d) => d.to === IND)!;
    expect(theirs).not.toBeNull();
    expect(intoInd.outcome).toBe("deferred");
    expect(intoInd.why).toMatch(/moved .* while this pass built its replacement/);
    expect(gh.head(IND, INTO_IND)).toBe(theirs);
    expect(gh.writes.filter((w) => w.op === "updateRef" && w.repo === IND)).toEqual([]);

    // The deferral is what brings the next slot round, and that pass reads the
    // branch as a person's and leaves it.
    octokit.git.createCommit = build;
    const next = await boundary();
    expect(next.outcome).toBe("ran");
    const again = next.directions.find((d) => d.to === IND)!;
    expect(again.outcome).toBe("unchanged");
    expect(again.why).toMatch(/a person pushed/);
    expect(gh.head(IND, INTO_IND)).toBe(theirs);
  });
});

describe("what a person does with a proposal is remembered", () => {
  it("a declined copy is not offered again — until the origin changes it", async () => {
    const { gh, boundary, lastState } = world();
    await boundary();
    const pr = gh.pulls.find((p) => p.repo === IND)!;
    pr.state = "closed"; // closed without merging, by a person

    const b = await boundary();
    expect(b.reconcile.find((r) => r.to === IND)?.state).toBe("declined");
    const intoInd = b.directions.find((d) => d.to === IND)!;
    expect(intoInd.writes).toEqual([]);
    expect(intoInd.declined.map((d) => d.path)).toEqual(["src/lib/reminders/priority.pure.ts"]);
    expect(gh.pulls.filter((p) => p.repo === IND && p.state === "open")).toEqual([]);
    expect(lastState().memo.declined[IND]?.["src/lib/reminders/priority.pure.ts"]?.sha).toBe(
      gitBlobSha(PRIORITY),
    );

    // The origin changes it: a new offer, on the same branch the closed one left behind.
    gh.commitOn(DEP, { "src/lib/reminders/priority.pure.ts": `${PRIORITY}// v2\n` });
    const again = await boundary();
    expect(again.directions.find((d) => d.to === IND)?.outcome).toBe("proposed");
    expect(gh.pulls.filter((p) => p.repo === IND && p.state === "open")).toHaveLength(1);
  });

  it("closes its own proposal once nothing is left to offer, marked so it is not read as a decline", async () => {
    const { gh, boundary, lastState } = world();
    await boundary();
    // The destination takes the same copy by other means.
    gh.commitOn(
      IND,
      { "src/lib/reminders/priority.pure.ts": PRIORITY },
      "a person copied it across",
    );

    const b = await boundary();
    const intoInd = b.directions.find((d) => d.to === IND)!;
    expect(intoInd.outcome).toBe("closed_stale");
    const pr = gh.pulls.find((p) => p.repo === IND)!;
    expect(pr.state).toBe("closed");
    expect(pr.body).toContain(SUPERSEDED_MARKER);

    // The close cleared the record with it, so the next pass neither
    // reconciles that proposal nor remembers it as a person's "no".
    const next = await boundary({ force: true });
    expect(next.reconcile.find((r) => r.to === IND)).toBeUndefined();
    expect(lastState().memo.declined[IND] ?? {}).toEqual({});
  });
});

describe("auto_merge lands through the vertical cascade's own gate", () => {
  it("arms GitHub's auto-merge where it may, and never merges itself", async () => {
    const { gh, boundary } = world({ mode: "auto_merge" });
    const b = await boundary();
    expect(b.mode).toBe("auto_merge");
    expect(gh.pulls.every((p) => p.auto_merge !== null)).toBe(true);
    expect(gh.writes.filter((w) => w.op === "merge")).toEqual([]);
  });

  it("where GitHub will not arm, merges on green and only on green", async () => {
    const { gh, boundary, lastState } = world({ mode: "auto_merge" });
    gh.armRefused = true;
    const first = await boundary();
    // No checks have reported: nothing has built the tree, so nothing lands.
    for (const d of first.directions) expect(d.merge).toMatch(/nothing has built this tree/);
    expect(gh.writes.filter((w) => w.op === "merge")).toEqual([]);

    for (const p of gh.pulls) gh.greenAt(gh.head(p.repo, p.headRef)!);
    const second = await boundary();
    expect(second.reconcile.map((r) => r.state).sort()).toEqual(["merged", "merged"]);
    expect(gh.blobAt(gh.head(IND, "main")!, "src/lib/reminders/priority.pure.ts")).toBe(
      gitBlobSha(PRIORITY),
    );
    expect(gh.blobAt(gh.head(DEP, "main")!, "src/lib/util/format.pure.ts")).toBe(
      gitBlobSha(FORMAT),
    );
    expect(lastState().proposals).toEqual([]);

    // And the boundary is at rest: the crossed files are the same on both sides now.
    const settled = await boundary({ force: true });
    expect(settled.candidates).toBe(2); // the two membrane holds, still apart
    expect(settled.directions.flatMap((d) => d.writes)).toEqual([]);
  });
});

describe("a pause", () => {
  it("disarms what the lane armed, stops every slot, and an operator's forced pass still never merges", async () => {
    const { gh, db, boundary } = world({ mode: "auto_merge" });
    await boundary();
    expect(gh.pulls.every((p) => p.auto_merge !== null)).toBe(true);

    const paused = await setLateralExchangePaused({
      paused: true,
      actorUserId: "op",
      supabase: db as never,
    });
    expect(paused.ok).toBe(true);
    expect(gh.pulls.every((p) => p.auto_merge === null)).toBe(true);

    gh.commitOn(DEP, { "src/lib/reminders/priority.pure.ts": `${PRIORITY}// v2\n` });
    const slot = await boundary();
    expect(slot.outcome).toBe("paused");

    for (const p of gh.pulls) gh.greenAt(gh.head(p.repo, p.headRef)!);
    const forced = await boundary({ force: true });
    expect(forced.mode).toBe("pr");
    expect(gh.writes.filter((w) => w.op === "merge" || w.op === "arm").length).toBe(2); // the two from before the pause
    expect(readLateralLedger(db.ledger()[db.ledger().length - 1].metadata).paused).toBe(true);

    const view = await readLateralExchangeLedger(db as never);
    expect(view[0].paused).toBe(true);
    expect(view[0].history.map((h) => h.event)).toContain("paused");
  });

  it("a pause written while a pass runs is not undone by that pass's row", async () => {
    const { db, boundary } = world();
    // The pass reads the ledger, then an operator pauses before it writes.
    const original = db.from.bind(db);
    let armed = false;
    db.from = (table: string) => {
      if (table === "clone_backends_safe" && !armed) {
        armed = true;
        db.rows.audit_log.push({
          id: randomUUID(),
          action: LATERAL_LEDGER_ACTION,
          entity_type: "lateral_boundary",
          entity_id: FLEET_LATERALS[0].ledgerId,
          created_at: db.stamp(),
          metadata: {
            v: 1,
            event: "paused",
            paused: true,
            fingerprint: null,
            deferred: 0,
            proposals: [],
            memo: {},
          },
        });
      }
      return original(table);
    };
    await boundary();
    const rows = db.ledger();
    expect(readLateralLedger(rows[rows.length - 1].metadata).paused).toBe(true);
  });
});

describe("the prime's history decides what is the lane's to move", () => {
  it("never moves a path the prime once held, even where the prime has since deleted it", async () => {
    const { gh, boundary } = world();
    gh.commitOn(PRIME, { "src/lib/legacy.ts": "export const x = 1;\n" });
    gh.commitOn(PRIME, { "src/lib/legacy.ts": null });
    gh.commitOn(
      DEP,
      { "src/lib/legacy.ts": "export const x = 1;\n" },
      "still has the prime's old file",
    );

    const b = await boundary();
    expect(b.primeOwned).toBe(1);
    expect(b.directions.flatMap((d) => [...d.writes, ...d.deletes])).not.toContain(
      "src/lib/legacy.ts",
    );
  });

  it("a history that could not be read defers the path, and the next slot asks again", async () => {
    const { gh, boundary, lastState } = world();
    gh.failContent = (repo, path) =>
      repo === IND && path === "src/lib/reminders/priority.pure.ts" ? 502 : null;
    // The independent held the file once and removed it, so its history must
    // be walked — and one revision of it will not read.
    gh.commitOn(IND, { "src/lib/reminders/priority.pure.ts": PRIORITY });
    gh.commitOn(IND, { "src/lib/reminders/priority.pure.ts": null });

    const b = await boundary();
    expect(b.deferred.map((d) => d.path)).toContain("src/lib/reminders/priority.pure.ts");
    expect(b.directions.flatMap((d) => [...d.writes, ...d.deletes])).not.toContain(
      "src/lib/reminders/priority.pure.ts",
    );
    expect(lastState().deferred).toBeGreaterThan(0);

    gh.failContent = null;
    const next = await boundary();
    expect(next.outcome).toBe("ran");
    // The independent held THIS copy and removed it, so the removal travels back.
    expect(next.directions.find((d) => d.to === DEP)?.deletes).toEqual([
      "src/lib/reminders/priority.pure.ts",
    ]);
  });

  it("holds a file both sides changed, for a person, and proposes neither copy", async () => {
    const { gh, boundary } = world();
    // Both sides start from the same copy, then each changes it.
    gh.commitOn(IND, { "src/lib/reminders/priority.pure.ts": PRIORITY });
    gh.commitOn(DEP, { "src/lib/reminders/priority.pure.ts": `${PRIORITY}// dependent\n` });
    gh.commitOn(IND, { "src/lib/reminders/priority.pure.ts": `${PRIORITY}// independent\n` });

    const b = await boundary();
    expect(b.conflicts).toEqual([
      expect.objectContaining({ path: "src/lib/reminders/priority.pure.ts", kind: "both_changed" }),
    ]);
    expect(b.directions.flatMap((d) => d.writes)).not.toContain(
      "src/lib/reminders/priority.pure.ts",
    );
  });
});

describe("only a question with a different answer next time keeps the boundary running", () => {
  it("holds a history longer than the walk for a person, and the next slot rests", async () => {
    const { gh, boundary, lastState } = world();
    // Both sides start from one copy, then each rewrites it more times than
    // the lane walks back — so neither walk can find the other's copy.
    gh.commitOn(IND, { "src/lib/reminders/priority.pure.ts": PRIORITY });
    for (let i = 0; i < 12; i++) {
      gh.commitOn(DEP, { "src/lib/reminders/priority.pure.ts": `${PRIORITY}// dependent ${i}\n` });
      gh.commitOn(IND, {
        "src/lib/reminders/priority.pure.ts": `${PRIORITY}// independent ${i}\n`,
      });
    }

    const b = await boundary();
    expect(b.conflicts).toEqual([
      expect.objectContaining({ path: "src/lib/reminders/priority.pure.ts", kind: "undecidable" }),
    ]);
    expect(lastState().deferred).toBe(0);
    // Deferred, it would re-walk those commits every ten minutes for ever.
    expect((await boundary()).outcome).toBe("skipped");
  });

  it("an overwrite past the survivor bound waits for a head to move, not for the next slot", async () => {
    const { gh, db, boundary, lastState } = world();
    // The independent's own source, past what one pass reads — held out of the
    // mirror by its own rulebook, so it is nothing but the destination's work.
    db.rows.clone_sync_exclusions.push({
      clone_id: "dep",
      pattern: "src/own/**",
      reason: "manual_reconcile",
      note: null,
    });
    db.rows.clone_modules.push({
      clone_id: "ind",
      modules: { slug: "own", file_globs: ["src/own/**"] },
    });
    const own: Record<string, string> = {};
    for (let i = 0; i < 151; i++) own[`src/own/m${i}.ts`] = `export const m${i} = ${i};\n`;
    gh.commitOn(IND, own);
    // And a copy the dependent is ahead on: the independent holds its old one.
    gh.commitOn(IND, { "src/lib/reminders/priority.pure.ts": PRIORITY });
    gh.commitOn(DEP, { "src/lib/reminders/priority.pure.ts": `${PRIORITY}// newer\n` });

    // The caps spread the first reading over a few passes; each is settled work.
    let b = await boundary({ force: true });
    for (let i = 0; i < 8 && b.deferred.length > 0; i++) b = await boundary({ force: true });
    expect(b.deferred).toEqual([]);

    const intoInd = b.directions.find((d) => d.to === IND)!;
    expect(intoInd.unread).toContain("src/lib/reminders/priority.pure.ts");
    expect(intoInd.why).toMatch(/past the 150/);
    expect(gh.pulls.filter((p) => p.repo === IND)).toEqual([]);
    expect(lastState().deferred).toBe(0);
    expect((await boundary()).outcome).toBe("skipped");
  });
});

describe("a read that FAILED is never taken for a fact that is ABSENT", () => {
  it("refuses the pass without the fleet's project refs, and records that once", async () => {
    const { gh, db, boundary } = world();
    db.failing.add("clone_backends_safe");
    const b = await boundary();
    expect(b.outcome).toBe("refused");
    expect(gh.writes).toEqual([]);
    expect(db.ledger()).toHaveLength(1);

    // The same refusal on the same heads is not written again every slot.
    await boundary();
    expect(db.ledger()).toHaveLength(1);
  });

  it("refuses a direction whose destination's installed modules could not be read, and runs the other", async () => {
    const { gh, db, boundary } = world();
    db.failing.add("clone_modules");
    const b = await boundary();
    expect(b.directions.find((d) => d.to === IND)?.outcome).toBe("refused");
    expect(b.directions.find((d) => d.to === DEP)?.outcome).toBe("proposed");
    expect(gh.pulls.filter((p) => p.repo === IND)).toEqual([]);
  });
});
