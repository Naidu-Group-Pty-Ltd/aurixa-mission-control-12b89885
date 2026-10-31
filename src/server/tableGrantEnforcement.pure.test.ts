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
  surplusLines,
} from "./tableGrantEnforcement.pure";
import { compareTableGrants, type RelationAcl, type TablePrivilege } from "./tablePrivileges.pure";

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

describe("surplusLines", () => {
  it("names each relation's surplus, by role", () => {
    const comparison = compareTableGrants({
      prime: [rel("public.t")],
      clone: [
        rel("public.t", {
          grants: { anon: ["SELECT", "INSERT"], authenticated: ["DELETE"], PUBLIC: [] },
        }),
      ],
      maintainOnBoth: true,
    });
    expect(surplusLines(comparison.entries)).toEqual([
      "public.t: anon INSERT, SELECT; authenticated DELETE",
    ]);
  });
});
