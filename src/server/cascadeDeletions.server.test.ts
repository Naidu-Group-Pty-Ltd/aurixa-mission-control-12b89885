/**
 * The probe respects the tick and remembers its answers.
 *
 * Measured 16 Sep 2026: the September retirement's approved sweep is 442
 * clone-only paths, ~3 GitHub calls each — no 45-second drain tick survives
 * probing them all, and the pass that was cut mid-probe used to come back
 * knowing nothing. These tests pin the three properties that end that:
 * probing pauses ON the budget instead of blowing through it, answers a
 * previous pass settled cost nothing, and a rate limit is thrown to the
 * deferral machinery rather than laundered into `unsettled` evidence.
 */
import { describe, expect, it, vi } from "vitest";
import { PROBE_CHUNK, probeDeletions, probePrimeDeletion } from "./cascadeDeletions.server";
import type { SettledDeletionEvidence } from "./cascade/deletionPropagation.pure";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const PRIME = { owner: "o", repo: "prime", branch: "main" };

/**
 * A prime whose history deleted every path: `listCommits` answers two
 * commits (the removal, then the last version), and `getContent` 404s at the
 * removal and matches the clone's blob at the version.
 */
function fakeOctokit(overrides?: {
  listCommits?: (args: { path?: string }) => Promise<{ data: Array<{ sha: string }> }>;
  getContent?: (args: { ref?: string; path?: string }) => Promise<{ data: unknown }>;
}) {
  const calls = { listCommits: 0, getContent: 0 };
  const listCommits =
    overrides?.listCommits ??
    (async () => ({ data: [{ sha: sha(0xdead) }, { sha: sha(0xbeef) }] }));
  const getContent =
    overrides?.getContent ??
    (async (args: { ref?: string; path?: string }) => {
      if (args.ref === sha(0xdead)) {
        const e = new Error("Not Found") as Error & { status: number };
        e.status = 404;
        throw e;
      }
      return { data: { sha: cloneShaOf(args.path ?? "") } };
    });
  return {
    calls,
    octokit: {
      repos: {
        listCommits: async (args: { path?: string }) => {
          calls.listCommits += 1;
          return listCommits(args);
        },
        getContent: async (args: { ref?: string; path?: string }) => {
          calls.getContent += 1;
          return getContent(args);
        },
      },
    } as never,
  };
}

/** Deterministic clone blob per path, so the walk's early exit matches. */
function cloneShaOf(path: string): string {
  let h = 0;
  for (const c of path) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return sha(h + 1);
}

function candidatesOf(n: number): Array<{ path: string; cloneSha: string }> {
  return Array.from({ length: n }, (_, i) => {
    const path = `src/gone-${i}.ts`;
    return { path, cloneSha: cloneShaOf(path) };
  });
}

const rateLimitError = () => {
  const e = new Error("API rate limit exceeded for installation ID 157200201.") as Error & {
    status: number;
  };
  e.status = 403;
  return e;
};

describe("probeDeletions on the budget", () => {
  it("pauses cleanly between chunks when the budget says stop", async () => {
    const { octokit } = fakeOctokit();
    const chunks: number[] = [];
    let stop = false;
    const res = await probeDeletions({
      octokit,
      primeRef: PRIME,
      candidates: candidatesOf(PROBE_CHUNK * 3),
      primeDirectories: new Set(),
      maxProbes: PROBE_CHUNK * 3,
      shouldStop: () => stop,
      onChunk: (settled) => {
        chunks.push(settled.length);
        stop = true; // the budget runs out after the first chunk lands
      },
    });
    expect(res.paused).toBe(true);
    expect(chunks).toEqual([PROBE_CHUNK]);
    expect(res.candidates).toHaveLength(PROBE_CHUNK);
    expect(res.unprobed).toBe(PROBE_CHUNK * 2);
  });

  it("always probes the first chunk — a pass that asked nothing would never converge", async () => {
    const { octokit } = fakeOctokit();
    const res = await probeDeletions({
      octokit,
      primeRef: PRIME,
      candidates: candidatesOf(PROBE_CHUNK + 3),
      primeDirectories: new Set(),
      maxProbes: PROBE_CHUNK + 3,
      shouldStop: () => true,
    });
    expect(res.paused).toBe(true);
    expect(res.candidates).toHaveLength(PROBE_CHUNK);
  });

  it("spends nothing on answers a previous pass settled, and they do not count against the cap", async () => {
    const { octokit, calls } = fakeOctokit();
    const all = candidatesOf(6);
    const known = new Map<string, SettledDeletionEvidence>(
      all.slice(0, 4).map((c) => [
        c.path,
        {
          kind: "removed",
          deletedIn: sha(0xdead),
          versions: [c.cloneSha],
          versionsExhaustive: true,
        } as const,
      ]),
    );
    const res = await probeDeletions({
      octokit,
      primeRef: PRIME,
      candidates: all,
      primeDirectories: new Set(),
      // Room for exactly the two uncached questions: the four cached
      // answers must not have consumed it.
      maxProbes: 2,
      known,
    });
    expect(res.paused).toBe(false);
    expect(res.unprobed).toBe(0);
    expect(res.candidates).toHaveLength(6);
    expect(calls.listCommits).toBe(2);
    // Every cached answer came back verbatim.
    for (const c of all.slice(0, 4)) {
      const got = res.candidates.find((x) => x.path === c.path);
      expect(got?.evidence).toEqual(known.get(c.path));
    }
  });

  it("hands each chunk's answers out as it lands, with its timing", async () => {
    const { octokit } = fakeOctokit();
    const onChunk = vi.fn();
    await probeDeletions({
      octokit,
      primeRef: PRIME,
      candidates: candidatesOf(PROBE_CHUNK + 2),
      primeDirectories: new Set(),
      maxProbes: PROBE_CHUNK + 2,
      onChunk,
    });
    expect(onChunk).toHaveBeenCalledTimes(2);
    const [settled, chunkMs] = onChunk.mock.calls[0] as [unknown[], number];
    expect(settled).toHaveLength(PROBE_CHUNK);
    expect(typeof chunkMs).toBe("number");
  });
});

describe("a rate limit is a window, never evidence", () => {
  it("rethrows a rate-limited listCommits instead of settling `unsettled`", async () => {
    const { octokit } = fakeOctokit({
      listCommits: async () => {
        throw rateLimitError();
      },
    });
    await expect(
      probePrimeDeletion(octokit, PRIME, "src/gone-0.ts", cloneShaOf("src/gone-0.ts")),
    ).rejects.toThrow(/rate limit/i);
  });

  it("rethrows a rate-limited getContent — a limited read is not 'prime held no blob here'", async () => {
    const { octokit } = fakeOctokit({
      getContent: async () => {
        throw rateLimitError();
      },
    });
    await expect(
      probePrimeDeletion(octokit, PRIME, "src/gone-0.ts", cloneShaOf("src/gone-0.ts")),
    ).rejects.toThrow(/rate limit/i);
  });

  it("a rate limit mid-run escapes probeDeletions whole, after the settled chunks were handed out", async () => {
    let asked = 0;
    const { octokit } = fakeOctokit({
      listCommits: async () => {
        asked += 1;
        if (asked > PROBE_CHUNK) throw rateLimitError();
        return { data: [{ sha: sha(0xdead) }, { sha: sha(0xbeef) }] };
      },
    });
    const onChunk = vi.fn();
    await expect(
      probeDeletions({
        octokit,
        primeRef: PRIME,
        candidates: candidatesOf(PROBE_CHUNK * 2),
        primeDirectories: new Set(),
        maxProbes: PROBE_CHUNK * 2,
        onChunk,
      }),
    ).rejects.toThrow(/rate limit/i);
    // The first chunk's answers reached the ledger before the throw.
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it("an ordinary failure still settles as `unsettled` — only the window defers", async () => {
    const { octokit } = fakeOctokit({
      listCommits: async () => {
        const e = new Error("Internal Server Error") as Error & { status: number };
        e.status = 500;
        throw e;
      },
    });
    const evidence = await probePrimeDeletion(
      octokit,
      PRIME,
      "src/gone-0.ts",
      cloneShaOf("src/gone-0.ts"),
    );
    expect(evidence).toEqual({ kind: "unsettled", why: "HTTP 500" });
  });
});
