/**
 * The rule that holds a migration which writes a ledger.
 * See `migrationLedgerWrites.pure.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  LEDGER_WRITE_FROZEN,
  ledgerWriteIn,
  ledgerWriteRefusal,
} from "./migrationLedgerWrites.pure";

const FROZEN = "20260921100000_withdraw_builder_aml_partner_portal_changes.sql";

/** The statement that file carries, verbatim from the prime. */
const FROZEN_STATEMENT = `DELETE FROM supabase_migrations.schema_migrations
 WHERE version IN ('20260719000000','20260728120000','20260921070000','20260921080000','20260921090000');`;

describe("ledgerWriteIn — every shape that writes either ledger", () => {
  it.each([
    "insert into supabase_migrations.schema_migrations (version) values ('1');",
    `INSERT INTO "supabase_migrations"."schema_migrations" VALUES ('1');`,
    "update supabase_migrations.schema_migrations set name = 'x';",
    "update only supabase_migrations.schema_migrations set name = 'x';",
    "delete from supabase_migrations.schema_migrations where version = '1';",
    "DELETE FROM ONLY supabase_migrations.schema_migrations;",
    "truncate supabase_migrations.schema_migrations;",
    "truncate table only supabase_migrations.schema_migrations;",
    "merge into supabase_migrations.schema_migrations t using s on true when matched then delete;",
    "copy supabase_migrations.schema_migrations from stdin;",
    "alter table supabase_migrations.schema_migrations add column x int;",
    "drop table if exists supabase_migrations.schema_migrations;",
    "drop schema supabase_migrations cascade;",
    `alter schema "supabase_migrations" rename to old_ledger;`,
    // Mission Control's own ledgers, which on a clone are ledger too.
    "insert into aurixa.schema_migrations (version, name) values ('1', 'x');",
    "update aurixa.migration_provenance set provenance = 'applied';",
    "delete from aurixa.module_installations;",
    `drop schema if exists "aurixa" cascade;`,
  ])("sees %s", (sql) => {
    expect(ledgerWriteIn(sql)).not.toBeNull();
  });

  it("names the statement it found, whitespace collapsed", () => {
    expect(ledgerWriteIn(FROZEN_STATEMENT)).toBe("DELETE FROM supabase_migrations.");
    expect(ledgerWriteIn("drop   schema\n  aurixa cascade")).toBe("drop schema aurixa");
  });

  it("sees a write inside a string handed to EXECUTE, and inside a function body", () => {
    expect(
      ledgerWriteIn(
        "do $$ begin execute 'delete from supabase_migrations.schema_migrations'; end $$;",
      ),
    ).toBe("delete from supabase_migrations.");
    expect(
      ledgerWriteIn(
        "create function public.f() returns void language sql as $$ insert into aurixa.schema_migrations values ('1', 'x') $$;",
      ),
    ).toBe("insert into aurixa.");
  });

  it("lets a migration ASK a ledger a question", () => {
    expect(
      ledgerWriteIn("select 1 from supabase_migrations.schema_migrations where version = '1';"),
    ).toBeNull();
    expect(
      ledgerWriteIn(
        "do $$ begin if exists (select 1 from aurixa.schema_migrations) then raise notice 'x'; end if; end $$;",
      ),
    ).toBeNull();
  });

  it("reads a schema by its whole name: one that merely starts with a ledger's is not one", () => {
    expect(ledgerWriteIn("insert into aurixa_archive.notes values (1);")).toBeNull();
    expect(ledgerWriteIn("drop schema aurixa_archive cascade;")).toBeNull();
    expect(ledgerWriteIn("delete from supabase_migrations_backup.rows;")).toBeNull();
  });

  it("does not read comments, where the corpus mentions the ledger in prose", () => {
    // Two files on the prime name the ledger in their headers and write nothing.
    const prose = `-- Neither version appears in supabase_migrations.schema_migrations, and neither
/* an example that must not run:
   delete from supabase_migrations.schema_migrations where version = '1'; */
create table public.t (id int);`;
    expect(ledgerWriteIn(prose)).toBeNull();
  });
});

describe("ledgerWriteRefusal — what is held, and the one file that is not", () => {
  it("lets a file that writes no ledger through", () => {
    expect(ledgerWriteRefusal("20260101000000_a.sql", "create table public.a (id int);")).toBe(
      null,
    );
  });

  it("refuses a file that writes one, naming it, the statement and the remedy", () => {
    const refusal = ledgerWriteRefusal(
      "20261301000000_tidy_ledger.sql",
      "delete from supabase_migrations.schema_migrations where version = '1';",
    );
    expect(refusal).toContain("20261301000000_tidy_ledger.sql writes a migration ledger");
    expect(refusal).toContain("`delete from supabase_migrations. …`");
    expect(refusal).toContain("It was not sent.");
    expect(refusal).toContain("MIGRATION_WITHDRAWN.json");
  });

  it("says that nothing at a shared version was sent", () => {
    const refusal = ledgerWriteRefusal(
      "20261301000000_b.sql",
      "truncate aurixa.migration_provenance;",
      { version: "20261301000000", files: ["20261301000000_a.sql", "20261301000000_b.sql"] },
    );
    expect(refusal).toContain(
      "Nothing at version 20261301000000 was sent (20261301000000_a.sql, 20261301000000_b.sql share it).",
    );
  });

  it("lets the frozen file through — while still seeing the write it makes", () => {
    expect(ledgerWriteIn(FROZEN_STATEMENT)).not.toBeNull();
    expect(ledgerWriteRefusal(FROZEN, FROZEN_STATEMENT)).toBeNull();
  });

  it("freezes by NAME: any other file carrying the same statement is refused", () => {
    expect(ledgerWriteRefusal("20261301000000_copy.sql", FROZEN_STATEMENT)).not.toBeNull();
  });

  it("is frozen as history and never extended: one file, the one the prime froze", () => {
    expect([...LEDGER_WRITE_FROZEN.keys()]).toEqual([FROZEN]);
  });
});
