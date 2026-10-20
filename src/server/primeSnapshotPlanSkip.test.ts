/**
 * `planSkip`: the redeploy lane plans what to skip from the tree the snapshot
 * read, at the commit it read, using every bundle's digest.
 *
 * The digests are the ledger's whole claim (`edgeBundleLedger.pure.ts`), so
 * what matters is which edits move them. A digest that misses a change skips
 * a deploy a tenant is owed; one that moves on an edit the bundle never sees
 * re-owes it for nothing, at about one bundle a pass — the F23 restart.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPrimeBackendSnapshot, resetPrimeSnapshotCache } from "./prime-backend.server";
import { bundleDigest } from "./functionBundleDigest.pure";
import { deployedVerifyJwt } from "./anonymousFunctionSlugs.pure";

const REF = { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" };

/** A prime's tree, served the way GitHub serves it, with a sha per content. */
function fakePrime(commitSha: string, files: Record<string, string>) {
  const shaOf = (path: string) =>
    `sha:${path}:${Buffer.from(files[path] ?? "").toString("base64")}`;
  const byOid = new Map(Object.keys(files).map((path) => [shaOf(path), files[path]]));
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
          tree: Object.keys(files).map((path) => ({ type: "blob", path, sha: shaOf(path) })),
        },
      })),
      getBlob: vi.fn(async ({ file_sha }: { file_sha: string }) => ({
        data: { content: Buffer.from(byOid.get(file_sha) ?? "", "utf8").toString("base64") },
      })),
    },
    graphql: vi.fn(async (query: string) => {
      const repository: Record<string, unknown> = {};
      for (const [, alias, oid] of query.matchAll(/(b\d+): object\(oid: "([^"]+)"\)/g)) {
        repository[alias] = { text: byOid.get(oid) ?? "", isBinary: false, isTruncated: false };
      }
      return { repository };
    }),
  };
  return { octokit, shaOf };
}

const BASE: Record<string, string> = {
  "supabase/functions/alpha/index.ts":
    'import { a } from "../_shared/a.ts";\nexport default () => a;\n',
  "supabase/functions/beta/index.ts":
    'import { b } from "../_shared/b.ts";\nexport default () => b;\n',
  "supabase/functions/stripe-webhook/index.ts": "export default () => 'hook';\n",
  "supabase/functions/_shared/a.ts": "export const a = 1;\n",
  "supabase/functions/_shared/b.ts": 'import { c } from "./c.ts";\nexport const b = c;\n',
  "supabase/functions/_shared/c.ts": "export const c = 2;\n",
  "supabase/functions/_shared/unused.ts": "export const unused = 3;\n",
  "supabase/config.toml":
    "[functions.alpha]\nverify_jwt = false\n[functions.beta]\nverify_jwt = true\n[functions.stripe-webhook]\nverify_jwt = true\n",
};

let commit = 0;
async function digestsOf(files: Record<string, string>) {
  resetPrimeSnapshotCache();
  const sha = `commit-${++commit}`;
  const { octokit } = fakePrime(sha, files);
  let seen: { commitSha: string; bundleDigests: ReadonlyMap<string, string> } | null = null;
  const snap = await fetchPrimeBackendSnapshot(octokit as never, REF, {
    includeMigrationSql: false,
    planSkip: (ctx) => {
      seen = ctx;
      return [];
    },
  });
  if (!seen) throw new Error("planSkip was not called");
  return {
    sha,
    snap,
    seen: seen as { commitSha: string; bundleDigests: ReadonlyMap<string, string> },
  };
}

beforeEach(() => resetPrimeSnapshotCache());

describe("what the snapshot hands planSkip", () => {
  it("the commit it read, and a digest for every bundle that commit defines", async () => {
    const { sha, snap, seen } = await digestsOf(BASE);
    expect(seen.commitSha).toBe(sha);
    expect(snap.sourceSha).toBe(sha);
    expect([...seen.bundleDigests.keys()].sort()).toEqual(["alpha", "beta", "stripe-webhook"]);
    // The same map the caller reads back when it records what landed.
    expect(snap.bundleDigests).toBe(seen.bundleDigests);
  });

  it("digests exactly what each deployed function carries", async () => {
    const { snap, seen } = await digestsOf(BASE);
    const { shaOf } = fakePrime("unused", BASE);
    for (const fn of snap.functions) {
      expect(seen.bundleDigests.get(fn.slug)).toBe(
        bundleDigest({
          slug: fn.slug,
          entrypointPath: fn.entrypointPath,
          importMapPath: fn.importMapPath,
          verifyJwt: deployedVerifyJwt(fn.slug, fn.verifyJwt).verifyJwt,
          files: fn.files.map((f) => ({
            path: f.path,
            sha: shaOf(`supabase/functions/${f.path}`),
          })),
        }),
      );
    }
  });

  it("computes nothing for a caller that did not ask", async () => {
    const { octokit } = fakePrime("commit-plain", BASE);
    const snap = await fetchPrimeBackendSnapshot(octokit as never, REF, {
      includeMigrationSql: false,
    });
    expect(snap.bundleDigests).toBeUndefined();
    expect(snap.deployableCount).toBe(3);
  });
});

describe("which edits move a bundle's digest", () => {
  it("an edit to a file a bundle reaches moves that bundle alone", async () => {
    const before = (await digestsOf(BASE)).seen.bundleDigests;
    const after = (
      await digestsOf({ ...BASE, "supabase/functions/_shared/c.ts": "export const c = 9;\n" })
    ).seen.bundleDigests;
    // beta reaches c.ts through b.ts; alpha and the webhook never do.
    expect(after.get("beta")).not.toBe(before.get("beta"));
    expect(after.get("alpha")).toBe(before.get("alpha"));
    expect(after.get("stripe-webhook")).toBe(before.get("stripe-webhook"));
  });

  it("an edit to a shared file nothing imports moves no digest", async () => {
    // Every bundle CARRIES the whole shared tree before pruning; digesting
    // that would re-owe every bundle on every shared edit.
    const before = (await digestsOf(BASE)).seen.bundleDigests;
    const after = (
      await digestsOf({
        ...BASE,
        "supabase/functions/_shared/unused.ts": "export const unused = 4;\n",
      })
    ).seen.bundleDigests;
    expect([...after]).toEqual([...before]);
  });

  it("a new import moves the bundle that gained it", async () => {
    const before = (await digestsOf(BASE)).seen.bundleDigests;
    const after = (
      await digestsOf({
        ...BASE,
        "supabase/functions/alpha/index.ts":
          'import { a } from "../_shared/a.ts";\nimport { unused } from "../_shared/unused.ts";\nexport default () => a + unused;\n',
      })
    ).seen.bundleDigests;
    expect(after.get("alpha")).not.toBe(before.get("alpha"));
    expect(after.get("beta")).toBe(before.get("beta"));
  });

  it("a verify_jwt the clone is sent moves the digest; one it is not sent does not", async () => {
    const before = (await digestsOf(BASE)).seen.bundleDigests;
    const flipped = (
      await digestsOf({
        ...BASE,
        "supabase/config.toml":
          "[functions.alpha]\nverify_jwt = false\n[functions.beta]\nverify_jwt = false\n[functions.stripe-webhook]\nverify_jwt = false\n",
      })
    ).seen.bundleDigests;
    // beta is sent the prime's flag, so flipping it changes what is sent.
    expect(flipped.get("beta")).not.toBe(before.get("beta"));
    // A webhook-style slug is sent `false` either way: nothing sent changed.
    expect(flipped.get("stripe-webhook")).toBe(before.get("stripe-webhook"));
    expect(flipped.get("alpha")).toBe(before.get("alpha"));
  });
});

describe("what planSkip returns is skipped before the cap", () => {
  it("leaves the skipped bundles out, counts what remains, and caps that", async () => {
    resetPrimeSnapshotCache();
    const { octokit } = fakePrime("commit-skip", BASE);
    const snap = await fetchPrimeBackendSnapshot(octokit as never, REF, {
      includeMigrationSql: false,
      skipFunctionSlugs: ["stripe-webhook"],
      planSkip: () => ["alpha"],
      functionLimit: 5,
    });
    expect(snap.functions.map((f) => f.slug)).toEqual(["beta"]);
    expect(snap.deployableCount).toBe(1);
    expect(snap.functionSourceTruncated).toBe(false);
    // A withheld bundle is still digested: the digests describe the commit,
    // and which of them a caller withholds is the caller's business.
    expect(snap.bundleDigests?.has("stripe-webhook")).toBe(true);
  });

  it("the cap applies to what planSkip left, so a skipped bundle cannot use up a pass", async () => {
    resetPrimeSnapshotCache();
    const { octokit } = fakePrime("commit-cap", BASE);
    const snap = await fetchPrimeBackendSnapshot(octokit as never, REF, {
      includeMigrationSql: false,
      planSkip: () => ["alpha"],
      functionLimit: 1,
    });
    expect(snap.functions.map((f) => f.slug)).toEqual(["beta"]);
    expect(snap.deployableCount).toBe(2);
    expect(snap.functionSourceTruncated).toBe(true);
  });
});
