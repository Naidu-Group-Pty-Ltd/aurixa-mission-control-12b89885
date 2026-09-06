import { describe, it, expect } from "vitest";
import {
  REFERENCE_TABLES,
  isReferenceTable,
  isIdentityCandidate,
  planColumns,
  referenceTable,
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
