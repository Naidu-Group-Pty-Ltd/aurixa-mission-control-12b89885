/**
 * The history walk reads every revision in one request and reports what the
 * per-revision walk reported.
 *
 * The walk used to read the path at each commit with one contents call, in
 * series: a clone whose copy matched nothing recent paid ten round trips for
 * one path, and the left-behind probe's fifteen walks were the phase that
 * pushed the independent's carry past the tick. These tests pin that the
 * batched read changes the cost and nothing else: the same versions, the same
 * early stop, the same rate-limit rule, and the old road for everything the
 * request does not answer exactly.
 */
import { describe, expect, it } from "vitest";
import {
  probeDeletions,
  probeHeldPaths,
  probePrimeDeletion,
  probePrimeVersions,
} from "./cascadeDeletions.server";
import type { HeldPathEvidence } from "./cascade/heldEvidence.pure";

const id = (n: number) => n.toString(16).padStart(40, "0");

/** The versions a probe reported; fails the test if it reported anything else. */
function versionsOf(evidence: HeldPathEvidence): readonly string[] {
  if (evidence.kind !== "prime_versions") {
    throw new Error(`Expected prime_versions, got ${JSON.stringify(evidence)}`);
  }
  return evidence.versions;
}
const PRIME = { owner: "o", repo: "prime", branch: "main" };

/** One commit's entry at a path, as git holds it. */
type Entry = {
  oid: string;
  mode: number;
  type: "blob" | "tree" | "commit";
  target?: string;
} | null;

/** A prime whose history for each path is a list of commits, newest first. */
type History = Record<string, Array<{ commit: string; entry: Entry }>>;

function rateLimitError() {
  return Object.assign(new Error("API rate limit exceeded for installation ID 1."), {
    status: 403,
  });
}

/**
 * A GitHub that answers `listCommits`, the contents API and the batch query
 * from `history`. `graphql: false` builds one with no GraphQL at all, which is
 * what every pass read with before the batch: the per-revision walk.
 */
function fakeGitHub(
  history: History,
  opts: {
    graphql?: false | ((query: string, vars: Record<string, string>) => unknown);
    getContent?: (args: { path: string; ref: string }) => unknown;
  } = {},
) {
  const calls = { listCommits: 0, getContent: 0, graphql: 0 };
  const entryAt = (path: string, commit: string): Entry | undefined =>
    history[path]?.find((h) => h.commit === commit)?.entry;
  const answer = (query: string, vars: Record<string, string>) => {
    const repository: Record<string, unknown> = {};
    const lookups = query.matchAll(
      /(p\d+c\d+): object\(oid: "([0-9a-f]{40})"\) \{ \.\.\. on Commit \{ file\(path: \$(p\d+)\)/g,
    );
    for (const [, alias, commit, pvar] of lookups) {
      const entry = entryAt(vars[pvar], commit);
      repository[alias] =
        entry === undefined
          ? null
          : {
              file: entry === null ? null : { oid: entry.oid, mode: entry.mode, type: entry.type },
            };
    }
    return { repository };
  };
  const octokit: Record<string, unknown> = {
    repos: {
      listCommits: async ({ path, per_page }: { path: string; per_page: number }) => {
        calls.listCommits += 1;
        return { data: (history[path] ?? []).slice(0, per_page).map((h) => ({ sha: h.commit })) };
      },
      getContent: async (args: { path: string; ref: string }) => {
        calls.getContent += 1;
        if (opts.getContent) return opts.getContent(args);
        const entry = entryAt(args.path, args.ref);
        if (!entry) throw Object.assign(new Error("Not Found"), { status: 404 });
        if (entry.type === "tree") return { data: [] };
        // The contents API follows a link to the file it names.
        return { data: { sha: entry.target ?? entry.oid } };
      },
    },
  };
  if (opts.graphql !== false) {
    octokit.graphql = async (query: string, vars: Record<string, string>) => {
      calls.graphql += 1;
      return opts.graphql ? opts.graphql(query, vars) : answer(query, vars);
    };
  }
  return { octokit: octokit as never, calls, answer };
}

const file = (n: number): Entry => ({ oid: id(n), mode: 0o100644, type: "blob" });

/** Ten revisions of one live path, each a different blob. */
function tenVersions(path: string, base: number): History {
  return {
    [path]: Array.from({ length: 10 }, (_, i) => ({
      commit: id(base + i),
      entry: file(base + 100 + i),
    })),
  };
}

describe("the walk reads every revision in one request", () => {
  it("reports what the per-revision walk reported, for one request instead of ten", async () => {
    const history = tenVersions("tsconfig.json", 0x100);
    const batched = fakeGitHub(history);
    const perRevision = fakeGitHub(history, { graphql: false });
    const clone = id(0xfff); // matches nothing: the whole walk is read
    const got = await probePrimeVersions(batched.octokit, PRIME, "tsconfig.json", clone);
    const was = await probePrimeVersions(perRevision.octokit, PRIME, "tsconfig.json", clone);
    expect(got).toEqual(was);
    expect(got).toEqual({
      kind: "prime_versions",
      versions: history["tsconfig.json"].map((h) => (h.entry as { oid: string }).oid),
      versionsExhaustive: true,
    });
    expect(batched.calls).toEqual({ listCommits: 1, getContent: 0, graphql: 1 });
    expect(perRevision.calls.getContent).toBe(10);
  });

  it("stops at the first version the clone holds, and repeats none", async () => {
    const path = "vite.config.ts";
    const history: History = {
      [path]: [
        { commit: id(1), entry: file(0xa) },
        { commit: id(2), entry: file(0xb) },
        { commit: id(3), entry: file(0xa) }, // a revert: the same blob again
        { commit: id(4), entry: file(0xc) },
        { commit: id(5), entry: file(0xd) },
      ],
    };
    const got = await probePrimeVersions(fakeGitHub(history).octokit, PRIME, path, id(0xc));
    const was = await probePrimeVersions(
      fakeGitHub(history, { graphql: false }).octokit,
      PRIME,
      path,
      id(0xc),
    );
    expect(got).toEqual(was);
    expect(got).toEqual({
      kind: "prime_versions",
      versions: [id(0xa), id(0xb), id(0xc)],
      versionsExhaustive: true,
    });
  });

  it("reads the removing commit as 'no blob here', exactly as its 404 was read", async () => {
    const path = "src/gone.ts";
    const history: History = {
      [path]: [
        { commit: id(0xdead), entry: null },
        { commit: id(0xbeef), entry: file(0x1) },
      ],
    };
    const got = await probePrimeDeletion(fakeGitHub(history).octokit, PRIME, path, id(0x1));
    expect(got).toEqual({
      kind: "removed",
      deletedIn: id(0xdead),
      versions: [id(0x1)],
      versionsExhaustive: true,
    });
  });

  it("asks every held path's walk in ONE request, and answers each in order", async () => {
    const paths = ["a.yml", "b.yml", "c.yml", "d.yml", "e.yml"];
    const history: History = Object.assign(
      {},
      ...paths.map((p, i) => tenVersions(p, (i + 1) * 0x1000)),
    );
    const candidates = paths.map((path, i) => ({ path, cloneSha: id((i + 1) * 0x1000 + 100 + i) }));
    const batched = fakeGitHub(history);
    const got = await probeHeldPaths({ octokit: batched.octokit, primeRef: PRIME, candidates });
    const was = await probeHeldPaths({
      octokit: fakeGitHub(history, { graphql: false }).octokit,
      primeRef: PRIME,
      candidates,
    });
    expect([...got.entries()]).toEqual([...was.entries()]);
    expect([...got.keys()]).toEqual(paths);
    expect(batched.calls).toEqual({ listCommits: 5, getContent: 0, graphql: 1 });
  });

  it("asks a deletion chunk's walks in one request as well", async () => {
    const history: History = {};
    const candidates = Array.from({ length: 6 }, (_, i) => {
      const path = `src/gone-${i}.ts`;
      history[path] = [
        { commit: id(0xd000 + i), entry: null },
        { commit: id(0xe000 + i), entry: file(0xf000 + i) },
      ];
      return { path, cloneSha: id(0xf000 + i) };
    });
    const batched = fakeGitHub(history);
    const res = await probeDeletions({
      octokit: batched.octokit,
      primeRef: PRIME,
      candidates,
      primeDirectories: new Set(),
      maxProbes: candidates.length,
    });
    expect(res.candidates.map((c) => c.evidence.kind)).toEqual(Array(6).fill("removed"));
    expect(batched.calls).toEqual({ listCommits: 6, getContent: 0, graphql: 1 });
  });
});

describe("what the request does not answer exactly takes the old road", () => {
  it("never lends one listing's answers to a different listing of the same path", async () => {
    // A path asked twice whose history moved between the two listings: the
    // second walk's revisions are not the ones the request answered.
    const path = "README.md";
    const older: History = {
      [path]: [
        { commit: id(1), entry: file(0xa) },
        { commit: id(2), entry: file(0xb) },
      ],
    };
    const newer: History = {
      [path]: [{ commit: id(3), entry: file(0xc) }, ...older[path]],
    };
    const gh = fakeGitHub(older);
    let listed = 0;
    const repos = (gh.octokit as unknown as { repos: Record<string, unknown> }).repos;
    const list = repos.listCommits as (a: { path: string; per_page: number }) => Promise<unknown>;
    repos.listCommits = async (args: { path: string; per_page: number }) => {
      listed += 1;
      if (listed === 1) return list(args);
      return { data: newer[path].map((h) => ({ sha: h.commit })) };
    };
    repos.getContent = async (args: { path: string; ref: string }) => {
      const entry = newer[path].find((h) => h.commit === args.ref)?.entry;
      if (!entry) throw Object.assign(new Error("Not Found"), { status: 404 });
      return { data: { sha: entry.oid } };
    };
    const got = await probeHeldPaths({
      octokit: gh.octokit,
      primeRef: PRIME,
      candidates: [
        { path, cloneSha: id(0xfff) },
        { path, cloneSha: id(0xfff) },
      ],
    });
    // The later listing's walk is what the map keeps, read revision by revision.
    expect(got.get(path)).toEqual({
      kind: "prime_versions",
      versions: [id(0xc), id(0xa), id(0xb)],
      versionsExhaustive: true,
    });
  });

  it("reads a link per revision, because the contents API answers it with the file it names", async () => {
    const path = "docs/current.md";
    const history: History = {
      [path]: [
        { commit: id(1), entry: { oid: id(0x11), mode: 0o120000, type: "blob", target: id(0x22) } },
        { commit: id(2), entry: file(0x33) },
      ],
    };
    const batched = fakeGitHub(history);
    const got = await probePrimeVersions(batched.octokit, PRIME, path, id(0xfff));
    const was = await probePrimeVersions(
      fakeGitHub(history, { graphql: false }).octokit,
      PRIME,
      path,
      id(0xfff),
    );
    expect(got).toEqual(was);
    expect(versionsOf(got)).toEqual([id(0x22), id(0x33)]);
    expect(batched.calls.getContent).toBe(1);
  });

  it("reads per revision when the request fails, a rate limit included", async () => {
    const history = tenVersions("package.json", 0x200);
    for (const failure of [new Error("Something went wrong"), rateLimitError()]) {
      const gh = fakeGitHub(history, {
        graphql: () => {
          throw failure;
        },
      });
      const got = await probePrimeVersions(gh.octokit, PRIME, "package.json", id(0xfff));
      expect(versionsOf(got)).toHaveLength(10);
      expect(gh.calls.getContent).toBe(10);
    }
  });

  it("still throws a rate limit from the per-revision read — a limited read is not 'no blob here'", async () => {
    const history = tenVersions("package.json", 0x300);
    const gh = fakeGitHub(history, {
      graphql: () => {
        throw rateLimitError();
      },
      getContent: () => {
        throw rateLimitError();
      },
    });
    await expect(probePrimeVersions(gh.octokit, PRIME, "package.json", id(0xfff))).rejects.toThrow(
      /rate limit/i,
    );
  });

  it("does not read a null beside an error as 'no blob here'", async () => {
    // GraphQL nulls a field that failed and reports it in `errors`, which
    // octokit throws with the partial data attached. The path DID hold a
    // blob at that commit; reading the null as absence would skip it.
    const path = "index.html";
    const history: History = {
      [path]: [
        { commit: id(1), entry: file(0xa) },
        { commit: id(2), entry: file(0xb) },
      ],
    };
    let answer: (q: string, v: Record<string, string>) => unknown = () => null;
    const gh = fakeGitHub(history, {
      graphql: (query, vars) => {
        const partial = answer(query, vars) as { repository: Record<string, unknown> };
        partial.repository.p0c1 = { file: null };
        throw Object.assign(new Error("Something went wrong while executing your query"), {
          data: partial,
        });
      },
    });
    answer = fakeGitHub(history).answer;
    const got = await probePrimeVersions(gh.octokit, PRIME, path, id(0xfff));
    expect(versionsOf(got)).toEqual([id(0xa), id(0xb)]);
    // The first revision came from the partial answer; the nulled one was read.
    expect(gh.calls.getContent).toBe(1);
  });
});
