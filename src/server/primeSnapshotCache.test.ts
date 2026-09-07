import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fetchPrimeBackendSnapshot, resetPrimeSnapshotCache } from "./prime-backend.server";

const REF = { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" };

/**
 * A prime with two function bundles, counting every GitHub round trip.
 *
 * The counts ARE the assertions. The defect this cache exists to fix was not
 * a wrong snapshot — every clone's snapshot was correct — it was that a sweep
 * serving three clones at one commit paid for the same ~1,033-file read three
 * times, which is what spent the installation's quota and left the third run
 * refused on nearly every pass.
 */
function fakePrime(commitSha: string) {
  const files: Record<string, string> = {
    "supabase/functions/alpha/index.ts": "export default () => 'alpha';\n",
    "supabase/functions/beta/index.ts": "export default () => 'beta';\n",
    "supabase/config.toml": '[functions.alpha]\nverify_jwt = false\n',
  };
  const calls = { getBranch: 0, getTree: 0, graphql: 0, getBlob: 0 };
  const octokit = {
    repos: {
      getBranch: vi.fn(async () => {
        calls.getBranch++;
        return { data: { commit: { sha: commitSha, commit: { tree: { sha: `tree-${commitSha}` } } } } };
      }),
      getContent: vi.fn(async () => {
        throw new Error("getContent must not be reached when the tree is whole");
      }),
    },
    git: {
      getTree: vi.fn(async () => {
        calls.getTree++;
        return {
          data: {
            truncated: false,
            tree: Object.keys(files).map((path) => ({ type: "blob", path, sha: `sha:${path}` })),
          },
        };
      }),
      getBlob: vi.fn(async ({ file_sha }: { file_sha: string }) => {
        calls.getBlob++;
        const path = file_sha.replace(/^sha:/, "");
        return { data: { content: Buffer.from(files[path] ?? "", "utf8").toString("base64") } };
      }),
    },
    graphql: vi.fn(async (query: string) => {
      calls.graphql++;
      const repository: Record<string, unknown> = {};
      for (const [, alias, oid] of query.matchAll(/(b\d+): object\(oid: "([^"]+)"\)/g)) {
        const path = oid.replace(/^sha:/, "");
        repository[alias] = { text: files[path] ?? "", isBinary: false, isTruncated: false };
      }
      return { repository };
    }),
  };
  return { octokit, calls };
}

beforeEach(() => resetPrimeSnapshotCache());

describe("one sweep reads the prime once, however many clones it serves", () => {
  it("a second snapshot at the same commit fetches nothing again", async () => {
    const { octokit, calls } = fakePrime("commit-a");
    const opts = { includeMigrationSql: false };

    const first = await fetchPrimeBackendSnapshot(octokit as never, REF, opts);
    const afterFirst = { ...calls };
    expect(afterFirst.graphql).toBeGreaterThan(0);

    const second = await fetchPrimeBackendSnapshot(octokit as never, REF, opts);

    // Not one more request of any kind — the tree is inside its TTL and the
    // blob bodies are keyed by this commit.
    expect(calls).toEqual(afterFirst);
    // And the same bytes, so the saving costs the caller nothing.
    expect(second.functions?.map((f) => f.slug)).toEqual(first.functions?.map((f) => f.slug));
    expect(JSON.stringify(second.functions)).toBe(JSON.stringify(first.functions));
  });

  it("a different commit is a different key, so cached bytes can never go stale", async () => {
    const a = fakePrime("commit-a");
    await fetchPrimeBackendSnapshot(a.octokit as never, REF, { includeMigrationSql: false });

    // A new head: the tree cache is keyed by branch, so force the TTL out of
    // the way and prove the BLOB cache alone refuses to serve the old commit.
    resetPrimeSnapshotCache();
    const b = fakePrime("commit-b");
    b.octokit.graphql.mockClear();
    await fetchPrimeBackendSnapshot(b.octokit as never, REF, { includeMigrationSql: false });
    expect(b.calls.graphql).toBeGreaterThan(0);
  });
});

describe("the tree cache cannot outlive a sweep", () => {
  const src = readFileSync(new URL("./prime-backend.server.ts", import.meta.url), "utf8");

  it("holds the branch head for less than the drain's cadence", () => {
    // This is the whole safety argument for caching something a branch can
    // move under: shorter than the two-minute drain means the entry can only
    // ever collapse reads WITHIN one sweep, never carry a stale head into the
    // next one. The blob half needs no such bound — it is keyed by commit.
    const declared = /const TREE_CACHE_TTL_MS = ([0-9_]+);/.exec(src);
    expect(declared, "TREE_CACHE_TTL_MS").not.toBeNull();
    const ttlMs = Number((declared as RegExpExecArray)[1].replace(/_/g, ""));
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThan(120_000);
  });

  it("keys the blob bodies by commit, never by branch", () => {
    const fn = src.slice(src.indexOf("async function fetchBlobTextsForCommit"));
    expect(fn.slice(0, 600)).toMatch(/const key = `\$\{ref\.owner\}\/\$\{ref\.repo\}@\$\{commitSha\}`/);
  });
});
