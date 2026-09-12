import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  composeCoverage,
  describeCoverage,
  KNOWN_ASSERTION_NAMES,
  MIGRATION_PROVENANCE_VALUES,
  provenanceFromCanonicalName,
  provenanceFromLedgerName,
  type ProvenanceRow,
} from "./migrationProvenance.pure";

const read = (p: string) => readFileSync(p, "utf8");

describe("provenanceFromLedgerName", () => {
  it("reads the lane's own filename as an execution", () => {
    expect(
      provenanceFromLedgerName("20250124120000_fix_client_data_rls_policies.sql", "20250124120000"),
    ).toBe("applied");
  });

  it("accepts the extension in any case", () => {
    expect(provenanceFromLedgerName("20260101000000_thing.SQL", "20260101000000")).toBe("applied");
  });

  it("refuses a filename belonging to a different version", () => {
    // A row naming somebody else's file is not evidence this one ran.
    expect(
      provenanceFromLedgerName("20250124120000_fix_client_data_rls_policies.sql", "20260101000000"),
    ).toBeNull();
  });

  it("treats a name equal to the version as no evidence", () => {
    // `stampMigrationLedgerFromPrime` writes coalesce(name, version); measured
    // 862 of 948 rows on one clone look like this.
    expect(provenanceFromLedgerName("20260101000000", "20260101000000")).toBeNull();
  });

  it.each([
    // Each is a genuine prefix of a listed name, and each is unknown — the
    // match is exact membership, never a prefix or a keyword. A rule loose
    // enough to catch these is loose enough to catch a name nobody wrote.
    [
      "accounted: this clone was built by catalog introspection from the prime and already carries what this file creates",
    ],
    [
      "OWED: the prime carries this and this clone does not — a cron schedule that hardcodes the prime project ref",
    ],
    [
      "UNVERIFIED: this file leaves no observable this check can read — a data backfill, a grant sweep",
    ],
    ["accounted: something nobody has accounted for"],
    ["OWED:"],
  ])("treats prose that is not on the list as unknown (%s)", (name) => {
    expect(provenanceFromLedgerName(name, "20260101000000")).toBeNull();
  });

  it.each(KNOWN_ASSERTION_NAMES.map((n) => [n]))(
    "reads a listed name as an assertion (%s)",
    (name) => {
      expect(provenanceFromLedgerName(name, "20260101000000")).toBe("asserted");
    },
  );

  it.each([
    ["seed_template_library_v9_report_part_numbering"],
    ["refresh_active_masters_from_library_v10"],
    ["seed_template_library_v12_guarded_verdict_line"],
  ])("reports a hand-carried apply recorded under a slug as unknown, not asserted (%s)", (name) => {
    // These six are REAL executions on npc-client-dashboard. The heuristic this
    // module replaces ("not a .sql filename ⇒ an assertion") called them
    // assertions and would have invited a re-run. Unknown is the honest answer.
    expect(provenanceFromLedgerName(name, "20260916100000")).toBeNull();
  });

  it.each([[null], [undefined], [""], ["   "]])("answers null for %s", (name) => {
    expect(provenanceFromLedgerName(name as string | null, "20260101000000")).toBeNull();
  });

  it("answers null when the version is missing", () => {
    expect(provenanceFromLedgerName("20260101000000_x.sql", "")).toBeNull();
  });

  it("refuses a bare version with the extension and no slug", () => {
    expect(provenanceFromLedgerName("20260101000000_.sql", "20260101000000")).toBeNull();
  });
});

describe("provenanceFromCanonicalName", () => {
  it("recognises the one assertion writer whose run is known", () => {
    expect(provenanceFromCanonicalName("aurixa-baseline")).toBe("asserted");
  });

  it("tolerates surrounding whitespace", () => {
    expect(provenanceFromCanonicalName("  aurixa-baseline  ")).toBe("asserted");
  });

  it.each([
    ["20260101000000_thing.sql"],
    ["20260101000000"],
    ["some-other-tool"],
    ["aurixa-baseline-v2"],
  ])("answers unknown for everything else (%s)", (name) => {
    // A filename in the CANONICAL ledger is copied from the prime by
    // `stampMigrationLedgerFromPrime` and says nothing about the clone.
    expect(provenanceFromCanonicalName(name)).toBeNull();
  });

  it.each([[null], [undefined], [""]])("answers null for %s", (name) => {
    expect(provenanceFromCanonicalName(name as string | null)).toBeNull();
  });

  it("keeps the known-writer list a list, not a pattern", () => {
    // It grows only when somebody can say who wrote a name and why: one
    // baseline writer plus the seven rationales of the 2026-09-02 run.
    expect(KNOWN_ASSERTION_NAMES).toContain("aurixa-baseline");
    expect(KNOWN_ASSERTION_NAMES).toHaveLength(8);
    expect(new Set(KNOWN_ASSERTION_NAMES).size).toBe(KNOWN_ASSERTION_NAMES.length);
    // Every entry is a literal somebody quoted, not a fragment to match on.
    for (const n of KNOWN_ASSERTION_NAMES) expect(n.trim()).toBe(n);
  });
});

describe("composeCoverage", () => {
  const rows = (...pairs: Array<[string, "applied" | "asserted"]>): ProvenanceRow[] =>
    pairs.map(([version, provenance]) => ({ version, provenance }));

  it("partitions the recorded set and always sums to it", () => {
    const c = composeCoverage(
      ["a", "b", "c", "d", "e"],
      rows(["a", "applied"], ["b", "applied"], ["c", "asserted"]),
    );
    expect(c).toEqual({ recorded: 5, applied: 2, asserted: 1, unclassified: 2 });
    expect(c.applied + c.asserted + c.unclassified).toBe(c.recorded);
  });

  it("ignores provenance for a version the clone does not record", () => {
    // The table annotates the ledgers; it is never a second opinion on them.
    const c = composeCoverage(["a"], rows(["a", "applied"], ["ghost", "applied"]));
    expect(c).toEqual({ recorded: 1, applied: 1, asserted: 0, unclassified: 0 });
  });

  it("counts a version once however many provenance rows name it", () => {
    const c = composeCoverage(["a"], rows(["a", "applied"], ["a", "asserted"]));
    expect(c.recorded).toBe(1);
    expect(c.applied + c.asserted).toBe(1);
  });

  it("de-duplicates the recorded set", () => {
    expect(composeCoverage(["a", "a", "b"], []).recorded).toBe(2);
  });

  it("reports an empty clone as empty rather than throwing", () => {
    expect(composeCoverage([], [])).toEqual({
      recorded: 0,
      applied: 0,
      asserted: 0,
      unclassified: 0,
    });
  });

  it("leaves everything unclassified when nothing has been recorded yet", () => {
    // The state every clone is in before the backfill runs.
    const c = composeCoverage(["a", "b", "c"], []);
    expect(c.unclassified).toBe(3);
    expect(c.applied).toBe(0);
    expect(c.asserted).toBe(0);
  });
});

describe("describeCoverage", () => {
  it("says nothing when every recorded version was applied here", () => {
    expect(describeCoverage({ recorded: 7, applied: 7, asserted: 0, unclassified: 0 })).toBeNull();
  });

  it("says nothing about an empty clone", () => {
    expect(describeCoverage({ recorded: 0, applied: 0, asserted: 0, unclassified: 0 })).toBeNull();
  });

  it("names both populations when both are present", () => {
    const s = describeCoverage({ recorded: 980, applied: 22, asserted: 783, unclassified: 175 });
    expect(s).toContain("980");
    expect(s).toContain("22 were applied here");
    expect(s).toContain("783");
    expect(s).toContain("175");
  });

  it("names only what is there", () => {
    const s = describeCoverage({ recorded: 10, applied: 4, asserted: 0, unclassified: 6 });
    expect(s).not.toContain("assertion");
    expect(s).toContain("6 were recorded before this was written down");
  });
});

describe("the rules this module exists to keep", () => {
  const pure = read("src/server/migrationProvenance.pure.ts");

  it("offers exactly two provenance values", () => {
    expect([...MIGRATION_PROVENANCE_VALUES]).toEqual(["applied", "asserted"]);
  });

  it("produces 'asserted' only by exact membership, never from shape", () => {
    // The invariant, tested by behaviour rather than by reading the source:
    // mutate any listed name by one character at either end and it must stop
    // being an assertion. A prefix, suffix or keyword rule would survive this.
    for (const known of KNOWN_ASSERTION_NAMES) {
      expect(provenanceFromLedgerName(known, "20260101000000")).toBe("asserted");
      expect(provenanceFromLedgerName(known.slice(0, -1), "20260101000000")).toBeNull();
      expect(provenanceFromLedgerName(`${known}.`, "20260101000000")).toBeNull();
      expect(provenanceFromCanonicalName(known.slice(1))).toBeNull();
    }
  });

  it("keeps the classifier free of prefix and keyword matching", () => {
    // The one source-level guard worth keeping: a `startsWith("accounted:")`
    // would classify 783 legacy rows AND the eight applies sitting beside them.
    const start = pure.indexOf("export function provenanceFromLedgerName");
    const end = pure.indexOf("\n}\n", start);
    const body = pure.slice(start, end);
    expect(body).not.toMatch(/startsWith\(\s*["`']accounted|OWED|UNVERIFIED/i);
    expect(body).toContain("KNOWN_ASSERTION_NAMES.includes");
  });

  it("leaves the eight hand-carried applies off the assertion list", () => {
    // Real executions on npc-client-dashboard recorded under a slug. Sweeping
    // them up with the 775 prose rows is the misreading this module prevents.
    for (const slug of [
      "seed_template_library_v9_report_part_numbering",
      "reactivate_templates_v9_part_numbering",
      "seed_template_library_v10_tier_identity_contents_figures",
      "refresh_active_masters_from_library_v10",
      "seed_template_library_v11_render_parts_conditional_rows",
      "refresh_active_masters_from_library_v11",
      "seed_template_library_v12_guarded_verdict_line",
      "refresh_active_masters_from_library_v12",
    ]) {
      expect(KNOWN_ASSERTION_NAMES).not.toContain(slug);
      expect(provenanceFromLedgerName(slug, "20260916100000")).toBeNull();
    }
  });

  it("keeps the applied-set a union with no provenance filter in it", () => {
    // The rule that makes this change safe: an assertion and an execution both
    // mean "do not send". Filtering the union to executions turns every
    // assertion into a hole, and nothing after a hole is ever sent.
    for (const file of [
      "src/server/self-healing.server.ts",
      "src/server/backend-provisioning.server.ts",
    ]) {
      const src = read(file);
      const unions = src.match(/UNION\s+SELECT\s+version\s+FROM\s+aurixa\.schema_migrations/gi);
      expect(unions, `${file} should still union the legacy ledger`).not.toBeNull();
      // No reader of the applied-set may narrow it by provenance.
      expect(src).not.toMatch(/schema_migrations[\s\S]{0,200}provenance\s*=\s*'applied'/i);
    }
  });
});

describe("the backfill does not depend on the replay having run", () => {
  const server = read("src/server/migrationProvenance.server.ts");
  const provisioning = read("src/server/backend-provisioning.server.ts");
  const lane = read("src/server/self-healing.server.ts");

  it("ensures the provenance table itself", () => {
    // The lane returns early on `pending.length === 0` and so never reaches
    // `applyPrimeMigrations`, where the ledgers are ensured. A backfill that
    // relied on that would annotate nothing on an up-to-date clone — which is
    // most clones, most of the time.
    expect(server).toContain("PROVENANCE_TABLE_SQL");
    const write = server.slice(server.indexOf("const entries = [...decided.entries()]"));
    expect(write.indexOf("runSqlOnProject(projectRef, PROVENANCE_TABLE_SQL)")).toBeGreaterThan(-1);
    expect(write.indexOf("runSqlOnProject(projectRef, PROVENANCE_TABLE_SQL)")).toBeLessThan(
      write.indexOf("insert into aurixa.migration_provenance"),
    );
  });

  it("keeps ONE copy of the table DDL", () => {
    expect(provisioning).toContain("export const PROVENANCE_TABLE_SQL");
    // The replay's own ensure interpolates it rather than restating it.
    expect(provisioning).toContain("${PROVENANCE_TABLE_SQL}");
    const creates = provisioning.match(/create table if not exists aurixa\.migration_provenance/g);
    expect(creates).toHaveLength(1);
    expect(server).not.toMatch(/create table if not exists aurixa\.migration_provenance/);
  });

  it("runs the backfill before the lane's early return", () => {
    const backfill = lane.indexOf("recordKnownProvenance");
    const earlyReturn = lane.indexOf("clone already at prime migration head");
    expect(backfill).toBeGreaterThan(-1);
    expect(backfill).toBeLessThan(earlyReturn);
  });
});
