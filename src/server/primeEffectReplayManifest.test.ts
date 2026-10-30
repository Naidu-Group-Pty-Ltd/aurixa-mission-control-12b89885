import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchEffectReplayManifest,
  openPrimeMigrationCorpus,
  resetPrimeSnapshotCache,
} from "./prime-backend.server";
import { EFFECT_REPLAYS_PATH } from "./migrationEffectReplay.pure";

beforeEach(() => resetPrimeSnapshotCache());

const REF = { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" };

const MANIFEST = JSON.stringify({
  schema_version: 1,
  replays: [
    {
      file: "20270210090000_revoke_browser_reach_on_integration_configs.sql",
      kind: "privilege",
      decided: "2026-10-29",
      reason: "Key audit S3, 29 Oct 2026: both browser roles held every privilege.",
    },
  ],
});

/** A fake installation: one branch, one tree, blobs that may refuse. */
function fakeOctokit(opts: { manifest?: string | null; blobFails?: boolean } = {}) {
  const files: Array<{ path: string; body: string }> = [
    {
      path: "supabase/migrations/20270210090000_revoke_browser_reach_on_integration_configs.sql",
      body: "-- @effect: select 1\nrevoke all on t from anon;",
    },
    ...(opts.manifest === null
      ? []
      : [{ path: EFFECT_REPLAYS_PATH, body: opts.manifest ?? MANIFEST }]),
  ];
  const calls = { branch: 0, tree: 0, blob: 0 };
  const octokit = {
    repos: {
      getBranch: vi.fn(async () => {
        calls.branch += 1;
        return {
          data: { commit: { sha: "commit-sha-1", commit: { tree: { sha: "tree-sha-1" } } } },
        };
      }),
      getContent: vi.fn(async () => {
        throw new Error("not reached");
      }),
    },
    git: {
      getTree: vi.fn(async () => {
        calls.tree += 1;
        return {
          data: {
            truncated: false,
            tree: files.map((f) => ({
              type: "blob",
              path: f.path,
              sha: `sha-${f.path}`,
              size: f.body.length,
            })),
          },
        };
      }),
      getBlob: vi.fn(async ({ file_sha }: { file_sha: string }) => {
        calls.blob += 1;
        if (opts.blobFails) throw Object.assign(new Error("Server Error"), { status: 502 });
        const hit = files.find((f) => `sha-${f.path}` === file_sha);
        if (!hit) throw new Error(`no such blob ${file_sha}`);
        return { data: { content: Buffer.from(hit.body, "utf-8").toString("base64") } };
      }),
    },
  };
  return { octokit: octokit as never, calls };
}

describe("fetchEffectReplayManifest", () => {
  it("reads the manifest from the listing the corpus takes, at the same commit", async () => {
    const { octokit, calls } = fakeOctokit();
    const corpus = await openPrimeMigrationCorpus(octokit, REF);
    const { commitSha, reading } = await fetchEffectReplayManifest(octokit, REF);
    expect(commitSha).toBe(corpus.sourceSha);
    // One listing for both, within the window the corpus already holds it for.
    expect(calls.branch).toBe(1);
    expect(calls.tree).toBe(1);
    expect(reading.state).toBe("read");
    expect(reading.entries.map((e) => e.kind)).toEqual(["privilege"]);
  });

  it("says absent when the tree carries no manifest", async () => {
    const { octokit } = fakeOctokit({ manifest: null });
    const { reading } = await fetchEffectReplayManifest(octokit, REF);
    expect(reading.state).toBe("absent");
  });

  it("says unfetched, never empty, when GitHub will not serve it", async () => {
    const { octokit } = fakeOctokit({ blobFails: true });
    const { reading } = await fetchEffectReplayManifest(octokit, REF);
    expect(reading.state).toBe("unfetched");
    expect(reading.state === "unfetched" && reading.why).toContain("Server Error");
    expect(reading.entries).toEqual([]);
  });

  it("reads the same bytes once", async () => {
    const { octokit, calls } = fakeOctokit();
    await fetchEffectReplayManifest(octokit, REF);
    await fetchEffectReplayManifest(octokit, REF);
    expect(calls.blob).toBe(1);
  });

  it("reports a manifest whose text cannot be used, rather than reading it as empty", async () => {
    const { octokit } = fakeOctokit({
      manifest: JSON.stringify({ schema_version: 2, replays: [] }),
    });
    const { reading } = await fetchEffectReplayManifest(octokit, REF);
    expect(reading.state).toBe("unreadable");
  });
});
