import { describe, expect, it } from "vitest";
import { gitBlobSha } from "./cascade/gitBlobSha.pure";
import {
  PRIME_TEXT_BATCH_CONCURRENCY,
  PRIME_TEXT_BATCH_ENTRIES,
  PRIME_TEXT_MAX_BYTES,
} from "./cascade/primeTextBatch.pure";
import {
  readBlobTextsBatched,
  readBlobTextsExact,
  repoFileFromExactText,
} from "./github-app.server";

type Octokit = Parameters<typeof readBlobTextsBatched>[0];

/** `n` distinct source files, with the id and size a tree listing would give. */
function files(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const text = `export const value${i} = ${i};\n`;
    return { path: `src/f${i}.ts`, text, sha: gitBlobSha(text), size: Buffer.byteLength(text) };
  });
}

/**
 * A GitHub that answers the batch query from a table of blobs by id, and
 * records what it was asked. `answer` may shape or refuse any one query.
 */
function fakeGitHub(
  blobs: ReadonlyMap<string, string>,
  answer?: (call: number, aliases: Map<string, string>) => unknown,
) {
  const queries: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const octokit = {
    graphql: async (query: string, vars: Record<string, unknown>) => {
      const call = queries.length;
      queries.push(query);
      expect(vars).toEqual({ owner: "o", repo: "r" });
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const aliases = new Map<string, string>();
      for (const m of query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)) {
        aliases.set(m[1], m[2]);
      }
      const shaped = answer?.(call, aliases);
      if (shaped !== undefined) {
        if (shaped instanceof Error) throw shaped;
        return shaped;
      }
      const repository: Record<string, unknown> = {};
      for (const [alias, oid] of aliases) {
        const text = blobs.get(oid);
        repository[alias] =
          text === undefined ? null : { text, isBinary: false, isTruncated: false };
      }
      return { repository };
    },
  } as unknown as Octokit;
  return { octokit, queries, peak: () => peak };
}

const REF = { owner: "o", repo: "r" };

describe("readBlobTextsBatched", () => {
  it("reads a whole candidate list in a handful of queries, a few at a time", async () => {
    const list = files(PRIME_TEXT_BATCH_ENTRIES * 5 + 3);
    const gh = fakeGitHub(new Map(list.map((f) => [f.sha, f.text])));
    const texts = await readBlobTextsBatched(gh.octokit, REF, list);
    expect(gh.queries).toHaveLength(6);
    expect(gh.peak()).toBeLessThanOrEqual(PRIME_TEXT_BATCH_CONCURRENCY);
    expect(texts.size).toBe(list.length);
    for (const f of list) expect(texts.get(f.path)).toBe(f.text);
  });

  it("leaves a failed batch unanswered and never throws", async () => {
    const list = files(PRIME_TEXT_BATCH_ENTRIES + 1);
    const gh = fakeGitHub(new Map(list.map((f) => [f.sha, f.text])), (call) =>
      call === 0 ? new Error("secondary rate limit") : undefined,
    );
    const texts = await readBlobTextsBatched(gh.octokit, REF, list);
    // The first batch threw: its eighty are read per file by the caller. The
    // second answered.
    expect(texts.size).toBe(1);
    expect(texts.get(list[PRIME_TEXT_BATCH_ENTRIES].path)).toBe(
      list[PRIME_TEXT_BATCH_ENTRIES].text,
    );
  });

  it("uses what an erroring answer carries, because each text is still id-checked", async () => {
    const list = files(3);
    const gh = fakeGitHub(new Map(), () =>
      Object.assign(new Error("Something went wrong while executing your query"), {
        data: {
          repository: {
            b0: { text: list[0].text, isBinary: false, isTruncated: false },
            b1: null,
            // A text that is not the file asked for at that index.
            b2: { text: list[0].text, isBinary: false, isTruncated: false },
          },
        },
      }),
    );
    const texts = await readBlobTextsBatched(gh.octokit, REF, list);
    expect([...texts.keys()]).toEqual([list[0].path]);
  });

  it("treats a body with no repository as a batch that told us nothing", async () => {
    const list = files(2);
    const gh = fakeGitHub(new Map(), () => ({ repository: null }));
    expect((await readBlobTextsBatched(gh.octokit, REF, list)).size).toBe(0);
    const empty = fakeGitHub(new Map(), () => null);
    expect((await readBlobTextsBatched(empty.octokit, REF, list)).size).toBe(0);
  });

  it("starts no batch once the pass's budget says stop", async () => {
    // More batches than one round starts, so the stop has something to stop.
    const list = files(PRIME_TEXT_BATCH_ENTRIES * (PRIME_TEXT_BATCH_CONCURRENCY + 2));
    const gh = fakeGitHub(new Map(list.map((f) => [f.sha, f.text])));
    const none = await readBlobTextsBatched(gh.octokit, REF, list, {
      isPastDeadline: () => true,
    });
    expect(none.size).toBe(0);
    expect(gh.queries).toHaveLength(0);

    // Past the deadline after the first round: what was started finishes, and
    // nothing more is started. The reserve is the slowest batch so far.
    let asked = 0;
    const reserves: number[] = [];
    const some = await readBlobTextsBatched(gh.octokit, REF, list, {
      isPastDeadline: (reserveMs) => {
        reserves.push(reserveMs);
        asked += 1;
        return asked > PRIME_TEXT_BATCH_CONCURRENCY;
      },
    });
    expect(some.size).toBe(PRIME_TEXT_BATCH_CONCURRENCY * PRIME_TEXT_BATCH_ENTRIES);
    expect(reserves[0]).toBe(0);
    expect(Math.max(...reserves)).toBeGreaterThan(0);
  });

  it("asks nothing for a list it cannot serve exactly", async () => {
    const gh = fakeGitHub(new Map());
    const texts = await readBlobTextsBatched(gh.octokit, REF, [
      { path: "no-size", sha: "0".repeat(40), size: undefined },
    ]);
    expect(texts.size).toBe(0);
    expect(gh.queries).toHaveLength(0);
  });
});

describe("readBlobTextsExact", () => {
  /**
   * `fakeGitHub`'s batch road, with the blobs API beside it: `git.getBlob`
   * answers from `blobs` (or from `perFile`, to serve bytes that are not the
   * id asked), and every id it was asked is recorded.
   */
  function withBlobs(
    blobs: ReadonlyMap<string, string>,
    perFile?: (sha: string) => { encoding: string; content: string } | Error | undefined,
    batch?: Parameters<typeof fakeGitHub>[1],
  ) {
    const gh = fakeGitHub(blobs, batch);
    const blobReads: string[] = [];
    (gh.octokit as unknown as { git: unknown }).git = {
      getBlob: async (args: { owner: string; repo: string; file_sha: string }) => {
        expect([args.owner, args.repo]).toEqual(["o", "r"]);
        blobReads.push(args.file_sha);
        const shaped = perFile?.(args.file_sha);
        if (shaped instanceof Error) throw shaped;
        if (shaped !== undefined) return { data: shaped };
        const text = blobs.get(args.file_sha);
        if (text === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
        return { data: { encoding: "base64", content: Buffer.from(text).toString("base64") } };
      },
    };
    return { ...gh, blobReads };
  }

  // Larger than GraphQL serves whole, so the batch road never asks for it:
  // the shape of `ai-dashboard-agent/index.ts`, 1.7 MB on both sides.
  const big = "x".repeat(PRIME_TEXT_MAX_BYTES + 1);
  const bigWant = {
    path: "supabase/functions/ai-dashboard-agent/index.ts",
    sha: gitBlobSha(big),
    size: big.length,
  };

  it("reads per file, by blob id, what the batch road cannot serve whole", async () => {
    const small = files(3);
    const gh = withBlobs(
      new Map([...small.map((f) => [f.sha, f.text] as const), [bigWant.sha, big]]),
    );
    const texts = await readBlobTextsExact(gh.octokit, REF, [...small, bigWant], {
      maxBytes: 8 * 1024 * 1024,
    });
    expect(texts.size).toBe(4);
    expect(texts.get(bigWant.path)).toBe(big);
    for (const f of small) expect(texts.get(f.path)).toBe(f.text);
    // The batch answered the small ones; only the big one went per file.
    expect(gh.queries).toHaveLength(1);
    expect(gh.blobReads).toEqual([bigWant.sha]);
  });

  it("reads per file what a failed batch left unanswered", async () => {
    const list = files(2);
    const gh = withBlobs(
      new Map(list.map((f) => [f.sha, f.text])),
      undefined,
      () => new Error("secondary rate limit"),
    );
    const texts = await readBlobTextsExact(gh.octokit, REF, list, { maxBytes: 1024 });
    expect([...texts.keys()].sort()).toEqual(list.map((f) => f.path).sort());
    expect(gh.blobReads.sort()).toEqual(list.map((f) => f.sha).sort());
  });

  it("keeps a per-file text only where its bytes are the id asked", async () => {
    const other = "export const other = 1;\n";
    const gh = withBlobs(new Map(), () => ({
      encoding: "base64",
      content: Buffer.from(other).toString("base64"),
    }));
    const texts = await readBlobTextsExact(gh.octokit, REF, [bigWant], {
      maxBytes: 8 * 1024 * 1024,
    });
    expect(texts.size).toBe(0);
    expect(gh.blobReads).toEqual([bigWant.sha]);
  });

  it("never reads whole a file the listing gave no size for, or one over the ceiling", async () => {
    const gh = withBlobs(new Map([[bigWant.sha, big]]));
    const texts = await readBlobTextsExact(
      gh.octokit,
      REF,
      [
        { ...bigWant, size: undefined },
        { ...bigWant, path: "over", size: big.length },
      ],
      { maxBytes: big.length - 1 },
    );
    expect(texts.size).toBe(0);
    expect(gh.blobReads).toEqual([]);
  });

  it("leaves a failed per-file read absent and never throws", async () => {
    const gh = withBlobs(new Map(), () => new Error("Bad credentials"));
    const texts = await readBlobTextsExact(gh.octokit, REF, [bigWant], {
      maxBytes: 8 * 1024 * 1024,
    });
    expect(texts.size).toBe(0);
  });
});

describe("repoFileFromExactText", () => {
  it("is the RepoFile the contents API would have given for the same bytes", () => {
    const text = "﻿const é = 'ü';\r\n";
    const raw = Buffer.from(text, "utf8");
    const file = repoFileFromExactText(gitBlobSha(text), text);
    expect(file).toEqual({
      sha: gitBlobSha(text),
      content: text,
      base64: raw.toString("base64"),
      binary: false,
      bytes: raw.length,
    });
    // `binary` is false by the same round-trip test `getFileContent` applies.
    expect(Buffer.from(Buffer.from(file.base64, "base64").toString("utf8"), "utf8")).toEqual(raw);
  });
});
