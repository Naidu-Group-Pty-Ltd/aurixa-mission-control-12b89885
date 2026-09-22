import { describe, it, expect } from "vitest";
import {
  dependencyFactsOf,
  stripUnresolved,
  canonicalObjectName,
  NO_DEPENDENCY_FACTS,
} from "./migrationDependencyFacts.pure";

describe("stripUnresolved", () => {
  it("keeps the source's length, so nothing downstream shifts", () => {
    const src = "create table t();\n-- a comment\n/* block */ select 1;\n";
    expect(stripUnresolved(src)).toHaveLength(src.length);
  });

  it("blanks a line comment, a nesting block comment, a literal and a dollar body", () => {
    const out = stripUnresolved(
      [
        "-- create table commented_out (id int);",
        "/* outer /* inner */ create table nested (id int); */",
        "select 'create table in_a_string (id int)';",
        "$fn$ create table in_a_body (id int); $fn$",
      ].join("\n"),
    );
    expect(out).not.toMatch(/commented_out|nested|in_a_string|in_a_body/);
  });

  it("does not read a -- inside a string as a comment", () => {
    // If the `--` were taken as a comment, everything after it on the line
    // would be blanked and the CREATE below would vanish with it.
    const sql = "select 'a -- b'; create table kept (id int);";
    expect(dependencyFactsOf(sql).creates).toContain("kept");
  });

  it("does not read a quote inside a dollar body as a string", () => {
    const sql = "$$ it's fine $$; create table kept (id int);";
    expect(dependencyFactsOf(sql).creates).toContain("kept");
  });
});

describe("canonicalObjectName", () => {
  it("unquotes, lower-cases and drops a leading public", () => {
    expect(canonicalObjectName('PUBLIC."My_Table"')).toBe("my_table");
    expect(canonicalObjectName("my_table")).toBe("my_table");
    expect(canonicalObjectName("aml.cases")).toBe("aml.cases");
  });

  it("spells a bare name and a public-qualified one the same, so the two sides can meet", () => {
    const creator = dependencyFactsOf("create table public.things (id int);");
    const user = dependencyFactsOf("alter table things add column x int;");
    expect(creator.creates).toContain("things");
    expect(user.requires).toContain("things");
  });
});

describe("dependencyFactsOf — what it creates", () => {
  it("reads every class the corpus uses", () => {
    const { creates } = dependencyFactsOf(
      [
        "create table t (id int);",
        "create unique index if not exists i on t (id);",
        "create or replace function f() returns int language sql as $$ select 1 $$;",
        "create materialized view mv as select 1;",
        "create type ty as enum ('a');",
        "create schema s;",
        "create trigger tg before update on t for each row execute function f();",
        "create sequence sq;",
      ].join("\n"),
    );
    expect(creates).toEqual(expect.arrayContaining(["t", "i", "f", "mv", "ty", "s", "tg", "sq"]));
  });

  it("reads a create the file guards with if not exists", () => {
    expect(dependencyFactsOf("create table if not exists t (id int);").creates).toContain("t");
  });
});

describe("dependencyFactsOf — what it requires", () => {
  it("reads the forms Postgres resolves at the statement", () => {
    const { requires } = dependencyFactsOf(
      [
        "alter table parent add column x int;",
        "create index i on indexed (id);",
        "create policy p on policied for select using (true);",
        "create trigger tg after insert on triggered for each row execute function f();",
        "insert into seeded (id) values (1);",
        "update updated set x = 1;",
        "delete from emptied where id = 1;",
        "alter table child add constraint fk foreign key (p) references referenced (id);",
        "comment on table commented is 'x';",
        "grant select on table granted to authenticated;",
      ].join("\n"),
    );
    expect(requires).toEqual(
      expect.arrayContaining([
        "parent",
        "indexed",
        "policied",
        "triggered",
        "seeded",
        "updated",
        "emptied",
        "referenced",
        "commented",
        "granted",
      ]),
    );
  });

  it("does NOT require what a statement tolerates the absence of", () => {
    // Measured on the prime against PostgreSQL 16: `drop policy if exists p on
    // t` succeeds when `t` does not exist. Reading it the other way produced
    // 88 findings there, every one wrong.
    const { requires } = dependencyFactsOf(
      [
        "alter table if exists absent_a add column x int;",
        "drop policy if exists p on absent_b;",
      ].join("\n"),
    );
    expect(requires).not.toContain("absent_a");
    expect(requires).not.toContain("absent_b");
  });

  it("requires a relation a drop policy does NOT guard", () => {
    expect(dependencyFactsOf("drop policy p on guarded_by_nothing;").requires).toContain(
      "guarded_by_nothing",
    );
  });

  it("ignores a schema an extension or the platform owns", () => {
    const { requires } = dependencyFactsOf(
      [
        "insert into cron.job (schedule) values ('* * * * *');",
        "grant select on table auth.users to authenticated;",
        "insert into ours (id) values (1);",
      ].join("\n"),
    );
    expect(requires).not.toContain("cron.job");
    expect(requires).not.toContain("auth.users");
    expect(requires).toContain("ours");
  });

  it("does not take a keyword a loose form swept up as a name", () => {
    const { requires } = dependencyFactsOf("grant select on all tables in schema public to anon;");
    expect(requires).not.toContain("select");
    expect(requires).not.toContain("public");
  });

  it("does not read a PL/pgSQL body as a reference", () => {
    // A body is stored as text and resolved when it runs, so naming a table
    // created later is correct and common.
    const { requires } = dependencyFactsOf(
      "create function f() returns void language plpgsql as $$ begin insert into written_later (id) values (1); end $$;",
    );
    expect(requires).not.toContain("written_later");
  });
});

describe("dependencyFactsOf — the shapes a caller must survive", () => {
  it("answers nothing for a body that could not be read", () => {
    expect(dependencyFactsOf("")).toBe(NO_DEPENDENCY_FACTS);
    expect(dependencyFactsOf(undefined as unknown as string)).toBe(NO_DEPENDENCY_FACTS);
  });

  it("de-duplicates, so a name repeated ten times is one name", () => {
    const sql = Array.from({ length: 10 }, () => "insert into t (id) values (1);").join("\n");
    expect(dependencyFactsOf(sql).requires.filter((r) => r === "t")).toHaveLength(1);
  });

  it("is not confused by a second call — the regexes carry no state across files", () => {
    const sql = "create table t (id int); alter table u add column x int;";
    const first = dependencyFactsOf(sql);
    const second = dependencyFactsOf(sql);
    expect(second).toEqual(first);
  });
});
