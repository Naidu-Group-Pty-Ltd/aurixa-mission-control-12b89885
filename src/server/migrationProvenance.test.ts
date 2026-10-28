import { readFileSync } from "node:fs";
import { upgradeNote } from "./migrationProvenance.server";
import { PROVENANCE_TABLE_SQL } from "./backend-provisioning.server";
import { describe, expect, it } from "vitest";
import {
  BASELINE_ASSERTION_NAME,
  composeCoverage,
  describeCoverage,
  KNOWN_ASSERTION_NAMES,
  EXTERNAL_APPLY_NOTE,
  MIGRATION_PROVENANCE_VALUES,
  provenanceFromCanonicalRow,
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

describe("provenanceFromCanonicalRow", () => {
  // What the lane's own writers leave: no body, and a legacy row beside it.
  const mine = { hasBody: false, hasLegacyRow: true };

  it("recognises the one assertion writer whose run is known", () => {
    expect(provenanceFromCanonicalRow({ name: "aurixa-baseline", ...mine })).toBe("asserted");
  });

  it("tolerates surrounding whitespace", () => {
    expect(provenanceFromCanonicalRow({ name: "  aurixa-baseline  ", ...mine })).toBe("asserted");
  });

  it.each([
    ["20260101000000_thing.sql"],
    ["20260101000000"],
    ["some-other-tool"],
    ["aurixa-baseline-v2"],
  ])("answers unknown for everything else (%s)", (name) => {
    // A filename in the CANONICAL ledger is copied from the prime by
    // `stampMigrationLedgerFromPrime` and says nothing about the clone.
    expect(provenanceFromCanonicalRow({ name, ...mine })).toBeNull();
    // Nor does a bare name with no legacy row: a stamp carries no body.
    expect(provenanceFromCanonicalRow({ name, hasBody: false, hasLegacyRow: false })).toBeNull();
  });

  it.each([[null], [undefined], [""]])("answers null for %s", (name) => {
    expect(provenanceFromCanonicalRow({ name: name as string | null, ...mine })).toBeNull();
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

describe("a row another applier wrote", () => {
  /*
    Measured 27 Oct 2026. npc-crm-independent-6505dc's own "Apply a migration"
    workflow ran five versions on 26 Oct (run 40406460451) while this lane held
    them behind four holes; its recorder stores the body it applied and writes
    no legacy row. The three mirrors carry 6, 8 and 8 hand-run applies from
    6-13 Sep, recorded the same way. Every Mission Control writer of the
    canonical ledger stores `ARRAY[]::text[]` and the lane writes the legacy
    row beside it, so the two marks together are the writer's own signature.
  */

  it("labels a body with no legacy row external", () => {
    expect(
      provenanceFromCanonicalRow({
        name: "brand_settings_logo_dark_url",
        hasBody: true,
        hasLegacyRow: false,
      }),
    ).toBe("external");
  });

  it("labels it external whatever name its applier gave it, or none", () => {
    for (const name of ["20261026090000", "20261026090000_x.sql", "", null, undefined]) {
      expect(provenanceFromCanonicalRow({ name, hasBody: true, hasLegacyRow: false })).toBe(
        "external",
      );
    }
  });

  it("leaves a body beside a legacy row unknown", () => {
    // The legacy row is the lane's own mark. A row carrying both is not one
    // this rule can attribute, so it answers what it can read: nothing.
    expect(
      provenanceFromCanonicalRow({ name: "20261026090000", hasBody: true, hasLegacyRow: true }),
    ).toBeNull();
  });

  it("leaves a row with no body unknown", () => {
    // The shape every Mission Control writer leaves, legacy row or not: the
    // stamp `stampMigrationLedgerFromPrime` copies from the prime is bodiless.
    expect(
      provenanceFromCanonicalRow({ name: "20261026090000", hasBody: false, hasLegacyRow: false }),
    ).toBeNull();
  });

  it("lets a known assertion name outrank the body test", () => {
    // An assertion is what somebody wrote down. A body beside it does not make
    // the assertion an execution, and the rule never decides that it does.
    expect(
      provenanceFromCanonicalRow({ name: "aurixa-baseline", hasBody: true, hasLegacyRow: false }),
    ).toBe("asserted");
  });

  it("notes the row with what it is, before the name it was given", () => {
    expect(EXTERNAL_APPLY_NOTE).toBe(
      "recorded with its body by an applier other than Mission Control",
    );
    expect(EXTERNAL_APPLY_NOTE).not.toMatch(/applied here|executed here|Mission Control ran/i);
  });

  it("reads the body as a boolean, never the body itself", () => {
    // A clone's bodies are megabytes this has no use for, and the mark the
    // rule reads is whether a body exists, not what it says.
    const server = read("src/server/migrationProvenance.server.ts");
    expect(server).toContain("cardinality(coalesce(statements, '{}'::text[])) > 0 as has_body");
    expect(server).not.toMatch(/select\s+version,\s*name,\s*statements\b/i);
  });

  it("asks the legacy ledger of the same pass, not a second read", () => {
    const server = read("src/server/migrationProvenance.server.ts");
    expect(server).toContain("const legacyVersions = new Set(legacy.map((r) => str(r.version)));");
    expect(server).toContain("hasLegacyRow: legacyVersions.has(version)");
  });
});

describe("composeCoverage", () => {
  const rows = (...pairs: Array<[string, ProvenanceRow["provenance"]]>): ProvenanceRow[] =>
    pairs.map(([version, provenance]) => ({ version, provenance }));

  it("partitions the recorded set and always sums to it", () => {
    const c = composeCoverage(
      ["a", "b", "c", "d", "e", "f"],
      rows(["a", "applied"], ["b", "applied"], ["c", "asserted"], ["d", "external"]),
    );
    expect(c).toEqual({ recorded: 6, applied: 2, asserted: 1, external: 1, unclassified: 2 });
    expect(c.applied + c.asserted + c.external + c.unclassified).toBe(c.recorded);
  });

  it("ignores provenance for a version the clone does not record", () => {
    // The table annotates the ledgers; it is never a second opinion on them.
    const c = composeCoverage(
      ["a"],
      rows(["a", "applied"], ["ghost", "applied"], ["phantom", "external"]),
    );
    expect(c).toEqual({ recorded: 1, applied: 1, asserted: 0, external: 0, unclassified: 0 });
  });

  it("counts a version once however many provenance rows name it", () => {
    const c = composeCoverage(["a"], rows(["a", "applied"], ["a", "asserted"], ["a", "external"]));
    expect(c.recorded).toBe(1);
    expect(c.applied + c.asserted + c.external).toBe(1);
  });

  it("de-duplicates the recorded set", () => {
    expect(composeCoverage(["a", "a", "b"], []).recorded).toBe(2);
  });

  it("reports an empty clone as empty rather than throwing", () => {
    expect(composeCoverage([], [])).toEqual({
      recorded: 0,
      applied: 0,
      asserted: 0,
      external: 0,
      unclassified: 0,
    });
  });

  it("leaves everything unclassified when nothing has been recorded yet", () => {
    // The state every clone is in before the backfill runs.
    const c = composeCoverage(["a", "b", "c"], []);
    expect(c.unclassified).toBe(3);
    expect(c.applied).toBe(0);
    expect(c.asserted).toBe(0);
    expect(c.external).toBe(0);
  });

  it("counts an external row as neither applied here nor unknown", () => {
    // The CRM's five: run by its own workflow, so not the lane's execution,
    // and recorded with their bodies, so not unknown either.
    const c = composeCoverage(
      ["v1", "v2", "v3", "v4", "v5", "v6"],
      rows(
        ["v1", "external"],
        ["v2", "external"],
        ["v3", "external"],
        ["v4", "external"],
        ["v5", "external"],
      ),
    );
    expect(c).toEqual({ recorded: 6, applied: 0, asserted: 0, external: 5, unclassified: 1 });
  });
});

describe("describeCoverage", () => {
  it("says nothing when every recorded version was applied here", () => {
    expect(
      describeCoverage({ recorded: 7, applied: 7, asserted: 0, external: 0, unclassified: 0 }),
    ).toBeNull();
  });

  it("says nothing about an empty clone", () => {
    expect(
      describeCoverage({ recorded: 0, applied: 0, asserted: 0, external: 0, unclassified: 0 }),
    ).toBeNull();
  });

  it("names both populations when both are present", () => {
    const s = describeCoverage({
      recorded: 980,
      applied: 22,
      asserted: 783,
      external: 0,
      unclassified: 175,
    });
    expect(s).toContain("980");
    expect(s).toContain("22 were applied here");
    expect(s).toContain("783");
    expect(s).toContain("175");
  });

  it("names only what is there", () => {
    const s = describeCoverage({
      recorded: 10,
      applied: 4,
      asserted: 0,
      external: 0,
      unclassified: 6,
    });
    expect(s).not.toContain("assertion");
    expect(s).not.toContain("another applier");
    expect(s).not.toContain("other than Mission Control");
    expect(s).toContain("6 were recorded before this was written down");
  });

  it("names the rows another applier ran, and never as applied here", () => {
    const s = describeCoverage({
      recorded: 1001,
      applied: 990,
      asserted: 0,
      external: 5,
      unclassified: 6,
    });
    expect(s).toBe(
      "Of 1001 recorded versions, 990 were applied here and " +
        "5 were run here by an applier other than Mission Control, and " +
        "6 were recorded before this was written down.",
    );
  });

  it("speaks even when every row it cannot vouch for is external", () => {
    // `applied !== recorded`, so silence would read as "all executed here".
    const s = describeCoverage({
      recorded: 8,
      applied: 0,
      asserted: 0,
      external: 8,
      unclassified: 0,
    });
    expect(s).toContain("8 were run here by an applier other than Mission Control");
  });
});

describe("the rules this module exists to keep", () => {
  const pure = read("src/server/migrationProvenance.pure.ts");

  it("offers exactly three provenance values", () => {
    expect([...MIGRATION_PROVENANCE_VALUES]).toEqual(["applied", "asserted", "external"]);
  });

  it("produces 'asserted' only by exact membership, never from shape", () => {
    // The invariant, tested by behaviour rather than by reading the source:
    // mutate any listed name by one character at either end and it must stop
    // being an assertion. A prefix, suffix or keyword rule would survive this.
    for (const known of KNOWN_ASSERTION_NAMES) {
      expect(provenanceFromLedgerName(known, "20260101000000")).toBe("asserted");
      expect(provenanceFromLedgerName(known.slice(0, -1), "20260101000000")).toBeNull();
      expect(provenanceFromLedgerName(`${known}.`, "20260101000000")).toBeNull();
      expect(
        provenanceFromCanonicalRow({ name: known.slice(1), hasBody: false, hasLegacyRow: true }),
      ).toBeNull();
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
      // Either spelling of the union: the replay reads it through
      // `readCloneMigrationLedger`, which names each row too.
      const unions = src.match(
        /UNION\s+SELECT\s+version(?:\s*,\s*null::text\s+as\s+name)?\s+FROM\s+aurixa\.schema_migrations/gi,
      );
      expect(unions, `${file} should still union the legacy ledger`).not.toBeNull();
      // No reader of the applied-set may narrow it by provenance.
      expect(src).not.toMatch(/schema_migrations[\s\S]{0,200}provenance\s*=\s*'applied'/i);
    }
  });
});

describe("a reason outranks the stamp that let the lane see past it", () => {
  /*
    775 versions on npc-client-dashboard are in BOTH ledgers: the 2026-09-02
    reconciliation wrote a rationale into `aurixa.schema_migrations`, and the
    2026-09-12 repair stamped `aurixa-baseline` into
    `supabase_migrations.schema_migrations`. The backfill ran before those seven
    rationales were on KNOWN_ASSERTION_NAMES, so the canonical pass supplied the
    baseline for all 775 and `on conflict do nothing` meant the legacy pass
    could never replace it. 52 of them actually read `OWED: … Never replay this
    file onto a tenant` and 7 read `UNVERIFIED` — the distinction the operator
    needs, collapsed into the one word that does not carry it.
  */
  const server = readFileSync("src/server/migrationProvenance.server.ts", "utf8");
  // The clause itself, as the database will receive it — not the source that
  // composes it. `sqlLiteral` is what turns the constant into SQL, so reading
  // the source would assert about the template and not about the statement.
  const clause = upgradeNote();

  it("names the baseline once, and everything else imports it", () => {
    expect(BASELINE_ASSERTION_NAME).toBe("aurixa-baseline");
    expect(KNOWN_ASSERTION_NAMES[0]).toBe(BASELINE_ASSERTION_NAME);
    const pure = readFileSync("src/server/migrationProvenance.pure.ts", "utf8");
    const declarations = pure.match(/"aurixa-baseline"/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it("upgrades only a row this same inference wrote", () => {
    // `asserted`, noted with the baseline. An `applied` row is the lane's own
    // record of running a file and is never rewritten by a guess — which is
    // the ordering the whole module rests on.
    expect(clause).toContain("aurixa.migration_provenance.provenance = 'asserted'");
    expect(clause).toContain(`aurixa.migration_provenance.note = '${BASELINE_ASSERTION_NAME}'`);
    expect(clause).not.toMatch(/set\s+provenance\s*=/);
    expect(clause.toLowerCase()).toContain("do update set note = excluded.note");
  });

  it("never replaces a reason with the stamp", () => {
    // The upgrade is one-directional. Without this the two passes would take
    // turns overwriting each other on every lane run.
    expect(clause).toContain(`excluded.note <> '${BASELINE_ASSERTION_NAME}'`);
  });

  it("leaves the canonical pass exactly as it was", () => {
    // Only the legacy pass may upgrade. A canonical row is a stamp, and a
    // stamp has nothing more specific to offer a row that already exists.
    expect(server).toContain('[canonicalEntries, "do nothing"] as const');
  });

  it("counts an upgrade separately from a new record", () => {
    // An upsert's RETURNING cannot tell an insert from an update without
    // `xmax`, and a report that counts an upgrade as a new record is a number
    // nobody can act on.
    expect(server).toContain("(xmax = 0) as inserted");
    expect(server).toMatch(/upgraded\s*\+=\s*1/);
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

describe("the column accepts what the classifier says, and no more", () => {
  /*
    A clone whose table was made before `external` existed carries the
    two-value check, and every external row the backfill tried to write there
    would be refused. Run against Postgres 16 on 27 Oct 2026: on a table made by
    the previous DDL the statement widens the check and keeps its rows, still
    refuses a value off the list, and on a second pass (and on a fresh table)
    leaves the constraint's oid where it was.
  */
  const provisioning = read("src/server/backend-provisioning.server.ts");
  const list = MIGRATION_PROVENANCE_VALUES.map((v) => `'${v}'`).join(", ");

  it("checks the column against the classifier's own list", () => {
    const checks = PROVENANCE_TABLE_SQL.split(`check (provenance in (${list}))`).length - 1;
    // Once where the table is made, once where an older table is widened.
    expect(checks).toBe(2);
  });

  it("derives the list rather than restating it", () => {
    expect(provisioning).toContain("MIGRATION_PROVENANCE_VALUES.map");
    expect(provisioning).not.toMatch(/'applied',\s*'asserted'/);
  });

  it("widens only the default-named check, and only when a value is missing", () => {
    expect(PROVENANCE_TABLE_SQL).toContain("conname = 'migration_provenance_provenance_check'");
    for (const v of MIGRATION_PROVENANCE_VALUES) {
      expect(PROVENANCE_TABLE_SQL).toContain(`pg_get_constraintdef(oid) not like '%''${v}''%'`);
    }
    const guard = PROVENANCE_TABLE_SQL.indexOf("if exists (");
    const drop = PROVENANCE_TABLE_SQL.indexOf(
      "drop constraint migration_provenance_provenance_check",
    );
    expect(guard).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(guard);
    // Nothing else about the table is touched: no row is rewritten to fit.
    expect(PROVENANCE_TABLE_SQL).not.toMatch(/\b(update|delete from|truncate)\b/i);
  });
});
