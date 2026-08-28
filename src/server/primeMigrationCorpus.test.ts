import { describe, it, expect, vi } from "vitest";
import { openPrimeMigrationCorpus, MAX_MIGRATION_BYTES } from "./prime-backend.server";

const REF = { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" };

/**
 * A fake Octokit that counts blob fetches.
 *
 * The count IS the assertion in most of these. The defect this module exists
 * to fix was not a wrong answer — `fetchPrimeMigrations` returned exactly the
 * right migrations — it was that getting them cost 962 round trips and 158 MB
 * before the caller could look at a single clone, which pg_net cut off at
 * 60,000 ms every time. So "did it produce the right SQL" is necessary and not
 * sufficient; "how many bodies did it download" is the property under test.
 */
function fakeOctokit(files: Array<{ name: string; body: string; size?: number }>) {
  const blobCalls: string[] = [];
  const shaOf = (name: string) => `sha-${name}`;
  const octokit = {
    repos: {
      getBranch: vi.fn(async () => ({
        data: { commit: { sha: "commit-sha-1", commit: { tree: { sha: "tree-sha-1" } } } },
      })),
      getContent: vi.fn(async () => {
        throw new Error("getContent should not be reached when the tree is not truncated");
      }),
    },
    git: {
      getTree: vi.fn(async () => ({
        data: {
          truncated: false,
          tree: files.map((f) => ({
            type: "blob",
            path: `supabase/migrations/${f.name}`,
            sha: shaOf(f.name),
            ...(f.size === undefined ? {} : { size: f.size }),
          })),
        },
      })),
      getBlob: vi.fn(async ({ file_sha }: { file_sha: string }) => {
        blobCalls.push(file_sha);
        const hit = files.find((f) => shaOf(f.name) === file_sha);
        if (!hit) throw new Error(`no such blob ${file_sha}`);
        return { data: { content: Buffer.from(hit.body, "utf-8").toString("base64") } };
      }),
    },
  };
  // The real Octokit type is far wider than what this module touches.
  return { octokit: octokit as never, blobCalls };
}

const CORPUS = [
  { name: "20250101000000_a.sql", body: "create table a();", size: 17 },
  { name: "20250102000000_b.sql", body: "create table b();", size: 17 },
  { name: "20250103000000_c.sql", body: "create table c();", size: 17 },
];

describe("openPrimeMigrationCorpus", () => {
  it("lists every migration without fetching a single body", async () => {
    const { octokit, blobCalls } = fakeOctokit(CORPUS);
    const corpus = await openPrimeMigrationCorpus(octokit, REF);

    expect(corpus.metas.map((m) => m.id)).toEqual([
      "20250101000000",
      "20250102000000",
      "20250103000000",
    ]);
    expect(corpus.sourceSha).toBe("commit-sha-1");
    // The whole point: a clone that is level with the prime pays for nothing.
    expect(blobCalls).toEqual([]);
  });

  it("fetches only the body asked for", async () => {
    const { octokit, blobCalls } = fakeOctokit(CORPUS);
    const corpus = await openPrimeMigrationCorpus(octokit, REF);

    await expect(corpus.loadSql("20250102000000")).resolves.toBe("create table b();");
    expect(blobCalls).toEqual(["sha-20250102000000_b.sql"]);
  });

  it("memoises, so a batch of clones missing the same version fetches it once", async () => {
    const { octokit, blobCalls } = fakeOctokit(CORPUS);
    const corpus = await openPrimeMigrationCorpus(octokit, REF);

    const [x, y, z] = await Promise.all([
      corpus.loadSql("20250101000000"),
      corpus.loadSql("20250101000000"),
      corpus.loadSql("20250101000000"),
    ]);

    expect([x, y, z]).toEqual(["create table a();", "create table a();", "create table a();"]);
    expect(blobCalls).toHaveLength(1);
  });

  it("does not cache a failure as the answer", async () => {
    // A transient GitHub fault must not become this clone's permanent verdict,
    // nor the verdict inherited by every later clone in the same batch.
    const { octokit } = fakeOctokit(CORPUS);
    let calls = 0;
    (octokit as unknown as { git: { getBlob: unknown } }).git.getBlob = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("502 from GitHub");
      return { data: { content: Buffer.from("create table a();", "utf-8").toString("base64") } };
    });
    const corpus = await openPrimeMigrationCorpus(octokit, REF);

    await expect(corpus.loadSql("20250101000000")).rejects.toThrow("502 from GitHub");
    await expect(corpus.loadSql("20250101000000")).resolves.toBe("create table a();");
    expect(calls).toBe(2);
  });

  it("rejects an unknown version rather than returning empty SQL", async () => {
    const { octokit } = fakeOctokit(CORPUS);
    const corpus = await openPrimeMigrationCorpus(octokit, REF);
    await expect(corpus.loadSql("29990101000000")).rejects.toThrow(/not in the prime corpus/);
  });

  describe("the size ceiling", () => {
    it("refuses an oversized blob from the tree's size, without fetching it", async () => {
      // The four generated template-library seeds are 36-41 MB. Decoding them
      // is what exhausts the isolate, so the refusal has to land before the
      // round trip, not after.
      const { octokit, blobCalls } = fakeOctokit([
        { name: "20250101000000_seed.sql", body: "x", size: 41_006_340 },
      ]);
      const corpus = await openPrimeMigrationCorpus(octokit, REF);

      await expect(corpus.loadSql("20250101000000")).rejects.toThrow(
        /20250101000000_seed\.sql is 39\.1 MB, past the 8 MB ceiling/,
      );
      expect(blobCalls).toEqual([]);
    });

    it("names the manual remedy, because a blocked clone needs a next step", async () => {
      const { octokit } = fakeOctokit([
        { name: "20250101000000_seed.sql", body: "x", size: 41_006_340 },
      ]);
      const corpus = await openPrimeMigrationCorpus(octokit, REF);
      await expect(corpus.loadSql("20250101000000")).rejects.toThrow(
        /Apply it to this clone by hand.*record its version in\s+supabase_migrations\.schema_migrations/s,
      );
    });

    it("treats an unknown size as fetch-and-measure, never as safely small", async () => {
      // `getContent` does not always report a size. Waving a blob through
      // because we failed to learn its size is how the ceiling gets bypassed
      // by exactly the files it was built to stop.
      const big = "y".repeat(MAX_MIGRATION_BYTES + 1);
      const { octokit, blobCalls } = fakeOctokit([
        { name: "20250101000000_seed.sql", body: big }, // no size on the tree entry
      ]);
      const corpus = await openPrimeMigrationCorpus(octokit, REF);

      await expect(corpus.loadSql("20250101000000")).rejects.toThrow(/past the 8 MB ceiling/);
      // It had to be fetched to be measured — that is the cost of an unknown
      // size, and it is the right side to err on.
      expect(blobCalls).toEqual(["sha-20250101000000_seed.sql"]);
    });

    it("admits a body exactly at the ceiling", async () => {
      const atLimit = "z".repeat(MAX_MIGRATION_BYTES);
      const { octokit } = fakeOctokit([
        { name: "20250101000000_big.sql", body: atLimit, size: MAX_MIGRATION_BYTES },
      ]);
      const corpus = await openPrimeMigrationCorpus(octokit, REF);
      await expect(corpus.loadSql("20250101000000")).resolves.toHaveLength(MAX_MIGRATION_BYTES);
    });
  });

  it("scales the read to the fleet's need, not to the corpus", async () => {
    // The regression this file exists to prevent, stated as a number: a
    // 962-file corpus where the fleet is missing two migrations must cost two
    // blob fetches. The old reader cost 962.
    const many = Array.from({ length: 962 }, (_, i) => ({
      name: `2025${String(i).padStart(10, "0")}_m.sql`,
      body: `select ${i};`,
      size: 12,
    }));
    const { octokit, blobCalls } = fakeOctokit(many);
    const corpus = await openPrimeMigrationCorpus(octokit, REF);

    expect(corpus.metas).toHaveLength(962);
    expect(blobCalls).toHaveLength(0);

    await corpus.loadSql(corpus.metas[960].id);
    await corpus.loadSql(corpus.metas[961].id);
    expect(blobCalls).toHaveLength(2);
  });
});
