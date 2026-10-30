import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPrimeBackendSnapshot, resetPrimeSnapshotCache } from "./prime-backend.server";
import { scanIsCacheable } from "./primeScanCache.pure";

const REF = { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" };

/**
 * A prime whose bundles each reference a secret of their own, recording which
 * blobs every GraphQL query asked for.
 *
 * What is under test is what a pass HOLDS. Measured 29 Oct 2026, a provisioning
 * pass that missed the scan cache held all 2,395 of the prime's function files
 * (44 MB of base64) beside the app, and the runtime killed it — three passes
 * on `tutorial-demo-orrimere-c158c7` after three prime merges in ninety
 * minutes. The scan set must stay whole; only what is kept may shrink.
 */
function fakePrime(commitSha: string) {
  const files: Record<string, string> = {
    "supabase/functions/_shared/util.ts": "export const k = Deno.env.get('SHARED_KEY');\n",
    "supabase/functions/alpha/index.ts":
      "import '../_shared/util.ts';\nDeno.env.get('ALPHA_KEY');\nexport default () => 'a';\n",
    "supabase/functions/beta/index.ts": "Deno.env.get('BETA_KEY');\nexport default () => 'b';\n",
    "supabase/functions/gamma/index.ts": "Deno.env.get('GAMMA_KEY');\nexport default () => 'g';\n",
    "supabase/config.toml": "[functions.alpha]\nverify_jwt = false\n",
  };
  const requested: string[][] = [];
  const octokit = {
    repos: {
      getBranch: vi.fn(async () => ({
        data: { commit: { sha: commitSha, commit: { tree: { sha: `tree-${commitSha}` } } } },
      })),
      getContent: vi.fn(async () => {
        throw new Error("getContent must not be reached when the tree is whole");
      }),
    },
    git: {
      getTree: vi.fn(async () => ({
        data: {
          truncated: false,
          tree: Object.keys(files).map((path) => ({ type: "blob", path, sha: `sha:${path}` })),
        },
      })),
      getBlob: vi.fn(async ({ file_sha }: { file_sha: string }) => ({
        data: {
          content: Buffer.from(files[file_sha.replace(/^sha:/, "")] ?? "", "utf8").toString(
            "base64",
          ),
        },
      })),
    },
    graphql: vi.fn(async (query: string) => {
      const repository: Record<string, unknown> = {};
      const asked: string[] = [];
      for (const [, alias, oid] of query.matchAll(/(b\d+): object\(oid: "([^"]+)"\)/g)) {
        const path = oid.replace(/^sha:/, "");
        asked.push(path);
        repository[alias] = { text: files[path] ?? "", isBinary: false, isTruncated: false };
      }
      requested.push(asked);
      return { repository };
    }),
  };
  const asked = () => requested.flat().filter((p) => p.startsWith("supabase/functions/"));
  return { octokit, asked, requested };
}

const ALL = ["ALPHA_KEY", "BETA_KEY", "GAMMA_KEY", "SHARED_KEY"];

beforeEach(() => resetPrimeSnapshotCache());

describe("a snapshot holds what it deploys, and scans the rest without holding it", () => {
  it("still names every bundle's secrets when it deploys only one of them", async () => {
    const { octokit } = fakePrime("commit-a");
    const snap = await fetchPrimeBackendSnapshot(octokit as never, REF, {
      includeMigrationSql: false,
      skipFunctionSlugs: ["beta", "gamma"],
    });
    expect(snap.functions.map((f) => f.slug)).toEqual(["alpha"]);
    // The scan set is every bundle the prime defines — never the deploy set.
    expect(snap.secretNames).toEqual(ALL);
    expect(snap.secretScanFromCache).toBeUndefined();
    expect(scanIsCacheable(snap)).toBe(true);
  });

  it("holds only the deployed bundles: a second read re-asks for the skipped ones alone", async () => {
    const { octokit, requested } = fakePrime("commit-a");
    const opts = { includeMigrationSql: false, skipFunctionSlugs: ["beta", "gamma"] };
    await fetchPrimeBackendSnapshot(octokit as never, REF, opts);
    const before = requested.length;
    await fetchPrimeBackendSnapshot(octokit as never, REF, opts);
    const again = requested
      .slice(before)
      .flat()
      .filter((p) => p.startsWith("supabase/functions/"))
      .sort();
    // alpha and the shared tree were held by the commit cache; beta and gamma
    // were streamed through the scan and dropped, so they are read again.
    expect(again).toEqual([
      "supabase/functions/beta/index.ts",
      "supabase/functions/gamma/index.ts",
    ]);
  });

  it("takes the names from a scan of THIS commit, and reads nothing it will not deploy", async () => {
    const { octokit, asked } = fakePrime("commit-a");
    const snap = await fetchPrimeBackendSnapshot(octokit as never, REF, {
      includeMigrationSql: false,
      skipFunctionSlugs: ["beta", "gamma"],
      cachedScan: { gitSha: "commit-a", secretNames: ["FROM_THE_CACHE"] },
    });
    expect(snap.secretNames).toEqual(["FROM_THE_CACHE"]);
    expect(snap.secretScanFromCache).toBe(true);
    expect(asked().sort()).toEqual([
      "supabase/functions/_shared/util.ts",
      "supabase/functions/alpha/index.ts",
    ]);
    // It scanned nothing, so it must not be written back as though it had.
    expect(scanIsCacheable(snap)).toBe(false);
  });

  it("treats a scan of any OTHER commit as a miss, and scans", async () => {
    const { octokit } = fakePrime("commit-b");
    const snap = await fetchPrimeBackendSnapshot(octokit as never, REF, {
      includeMigrationSql: false,
      skipFunctionSlugs: ["beta", "gamma"],
      cachedScan: { gitSha: "commit-a", secretNames: ["STALE"] },
    });
    expect(snap.secretNames).toEqual(ALL);
    expect(snap.secretScanFromCache).toBeUndefined();
  });

  it("treats an EMPTY cached list as a miss, never as a prime with no secrets", async () => {
    const { octokit } = fakePrime("commit-a");
    const snap = await fetchPrimeBackendSnapshot(octokit as never, REF, {
      includeMigrationSql: false,
      cachedScan: { gitSha: "commit-a", secretNames: [] },
    });
    expect(snap.secretNames).toEqual(ALL);
  });
});
