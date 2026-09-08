import { describe, it, expect, vi } from "vitest";
import { fetchBlobTextsBatched } from "./prime-backend.server";

const REF = { owner: "Naidu-Group-Pty-Ltd", repo: "npc-property-dashbord", branch: "main" };

/**
 * The deploy lane reads a clone's function bodies in GraphQL batches of ~80
 * and falls back to REST for anything GraphQL cannot carry.
 *
 * What these pin is the ANSWER-shaped failure, not the blob-shaped one.
 * On 8 Sep 2026 the fleet deploy lane raised
 * `Cannot read properties of undefined (reading 'repository')` against two
 * clones — Preflight Property Group had spent five of its thirty attempts on
 * it — because a GraphQL body with no `repository` was dereferenced straight
 * away. The failure told an operator nothing (a TypeError names no repo, no
 * batch and no file), and it cost a whole remediation attempt for a fault
 * that has a working remedy sitting in the same function.
 *
 * So the property under test is not "does it return the right bytes" — the
 * old code returned the right bytes whenever it returned at all. It is: when
 * GraphQL cannot answer, does every file in that batch still arrive, by REST,
 * without the run failing? And its converse, which is the one that makes the
 * fallback safe to have: a fault REST SHARES must still surface by name
 * rather than being buried under a retry that cannot succeed.
 */
function fakeOctokit(opts: {
  bodies: Record<string, string>;
  graphql: (query: string) => unknown;
  getBlob?: (sha: string) => Promise<{ data: { content: string } }>;
}) {
  const restCalls: string[] = [];
  const graphqlCalls: string[] = [];
  const octokit = {
    graphql: vi.fn(async (query: string) => {
      graphqlCalls.push(query);
      return opts.graphql(query);
    }),
    git: {
      getBlob: vi.fn(async ({ file_sha }: { file_sha: string }) => {
        restCalls.push(file_sha);
        if (opts.getBlob) return opts.getBlob(file_sha);
        const body = opts.bodies[file_sha];
        if (body === undefined) throw new Error(`no such blob ${file_sha}`);
        return { data: { content: Buffer.from(body, "utf-8").toString("base64") } };
      }),
    },
  };
  // The real Octokit type is far wider than what this module touches.
  return { octokit: octokit as never, restCalls, graphqlCalls };
}

const ENTRIES = [
  { rel: "listings-cache/index.ts", sha: "sha-a" },
  { rel: "airtable-proxy/index.ts", sha: "sha-b" },
];
const BODIES = { "sha-a": "export const a = 1;\n", "sha-b": "export const b = 2;\n" };

function decoded(out: Map<string, string>) {
  return Object.fromEntries(
    Array.from(out, ([rel, b64]) => [rel, Buffer.from(b64, "base64").toString("utf-8")]),
  );
}

describe("fetchBlobTextsBatched", () => {
  it("serves a healthy batch from GraphQL alone", async () => {
    const { octokit, restCalls } = fakeOctokit({
      bodies: BODIES,
      graphql: () => ({
        repository: {
          b0: { text: BODIES["sha-a"], isBinary: false, isTruncated: false },
          b1: { text: BODIES["sha-b"], isBinary: false, isTruncated: false },
        },
      }),
    });
    const out = await fetchBlobTextsBatched(octokit, REF, ENTRIES);
    expect(decoded(out)).toEqual({
      "listings-cache/index.ts": BODIES["sha-a"],
      "airtable-proxy/index.ts": BODIES["sha-b"],
    });
    expect(restCalls).toEqual([]);
  });

  it("re-asks the whole batch by REST when the answer carries no repository", async () => {
    const { octokit, restCalls } = fakeOctokit({
      bodies: BODIES,
      // What GitHub hands back beside `errors`, and what the lane fell over on.
      graphql: () => ({ errors: [{ message: "was submitted too quickly" }] }),
    });
    const out = await fetchBlobTextsBatched(octokit, REF, ENTRIES);
    expect(decoded(out)).toEqual({
      "listings-cache/index.ts": BODIES["sha-a"],
      "airtable-proxy/index.ts": BODIES["sha-b"],
    });
    expect(restCalls.sort()).toEqual(["sha-a", "sha-b"]);
  });

  it("re-asks the whole batch by REST when the answer is undefined", async () => {
    const { octokit, restCalls } = fakeOctokit({
      bodies: BODIES,
      graphql: () => undefined,
    });
    const out = await fetchBlobTextsBatched(octokit, REF, ENTRIES);
    expect(Object.keys(decoded(out)).sort()).toEqual([
      "airtable-proxy/index.ts",
      "listings-cache/index.ts",
    ]);
    expect(restCalls).toHaveLength(2);
  });

  it("re-asks the whole batch by REST when repository is null", async () => {
    const { octokit, restCalls } = fakeOctokit({
      bodies: BODIES,
      graphql: () => ({ repository: null }),
    });
    const out = await fetchBlobTextsBatched(octokit, REF, ENTRIES);
    expect(restCalls).toHaveLength(2);
    expect(decoded(out)["listings-cache/index.ts"]).toBe(BODIES["sha-a"]);
  });

  it("re-asks the whole batch by REST when the GraphQL request throws", async () => {
    const { octokit, restCalls } = fakeOctokit({
      bodies: BODIES,
      graphql: () => {
        throw new Error("502 Bad Gateway");
      },
    });
    const out = await fetchBlobTextsBatched(octokit, REF, ENTRIES);
    expect(decoded(out)).toEqual({
      "listings-cache/index.ts": BODIES["sha-a"],
      "airtable-proxy/index.ts": BODIES["sha-b"],
    });
    expect(restCalls).toHaveLength(2);
  });

  it("still routes a single unusable blob to REST while the rest come from GraphQL", async () => {
    const { octokit, restCalls } = fakeOctokit({
      bodies: BODIES,
      graphql: () => ({
        repository: {
          b0: { text: null, isBinary: true, isTruncated: false },
          b1: { text: BODIES["sha-b"], isBinary: false, isTruncated: false },
        },
      }),
    });
    const out = await fetchBlobTextsBatched(octokit, REF, ENTRIES);
    expect(restCalls).toEqual(["sha-a"]);
    expect(decoded(out)["listings-cache/index.ts"]).toBe(BODIES["sha-a"]);
  });

  it("surfaces a fault REST shares by name rather than burying it", async () => {
    // A revoked token or an exhausted quota fails both roads. The fallback
    // must not turn that into silence: the REST error is what an operator
    // needs, and it is what the run records.
    const { octokit } = fakeOctokit({
      bodies: BODIES,
      graphql: () => {
        throw new Error("401 Bad credentials");
      },
      getBlob: async () => {
        throw new Error("401 Bad credentials");
      },
    });
    await expect(fetchBlobTextsBatched(octokit, REF, ENTRIES)).rejects.toThrow(
      "401 Bad credentials",
    );
  });

  it("never raises a TypeError for a malformed answer", async () => {
    for (const answer of [undefined, null, {}, { repository: null }, { repository: undefined }]) {
      const { octokit } = fakeOctokit({ bodies: BODIES, graphql: () => answer });
      await expect(fetchBlobTextsBatched(octokit, REF, ENTRIES)).resolves.toBeInstanceOf(Map);
    }
  });
});
