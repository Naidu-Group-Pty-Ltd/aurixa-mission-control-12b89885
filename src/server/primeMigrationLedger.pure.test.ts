/**
 * The prime's SQL position, and the four ways of getting it wrong.
 *
 * Each block below is named for the mistake it forbids rather than for the
 * function it calls, because every one of them is a mistake this codebase has
 * already made somewhere else: a frontier taken from the newest FILE, an empty
 * read rendered as a clean bill, a failed half producing a number about the
 * other, and a hypothesis subtracted from a count as though it were a
 * clearance.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assessPrimeMigrationLedger,
  frontierIsEstablished,
  WITHHELD_ROWS,
  type LedgerHalf,
} from "./primeMigrationLedger.pure";
import type { CorpusMeta } from "./fleetCorpusScope.pure";

const file = (id: string, slug = "thing"): CorpusMeta => ({ id, name: `${id}_${slug}.sql` });

const corpus = (...ids: string[]): LedgerHalf<CorpusMeta> => ({
  read: true,
  entries: ids.map((id) => file(id)),
});

const ledger = (...versions: string[]): LedgerHalf<string> => ({ read: true, entries: versions });

const A = "20260901010000";
const B = "20260902010000";
const C = "20260903010000";
const D = "20260904010000";

describe("a read that failed is not a repository with nothing in it", () => {
  it("an unread corpus says so and produces no counts", () => {
    const out = assessPrimeMigrationLedger({
      corpus: { read: false, why: "the installation has no token" },
      ledger: ledger(A),
    });
    expect(out.reading.standing).toBe("unreadable");
    expect(out.reading.headline).toContain("the installation has no token");
    expect(out.reading.corpusCount).toBeNull();
    expect(out.reading.ledgerCount).toBeNull();
    expect(out.reading.withheldCount).toBeNull();
    expect(out.runnableVersions).toBeNull();
  });

  it("an unread ledger says so, and does not report the corpus as aligned", () => {
    const out = assessPrimeMigrationLedger({
      corpus: corpus(A, B),
      ledger: { read: false, why: "the management token was refused" },
    });
    expect(out.reading.standing).toBe("unreadable");
    expect(out.reading.headline).toContain("the management token was refused");
    // The corpus WAS read. Reporting its count here would be a number about a
    // comparison nobody made.
    expect(out.reading.corpusCount).toBeNull();
    expect(out.runnableVersions).toBeNull();
  });

  it("an unreadable half names no remedy", () => {
    const out = assessPrimeMigrationLedger({
      corpus: { read: false, why: "no prime repository is configured" },
      ledger: { read: false, why: "no prime backend is configured" },
    });
    expect(out.reading.remedy).toBeNull();
    expect(out.reading.tone).toBe("idle");
  });

  it("the corpus failure is reported first when both halves failed", () => {
    // Not arbitrary: without a corpus there is nothing to compare at all, so
    // naming the ledger would send an operator to fix the second problem.
    const out = assessPrimeMigrationLedger({
      corpus: { read: false, why: "CORPUS REASON" },
      ledger: { read: false, why: "LEDGER REASON" },
    });
    expect(out.reading.headline).toContain("CORPUS REASON");
    expect(out.reading.headline).not.toContain("LEDGER REASON");
  });
});

describe("an empty ledger is unreadable, never aligned", () => {
  it("refuses to call a prime with no recorded migrations healthy", () => {
    const out = assessPrimeMigrationLedger({ corpus: corpus(A, B), ledger: ledger() });
    expect(out.reading.standing).toBe("unreadable");
    expect(out.reading.standing).not.toBe("aligned");
    expect(out.runnableVersions).toBeNull();
  });

  it("says why, in the terms the fleet lane refuses on", () => {
    const out = assessPrimeMigrationLedger({ corpus: corpus(A), ledger: ledger() });
    expect(out.reading.headline).toMatch(/no authority/i);
  });
});

describe("the frontier is the newest RUNNABLE version, not the newest file", () => {
  it("stops at the last version the prime has actually run", () => {
    // The repo holds four; the prime has run the first two. A frontier taken
    // from the corpus would answer D — a position past the end of what
    // happened, which is the fault `migrationFrontier.pure.ts` exists for.
    const out = assessPrimeMigrationLedger({
      corpus: corpus(A, B, C, D),
      ledger: ledger(A, B),
    });
    expect(out.reading.frontier).toBe(B);
    expect(out.reading.frontier).not.toBe(D);
  });

  it("is null where the prime has run nothing the repo still carries", () => {
    const out = assessPrimeMigrationLedger({
      corpus: corpus(C, D),
      // A non-empty ledger, but nothing in it matches a file here.
      ledger: ledger("20260101010000"),
    });
    expect(out.reading.frontier).toBeNull();
    expect(frontierIsEstablished(out.reading)).toBe(false);
  });

  it("frontierIsEstablished is false for every unreadable reading", () => {
    for (const half of [
      assessPrimeMigrationLedger({ corpus: { read: false, why: "x" }, ledger: ledger(A) }),
      assessPrimeMigrationLedger({ corpus: corpus(A), ledger: { read: false, why: "y" } }),
      assessPrimeMigrationLedger({ corpus: corpus(A), ledger: ledger() }),
    ]) {
      expect(frontierIsEstablished(half.reading)).toBe(false);
    }
  });
});

describe("what is held back, and how much of it might be bookkeeping", () => {
  it("counts the held-back set exactly and names the act that clears it", () => {
    const out = assessPrimeMigrationLedger({ corpus: corpus(A, B, C, D), ledger: ledger(A, B) });
    expect(out.reading.standing).toBe("holding");
    expect(out.reading.withheldCount).toBe(2);
    expect(out.reading.runnableCount).toBe(2);
    expect(out.reading.corpusCount).toBe(4);
    expect(out.reading.remedy).toMatch(/dispatch/i);
    expect(out.reading.tone).toBe("warn");
  });

  it("lists the held-back set newest first", () => {
    const out = assessPrimeMigrationLedger({ corpus: corpus(A, B, C, D), ledger: ledger(A) });
    expect(out.reading.withheld.map((w) => w.id)).toEqual([D, C, B]);
  });

  it("caps the list and never the count", () => {
    const ids = Array.from({ length: WITHHELD_ROWS + 9 }, (_, i) =>
      String(20260900000000 + i * 10000),
    );
    const out = assessPrimeMigrationLedger({ corpus: corpus(A, ...ids), ledger: ledger(A) });
    expect(out.reading.withheld).toHaveLength(WITHHELD_ROWS);
    expect(out.reading.withheldCount).toBe(ids.length);
  });

  it("a skew suspicion is reported beside the count and never subtracted from it", () => {
    // Three seconds apart — the shape this prime's ledger actually produces.
    const repoVersion = "20260905091525";
    const ledgerVersion = "20260905091522";
    const out = assessPrimeMigrationLedger({
      corpus: corpus(A, repoVersion),
      ledger: ledger(A, ledgerVersion),
    });
    expect(out.reading.withheldCount).toBe(1);
    expect(out.reading.skewSuspected).toBe(1);
    expect(out.reading.neverApplied).toBe(0);
    const row = out.reading.withheld[0];
    expect(row.reason).toBe("skew_suspected");
    expect(row.nearestPrimeVersion).toBe(ledgerVersion);
    expect(row.skewSeconds).toBe(-3);
    // The headline states what is WITHHELD. A suspicion does not reduce it.
    expect(out.reading.headline).toContain("1 migration");
  });

  it("a file the prime has plainly never run carries no nearest version", () => {
    const out = assessPrimeMigrationLedger({ corpus: corpus(A, D), ledger: ledger(A) });
    const row = out.reading.withheld[0];
    expect(row.reason).toBe("never_applied");
    expect(row.nearestPrimeVersion).toBeNull();
    expect(row.skewSeconds).toBeNull();
  });
});

describe("aligned means nothing in the repository is holding a clone back", () => {
  it("reports every file as deliverable", () => {
    const out = assessPrimeMigrationLedger({ corpus: corpus(A, B), ledger: ledger(A, B) });
    expect(out.reading.standing).toBe("aligned");
    expect(out.reading.tone).toBe("ok");
    expect(out.reading.withheld).toEqual([]);
    expect(out.reading.withheldCount).toBe(0);
    expect(out.reading.remedy).toBeNull();
    expect(out.runnableVersions).toEqual([A, B]);
    expect(frontierIsEstablished(out.reading)).toBe(true);
  });

  it("the runnable list is ascending, which is what the comparison counts against", () => {
    const out = assessPrimeMigrationLedger({ corpus: corpus(A, B, C), ledger: ledger(C, A, B) });
    expect(out.runnableVersions).toEqual([A, B, C]);
  });
});

describe("a ledger row matching no file here is counted, never listed", () => {
  it("counts the rows the repository cannot account for", () => {
    const out = assessPrimeMigrationLedger({
      corpus: corpus(A, B),
      // Two of these are the Lovable apply-timestamp shape: recorded, but
      // matching no filename in the tree.
      ledger: ledger(A, B, "20250912050519", "20251029030453"),
    });
    expect(out.reading.unmatchedLedgerRows).toBe(2);
    expect(out.reading.ledgerCount).toBe(4);
    // They are not withheld migrations — they are not migrations here at all.
    expect(out.reading.withheldCount).toBe(0);
  });
});

describe("the page never re-derives this judgement", () => {
  /*
    The import boundary itself is asserted ONCE, in `primeHealth.pure.test.ts`,
    as a property over every `@/server` import the route makes. A second copy
    here would be the same rule in two places — which is how they come to
    disagree, and the disagreement would be silent because both would pass.
  */
  const page = readFileSync(join(__dirname, "..", "routes", "prime.tsx"), "utf8");

  it("does not decide which side of the copy a blockage lives on", () => {
    /*
      The split is the whole point of the comparison, and it is derived from
      `BLOCKAGE_POLICY` on the server. A page that tested for a class name
      would be a second copy of that rule living in JSX, where no test reaches
      it — and it would go on answering after the taxonomy gained a class.

      Planted back (`b.cls === "prime_ledger_hole"` in the filter) this test
      fails, which is what makes it worth having.
    */
    expect(page).not.toMatch(/"prime_author"|'prime_author'/);
    expect(page).not.toMatch(/"prime_ledger_hole"|'prime_ledger_hole'/);
    expect(page).toMatch(/b\.side === "prime"/);
  });
});
