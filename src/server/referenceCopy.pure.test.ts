import { describe, it, expect } from "vitest";
import {
  buildPageQuery,
  buildInsertStatement,
  buildCountQuery,
  buildColumnsQuery,
  buildTableExistsQuery,
  sqlLiteral,
  quoteIdent,
} from "./referenceCopy.pure";
import { referenceTable, type ReferenceTable } from "./referenceTables.pure";

const suburbs = referenceTable("suburb_directory") as ReferenceTable;
const library = referenceTable("template_library_entries") as ReferenceTable;

describe("escaping", () => {
  it("doubles a quote in a literal", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("survives a value that tries to close the statement", () => {
    expect(sqlLiteral("'; drop table clones; --")).toBe("'''; drop table clones; --'");
  });

  it("quotes an identifier that would otherwise be a keyword", () => {
    expect(quoteIdent("order")).toBe('"order"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});

describe("buildPageQuery", () => {
  it("reads the first page with no cursor predicate", () => {
    const sql = buildPageQuery(suburbs, [], null, 2000);
    expect(sql).toContain('from public."suburb_directory" t');
    expect(sql).toContain('order by "id"::text asc limit 2000');
    expect(sql).not.toContain("where");
  });

  it("pages by keyset, never by OFFSET", () => {
    const sql = buildPageQuery(suburbs, [], "abc", 2000);
    expect(sql).toContain(`"id"::text > 'abc'`);
    expect(sql).not.toMatch(/offset/i);
  });

  /**
   * The load-bearing assertion of the whole feature. Identity columns are
   * stripped in the SELECT, on the prime — so the value is never read, not
   * merely never written. "The clone never receives it" and "it was never read"
   * are different guarantees and only the second one is true here.
   */
  it("strips identity columns ON THE PRIME, inside the select", () => {
    const sql = buildPageQuery(library, ["created_by_user_id", "agency_id"], null, 20);
    expect(sql).toContain(
      `to_jsonb(t) - ARRAY['created_by_user_id', 'agency_id']::text[] as __row`,
    );
    // and the strip is part of the read, not a later step
    expect(sql.indexOf("- ARRAY[")).toBeLessThan(sql.indexOf("from public."));
  });

  it("omits the strip entirely when nothing is nulled", () => {
    expect(buildPageQuery(suburbs, [], null, 10)).not.toContain("ARRAY[");
  });

  it("ANDs a row filter with the cursor rather than replacing it", () => {
    const filtered: ReferenceTable = { ...suburbs, where: "is_seeded = true" };
    const sql = buildPageQuery(filtered, [], "xyz", 10);
    expect(sql).toContain("(is_seeded = true)");
    expect(sql).toContain(`"id"::text > 'xyz'`);
    expect(sql).toContain(" and ");
  });

  it("applies a row filter on the first page too, when there is no cursor yet", () => {
    const filtered: ReferenceTable = { ...suburbs, where: "is_seeded = true" };
    const sql = buildPageQuery(filtered, [], null, 10);
    expect(sql).toContain("where (is_seeded = true)");
  });

  it("orders by the same expression it compares the cursor against", () => {
    // If the ORDER BY and the cursor predicate disagree on the cast, paging
    // silently skips or repeats rows at every boundary.
    const sql = buildPageQuery(suburbs, [], "k", 10);
    const cmp = sql.match(/"id"::text > /);
    const ord = sql.match(/order by "id"::text asc/);
    expect(cmp).toBeTruthy();
    expect(ord).toBeTruthy();
  });
});

describe("buildInsertStatement", () => {
  it("casts through the table's own record type rather than rendering literals", () => {
    const sql = buildInsertStatement(suburbs, '[{"id":"1","suburb":"Perth"}]');
    expect(sql).toContain(
      `jsonb_populate_recordset(null::public."suburb_directory", '[{"id":"1","suburb":"Perth"}]'::jsonb)`,
    );
  });

  it("is idempotent by conflict target and never overwrites a tenant's edit", () => {
    const sql = buildInsertStatement(suburbs, "[]");
    expect(sql).toContain(`on conflict ("id") do nothing`);
    expect(sql).not.toMatch(/do update/i);
  });

  it("escapes a quote inside the JSON payload", () => {
    const sql = buildInsertStatement(suburbs, `[{"suburb":"O'Connor"}]`);
    expect(sql).toContain(`'[{"suburb":"O''Connor"}]'::jsonb`);
  });

  it("handles a composite conflict target", () => {
    const composite: ReferenceTable = { ...suburbs, conflictKey: ["clone_id", "table_name"] };
    expect(buildInsertStatement(composite, "[]")).toContain(
      `on conflict ("clone_id", "table_name")`,
    );
  });
});

describe("the small queries", () => {
  it("counts through the same row filter the copy uses", () => {
    const filtered: ReferenceTable = { ...suburbs, where: "is_seeded = true" };
    expect(buildCountQuery(filtered)).toContain("where is_seeded = true");
    expect(buildCountQuery(suburbs)).not.toContain("where");
  });

  it("asks information_schema for the live column list, in the entry's schema", () => {
    const sql = buildColumnsQuery({ ...suburbs, table: "template_library_entries" });
    expect(sql).toContain("information_schema.columns");
    expect(sql).toContain("table_schema = 'public'");
    expect(sql).toContain("'template_library_entries'");
    expect(sql).toContain("order by ordinal_position");
    expect(buildColumnsQuery({ ...suburbs, table: "risk_factors", schema: "aml" })).toContain(
      "table_schema = 'aml'",
    );
  });

  it("asks whether the clone has the table by effect, via to_regclass", () => {
    expect(buildTableExistsQuery(suburbs)).toContain(
      `to_regclass('public.suburb_directory') is not null`,
    );
    expect(buildTableExistsQuery({ ...suburbs, table: "sanctions_entries", schema: "aml" })).toContain(
      `to_regclass('aml.sanctions_entries') is not null`,
    );
  });
});

describe("a table outside public", () => {
  const amlTable: ReferenceTable = {
    table: "provider_configs",
    schema: "aml",
    pageKey: "id",
    conflictKey: ["id"],
    rowsPerPage: 50,
    columns: {},
    reason: "test",
  };

  it("reads, counts and writes through the qualified name", () => {
    expect(buildPageQuery(amlTable, [], null, 10)).toContain('from aml."provider_configs" t');
    expect(buildCountQuery(amlTable)).toContain('from aml."provider_configs" t');
    const insert = buildInsertStatement(amlTable, "[]");
    expect(insert).toContain('insert into aml."provider_configs"');
    expect(insert).toContain('null::aml."provider_configs"');
  });
});
