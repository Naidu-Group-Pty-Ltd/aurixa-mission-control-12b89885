import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENFORCE_TABLE_GRANTS,
  TABLE_PRIVILEGES,
  WORST_RELATIONS_CAP,
  compareTableGrants,
  decideTableGrantNotice,
  describeTableGrantNotice,
  parseTablePrivileges,
  summariseTableGrants,
  tableGrantFingerprint,
  tableGrantMode,
  toRelationAcls,
} from "./tablePrivileges.pure";

/*
  Rows as the relation-ACL statement answers them through the Management API,
  copied from the live catalogues on 28 Oct 2026: privilege lists as the
  `string_agg` text, column grants as the parsed `jsonb`, booleans as JSON.
*/
type Row = Record<string, unknown>;
const ALL = "DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE";
const row = (relation: string, over: Row = {}): Row => ({
  relation: `public.${relation}`,
  kind: "r",
  anon: null,
  authenticated: null,
  public: null,
  column_grants: null,
  rls: true,
  options: null,
  open_read: null,
  restricted_read: null,
  maintain: true,
  ...over,
});

const RESOLUTION_COLUMNS = [
  { column: "resolved", grantee: "authenticated", privilege: "UPDATE" },
  { column: "resolved_at", grantee: "authenticated", privilege: "UPDATE" },
  { column: "resolved_by", grantee: "authenticated", privilege: "UPDATE" },
];

// The prime, read back 28 Oct 2026.
const PRIME = {
  clientAddressHistory: row("client_address_history", { open_read: "PUBLIC" }),
  templateComments: row("template_comments", {
    anon: "MAINTAIN,REFERENCES,SELECT,TRIGGER",
    authenticated: "DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE",
    column_grants: RESOLUTION_COLUMNS,
    open_read: "authenticated",
  }),
  pdfImportCostDaily: row("pdf_import_cost_daily", {
    kind: "m",
    anon: "DELETE,INSERT,MAINTAIN,REFERENCES,TRIGGER,TRUNCATE,UPDATE",
    authenticated: "DELETE,INSERT,MAINTAIN,REFERENCES,TRIGGER,TRUNCATE,UPDATE",
    rls: false,
  }),
  suburbDirectory: row("suburb_directory", {
    anon: "MAINTAIN,REFERENCES,SELECT,TRIGGER",
    authenticated: "MAINTAIN,REFERENCES,SELECT,TRIGGER",
    open_read: "PUBLIC",
  }),
};

// npc-client-dashboard as it was before the hand revokes of 28 Oct, and as it
// still is on template_comments and pdf_import_cost_daily.
const CLONE = {
  clientAddressHistory: row("client_address_history", {
    anon: ALL,
    authenticated: ALL,
    open_read: "PUBLIC",
  }),
  templateComments: row("template_comments", {
    anon: ALL,
    authenticated: "DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE",
    column_grants: RESOLUTION_COLUMNS,
    open_read: "authenticated",
  }),
  pdfImportCostDaily: row("pdf_import_cost_daily", {
    kind: "m",
    anon: ALL,
    authenticated: ALL,
    rls: false,
  }),
  suburbDirectory: row("suburb_directory", {
    anon: "MAINTAIN,REFERENCES,SELECT,TRIGGER",
    authenticated: "MAINTAIN,REFERENCES,SELECT,TRIGGER",
    open_read: "PUBLIC",
  }),
};

const read = (rows: Row[]) => toRelationAcls(rows);
const compare = (prime: Row[], clone: Row[]) => {
  const p = read(prime);
  const c = read(clone);
  return compareTableGrants({
    prime: p.relations,
    clone: c.relations,
    maintainOnBoth: p.maintain && c.maintain,
  });
};
const entryFor = (relation: string, c: ReturnType<typeof compare>) =>
  c.entries.find((e) => e.relation === `public.${relation}`);

describe("toRelationAcls", () => {
  it("reads the rows as the catalogue answers them", () => {
    const { relations, maintain } = read([PRIME.templateComments]);
    expect(maintain).toBe(true);
    expect(relations).toEqual([
      {
        relation: "public.template_comments",
        kind: "r",
        grants: {
          anon: ["SELECT", "REFERENCES", "TRIGGER", "MAINTAIN"],
          authenticated: [
            "INSERT",
            "DELETE",
            "TRUNCATE",
            "SELECT",
            "REFERENCES",
            "TRIGGER",
            "MAINTAIN",
          ],
          PUBLIC: [],
        },
        columnGrants: [
          { grantee: "authenticated", privilege: "UPDATE", column: "resolved" },
          { grantee: "authenticated", privilege: "UPDATE", column: "resolved_at" },
          { grantee: "authenticated", privilege: "UPDATE", column: "resolved_by" },
        ],
        rls: true,
        securityInvoker: false,
        openReadFor: ["authenticated"],
        restrictedReadFor: [],
      },
    ]);
  });

  it("tolerates text where JSON was expected, and drops what it does not know", () => {
    const { relations } = read([
      row("odd", {
        anon: "SELECT,REWRITE, insert",
        column_grants: JSON.stringify([
          { column: "a", grantee: "anon", privilege: "SELECT" },
          { column: "b", grantee: "postgres", privilege: "SELECT" },
          { column: "c", grantee: "anon", privilege: "DROP" },
        ]),
        rls: "t",
        open_read: "PUBLIC,service_role",
      }),
    ]);
    expect(relations[0].grants.anon).toEqual(["INSERT", "SELECT"]);
    expect(relations[0].columnGrants).toEqual([
      { grantee: "anon", privilege: "SELECT", column: "a" },
    ]);
    expect(relations[0].rls).toBe(true);
    expect(relations[0].openReadFor).toEqual(["PUBLIC"]);
  });

  it("reads a view's security_invoker from its options", () => {
    const { relations } = read([
      row("v1", { kind: "v", options: "{security_invoker=true}" }),
      row("v2", { kind: "v", options: "{}" }),
    ]);
    expect(relations.map((r) => r.securityInvoker)).toEqual([true, false]);
  });

  it("says the server has MAINTAIN only when every row does, and never for no rows", () => {
    expect(read([row("a"), row("b", { maintain: false })]).maintain).toBe(false);
    expect(read([row("a", { maintain: "true" })]).maintain).toBe(true);
    expect(read([]).maintain).toBe(false);
    expect(read([{ nope: 1 }]).relations).toEqual([]);
  });

  it("parses a privilege list in writes-first order", () => {
    expect(parseTablePrivileges(ALL)).toEqual([...TABLE_PRIVILEGES]);
    expect(parseTablePrivileges(null)).toEqual([]);
    expect(parseTablePrivileges(["select", "Trigger"])).toEqual(["SELECT", "TRIGGER"]);
  });
});

describe("compareTableGrants", () => {
  it("finds the 28 Oct exposure: every privilege on a table whose policy is TO public USING (true)", () => {
    const c = compare([PRIME.clientAddressHistory], [CLONE.clientAddressHistory]);
    expect(c.compared).toBe(1);
    expect(c.entries).toEqual([
      {
        relation: "public.client_address_history",
        kind: "r",
        severity: "write",
        surplus: { anon: [...TABLE_PRIVILEGES], authenticated: [...TABLE_PRIVILEGES] },
        openRead: ["anon", "authenticated"],
        viaPublic: [],
        columnGrantsToKeep: [],
      },
    ]);
  });

  it("does not mistake template_comments' column grants for a table surplus", () => {
    // On all five projects authenticated may UPDATE three columns and holds no
    // table-level UPDATE. The clone's surplus there is anon's writes, and the
    // column grants are neither a surplus nor anything a revoke must spare.
    const c = compare([PRIME.templateComments], [CLONE.templateComments]);
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0].surplus).toEqual({
      anon: ["INSERT", "UPDATE", "DELETE", "TRUNCATE"],
      authenticated: [],
    });
    expect(c.entries[0].columnGrantsToKeep).toEqual([]);
    expect(c.columnSurplus).toEqual([]);
  });

  it("says which of the prime's column grants a table-level revoke would take", () => {
    const clone = {
      ...CLONE.templateComments,
      authenticated: "DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE",
    };
    const e = entryFor("template_comments", compare([PRIME.templateComments], [clone]));
    expect(e?.surplus.authenticated).toEqual(["UPDATE"]);
    expect(e?.columnGrantsToKeep).toEqual([
      "authenticated UPDATE (resolved, resolved_at, resolved_by)",
    ]);
  });

  it("compares column grants apart, and never counts them as table privileges", () => {
    const clone = {
      ...CLONE.suburbDirectory,
      column_grants: [
        { column: "name", grantee: "anon", privilege: "UPDATE" },
        // The prime grants this one on the whole table already.
        { column: "name", grantee: "anon", privilege: "SELECT" },
      ],
    };
    const c = compare([PRIME.suburbDirectory], [clone]);
    expect(c.entries).toEqual([]);
    expect(c.columnSurplus).toEqual(["public.suburb_directory(name) anon UPDATE"]);
    expect(summariseTableGrants(c)).toMatchObject({ surplus: 0, relations: 0, columnSurplus: 1 });
  });

  it("compares MAINTAIN where both servers have it, and on neither side where one does not", () => {
    const prime = row("t", { anon: "SELECT" });
    const clone = row("t", { anon: "MAINTAIN,SELECT" });
    const both = compare([prime], [clone]);
    expect(both.maintainCompared).toBe(true);
    expect(both.entries[0]).toMatchObject({ severity: "other", surplus: { anon: ["MAINTAIN"] } });

    // A server without MAINTAIN cannot hold it, so the difference is nobody's
    // choice: dropped from both sides, and said.
    const older = compare([{ ...prime, maintain: false }], [clone]);
    expect(older.maintainCompared).toBe(false);
    expect(older.entries).toEqual([]);
    const olderStill = compare([{ ...prime, maintain: false }], [row("t", { anon: ALL })]);
    expect(olderStill.entries[0].surplus.anon).not.toContain("MAINTAIN");
  });

  it("ignores a relation only one side holds, and counts it", () => {
    const c = compare(
      [PRIME.suburbDirectory, row("prime_only_table")],
      [CLONE.suburbDirectory, row("crm_variant_table", { anon: ALL })],
    );
    expect(c).toMatchObject({ compared: 1, cloneOnly: 1, primeOnly: 1, entries: [] });
  });

  it("reads a materialised view's surplus SELECT as open: RLS cannot cover it", () => {
    const e = entryFor(
      "pdf_import_cost_daily",
      compare([PRIME.pdfImportCostDaily], [CLONE.pdfImportCostDaily]),
    );
    expect(e).toMatchObject({
      severity: "open_read",
      surplus: { anon: ["SELECT"], authenticated: ["SELECT"] },
      openRead: ["anon", "authenticated"],
    });
  });

  it("reads a view without security_invoker as open, and one with it as filtered", () => {
    const prime = [row("v_owner", { kind: "v" }), row("v_invoker", { kind: "v" })];
    const clone = [
      row("v_owner", { kind: "v", anon: "SELECT", options: "{}" }),
      row("v_invoker", { kind: "v", anon: "SELECT", options: "{security_invoker=true}" }),
    ];
    const c = compare(prime, clone);
    expect(entryFor("v_owner", c)?.severity).toBe("open_read");
    expect(entryFor("v_invoker", c)?.severity).toBe("read");
  });

  it("reads a table with RLS off as open, and a restrictive policy as closing what `true` opened", () => {
    const c = compare(
      [row("no_rls", { rls: false }), row("narrowed"), row("filtered")],
      [
        row("no_rls", { rls: false, anon: "SELECT" }),
        row("narrowed", { anon: "SELECT", open_read: "PUBLIC", restricted_read: "anon" }),
        row("filtered", { anon: "SELECT" }),
      ],
    );
    expect(entryFor("no_rls", c)?.severity).toBe("open_read");
    expect(entryFor("narrowed", c)?.severity).toBe("read");
    expect(entryFor("filtered", c)?.severity).toBe("read");
  });

  it("counts a privilege held through PUBLIC as held, on both sides", () => {
    const c = compare(
      [row("a"), row("b", { public: "SELECT" })],
      [row("a", { public: "SELECT" }), row("b", { anon: "SELECT" })],
    );
    expect(entryFor("a", c)).toMatchObject({
      surplus: { anon: ["SELECT"], authenticated: ["SELECT"] },
      viaPublic: ["SELECT"],
    });
    expect(entryFor("b", c)).toBeUndefined();
  });

  it("ranks writes, then open reads, then other reads, then the rest, anon ahead", () => {
    const c = compare(
      [row("w_auth"), row("w_anon"), row("open"), row("closed"), row("refs")],
      [
        row("w_auth", { authenticated: "INSERT" }),
        row("w_anon", { anon: "UPDATE" }),
        row("open", { anon: "SELECT", open_read: "anon" }),
        row("closed", { anon: "SELECT,TRIGGER" }),
        row("refs", { anon: "REFERENCES" }),
      ],
    );
    expect(c.entries.map((e) => [e.relation.replace("public.", ""), e.severity])).toEqual([
      ["w_anon", "write"],
      ["w_auth", "write"],
      ["open", "open_read"],
      ["closed", "read"],
      ["refs", "other"],
    ]);
  });

  it("puts first, within a class, the relations whose rows privileges alone guard", () => {
    // `finance_agent_contacts` on every clone, 28 Oct 2026: authenticated holds
    // all eight under a `TO public USING (true)` policy, and the prime holds
    // none. It must not sort behind a hundred tables RLS still filters.
    const c = compare(
      [row("a_filtered"), row("finance_agent_contacts"), row("m_open_to_anon")],
      [
        row("a_filtered", { anon: ALL, authenticated: ALL }),
        row("finance_agent_contacts", { authenticated: ALL, open_read: "PUBLIC" }),
        row("m_open_to_anon", { anon: "INSERT,SELECT", open_read: "anon" }),
      ],
    );
    expect(c.entries.map((e) => [e.relation, e.severity, e.openRead])).toEqual([
      ["public.m_open_to_anon", "write", ["anon"]],
      ["public.finance_agent_contacts", "write", ["authenticated"]],
      ["public.a_filtered", "write", []],
    ]);
  });

  it("finds nothing where the clone holds exactly the prime's ACLs", () => {
    const prime = Object.values(PRIME);
    const c = compare(prime, prime);
    expect(c).toMatchObject({ compared: 4, entries: [], columnSurplus: [] });
    expect(tableGrantFingerprint(c)).toBe("");
  });
});

describe("summariseTableGrants", () => {
  const c = compare(Object.values(PRIME), Object.values(CLONE));

  it("counts every surplus privilege once per relation and role", () => {
    const s = summariseTableGrants(c);
    expect(s).toMatchObject({
      compared: 4,
      maintainCompared: true,
      // client_address_history 8 + 8, template_comments 4, pdf_import_cost_daily 1 + 1
      surplus: 22,
      relations: 3,
      byRole: { anon: 13, authenticated: 9 },
      bySeverity: { write: 2, open_read: 1, read: 0, other: 0 },
      columnSurplus: 0,
      unlisted: 0,
    });
    expect(s.byPrivilege).toMatchObject({ SELECT: 4, INSERT: 3, MAINTAIN: 2 });
    expect(s.worst.map((w) => w.relation)).toEqual([
      "public.client_address_history",
      "public.template_comments",
      "public.pdf_import_cost_daily",
    ]);
    expect(s.worst[0]).toEqual({
      relation: "public.client_address_history",
      kind: "r",
      severity: "write",
      anon: "INSERT,UPDATE,DELETE,TRUNCATE,SELECT,REFERENCES,TRIGGER,MAINTAIN",
      authenticated: "INSERT,UPDATE,DELETE,TRUNCATE,SELECT,REFERENCES,TRIGGER,MAINTAIN",
      openRead: ["anon", "authenticated"],
    });
  });

  it("names at most the cap, and says how many it left out", () => {
    const many = Array.from({ length: WORST_RELATIONS_CAP + 3 }, (_, i) => `t${i}`);
    const wide = compare(
      many.map((t) => row(t)),
      many.map((t) => row(t, { anon: "SELECT" })),
    );
    const s = summariseTableGrants(wide);
    expect(s.worst).toHaveLength(WORST_RELATIONS_CAP);
    expect(s.unlisted).toBe(3);
    expect(s.relations).toBe(WORST_RELATIONS_CAP + 3);
  });

  it("fingerprints the surplus whatever order either catalogue listed it in", () => {
    const reversed = compare(Object.values(PRIME).reverse(), Object.values(CLONE).reverse());
    expect(summariseTableGrants(reversed).fingerprint).toBe(summariseTableGrants(c).fingerprint);
    expect(summariseTableGrants(c).fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("plans no statement: a report carries counts and names, never SQL", () => {
    const text = JSON.stringify(summariseTableGrants(c));
    expect(text).not.toMatch(/\b(revoke|grant)\s/i);
  });
});

describe("decideTableGrantNotice", () => {
  it("announces a new surplus, and nothing for the same one again", () => {
    expect(decideTableGrantNotice({ previous: null, current: { fingerprint: "abc" } })).toEqual({
      notify: true,
      kind: "surplus",
      fingerprint: "abc",
    });
    expect(
      decideTableGrantNotice({ previous: "abc", current: { fingerprint: "abc" } }).notify,
    ).toBe(false);
    expect(
      decideTableGrantNotice({ previous: "abc", current: { fingerprint: "def" } }),
    ).toMatchObject({
      notify: true,
      kind: "surplus",
    });
  });

  it("announces a clearance, so the same surplus coming back is a change again", () => {
    expect(decideTableGrantNotice({ previous: "abc", current: { fingerprint: "" } })).toEqual({
      notify: true,
      kind: "cleared",
      fingerprint: "",
    });
    expect(decideTableGrantNotice({ previous: null, current: { fingerprint: "" } }).notify).toBe(
      false,
    );
  });

  it("never reads a clone it could not compare as clean", () => {
    expect(decideTableGrantNotice({ previous: "abc", current: null }).notify).toBe(false);
  });
});

describe("describeTableGrantNotice", () => {
  const s = summariseTableGrants(compare(Object.values(PRIME), Object.values(CLONE)));

  it("names the relations worst first, and says nothing was revoked", () => {
    const n = describeTableGrantNotice("NPC Test", s, "surplus");
    expect(n.severity).toBe("warning");
    expect(n.title).toBe(
      "NPC Test: browser roles hold 22 table privileges the prime does not, on 3 relations",
    );
    expect(n.body).toContain("Report only: nothing was revoked");
    expect(n.body).toContain(
      "- public.client_address_history, table: anon INSERT, UPDATE, DELETE, TRUNCATE, SELECT",
    );
    expect(n.body).toContain("- public.pdf_import_cost_daily, materialised view: anon SELECT");
    expect(n.body.indexOf("client_address_history")).toBeLessThan(
      n.body.indexOf("pdf_import_cost_daily"),
    );
  });

  it("says when it has cleared", () => {
    const n = describeTableGrantNotice("NPC Test", { ...s, compared: 610 }, "cleared");
    expect(n.severity).toBe("success");
    expect(n.title).toBe("NPC Test: browser roles hold no table privilege the prime does not");
    expect(n.body).toContain("610 relations");
  });
});

describe("the enforcement switch", () => {
  it("is off, and the sweep calls itself report-only", () => {
    expect(ENFORCE_TABLE_GRANTS).toBe(false);
    expect(tableGrantMode()).toBe("report_only");
  });

  it("would not pretend to enforce: nothing that writes a grant is built behind it", () => {
    expect(tableGrantMode(true)).toBe("enforcement_not_built");
    const source = readFileSync(join(__dirname, "tablePrivileges.pure.ts"), "utf8");
    // No statement is rendered anywhere in the comparison.
    expect(source).not.toMatch(/`\s*(revoke|grant|alter)\s/i);
  });
});
