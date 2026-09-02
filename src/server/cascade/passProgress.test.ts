import { describe, expect, it } from "vitest";
import { mapWithConcurrencyUntil } from "@/lib/concurrency";
import {
  PROGRESS_FLUSH_EVERY,
  describePreparePause,
  readProgress,
  resumableBlobs,
  type CascadeProgress,
} from "./passProgress.pure";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const SOURCE = sha(0xabc);

const record: CascadeProgress = {
  version: 1,
  source_sha: SOURCE,
  prepared: {
    "src/a.ts": { blob: sha(1), prime: sha(11) },
    "src/b.ts": { blob: sha(2), prime: sha(12) },
  },
  total: 353,
};

describe("readProgress", () => {
  it("reads a record made for this commit", () => {
    expect(readProgress(record, SOURCE)).toEqual(record);
  });

  it("ignores a record made for another commit", () => {
    expect(readProgress(record, sha(0xdef))).toBeNull();
  });

  it("refuses anything malformed rather than guessing", () => {
    expect(readProgress(null, SOURCE)).toBeNull();
    expect(readProgress("x", SOURCE)).toBeNull();
    expect(readProgress({ ...record, version: 2 }, SOURCE)).toBeNull();
    expect(readProgress({ ...record, prepared: [] }, SOURCE)).toBeNull();
    expect(
      readProgress(
        { ...record, prepared: { "src/a.ts": { blob: "not-a-sha", prime: sha(1) } } },
        SOURCE,
      ),
    ).toBeNull();
    expect(
      readProgress({ ...record, prepared: { "src/a.ts": { blob: sha(1) } } }, SOURCE),
    ).toBeNull();
  });

  it("tolerates a missing total", () => {
    const { total: _t, ...noTotal } = record;
    expect(readProgress(noTotal, SOURCE)?.total).toBe(0);
  });
});

describe("resumableBlobs", () => {
  it("reuses only entries whose prime blob is still the one prime holds", () => {
    const primeTree = new Map([
      ["src/a.ts", sha(11)], // unchanged upstream — reuse
      ["src/b.ts", sha(99)], // changed upstream — read again
    ]);
    const out = resumableBlobs(record, primeTree);
    expect([...out.entries()]).toEqual([["src/a.ts", sha(1)]]);
  });

  it("reuses nothing without a prime listing to check against", () => {
    expect(resumableBlobs(record, null).size).toBe(0);
    expect(resumableBlobs(null, new Map()).size).toBe(0);
  });
});

describe("mapWithConcurrencyUntil", () => {
  it("finishes what it started, touches nothing past the stop, and keeps order", async () => {
    const started: number[] = [];
    let stop = false;
    const { results, processed, stopped } = await mapWithConcurrencyUntil(
      [1, 2, 3, 4, 5, 6, 7, 8],
      3,
      async (n) => {
        started.push(n);
        if (n === 4) stop = true;
        await new Promise((r) => setTimeout(r, n % 2 === 0 ? 5 : 1));
        return n * 10;
      },
      () => stop,
    );
    expect(stopped).toBe(true);
    // Every started item is in the results, in input order, and nothing else.
    expect(results).toEqual(
      started
        .slice()
        .sort((a, b) => a - b)
        .map((n) => n * 10),
    );
    expect(processed).toBe(started.length);
    expect(started).not.toContain(8);
  });

  it("runs to the end when never told to stop", async () => {
    const { results, processed, stopped } = await mapWithConcurrencyUntil(
      [1, 2, 3],
      2,
      async (n) => n + 1,
      () => false,
    );
    expect({ results, processed, stopped }).toEqual({
      results: [2, 3, 4],
      processed: 3,
      stopped: false,
    });
  });

  it("starts the first item even when told to stop at once? no — it starts nothing", async () => {
    /* The caller decides whether a first item is owed; `attempted > 0` in the
       engine's budget question is what guarantees progress, not this helper. */
    const { results, processed, stopped } = await mapWithConcurrencyUntil(
      [1, 2],
      2,
      async (n) => n,
      () => true,
    );
    expect({ results, processed, stopped }).toEqual({ results: [], processed: 0, stopped: true });
  });
});

describe("the sentence", () => {
  it("says how far the pass got", () => {
    expect(describePreparePause({ prepared: 200, total: 353 })).toBe(
      "Paused at the invocation budget — 200 of 353 file(s) prepared; the rest resume next tick",
    );
    expect(PROGRESS_FLUSH_EVERY).toBeGreaterThan(0);
  });
});
