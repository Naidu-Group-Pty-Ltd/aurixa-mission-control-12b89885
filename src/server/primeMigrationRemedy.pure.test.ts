/**
 * A repair is offered only where it is sound, and only where it works.
 *
 * Each block is named for the mistake it forbids, and the first two are the
 * ones the whole module rests on: a patch that claims a re-runnability it
 * cannot deliver, and a patch that quietly damages the file it is repairing.
 *
 * ## Why so much of this re-measures rather than re-states
 *
 * `planMigrationRepair` already re-reads its own patch and discards it on
 * failure. A test that asserted "the outcome was `healed`" would therefore be
 * asserting the module's own claim about itself — the shape this repository
 * has been bitten by twice, most recently where a vocabulary-disjointness
 * test was satisfied by two lists written by hand inside the test.
 *
 * So the invariants below are checked INDEPENDENTLY: every patch is re-scanned
 * here, with the same reader the chip uses, and compared against the original
 * by subsequence and by length. If the module's proof were removed, these
 * would fail; if these were removed, the module's proof would still hold. Two
 * witnesses, neither derived from the other.
 */
import { describe, expect, it } from "vitest";
import { assessIdempotency, scanSqlStatements } from "./primeMigrationDiagnosis.pure";
import {
  OFFERABLE_OUTCOMES,
  REFUSAL_KINDS,
  REMEDY_OUTCOMES,
  REPAIR_KINDS,
  mayPropose,
  planMigrationRepair,
  proveRepair,
  type RemedyPlan,
} from "./primeMigrationRemedy.pure";

const plan = (sql: string | null) => planMigrationRepair(sql);
const kinds = (p: RemedyPlan) => p.repairs.map((r) => r.kind);
const refusedAs = (p: RemedyPlan) => p.refusals.map((r) => r.kind);
const reading = (sql: string) => assessIdempotency(scanSqlStatements(sql)).reading;

/** Is `a` a subsequence of `b`? True exactly when `b` only ADDS to `a`. */
function isSubsequence(a: string, b: string): boolean {
  let i = 0;
  for (let j = 0; j < b.length && i < a.length; j++) if (b[j] === a[i]) i++;
  return i === a.length;
}

/**
 * Every literal and comment in a file, in order — a reader written HERE, from
 * nothing the module exports.
 *
 * Pure insertion is not enough on its own, and that gap is what a sweep
 * against a real PostgreSQL found: inserting `IF NOT EXISTS ` into the middle
 * of `DEFAULT 'add column b int'` keeps the original a subsequence, keeps the
 * bytes accounting, keeps the statement count, and moves the reading — so
 * every check the module and this file already had said yes, while the column
 * a migration creates had silently acquired a different default. A comment
 * reading `-- add column for tracking` goes the same way.
 *
 * So: what the author wrote as prose or as a value has to come out the other
 * side untouched. A prepended `DROP POLICY IF EXISTS "name"` legitimately ADDS
 * quoted identifiers, which is why this is a subsequence rather than equality.
 */
function inert(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  const closeAt = (from: number, end: string) => {
    const at = sql.indexOf(end, from);
    return at === -1 ? sql.length : at + end.length;
  };
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const nl = sql.indexOf("\n", i);
      out.push(sql.slice(i, nl === -1 ? sql.length : nl));
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (two === "/*") {
      const j = closeAt(i + 2, "*/");
      out.push(sql.slice(i, j));
      i = j;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const q = sql[i];
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === q && sql[j + 1] === q) {
          j += 2;
          continue;
        }
        if (sql[j] === q) {
          j += 1;
          break;
        }
        j += 1;
      }
      out.push(sql.slice(i, j));
      i = j;
      continue;
    }
    const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
    if (tag) {
      out.push(sql.slice(i, closeAt(i + tag[0].length, tag[0])));
      i = closeAt(i + tag[0].length, tag[0]);
      continue;
    }
    i += 1;
  }
  return out;
}

/** Every literal and comment the author wrote still appears, in order. */
function keepsProseAndValues(original: string, patched: string): boolean {
  const a = inert(original);
  const b = inert(patched);
  let j = 0;
  for (const token of a) {
    const at = b.indexOf(token, j);
    if (at === -1) return false;
    j = at + 1;
  }
  return true;
}

/**
 * Every property a patch must have, checked against the bytes rather than
 * against the plan's own word for it.
 */
function assertSoundPatch(original: string, p: RemedyPlan) {
  expect(p.patched).not.toBeNull();
  const patched = p.patched!;

  // Nothing was removed, reordered or reformatted.
  expect(isSubsequence(original, patched)).toBe(true);
  expect(patched.length).toBeGreaterThan(original.length);

  // And nothing was written into the author's prose or into a stored value.
  expect(keepsProseAndValues(original, patched)).toBe(true);

  // The patched file still parses, into the statements it had plus what was
  // inserted as whole statements.
  const before = scanSqlStatements(original);
  const after = scanSqlStatements(patched);
  expect(after.length).toBeGreaterThanOrEqual(before.length);

  // And it is measurably better, read by the module the chip reads.
  const b = assessIdempotency(before);
  const a = assessIdempotency(after);
  expect(a.collideCount + a.rewriteCount).toBeLessThan(b.collideCount + b.rewriteCount);
  expect(a.reading).toBe(p.after);
}

describe("a repair never claims what it cannot deliver", () => {
  it("refuses an unguarded INSERT rather than moving the chip with ON CONFLICT", () => {
    const sql = `insert into seeds (id, label) values (1, 'a');`;
    const p = plan(sql);
    expect(reading(sql)).toBe("rewrites_data");
    expect(p.outcome).toBe("no_repair");
    expect(p.patched).toBeNull();
    expect(refusedAs(p)).toEqual(["insert"]);
    expect(p.refusals[0].why).toMatch(/unique constraint/i);
  });

  it("a file whose only unrepairable statement is an INSERT is improved, never healed", () => {
    const sql = [
      `create table t (id int);`,
      `create policy p on t for select using (true);`,
      `insert into t (id) values (1);`,
    ].join("\n");
    const p = plan(sql);
    expect(p.outcome).toBe("improved");
    expect(p.after).toBe("rewrites_data");
    expect(p.summary).toMatch(/still not be safe to run twice/i);
    assertSoundPatch(sql, p);
  });

  it("refuses CREATE TYPE, because the drop that would guard it takes columns with it", () => {
    const sql = `create type mood as enum ('ok', 'bad');`;
    const p = plan(sql);
    expect(p.outcome).toBe("no_repair");
    expect(refusedAs(p)).toEqual(["type"]);
    expect(p.refusals[0].why).toMatch(/column/i);
  });

  it("every refusal says why, in words rather than an identifier", () => {
    const sql = [`create type mood as enum ('ok');`, `insert into t (a) values (1);`].join("\n");
    for (const r of plan(sql).refusals) {
      expect(r.why.length).toBeGreaterThan(40);
      expect(r.why).not.toMatch(/\b[a-z]+_[a-z]+\b/);
    }
  });
});

describe("a patch only ever adds", () => {
  const cases: Array<[string, string]> = [
    ["a table", `CREATE TABLE widgets (id int primary key);`],
    ["an index", `CREATE INDEX t_a_idx ON t (a);`],
    ["a unique index", `CREATE UNIQUE INDEX t_a_uq ON t (a);`],
    ["a schema", `CREATE SCHEMA app;`],
    ["a sequence", `CREATE SEQUENCE s START 5;`],
    ["an extension", `CREATE EXTENSION pgcrypto;`],
    ["a materialized view", `CREATE MATERIALIZED VIEW mv AS SELECT 1 AS a;`],
    ["a view", `CREATE VIEW v AS SELECT 1 AS a;`],
    [
      "a function",
      `CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql;`,
    ],
    ["a column", `ALTER TABLE t ADD COLUMN b text;`],
    ["an enum value", `ALTER TYPE mood ADD VALUE 'great';`],
    ["a policy", `CREATE POLICY p ON t FOR SELECT USING (true);`],
    ["a trigger", `CREATE TRIGGER g BEFORE INSERT ON t FOR EACH ROW EXECUTE FUNCTION f();`],
    ["a constraint", `ALTER TABLE t ADD CONSTRAINT t_pos CHECK (a > 0);`],
    ["a bare drop", `DROP TABLE gone;`],
    ["a bare constraint drop", `ALTER TABLE t DROP CONSTRAINT c1;`],
  ];

  for (const [what, sql] of cases) {
    it(`${what} is guarded, and nothing else about the file changes`, () => {
      const p = plan(sql);
      expect(p.outcome).toBe("healed");
      expect(p.after).toBe("rerunnable");
      assertSoundPatch(sql, p);
    });
  }

  it("covers every repair kind the module declares", () => {
    const seen = new Set(cases.flatMap(([, sql]) => kinds(plan(sql))));
    expect([...REPAIR_KINDS].filter((k) => !seen.has(k))).toEqual([]);
  });
});

describe("the inserted text belongs in the file it lands in", () => {
  it("takes the case of the keyword it attaches to", () => {
    expect(plan(`CREATE TABLE t (id int);`).patched).toContain("CREATE TABLE IF NOT EXISTS t");
    expect(plan(`create table t (id int);`).patched).toContain("create table if not exists t");
  });

  it("keeps a quoted policy name exactly as written", () => {
    const sql = `CREATE POLICY "Users can view their own rows" ON public.t FOR SELECT USING (true);`;
    const p = plan(sql);
    expect(p.patched).toContain(
      `DROP POLICY IF EXISTS "Users can view their own rows" ON public.t;`,
    );
    assertSoundPatch(sql, p);
  });

  it("keeps the indentation of the statement it sits above", () => {
    const sql = `do $$ begin end $$;\n    CREATE POLICY p ON t FOR SELECT USING (true);`;
    expect(plan(sql).patched).toContain(`    DROP POLICY IF EXISTS p ON t;\n    CREATE POLICY p`);
  });

  it("lands under a leading comment rather than between it and its statement", () => {
    const sql = `-- everybody may read\nCREATE POLICY p ON t FOR SELECT USING (true);`;
    expect(plan(sql).patched).toBe(
      `-- everybody may read\nDROP POLICY IF EXISTS p ON t;\nCREATE POLICY p ON t FOR SELECT USING (true);`,
    );
  });

  it("guards every column an ALTER TABLE adds, not only the first", () => {
    const sql = `ALTER TABLE t ADD COLUMN b text, ADD COLUMN c int;`;
    const p = plan(sql);
    expect(p.outcome).toBe("healed");
    expect(p.patched).toBe(
      `ALTER TABLE t ADD COLUMN IF NOT EXISTS b text, ADD COLUMN IF NOT EXISTS c int;`,
    );
  });

  it("does not reach inside a function body looking for more to guard", () => {
    const sql = [
      `CREATE FUNCTION f() RETURNS void AS $$`,
      `BEGIN`,
      `  CREATE TEMP TABLE scratch (a int);`,
      `END`,
      `$$ LANGUAGE plpgsql;`,
    ].join("\n");
    const p = plan(sql);
    expect(p.patched).toContain("CREATE OR REPLACE FUNCTION f()");
    expect(p.patched).toContain("CREATE TEMP TABLE scratch (a int);");
    expect(p.patched).not.toContain("CREATE OR REPLACE TEMP");
  });
});

describe("what it leaves alone", () => {
  it("says a file that is already re-runnable needs nothing", () => {
    const p = plan(`create table if not exists t (id int);`);
    expect(p.outcome).toBe("nothing_to_do");
    expect(p.patched).toBeNull();
    expect(p.repairCount).toBe(0);
    expect(p.refusalCount).toBe(0);
  });

  it("does not re-guard a creation an earlier DROP … IF EXISTS already guards", () => {
    const sql = [
      `DROP POLICY IF EXISTS p ON t;`,
      `CREATE POLICY p ON t FOR SELECT USING (true);`,
    ].join("\n");
    expect(reading(sql)).toBe("rerunnable");
    expect(plan(sql).outcome).toBe("nothing_to_do");
  });

  it("a body nobody read is unreadable, never a file that needs nothing", () => {
    const p = plan(null);
    expect(p.outcome).toBe("unreadable");
    expect(p.before).toBe("unreadable");
    expect(p.patched).toBeNull();
  });
});

describe("the proof throws a patch away rather than trusting the planner", () => {
  const original = `CREATE TABLE t (id int);`;
  const good = `CREATE TABLE IF NOT EXISTS t (id int);`;

  it("holds for a patch that inserted what it said and measurably helped", () => {
    expect(
      proveRepair({
        original,
        patched: good,
        insertedBytes: good.length - original.length,
        prepends: 0,
      }),
    ).toEqual({ held: true });
  });

  it("refuses a patch whose bytes do not account — something was overwritten", () => {
    const clobbered = `CREATE TABLE IF NOT EXISTS t (id);`;
    const p = proveRepair({ original, patched: clobbered, insertedBytes: 14, prepends: 0 });
    expect(p.held).toBe(false);
    expect(p.held === false && p.why).toMatch(/length/i);
  });

  it("refuses a patch that no longer parses into the statements it had", () => {
    // A guard dropped where it splits the file rather than guarding it.
    const split = `CREATE TABLE IF NOT; EXISTS t (id int);`;
    const p = proveRepair({
      original,
      patched: split,
      insertedBytes: split.length - original.length,
      prepends: 0,
    });
    expect(p.held).toBe(false);
    expect(p.held === false && p.why).toMatch(/statements/i);
  });

  it("refuses a patch that changed the file without making it better", () => {
    const cosmetic = `CREATE TABLE t (id int); -- tidied`;
    const p = proveRepair({
      original,
      patched: cosmetic,
      insertedBytes: cosmetic.length - original.length,
      prepends: 0,
    });
    expect(p.held).toBe(false);
    expect(p.held === false && p.why).toMatch(/no fewer/i);
  });

  it("counts a prepended statement as one it expected, not as a broken parse", () => {
    const pol = `CREATE POLICY p ON t FOR SELECT USING (true);`;
    const withDrop = `DROP POLICY IF EXISTS p ON t;\n${pol}`;
    expect(
      proveRepair({
        original: pol,
        patched: withDrop,
        insertedBytes: withDrop.length - pol.length,
        prepends: 1,
      }),
    ).toEqual({ held: true });
    // …and refuses the same patch where the planner forgot to count it.
    expect(
      proveRepair({
        original: pol,
        patched: withDrop,
        insertedBytes: withDrop.length - pol.length,
        prepends: 0,
      }).held,
    ).toBe(false);
  });
});

describe("what it will not patch at a guessed offset", () => {
  it("refuses where the keywords are not in the file as the head reads them", () => {
    // The scanner strips the comment, so the shape is recognised; the bytes
    // do not carry `CREATE TABLE` adjacently, so there is nowhere to put the
    // guard. Measured at zero over the prime's whole corpus, and kept because
    // measured-zero is not cannot-happen.
    const sql = `CREATE /* the widget table */ TABLE t (id int);`;
    const p = plan(sql);
    expect(p.outcome).toBe("no_repair");
    expect(p.patched).toBeNull();
    expect(refusedAs(p)).toEqual(["not_located"]);
    expect(p.refusals[0].why).toMatch(/guessing/i);
  });
});

describe("the vocabulary is derived rather than restated", () => {
  it("every outcome that may be proposed is one the module declares", () => {
    for (const o of OFFERABLE_OUTCOMES) expect(REMEDY_OUTCOMES).toContain(o);
    expect([...REMEDY_OUTCOMES].filter(mayPropose).sort()).toEqual(["healed", "improved"]);
  });

  it("nothing that carries no patch is offerable", () => {
    for (const sql of [
      `create table if not exists t (id int);`,
      `insert into t (a) values (1);`,
      `create type mood as enum ('ok');`,
    ]) {
      const p = plan(sql);
      if (!mayPropose(p.outcome)) expect(p.patched).toBeNull();
    }
    expect(plan(null).patched).toBeNull();
  });

  it("every refusal kind is one the module declares", () => {
    const sql = [
      `create type mood as enum ('ok');`,
      `insert into t (a) values (1);`,
      `create publication pub for all tables;`,
      `create role app_user;`,
    ].join("\n");
    for (const k of refusedAs(plan(sql))) expect(REFUSAL_KINDS).toContain(k);
  });
});

describe("a bigger file, read the way a real one is", () => {
  const sql = [
    `-- 20260901 add the widget module`,
    `CREATE TABLE widgets (id uuid primary key, owner uuid not null);`,
    `ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;`,
    `CREATE POLICY "Owners read widgets" ON widgets FOR SELECT USING (owner = auth.uid());`,
    `CREATE POLICY "Owners write widgets" ON widgets FOR INSERT WITH CHECK (owner = auth.uid());`,
    `CREATE INDEX widgets_owner_idx ON widgets (owner);`,
    `ALTER TABLE widgets ADD CONSTRAINT widgets_owner_fk FOREIGN KEY (owner) REFERENCES auth.users (id);`,
    `DROP POLICY IF EXISTS legacy ON widgets;`,
    `CREATE POLICY legacy ON widgets FOR SELECT USING (true);`,
  ].join("\n");

  it("guards five statements and leaves the one already guarded alone", () => {
    const p = plan(sql);
    expect(p.outcome).toBe("healed");
    expect(p.repairCount).toBe(5);
    expect(p.refusalCount).toBe(0);
    expect(kinds(p).sort()).toEqual(["constraint", "index", "policy", "policy", "table"]);
    assertSoundPatch(sql, p);
  });

  it("names the cost of re-adding a constraint rather than leaving it to review", () => {
    const row = plan(sql).repairs.find((r) => r.kind === "constraint");
    expect(row?.what).toMatch(/revalidat/i);
  });
});

/**
 * Found by driving the planner over shapes the prime's corpus does not
 * contain, then applying both files to a real PostgreSQL 16 and diffing the
 * catalogues. Every one of these passed every check the module and this file
 * had: the patch was a pure insertion, the bytes accounted, the statement
 * count held, and the reading moved. What moved with it was a column default
 * or a comment.
 *
 * The cause was one line: the anchor was matched against the statement's raw
 * SOURCE, which carries comments, string literals and dollar-quoted bodies.
 * The walk knows which stretches are SQL, so it now says (`codeSpans`), and a
 * hit outside them is not an anchor.
 *
 * Measured over the prime's 1,002 migrations before and after: the outcome of
 * every file is unchanged (701 nothing_to_do, 255 healed, 31 improved, 15
 * no_repair). This corrects shapes the corpus has not yet produced.
 */
describe("an anchor is SQL, never a comment or a stored value", () => {
  it("leaves a comment that happens to read like the keywords alone", () => {
    const sql = `ALTER TABLE public.profiles\n  ADD COLUMN a int,  -- add column for tracking\n  ADD COLUMN b int;\n`;
    const p = plan(sql);
    expect(p.outcome).toBe("healed");
    assertSoundPatch(sql, p);
    expect(p.patched).toContain("-- add column for tracking");
    // Both real columns are guarded; the comment's match is not one of them.
    expect(p.patched!.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(2);
  });

  it("takes its casing from the statement's keyword, not from a comment above it", () => {
    /*
      The comment came first in the bytes, so the first match used to be its
      lower-case one — and the guard written into an upper-case statement was
      `ADD COLUMN if not exists a int`, which is the diff noise this module's
      header says the case-matching exists to avoid.
    */
    const sql = `ALTER TABLE public.profiles\n  -- add column for tracking\n  ADD COLUMN a int;\n`;
    const p = plan(sql);
    assertSoundPatch(sql, p);
    expect(p.patched).toContain("ADD COLUMN IF NOT EXISTS a int");
    expect(p.patched).toContain("-- add column for tracking");
  });

  it("refuses a statement whose only match sits inside a quoted value", () => {
    /*
      The block comment breaks up CREATE and TABLE, so the only text matching
      the anchor is in the default. Patched there the file read `healed` while
      a second run still failed `relation "t" already exists` — proved against
      PostgreSQL 16 — and the stored default had changed. Refused now.
    */
    const sql = `CREATE /* note */ TABLE t (n text DEFAULT 'create table zz');\n`;
    const p = plan(sql);
    expect(p.outcome).toBe("no_repair");
    expect(p.patched).toBeNull();
    expect(refusedAs(p)).toEqual(["not_located"]);
  });

  it("leaves a dollar-quoted value alone", () => {
    const sql = `ALTER TABLE t ADD COLUMN note text DEFAULT $tag$add column nope$tag$;\n`;
    const p = plan(sql);
    assertSoundPatch(sql, p);
    expect(p.patched).toContain("$tag$add column nope$tag$");
  });

  it("leaves a comment alone on the drop side too", () => {
    const sql = `ALTER TABLE t\n  DROP COLUMN a,  -- drop column b as well\n  DROP COLUMN b;\n`;
    const p = plan(sql);
    assertSoundPatch(sql, p);
    expect(p.patched).toContain("-- drop column b as well");
  });
});

describe("what the file already is, the repair keeps being", () => {
  it("writes a prepended statement with the file's own line ending", () => {
    const crlf = `CREATE POLICY p ON t FOR SELECT USING (true);\r\nCREATE POLICY q ON t FOR SELECT USING (true);\r\n`;
    const p = plan(crlf);
    assertSoundPatch(crlf, p);
    expect(p.patched).toContain("DROP POLICY IF EXISTS p ON t;\r\n");
    expect(p.patched).not.toMatch(/;\n(?!\r)/);
  });

  it("still writes LF into a file that uses LF", () => {
    const lf = `CREATE POLICY p ON t FOR SELECT USING (true);\n`;
    const p = plan(lf);
    expect(p.patched).toContain("DROP POLICY IF EXISTS p ON t;\n");
    expect(p.patched).not.toContain("\r");
  });
});

describe("the shapes a plan reports are every shape, not the ones that fit", () => {
  /*
    `repairs` and `refusals` stop at REMEDY_ROWS so one file cannot fill a
    page, and 65 of the prime's migrations plan more repairs than that. The
    commit message names the shapes and the pull request warns about
    constraints specifically — both read the kind set, so it has to be the
    whole file's, not the first eight rows'.
  */
  const many = [
    ...Array.from({ length: 9 }, (_, i) => `CREATE POLICY p${i} ON t FOR SELECT USING (true);`),
    `ALTER TABLE t ADD CONSTRAINT t_chk CHECK (x > 0);`,
  ].join("\n");

  it("names a shape that falls past the row cap", () => {
    const p = plan(many);
    expect(p.repairCount).toBe(10);
    expect(p.repairs).toHaveLength(8);
    // The constraint is the tenth repair, so no row shows it.
    expect(kinds(p)).not.toContain("constraint");
    expect(p.repairKinds).toContain("constraint");
    expect(p.repairKinds).toContain("policy");
  });

  it("lists each shape once, in the order the kinds are declared", () => {
    const p = plan(many);
    expect(p.repairKinds).toEqual([...new Set(p.repairKinds)]);
    const order = p.repairKinds.map((k) => REPAIR_KINDS.indexOf(k));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("says nothing about shapes where there is nothing to repair", () => {
    const p = plan(`CREATE TABLE IF NOT EXISTS t (id int);`);
    expect(p.repairKinds).toEqual([]);
    expect(p.refusalKinds).toEqual([]);
  });

  it("names the shapes it refused as well", () => {
    const p = plan(`INSERT INTO t (id) VALUES (1);\nCREATE TYPE mood AS ENUM ('a');`);
    expect(p.refusalKinds).toEqual(["insert", "type"]);
  });
});
