import { describe, expect, it } from "vitest";
import {
  extractCreatedObjects,
  qualify,
  reconcileMigration,
  stripSqlNoise,
  summarise,
} from "./primeLedgerReconciliation.pure";

describe("extractCreatedObjects", () => {
  it("finds the definition that started all this", () => {
    // Verbatim shape of 20261012000000_builder_stock_auto_source_drain.sql,
    // the migration the prime ran and its ledger does not record.
    const sql = `
      CREATE OR REPLACE FUNCTION public.ensure_builder_stock_settlement_scheduled()
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = public, pg_temp
      AS $$
      BEGIN
        PERFORM cron.schedule('x', '* * * * *', $job$SELECT 1;$job$);
        RETURN true;
      END;
      $$;
    `;
    expect(extractCreatedObjects(sql)).toEqual([
      { kind: "function", qualified: "public.ensure_builder_stock_settlement_scheduled" },
    ]);
  });

  it("does not count a CREATE that appears inside a function body", () => {
    // A body routinely mentions CREATE. Attributing a caller's mention to the
    // file as though it were a definition would produce `satisfied` for a
    // migration that creates nothing.
    const sql = `
      CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        EXECUTE 'CREATE TABLE public.not_really_created (id int)';
      END;
      $$;
    `;
    expect(extractCreatedObjects(sql).map((o) => o.qualified)).toEqual(["public.f"]);
  });

  it("ignores commented-out DDL", () => {
    const sql = `
      -- CREATE TABLE public.ghost (id int);
      /* CREATE TABLE public.spectre (id int); */
      CREATE TABLE IF NOT EXISTS public.real_one (id int);
    `;
    expect(extractCreatedObjects(sql).map((o) => o.qualified)).toEqual(["public.real_one"]);
  });

  it("reads tables, types, views, indexes and sequences", () => {
    const sql = `
      CREATE TABLE public.a (id int);
      CREATE TYPE public.mood AS ENUM ('ok');
      CREATE MATERIALIZED VIEW public.v AS SELECT 1;
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_a ON public.a (id);
      CREATE SEQUENCE public.s;
    `;
    const got = extractCreatedObjects(sql);
    expect(got.map((o) => `${o.kind}:${o.qualified}`).sort()).toEqual([
      "index:public.idx_a",
      "sequence:public.s",
      "table:public.a",
      "type:public.mood",
      "view:public.v",
    ]);
  });

  it("assumes public for an unqualified name and normalises quoting", () => {
    expect(qualify('"Public"."Thing"', "table")).toBe("public.thing");
    expect(qualify("thing", "table")).toBe("public.thing");
  });

  it("strips dollar-quoted bodies whatever the tag", () => {
    expect(stripSqlNoise("a $job$ CREATE TABLE x $job$ b")).not.toContain("CREATE TABLE");
  });
});

describe("reconcileMigration — evidence, never permission", () => {
  const meta = { id: "20261012000000", name: "builder_stock_auto_source_drain.sql" };
  const sql = "CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE sql AS 'select 1';";

  it("says satisfied when the prime already has everything it creates", () => {
    const r = reconcileMigration(meta, sql, new Set(["function:public.f"]));
    expect(r.verdict).toBe("satisfied");
    expect(r.missing).toEqual([]);
  });

  it("says unsatisfied, and names what is absent", () => {
    const r = reconcileMigration(meta, sql, new Set());
    expect(r.verdict).toBe("unsatisfied");
    expect(r.missing.map((m) => m.qualified)).toEqual(["public.f"]);
  });

  it("never calls a migration that creates nothing `satisfied`", () => {
    // The rule that keeps this honest. A pure-ALTER migration and a rollback
    // script look identical to this test, and one of those must never be
    // stamped. "Found nothing to check" is not "checked and found everything".
    const r = reconcileMigration(meta, "ALTER TABLE public.a ADD COLUMN b int;", new Set());
    expect(r.verdict).toBe("indeterminate");
    expect(r.creates).toEqual([]);

    const rollback = reconcileMigration(
      meta,
      "DROP POLICY IF EXISTS p ON public.client_files; CREATE POLICY p ON public.client_files USING (true);",
      new Set(),
    );
    // CREATE POLICY is deliberately not extracted — a policy is not an object
    // whose presence proves the file ran, and the two rollback scripts in this
    // corpus are exactly policy rewrites.
    expect(rollback.verdict).toBe("indeterminate");
  });

  it("one missing object is enough to withhold the whole migration", () => {
    const two = "CREATE TABLE public.a (id int); CREATE TABLE public.b (id int);";
    const r = reconcileMigration(meta, two, new Set(["table:public.a"]));
    expect(r.verdict).toBe("unsatisfied");
    expect(r.missing.map((m) => m.qualified)).toEqual(["public.b"]);
  });
});

describe("summarise", () => {
  it("counts the three verdicts separately", () => {
    const rows = [
      reconcileMigration(
        { id: "1", name: "a" },
        "CREATE TABLE public.a (id int);",
        new Set(["table:public.a"]),
      ),
      reconcileMigration({ id: "2", name: "b" }, "CREATE TABLE public.b (id int);", new Set()),
      reconcileMigration(
        { id: "3", name: "c" },
        "ALTER TABLE public.a ADD COLUMN z int;",
        new Set(),
      ),
    ];
    expect(summarise(rows)).toEqual({ satisfied: 1, unsatisfied: 1, indeterminate: 1 });
  });
});
