// The digest manifest refresh, proposed on Prime by Mission Control's App now
// that `main` takes nothing but pull requests: what it writes, that it reuses
// one branch and one pull request, and that it arms the merge.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  digests: [] as Array<{ version: string; name: string; sha256: string; status: string }>,
  manifest: null as string | null,
  open: [] as Array<{ number: number; html_url: string; node_id: string }>,
  branchExists: false,
  armError: null as string | null,
  log: [] as string[],
  blobs: [] as string[],
}));

vi.mock("@/server/migration-enqueue.server", () => ({
  readSettledDigests: async () => h.digests,
}));

vi.mock("@/server/github-app.server", () => ({
  getAppOctokit: () => ({
    repos: {
      getBranch: async () => ({
        data: { commit: { sha: "tip", commit: { tree: { sha: "tree0" } } } },
      }),
      getContent: async () => {
        if (h.manifest === null) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: { type: "file", content: Buffer.from(h.manifest).toString("base64") } };
      },
    },
    pulls: {
      list: async () => ({ data: h.open }),
      create: async (p: { head: string; base: string; title: string }) => {
        h.log.push(`create pr ${p.head} -> ${p.base}`);
        return {
          data: { number: 51, html_url: "https://github.com/acme/prime/pull/51", node_id: "PR_51" },
        };
      },
      update: async (p: { pull_number: number; state: string }) => {
        h.log.push(`close pr ${p.pull_number}`);
        return { data: {} };
      },
    },
    git: {
      createBlob: async (p: { content: string }) => {
        h.blobs.push(Buffer.from(p.content, "base64").toString("utf8"));
        return { data: { sha: "blob1" } };
      },
      createTree: async (p: { base_tree: string; tree: Array<{ path: string }> }) => {
        h.log.push(`tree ${p.tree.map((t) => t.path).join(",")} on ${p.base_tree}`);
        return { data: { sha: "tree1" } };
      },
      createCommit: async (p: { parents: string[] }) => {
        h.log.push(`commit on ${p.parents.join(",")}`);
        return { data: { sha: "c1" } };
      },
      createRef: async (p: { ref: string }) => {
        if (h.branchExists) {
          throw Object.assign(new Error("Reference already exists"), { status: 422 });
        }
        h.log.push(`create ${p.ref}`);
        return { data: {} };
      },
      updateRef: async (p: { ref: string; force: boolean }) => {
        h.log.push(`move ${p.ref}${p.force ? " (force)" : ""}`);
        return { data: {} };
      },
    },
    graphql: async (_q: string, vars: { id: string }) => {
      h.log.push(`arm ${vars.id}`);
      if (h.armError) throw new Error(h.armError);
      return {};
    },
  }),
}));

import { DIGEST_BRANCH, proposeAppliedDigests } from "./applied-digests-proposal.server";

const db = {
  from: () => ({
    select: () => ({
      limit: () => ({
        maybeSingle: async () => ({
          data: {
            github_owner: "acme",
            github_repo: "prime",
            default_branch: "main",
            github_app_installation_id: "1",
          },
          error: null,
        }),
      }),
    }),
  }),
} as never;

const HEADER = "# generated\n";
const d = (version: string, sha256: string) => ({
  version,
  name: `${version}_x.sql`,
  sha256,
  status: "applied",
});

beforeEach(() => {
  h.digests = [d("20260101000000", "a".repeat(64)), d("20260102000000", "b".repeat(64))];
  h.manifest = `${HEADER}20260101000000  ${"a".repeat(64)}  20260101000000_x.sql\n`;
  h.open = [];
  h.branchExists = false;
  h.armError = null;
  h.log = [];
  h.blobs = [];
});

describe("proposeAppliedDigests", () => {
  it("proposes the new manifest on its own branch and arms the merge", async () => {
    const r = await proposeAppliedDigests(db);
    expect(r).toMatchObject({ state: "proposed", number: 51, armed: true });
    expect(h.blobs[0]).toBe(
      `${HEADER}20260101000000  ${"a".repeat(64)}  20260101000000_x.sql\n` +
        `20260102000000  ${"b".repeat(64)}  20260102000000_x.sql\n`,
    );
    expect(h.log).toEqual([
      "tree scripts/applied-migration-digests.txt on tree0",
      "commit on tip",
      `create refs/heads/${DIGEST_BRANCH}`,
      `create pr ${DIGEST_BRANCH} -> main`,
      "arm PR_51",
    ]);
  });

  it("moves the one branch and reuses the open pull request", async () => {
    h.branchExists = true;
    h.open = [{ number: 50, html_url: "https://github.com/acme/prime/pull/50", node_id: "PR_50" }];
    const r = await proposeAppliedDigests(db);
    expect(r).toMatchObject({ state: "proposed", number: 50 });
    expect(h.log).toContain(`move heads/${DIGEST_BRANCH} (force)`);
    expect(h.log.some((l) => l.startsWith("create pr"))).toBe(false);
  });

  it("says so, and closes a stale proposal, when main already agrees", async () => {
    h.digests = [d("20260101000000", "a".repeat(64))];
    h.open = [{ number: 50, html_url: "u", node_id: "PR_50" }];
    const r = await proposeAppliedDigests(db);
    expect(r.state).toBe("current");
    expect(h.log).toEqual(["close pr 50"]);
    expect(h.blobs).toEqual([]);
  });

  it("leaves the pull request open, and says why, when the merge cannot be armed", async () => {
    h.armError = "Auto merge is not allowed for this repository";
    const r = await proposeAppliedDigests(db);
    expect(r).toMatchObject({ state: "proposed", armed: false });
    expect(r.state === "proposed" && r.detail).toMatch(/not allowed.*waits for a person/);
  });

  it("counts a merge an earlier refresh armed as armed", async () => {
    h.armError = "Pull request auto merge is already enabled";
    const r = await proposeAppliedDigests(db);
    expect(r).toMatchObject({ state: "proposed", armed: true });
  });

  it("proposes nothing from an empty read", async () => {
    h.digests = [];
    const r = await proposeAppliedDigests(db);
    expect(r.state).toBe("failed");
    expect(h.log).toEqual([]);
  });
});
