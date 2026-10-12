import { describe, expect, it } from "vitest";
import { mapWithConcurrencyUntil } from "@/lib/concurrency";
import {
  PROGRESS_FLUSH_EVERY,
  describePreparePause,
  describeProbePause,
  describeVariantMergePause,
  ledgerGrew,
  readProgress,
  resumableBlobs,
  resumableDeletionEvidence,
  resumableHeldEvidence,
  resumableVariantEvidence,
  variantRetryPaths,
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
  held_evidence: {
    "src/App.tsx": {
      clone: sha(61),
      evidence: { kind: "prime_versions", versions: [sha(62), sha(63)], versionsExhaustive: false },
    },
  },
  variant_evidence: {
    "supabase/functions/x/index.ts": {
      clone: sha(81),
      prime: sha(82),
      verdict: { act: "write", base: sha(83), fromPrime: 3, fromClone: 2, blob: sha(84) },
    },
    "src/lib/crm.ts": {
      clone: sha(85),
      prime: sha(86),
      verdict: { act: "current", base: sha(87) },
    },
    "src/App.tsx": {
      clone: sha(61),
      prime: sha(88),
      verdict: { act: "hold", why: "the line edited both sides" },
    },
    "src/flaky.ts": {
      clone: sha(89),
      prime: sha(90),
      verdict: { act: "hold", why: "HTTP 502 reading the base", transient: true },
    },
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
    /* Every ledger written before the evidence fields existed. */
    const { deletion_evidence: _e, held_evidence: _h, variant_evidence: _v, ...legacy } = record;
    expect(readProgress(legacy)).toEqual({
      ...legacy,
      deletion_evidence: {},
      held_evidence: {},
      variant_evidence: {},
    });
  });

  it("caches and revalidates held evidence by the same rule as deletions", () => {
    /* Measured 16 Sep 2026: re-walking the same held paths every pass was
       ~90 calls and ~30 seconds of fixed cost, and a genuinely divergent
       hold (npc-client's App.tsx) never converges — it re-paid for ever. */
    const cloneTree = new Map([["src/App.tsx", sha(61)]]);
    expect([...resumableHeldEvidence(record, cloneTree).keys()]).toEqual(["src/App.tsx"]);
    // The clone edited the file → a changed question → nothing reused.
    expect(resumableHeldEvidence(record, new Map([["src/App.tsx", sha(99)]])).size).toBe(0);
    expect(resumableHeldEvidence(record, null).size).toBe(0);
    // `unsettled` never parses back in.
    const dirty = {
      ...record,
      held_evidence: {
        "src/x.ts": { clone: sha(70), evidence: { kind: "unsettled", why: "HTTP 500" } },
      },
    };
    expect(readProgress(dirty)?.held_evidence).toEqual({});
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

describe("variant merge verdicts", () => {
  /* Measured 11–12 Oct 2026 on the CRM line: four consecutive events spent
     their whole window re-merging the same ~30 held variants (≈130 requests
     each pass), recorded nothing, and were retired after three attempts. A
     verdict is now remembered, keyed to the two blobs it was computed from. */
  const VARIANT = "supabase/functions/x/index.ts";
  const trees = () => ({
    clone: new Map([
      [VARIANT, sha(81)],
      ["src/lib/crm.ts", sha(85)],
      ["src/App.tsx", sha(61)],
      ["src/flaky.ts", sha(89)],
    ]),
    prime: new Map([
      [VARIANT, sha(82)],
      ["src/lib/crm.ts", sha(86)],
      ["src/App.tsx", sha(88)],
      ["src/flaky.ts", sha(90)],
    ]),
  });

  it("reuses a settled verdict only while BOTH blobs it read are unchanged", () => {
    const { clone, prime } = trees();
    expect([...resumableVariantEvidence(record, clone, prime).keys()].sort()).toEqual(
      ["src/App.tsx", "src/lib/crm.ts", VARIANT].sort(),
    );
    // The clone moved the file — the base is read off the clone's history, so
    // a new question.
    const cloneMoved = new Map(clone).set(VARIANT, sha(99));
    expect(resumableVariantEvidence(record, cloneMoved, prime).has(VARIANT)).toBe(false);
    // Prime moved it — theirs changed, so a new question.
    const primeMoved = new Map(prime).set(VARIANT, sha(99));
    expect(resumableVariantEvidence(record, clone, primeMoved).has(VARIANT)).toBe(false);
  });

  it("never reuses a transient hold as an answer — only as 'already asked'", () => {
    const { clone, prime } = trees();
    expect(resumableVariantEvidence(record, clone, prime).has("src/flaky.ts")).toBe(false);
    expect([...variantRetryPaths(record, clone, prime).keys()]).toEqual(["src/flaky.ts"]);
    // At different blobs it is never-asked again, not asked-last.
    const moved = new Map(clone).set("src/flaky.ts", sha(99));
    expect(variantRetryPaths(record, moved, prime).size).toBe(0);
  });

  it("reuses nothing without both listings to check against", () => {
    const { clone, prime } = trees();
    expect(resumableVariantEvidence(record, null, prime).size).toBe(0);
    expect(resumableVariantEvidence(record, clone, null).size).toBe(0);
    expect(resumableVariantEvidence(null, clone, prime).size).toBe(0);
    expect(variantRetryPaths(record, null, prime).size).toBe(0);
  });

  it("drops a malformed verdict alone — one re-merge, never bytes nobody merged", () => {
    const dirty = {
      ...record,
      variant_evidence: {
        ...record.variant_evidence,
        "src/no-blob.ts": {
          clone: sha(1),
          prime: sha(2),
          verdict: { act: "write", base: sha(3), fromPrime: 1, fromClone: 1 },
        },
        "src/bad-count.ts": {
          clone: sha(1),
          prime: sha(2),
          verdict: { act: "write", base: sha(3), fromPrime: -1, fromClone: 1, blob: sha(4) },
        },
        "src/bad-act.ts": { clone: sha(1), prime: sha(2), verdict: { act: "merge" } },
        "src/bad-prime.ts": {
          clone: sha(1),
          prime: "x",
          verdict: { act: "current", base: sha(3) },
        },
        "src/no-why.ts": { clone: sha(1), prime: sha(2), verdict: { act: "hold" } },
      },
    };
    expect(readProgress(dirty)).toEqual(record);
  });

  it("says how far the merge phase got", () => {
    expect(describeVariantMergePause({ settled: 12, total: 30 })).toBe(
      "Paused at the invocation budget — line variant merges asked for 12 of 30 held path(s); the rest resume next tick",
    );
  });
});

describe("ledgerGrew", () => {
  /* A paused pass is judged by whether it moved its ledger. The old measure
     was a COUNT of prepared + deletion evidence, which stood still while a
     pass recorded dozens of variant verdicts and held probes — so the pass
     spent an attempt and the event was retired with its work thrown away. */
  const parsed = () => readProgress(record) as CascadeProgress;

  it("is false for no ledger at all, and for a ledger that says exactly what it said", () => {
    expect(ledgerGrew(parsed(), null)).toBe(false);
    expect(ledgerGrew(null, null)).toBe(false);
    expect(ledgerGrew(parsed(), parsed())).toBe(false);
  });

  it("is true for a first ledger with anything in it", () => {
    expect(ledgerGrew(null, parsed())).toBe(true);
  });

  it("sees a new answer in EVERY section, not only the two the count read", () => {
    const base = parsed();
    const grow = (patch: Partial<CascadeProgress>) => ledgerGrew(base, { ...base, ...patch });
    expect(
      grow({ prepared: { ...base.prepared, "src/c.ts": { blob: sha(3), prime: sha(13) } } }),
    ).toBe(true);
    expect(
      grow({
        deletion_evidence: {
          ...base.deletion_evidence,
          "src/new.ts": { clone: sha(5), evidence: { kind: "never_primes" } },
        },
      }),
    ).toBe(true);
    expect(
      grow({
        held_evidence: {
          ...base.held_evidence,
          "src/held.ts": {
            clone: sha(6),
            evidence: { kind: "prime_versions", versions: [sha(7)], versionsExhaustive: true },
          },
        },
      }),
    ).toBe(true);
    expect(
      grow({
        variant_evidence: {
          ...base.variant_evidence,
          "src/new-variant.ts": {
            clone: sha(8),
            prime: sha(9),
            verdict: { act: "current", base: sha(10) },
          },
        },
      }),
    ).toBe(true);
  });

  it("sees a changed answer at the same path", () => {
    const base = parsed();
    const changed: CascadeProgress = {
      ...base,
      variant_evidence: {
        ...base.variant_evidence,
        "src/flaky.ts": {
          clone: sha(89),
          prime: sha(90),
          verdict: { act: "current", base: sha(91) },
        },
      },
    };
    expect(ledgerGrew(base, changed)).toBe(true);
  });

  it("does NOT refund a pass that only re-asked a transient path — its prose is not compared", () => {
    const base = parsed();
    const reworded: CascadeProgress = {
      ...base,
      variant_evidence: {
        ...base.variant_evidence,
        "src/flaky.ts": {
          clone: sha(89),
          prime: sha(90),
          verdict: { act: "hold", why: "HTTP 503 reading the base", transient: true },
        },
      },
    };
    expect(ledgerGrew(base, reworded)).toBe(false);
  });

  it("does not count a size change with no new identity — a re-prepared spec re-enters unchanged", () => {
    const base = parsed();
    const { "src/b.ts": _b, ...fewer } = base.prepared;
    expect(ledgerGrew(base, { ...base, prepared: fewer })).toBe(false);
  });
});
