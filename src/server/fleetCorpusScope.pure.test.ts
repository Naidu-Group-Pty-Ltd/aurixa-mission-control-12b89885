import { describe, it, expect } from "vitest";
import {
  scopeCorpusToPrime,
  assertPrimeLedgerUsable,
  migrationEpochSeconds,
  SKEW_WINDOW_SECONDS,
  partitionByDependency,
} from "./fleetCorpusScope.pure";

const meta = (id: string, name = `${id}_m.sql`) => ({ id, name });

describe("scopeCorpusToPrime", () => {
  it("offers a clone only what the prime has applied", () => {
    const corpus = [meta("20250101000000"), meta("20250102000000"), meta("20250103000000")];
    const { runnable, withheld } = scopeCorpusToPrime(
      corpus,
      new Set(["20250101000000", "20250103000000"]),
    );
    expect(runnable.map((m) => m.id)).toEqual(["20250101000000", "20250103000000"]);
    expect(withheld.map((w) => w.meta.id)).toEqual(["20250102000000"]);
  });

  it("preserves corpus order, because replay order is filename order", () => {
    const corpus = [meta("20250101000000"), meta("20250102000000"), meta("20250103000000")];
    const { runnable } = scopeCorpusToPrime(corpus, new Set(corpus.map((m) => m.id)));
    expect(runnable.map((m) => m.id)).toEqual([
      "20250101000000",
      "20250102000000",
      "20250103000000",
    ]);
  });

  it("withholds and never drops — every corpus entry lands in exactly one bucket", () => {
    const corpus = Array.from({ length: 50 }, (_, i) =>
      meta(`2025010100${String(i).padStart(4, "0")}`),
    );
    const applied = new Set(corpus.slice(0, 17).map((m) => m.id));
    const { runnable, withheld } = scopeCorpusToPrime(corpus, applied);
    expect(runnable.length + withheld.length).toBe(corpus.length);
    expect(new Set([...runnable.map((m) => m.id), ...withheld.map((w) => w.meta.id)]).size).toBe(
      corpus.length,
    );
  });

  it("an empty prime ledger withholds everything rather than passing everything", () => {
    // The direction of this failure is the whole point. Scoping that degraded
    // to "allow all" on an empty ledger would send a clone every file in the
    // tree — which is exactly the behaviour being removed.
    const corpus = [meta("20250101000000"), meta("20250102000000")];
    const { runnable, withheld } = scopeCorpusToPrime(corpus, new Set());
    expect(runnable).toEqual([]);
    expect(withheld).toHaveLength(2);
  });

  describe("the case that was measured in production", () => {
    // Named files, because this is the specific event the module exists for:
    // the sync applied two rollback_* scripts to a tenant database and put 23
    // permissive USING(true) policies on its client and financial tables.
    const ROLLBACKS = [
      meta("20250124120001", "20250124120001_rollback_client_data_rls_policies.sql"),
      meta("20250124130001", "20250124130001_rollback_financial_data_rls_policies.sql"),
    ];
    const FUTURE_DATED = meta("20260901000000", "20260901000000_aml_integration_completion.sql");
    const REAL = meta("20260820000000", "20260820000000_real_applied_migration.sql");

    // What the prime's ledger actually holds: the real one, none of the rest.
    const primeApplied = new Set([REAL.id]);

    it("withholds the rollback scripts the prime never ran", () => {
      const { runnable, withheld } = scopeCorpusToPrime(
        [...ROLLBACKS, REAL, FUTURE_DATED],
        primeApplied,
      );
      expect(runnable.map((m) => m.id)).toEqual([REAL.id]);
      expect(withheld.map((w) => w.meta.name)).toEqual([
        "20250124120001_rollback_client_data_rls_policies.sql",
        "20250124130001_rollback_financial_data_rls_policies.sql",
        "20260901000000_aml_integration_completion.sql",
      ]);
    });

    it("withholds future-dated work the prime has not taken", () => {
      const { runnable } = scopeCorpusToPrime([FUTURE_DATED], primeApplied);
      expect(runnable).toEqual([]);
    });
  });
});

describe("assertPrimeLedgerUsable", () => {
  it("permits a run when the prime reports applied migrations", () => {
    expect(
      assertPrimeLedgerUsable({
        failed: false,
        appliedCount: 864,
        primeRef: "dduzbchuswwbefdunfct",
      }),
    ).toBeNull();
  });

  it("refuses when the ledger read FAILED, and says a failed read is not an empty prime", () => {
    const refusal = assertPrimeLedgerUsable({
      failed: true,
      errorMessage: "503 from the Management API",
      appliedCount: 0,
      primeRef: "dduzbchuswwbefdunfct",
    });
    expect(refusal).toContain("503 from the Management API");
    expect(refusal).toMatch(/not a prime that has applied nothing/);
  });

  it("refuses an EMPTY ledger rather than treating the whole repo as runnable", () => {
    const refusal = assertPrimeLedgerUsable({
      failed: false,
      appliedCount: 0,
      primeRef: "dduzbchuswwbefdunfct",
    });
    expect(refusal).toMatch(/no applied migrations/);
    expect(refusal).toMatch(/rollback scripts/);
  });

  it("names the prime project in every refusal, so an operator knows what to look at", () => {
    for (const input of [
      { failed: true, appliedCount: 0, primeRef: "abcdefghijklmnopqrst" },
      { failed: false, appliedCount: 0, primeRef: "abcdefghijklmnopqrst" },
    ] as const) {
      expect(assertPrimeLedgerUsable(input)).toContain("abcdefghijklmnopqrst");
    }
  });

  it("a failed read is refused even when a count somehow came back non-zero", () => {
    // `failed` outranks the count: a partial result from a failed read is not
    // an authority, and trusting it would sync against a truncated ledger.
    expect(
      assertPrimeLedgerUsable({
        failed: true,
        errorMessage: "connection reset",
        appliedCount: 400,
        primeRef: "dduzbchuswwbefdunfct",
      }),
    ).toMatch(/Refusing to sync/);
  });
});

describe("migrationEpochSeconds", () => {
  it("parses a 14-digit version as UTC", () => {
    expect(migrationEpochSeconds("20250831091525")).toBe(Date.UTC(2025, 7, 31, 9, 15, 25) / 1000);
  });

  it("measures the real skew observed on this prime", () => {
    // 20250831091525 (repo) vs 20250831091523 (prime ledger)
    const repo = migrationEpochSeconds("20250831091525")!;
    const ledger = migrationEpochSeconds("20250831091523")!;
    expect(repo - ledger).toBe(2);
  });

  it("returns null rather than a guess for an id it cannot parse", () => {
    // Not zero: an unparsed id defaulting to the epoch would sit fourteen
    // hundred years from every ledger entry and read as never_applied — right
    // answer, wrong reason, and wrong the moment an id shape changes.
    for (const bad of ["", "2025", "not-a-version", "202508310915250", "20251331091525"]) {
      expect(migrationEpochSeconds(bad), bad).toBeNull();
    }
  });
});

describe("the withheld breakdown", () => {
  // The exact pairs measured on the prime: the repo filename and the version
  // Lovable actually stamped when it applied the file.
  const SKEWED = [
    { repo: "20250831091525", ledger: "20250831091523" },
    { repo: "20250902092314", ledger: "20250902092312" },
    { repo: "20251029030456", ledger: "20251029030453" },
  ];

  it("calls a near-miss skew_suspected and names the entry it is near", () => {
    const { withheld, breakdown } = scopeCorpusToPrime(
      SKEWED.map((p) => meta(p.repo)),
      new Set(SKEWED.map((p) => p.ledger)),
    );
    expect(breakdown).toEqual({ neverApplied: 0, skewSuspected: 3 });
    expect(withheld.map((w) => w.nearestPrimeVersion)).toEqual(SKEWED.map((p) => p.ledger));
    expect(withheld.map((w) => w.skewSeconds)).toEqual([-2, -2, -3]);
  });

  it("calls a migration with nothing near it never_applied", () => {
    // The nine January 2025 files: the prime's earliest ledger entry is
    // August 2025, so nothing is remotely near them.
    const { withheld, breakdown } = scopeCorpusToPrime(
      [meta("20250124120001"), meta("20250124130001")],
      new Set(["20250827053832", "20260820000000"]),
    );
    expect(breakdown).toEqual({ neverApplied: 2, skewSuspected: 0 });
    expect(withheld.every((w) => w.reason === "never_applied")).toBe(true);
    expect(withheld.every((w) => w.nearestPrimeVersion === undefined)).toBe(true);
  });

  /**
   * The assertion the whole design turns on. The classification is a report,
   * not a matching rule: a migration one second away from a ledger entry is
   * still withheld, because "obviously the same migration" is a guess about
   * somebody else's timestamping and a tenant's database is on the other side
   * of it.
   */
  it("NEVER promotes a skew_suspected migration to runnable", () => {
    const { runnable, withheld } = scopeCorpusToPrime(
      [meta("20250831091525")],
      new Set(["20250831091524"]), // one second away
    );
    expect(runnable).toEqual([]);
    expect(withheld).toHaveLength(1);
    expect(withheld[0].reason).toBe("skew_suspected");
    expect(withheld[0].skewSeconds).toBe(-1);
  });

  it("holds the window exactly — inside is suspected, outside is never_applied", () => {
    const base = "20250831091500";
    const at = scopeCorpusToPrime(
      [meta(base)],
      new Set(["20250831091510"]), // exactly SKEW_WINDOW_SECONDS away
    );
    expect(SKEW_WINDOW_SECONDS).toBe(10);
    expect(at.withheld[0].reason).toBe("skew_suspected");

    const past = scopeCorpusToPrime([meta(base)], new Set(["20250831091511"]));
    expect(past.withheld[0].reason).toBe("never_applied");
  });

  it("picks the nearest entry when the ledger has one on each side", () => {
    const { withheld } = scopeCorpusToPrime(
      [meta("20250831091510")],
      new Set(["20250831091505", "20250831091512"]),
    );
    expect(withheld[0].nearestPrimeVersion).toBe("20250831091512");
    expect(withheld[0].skewSeconds).toBe(2);
  });

  it("counts the breakdown to exactly the withheld total", () => {
    const corpus = [
      meta("20250831091525"), // skew
      meta("20250124120001"), // never
      meta("20260820000000"), // runnable
      meta("20260901000000"), // never (future-dated)
    ];
    const { runnable, withheld, breakdown } = scopeCorpusToPrime(
      corpus,
      new Set(["20250831091523", "20260820000000"]),
    );
    expect(runnable).toHaveLength(1);
    expect(breakdown.neverApplied + breakdown.skewSuspected).toBe(withheld.length);
    expect(breakdown).toEqual({ neverApplied: 2, skewSuspected: 1 });
  });

  it("does not crash on a ledger holding versions it cannot parse", () => {
    const { withheld, breakdown } = scopeCorpusToPrime(
      [meta("20250831091525")],
      new Set(["not-a-version", "20250831091523"]),
    );
    expect(breakdown.skewSuspected).toBe(1);
    expect(withheld[0].nearestPrimeVersion).toBe("20250831091523");
  });

  it("classifies an unparsable REPO id as never_applied rather than guessing", () => {
    const { withheld, breakdown } = scopeCorpusToPrime(
      [{ id: "weird-id", name: "weird-id_m.sql" }],
      new Set(["20250831091523"]),
    );
    expect(breakdown).toEqual({ neverApplied: 1, skewSuspected: 0 });
    expect(withheld[0].reason).toBe("never_applied");
  });
});

/**
 * The rule has to hold at every caller, and it had two callers with one
 * implementation: the scheduled fleet sync scoped, and the per-clone
 * "Sync migrations" button passed the raw repo corpus to
 * `applyPrimeMigrations`. One click replayed the repo's January-2025 tail at a
 * tenant backend and marked it `failed`, taking it out of the fleet sync and
 * blocking its deployment. These read the source because the defect was a
 * missing call, which no behavioural test of the pure function can see.
 */
describe("every replay path goes through the scoped corpus", () => {
  const read = async (f: string) => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  };

  it("the per-clone sync button scopes, and never passes the raw corpus", async () => {
    const src = await read("migration-sync.functions.ts");
    expect(src).toContain("openScopedPrimeCorpus");
    expect(src).not.toMatch(/applyPrimeMigrations\(\s*[^)]*corpus\.metas/s);
  });

  it("the pending count on the clone card is measured against the scoped set", async () => {
    const src = await read("migration-sync.functions.ts");
    const status = src.slice(
      src.indexOf("getCloneMigrationStatus"),
      src.indexOf("syncCloneMigrations"),
    );
    expect(status).toContain("openScopedPrimeCorpus");
    expect(status).toContain("scoped.runnable");
  });

  it("the scheduled fleet sync uses the same implementation", async () => {
    const src = await read("fleet-migration.server.ts");
    expect(src).toContain("export async function openScopedPrimeCorpus");
    // Exactly one site constructs the scope; everything else calls the helper.
    expect(src.match(/scopeCorpusToPrime\(/g)?.length).toBe(1);
  });
});

describe("partitionByDependency — never step over a hole", () => {
  const meta = (id: string) => ({ id, name: `${id}_m.sql` });
  // The real shape, from npc-client-dashboard.
  const FRONTIER = "20260920000000";
  const DEFINER = "20261012000000"; // defines ensure_builder_stock_settlement_scheduled()
  const CALLER = "20261027010000"; // calls it
  const corpus = [meta(FRONTIER), meta(DEFINER), meta(CALLER)];

  it("refuses to send a migration whose predecessor was withheld", () => {
    // Exactly what happened: the prime's ledger records the CALLER and not the
    // DEFINER, so the scope cleared the caller alone and the clone answered
    // 42883. The clone already holds the frontier.
    const part = partitionByDependency(
      corpus,
      new Set([FRONTIER, CALLER]), // runnable per the prime's ledger
      new Set([FRONTIER]), // the clone's own ledger
    );
    expect(part.send).toEqual([]);
    expect(part.orphaned.map((o) => o.meta.id)).toEqual([CALLER]);
    expect(part.orphaned[0].blockedBy).toEqual([DEFINER]);
  });

  it("sends it once the hole is filled", () => {
    const part = partitionByDependency(
      corpus,
      new Set([FRONTIER, DEFINER, CALLER]),
      new Set([FRONTIER]),
    );
    expect(part.send.map((m) => m.id)).toEqual([DEFINER, CALLER]);
    expect(part.orphaned).toEqual([]);
  });

  it("a version the CLONE already holds is not a hole, whatever the prime's ledger says", () => {
    // The prime's ledger is polluted with a second id namespace — this prime's
    // repo holds 20250912170521 where its ledger holds 20250912050519. A clone
    // that already has the version must not be blocked by the prime's failure
    // to record it, or every clone freezes at its thirteenth migration.
    const part = partitionByDependency(
      corpus,
      new Set([CALLER]), // prime's ledger records only the caller
      new Set([FRONTIER, DEFINER]), // but the clone HAS the definer
    );
    expect(part.send.map((m) => m.id)).toEqual([CALLER]);
    expect(part.orphaned).toEqual([]);
  });

  it("skips rather than halts, so everything after a hole is still considered", () => {
    // Halting is what starved seedAdminUser: the replay stopped at step 5 of 7
    // and the clone never got an owner. A later runnable version is reported as
    // orphaned in its own right, not silently swallowed by an early exit.
    const later = meta("20261029000000");
    const part = partitionByDependency(
      [...corpus, later],
      new Set([FRONTIER, CALLER, later.id]),
      new Set([FRONTIER]),
    );
    expect(part.send).toEqual([]);
    expect(part.orphaned.map((o) => o.meta.id)).toEqual([CALLER, later.id]);
  });

  it("caps the recorded blockers, keeping the first", () => {
    const holes = Array.from({ length: 40 }, (_, i) =>
      meta(`2026100${String(i).padStart(7, "0")}`),
    );
    const tail = meta("20261099000000");
    const part = partitionByDependency([...holes, tail], new Set([tail.id]), new Set(), 3);
    expect(part.orphaned).toHaveLength(1);
    expect(part.orphaned[0].blockedBy).toEqual(holes.slice(0, 3).map((m) => m.id));
  });

  it("is a no-op when nothing was withheld", () => {
    const part = partitionByDependency(corpus, new Set(corpus.map((m) => m.id)), new Set());
    expect(part.send).toHaveLength(3);
    expect(part.orphaned).toEqual([]);
  });
});

describe("the self-healing sql_migration lane is the third replay path", () => {
  it("scopes through the same function, and never passes the raw corpus", async () => {
    /*
      Found 2 Sep 2026: the cascade's catch-up lane took the raw listing and
      called 341 files "pending" on a clone the fleet sync reported level —
      fifty-eight of them destructive. Same defect as the button, one file
      over.
    */
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./self-healing.server.ts", import.meta.url), "utf8");
    const start = src.indexOf("async function executeSqlMigration");
    const end = src.indexOf("async function deployWithinBudget");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const lane = src.slice(start, end);
    expect(lane).toContain("openScopedPrimeCorpus");
    expect(lane).not.toContain("openPrimeMigrationCorpus(");
    expect(lane).toMatch(/applyPrimeMigrations\(\s*backend\.supabase_project_ref,\s*runnable,/);
  });
});
