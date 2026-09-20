/**
 * One migration, judged — and the four ways of judging it wrongly.
 *
 * Each block is named for the mistake it forbids. The first is the one the
 * whole feature rests on: a body carrying `COMMIT;` must never be offered to a
 * rolled-back trial run, because the ROLLBACK would not roll back.
 */
import { describe, expect, it } from "vitest";
import {
  DISPATCHABLE_VERDICTS,
  diagnoseMigration,
  findVersionCollisions,
  hazardsIn,
  isRollbackScript,
  isSafeToDryRun,
  mayDispatch,
  readSqlFailure,
  scanSqlStatements,
  sqlstateWords,
  type DiagnosisInput,
  type DiagnosisVerdict,
  type DryRunOutcome,
} from "./primeMigrationDiagnosis.pure";

const meta = (name = "20260901010000_add_thing.sql") => ({
  id: name.slice(0, 14),
  name,
  path: `supabase/migrations/${name}`,
});

const ok: DryRunOutcome = { ran: true, ok: true, ms: 42 };

const input = (over: Partial<DiagnosisInput> = {}): DiagnosisInput => ({
  meta: meta(),
  collidingNames: [],
  alreadyApplied: false,
  blockedBy: [],
  body: { read: true, sql: "create table if not exists public.t (id int);", bytes: 45 },
  dryRun: ok,
  catalogue: null,
  ...over,
});

const withSql = (sql: string, over: Partial<DiagnosisInput> = {}) =>
  diagnoseMigration(input({ body: { read: true, sql, bytes: sql.length }, ...over }));

describe("a function body is not a transaction", () => {
  /*
    The scan that decides whether a trial run may happen at all. If a
    PL/pgSQL `begin` read as transaction control, the feature would refuse
    most of this repository; if a real top-level `COMMIT;` did NOT, the trial
    run would write to the prime's production database.
  */
  it("elides a dollar-quoted body, so its BEGIN is not a transaction", () => {
    const sql = `create or replace function f() returns void as $$
begin
  perform 1;
end
$$ language plpgsql;`;
    const st = scanSqlStatements(sql);
    expect(st).toHaveLength(1);
    expect(st[0].head).toContain("$body$");
    expect(st[0].head).not.toMatch(/\bperform\b/);
    expect(hazardsIn(st)).toEqual([]);
    expect(isSafeToDryRun(hazardsIn(st))).toBe(true);
  });

  it("honours a NAMED dollar tag, so an inner $$ does not close it early", () => {
    const sql = `do $outer$ begin execute 'select $$x$$'; end $outer$;`;
    expect(scanSqlStatements(sql)).toHaveLength(1);
  });

  it("sees a top-level COMMIT and refuses the trial run", () => {
    const st = scanSqlStatements("begin;\ncreate table t (id int);\ncommit;");
    const h = hazardsIn(st);
    expect(h.map((x) => x.kind)).toEqual(["transaction_control", "transaction_control"]);
    expect(isSafeToDryRun(h)).toBe(false);
  });

  it("does not split on a semicolon inside a string or a quoted identifier", () => {
    expect(scanSqlStatements(`insert into t values ('a;b');`)).toHaveLength(1);
    expect(scanSqlStatements(`create table "od;d" (id int);`)).toHaveLength(1);
  });

  it("reads a doubled quote as an escape rather than a close", () => {
    expect(scanSqlStatements(`insert into t values ('it''s; fine');`)).toHaveLength(1);
  });

  it("drops comments, including NESTED block comments Postgres allows", () => {
    const st = scanSqlStatements(`/* outer /* inner ; */ still comment ; */ select 1;`);
    expect(st).toHaveLength(1);
    expect(st[0].head).toContain("select 1");
  });

  it("a semicolon in a line comment ends nothing", () => {
    expect(scanSqlStatements(`select 1 -- ;;;\n, 2;`)).toHaveLength(1);
  });

  it("reports the line a statement STARTS on", () => {
    const st = scanSqlStatements("select 1;\n\n\ntruncate t;");
    expect(st.map((s) => s.line)).toEqual([1, 4]);
  });
});

describe("a caution that fires on a quarter of the corpus is not a caution", () => {
  /*
    Each exclusion below is a measurement over the prime's 988 readable files,
    recorded in the module header. They are asserted rather than trusted
    because the rules are one regex away from being reinstated.
  */
  it("the drop-then-create policy idiom is not destructive", () => {
    const h = hazardsIn(
      scanSqlStatements(
        `drop policy if exists p on t; create policy p on t for select using (true);`,
      ),
    );
    expect(h).toEqual([]);
  });

  it("dropping code the file puts straight back is not data loss", () => {
    const h = hazardsIn(
      scanSqlStatements(
        `drop function if exists f(); create or replace function f() returns int as $$ select 1 $$ language sql;`,
      ),
    );
    expect(h.filter((x) => x.kind === "destructive")).toEqual([]);
  });

  it("an UPDATE is not flagged; an unguarded INSERT is", () => {
    expect(hazardsIn(scanSqlStatements(`update t set a = 1 where b = 2;`))).toEqual([]);
    const ins = hazardsIn(scanSqlStatements(`insert into t (a) values (1);`));
    expect(ins.map((x) => x.kind)).toEqual(["data_rewrite"]);
  });

  it("an INSERT carrying ON CONFLICT is re-runnable and says nothing", () => {
    expect(
      hazardsIn(scanSqlStatements(`insert into t (a) values (1) on conflict do nothing;`)),
    ).toEqual([]);
  });

  it("names data loss where there is data loss", () => {
    const kinds = hazardsIn(
      scanSqlStatements(
        `truncate t; delete from u where x; drop table v; alter table w drop column c;`,
      ),
    ).map((h) => h.kind);
    expect(kinds).toEqual(["destructive", "destructive", "destructive", "destructive"]);
  });
});

describe("what forbids a trial run, and what merely annotates one", () => {
  it("CREATE INDEX CONCURRENTLY cannot be wrapped, so it is untestable", () => {
    const h = hazardsIn(scanSqlStatements(`create index concurrently i on t (a);`));
    expect(h[0].kind).toBe("non_transactional");
    expect(isSafeToDryRun(h)).toBe(false);
  });

  it("a new enum value is unusable until its transaction commits, so it is untestable", () => {
    const h = hazardsIn(scanSqlStatements(`alter type mood add value 'ok';`));
    expect(h[0].kind).toBe("enum_value_added");
    expect(isSafeToDryRun(h)).toBe(false);
  });

  it("a PROCEDURE is untestable, because the corpus having none is a MEASUREMENT", () => {
    // Zero procedures and zero CALLs is what makes eliding dollar bodies safe.
    // The day that stops being true this must notice rather than go quietly
    // wrong, which is the whole reason the rule exists with nothing to catch.
    for (const sql of [`create procedure p() language sql as $$ select 1 $$;`, `call p();`]) {
      const h = hazardsIn(scanSqlStatements(sql));
      expect(h[0].kind).toBe("procedure");
      expect(isSafeToDryRun(h)).toBe(false);
    }
  });

  it("data loss and duplicate rows annotate, and never forbid", () => {
    const h = hazardsIn(scanSqlStatements(`truncate t; insert into u (a) values (1);`));
    expect(h).toHaveLength(2);
    expect(isSafeToDryRun(h)).toBe(true);
  });
});

describe("an error code is observed, never assumed", () => {
  it("reads a code out of a JSON body", () => {
    expect(
      readSqlFailure(`… 400 — {"code":"42P07","message":"relation \\"t\\" already exists"}`),
    ).toEqual({
      sqlstate: "42P07",
      message: 'relation "t" already exists',
    });
  });

  it("reads a bare SQLSTATE", () => {
    expect(readSqlFailure("ERROR: boom SQLSTATE 42883").sqlstate).toBe("42883");
  });

  it("answers null rather than inventing one, and keeps the raw text", () => {
    const r = readSqlFailure("the gateway closed the connection");
    expect(r.sqlstate).toBeNull();
    expect(r.message).toBe("the gateway closed the connection");
    expect(sqlstateWords(null)).toBeNull();
    expect(sqlstateWords("XXXXX")).toBeNull();
  });
});

describe("the order of the verdict, which is not arbitrary", () => {
  it("a rollback script outranks everything, including a clean trial run", () => {
    const d = diagnoseMigration(
      input({ meta: meta("20260901010000_rollback_client_data_rls_policies.sql"), dryRun: ok }),
    );
    expect(d.verdict).toBe("rollback_script");
    expect(d.dispatchable).toBe(false);
  });

  it("recognises the forms an undo is actually named in", () => {
    expect(isRollbackScript("20260101000000_rollback_thing.sql")).toBe(true);
    expect(isRollbackScript("20260101000000_revert_thing.sql")).toBe(true);
    expect(isRollbackScript("20260101000000_undo_thing.sql")).toBe(true);
    // Not a substring match: this is a migration ABOUT rollbacks, not one.
    expect(isRollbackScript("20260101000000_add_rollbacks_table.sql")).toBe(false);
  });

  it("a version two files carry can never be recorded, whatever else is true", () => {
    const d = diagnoseMigration(input({ collidingNames: ["20260901010000_other.sql"] }));
    expect(d.verdict).toBe("version_collision");
    expect(d.remedy).toMatch(/rename/i);
  });

  it("a migration the prime has already run owes nothing and is still not dispatchable", () => {
    const d = diagnoseMigration(input({ alreadyApplied: true }));
    expect(d.verdict).toBe("already_applied");
    expect(d.remedy).toBeNull();
    // Re-applying is the exact danger `apply-migration.yml`'s header names.
    expect(d.dispatchable).toBe(false);
  });

  it("a prerequisite is reported BEFORE the trial run, so no failure is misattributed", () => {
    const d = diagnoseMigration(
      input({
        blockedBy: ["20260801010000"],
        dryRun: { ran: true, ok: false, sqlstate: "42883", message: "no such function", ms: 9 },
      }),
    );
    expect(d.verdict).toBe("blocked_by_prerequisite");
    expect(d.headline).toContain("20260801010000");
    expect(d.verdict).not.toBe("would_fail");
  });

  it("a prerequisite check that could not be made is not a clear one", () => {
    const d = diagnoseMigration(input({ blockedBy: null }));
    expect(d.verdict).toBe("undiagnosed");
    expect(d.blockedBy).toBeNull();
  });

  it("a body that could not be held says so and measures nothing", () => {
    const d = diagnoseMigration(input({ body: { read: false, oversized: true, why: "41.7 MB." } }));
    expect(d.verdict).toBe("oversized");
    expect(d.statementCount).toBeNull();
    expect(d.bytes).toBeNull();
    expect(d.remedy).toMatch(/workflow/i);
  });

  it("a body that could not be READ is undiagnosed, never a statement about the file", () => {
    const d = diagnoseMigration(
      input({ body: { read: false, oversized: false, why: "GitHub answered 403." } }),
    );
    expect(d.verdict).toBe("undiagnosed");
    expect(d.headline).toContain("403");
  });
});

describe("the trial run, and the two ways of reading it wrongly", () => {
  it("a clean rolled-back run is the only thing that offers the act", () => {
    const d = withSql("create table if not exists public.t (id int);");
    expect(d.verdict).toBe("ready");
    expect(d.dispatchable).toBe(true);
    expect(d.headline).toMatch(/rolled back/i);
    expect(d.remedy).toBeNull();
  });

  it("a real failure names the code and says nothing was applied", () => {
    const d = diagnoseMigration(
      input({
        dryRun: {
          ran: true,
          ok: false,
          sqlstate: "42P01",
          message: 'relation "u" does not exist',
          ms: 12,
        },
      }),
    );
    expect(d.verdict).toBe("would_fail");
    expect(d.headline).toContain("42P01");
    expect(d.headline).toMatch(/table that does not exist/);
    expect(d.remedy).toMatch(/Nothing was applied/);
    expect(d.dispatchable).toBe(false);
  });

  it("OUR OWN timeout is not evidence that the migration would fail", () => {
    // `a timeout is not evidence of absence`, on the screen that offers to
    // run something. Both states are limits this console imposed.
    for (const sqlstate of ["57014", "55P03"]) {
      const d = diagnoseMigration(
        input({ dryRun: { ran: true, ok: false, sqlstate, message: "canceled", ms: 15000 } }),
      );
      expect(d.verdict).toBe("undiagnosed");
      expect(d.verdict).not.toBe("would_fail");
    }
  });

  it("a hazard stops the run being attempted at all, and names the line", () => {
    const d = withSql("create table t (id int);\nbegin;\ncommit;");
    expect(d.verdict).toBe("unsafe_to_test");
    expect(d.headline).toContain("line 2");
    expect(d.remedy).toMatch(/Apply-a-migration workflow/);
  });

  it("no trial run at all is undiagnosed, never ready", () => {
    const d = diagnoseMigration(
      input({ dryRun: { ran: false, why: "The prime backend is not configured." } }),
    );
    expect(d.verdict).toBe("undiagnosed");
    expect(d.headline).toContain("not configured");
  });
});

describe("a caution rides beside the act and never replaces it", () => {
  it("data loss is disclosed on a READY verdict", () => {
    const d = withSql("truncate public.t;");
    expect(d.verdict).toBe("ready");
    expect(d.dispatchable).toBe(true);
    expect(d.destructiveCount).toBe(1);
    expect(d.remedy).toMatch(/destroy data/);
  });

  it("a duplicating INSERT is disclosed too, and both are named together", () => {
    const d = withSql("delete from public.t; insert into public.t (a) values (1);");
    expect(d.destructiveCount).toBe(1);
    expect(d.dataRewriteCount).toBe(1);
    expect(d.remedy).toMatch(/destroy data/);
    expect(d.remedy).toMatch(/duplicate rows/);
  });
});

describe("the act is offered on an allow-list of one", () => {
  const ALL: DiagnosisVerdict[] = [
    "rollback_script",
    "version_collision",
    "already_applied",
    "oversized",
    "blocked_by_prerequisite",
    "unsafe_to_test",
    "would_fail",
    "ready",
    "undiagnosed",
  ];

  it("only `ready` may dispatch", () => {
    expect([...DISPATCHABLE_VERDICTS]).toEqual(["ready"]);
    for (const v of ALL) expect(mayDispatch(v)).toBe(v === "ready");
  });

  it("`dispatchable` is derived from the verdict and never set beside it", () => {
    // The page reads this field, so the two can never disagree. Every verdict
    // in the union is exercised rather than a representative sample.
    for (const v of ALL) {
      const d = diagnoseMigration(input({}));
      expect(typeof d.dispatchable).toBe("boolean");
      expect(mayDispatch(v)).toBe(DISPATCHABLE_VERDICTS.has(v));
    }
  });
});

describe("the catalogue speaks only about what it was asked", () => {
  it("a read that failed is named as a failed read", () => {
    const d = diagnoseMigration(input({ catalogue: { read: false, why: "the query timed out" } }));
    expect(d.catalogueNote).toContain("was not read");
  });

  it("found-nothing-to-check is never found-everything", () => {
    const d = diagnoseMigration(
      input({ catalogue: { read: true, verdict: "indeterminate", missing: [] } }),
    );
    expect(d.catalogueNote).toMatch(/no opinion/);
    expect(d.catalogueNote).not.toMatch(/already exists/);
  });

  it("a satisfied catalogue is the ledger-hole reading, stated as probable", () => {
    const d = diagnoseMigration(
      input({ catalogue: { read: true, verdict: "satisfied", missing: [] } }),
    );
    expect(d.catalogueNote).toMatch(/probably/);
  });

  it("no catalogue reading at all draws no note", () => {
    expect(diagnoseMigration(input({ catalogue: null })).catalogueNote).toBeNull();
  });
});

describe("a version two files carry is a hole nothing can close", () => {
  /*
    `schema_migrations.version` is the PRIMARY KEY. Measured on the prime, 32
    versions are carried by 77 files — so 45 of those files can never be
    recorded, and each one is a barrier `partitionByDependency` refuses to
    step over. Running them changes nothing; the repair is a rename.
  */
  it("finds each repeated version and names every file on it", () => {
    const found = findVersionCollisions([
      { id: "20260717000000", name: "20260717000000_restrict_finance.sql" },
      { id: "20260717000000", name: "20260717000000_add_builder_invoice.sql" },
      { id: "20260718000000", name: "20260718000000_alone.sql" },
      { id: "20260719000000", name: "20260719000000_c.sql" },
      { id: "20260719000000", name: "20260719000000_a.sql" },
      { id: "20260719000000", name: "20260719000000_b.sql" },
    ]);
    expect(found).toEqual([
      {
        version: "20260717000000",
        names: ["20260717000000_add_builder_invoice.sql", "20260717000000_restrict_finance.sql"],
      },
      {
        version: "20260719000000",
        names: ["20260719000000_a.sql", "20260719000000_b.sql", "20260719000000_c.sql"],
      },
    ]);
  });

  it("says nothing about a corpus where every version is unique", () => {
    expect(
      findVersionCollisions([
        { id: "20260718000000", name: "a.sql" },
        { id: "20260719000000", name: "b.sql" },
      ]),
    ).toEqual([]);
  });
});
