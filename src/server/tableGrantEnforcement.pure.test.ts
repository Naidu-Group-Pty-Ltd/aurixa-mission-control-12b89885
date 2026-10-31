/**
 * The statements that take a clone's surplus table privileges back.
 *
 * Every shape here is one the catalogues answered: a relation where the clone
 * gives the browser roles everything and the prime gives `authenticated`
 * SELECT, a privilege held through PUBLIC, and `template_comments`, where the
 * prime gives `authenticated` UPDATE on three columns and none at table level.
 */
import { describe, expect, it } from "vitest";
import {
  TABLE_GRANT_ENFORCEMENT,
  enforcesTableGrants,
  planTableGrantRevokes,
  revokeLines,
} from "./tableGrantEnforcement.pure";
import {
  compareTableGrants,
  type BrowserGrantee,
  type RelationAcl,
  type TablePrivilege,
} from "./tablePrivileges.pure";

const ALL: TablePrivilege[] = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "SELECT",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
];

function rel(relation: string, over: Partial<RelationAcl> = {}): RelationAcl {
  return {
    relation,
    kind: "r",
    grants: { anon: [], authenticated: [], PUBLIC: [] },
    columnGrants: [],
    rls: true,
    securityInvoker: false,
    openReadFor: [],
    restrictedReadFor: [],
    ...over,
  };
}

function plan(prime: RelationAcl[], clone: RelationAcl[], maintainOnBoth = true) {
  const comparison = compareTableGrants({ prime, clone, maintainOnBoth });
  return planTableGrantRevokes({ entries: comparison.entries, prime, clone, maintainOnBoth });
}

describe("planTableGrantRevokes", () => {
  it("takes back exactly the surplus, per role, in one statement a relation", () => {
    const p = plan(
      [
        rel("public.client_fact_finds", {
          grants: { anon: [], authenticated: ["SELECT"], PUBLIC: [] },
        }),
      ],
      [rel("public.client_fact_finds", { grants: { anon: ALL, authenticated: ALL, PUBLIC: [] } })],
    );
    expect(p.privileges).toBe(15);
    expect(p.refused).toEqual([]);
    const [r] = p.relations;
    expect(r.revoke).toEqual({
      anon: ALL,
      authenticated: [
        "INSERT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
        "MAINTAIN",
      ],
      PUBLIC: [],
    });
    expect(r.statement).toBe(
      [
        "do $mc_table_grants$",
        "begin",
        "  revoke INSERT, UPDATE, DELETE, TRUNCATE, SELECT, REFERENCES, TRIGGER, MAINTAIN on public.client_fact_finds from anon;",
        "  revoke INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN on public.client_fact_finds from authenticated;",
        "end",
        "$mc_table_grants$",
      ].join("\n"),
    );
    // The prime's SELECT for authenticated is never touched.
    expect(r.statement).not.toMatch(/SELECT[^;]*from authenticated/);
    expect(r.inverse).toEqual([
      "grant INSERT, UPDATE, DELETE, TRUNCATE, SELECT, REFERENCES, TRIGGER, MAINTAIN on public.client_fact_finds to anon;",
      "grant INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN on public.client_fact_finds to authenticated;",
    ]);
  });

  it("revokes from PUBLIC what the prime does not grant PUBLIC, and grants directly what the prime grants a role", () => {
    const p = plan(
      [rel("public.t", { grants: { anon: [], authenticated: ["SELECT"], PUBLIC: [] } })],
      [rel("public.t", { grants: { anon: [], authenticated: [], PUBLIC: ["SELECT", "INSERT"] } })],
    );
    const [r] = p.relations;
    expect(r.revoke).toEqual({ anon: [], authenticated: [], PUBLIC: ["INSERT", "SELECT"] });
    // authenticated held SELECT only through PUBLIC; the prime gives it directly.
    expect(r.grantDirect).toEqual([{ grantee: "authenticated", privileges: ["SELECT"] }]);
    expect(r.statement).toContain("revoke INSERT, SELECT on public.t from public;");
    expect(r.statement).toContain("grant SELECT on public.t to authenticated;");
    expect(r.statement.indexOf("revoke")).toBeLessThan(r.statement.indexOf("grant SELECT"));
    // Undone in reverse: PUBLIC back, then the direct grant taken away.
    expect(r.inverse).toEqual([
      "grant INSERT, SELECT on public.t to public;",
      "revoke SELECT on public.t from authenticated;",
    ]);
  });

  it("grants the prime's column grants back after a table-level revoke takes them", () => {
    // template_comments: the prime gives authenticated UPDATE on three columns
    // and none at table level; a clone gave it UPDATE on the whole table.
    const columns = ["body", "resolved", "updated_at"].map((column) => ({
      grantee: "authenticated" as const,
      privilege: "UPDATE" as const,
      column,
    }));
    const p = plan(
      [
        rel("public.template_comments", {
          grants: { anon: [], authenticated: ["SELECT", "INSERT"], PUBLIC: [] },
          columnGrants: columns,
        }),
      ],
      [
        rel("public.template_comments", {
          grants: { anon: [], authenticated: ["SELECT", "INSERT", "UPDATE"], PUBLIC: [] },
          columnGrants: [
            ...columns,
            { grantee: "authenticated", privilege: "UPDATE", column: "author_id" },
          ],
        }),
      ],
    );
    const [r] = p.relations;
    expect(r.revoke.authenticated).toEqual(["UPDATE"]);
    expect(r.regrantColumns).toEqual([
      {
        grantee: "authenticated",
        privilege: "UPDATE",
        columns: ["body", "resolved", "updated_at"],
      },
    ]);
    expect(r.removedColumnGrants).toEqual([
      { grantee: "authenticated", privilege: "UPDATE", column: "author_id" },
    ]);
    expect(r.statement).toContain(
      'grant UPDATE ("body", "resolved", "updated_at") on public.template_comments to authenticated;',
    );
    expect(r.inverse).toEqual([
      "grant UPDATE on public.template_comments to authenticated;",
      'grant UPDATE ("author_id") on public.template_comments to authenticated;',
    ]);
  });

  it("leaves a role the prime's column grants when the clone gave it the privilege only through PUBLIC", () => {
    // Codex on #472: the clone gives everyone UPDATE through PUBLIC, and the
    // prime gives `authenticated` UPDATE on one column. Revoking PUBLIC's
    // UPDATE alone would leave `authenticated` nothing.
    const p = plan(
      [
        rel("public.notes", {
          grants: { anon: [], authenticated: ["SELECT"], PUBLIC: [] },
          columnGrants: [{ grantee: "authenticated", privilege: "UPDATE", column: "body" }],
        }),
      ],
      [
        rel("public.notes", {
          grants: { anon: [], authenticated: ["SELECT"], PUBLIC: ["UPDATE"] },
        }),
      ],
    );
    const [r] = p.relations;
    expect(r.revoke).toEqual({ anon: [], authenticated: [], PUBLIC: ["UPDATE"] });
    expect(r.regrantColumns).toEqual([
      { grantee: "authenticated", privilege: "UPDATE", columns: ["body"] },
    ]);
    expect(r.statement).toContain("revoke UPDATE on public.notes from public;");
    expect(r.statement).toContain('grant UPDATE ("body") on public.notes to authenticated;');
    // Undone exactly: the column grant this added is taken away again.
    expect(r.inverse).toEqual([
      'revoke UPDATE ("body") on public.notes from authenticated;',
      "grant UPDATE on public.notes to public;",
    ]);
  });

  it("keeps a role the column the prime gives it through PUBLIC, granted to the role alone", () => {
    // Codex on #472: the prime gives PUBLIC UPDATE on one column, and the
    // clone gave `authenticated` UPDATE on the whole table without that
    // column grant. Revoking the table-level UPDATE alone would leave it
    // none; granting the column to PUBLIC would give `anon` a column it
    // never held here.
    const p = plan(
      [
        rel("public.notes", {
          grants: { anon: [], authenticated: ["SELECT"], PUBLIC: [] },
          columnGrants: [{ grantee: "PUBLIC", privilege: "UPDATE", column: "body" }],
        }),
      ],
      [
        rel("public.notes", {
          grants: { anon: [], authenticated: ["SELECT", "UPDATE"], PUBLIC: [] },
        }),
      ],
    );
    const [r] = p.relations;
    expect(r.revoke).toEqual({ anon: [], authenticated: ["UPDATE"], PUBLIC: [] });
    expect(r.regrantColumns).toEqual([
      { grantee: "authenticated", privilege: "UPDATE", columns: ["body"] },
    ]);
    expect(r.statement).toContain("revoke UPDATE on public.notes from authenticated;");
    expect(r.statement).toContain('grant UPDATE ("body") on public.notes to authenticated;');
    expect(r.statement).not.toMatch(/to (public|anon);/);
    expect(r.inverse).toEqual([
      'revoke UPDATE ("body") on public.notes from authenticated;',
      "grant UPDATE on public.notes to authenticated;",
    ]);
  });

  it("gives a role back its own column grants when undoing a direct grant made for PUBLIC's", () => {
    // Codex on #472: the clone gave SELECT through PUBLIC, and `authenticated`
    // two column grants of its own. Undoing the direct grant revokes SELECT
    // from `authenticated`, which takes those two with it.
    const p = plan(
      [rel("public.t", { grants: { anon: [], authenticated: ["SELECT"], PUBLIC: [] } })],
      [
        rel("public.t", {
          grants: { anon: [], authenticated: [], PUBLIC: ["SELECT"] },
          columnGrants: [
            { grantee: "authenticated", privilege: "SELECT", column: "a" },
            { grantee: "authenticated", privilege: "SELECT", column: "b" },
          ],
        }),
      ],
    );
    const [r] = p.relations;
    expect(r.grantDirect).toEqual([{ grantee: "authenticated", privileges: ["SELECT"] }]);
    expect(r.regrantColumns).toEqual([]);
    expect(r.inverse).toEqual([
      "grant SELECT on public.t to public;",
      "revoke SELECT on public.t from authenticated;",
      'grant SELECT ("a", "b") on public.t to authenticated;',
    ]);
  });

  it("leaves MAINTAIN alone where either server lacks it", () => {
    const p = plan(
      [rel("public.t")],
      [
        rel("public.t", {
          grants: { anon: ["SELECT", "MAINTAIN"], authenticated: [], PUBLIC: [] },
        }),
      ],
      false,
    );
    expect(p.relations[0].revoke.anon).toEqual(["SELECT"]);
    expect(p.relations[0].statement).not.toContain("MAINTAIN");
  });

  it("refuses a relation name the catalogue would not render, and writes nothing for it", () => {
    const bad = "public.x; drop table y; --";
    const p = planTableGrantRevokes({
      entries: [
        {
          relation: bad,
          kind: "r",
          severity: "write",
          surplus: { anon: ["INSERT"], authenticated: [] },
          openRead: [],
          viaPublic: [],
          columnGrantsToKeep: [],
        },
      ],
      prime: [rel(bad)],
      clone: [rel(bad, { grants: { anon: ["INSERT"], authenticated: [], PUBLIC: [] } })],
      maintainOnBoth: true,
    });
    expect(p.relations).toEqual([]);
    expect(p.refused).toEqual([
      { relation: bad, why: "not a relation name the catalogue renders" },
    ]);
  });

  it("accepts a quoted name, and never lets a name end its block", () => {
    const name = 'public."odd$mc_table_grants$name"';
    const p = plan(
      [rel(name)],
      [rel(name, { grants: { anon: ["SELECT"], authenticated: [], PUBLIC: [] } })],
    );
    const [r] = p.relations;
    expect(r.statement.startsWith("do $mc_table_grants_1$\n")).toBe(true);
    expect(r.statement.endsWith("\n$mc_table_grants_1$")).toBe(true);
  });

  it("plans nothing for a clone that already matches", () => {
    const same = [
      rel("public.t", { grants: { anon: ["SELECT"], authenticated: ["SELECT"], PUBLIC: [] } }),
    ];
    expect(plan(same, same)).toEqual({ relations: [], privileges: 0, refused: [] });
  });
});

describe("enforcesTableGrants", () => {
  const demo = { billing_stripe_customer_id: null, entitled_plan_slug: null, tags: ["demo"] };

  it("reaches only a demo at `demo`, by the shared rule", () => {
    expect(enforcesTableGrants("demo", demo)).toBe(true);
    expect(enforcesTableGrants("demo", { ...demo, tags: [] })).toBe(false);
    expect(enforcesTableGrants("demo", { ...demo, entitled_plan_slug: "launch" })).toBe(false);
    expect(enforcesTableGrants("demo", { ...demo, billing_stripe_customer_id: "cus_1" })).toBe(
      false,
    );
  });

  it("never reaches a clone whose record was not read, short of `all`", () => {
    expect(enforcesTableGrants("demo", null)).toBe(false);
    expect(enforcesTableGrants("all", null)).toBe(true);
    expect(enforcesTableGrants("off", demo)).toBe(false);
  });

  it("ships at `demo`", () => {
    expect(TABLE_GRANT_ENFORCEMENT).toBe("demo");
  });
});

describe("revokeLines", () => {
  it("names what each relation's statement revokes, by grantee, PUBLIC's included", () => {
    const p = plan(
      [
        rel("public.t"),
        rel("public.u", { grants: { anon: [], authenticated: ["SELECT"], PUBLIC: [] } }),
      ],
      [
        rel("public.t", {
          grants: { anon: ["SELECT", "INSERT"], authenticated: ["DELETE"], PUBLIC: [] },
        }),
        // Both roles hold INSERT directly, so the comparison's `viaPublic`
        // is empty, and PUBLIC's INSERT is revoked all the same.
        rel("public.u", {
          grants: { anon: ["INSERT"], authenticated: ["SELECT", "INSERT"], PUBLIC: ["INSERT"] },
        }),
      ],
    );
    expect(revokeLines(p)).toEqual([
      "public.t: anon INSERT, SELECT; authenticated DELETE",
      "public.u: anon INSERT; authenticated INSERT; PUBLIC INSERT",
    ]);
  });

  it("says which relations the plan refused", () => {
    const bad = "public.x; drop table y; --";
    const p = plan(
      [rel(bad)],
      [rel(bad, { grants: { anon: ["INSERT"], authenticated: [], PUBLIC: [] } })],
    );
    expect(revokeLines(p)).toEqual([
      "public.x; drop table y; --: refused, not a relation name the catalogue renders",
    ]);
  });
});

/**
 * A model of what Postgres does with these statements, checked against every
 * rule above on relations drawn at random. A table-level REVOKE takes the
 * grantee's column grants of that privilege with it; a column REVOKE touches
 * only that column; a GRANT adds and never removes. Seeded, so a failure
 * names a case that reproduces.
 */
describe("the plan, run on a model of the catalogue", () => {
  const PRIVS: TablePrivilege[] = ["INSERT", "UPDATE", "SELECT", "REFERENCES"];
  const COLUMNS = ["a", "b", "c"];
  const GRANTEES: BrowserGrantee[] = ["anon", "authenticated", "PUBLIC"];
  const NAME = "public.t";

  type State = {
    table: Record<BrowserGrantee, Set<TablePrivilege>>;
    columns: Record<BrowserGrantee, Map<TablePrivilege, Set<string>>>;
  };

  const stateOf = (acl: RelationAcl): State => {
    const s: State = {
      table: { anon: new Set(), authenticated: new Set(), PUBLIC: new Set() },
      columns: { anon: new Map(), authenticated: new Map(), PUBLIC: new Map() },
    };
    for (const g of GRANTEES) for (const x of acl.grants[g]) s.table[g].add(x);
    for (const cg of acl.columnGrants) {
      const m = s.columns[cg.grantee];
      if (!m.has(cg.privilege)) m.set(cg.privilege, new Set());
      m.get(cg.privilege)!.add(cg.column);
    }
    return s;
  };

  const aclOf = (s: State): RelationAcl =>
    rel(NAME, {
      grants: {
        anon: PRIVS.filter((x) => s.table.anon.has(x)),
        authenticated: PRIVS.filter((x) => s.table.authenticated.has(x)),
        PUBLIC: PRIVS.filter((x) => s.table.PUBLIC.has(x)),
      },
      columnGrants: GRANTEES.flatMap((g) =>
        PRIVS.flatMap((x) =>
          [...(s.columns[g].get(x) ?? [])]
            .sort()
            .map((column) => ({ grantee: g, privilege: x, column })),
        ),
      ),
    });

  const granteeOf = (sql: string): BrowserGrantee =>
    sql === "public" ? "PUBLIC" : (sql as BrowserGrantee);

  /** Runs one line the planner writes, and fails on any other. */
  function run(s: State, line: string) {
    const column = line.match(/^(grant|revoke) (\w+) \(([^)]*)\) on \S+ (?:to|from) (\w+);$/);
    if (column) {
      const [, verb, x, list, g] = column;
      const cols = list.split(", ").map((c) => c.slice(1, -1));
      const m = s.columns[granteeOf(g)];
      if (!m.has(x as TablePrivilege)) m.set(x as TablePrivilege, new Set());
      for (const c of cols) {
        if (verb === "grant") m.get(x as TablePrivilege)!.add(c);
        else m.get(x as TablePrivilege)!.delete(c);
      }
      return;
    }
    const table = line.match(/^(grant|revoke) ([A-Z, ]+) on \S+ (?:to|from) (\w+);$/);
    if (!table) throw new Error(`not a line the planner writes: ${line}`);
    const [, verb, list, g] = table;
    for (const x of list.split(", ") as TablePrivilege[]) {
      if (verb === "grant") s.table[granteeOf(g)].add(x);
      else {
        s.table[granteeOf(g)].delete(x);
        s.columns[granteeOf(g)].delete(x);
      }
    }
  }

  const statementLines = (statement: string) =>
    statement
      .split("\n")
      .slice(2, -2)
      .map((l) => l.trim());

  /** A browser role's access to one column, every path Postgres has. */
  const reaches = (s: State, r: "anon" | "authenticated", x: TablePrivilege, col: string) =>
    s.table[r].has(x) ||
    s.table.PUBLIC.has(x) ||
    (s.columns[r].get(x)?.has(col) ?? false) ||
    (s.columns.PUBLIC.get(x)?.has(col) ?? false);
  const publicReaches = (s: State, x: TablePrivilege, col: string) =>
    s.table.PUBLIC.has(x) || (s.columns.PUBLIC.get(x)?.has(col) ?? false);

  // mulberry32
  function random(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function draw(next: () => number, publicOdds: number): RelationAcl {
    const pick = (odds: number) => PRIVS.filter(() => next() < odds);
    return rel(NAME, {
      grants: { anon: pick(0.3), authenticated: pick(0.45), PUBLIC: pick(publicOdds) },
      columnGrants: GRANTEES.flatMap((g) =>
        PRIVS.flatMap((x) =>
          COLUMNS.filter(() => next() < 0.15).map((column) => ({
            grantee: g,
            privilege: x,
            column,
          })),
        ),
      ),
    });
  }

  it("takes back the surplus, keeps every column the prime gives, gives nobody more, and undoes exactly", () => {
    const next = random(472);
    let planned = 0;
    for (let i = 0; i < 4000; i++) {
      const prime = draw(next, 0.05);
      const clone = draw(next, 0.25);
      const p = plan([prime], [clone]);
      if (!p.relations.length) continue;
      planned += 1;
      const [r] = p.relations;
      const before = stateOf(clone);
      const primeState = stateOf(prime);
      const after = stateOf(clone);
      for (const line of statementLines(r.statement)) run(after, line);
      const where = `case ${i}: prime ${JSON.stringify(prime)} clone ${JSON.stringify(clone)}`;

      // The table-level surplus is gone.
      const left = compareTableGrants({
        prime: [prime],
        clone: [aclOf(after)],
        maintainOnBoth: true,
      });
      expect(left.entries, where).toEqual([]);

      for (const x of PRIVS) {
        for (const col of COLUMNS) {
          for (const role of ["anon", "authenticated"] as const) {
            const had = reaches(before, role, x, col);
            const has = reaches(after, role, x, col);
            // Nobody gains a column.
            if (has) expect(had, `${where}: ${role} gained ${x} on ${col}`).toBe(true);
            // Nobody loses a column the prime gives them.
            if (had && reaches(primeState, role, x, col)) {
              expect(has, `${where}: ${role} lost ${x} on ${col}`).toBe(true);
            }
          }
          // PUBLIC, which every other role reaches through, the same.
          const had = publicReaches(before, x, col);
          const has = publicReaches(after, x, col);
          if (has) expect(had, `${where}: PUBLIC gained ${x} on ${col}`).toBe(true);
          if (had && publicReaches(primeState, x, col)) {
            expect(has, `${where}: PUBLIC lost ${x} on ${col}`).toBe(true);
          }
        }
      }

      // The inverse puts the catalogue back exactly as it was.
      for (const line of r.inverse) run(after, line);
      expect(aclOf(after), where).toEqual(aclOf(before));
    }
    // Enough of the draws plan something for the check to mean anything.
    expect(planned).toBeGreaterThan(2000);
  });
});
