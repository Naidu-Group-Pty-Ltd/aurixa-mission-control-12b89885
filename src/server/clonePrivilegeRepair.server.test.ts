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
  writeAuditLog: vi.fn(async () => {}),
}));
vi.mock("./audit.server", () => audit);

// The real comparison, wrapped so one test can make it throw.
const pure = vi.hoisted(() => ({ compareTableGrants: vi.fn() }));
vi.mock("./tablePrivileges.pure", async (importOriginal) => {
  const real = await importOriginal<typeof import("./tablePrivileges.pure")>();
  pure.compareTableGrants.mockImplementation(real.compareTableGrants);
  return { ...real, compareTableGrants: pure.compareTableGrants };
});

const { privilegeSweepIsNoteworthy, reconcileClonePrivileges, rotate } =
  await import("./clonePrivilegeRepair.server");
const { RELATION_ACL_QUERY, isReadOnlySourceQuery } = await import("./schema-introspection.server");
const { ENFORCE_TABLE_GRANTS, TABLE_GRANT_NOTICE_SOURCE } = await import("./tablePrivileges.pure");

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

/** The Management API: relation ACLs per project, and no function or view anywhere. */
function wireCatalogues() {
  sql.runSqlOnProject.mockImplementation(async (ref: string, text: string) => {
    sent.push({ ref, sql: text });
    if (text === RELATION_ACL_QUERY) {
      const answer = tables[ref];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    }
    return [];
  });
}

/**
 * Mission Control's own tables: the clone list, and the audit rows that record
 * the notices already delivered, newest first, answered as PostgREST would:
 * only the rows the filters match, and no more than the limit.
 */
function fakeSupabase(opts: { ledger?: Row[]; ledgerError?: string } = {}) {
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

const run = (supabase: ReturnType<typeof fakeSupabase>, extra: { dryRun?: boolean } = {}) =>
  reconcileClonePrivileges(supabase.client, {
    deadlineAt: Date.now() + 60_000,
    now: 0,
    ...extra,
  });

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
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

  it("is off: the switch an enforcement would sit behind", () => {
    expect(ENFORCE_TABLE_GRANTS).toBe(false);
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
