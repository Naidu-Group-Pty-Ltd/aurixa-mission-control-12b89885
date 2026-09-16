import { describe, it, expect } from "vitest";
import {
  parseAssertions,
  parseSupersedes,
  hasAnyAssertion,
  formatAssertion,
  isPubliclyCheckable,
  type Assertion,
} from "./migrationAssertions.pure";

const ok = (sql: string): Assertion[] => {
  const r = parseAssertions(sql);
  if (!r.ok) throw new Error(`expected parse to succeed: ${r.errors.join("; ")}`);
  return r.assertions;
};
const errs = (sql: string): string[] => {
  const r = parseAssertions(sql);
  if (r.ok) throw new Error("expected parse to fail");
  return r.errors;
};

describe("parseAssertions", () => {
  it("reads every supported kind", () => {
    const a = ok(`
-- @asserts table:clone_reference_syncs
-- @asserts column:clone_backends.reference_sync_started_at
-- @asserts rpc:cron_delivery_health
-- @asserts cron:reference-data-sync-hourly
-- @asserts rows:mirror_exclusions>=17
-- @asserts enum:clone_backend_status
create table x();
`);
    expect(a).toEqual([
      { kind: "table", table: "clone_reference_syncs" },
      { kind: "column", table: "clone_backends", column: "reference_sync_started_at" },
      { kind: "rpc", fn: "cron_delivery_health" },
      { kind: "cron", jobname: "reference-data-sync-hourly" },
      { kind: "rows", table: "mirror_exclusions", atLeast: 17 },
      { kind: "enum", type: "clone_backend_status" },
    ]);
  });

  it("ignores SQL that merely mentions the word", () => {
    expect(ok(`select '@asserts table:not_a_claim';`)).toEqual([]);
    expect(ok(`create table asserts_log();`)).toEqual([]);
  });

  it("tolerates a written-out rpc signature but keeps only the name", () => {
    expect(ok(`-- @asserts rpc:cron_delivery_health(_since_hours integer)`)).toEqual([
      { kind: "rpc", fn: "cron_delivery_health" },
    ]);
  });

  it("accepts indented and loosely spaced claims", () => {
    expect(ok(`   --   @asserts   table:foo  `)).toEqual([{ kind: "table", table: "foo" }]);
  });

  /**
   * A malformed claim must fail, never be skipped. A line nobody can parse
   * looks like coverage in a listing and checks nothing at run time — the exact
   * shape of guard failure this repository keeps finding.
   */
  describe("refuses rather than skips", () => {
    it.each([
      ["-- @asserts table", "expected `<kind>:<target>`"],
      ["-- @asserts table:", "has no target"],
      ["-- @asserts table:Clone_Backends", "lower_snake"],
      ["-- @asserts table:public.clones", "lower_snake"],
      ["-- @asserts column:clones", "expected `column:<table>.<column>`"],
      ["-- @asserts column:.deploy_url", "expected `column:<table>.<column>`"],
      ["-- @asserts cron:Not_Kebab", "kebab-case"],
      ["-- @asserts rows:clones", "expected `rows:<table>>=<n>`"],
      ["-- @asserts rows:clones>17", "expected `rows:<table>>=<n>`"],
      ["-- @asserts widget:foo", "unknown kind `widget`"],
    ])("%s", (line, why) => {
      const e = errs(line);
      expect(e).toHaveLength(1);
      expect(e[0]).toContain(why);
    });

    it("reports every bad line, not just the first", () => {
      expect(errs(`-- @asserts table\n-- @asserts widget:x`)).toHaveLength(2);
    });

    it("fails the whole file when one claim is malformed", () => {
      // Partial credit would let a typo silently reduce coverage.
      const r = parseAssertions(`-- @asserts table:good\n-- @asserts table:Bad`);
      expect(r.ok).toBe(false);
    });
  });

  describe("`none` must carry a reason", () => {
    it("accepts a real explanation", () => {
      expect(ok(`-- @asserts none:documentation only — creates no object`)).toEqual([
        { kind: "none", reason: "documentation only — creates no object" },
      ]);
    });

    it("rejects a rubber stamp", () => {
      // `none:n/a` is how an escape hatch becomes the default.
      for (const stamp of ["none:n/a", "none:none", "none:nothing", "none:-"]) {
        expect(errs(`-- @asserts ${stamp}`)[0]).toContain("needs a reason");
      }
    });
  });
});

describe("hasAnyAssertion", () => {
  it("separates `wrote it wrong` from `did not write one`", () => {
    // A typo and an omission are different failures with different remedies,
    // so the guard must be able to tell them apart.
    expect(hasAnyAssertion("-- @asserts table:Bad")).toBe(true);
    expect(parseAssertions("-- @asserts table:Bad").ok).toBe(false);
    expect(hasAnyAssertion("create table x();")).toBe(false);
  });
});

describe("formatAssertion", () => {
  it("round-trips every kind through the parser", () => {
    const all: Assertion[] = [
      { kind: "table", table: "t" },
      { kind: "column", table: "t", column: "c" },
      { kind: "rpc", fn: "f" },
      { kind: "cron", jobname: "a-job" },
      { kind: "rows", table: "t", atLeast: 3 },
      { kind: "enum", type: "e" },
      { kind: "none", reason: "nothing observable to check here" },
    ];
    for (const a of all) {
      expect(ok(`-- @asserts ${formatAssertion(a)}`)).toEqual([a]);
    }
  });
});

describe("isPubliclyCheckable", () => {
  it("marks cron and enum unanswerable at zero privilege", () => {
    // cron.job and pg_type are not exposed by PostgREST (PGRST106), so CI —
    // which holds only the publishable key — must report them as unchecked
    // rather than guess. A checker that drops what it cannot see reports
    // coverage it does not have.
    expect(isPubliclyCheckable({ kind: "cron", jobname: "a-job" })).toBe(false);
    expect(isPubliclyCheckable({ kind: "enum", type: "e" })).toBe(false);
  });

  it("marks table, column, rpc and rows checkable", () => {
    expect(isPubliclyCheckable({ kind: "table", table: "t" })).toBe(true);
    expect(isPubliclyCheckable({ kind: "column", table: "t", column: "c" })).toBe(true);
    expect(isPubliclyCheckable({ kind: "rpc", fn: "f" })).toBe(true);
    expect(isPubliclyCheckable({ kind: "rows", table: "t", atLeast: 1 })).toBe(true);
  });

  it("never treats `none` as evidence of anything", () => {
    expect(isPubliclyCheckable({ kind: "none", reason: "no observable effect at all" })).toBe(
      false,
    );
  });
});

describe("parseSupersedes", () => {
  it("reads a well-formed retirement in the claim's exact source form", () => {
    const r = parseSupersedes(
      "-- @asserts rows:prime_secret_forwards>=44\n" +
        "-- @supersedes 20260906100000_didit_fleet_forward.sql:rows:prime_secret_forwards>=45\n" +
        "select 1;\n",
    );
    expect(r).toEqual({
      ok: true,
      supersedes: [
        {
          migration: "20260906100000_didit_fleet_forward.sql",
          assertion: "rows:prime_secret_forwards>=45",
        },
      ],
    });
  });

  it("a malformed retirement is an error, never a skip — a directive nobody can parse retires nothing", () => {
    const r = parseSupersedes("-- @supersedes didit_fleet_forward:rows:x>=45\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain("@supersedes");
  });

  it("a file with no retirements parses to an empty list", () => {
    expect(parseSupersedes("-- @asserts table:t\n")).toEqual({ ok: true, supersedes: [] });
  });
});
