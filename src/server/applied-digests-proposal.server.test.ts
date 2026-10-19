// The digest manifest refresh, proposed by Mission Control's App on Mission
// Control's own repository — never on Prime's — now that `main` takes nothing
// but pull requests: which repository it acts on, what it writes, that it
// reuses one branch and one pull request, that it arms the merge, and that it
// takes back what the misdirected first refresh opened on Prime.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  digests: [] as Array<{ version: string; name: string; sha256: string; status: string }>,
  manifest: null as string | null,
  open: [] as Array<{ number: number; html_url: string; node_id: string }>,
  branchExists: false,
  armError: null as string | null,
  log: [] as string[],
  blobs: [] as string[],
  /** Every repository a call named, as owner/repo. */
  repos: new Set<string>(),
}));

vi.mock("@/server/migration-enqueue.server", () => ({
  readSettledDigests: async () => h.digests,
}));

vi.mock("@/server/github-app.server", () => {
  const seen = (p: { owner?: string; repo?: string }) => {
    if (p.owner && p.repo) h.repos.add(`${p.owner}/${p.repo}`);
  };
  return {
    getAppOctokit: () => ({
      repos: {
        get: async (p: { owner: string; repo: string }) => {
          seen(p);
          return { data: { default_branch: "main" } };
        },
        getBranch: async (p: { owner: string; repo: string }) => {
          seen(p);
          return { data: { commit: { sha: "tip", commit: { tree: { sha: "tree0" } } } } };
        },
        getContent: async (p: { owner: string; repo: string }) => {
          seen(p);
          if (h.manifest === null) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: { type: "file", content: Buffer.from(h.manifest).toString("base64") } };
        },
      },
      pulls: {
        list: async (p: { owner: string; repo: string; head: string }) => {
          seen(p);
          h.log.push(`list ${p.owner}/${p.repo} ${p.head}`);
          return { data: h.open };
        },
        create: async (p: { owner: string; repo: string; head: string; base: string }) => {
          seen(p);
          h.log.push(`create pr ${p.head} -> ${p.base}`);
          return {
            data: {
              number: 51,
              html_url: `https://github.com/${p.owner}/${p.repo}/pull/51`,
              node_id: "PR_51",
            },
          };
        },
        update: async (p: { owner: string; repo: string; pull_number: number }) => {
          seen(p);
          h.log.push(`close pr ${p.owner}/${p.repo}#${p.pull_number}`);
          return { data: {} };
        },
      },
      git: {
        createBlob: async (p: { owner: string; repo: string; content: string }) => {
          seen(p);
          h.blobs.push(Buffer.from(p.content, "base64").toString("utf8"));
          return { data: { sha: "blob1" } };
        },
        createTree: async (p: {
          owner: string;
          repo: string;
          base_tree: string;
          tree: Array<{ path: string }>;
        }) => {
          seen(p);
          h.log.push(`tree ${p.tree.map((t) => t.path).join(",")} on ${p.base_tree}`);
          return { data: { sha: "tree1" } };
        },
        createCommit: async (p: { owner: string; repo: string; parents: string[] }) => {
          seen(p);
          h.log.push(`commit on ${p.parents.join(",")}`);
          return { data: { sha: "c1" } };
        },
        createRef: async (p: { owner: string; repo: string; ref: string }) => {
          seen(p);
          if (h.branchExists) {
            throw Object.assign(new Error("Reference already exists"), { status: 422 });
          }
          h.log.push(`create ${p.ref}`);
          return { data: {} };
        },
        updateRef: async (p: { owner: string; repo: string; ref: string; force: boolean }) => {
          seen(p);
          h.log.push(`move ${p.ref}${p.force ? " (force)" : ""}`);
          return { data: {} };
        },
        deleteRef: async (p: { owner: string; repo: string; ref: string }) => {
          seen(p);
          if (!h.branchExists) {
            throw Object.assign(new Error("Reference does not exist"), { status: 422 });
          }
          h.log.push(`delete ${p.owner}/${p.repo} ${p.ref}`);
          return { data: {} };
        },
      },
      graphql: async (_q: string, vars: { id: string }) => {
        h.log.push(`arm ${vars.id}`);
        if (h.armError) throw new Error(h.armError);
        return {};
      },
    }),
  };
});

import {
  DIGEST_BRANCH,
  proposeAppliedDigests,
  retractStrayDigestProposal,
} from "./applied-digests-proposal.server";

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

afterAll(() => {
  delete process.env.MISSION_CONTROL_GITHUB_REPO;
});

beforeEach(() => {
  process.env.MISSION_CONTROL_GITHUB_REPO = "acme/control";
  h.digests = [d("20260101000000", "a".repeat(64)), d("20260102000000", "b".repeat(64))];
  h.manifest = `${HEADER}20260101000000  ${"a".repeat(64)}  20260101000000_x.sql\n`;
  h.open = [];
  h.branchExists = false;
  h.armError = null;
  h.log = [];
  h.blobs = [];
  h.repos = new Set();
});

describe("proposeAppliedDigests", () => {
  it("proposes the new manifest on Mission Control's repository, and only there", async () => {
    const r = await proposeAppliedDigests(db, { requestedBy: "acme/control" });
    expect(r).toMatchObject({
      state: "proposed",
      number: 51,
      armed: true,
      url: "https://github.com/acme/control/pull/51",
    });
    // prime_config names acme/prime; nothing went near it.
    expect([...h.repos]).toEqual(["acme/control"]);
    expect(h.blobs[0]).toBe(
      `${HEADER}20260101000000  ${"a".repeat(64)}  20260101000000_x.sql\n` +
        `20260102000000  ${"b".repeat(64)}  20260102000000_x.sql\n`,
    );
    expect(h.log).toEqual([
      `list acme/control acme:${DIGEST_BRANCH}`,
      "tree scripts/applied-migration-digests.txt on tree0",
      "commit on tip",
      `create refs/heads/${DIGEST_BRANCH}`,
      `create pr ${DIGEST_BRANCH} -> main`,
      "arm PR_51",
    ]);
  });

  it("refuses a refresh asked for from another repository", async () => {
    for (const asker of ["acme/prime", "someone/else", "not a repo"]) {
      const r = await proposeAppliedDigests(db, { requestedBy: asker });
      expect(r.state).toBe("failed");
      expect(r.state === "failed" && r.detail).toMatch(/lives in acme\/control/);
    }
    expect(h.repos.size).toBe(0);
  });

  it("refuses when the repository it is told is Mission Control's is Prime's", async () => {
    process.env.MISSION_CONTROL_GITHUB_REPO = "acme/prime";
    const r = await proposeAppliedDigests(db);
    expect(r.state).toBe("failed");
    expect(r.state === "failed" && r.detail).toMatch(/Prime's repository/);
    expect(h.repos.size).toBe(0);
  });

  it("moves the one branch and reuses the open pull request", async () => {
    h.branchExists = true;
    h.open = [
      { number: 50, html_url: "https://github.com/acme/control/pull/50", node_id: "PR_50" },
    ];
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
    expect(h.log).toEqual([`list acme/control acme:${DIGEST_BRANCH}`, "close pr acme/control#50"]);
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

describe("retractStrayDigestProposal", () => {
  it("closes the misdirected pull request on Prime and deletes its branch", async () => {
    h.open = [{ number: 3316, html_url: "u", node_id: "PR_3316" }];
    h.branchExists = true;
    const r = await retractStrayDigestProposal(db);
    expect(r).toEqual({ closed: [3316], branchDeleted: true, repo: "acme/prime" });
    expect(h.log).toEqual([
      `list acme/prime acme:${DIGEST_BRANCH}`,
      "close pr acme/prime#3316",
      `delete acme/prime heads/${DIGEST_BRANCH}`,
    ]);
  });

  it("changes nothing once they are gone", async () => {
    const r = await retractStrayDigestProposal(db);
    expect(r).toEqual({ closed: [], branchDeleted: false, repo: "acme/prime" });
    expect(h.log).toEqual([`list acme/prime acme:${DIGEST_BRANCH}`]);
  });

  it("never touches Mission Control's own repository", async () => {
    process.env.MISSION_CONTROL_GITHUB_REPO = "acme/prime";
    const r = await retractStrayDigestProposal(db);
    expect(r).toEqual({ closed: [], branchDeleted: false, repo: null });
    expect(h.repos.size).toBe(0);
  });
});
