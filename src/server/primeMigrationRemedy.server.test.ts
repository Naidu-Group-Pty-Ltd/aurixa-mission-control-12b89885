/**
 * The module that changes a repository, exercised on what it SENDS.
 *
 * Every property here is invisible in any output. A refusal that works is a
 * transcript with nothing in it, so the transcript is what is asserted — the
 * same shape `primeMigrationDispatch.server.test.ts` takes, and for the same
 * reason: "nothing was changed" is a claim about requests that were never
 * made, and reading a returned message cannot tell it from a claim that is
 * merely worded well.
 *
 * The first block is the one that matters most. A migration the prime has
 * already run must not change in the repository, and the only evidence that
 * this holds is that no blob, no tree, no commit and no pull request left
 * this process.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

const state = vi.hoisted(() => ({
  /** Every REST route this module asked for, in order. */
  routes: [] as Array<{ route: string; params: Record<string, unknown> }>,
  /** Every git/pulls helper it called, in order. */
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  audits: [] as Array<Record<string, unknown>>,
  /** The prime repo, or null for "not configured". */
  source: { owner: "n", repo: "prime", branch: "main" } as null | {
    owner: string;
    repo: string;
    branch: string;
  },
  metas: [
    {
      id: "20260901010000",
      name: "20260901010000_x.sql",
      path: "supabase/migrations/20260901010000_x.sql",
    },
  ],
  sql: "CREATE POLICY p ON t FOR SELECT USING (true);" as string | null,
  sqlThrows: null as null | Error,
  /** What `schema_migrations` answers. */
  applied: ["20260101000000"] as string[],
  ledgerThrows: false,
  /** Is the repair branch already there, and is a pull request open from it? */
  branchExists: false,
  openPr: null as null | { number: number; html_url: string },
}));

vi.mock("./github-app.server", () => ({
  getAppOctokit: () => ({
    request: async (route: string, params: Record<string, unknown>) => {
      state.routes.push({ route, params });
      if (route.includes("GET /repos/{owner}/{repo}/pulls")) {
        return { data: state.openPr ? [state.openPr] : [] };
      }
      if (route.includes("git/ref")) {
        const ref = String(params.ref ?? "");
        if (ref.startsWith("heads/mission-control/")) {
          if (state.branchExists) return { data: { object: { sha: "branchsha" } } };
          const err = new Error("Not Found") as Error & { status?: number };
          err.status = 404;
          throw err;
        }
        return { data: { object: { sha: "basesha" } } };
      }
      return { data: {} };
    },
    git: {
      // A read, so it does not join `state.calls` — that list is the writes.
      getCommit: async () => ({ data: { tree: { sha: "basetreesha" } } }),
      createBlob: async (a: Record<string, unknown>) => {
        state.calls.push({ name: "createBlob", args: a });
        return { data: { sha: "blobsha" } };
      },
      createTree: async (a: Record<string, unknown>) => {
        state.calls.push({ name: "createTree", args: a });
        return { data: { sha: "treesha" } };
      },
      createCommit: async (a: Record<string, unknown>) => {
        state.calls.push({ name: "createCommit", args: a });
        return { data: { sha: "commitsha" } };
      },
      createRef: async (a: Record<string, unknown>) => {
        state.calls.push({ name: "createRef", args: a });
        return { data: {} };
      },
    },
    pulls: {
      create: async (a: Record<string, unknown>) => {
        state.calls.push({ name: "pulls.create", args: a });
        return { data: { number: 7, html_url: "https://github.com/n/prime/pull/7" } };
      },
    },
  }),
}));

vi.mock("./audit.server", () => ({
  writeAuditLog: async (a: Record<string, unknown>) => {
    state.audits.push(a);
  },
}));

vi.mock("./prime-backend.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./prime-backend.server")>();
  return {
    ...real,
    resolvePrimeSource: async () => state.source,
    resolvePrimeBackendRef: async () => "primeref",
    openPrimeMigrationCorpus: async () => ({
      metas: state.metas,
      sourceSha: "headsha0000000",
      bodyIdentity: () => null,
      sizeOf: () => 100,
      loadSql: async () => {
        if (state.sqlThrows) throw state.sqlThrows;
        return state.sql ?? "";
      },
      openSqlStream: async () => (async function* () {})(),
    }),
  };
});

vi.mock("./backend-provisioning.server", () => ({
  runSqlOnProject: async () => {
    if (state.ledgerThrows) throw new Error("the project refused");
    return state.applied.map((version) => ({ version }));
  },
}));

const { openPrimeMigrationRepair, planPrimeMigrationRepair, repairBranchName, repairProposalBody } =
  await import("./primeMigrationRemedy.server");

const V = "20260901010000";

beforeEach(() => {
  state.routes = [];
  state.calls = [];
  state.audits = [];
  state.source = { owner: "n", repo: "prime", branch: "main" };
  state.metas = [{ id: V, name: `${V}_x.sql`, path: `supabase/migrations/${V}_x.sql` }];
  state.sql = "CREATE POLICY p ON t FOR SELECT USING (true);";
  state.sqlThrows = null;
  state.applied = ["20260101000000"];
  state.ledgerThrows = false;
  state.branchExists = false;
  state.openPr = null;
});

/** Everything that would change the repository. Empty is the assertion. */
const writes = () => state.calls.map((c) => c.name);

describe("a migration the prime has already run is never edited", () => {
  it("refuses it, and names the rule rather than a missing setting", async () => {
    state.applied = ["20260101000000", V];
    const { report } = await planPrimeMigrationRepair({} as never, V);
    expect(report.proposable).toBe(false);
    expect(report.blocked).toMatch(/already run/i);
    expect(report.blocked).toMatch(/schema_migrations/);
  });

  it("writes nothing at all when the act is attempted anyway", async () => {
    state.applied = [V];
    const r = await openPrimeMigrationRepair({} as never, V, "u1");
    expect(r.ok).toBe(false);
    expect(writes()).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("a ledger that could not be read blocks it too — a failed read is not an absent row", async () => {
    state.ledgerThrows = true;
    const { report } = await planPrimeMigrationRepair({} as never, V);
    expect(report.proposable).toBe(false);
    expect(report.blocked).toMatch(/could not be read/i);
  });

  it("an empty ledger blocks it, because it is no authority for what has run", async () => {
    state.applied = [];
    const { report } = await planPrimeMigrationRepair({} as never, V);
    expect(report.proposable).toBe(false);
    expect(report.blocked).toMatch(/no applied migrations/i);
  });
});

describe("what else it refuses before touching anything", () => {
  it("a version two files carry — the remedy is a rename, not a patch", async () => {
    state.metas = [
      { id: V, name: `${V}_a.sql`, path: `supabase/migrations/${V}_a.sql` },
      { id: V, name: `${V}_b.sql`, path: `supabase/migrations/${V}_b.sql` },
    ];
    const { report } = await planPrimeMigrationRepair({} as never, V);
    expect(report.blocked).toMatch(/renumber|rename/i);
    expect(report.proposable).toBe(false);
    // And the ledger was never asked, because the answer could not matter.
    expect(state.routes.filter((r) => r.route.includes("git/ref"))).toEqual([]);
  });

  it("a body it could not read", async () => {
    state.sqlThrows = new Error("the blob went missing");
    const { report } = await planPrimeMigrationRepair({} as never, V);
    expect(report.plan.outcome).toBe("unreadable");
    expect(report.blocked).toMatch(/could not be read/i);
    expect(report.proposable).toBe(false);
  });

  it("a file that needs nothing — and it does not spend a ledger read finding out", async () => {
    state.sql = "create table if not exists t (id int);";
    const { report } = await planPrimeMigrationRepair({} as never, V);
    expect(report.plan.outcome).toBe("nothing_to_do");
    expect(report.blocked).toBeNull();
    expect(report.proposable).toBe(false);
  });

  it("no prime configured at all", async () => {
    state.source = null;
    await expect(planPrimeMigrationRepair({} as never, V)).rejects.toThrow(/prime repository/i);
  });
});

describe("the patched body never leaves the server", () => {
  it("the report carries the rows and the counts, and never the file", async () => {
    const { report, patched } = await planPrimeMigrationRepair({} as never, V);
    expect(patched).toContain("DROP POLICY IF EXISTS p ON t;");
    expect(report.plan).not.toHaveProperty("patched");
    expect(JSON.stringify(report)).not.toContain(patched);
    expect(report.plan.repairCount).toBe(1);
  });

  it("and the report does not grow with the file", async () => {
    // A thousand policies is a plausible shape here — one real migration in
    // the prime's corpus carries 1,020 flagged statements — and the rows are
    // capped, so what crosses is a page of evidence rather than a megabyte.
    state.sql = Array.from(
      { length: 1000 },
      (_, i) => `CREATE POLICY p${i} ON t FOR SELECT USING (true);`,
    ).join("\n");
    const { report, patched } = await planPrimeMigrationRepair({} as never, V);
    expect(report.plan.repairCount).toBe(1000);
    expect(patched!.length).toBeGreaterThan(60_000);
    expect(JSON.stringify(report).length).toBeLessThan(4_000);
  });
});

describe("the proposal itself", () => {
  it("commits the file it planned, on a branch named for the version", async () => {
    const r = await openPrimeMigrationRepair({} as never, V, "u1");
    expect(r.ok).toBe(true);
    expect(writes()).toEqual([
      "createBlob",
      "createTree",
      "createCommit",
      "createRef",
      "pulls.create",
    ]);

    const tree = state.calls.find((c) => c.name === "createTree")!.args as {
      base_tree: string;
      tree: Array<{ path: string }>;
    };
    /*
      The TREE the base commit carries, never the commit sha. `createTree`
      documents `base_tree` as a tree object; handing it a commit relies on
      the service resolving something it does not promise to, on the one call
      that decides which files the proposal carries.
    */
    expect(tree.base_tree).toBe("basetreesha");
    expect(tree.tree).toHaveLength(1);
    expect(tree.tree[0].path).toBe(`supabase/migrations/${V}_x.sql`);

    const blob = state.calls.find((c) => c.name === "createBlob")!.args as { content: string };
    expect(Buffer.from(blob.content, "base64").toString("utf8")).toContain(
      "DROP POLICY IF EXISTS p ON t;",
    );

    const ref = state.calls.find((c) => c.name === "createRef")!.args as { ref: string };
    expect(ref.ref).toBe(`refs/heads/${repairBranchName(V)}`);

    const pr = state.calls.find((c) => c.name === "pulls.create")!.args as {
      base: string;
      head: string;
      body: string;
    };
    expect(pr.base).toBe("main");
    expect(pr.head).toBe(repairBranchName(V));
    expect(pr.body).toMatch(/Every edit is an insertion/);
  });

  it("records the act afterwards, with the readings rather than a verdict word", async () => {
    await openPrimeMigrationRepair({} as never, V, "u1");
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({
      action: "prime.migration.repair",
      entityId: V,
      actorUserId: "u1",
    });
    const meta = state.audits[0].metadata as Record<string, unknown>;
    expect(meta).toMatchObject({
      reading_before: "fails_loudly",
      reading_after: "rerunnable",
      pull_request: 7,
    });
  });

  it("hands back the open one rather than opening a second", async () => {
    state.openPr = { number: 3, html_url: "https://github.com/n/prime/pull/3" };
    const r = await openPrimeMigrationRepair({} as never, V, "u1");
    expect(r.ok && r.state).toBe("already_open");
    expect(r.ok && r.number).toBe(3);
    expect(writes()).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("refuses to re-propose onto a branch whose pull request somebody closed", async () => {
    state.branchExists = true;
    const r = await openPrimeMigrationRepair({} as never, V, "u1");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/closed/i);
    expect(!r.ok && r.error).toMatch(/Delete the branch/i);
    expect(writes()).toEqual([]);
  });

  it("names the permissions it needs when GitHub says Not Found", async () => {
    state.branchExists = false;
    const { openPrimeMigrationRepair: fn } = await import("./primeMigrationRemedy.server");
    // The base ref read succeeds; the blob write is what fails.
    const spy = vi.spyOn(Buffer, "from");
    spy.mockImplementationOnce(() => {
      const err = new Error("Not Found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    const r = await fn({} as never, V, "u1");
    spy.mockRestore();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Contents: read & write/);
    expect(!r.ok && r.error).toMatch(/Nothing was changed/);
  });
});

describe("the document a reviewer opens", () => {
  /*
    Read as a DOCUMENT rather than as the source that composes it. Its first
    version filtered omitted lines and blank ones with the same test, which in
    Markdown means no table renders and no heading closes — the whole body
    arrives as one paragraph. Nothing about the code looked wrong; printing it
    is what found it.
  */
  const bodyFor = async (sql: string) => {
    state.sql = sql;
    const { report } = await planPrimeMigrationRepair({} as never, V);
    return repairProposalBody(report);
  };

  it("renders as Markdown — the table has a blank line above it and rows under it", async () => {
    const body = await bodyFor(
      [
        `CREATE TABLE t (id int);`,
        `CREATE POLICY "Users can read" ON public.t FOR SELECT USING (true);`,
      ].join("\n"),
    );
    const lines = body.split("\n");
    const header = lines.findIndex((l) => l.startsWith("| line |"));
    expect(header).toBeGreaterThan(0);
    expect(lines[header - 1]).toBe("");
    expect(lines[header + 1]).toMatch(/^\| --- \|/);
    expect(lines[header + 2]).toMatch(/^\| \d+ \| table \| `IF NOT EXISTS` \|/);
    for (const h of body.split("\n").filter((l) => l.startsWith("### "))) {
      expect(body).toContain(`\n${h}\n\n`);
    }
  });

  it("names what it changed in words, never in the column the enum uses", async () => {
    const body = await bodyFor(`CREATE MATERIALIZED VIEW mv AS SELECT 1 AS a;`);
    expect(body).toContain("| materialized view |");
    expect(body).not.toContain("materialized_view");
  });

  it("fences every refusal's SQL and says why in the same breath", async () => {
    const body = await bodyFor(
      [`CREATE TABLE t (id int);`, `INSERT INTO t (id) VALUES (1);`].join("\n"),
    );
    expect(body).toContain("### What was deliberately left alone");
    expect(body).toMatch(/\*\*Line \d+ — rows written\.\*\* The only edit/);
    // The excerpt is the statement as the scanner holds it — comments gone,
    // terminator trimmed — which is the same shape the diagnosis panel quotes
    // its hazards in. One excerpt rule, not two.
    expect(body).toMatch(/```sql\nINSERT INTO t \(id\) VALUES \(1\)\n```/);
    expect(body).toContain("still not safe to run twice");
  });

  it("agrees with itself about number, because a reviewer reads it", async () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `CREATE POLICY p${i} ON t FOR SELECT USING (true);`,
    ).join("\n");
    /*
      Renegotiated. This read `of the same shapes`, which was a claim the body
      could not support: `plan.repairs` stops at `REMEDY_ROWS`, so the shapes
      it can see are the first eight, and 65 of the prime's migrations plan
      more repairs than that. The count is the part that is known.
    */
    expect(await bodyFor(many)).toContain("further repairs are in the diff");

    const nine = Array.from(
      { length: 9 },
      (_, i) => `CREATE POLICY q${i} ON t FOR SELECT USING (true);`,
    ).join("\n");
    expect(await bodyFor(nine)).toContain("1 further repair is in the diff");
  });

  it("carries no placeholder anywhere", async () => {
    const body = await bodyFor(`CREATE POLICY "A B" ON public.t FOR SELECT USING (true);`);
    expect(body).not.toMatch(/undefined|NaN|\[object/);
  });
});
