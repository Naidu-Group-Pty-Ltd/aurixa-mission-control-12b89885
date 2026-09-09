import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  readCloneMigrationStanding,
  sharedVersionReading,
  type LedgerRow,
  type RunnableMigration,
} from "./cloneMigrationStanding.pure";

/**
 * A corpus entry as `openPrimeMigrationCorpus` builds one: `name` is the FULL
 * filename. The clone's ledger spells the same migration as the Supabase CLI
 * does — the base alone — so the fixtures below deliberately mix both forms.
 */
const m = (id: string, base: string): RunnableMigration => ({
  id,
  name: `${id}_${base}.sql`,
});

/**
 * The production shape, measured 9 Sep 2026 on `plisdzywzleljorrphxv`
 * (NPC Client Dashboard) and identical on the other two clones. Four versions
 * sit above Mission Control's stored cursor `20261111010000`; one of them is
 * carried by two files.
 */
const RUNNABLE_TAIL: RunnableMigration[] = [
  m("20261112000000", "client_deals_agent_fee_receipt"),
  m("20261112000000", "seed_template_library_v12_guarded_verdict_line"),
  m("20261112010000", "refresh_active_masters_from_library_v12"),
  m("20261114090000", "verification_workspace_out_of_tokens"),
  m("20261115100000", "builder_stock_runtime_version_3"),
];

/** What the clone actually records for that tail. */
const CLONE_TAIL: LedgerRow[] = [
  { version: "20261112000000", name: "seed_template_library_v12_guarded_verdict_line" },
  { version: "20261112000000", name: "20261112000000" }, // the legacy aurixa mirror
  { version: "20261112010000", name: "refresh_active_masters_from_library_v12" },
];

describe("the reading the clone page shows", () => {
  it("names the two migrations that are genuinely owed, and nothing else", () => {
    // The badge said "5 PENDING" against a cursor. Two of the five were already
    // applied and a third can never be sent.
    const r = readCloneMigrationStanding({
      runnable: RUNNABLE_TAIL,
      ledger: CLONE_TAIL,
      recordedVersion: "20261111010000",
    });
    expect(r.basis).toBe("clone_ledger");
    expect(r.pending.map((p) => p.description)).toEqual([
      "20261114090000_verification_workspace_out_of_tokens.sql",
      "20261115100000_builder_stock_runtime_version_3.sql",
    ]);
    // Four versions runnable, two of them recorded here — which is the pair the
    // card draws, and it adds up in a way the file count never could.
    expect(r.appliedVersionCount).toBe(2);
    expect(r.runnableVersionCount).toBe(4);
  });

  it("puts the file that shares a recorded version in its own reading, never in pending", () => {
    // `client_deals_agent_fee_receipt` shares 20261112000000 with the v12 seed.
    // `version` is the PRIMARY KEY and the replay skips by version, so pressing
    // Apply cannot send it — offering it as pending work is a button that does
    // nothing, for ever.
    const r = readCloneMigrationStanding({
      runnable: RUNNABLE_TAIL,
      ledger: CLONE_TAIL,
      recordedVersion: "20261111010000",
    });
    expect(r.pending.some((p) => p.description.includes("client_deals_agent_fee_receipt"))).toBe(
      false,
    );
    expect(r.sharedVersions).toHaveLength(1);
    const s = r.sharedVersions[0];
    expect(s.version).toBe("20261112000000");
    expect(s.recordedAs).toBe("seed_template_library_v12_guarded_verdict_line");
    expect(s.files).toContain("20261112000000_client_deals_agent_fee_receipt.sql");
    const reading = sharedVersionReading(s);
    expect(reading).toContain("client_deals_agent_fee_receipt");
    expect(reading).toContain("cannot be applied here");
    // And it must not say the migration that DID run is one of the ones that
    // never will — the two names differ only by prefix and suffix, so a string
    // comparison keeps the recorded file in the "cannot be applied" list.
    expect(reading.split("shares this version")[0]).not.toContain(
      "20261112000000_seed_template_library_v12_guarded_verdict_line.sql",
    );
  });

  it("counts the recorded half of a shared version as applied, not as a problem", () => {
    const r = readCloneMigrationStanding({
      runnable: RUNNABLE_TAIL,
      ledger: CLONE_TAIL,
      recordedVersion: null,
    });
    // The seed IS applied — the ledger names it. Only its sibling is held.
    expect(r.appliedVersionCount).toBe(2);
    expect(r.sharedVersions.map((s) => s.version)).toEqual(["20261112000000"]);
  });

  it("reports where the clone actually stands, not where the cursor was left", () => {
    // The pair the card draws. On all three deployments the clone's own maximum
    // was AHEAD of the version Mission Control had recorded about it, which is
    // the shape that made "5 pending" look plausible.
    const r = readCloneMigrationStanding({
      runnable: RUNNABLE_TAIL,
      ledger: CLONE_TAIL,
      recordedVersion: "20261111010000",
    });
    expect(r.latestAppliedVersion).toBe("20261112010000");
  });

  it("ignores Mission Control's cursor entirely once the ledger is readable", () => {
    // The cursor is a record of a run. A clone AHEAD of it — which is the state
    // that produced this defect — must read as up to date, not as five behind.
    const r = readCloneMigrationStanding({
      runnable: [m("20260101000000", "old_one")],
      ledger: [{ version: "20260101000000", name: "20260101000000" }],
      recordedVersion: "20250101000000",
    });
    expect(r.pending).toEqual([]);
  });
});

describe("the name column is not evidence", () => {
  /*
    `stampMigrationLedgerFromPrime` writes `coalesce(name, version)` and the
    prime's own rows are mostly nameless, so the clone's `name` is usually the
    version repeated: 862 of 948 rows on the live clone. A matcher that trusted
    it would call almost the whole corpus "recorded under another name".
  */
  it("a name equal to the version counts as applied, not as a mismatch", () => {
    const r = readCloneMigrationStanding({
      runnable: [m("20260820000000", "report_qa_render_path")],
      ledger: [{ version: "20260820000000", name: "20260820000000" }],
      recordedVersion: null,
    });
    expect(r.pending).toEqual([]);
    expect(r.sharedVersions).toEqual([]);
    expect(r.appliedVersionCount).toBe(1);
  });

  it("a null name counts as applied for a version only one file carries", () => {
    const r = readCloneMigrationStanding({
      runnable: [m("20260820000000", "report_qa_render_path")],
      ledger: [{ version: "20260820000000", name: null }],
      recordedVersion: null,
    });
    expect(r.appliedVersionCount).toBe(1);
    expect(r.sharedVersions).toEqual([]);
  });

  it("says so plainly when a shared version has no name to settle it", () => {
    // Nine of the ten runnable collision versions look exactly like this on a
    // live clone. Naming one of the two files here would be a guess.
    const r = readCloneMigrationStanding({
      runnable: [
        m("20260820000000", "builder_admin_safe_deletion"),
        m("20260820000000", "report_qa_render_path"),
      ],
      ledger: [{ version: "20260820000000", name: "20260820000000" }],
      recordedVersion: null,
    });
    expect(r.pending).toEqual([]);
    // Recorded — one version, counted once — while still saying it cannot
    // attribute it. "Nothing outstanding" and "we know which file ran" are
    // different claims and only the first is being made.
    expect(r.appliedVersionCount).toBe(1);
    expect(r.sharedVersions).toHaveLength(1);
    expect(r.sharedVersions[0].recordedAs).toBeNull();
    const reading = sharedVersionReading(r.sharedVersions[0]);
    expect(reading).toContain("does not say which");
    expect(reading).toContain("builder_admin_safe_deletion");
    expect(reading).toContain("report_qa_render_path");
  });

  it("matches the CLI's spelling of a name against the corpus's filename", () => {
    // The two sides never spell it the same way. A corpus entry is the full
    // filename (which is also what `applyPrimeMigrations` writes when it
    // applies one); the prime's own ledger — and so everything the re-stamp
    // copies onto a clone — carries the Supabase CLI's base form. Comparing
    // them raw makes every collision unresolvable and every recorded half of
    // one read as never applied.
    const r = readCloneMigrationStanding({
      runnable: [
        m("20261112000000", "client_deals_agent_fee_receipt"),
        m("20261112000000", "seed_template_library_v12_guarded_verdict_line"),
      ],
      ledger: [
        { version: "20261112000000", name: "seed_template_library_v12_guarded_verdict_line" },
      ],
      recordedVersion: null,
    });
    expect(r.appliedVersionCount).toBe(1);
    expect(r.sharedVersions[0].recordedAs).toBe(
      "seed_template_library_v12_guarded_verdict_line",
    );
  });

  it("reads a name carrying both files of a collision as applying to both", () => {
    // The prime records some collisions it applied together under one joined
    // name — `20260821000000` is `builder_admin_blocker_array_fix +
    // market_intelligence_render_path` in its own ledger. Equality alone would
    // hold both files as unresolvable.
    const r = readCloneMigrationStanding({
      runnable: [
        m("20260821000000", "builder_admin_blocker_array_fix"),
        m("20260821000000", "market_intelligence_render_path"),
      ],
      ledger: [
        {
          version: "20260821000000",
          name: "builder_admin_blocker_array_fix + market_intelligence_render_path",
        },
      ],
      recordedVersion: null,
    });
    expect(r.sharedVersions).toEqual([]);
    // One version, so one count — the pair is not two migrations to the ledger
    // or to the replay, and counting them as two is what would make a healthy
    // clone read as holding more than the corpus has.
    expect(r.appliedVersionCount).toBe(1);
    expect(r.runnableVersionCount).toBe(1);
  });

  it("still holds a shared version whose recorded name is a file the corpus does not carry", () => {
    const r = readCloneMigrationStanding({
      runnable: [m("20260820000000", "a_one"), m("20260820000000", "b_two")],
      ledger: [{ version: "20260820000000", name: "something_else_entirely" }],
      recordedVersion: null,
    });
    expect(r.pending).toEqual([]);
    expect(r.sharedVersions).toHaveLength(1);
    expect(r.sharedVersions[0].recordedAs).toBe("something_else_entirely");
  });
});

describe("a ledger that could not be read", () => {
  it("falls back to the recorded cursor and says which reading this is", () => {
    // The load-bearing rule. A failed read is not an empty database, and
    // treating it as one would offer to replay the whole corpus at a healthy
    // tenant backend — the exact click that once marked a clone `failed`.
    const r = readCloneMigrationStanding({
      runnable: RUNNABLE_TAIL,
      ledger: null,
      recordedVersion: "20261111010000",
      ledgerError: "SQL execution failed on plisdzywzleljorrphxv: 503",
    });
    expect(r.basis).toBe("recorded_version");
    expect(r.appliedVersionCount).toBeNull();
    expect(r.note).toContain("could not be read");
    expect(r.note).toContain("503");
    // Exactly the old behaviour, and no more: the cursor's answer, unchanged —
    // five files above the cursor, including the one that can never be sent.
    // Preserved deliberately. A fallback that quietly improved on the reading
    // it is standing in for would be a second measure nobody could check.
    expect(r.pending).toHaveLength(5);
    expect(r.sharedVersions).toEqual([]);
  });

  it("never reports an unreadable clone as owing the entire corpus", () => {
    const r = readCloneMigrationStanding({
      runnable: RUNNABLE_TAIL,
      ledger: null,
      recordedVersion: "20261115100000",
    });
    expect(r.pending).toEqual([]);
  });

  it("treats an empty ledger beside a recorded cursor as a contradiction, not a measurement", () => {
    // Zero rows is credible on a brand-new project and not credible on one
    // Mission Control has synced: every replay creates the tracking table. The
    // difference decides whether a page offers a 1,000-migration replay.
    const r = readCloneMigrationStanding({
      runnable: RUNNABLE_TAIL,
      ledger: [],
      recordedVersion: "20261111010000",
    });
    expect(r.basis).toBe("recorded_version");
    expect(r.pending).toHaveLength(5);
    expect(r.note).toContain("came back empty");
  });

  it("does report a genuinely fresh project as owing everything", () => {
    // No cursor and no ledger is a project nothing has ever run against, and
    // there the whole corpus really is pending.
    const r = readCloneMigrationStanding({
      runnable: RUNNABLE_TAIL,
      ledger: [],
      recordedVersion: null,
    });
    expect(r.basis).toBe("clone_ledger");
    expect(r.pending).toHaveLength(5);
  });
});

describe("the server function asks the clone", () => {
  const src = readFileSync("src/server/migration-sync.functions.ts", "utf8");
  const status = src.slice(
    src.indexOf("getCloneMigrationStatus"),
    src.indexOf("syncCloneMigrations"),
  );

  it("reads the clone's own ledger rather than its stored cursor", () => {
    // A pure module nothing calls is a rule that does not exist, and the whole
    // defect was that this handler measured against `backend.migration_version`.
    expect(status).toContain("readCloneMigrationStanding");
    expect(status).toContain("readCloneMigrationLedger");
  });

  it("does not measure a backend that is still moving", () => {
    // The card polls this every five seconds while a backend provisions, and
    // both readings are Management API calls against the clone's project. A
    // reading taken mid-run is stale before it is drawn, and paying for it per
    // clone per tick is how a fleet page meets a rate limiter.
    expect(status).toContain("const settled = !");
    for (const moving of ["pending", "provisioning", "migrating", "seeding_admin"]) {
      expect(status).toContain(`"${moving}"`);
    }
  });

  it("measures the deployed edge functions rather than reporting the provisioning array", () => {
    expect(status).toContain("countProjectEdgeFunctions");
    expect(status).toContain("deployedFunctions");
  });

  it("still scopes the corpus to what the prime itself has run", () => {
    // Unchanged, and the reason is #71's: a clone never runs a migration the
    // prime has not run. This change alters what is REPORTED, never what the
    // Apply button sends.
    expect(status).toContain("openScopedPrimeCorpus");
    expect(status).toContain("scoped.runnable");
  });
});
