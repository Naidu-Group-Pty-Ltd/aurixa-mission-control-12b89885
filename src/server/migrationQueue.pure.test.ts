import { describe, it, expect } from "vitest";
import {
  validateSubmissions,
  judgeBatch,
  stripSqlComments,
  MAX_SQL_BYTES,
  MAX_BATCH,
  type MigrationSubmission,
  type QueueRow,
} from "./migrationQueue.pure";

const sub = (over: Partial<MigrationSubmission> = {}): MigrationSubmission => ({
  version: "20260828030000",
  name: "20260828030000_migration_queue.sql",
  sql: "create table public.x ();",
  ...over,
});

describe("validateSubmissions", () => {
  it("accepts a well-formed migration", () => {
    const r = validateSubmissions([sub()]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(1);
  });

  it("orders the batch the way the drain will run it", () => {
    const r = validateSubmissions([
      sub({ version: "20260828030002", name: "20260828030002_c.sql" }),
      sub({ version: "20260828030000", name: "20260828030000_a.sql" }),
      sub({ version: "20260828030001", name: "20260828030001_b.sql" }),
    ]);
    expect(r.accepted.map((a) => a.version)).toEqual([
      "20260828030000",
      "20260828030001",
      "20260828030002",
    ]);
  });

  /**
   * The version is the row's identity AND the ledger's. Letting the two
   * disagree is how a file is recorded under somebody else's identity and then
   * skipped forever on every later replay.
   */
  it("refuses a version that disagrees with the filename", () => {
    const r = validateSubmissions([
      sub({ version: "20260828030000", name: "20260828039999_other.sql" }),
    ]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected[0].reason).toContain("does not match the filename");
  });

  it.each([
    ["nope.sql", "filename must be"],
    ["20260828030000_no_extension", "filename must be"],
    ["2026_short.sql", "filename must be"],
  ])("refuses filename %s", (name, why) => {
    expect(validateSubmissions([sub({ name })]).rejected[0].reason).toContain(why);
  });

  it("refuses a non-14-digit version", () => {
    const r = validateSubmissions([sub({ version: "123", name: "20260828030000_a.sql" })]);
    expect(r.rejected[0].reason).toContain("14 digits");
  });

  it("refuses a duplicate version inside one request", () => {
    const r = validateSubmissions([sub(), sub({ name: "20260828030000_again.sql" })]);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected[0].reason).toContain("appears twice");
  });

  it("refuses empty sql", () => {
    expect(validateSubmissions([sub({ sql: "   \n " })]).rejected[0].reason).toContain("empty");
  });

  it("refuses sql past the size limit", () => {
    const r = validateSubmissions([sub({ sql: "-".repeat(MAX_SQL_BYTES + 1) })]);
    expect(r.rejected[0].reason).toContain("over the");
  });

  it("refuses a batch larger than the cap, without pretending to judge it", () => {
    const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) =>
      sub({
        version: `2026082803${String(i).padStart(4, "0")}`,
        name: `2026082803${String(i).padStart(4, "0")}_x.sql`,
      }),
    );
    const r = validateSubmissions(many);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
  });

  /**
   * The drain applies a batch inside one transaction, so CONCURRENTLY raises
   * `25001`. Refusing here turns a confusing drain-time failure an hour later
   * into a red merge with the file named.
   */
  it("refuses a statement the drain physically cannot run", () => {
    const r = validateSubmissions([sub({ sql: "create index concurrently idx on public.t (a);" })]);
    expect(r.rejected[0].reason).toContain("CONCURRENTLY");
  });

  it("judges the code, never the prose", () => {
    // A guard that fires on a comment reports a contradiction about correct
    // code, and those are the guards people learn to silence.
    const r = validateSubmissions([
      sub({
        sql: "-- Deliberately NOT concurrently: the drain runs in one transaction.\ncreate index idx on public.t (a);",
      }),
    ]);
    expect(r.rejected).toEqual([]);
  });

  it("reports every bad file in a batch, not just the first", () => {
    const r = validateSubmissions([
      sub({ name: "bad.sql" }),
      sub({ version: "20260828030001", name: "20260828030001_ok.sql" }),
      sub({ version: "20260828030002", name: "20260828030002_x.sql", sql: "" }),
    ]);
    expect(r.rejected).toHaveLength(2);
    expect(r.accepted).toHaveLength(1);
  });
});

describe("stripSqlComments", () => {
  it("removes line and block comments", () => {
    expect(stripSqlComments("select 1; -- concurrently\n/* concurrently */ select 2;")).not.toMatch(
      /concurrently/,
    );
  });
});

describe("judgeBatch", () => {
  const row = (over: Partial<QueueRow> = {}): QueueRow => ({
    version: "20260828030000",
    name: "20260828030000_a.sql",
    status: "queued",
    attempts: 0,
    error: null,
    ...over,
  });

  it("settles when every version has applied", () => {
    const v = judgeBatch(["20260828030000"], [row({ status: "applied" })]);
    expect(v).toMatchObject({ settled: true, applied: ["20260828030000"], pending: [] });
  });

  it("settles on failure too, and carries the row", () => {
    const v = judgeBatch(
      ["20260828030000"],
      [row({ status: "failed", error: "42P07 relation already exists", attempts: 3 })],
    );
    expect(v.settled).toBe(true);
    expect(v.failed[0].error).toContain("42P07");
  });

  it("does not settle while anything is queued or running", () => {
    expect(judgeBatch(["20260828030000"], [row({ status: "queued" })]).settled).toBe(false);
    expect(judgeBatch(["20260828030000"], [row({ status: "running" })]).settled).toBe(false);
  });

  /**
   * A version the queue has never heard of is a LOST enqueue, not a slow one.
   * Reporting the two as one is how a caller waits out a timeout for something
   * that was never going to arrive.
   */
  it("separates a lost enqueue from a pending one", () => {
    const v = judgeBatch(["20260828030000", "20260828030001"], [row({ status: "queued" })]);
    expect(v.pending).toEqual(["20260828030000"]);
    expect(v.missing).toEqual(["20260828030001"]);
    expect(v.settled).toBe(false);
  });
});

/*
  A MIGRATION THE PLATFORM ALREADY APPLIED IS RECORDED, NEVER RE-EXECUTED.

  `aurixa.drain_schema_migrations()` ran `EXECUTE v_row.sql` unconditionally.
  The `INSERT … WHERE NOT EXISTS` immediately after reads like an
  already-applied guard and is not one: it prevents a duplicate ledger ROW, not
  a duplicate APPLY.

  Measured 12 Sep 2026: 141 of 268 migrations were authored by Lovable, which
  applies them before the file reaches this repository. Three postdate this
  queue and two were replayed — harmlessly, and by luck, as `20260909010118`'s
  own header admits. The third says "DO NOT REPLAY" and would double a billing
  rollup.
*/
describe("a migration applied out of band", () => {
  it("is carried as a declaration and defaults to false", () => {
    expect(validateSubmissions([sub()]).accepted[0].alreadyApplied).toBe(false);
    expect(validateSubmissions([sub({ alreadyApplied: true })]).accepted[0].alreadyApplied).toBe(
      true,
    );
    expect(validateSubmissions([sub({ alreadyApplied: false })]).accepted[0].alreadyApplied).toBe(
      false,
    );
  });

  it("refuses a non-boolean rather than coercing it", () => {
    // Every non-boolean a caller might send by accident is TRUTHY — `"false"`,
    // `"0"`, `1` — so a coercion would silently SKIP a migration that needed
    // applying and report it done. The refusal is the whole safety of the flag.
    for (const bad of ["true", "false", "0", 1, 0, null, {}, []]) {
      const r = validateSubmissions([sub({ alreadyApplied: bad as never })]);
      expect(r.accepted).toHaveLength(0);
      expect(r.rejected[0].reason).toContain("alreadyApplied must be a boolean");
    }
  });

  it("is judged like every other field — one bad flag does not hide a good file", () => {
    const r = validateSubmissions([
      sub({ version: "20260828030000", name: "20260828030000_a.sql", alreadyApplied: true }),
      sub({
        version: "20260828030001",
        name: "20260828030001_b.sql",
        alreadyApplied: "yes" as never,
      }),
    ]);
    expect(r.accepted.map((a) => a.version)).toEqual(["20260828030000"]);
    expect(r.rejected).toHaveLength(1);
  });
});

describe("the `recorded` status", () => {
  const row = (over: Partial<QueueRow> = {}): QueueRow => ({
    version: "20260828030000",
    name: "20260828030000_a.sql",
    status: "queued",
    attempts: 0,
    error: null,
    ...over,
  });

  it("is terminal, so a waiting caller settles on it", () => {
    const v = judgeBatch(["20260828030000"], [row({ status: "recorded" })]);
    expect(v.settled).toBe(true);
    expect(v.pending).toEqual([]);
  });

  /*
    The rule that makes the status worth having. "this queue ran it" and "this
    queue was told it had already run" are different facts, and the moment they
    matter is when a migration's `@asserts` claim later fails and somebody has
    to know whether anything ever executed that file here.
  */
  it("is never reported as `applied`", () => {
    const v = judgeBatch(["20260828030000"], [row({ status: "recorded" })]);
    expect(v.applied).toEqual([]);
    expect(v.recorded).toEqual(["20260828030000"]);
  });

  it("settles a mixed batch and keeps the two apart", () => {
    const v = judgeBatch(
      ["20260828030000", "20260828030001"],
      [
        row({ status: "recorded" }),
        row({ version: "20260828030001", name: "20260828030001_b.sql", status: "applied" }),
      ],
    );
    expect(v.settled).toBe(true);
    expect(v.recorded).toEqual(["20260828030000"]);
    expect(v.applied).toEqual(["20260828030001"]);
  });

  it("does not rescue a failure, and a failure still halts", () => {
    const v = judgeBatch(
      ["20260828030000", "20260828030001"],
      [
        row({ status: "recorded" }),
        row({ version: "20260828030001", name: "20260828030001_b.sql", status: "failed" }),
      ],
    );
    expect(v.recorded).toEqual(["20260828030000"]);
    expect(v.failed).toHaveLength(1);
  });
});
