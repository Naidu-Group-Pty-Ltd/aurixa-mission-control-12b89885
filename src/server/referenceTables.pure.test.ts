import { describe, it, expect } from "vitest";
import {
  REFERENCE_TABLES,
  isReferenceTable,
  isIdentityCandidate,
  planColumns,
  referenceTable,
  tablesToReopen,
  type ReferenceTable,
  refName,
} from "./referenceTables.pure";

const entry = (table: string): ReferenceTable => {
  const e = referenceTable(table);
  if (!e) throw new Error(`${table} is not on the allow-list`);
  return e;
};

describe("the allow-list", () => {
  it("is an allow-list: an unnamed table is never copyable", () => {
    expect(isReferenceTable("suburb_directory")).toBe(true);
    expect(isReferenceTable("a_table_invented_after_this_was_written")).toBe(false);
  });

  /**
   * The negative assertion is the important one. These are real tables on the
   * prime, holding real customer data, sitting alphabetically beside the ones
   * that ARE copied. A deny-list would have to name all of them; this test
   * exists to fail loudly if one is ever added to the allow-list by mistake.
   */
  it.each([
    ["email_copilot_emails", "5,350 real client emails, 64 MB"],
    ["email_copilot_email_addresses", "14,925 real email addresses"],
    ["report_versions", "1,857 generated client reports, 91 MB"],
    ["ghl_conversation_messages", "11,335 CRM conversation messages"],
    ["listing_images", "9,089 listing photographs"],
    ["clients", "the customer list itself"],
    ["client_notes", "notes written about customers"],
    ["client_files", "customer documents"],
    ["document_chunks", "indexed customer document text"],
    ["api_usage_log", "per-tenant billing records"],
    ["security_events", "the prime's own security log"],
    ["activity_logs", "who did what on the prime"],
    ["custom_users", "the prime's user accounts"],
    ["notifications", "messages addressed to prime staff"],
  ])("never allows %s (%s)", (table) => {
    expect(isReferenceTable(table)).toBe(false);
  });

  it("excludes report_templates and its versions — prime-authored, not the catalogue", () => {
    // 258 MB between them and 5 rows carrying a populated owner_user_id. The
    // seeded catalogue is template_library_entries, which is allowed.
    expect(isReferenceTable("report_templates")).toBe(false);
    expect(isReferenceTable("report_template_versions")).toBe(false);
    expect(isReferenceTable("template_library_entries")).toBe(true);
  });

  it("excludes stamp_duty_rates_cache — a cache carries somebody else's fetch time", () => {
    expect(isReferenceTable("stamp_duty_rates_cache")).toBe(false);
  });

  it("gives every entry a reason, because the reason is the review", () => {
    for (const t of REFERENCE_TABLES) {
      expect(t.reason.length, `${t.table} has no reason`).toBeGreaterThan(30);
    }
  });

  it("gives every classified column a reason too", () => {
    for (const t of REFERENCE_TABLES) {
      for (const [col, c] of Object.entries(t.columns)) {
        expect(c.reason.length, `${t.table}.${col} has no reason`).toBeGreaterThan(20);
      }
    }
  });

  it("declares a page size for every entry, and never an unbounded one", () => {
    for (const t of REFERENCE_TABLES) {
      expect(t.rowsPerPage, t.table).toBeGreaterThan(0);
      expect(t.rowsPerPage, t.table).toBeLessThanOrEqual(5000);
    }
  });

  it("names no table twice", () => {
    const names = REFERENCE_TABLES.map((t) => t.table);
    expect(new Set(names).size).toBe(names.length);
  });

  it("puts parents before children, because the copier walks the array as written", () => {
    const order = REFERENCE_TABLES.map((t) => t.table);
    expect(order.indexOf("checklist_templates")).toBeLessThan(
      order.indexOf("checklist_template_sections"),
    );
    expect(order.indexOf("checklist_template_sections")).toBeLessThan(
      order.indexOf("checklist_template_items"),
    );
    // aml.tenant_settings → aml.plan_tiers and aml.provider_configs →
    // aml.tenant_settings are real foreign keys; the register ledgers must
    // land before the entries that reference them.
    expect(order.indexOf("plan_tiers")).toBeLessThan(order.indexOf("tenant_settings"));
    expect(order.indexOf("tenant_settings")).toBeLessThan(order.indexOf("provider_configs"));
    expect(order.indexOf("sanctions_list_syncs")).toBeLessThan(order.indexOf("sanctions_entries"));
    expect(order.indexOf("pep_officeholder_syncs")).toBeLessThan(order.indexOf("pep_officeholders"));
  });
});

describe("the aml entries", () => {
  it("qualifies every aml entry's name and leaves public names bare", () => {
    for (const t of REFERENCE_TABLES) {
      expect(refName(t)).toBe(t.schema ? `aml.${t.table}` : t.table);
    }
    const names = REFERENCE_TABLES.map(refName);
    expect(names).toContain("aml.provider_configs");
    expect(names).toContain("aml.sanctions_entries");
    expect(names).toContain("feature_flags");
  });

  it("still refuses the tenant tables that sit beside the programme config", () => {
    // Case data, screenings, decisions and reports are a TENANT's records; the
    // allow-list must never grow them. Named so a future entry fails loudly.
    for (const denied of [
      "cases",
      "case_events",
      "screening_checks",
      "verification_checks",
      "decisions",
      "reports",
      "reliance_grants",
      "pep_determinations",
      "risk_assessments",
    ]) {
      expect(isReferenceTable(denied), denied).toBe(false);
      expect(isReferenceTable(`aml.${denied}`), `aml.${denied}`).toBe(false);
    }
  });

  it("keeps the deployment key and nulls every person-shaped field on tenant_settings", () => {
    const ts = REFERENCE_TABLES.find((t) => refName(t) === "aml.tenant_settings")!;
    expect(ts.columns.tenant_id?.policy).toBe("keep");
    for (const c of ["contact_email", "mlro_contact_email", "mlro_contact_name", "brand_kit_id"]) {
      expect(ts.columns[c]?.policy, c).toBe("null_on_copy");
    }
  });

  it("nulls the prime's own provider-health reading", () => {
    const pc = REFERENCE_TABLES.find((t) => refName(t) === "aml.provider_configs")!;
    for (const c of ["last_health_at", "last_health_status", "last_health_message"]) {
      expect(pc.columns[c]?.policy, c).toBe("null_on_copy");
    }
  });
});

describe("isIdentityCandidate", () => {
  it.each([
    "user_id",
    "owner_user_id",
    "created_by",
    "updated_by",
    "locked_by",
    "client_id",
    "tenant_id",
    "agency_id",
    "created_by_user_id",
    "account_id",
    "assigned_to",
    "customer_email",
    "author",
    "profile_id",
    "org_id",
    "broker_id",
    "partner_id",
  ])("flags %s", (col) => {
    expect(isIdentityCandidate(col)).toBe(true);
  });

  it.each(["id", "suburb", "state", "postcode", "created_at", "display_order", "page_plan", "title"])(
    "does not flag %s",
    (col) => {
      expect(isIdentityCandidate(col)).toBe(false);
    },
  );
});

describe("planColumns — the guard that reads the live schema", () => {
  it("copies the plain columns and nulls the classified identities", () => {
    const plan = planColumns(entry("template_library_entries"), [
      "id",
      "name",
      "created_by_user_id",
      "agency_id",
      "source_template_id",
      "page_plan",
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.copy).toEqual(["id", "name", "page_plan"]);
    expect(plan.nulled).toEqual(["created_by_user_id", "agency_id", "source_template_id"]);
  });

  it("keeps a column classified `keep` — a role is not a person", () => {
    const plan = planColumns(entry("document_requirement_templates"), [
      "id",
      "label",
      "default_owner",
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.copy).toContain("default_owner");
    expect(plan.nulled).toEqual([]);
  });

  /**
   * The case this whole module exists for. The allow-list is configuration and
   * configuration goes stale; the prime's schema is free to change without
   * anybody remembering this file. So the refusal is driven by the LIVE column
   * list, not by what was true at review time.
   */
  it("REFUSES when the prime has gained an unclassified identity column", () => {
    const plan = planColumns(entry("suburb_directory"), [
      "id",
      "suburb",
      "state",
      "postcode",
      "created_at",
      "owner_user_id", // added to the prime after this entry was written
    ]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toContain("owner_user_id");
    expect(plan.refusal).toMatch(/Refusing to copy/);
    expect(plan.refusal).toMatch(/referenceTables\.pure\.ts/);
  });

  it("REFUSES when a classified column no longer exists — a rename must not read as reviewed", () => {
    const plan = planColumns(entry("depreciation_comps"), ["id", "suburb", "amount"]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toContain("created_by");
    expect(plan.refusal).toMatch(/no longer has/);
  });

  it("names every offending column, not just the first", () => {
    const plan = planColumns(entry("suburb_directory"), [
      "id",
      "suburb",
      "owner_user_id",
      "client_id",
    ]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toContain("owner_user_id");
    expect(plan.refusal).toContain("client_id");
  });

  it("passes a table whose live schema matches exactly what was classified", () => {
    const plan = planColumns(entry("suburb_directory"), [
      "id",
      "suburb",
      "state",
      "postcode",
      "created_at",
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.nulled).toEqual([]);
    expect(plan.copy).toHaveLength(5);
  });
});

/**
 * The conflict key is the NATURAL key, never the surrogate id.
 *
 * `on conflict (<conflictKey>) do nothing` exists so a row a tenant already
 * holds is left alone. Naming `id` breaks that in the one case it was written
 * for: a catalogue row seeded on both sides by the same migration gets a fresh
 * uuid on each, so the ids differ by construction and the insert conflicts on
 * the table's OTHER unique constraint instead — which `on conflict (id)` does
 * not catch, and which fails the whole page.
 *
 * Measured 19 Sep 2026 on `npc-client-dashboard`: `aml.retention_schedules`
 * at 0 of 35, `Key (entity_type)=(manual_screening_check) already exists`.
 * The same table copied cleanly on two other clones, because whether it works
 * depends on which of the clone's own migration and this copy reached the row
 * first.
 *
 * Pinned as DATA, read from the prime's own schema, because this file cannot
 * see that schema: each entry below was checked against the `CREATE TABLE` in
 * the prime's migrations.
 */
describe("a table with a natural unique key conflicts on it", () => {
  /** schema.table → the unique constraint in the prime's own DDL. */
  const NATURAL_KEYS: Record<string, string[]> = {
    "aml.provider_configs": ["tenant_id", "capability", "provider_key"],
    "aml.risk_factors": ["key"],
    "aml.mandatory_triggers": ["key"],
    "aml.retention_schedules": ["entity_type"],
    "aml.sanctions_entries": ["list_code", "external_id"],
    "aml.pep_officeholders": ["source_code", "external_id"],
  };

  for (const [qualified, key] of Object.entries(NATURAL_KEYS)) {
    it(`${qualified} conflicts on ${key.join(", ")}`, () => {
      const [schema, table] = qualified.split(".");
      const entry = REFERENCE_TABLES.find((e) => e.table === table && e.schema === schema);
      expect(entry, `${qualified} is no longer a reference table`).toBeDefined();
      expect(entry!.conflictKey).toEqual(key);
    });
  }

  it("never names a column the copy nulls", () => {
    // NULLs are distinct in a unique index, so a nulled column in the conflict
    // target means the target never matches and every re-run raises 23505
    // again. `provider_configs.tenant_id` is `keep` for exactly this reason.
    for (const entry of REFERENCE_TABLES) {
      for (const col of entry.conflictKey) {
        expect(
          entry.columns?.[col]?.policy,
          `${entry.schema}.${entry.table} conflicts on ${col}, which is nulled on copy`,
        ).not.toBe("null_on_copy");
      }
    }
  });

  it("leaves the surrogate id where the table has no natural key", () => {
    // Not every table has one. These four are keyed on `id` correctly, and a
    // sweep that "fixed" them would be inventing a uniqueness the schema does
    // not declare.
    for (const table of [
      "monitoring_rules",
      "tipping_off_rules",
      "sanctions_list_syncs",
      "pep_officeholder_syncs",
    ]) {
      const entry = REFERENCE_TABLES.find((e) => e.table === table);
      expect(entry, `${table} is no longer a reference table`).toBeDefined();
      expect(entry!.conflictKey).toEqual(["id"]);
    }
  });
});

/**
 * The FOREIGN-KEY edges among allow-listed tables, pinned as data.
 *
 * Each entry is (child, parent, the child column that creates the edge). The
 * column is checked against the prime's live snapshot in
 * `referenceTablesLiveSchema.test.ts`; here the shape of the graph is checked,
 * which is what `tablesToReopen` walks.
 *
 * Written down rather than derived, for the reason the module's own conflict
 * keys are: this file cannot see constraints, and a graph that quietly loses
 * an edge re-opens nothing and looks exactly like a graph that works.
 */
const EDGES: ReadonlyArray<readonly [child: string, parent: string, column: string]> = [
  ["checklist_template_sections", "checklist_templates", "template_id"],
  ["checklist_template_items", "checklist_template_sections", "section_id"],
  ["aml.sanctions_entries", "aml.sanctions_list_syncs", "sync_id"],
  ["aml.pep_officeholders", "aml.pep_officeholder_syncs", "sync_id"],
];

describe("the dependency graph the re-walk reads", () => {
  it("declares exactly the edges pinned above, and no others", () => {
    const declared = REFERENCE_TABLES.flatMap((t) =>
      (t.dependsOn ?? []).map((p) => `${refName(t)} -> ${p}`),
    ).sort();
    expect(declared).toEqual(EDGES.map(([c, p]) => `${c} -> ${p}`).sort());
  });

  it("names only allow-listed parents — an unknown name re-opens nothing, silently", () => {
    const known = new Set(REFERENCE_TABLES.map(refName));
    for (const t of REFERENCE_TABLES) {
      for (const parent of t.dependsOn ?? []) {
        expect(known, `${refName(t)} depends on an unknown table`).toContain(parent);
      }
    }
  });

  /*
    The array's ORDER is the within-a-pass half of the same rule, and the
    module's own comment calls it load-bearing. If the two ever disagree, one
    of them is wrong and the copy inserts a child before its parent on the
    FIRST pass — which no amount of re-walking later can repair.
  */
  it("agrees with the array order: a parent is always written earlier", () => {
    const index = new Map(REFERENCE_TABLES.map((t, i) => [refName(t), i]));
    for (const t of REFERENCE_TABLES) {
      for (const parent of t.dependsOn ?? []) {
        const msg = `${parent} must be listed before ${refName(t)}`;
        expect(index.get(parent)!, msg).toBeLessThan(index.get(refName(t))!);
      }
    }
  });
});

describe("tablesToReopen", () => {
  const all = REFERENCE_TABLES.map(refName);
  /** Every table complete — the steady state a healthy clone sits in. */
  const allComplete = () => new Map(all.map((n) => [n, "complete"]));

  it("re-opens nothing when everything has finished", () => {
    expect([...tablesToReopen(allComplete())]).toEqual([]);
  });

  it("re-opens the parent of a child that has not finished", () => {
    // The measured case: the register's ledger finished, the register did not.
    const state = allComplete();
    state.set("aml.sanctions_entries", "failed");
    expect([...tablesToReopen(state)]).toEqual(["aml.sanctions_list_syncs"]);
  });

  it.each(["copying", "in_progress", "failed", undefined])(
    "treats %s as unfinished — only complete and skipped are finished",
    (status) => {
      const state = allComplete();
      if (status === undefined) state.delete("aml.sanctions_entries");
      else state.set("aml.sanctions_entries", status);
      expect([...tablesToReopen(state)]).toContain("aml.sanctions_list_syncs");
    },
  );

  it("follows the chain to a fixed point rather than stopping one level up", () => {
    // items -> sections -> templates. Re-opening sections makes IT unfinished,
    // which must re-open templates; a single sweep would leave templates
    // frozen and the same 23503 one link further along.
    const state = allComplete();
    state.set("checklist_template_items", "copying");
    const out = tablesToReopen(state);
    expect(out).toContain("checklist_template_sections");
    expect(out).toContain("checklist_templates");
  });

  it("does not re-open a skipped parent — that is a migration question", () => {
    const state = allComplete();
    state.set("aml.sanctions_list_syncs", "skipped");
    state.set("aml.sanctions_entries", "failed");
    expect([...tablesToReopen(state)]).toEqual([]);
  });

  it("a finished child holds nothing open", () => {
    const state = allComplete();
    state.set("suburb_directory", "copying");
    // An unfinished table with no dependants re-opens nothing.
    expect([...tablesToReopen(state)]).toEqual([]);
  });
});
