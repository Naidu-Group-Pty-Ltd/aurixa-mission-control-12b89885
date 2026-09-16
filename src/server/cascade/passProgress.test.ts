import { describe, expect, it } from "vitest";
import { mapWithConcurrencyUntil } from "@/lib/concurrency";
import {
  PROGRESS_FLUSH_EVERY,
  describePreparePause,
  describeProbePause,
  readProgress,
  resumableBlobs,
  resumableDeletionEvidence,
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
  deletion_evidence: {
    "src/gone.ts": {
      clone: sha(21),
      evidence: {
        kind: "removed",
        deletedIn: sha(31),
        versions: [sha(21), sha(22)],
        versionsExhaustive: true,
      },
    },
    "src/own.ts": { clone: sha(23), evidence: { kind: "never_primes" } },
  },
  total: 353,
};

describe("readProgress", () => {
  it("reads a well-formed record", () => {
    expect(readProgress(record)).toEqual(record);
  });

  it("reads a record made for ANOTHER commit — the commit pin was a proxy the per-entry check replaces", () => {
    /* Prime merged ~50 commits a day and each fresh pass reused nothing under
       the pin, so three clones re-prepared ~300 nearly identical blobs per
       commit and the App's hourly budget went to work already done. What made
       an entry safe was never the commit — it is that prime's CURRENT tree
       still holds the blob it was made from, which `resumableBlobs` checks
       entry by entry. */
    const other: CascadeProgress = { ...record, source_sha: sha(0xdef) };
    expect(readProgress(other)).toEqual(other);
  });

  it("refuses anything malformed rather than guessing", () => {
    expect(readProgress(null)).toBeNull();
    expect(readProgress("x")).toBeNull();
    expect(readProgress({ ...record, version: 2 })).toBeNull();
    expect(readProgress({ ...record, source_sha: "not-a-sha" })).toBeNull();
    expect(readProgress({ ...record, prepared: [] })).toBeNull();
    expect(
      readProgress({ ...record, prepared: { "src/a.ts": { blob: "not-a-sha", prime: sha(1) } } }),
    ).toBeNull();
    expect(readProgress({ ...record, prepared: { "src/a.ts": { blob: sha(1) } } })).toBeNull();
  });

  it("tolerates a missing total", () => {
    const { total: _t, ...noTotal } = record;
    expect(readProgress(noTotal)?.total).toBe(0);
  });

  it("reads an OLD record with no evidence at all", () => {
    /* Every ledger written before the evidence field existed. */
    const { deletion_evidence: _e, ...legacy } = record;
    expect(readProgress(legacy)).toEqual({ ...legacy, deletion_evidence: {} });
  });

  it("drops a malformed evidence entry alone, keeping the blobs and the rest", () => {
    /* The safe direction differs by section: a wrong BLOB delivers wrong
       bytes, so a malformed blob entry voids the record; a wrong EVIDENCE
       entry deletes the wrong file, so it is dropped alone and re-probed —
       hundreds of sound prepared blobs must not be discarded over one
       unreadable answer. */
    const dirty = {
      ...record,
      deletion_evidence: {
        ...record.deletion_evidence,
        "src/bad-clone.ts": { clone: "not-a-sha", evidence: { kind: "never_primes" } },
        "src/bad-kind.ts": { clone: sha(40), evidence: { kind: "unsettled", why: "HTTP 500" } },
        "src/bad-versions.ts": {
          clone: sha(41),
          evidence: {
            kind: "removed",
            deletedIn: sha(42),
            versions: ["x"],
            versionsExhaustive: true,
          },
        },
        "src/bad-exhaustive.ts": {
          clone: sha(43),
          evidence: {
            kind: "removed",
            deletedIn: sha(44),
            versions: [],
            versionsExhaustive: "yes",
          },
        },
      },
    };
    expect(readProgress(dirty)).toEqual(record);
  });

  it("never reads `unsettled` back — a failed read is retried, not remembered", () => {
    const withUnsettled = {
      ...record,
      deletion_evidence: {
        "src/x.ts": { clone: sha(50), evidence: { kind: "unsettled", why: "HTTP 502" } },
      },
    };
    expect(readProgress(withUnsettled)?.deletion_evidence).toEqual({});
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

describe("resumableDeletionEvidence", () => {
  it("reuses only answers asked about the blob the clone still holds", () => {
    const cloneTree = new Map([
      ["src/gone.ts", sha(21)], // unchanged since the probe — reuse
      ["src/own.ts", sha(99)], // the clone edited it — a changed question
    ]);
    const out = resumableDeletionEvidence(record, cloneTree);
    expect([...out.keys()]).toEqual(["src/gone.ts"]);
    expect(out.get("src/gone.ts")?.kind).toBe("removed");
  });

  it("reuses nothing without a clone listing to check against", () => {
    expect(resumableDeletionEvidence(record, null).size).toBe(0);
    expect(resumableDeletionEvidence(null, new Map()).size).toBe(0);
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

  it("says how far the PROBE got, in candidates rather than files", () => {
    expect(describeProbePause({ settled: 180, total: 442 })).toBe(
      "Paused at the invocation budget — deletion evidence settled for 180 of 442 candidate(s); the rest resume next tick",
    );
  });
});
