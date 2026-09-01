import { describe, it, expect } from "vitest";
import {
  isReadOnlySourceQuery,
  assertReadOnlySourceQuery,
  toRows,
  chunk,
  isBenignDdlError,
  shouldRunAnotherFunctionPass,
  diffMissingColumns,
  buildAddColumnStatements,
  columnSignature,
  driftedTables,
  filterCreatableIndexes,
  isConstraintBacked,
  buildEnumDdl,
  buildCreateTableDdl,
  buildPolicyDdl,
  parsePgArray,
  reconcile,
  MAX_FUNCTION_PASSES,
  buildGrantDdl,
} from "./schema-introspection.server";

describe("read-only source-query assertion", () => {
  it("accepts catalog reads", () => {
    expect(isReadOnlySourceQuery("select * from pg_class")).toBe(true);
    expect(isReadOnlySourceQuery("  WITH x as (select 1) select * from x")).toBe(true);
    expect(isReadOnlySourceQuery("-- comment\nselect 1")).toBe(true);
  });

  it("refuses anything that is not a read", () => {
    expect(isReadOnlySourceQuery("insert into t values (1)")).toBe(false);
    expect(isReadOnlySourceQuery("update t set a = 1")).toBe(false);
    expect(isReadOnlySourceQuery("delete from t")).toBe(false);
    expect(isReadOnlySourceQuery("drop table t")).toBe(false);
    expect(isReadOnlySourceQuery("create table t (a int)")).toBe(false);
    expect(isReadOnlySourceQuery("truncate t")).toBe(false);
  });

  it("refuses a write dressed as a CTE", () => {
    expect(isReadOnlySourceQuery("with d as (delete from t returning *) select * from d")).toBe(
      false,
    );
    expect(() =>
      assertReadOnlySourceQuery("with d as (insert into t values (1)) select 1"),
    ).toThrow(/non-read-only/);
  });

  it("passes the query through when it is a read", () => {
    expect(assertReadOnlySourceQuery("select 1 as n")).toBe("select 1 as n");
  });
});

describe("toRows", () => {
  it("handles bare arrays and wrapped shapes", () => {
    expect(toRows([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(toRows({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(toRows({ result: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(toRows(null)).toEqual([]);
    expect(toRows({ nope: true })).toEqual([]);
  });
});

describe("chunk", () => {
  it("splits into fixed-size batches", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 60)).toEqual([]);
  });
});

describe("isBenignDdlError", () => {
  it("treats already-exists / duplicate as success", () => {
    expect(isBenignDdlError('relation "foo" already exists')).toBe(true);
    expect(isBenignDdlError("duplicate object")).toBe(true);
    expect(isBenignDdlError('column "x" of relation "y" does not exist')).toBe(false);
  });

  it("treats a re-added primary key as success, because that is what it is", () => {
    /* The tables stage creates a table with its key inline, so the constraints
       stage re-adds one Postgres already has — and says so with this wording
       rather than "already exists". 200 of the dry run's recorded constraint
       failures came from five tables this way, and the operator's sample is
       capped at twenty, so noise does not dilute the signal, it evicts it. */
    expect(
      isBenignDdlError('multiple primary keys for table "report_versions" are not allowed'),
    ).toBe(true);
  });

  it("still reports a genuinely missing dependency", () => {
    /* The failure that mattered on the dry run — one absent extension behind
       6 tables, 337 columns and 28 functions — must never be filtered away. */
    expect(isBenignDdlError('type "vector" does not exist')).toBe(false);
    expect(isBenignDdlError('relation "public.market_updates" does not exist')).toBe(false);
    expect(isBenignDdlError("cannot use column reference in DEFAULT expression")).toBe(false);
  });
});

describe("function convergence stop condition", () => {
  it("runs a first pass with no history", () => {
    expect(shouldRunAnotherFunctionPass([])).toBe(true);
  });

  it("keeps going while failures are falling", () => {
    expect(shouldRunAnotherFunctionPass([12])).toBe(true);
    expect(shouldRunAnotherFunctionPass([12, 1])).toBe(true);
  });

  it("stops once failures reach zero", () => {
    expect(shouldRunAnotherFunctionPass([12, 1, 0])).toBe(false);
  });

  it("stops when the failure count stops falling", () => {
    expect(shouldRunAnotherFunctionPass([5, 5])).toBe(false);
    expect(shouldRunAnotherFunctionPass([5, 7])).toBe(false);
  });

  it("caps the passes so a genuine error cannot loop", () => {
    const stuck = Array.from({ length: MAX_FUNCTION_PASSES }, (_, i) => 100 - i);
    expect(shouldRunAnotherFunctionPass(stuck)).toBe(false);
  });
});

describe("column drift detector", () => {
  const prime = [
    { table: "public.a", column: "id", type: "uuid" },
    { table: "public.a", column: "name", type: "text" },
    { table: "public.b", column: "id", type: "uuid" },
  ];

  it("finds columns the clone is missing", () => {
    const missing = diffMissingColumns(prime, [{ table: "public.a", column: "id", type: "uuid" }]);
    expect(missing.map((c) => `${c.table}.${c.column}`)).toEqual(["public.a.name", "public.b.id"]);
  });

  it("emits idempotent add-column repairs", () => {
    expect(buildAddColumnStatements([{ table: "public.a", column: "name", type: "text" }])).toEqual(
      ["alter table public.a add column if not exists name text"],
    );
  });

  it("detects type drift via the hashed signature even when counts match", () => {
    const clone = [
      { table: "public.a", column: "id", type: "uuid" },
      { table: "public.a", column: "name", type: "integer" },
      { table: "public.b", column: "id", type: "uuid" },
    ];
    expect(diffMissingColumns(prime, clone)).toEqual([]);
    expect(driftedTables(columnSignature(prime), columnSignature(clone))).toEqual(["public.a"]);
  });

  it("reports no drift for identical schemas regardless of column order", () => {
    const shuffled = [prime[2], prime[1], prime[0]];
    expect(driftedTables(columnSignature(prime), columnSignature(shuffled))).toEqual([]);
  });
});

describe("constraint-backed index filter", () => {
  const indexes = [
    { indexname: "a_pkey", indexdef: "CREATE UNIQUE INDEX a_pkey ON public.a USING btree (id)" },
    { indexname: "a_name_idx", indexdef: "CREATE INDEX a_name_idx ON public.a USING btree (name)" },
  ];

  it("skips indexes the constraints stage already created", () => {
    const names = new Set(["a_pkey"]);
    expect(isConstraintBacked("a_pkey", names)).toBe(true);
    expect(filterCreatableIndexes(indexes, names)).toEqual([indexes[1].indexdef]);
  });

  it("keeps everything when no constraint owns an index", () => {
    expect(filterCreatableIndexes(indexes, new Set())).toHaveLength(2);
  });
});

describe("DDL builders", () => {
  it("builds an idempotent enum type", () => {
    const sql = buildEnumDdl("public", "app_role", ["admin", "it's"]);
    expect(sql).toContain(`create type "public"."app_role" as enum ('admin', 'it''s')`);
    expect(sql).toContain("duplicate_object");
  });

  it("builds a create-table statement with defaults and not-null", () => {
    const sql = buildCreateTableDdl("aml", "cases", [
      { name: "id", type: "uuid", notNull: true, default: "gen_random_uuid()" },
      { name: "note", type: "text", notNull: false, default: null },
    ]);
    expect(sql).toContain(`create table if not exists "aml"."cases"`);
    expect(sql).toContain(`"id" uuid default gen_random_uuid() not null`);
    expect(sql).toContain(`"note" text`);
  });

  it("builds a policy with roles, using and with check", () => {
    const sql = buildPolicyDdl({
      schemaname: "public",
      tablename: "notes",
      policyname: "own notes",
      permissive: "PERMISSIVE",
      roles: "{authenticated}",
      cmd: "SELECT",
      qual: "(user_id = auth.uid())",
      with_check: null,
    });
    expect(sql).toBe(
      `create policy "own notes" on "public"."notes" as permissive for select to "authenticated" using ((user_id = auth.uid()))`,
    );
  });

  it("parses postgres array literals", () => {
    expect(parsePgArray("{a,b}")).toEqual(["a", "b"]);
    expect(parsePgArray("{}")).toEqual([]);
    expect(parsePgArray(["a"])).toEqual(["a"]);
  });
});

describe("reconcile", () => {
  it("fails a stage when the clone is short", () => {
    expect(reconcile(641, 528)).toBe(false);
    expect(reconcile(641, 641)).toBe(true);
    expect(reconcile(641, 642)).toBe(true);
  });
});

describe("identity columns", () => {
  it("declares generated identity instead of a default", () => {
    const sql = buildCreateTableDdl("public", "t", [
      { name: "id", type: "bigint", notNull: true, default: null, identity: "a" },
      { name: "n", type: "integer", notNull: false, default: "0", identity: "" },
    ]);
    expect(sql).toContain(`"id" bigint generated always as identity not null`);
    expect(sql).toContain(`"n" integer default 0`);
  });

  it("uses by-default identity for attidentity 'd'", () => {
    const sql = buildCreateTableDdl("public", "t", [
      { name: "id", type: "integer", notNull: true, default: null, identity: "d" },
    ]);
    expect(sql).toContain("generated by default as identity");
  });
});

describe("buildGrantDdl", () => {
  it("emits a quoted grant per privilege and role", () => {
    expect(buildGrantDdl("public", "notes", "authenticated", "SELECT")).toBe(
      `grant select on "public"."notes" to "authenticated"`,
    );
  });
});

describe("view convergence", () => {
  it("stops once failures stop falling, within the pass cap", () => {
    expect(shouldRunAnotherFunctionPass([], 3)).toBe(true);
    expect(shouldRunAnotherFunctionPass([4], 3)).toBe(true);
    expect(shouldRunAnotherFunctionPass([4, 2], 3)).toBe(true);
    expect(shouldRunAnotherFunctionPass([4, 2, 2], 3)).toBe(false);
    expect(shouldRunAnotherFunctionPass([0], 3)).toBe(false);
  });
});
