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
  DIAGNOSIS_VERDICTS,
  IDEMPOTENCY_ROWS,
  OWED_STANDINGS,
  SURVEY_STANDINGS,
  assessIdempotency,
  diagnoseMigration,
  findVersionCollisions,
  hazardsIn,
  isRollbackScript,
  isSafeToDryRun,
  mayDispatch,
  readSqlFailure,
  scanSqlStatements,
  spansCode,
  sqlstateWords,
  type DiagnosisInput,
  type DiagnosisVerdict,
  surveyMigration,
  type DryRunOutcome,
  type MigrationSurvey,
  type SurveyInput,
  type SurveyStanding,
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

describe("what a second run of the same file would do", () => {
  const read = (sql: string) => assessIdempotency(scanSqlStatements(sql));

  it("reads a file the repository already wrote to be repeated as re-runnable", () => {
    const r = read(`
      create table if not exists public.t (id int);
      create or replace function public.f() returns int language sql as $$ select 1 $$;
      alter table public.t add column if not exists c text;
      grant select on public.t to authenticated;
      comment on table public.t is 'x';
      insert into public.t (id) values (1) on conflict do nothing;
    `);
    expect(r.reading).toBe("rerunnable");
    expect(r.collideCount).toBe(0);
    expect(r.rewriteCount).toBe(0);
  });

  it("pairs a create with an EARLIER drop of the same object and not a later one", () => {
    const guarded = read(`
      drop policy if exists "read" on public.t;
      create policy "read" on public.t for select using (true);
    `);
    expect(guarded.reading).toBe("rerunnable");
    expect(guarded.guardedByDrop).toBe(1);

    // The same two statements the other way round. The create runs first and
    // there is nothing above it, so the second run still collides.
    const after = read(`
      create policy "read" on public.t for select using (true);
      drop policy if exists "read" on public.t;
    `);
    expect(after.reading).toBe("fails_loudly");
    expect(after.guardedByDrop).toBe(0);
  });

  it("refuses to accept a bare DROP as a guard, because its own second run fails", () => {
    const r = read(`
      drop policy "read" on public.t;
      create policy "read" on public.t for select using (true);
    `);
    expect(r.reading).toBe("fails_loudly");
    expect(r.guardedByDrop).toBe(0);
    // Both statements are named: the drop that would not find its object, and
    // the create the drop failed to guard.
    expect(r.collideCount).toBe(2);
  });

  it("does not pair a drop with a create of a different object", () => {
    const r = read(`
      drop policy if exists "old name" on public.t;
      create policy "new name" on public.t for select using (true);
    `);
    expect(r.reading).toBe("fails_loudly");
    expect(r.guardedByDrop).toBe(0);
  });

  it("reads through schema and quoting, because one file writes a name both ways", () => {
    const r = read(`
      drop index if exists public."idx_t_id";
      create index idx_t_id on public.t (id);
    `);
    expect(r.reading).toBe("rerunnable");
    expect(r.guardedByDrop).toBe(1);
  });

  it("separates the loud second run from the silent one", () => {
    const loud = read("create table public.t (id int);");
    expect(loud.reading).toBe("fails_loudly");
    expect(loud.summary).toContain("Nothing would be written twice");

    const silent = read("insert into public.t (id) values (1);");
    expect(silent.reading).toBe("rewrites_data");
    expect(silent.summary).toContain("change data rather than stop");
  });

  it("lets the silent outcome outrank the loud one when a file carries both", () => {
    const r = read(`
      create table public.t (id int);
      insert into public.t (id) values (1);
    `);
    expect(r.reading).toBe("rewrites_data");
    expect(r.collideCount).toBe(1);
    expect(r.rewriteCount).toBe(1);
    // …and the loud one is still said, because it is what actually happens first.
    expect(r.summary).toContain("would fail first");
  });

  it("never reads a body it was not given as re-runnable", () => {
    const r = assessIdempotency(null);
    expect(r.reading).toBe("unreadable");
    expect(r.summary).toContain("not read here");
    expect(r.collideCount).toBe(0);
    expect(r.rewriteCount).toBe(0);
  });

  it("counts a block it cannot see into rather than judging what is inside it", () => {
    const r = read(`
      do $$ begin create table public.t (id int); end $$;
    `);
    // The scanner elides a dollar-quoted body on purpose, so the CREATE inside
    // is invisible here. Reporting `rerunnable` in silence would be a claim
    // about statements nothing read.
    expect(r.reading).toBe("rerunnable");
    expect(r.opaqueBlocks).toBe(1);
    expect(r.summary).toContain("does not read into");
  });

  it("caps the notes it draws but never the count it reports", () => {
    const many = Array.from(
      { length: IDEMPOTENCY_ROWS + 4 },
      (_, i) => `create table public.t${i} (id int);`,
    ).join("\n");
    const r = read(many);
    expect(r.collideCount).toBe(IDEMPOTENCY_ROWS + 4);
    expect(r.collides).toHaveLength(IDEMPOTENCY_ROWS);
  });

  it("rides every verdict, including the ones that refuse to run the file", () => {
    // The question "what would a second run do" outlives the verdict that
    // answered "you may not run it once", which is the state an operator is in
    // after a half-failed dispatch.
    const blocked = diagnoseMigration(
      input({
        blockedBy: ["20260101000000"],
        body: { read: true, sql: "insert into public.t (id) values (1);", bytes: 40 },
      }),
    );
    expect(blocked.verdict).toBe("blocked_by_prerequisite");
    expect(blocked.idempotency.reading).toBe("rewrites_data");
  });

  it("says unreadable on a verdict that never opened the body", () => {
    const oversized = diagnoseMigration(
      input({ body: { read: false, oversized: true, why: "9 MB." } }),
    );
    expect(oversized.verdict).toBe("oversized");
    expect(oversized.idempotency.reading).toBe("unreadable");
  });
});

describe("a survey is not a cheaper diagnosis", () => {
  const survey = (over: Partial<SurveyInput> = {}): MigrationSurvey =>
    surveyMigration({
      meta: meta(),
      collidingNames: [],
      alreadyApplied: false,
      blockedBy: [],
      body: { read: true, sql: "create table if not exists public.t (id int);", bytes: 45 },
      ...over,
    });

  it("never spells a word the verdict spells, so a list cannot promise what a trial run did not", () => {
    // Read from the module, not restated here: a hand-typed copy of either
    // list cannot see a member the module gains, which is exactly the way
    // this assertion was vacuous when it was first written.
    const shared = SURVEY_STANDINGS.filter((s) =>
      (DIAGNOSIS_VERDICTS as readonly string[]).includes(s),
    );
    expect(shared).toEqual([]);
    expect(SURVEY_STANDINGS.length).toBeGreaterThan(1);
    expect(DIAGNOSIS_VERDICTS.length).toBeGreaterThan(1);
  });

  it("reads a healthy file as untested rather than as good", () => {
    const r = survey();
    expect(r.standing).toBe("needs_a_trial_run");
    expect(r.note).toContain("has not been tested");
    // The word the diagnosis uses for a file it has evidence about.
    expect(r.note).not.toContain("ready");
  });

  it("stops at the same layer the diagnosis stops at, on the same inputs", () => {
    // The two walk one cascade, so a case that settles before the trial run
    // must settle at the same place on both surfaces. If they ever part, the
    // list and the page disagree about a file while each is right about itself.
    const cases: Array<{
      over: Partial<DiagnosisInput>;
      verdict: DiagnosisVerdict;
      standing: SurveyStanding;
    }> = [
      {
        over: { meta: meta("20260101000000_rollback_rls.sql") },
        verdict: "rollback_script",
        standing: "must_not_run",
      },
      {
        over: { collidingNames: ["other.sql"] },
        verdict: "version_collision",
        standing: "cannot_be_recorded",
      },
      { over: { alreadyApplied: true }, verdict: "already_applied", standing: "applied" },
      {
        over: { body: { read: false, oversized: true, why: "9 MB." } },
        verdict: "oversized",
        standing: "too_large",
      },
      {
        over: { body: { read: false, oversized: false, why: "the read failed." } },
        verdict: "undiagnosed",
        standing: "unknown",
      },
      { over: { blockedBy: null }, verdict: "undiagnosed", standing: "unknown" },
      {
        over: { blockedBy: ["20250101000000"] },
        verdict: "blocked_by_prerequisite",
        standing: "blocked",
      },
      {
        over: { body: { read: true, sql: "begin; create table t (id int); commit;", bytes: 40 } },
        verdict: "unsafe_to_test",
        standing: "hand_apply",
      },
    ];
    for (const c of cases) {
      const full = diagnoseMigration(input(c.over));
      const quick = surveyMigration({
        meta: c.over.meta ?? meta(),
        collidingNames: c.over.collidingNames ?? [],
        alreadyApplied: c.over.alreadyApplied ?? false,
        blockedBy: "blockedBy" in c.over ? (c.over.blockedBy ?? null) : [],
        body: c.over.body ?? {
          read: true,
          sql: "create table if not exists public.t (id int);",
          bytes: 45,
        },
      });
      expect([c.over, full.verdict]).toEqual([c.over, c.verdict]);
      expect([c.over, quick.standing]).toEqual([c.over, c.standing]);
    }
  });

  it("carries the re-run reading on every standing, including the ones it refuses", () => {
    const undo = survey({
      meta: meta("20260101000000_rollback_rls.sql"),
      body: { read: true, sql: "insert into public.t (id) values (1);", bytes: 40 },
    });
    expect(undo.standing).toBe("must_not_run");
    expect(undo.idempotency.reading).toBe("rewrites_data");
  });

  it("separates a file nobody could read from a file that read clean", () => {
    const unread = survey({ body: { read: false, oversized: false, why: "404 from GitHub." } });
    expect(unread.standing).toBe("unknown");
    expect(unread.statementCount).toBeNull();
    expect(unread.bytes).toBeNull();
    expect(unread.idempotency.reading).toBe("unreadable");
    expect(unread.note).toContain("404");

    const clean = survey();
    expect(clean.statementCount).toBe(1);
    expect(clean.idempotency.reading).toBe("rerunnable");
  });

  it("counts what is in front of a file, and says null rather than zero when it cannot", () => {
    expect(survey({ blockedBy: ["a", "b"] }).blockedByCount).toBe(2);
    expect(survey({ blockedBy: null }).blockedByCount).toBeNull();
  });

  it("names as owed exactly the standings an operator can act on", () => {
    // `applied`, `must_not_run` and `unknown` are not work: one is done, one
    // is refused on purpose, and one is a read this console could not make.
    expect(OWED_STANDINGS.has("applied")).toBe(false);
    expect(OWED_STANDINGS.has("must_not_run")).toBe(false);
    expect(OWED_STANDINGS.has("unknown")).toBe(false);
    expect(OWED_STANDINGS.has("needs_a_trial_run")).toBe(true);
    expect(OWED_STANDINGS.has("blocked")).toBe(true);
  });
});

/**
 * Which stretches of a statement are SQL, and which are the author talking.
 *
 * The walk has always had to know — it strips comments from `text` and elides
 * dollar bodies from `head` — but it did not SAY, so anything working on the
 * source had to guess. `planMigrationRepair` guessed, matched an `ADD COLUMN`
 * anchor inside `-- add column for tracking`, and wrote a guard into the
 * comment; on another shape it wrote one into a column default and reported
 * the file healed while a second run still failed. Proved against PostgreSQL
 * 16 by diffing the catalogue either side.
 */
describe("the walk says which stretches are SQL", () => {
  const codeOf = (sql: string) =>
    scanSqlStatements(sql).map((s) => s.codeSpans.map(([a, b]) => sql.slice(a, b)).join("⟦⟧"));

  it("leaves out line comments, block comments, literals, quoted names and bodies", () => {
    expect(codeOf(`ALTER TABLE p ADD COLUMN a int, -- add column x\n  ADD COLUMN b int;`)).toEqual([
      "ALTER TABLE p ADD COLUMN a int, ⟦⟧  ADD COLUMN b int;",
    ]);
    expect(codeOf(`CREATE /* note */ TABLE t (n text DEFAULT 'create table zz');`)).toEqual([
      "CREATE ⟦⟧ TABLE t (n text DEFAULT ⟦⟧);",
    ]);
    expect(codeOf(`ALTER TABLE t ADD COLUMN n text DEFAULT $tag$add column$tag$;`)).toEqual([
      "ALTER TABLE t ADD COLUMN n text DEFAULT ⟦⟧;",
    ]);
    expect(
      codeOf(`CREATE POLICY "can view; x" ON public."Odd Tbl" FOR SELECT USING (true);`),
    ).toEqual(["CREATE POLICY ⟦⟧ ON public.⟦⟧ FOR SELECT USING (true);"]);
    expect(codeOf(`INSERT INTO t (a) VALUES ('it''s; fine');`)).toEqual([
      "INSERT INTO t (a) VALUES (⟦⟧);",
    ]);
  });

  it("keeps every span inside its own statement, ordered and disjoint", () => {
    const sql = [
      `-- a leading comment`,
      `CREATE TABLE t (n text DEFAULT 'x');`,
      `/* between */`,
      `CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$;`,
    ].join("\n");
    for (const s of scanSqlStatements(sql)) {
      let prev = s.start;
      for (const [a, b] of s.codeSpans) {
        expect(a).toBeGreaterThanOrEqual(s.start);
        expect(b).toBeLessThanOrEqual(s.end);
        expect(b).toBeGreaterThan(a);
        expect(a).toBeGreaterThanOrEqual(prev);
        prev = b;
      }
    }
  });

  it("calls nothing code after a literal or body the file never closes", () => {
    /*
      A truncated file, or one cut at the corpus ceiling, leaves the walk
      inside a literal at EOF. Without a flag saying so, the final close
      pushed a run from wherever code last began straight through the
      unterminated text — calling it SQL, and overlapping the run already
      recorded: spans [0,31] and [0,44] on the first of these.
    */
    expect(codeOf(`CREATE TABLE t (n text DEFAULT 'unterminated`)).toEqual([
      "CREATE TABLE t (n text DEFAULT ",
    ]);
    expect(codeOf(`CREATE FUNCTION f() AS $$ unterminated body`)).toEqual([
      "CREATE FUNCTION f() AS ",
    ]);
    expect(codeOf(`CREATE TABLE t (n text); -- trailing comment, no newline`)).toEqual([
      "CREATE TABLE t (n text);",
    ]);
  });

  it("does not hand a statement the comment that introduces it", () => {
    const sql = `-- add column for tracking\nALTER TABLE t ADD COLUMN a int;`;
    expect(codeOf(sql)).toEqual(["ALTER TABLE t ADD COLUMN a int;"]);
  });

  it("answers spansCode only for a range wholly inside one span", () => {
    const [s] = scanSqlStatements(`CREATE TABLE t (n text DEFAULT 'zz');`);
    const [first] = s.codeSpans;
    expect(spansCode(s.codeSpans, first[0], first[1])).toBe(true);
    expect(spansCode(s.codeSpans, first[0], first[1] + 1)).toBe(false);
    // The literal sits between two spans, so nothing overlapping it is code.
    expect(spansCode(s.codeSpans, first[1], first[1] + 2)).toBe(false);
  });
});

describe("a guard has to be written in SQL, not quoted inside a value", () => {
  /*
    `head` keeps string literals — the enum form reads one as its object key —
    so the guard test used `.*`, which walks straight into a default. A file
    that WILL stop on its second run then read `rerunnable`, which is the one
    direction that matters: re-runnable is the reading that lets a file be
    dispatched again. Measured over the prime's 11,110 statements: this
    changes none of them.
  */
  const read = (sql: string) => assessIdempotency(scanSqlStatements(sql)).reading;

  it("does not read a quoted IF NOT EXISTS as a guard", () => {
    expect(read(`CREATE TABLE t (n text DEFAULT 'create table if not exists z');`)).toBe(
      "fails_loudly",
    );
  });

  it("still reads a real guard as one", () => {
    expect(
      read(`CREATE TABLE IF NOT EXISTS t (n text DEFAULT 'create table if not exists z');`),
    ).toBe("rerunnable");
    expect(read(`CREATE UNIQUE INDEX IF NOT EXISTS i ON t (a);`)).toBe("rerunnable");
    expect(
      read(`CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;`),
    ).toBe("rerunnable");
  });
});
