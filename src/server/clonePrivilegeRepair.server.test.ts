/**
 * The privilege sweep, driven through fakes of the three things it talks to:
 * the Management API (`runSqlOnProject`), the resolver that names a clone's
 * project, and Mission Control's own `clone_backends` and `notifications`.
 *
 * `schema-introspection.server.ts` is the real one, so the function pass and
 * the table comparison read exactly the statements they read in production,
 * and every statement either would send is recorded here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sql = vi.hoisted(() => ({ runSqlOnProject: vi.fn() }));
vi.mock("./backend-provisioning.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backend-provisioning.server")>()),
  runSqlOnProject: sql.runSqlOnProject,
}));

const prime = vi.hoisted(() => ({
  resolvePrimeBackendRef: vi.fn(async () => "primeprimeprimeprime"),
  ownProjectRef: vi.fn(() => "missioncontrolmcmcmc"),
}));
vi.mock("./prime-backend.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prime-backend.server")>()),
  ...prime,
}));

const target = vi.hoisted(() => ({ resolveCloneSecretTarget: vi.fn() }));
vi.mock("./cloneAllowedOrigins.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cloneAllowedOrigins.server")>()),
  ...target,
}));

const audit = vi.hoisted(() => ({
  notifyOperators: vi.fn(async (_n: Record<string, unknown>) => true),
  writeAuditLog: vi.fn(async (_e: Record<string, unknown>) => true),
}));
vi.mock("./audit.server", () => audit);

// The real comparison, wrapped so one test can make it throw.
const pure = vi.hoisted(() => ({ compareTableGrants: vi.fn() }));
vi.mock("./tablePrivileges.pure", async (importOriginal) => {
  const real = await importOriginal<typeof import("./tablePrivileges.pure")>();
  pure.compareTableGrants.mockImplementation(real.compareTableGrants);
  return { ...real, compareTableGrants: pure.compareTableGrants };
});

const { TABLE_GRANT_REVOKE_ACTION, privilegeSweepIsNoteworthy, reconcileClonePrivileges, rotate } =
  await import("./clonePrivilegeRepair.server");
const { RELATION_ACL_QUERY, isReadOnlySourceQuery } = await import("./schema-introspection.server");
const { TABLE_GRANT_NOTICE_SOURCE } = await import("./tablePrivileges.pure");
const { TABLE_GRANT_ENFORCEMENT } = await import("./tableGrantEnforcement.pure");

const PRIME = "primeprimeprimeprime";
const DASHBOARD = {
  cloneId: "c1",
  cloneName: "NPC Client Dashboard",
  projectRef: "dashdashdashdashdash",
};
const TEST = { cloneId: "c2", cloneName: "NPC Test", projectRef: "testtesttesttesttest" };

type Row = Record<string, unknown>;
const ALL = "DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE";
const rel = (name: string, over: Row = {}): Row => ({
  relation: `public.${name}`,
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

// The prime's ACLs on two of the 28 Oct tables, as its catalogue answers them.
const PRIME_TABLES = [
  rel("client_address_history", { open_read: "PUBLIC" }),
  rel("suburb_directory", {
    anon: "MAINTAIN,REFERENCES,SELECT,TRIGGER",
    authenticated: "MAINTAIN,REFERENCES,SELECT,TRIGGER",
    open_read: "PUBLIC",
  }),
];
// A clone as all four stood before the hand revokes: every privilege, for both roles.
const OPEN_CLONE = [
  rel("client_address_history", { anon: ALL, authenticated: ALL, open_read: "PUBLIC" }),
  rel("suburb_directory", { anon: ALL, authenticated: ALL, open_read: "PUBLIC" }),
];

type Answer = unknown | Error;
let tables: Record<string, Answer>;
let sent: Array<{ ref: string; sql: string }>;
/** What a batch of statements does to a project's catalogue, when a test says. */
let onApply: ((ref: string, statements: string[]) => void) | undefined;

/**
 * The Management API: relation ACLs per project, and no function or view
 * anywhere. The batch helper answers as the clone's would, each statement
 * applied, and a test may change the catalogue as the statements would.
 */
function wireCatalogues() {
  sql.runSqlOnProject.mockImplementation(async (ref: string, text: string) => {
    sent.push({ ref, sql: text });
    if (text === RELATION_ACL_QUERY) {
      const answer = tables[ref];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    }
    const batch = /select aurixa\.apply_ddl_batch\('(.*)'::jsonb/s.exec(text);
    if (batch) {
      const statements = JSON.parse(batch[1].replace(/''/g, "'")) as string[];
      onApply?.(ref, statements);
      return [{ r: { applied: statements.length, failures: [] } }];
    }
    return [];
  });
}

/**
 * Mission Control's own tables: the clone list, and the audit rows that record
 * the notices already delivered, newest first, answered as PostgREST would:
 * only the rows the filters match, and no more than the limit.
 */
function fakeSupabase(
  opts: { ledger?: Row[]; ledgerError?: string; clones?: Row[]; clonesError?: string } = {},
) {
  const reads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let limit: number | undefined;
    const result = () => {
      if (table === "clone_backends") {
        return {
          data: [DASHBOARD, TEST].map((t) => ({
            clone_id: t.cloneId,
            supabase_project_ref: t.projectRef,
          })),
          error: null,
        };
      }
      if (table === "clones") {
        if (opts.clonesError) return { data: null, error: { message: opts.clonesError } };
        return { data: opts.clones ?? [], error: null };
      }
      if (table === "audit_log") {
        if (opts.ledgerError) return { data: null, error: { message: opts.ledgerError } };
        const rows = (opts.ledger ?? []).filter((row) => filters.every(([c, v]) => row[c] === v));
        return { data: rows.slice(0, limit ?? rows.length), error: null };
      }
      return { data: [], error: null };
    };
    const q: Record<string, unknown> = {};
    for (const m of ["select", "not", "order"]) q[m] = () => q;
    q.limit = (n: number) => {
      limit = n;
      return q;
    };
    for (const m of ["eq", "in"]) {
      q[m] = (c: string, v: unknown) => {
        filters.push([c, v]);
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      reads.push({ table, filters: [...filters] });
      return Promise.resolve(result()).then(resolve, reject);
    };
    return q;
  };
  return { client: { from } as never, reads };
}

const run = (
  supabase: ReturnType<typeof fakeSupabase>,
  extra: { dryRun?: boolean; tableGrantScope?: "off" | "demo" | "all" } = {},
) =>
  reconcileClonePrivileges(supabase.client, {
    deadlineAt: Date.now() + 60_000,
    now: 0,
    tableGrantScope: "off",
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  onApply = undefined;
  tables = {
    [PRIME]: PRIME_TABLES,
    [DASHBOARD.projectRef]: OPEN_CLONE,
    [TEST.projectRef]: PRIME_TABLES,
  };
  target.resolveCloneSecretTarget.mockImplementation(async (_db: unknown, id: string) =>
    id === DASHBOARD.cloneId ? DASHBOARD : TEST,
  );
  wireCatalogues();
});

describe("rotate", () => {
  it("starts the sweep at the offset and keeps every clone", () => {
    expect(rotate(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotate(["a", "b", "c"], 4)).toEqual(["b", "c", "a"]);
    expect(rotate(["a", "b", "c"], -1)).toEqual(["c", "a", "b"]);
    expect(rotate([], 3)).toEqual([]);
  });
});

describe("the sweep compares table privileges, and takes none back", () => {
  it("reports each clone's surplus beside the function pass", async () => {
    const report = await run(fakeSupabase());

    expect(report.tables.mode).toBe("report_only");
    const [dashboard, test] = report.tables.clones;
    expect(dashboard).toMatchObject({
      cloneId: "c1",
      read: "ok",
      compared: 2,
      // client_address_history: 8 + 8. suburb_directory: the four writes, twice.
      surplus: 24,
      relations: 2,
      byRole: { anon: 12, authenticated: 12 },
      bySeverity: { write: 2, open_read: 0, read: 0, other: 0 },
    });
    expect(dashboard.read === "ok" && dashboard.worst[0]).toMatchObject({
      relation: "public.client_address_history",
      severity: "write",
      openRead: ["anon", "authenticated"],
    });
    expect(test).toMatchObject({ cloneId: "c2", read: "ok", surplus: 0, fingerprint: "" });
    expect(privilegeSweepIsNoteworthy(report)).toBe(true);
  });

  it("sends nothing to any project but reads, with a surplus on the clone", async () => {
    const report = await run(fakeSupabase());
    expect(report.dryRun).toBe(false);
    expect(report.tables.clones[0]).toMatchObject({ read: "ok", surplus: 24 });

    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(isReadOnlySourceQuery(s.sql), `${s.ref}: ${s.sql.slice(0, 80)}`).toBe(true);
      expect(s.sql).not.toMatch(/\b(revoke|grant)\b/i);
    }
    expect(report.changed.every((c) => c.applied === 0 && c.revokes === 0)).toBe(true);
  });

  it("reads the prime's side once a pass, and each clone's once", async () => {
    await run(fakeSupabase());
    const tableReads = sent.filter((s) => s.sql === RELATION_ACL_QUERY).map((s) => s.ref);
    expect(tableReads.sort()).toEqual([DASHBOARD.projectRef, PRIME, TEST.projectRef].sort());
  });

  it("says a clone it could not read was not read, and never reports it clean", async () => {
    tables[TEST.projectRef] = new Error("SQL execution failed on testtesttesttesttest: 500");
    const report = await run(fakeSupabase());
    expect(report.tables.clones[1]).toMatchObject({
      cloneId: "c2",
      read: "unreadable",
      side: "clone",
      error: expect.stringContaining("500"),
    });
    expect(report.tables.clones[1]).not.toHaveProperty("surplus");
    expect(privilegeSweepIsNoteworthy(report)).toBe(true);
    // Only the clone that was read is announced.
    expect(audit.notifyOperators).toHaveBeenCalledTimes(1);
  });

  it("reads a body it does not recognise as unread, not as a clone with no tables", async () => {
    tables[TEST.projectRef] = { unexpected: true };
    const report = await run(fakeSupabase());
    expect(report.tables.clones[1]).toMatchObject({ read: "unreadable", side: "clone" });
  });

  it("marks every clone unreadable when the prime cannot be read", async () => {
    tables[PRIME] = new Error("SQL execution failed on primeprimeprimeprime: 503");
    const report = await run(fakeSupabase());
    expect(report.tables.clones.map((c) => [c.cloneId, c.read, "side" in c && c.side])).toEqual([
      ["c1", "unreadable", "prime"],
      ["c2", "unreadable", "prime"],
    ]);
    expect(audit.notifyOperators).not.toHaveBeenCalled();
  });

  it("says a comparison that threw failed, and still reports the pass", async () => {
    pure.compareTableGrants.mockImplementationOnce(() => {
      throw new Error("comparison fault");
    });
    const report = await run(fakeSupabase());
    expect(report.tables.clones[0]).toMatchObject({
      cloneId: "c1",
      read: "failed",
      error: "comparison fault",
    });
    expect(report.tables.clones[1]).toMatchObject({ cloneId: "c2", read: "ok" });
    expect(report.considered).toBe(2);
    expect(privilegeSweepIsNoteworthy(report)).toBe(true);
  });

  it("ships taking back on the demo first (the owner, 31 Oct 2026)", () => {
    expect(TABLE_GRANT_ENFORCEMENT).toBe("demo");
  });
});

describe("telling a person", () => {
  it("raises one notice for a clone whose surplus is new", async () => {
    const report = await run(fakeSupabase());
    expect(report.tables.notices).toEqual({ raised: 1, failed: 0, ledger: "read" });
    expect(audit.notifyOperators).toHaveBeenCalledTimes(1);
    const notice = audit.notifyOperators.mock.calls[0][0] as Record<string, unknown>;
    expect(notice).toMatchObject({
      kind: "drift_medium",
      severity: "warning",
      cloneId: "c1",
      url: "/clones/c1",
      title:
        "NPC Client Dashboard: browser roles hold 24 table privileges the prime does not, on 2 relations",
      metadata: {
        source: TABLE_GRANT_NOTICE_SOURCE,
        mode: "report_only",
        surplus: 24,
        fingerprint: report.tables.clones[0].read === "ok" && report.tables.clones[0].fingerprint,
      },
    });
  });

  it("does not raise the same surplus again", async () => {
    const first = await run(fakeSupabase());
    const fingerprint = first.tables.clones[0].read === "ok" && first.tables.clones[0].fingerprint;
    vi.clearAllMocks();
    wireCatalogues();
    const supabase = fakeSupabase({
      ledger: [{ action: TABLE_GRANT_NOTICE_SOURCE, entity_id: "c1", metadata: { fingerprint } }],
    });
    const second = await run(supabase);
    expect(audit.notifyOperators).not.toHaveBeenCalled();
    expect(second.tables.notices).toEqual({ raised: 0, failed: 0, ledger: "read" });
    // It asked for exactly its own record, one clone at a time.
    const ledgerReads = supabase.reads.filter((r) => r.table === "audit_log");
    expect(ledgerReads.map((r) => r.filters)).toEqual([
      [
        ["action", TABLE_GRANT_NOTICE_SOURCE],
        ["entity_id", "c1"],
      ],
      [
        ["action", TABLE_GRANT_NOTICE_SOURCE],
        ["entity_id", "c2"],
      ],
    ]);
  });

  it("records each notice it delivered in the audit log, and reads no notification back", async () => {
    // An operator may purge read notifications. Read from there, a purged
    // notice would read as never told, and the same surplus would be
    // announced again as new (Codex, #387).
    const supabase = fakeSupabase();
    const report = await run(supabase);
    const fingerprint =
      report.tables.clones[0].read === "ok" ? report.tables.clones[0].fingerprint : null;
    expect(audit.writeAuditLog).toHaveBeenCalledWith({
      action: TABLE_GRANT_NOTICE_SOURCE,
      entityType: "clone",
      entityId: "c1",
      metadata: {
        fingerprint,
        kind: "surplus",
        mode: "report_only",
        surplus: 24,
        relations: 2,
        columnSurplus: 0,
      },
    });
    expect(supabase.reads.some((r) => r.table === "notifications")).toBe(false);
  });

  it("keeps the surplus told once a purge took its notice, and announces its clearance", async () => {
    const first = await run(fakeSupabase());
    const fingerprint = first.tables.clones[0].read === "ok" && first.tables.clones[0].fingerprint;
    const told = [
      { action: TABLE_GRANT_NOTICE_SOURCE, entity_id: "c1", metadata: { fingerprint } },
    ];

    // The notice itself is gone; the audit row is what the sweep reads.
    vi.clearAllMocks();
    wireCatalogues();
    await run(fakeSupabase({ ledger: told }));
    expect(audit.notifyOperators).not.toHaveBeenCalled();

    // The surplus is then taken back: the clearance is still announced.
    vi.clearAllMocks();
    tables[DASHBOARD.projectRef] = PRIME_TABLES;
    wireCatalogues();
    const report = await run(fakeSupabase({ ledger: told }));
    expect(audit.notifyOperators).toHaveBeenCalledTimes(1);
    expect(audit.notifyOperators.mock.calls[0][0]).toMatchObject({
      cloneId: "c1",
      severity: "success",
      metadata: { fingerprint: "" },
    });
    expect(report.tables.notices).toEqual({ raised: 1, failed: 0, ledger: "read" });
  });

  it("does not record a notice the database refused, so the next pass raises it again", async () => {
    audit.notifyOperators.mockResolvedValueOnce(false);
    const report = await run(fakeSupabase());
    expect(report.tables.notices).toEqual({ raised: 0, failed: 1, ledger: "read" });
    expect(audit.writeAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: TABLE_GRANT_NOTICE_SOURCE }),
    );
  });

  it("reads each clone's own last row, however much another clone has been told since", async () => {
    // Newest first, as the query orders them. c1's history is long; c2's one
    // row, a surplus that has since been taken back, is older than all of it.
    // A shared window over every clone's rows would lose it, and with it the
    // clearance.
    const first = await run(fakeSupabase());
    const fingerprint = first.tables.clones[0].read === "ok" && first.tables.clones[0].fingerprint;
    vi.clearAllMocks();
    wireCatalogues();
    const ledger = [
      { action: TABLE_GRANT_NOTICE_SOURCE, entity_id: "c1", metadata: { fingerprint } },
      ...Array.from({ length: 600 }, (_, i) => ({
        action: TABLE_GRANT_NOTICE_SOURCE,
        entity_id: "c1",
        metadata: { fingerprint: `older-${i}` },
      })),
      {
        action: TABLE_GRANT_NOTICE_SOURCE,
        entity_id: "c2",
        metadata: { fingerprint: "an-earlier-surplus" },
      },
    ];
    const report = await run(fakeSupabase({ ledger }));
    expect(audit.notifyOperators).toHaveBeenCalledTimes(1);
    expect(audit.notifyOperators.mock.calls[0][0]).toMatchObject({
      cloneId: "c2",
      severity: "success",
    });
    expect(report.tables.notices).toEqual({ raised: 1, failed: 0, ledger: "read" });
  });

  it("announces a clearance, so the same surplus coming back is a change again", async () => {
    const report = await run(
      fakeSupabase({
        ledger: [
          {
            action: TABLE_GRANT_NOTICE_SOURCE,
            entity_id: "c2",
            metadata: { fingerprint: "an-earlier-surplus" },
          },
        ],
      }),
    );
    const cleared = audit.notifyOperators.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((n) => n.cloneId === "c2");
    expect(cleared).toMatchObject({
      severity: "success",
      title: "NPC Test: browser roles hold no table privilege the prime does not",
      metadata: { fingerprint: "" },
    });
    expect(report.tables.notices.raised).toBe(2);
  });

  it("raises nothing when it cannot read what it raised before", async () => {
    const report = await run(fakeSupabase({ ledgerError: "connection reset" }));
    expect(audit.notifyOperators).not.toHaveBeenCalled();
    expect(report.tables.notices).toEqual({
      raised: 0,
      failed: 0,
      ledger: "unreadable",
      error: "connection reset",
    });
    expect(privilegeSweepIsNoteworthy(report)).toBe(true);
  });

  it("tells nobody on a dry run, and answers the caller instead", async () => {
    const report = await run(fakeSupabase(), { dryRun: true });
    expect(audit.notifyOperators).not.toHaveBeenCalled();
    expect(report.tables.notices.ledger).toBe("dry_run");
    expect(report.tables.clones[0]).toMatchObject({ read: "ok", surplus: 24 });
    expect(privilegeSweepIsNoteworthy(report)).toBe(false);
  });
});

describe("privilegeSweepIsNoteworthy", () => {
  it("is quiet once every clone matches the prime", async () => {
    tables[DASHBOARD.projectRef] = PRIME_TABLES;
    const report = await run(fakeSupabase());
    expect(report.tables.clones.every((c) => c.read === "ok" && c.surplus === 0)).toBe(true);
    expect(privilegeSweepIsNoteworthy(report)).toBe(false);
  });
});

describe("taking the surplus back (the owner, 31 Oct 2026)", () => {
  /** NPC Client Dashboard tagged as the demo: no Stripe customer, no plan. */
  const DEMO_RECORD = {
    id: DASHBOARD.cloneId,
    billing_stripe_customer_id: null,
    entitled_plan_slug: null,
    tags: ["demo"],
  };
  const CUSTOMER_RECORD = {
    id: TEST.cloneId,
    billing_stripe_customer_id: "cus_123",
    entitled_plan_slug: "launch",
    tags: [],
  };
  const writesTo = (ref: string) =>
    sent.filter((s) => s.ref === ref && !isReadOnlySourceQuery(s.sql)).map((s) => s.sql);
  const revokeRows = () =>
    audit.writeAuditLog.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((e) => e.action === TABLE_GRANT_REVOKE_ACTION);

  beforeEach(() => {
    // `clearAllMocks` keeps an implementation a test set; this block's tests
    // each start from an audit log that files every row.
    audit.writeAuditLog.mockImplementation(async () => true);
    // The statements do what they say: the clone ends holding what the prime holds.
    onApply = (ref) => {
      tables[ref] = PRIME_TABLES;
    };
  });

  it("takes a demo's surplus back, files the undo first, and reports the reading after", async () => {
    const report = await run(fakeSupabase({ clones: [DEMO_RECORD, CUSTOMER_RECORD] }), {
      tableGrantScope: "demo",
    });

    expect(report.tables.mode).toBe("enforcing_demo");
    const dashboard = report.tables.clones[0];
    expect(dashboard).toMatchObject({
      cloneId: "c1",
      read: "ok",
      surplus: 0,
      relations: 0,
      enforcement: {
        done: "revoked",
        privileges: 24,
        relations: 2,
        applied: 2,
        failed: 0,
        before: { surplus: 24, relations: 2 },
      },
    });

    // One statement a relation, each a `do` block, revoking only the surplus.
    const batch = writesTo(DASHBOARD.projectRef).find((t) =>
      t.startsWith("select aurixa.apply_ddl_batch("),
    );
    expect(batch).toBeDefined();
    expect(batch).toContain(
      "revoke INSERT, UPDATE, DELETE, TRUNCATE, SELECT, REFERENCES, TRIGGER, MAINTAIN on public.client_address_history from anon;",
    );
    expect(batch).toContain(
      "revoke INSERT, UPDATE, DELETE, TRUNCATE on public.suburb_directory from authenticated;",
    );
    expect(batch).not.toMatch(/suburb_directory from anon;[^"]*SELECT/);

    // The undo is filed before anything is sent, and the outcome after.
    const rows = revokeRows();
    expect(rows.map((r) => (r.metadata as { stage: string }).stage)).toEqual([
      "planned",
      "applied",
    ]);
    const planned = rows[0].metadata as {
      relations: Array<{ relation: string; inverse: string[] }>;
    };
    expect(planned.relations.map((r) => r.relation).sort()).toEqual([
      "public.client_address_history",
      "public.suburb_directory",
    ]);
    expect(planned.relations[0].inverse[0]).toMatch(/^grant .* to anon;$/);
    const plannedAt =
      audit.writeAuditLog.mock.invocationCallOrder[
        audit.writeAuditLog.mock.calls.findIndex(
          (c) => (c[0] as { metadata?: { stage?: string } }).metadata?.stage === "planned",
        )
      ];
    const firstBatchAt =
      sql.runSqlOnProject.mock.invocationCallOrder[
        sql.runSqlOnProject.mock.calls.findIndex((c) =>
          String(c[1]).startsWith("select aurixa.apply_ddl_batch("),
        )
      ];
    expect(plannedAt).toBeLessThan(firstBatchAt);

    // The customer is not a demo: it is read, listed, and sent nothing.
    expect(writesTo(TEST.projectRef)).toEqual([]);
    expect(privilegeSweepIsNoteworthy(report)).toBe(true);
  });

  it("lists what would be taken back on a clone outside the scope, and sends it nothing", async () => {
    const report = await run(
      fakeSupabase({ clones: [{ ...DEMO_RECORD, tags: [] }, CUSTOMER_RECORD] }),
      { tableGrantScope: "demo" },
    );
    const dashboard = report.tables.clones[0];
    expect(dashboard).toMatchObject({ read: "ok", surplus: 24 });
    expect(dashboard.read === "ok" && dashboard.wouldRevoke).toEqual([
      "public.client_address_history: anon INSERT, UPDATE, DELETE, TRUNCATE, SELECT, REFERENCES, TRIGGER, MAINTAIN; authenticated INSERT, UPDATE, DELETE, TRUNCATE, SELECT, REFERENCES, TRIGGER, MAINTAIN",
      "public.suburb_directory: anon INSERT, UPDATE, DELETE, TRUNCATE; authenticated INSERT, UPDATE, DELETE, TRUNCATE",
    ]);
    expect(dashboard.read === "ok" && dashboard.enforcement).toBeUndefined();
    expect(writesTo(DASHBOARD.projectRef)).toEqual([]);
    expect(revokeRows()).toEqual([]);
  });

  it("takes nothing back when the records that decide the demo scope cannot be read", async () => {
    const report = await run(
      fakeSupabase({ clones: [DEMO_RECORD], clonesError: "permission denied" }),
      { tableGrantScope: "demo" },
    );
    expect(report.tables.scopeUnread).toBe("permission denied");
    expect(writesTo(DASHBOARD.projectRef)).toEqual([]);
    expect(privilegeSweepIsNoteworthy(report)).toBe(true);
  });

  it("takes nothing back when the undo cannot be filed", async () => {
    audit.writeAuditLog.mockImplementation(async (e: Record<string, unknown>) =>
      e.action === TABLE_GRANT_REVOKE_ACTION ? false : true,
    );
    const report = await run(fakeSupabase(), { tableGrantScope: "all" });
    expect(report.tables.clones[0]).toMatchObject({
      read: "ok",
      surplus: 24,
      enforcement: { done: "withheld", why: expect.stringContaining("could not be filed") },
    });
    expect(writesTo(DASHBOARD.projectRef)).toEqual([]);
  });

  it("plans and sends nothing on a dry run", async () => {
    const report = await run(fakeSupabase(), { tableGrantScope: "all", dryRun: true });
    expect(report.tables.clones[0]).toMatchObject({
      read: "ok",
      surplus: 24,
      enforcement: { done: "planned", privileges: 24, relations: 2 },
    });
    const planned = report.tables.clones[0];
    expect(
      planned.read === "ok" &&
        planned.enforcement?.done === "planned" &&
        planned.enforcement.sample[0],
    ).toMatch(/^do \$mc_table_grants\$/);
    for (const s of sent) expect(isReadOnlySourceQuery(s.sql), s.sql.slice(0, 60)).toBe(true);
    expect(revokeRows()).toEqual([]);
  });

  it("keeps the reading before, and says so, when the clone cannot be read after", async () => {
    onApply = (ref) => {
      tables[ref] = new Error("SQL execution failed: 503");
    };
    const report = await run(fakeSupabase(), { tableGrantScope: "all" });
    expect(report.tables.clones[0]).toMatchObject({
      read: "ok",
      surplus: 24,
      enforcement: {
        done: "revoked",
        errors: [expect.stringContaining("could not be read after")],
      },
    });
  });

  it("reaches every clone at `all`, and leaves one already matching alone", async () => {
    const report = await run(fakeSupabase(), { tableGrantScope: "all" });
    expect(report.tables.mode).toBe("enforcing_all");
    expect(report.tables.clones[0]).toMatchObject({ cloneId: "c1", surplus: 0 });
    expect(report.tables.clones[1]).toMatchObject({ cloneId: "c2", surplus: 0 });
    expect(report.tables.clones[1]).not.toHaveProperty("enforcement");
    expect(writesTo(TEST.projectRef)).toEqual([]);
  });
});
