/**
 * A CRM conversion's lifecycle, driven through fakes of what it talks to:
 * Mission Control's tables, the clone's pull request, and the clone's project.
 *
 * The decisions are `crmConversion.pure.ts`' and are tested there; what is
 * pinned here is that the server module ACTS on them — that a merged pull
 * request moves the clone and takes exactly the retired, non-prime functions
 * off its project, that a closed one cancels, and that nothing is written
 * while a pull request is merely open or could not be read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const owned = vi.hoisted(() => ({
  deployCloneOwnedFunctions: vi.fn(),
  describeCloneOwnedOutcome: vi.fn(() => "deployed crm-send-message"),
}));
vi.mock("./cloneOwnedFunctions.server", () => owned);

const prime = vi.hoisted(() => ({
  resolvePrimeSource: vi.fn(),
  resolvePrimeBackendRef: vi.fn(),
  fetchDeclaredEdgeFunctionSlugs: vi.fn(),
}));
vi.mock("./prime-backend.server", () => prime);

const project = vi.hoisted(() => ({
  deleteProjectEdgeFunctions: vi.fn(),
  readProjectEdgeFunctionSlugs: vi.fn(),
}));
vi.mock("./backend-provisioning.server", () => project);

vi.mock("./cascade-engine.server", () => ({ processClone: vi.fn() }));

const { cancelCrmConversion, drainCrmConversions, finaliseConversion } =
  await import("./crmConversion.server");

type Row = Record<string, unknown>;
type Write = {
  table: string;
  op: "update" | "delete";
  patch?: Row;
  filters: Array<[string, unknown]>;
};

/** A Supabase double over plain rows: eq/in filters, reads, updates and deletes, all recorded. */
function fakeSupabase(tables: Record<string, Row[]>) {
  const writes: Write[] = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "update" | "delete" = "select";
    let patch: Row | undefined;
    const rows = () =>
      (tables[table] ?? []).filter((r) =>
        filters.every(([c, v]) =>
          Array.isArray(v) ? (v as unknown[]).includes(r[c]) : r[c] === v,
        ),
      );
    const settle = () => {
      if (op === "select") return { data: rows(), error: null };
      const hit = rows();
      writes.push({ table, op, patch, filters: [...filters] });
      if (op === "update") for (const r of hit) Object.assign(r, patch);
      if (op === "delete") tables[table] = (tables[table] ?? []).filter((r) => !hit.includes(r));
      return { data: null, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (filters.push([c, v]), q),
      in: (c: string, v: unknown[]) => (filters.push([c, v]), q),
      order: () => q,
      limit: () => q,
      update: (p: Row) => ((op = "update"), (patch = p), q),
      delete: () => ((op = "delete"), q),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(settle()).then(resolve, reject),
    };
    return q;
  };
  return { client: { from } as never, writes, tables };
}

function fakeOctokit(pr: { merged?: boolean; state?: string; merge_commit_sha?: string } | Error) {
  return {
    pulls: {
      get: vi.fn(async () => {
        if (pr instanceof Error) throw pr;
        return { data: { merged: false, state: "open", ...pr } };
      }),
      update: vi.fn(async () => ({ data: {} })),
    },
    git: { deleteRef: vi.fn(async () => ({})) },
  } as never as ReturnType<typeof import("./github-app.server").getAppOctokit> & {
    pulls: { get: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
    git: { deleteRef: ReturnType<typeof vi.fn> };
  };
}

const NOW = Date.parse("2026-09-28T12:00:00Z");

function world(conversion: Row = {}) {
  return {
    clones: [
      {
        id: "clone",
        name: "npc-test",
        github_owner: "Naidu-Group-Pty-Ltd",
        github_repo: "npc-test-76b3b3",
        default_branch: "main",
        crm_mode: "independent",
        parent_clone_id: "crm-head",
        sync_scope: "mirror",
        last_synced_sha: "old",
      },
      {
        id: "dep-head",
        name: "npc-client-dashboard",
        github_owner: "Naidu-Group-Pty-Ltd",
        github_repo: "npc-client-dashboard",
        github_url: null,
        default_branch: "main",
        last_synced_sha: "headsha",
        crm_mode: "dependent",
        sync_scope: "mirror",
        parent_clone_id: null,
      },
    ],
    clone_crm_conversions: [
      {
        id: "conv",
        clone_id: "clone",
        status: "proposed",
        from_mode: "independent",
        to_mode: "dependent",
        to_parent_clone_id: "dep-head",
        pr_number: 7,
        branch: "aurixa/crm-conversion-dependent-abc1234-x",
        delivered_sha: "delivered",
        created_at: "2026-09-28T11:00:00Z",
        plan: { retiredFunctions: ["crm-calendar", "crm-send-message", "shared-with-prime"] },
        ...conversion,
      },
    ],
    clone_sync_exclusions: [
      {
        clone_id: "clone",
        pattern: "src/pages/Conversations.tsx",
        reason: "manual_reconcile",
        note: null,
      },
      { clone_id: "clone", pattern: "supabase/config.toml", reason: "protected", note: null },
    ],
    clone_backends_safe: [{ clone_id: "clone", supabase_project_ref: "clonerefclonerefclon" }],
  } as Record<string, Row[]>;
}

beforeEach(() => {
  vi.clearAllMocks();
  owned.deployCloneOwnedFunctions.mockResolvedValue({ act: "none" });
  prime.resolvePrimeSource.mockResolvedValue({ owner: "o", repo: "prime", branch: "main" });
  prime.resolvePrimeBackendRef.mockResolvedValue("primeprimeprimeprime");
  prime.fetchDeclaredEdgeFunctionSlugs.mockResolvedValue(["airtable-proxy", "shared-with-prime"]);
  project.readProjectEdgeFunctionSlugs.mockResolvedValue([
    "airtable-proxy",
    "crm-calendar",
    "crm-send-message",
    "shared-with-prime",
  ]);
  project.deleteProjectEdgeFunctions.mockImplementation(async (_ref: string, slugs: string[]) => ({
    deleted: slugs,
    failed: [],
    deferred: [],
    skipped: null,
  }));
});

describe("the drain", () => {
  it("writes nothing while the pull request is open", async () => {
    const db = fakeSupabase(world());
    const report = await drainCrmConversions(db.client, fakeOctokit({ state: "open" }), NOW);
    expect(report.waiting).toBe(1);
    expect(db.writes).toEqual([]);
  });

  it("writes nothing when the pull request cannot be read", async () => {
    const db = fakeSupabase(world());
    const err = Object.assign(new Error("boom"), { status: 502 });
    const report = await drainCrmConversions(db.client, fakeOctokit(err), NOW);
    expect(report.waiting).toBe(1);
    expect(db.writes).toEqual([]);
  });

  it("cancels on a pull request closed unmerged, and changes nothing on the clone", async () => {
    const db = fakeSupabase(world());
    const report = await drainCrmConversions(db.client, fakeOctokit({ state: "closed" }), NOW);
    expect(report.cancelled).toBe(1);
    expect(db.tables.clone_crm_conversions[0].status).toBe("cancelled");
    expect(db.writes.every((w) => w.table === "clone_crm_conversions")).toBe(true);
  });

  it("cancels on a pull request that no longer exists", async () => {
    const db = fakeSupabase(world());
    const gone = Object.assign(new Error("Not Found"), { status: 404 });
    const report = await drainCrmConversions(db.client, fakeOctokit(gone), NOW);
    expect(report.cancelled).toBe(1);
  });

  it("fails a claim whose proposal was never recorded, once it has stalled", async () => {
    const db = fakeSupabase(world({ pr_number: null, created_at: "2026-09-28T10:00:00Z" }));
    const report = await drainCrmConversions(db.client, fakeOctokit({}), NOW);
    expect(report.failed).toBe(1);
    expect(db.tables.clone_crm_conversions[0].status).toBe("failed");
  });

  it("finishes a merged conversion: moves the clone, drops its routing holds, retires its functions", async () => {
    const db = fakeSupabase(world());
    const report = await drainCrmConversions(
      db.client,
      fakeOctokit({ merged: true, state: "closed", merge_commit_sha: "merge" }),
      NOW,
    );
    expect(report.completed).toBe(1);

    const clone = db.tables.clones.find((c) => c.id === "clone")!;
    expect(clone.parent_clone_id).toBe("dep-head");
    expect(clone.crm_mode).toBe("dependent");
    // The pointer is what the proposal delivered, never the head's current value.
    expect(clone.last_synced_sha).toBe("delivered");

    // The routing hold goes on arrival at the dependent line; the protected row stays.
    expect(db.tables.clone_sync_exclusions.map((r) => r.pattern)).toEqual(["supabase/config.toml"]);

    expect(owned.deployCloneOwnedFunctions).toHaveBeenCalledWith(
      expect.objectContaining({ cloneId: "clone", force: true }),
    );
    // Never a function the prime declares, whatever the plan retired.
    expect(project.deleteProjectEdgeFunctions).toHaveBeenCalledWith(
      "clonerefclonerefclon",
      ["crm-calendar", "crm-send-message"],
      { primeRef: "primeprimeprimeprime" },
    );

    const row = db.tables.clone_crm_conversions[0];
    expect(row.status).toBe("completed");
    expect(row.merge_sha).toBe("merge");
    expect((row.plan as { finish: { undeployed: string[] } }).finish.undeployed).toEqual([
      "crm-calendar",
      "crm-send-message",
    ]);
  });
});

describe("finishing", () => {
  it("removes nothing when the prime's own list cannot be read", async () => {
    prime.fetchDeclaredEdgeFunctionSlugs.mockResolvedValue(null);
    const db = fakeSupabase(world({ status: "merged" }));
    const done = await finaliseConversion({
      supabase: db.client,
      octokit: fakeOctokit({}),
      conversionId: "conv",
    });
    expect(done.ok).toBe(true);
    expect(project.deleteProjectEdgeFunctions).not.toHaveBeenCalled();
    if (done.ok) expect(done.finish.undeploySkipped).toMatch(/could not be read/);
  });

  it("fails, rather than guessing, when the target head is gone", async () => {
    const w = world({ status: "merged" });
    w.clones = w.clones.filter((c) => c.id !== "dep-head");
    const db = fakeSupabase(w);
    const done = await finaliseConversion({
      supabase: db.client,
      octokit: fakeOctokit({}),
      conversionId: "conv",
    });
    expect(done.ok).toBe(false);
    expect(db.tables.clone_crm_conversions[0].status).toBe("failed");
    expect(db.tables.clones.find((c) => c.id === "clone")!.crm_mode).toBe("independent");
  });

  it("keeps the routing holds on arrival at the independent line", async () => {
    const w = world({ status: "merged", to_mode: "independent", to_parent_clone_id: "ind-head" });
    w.clones.push({
      id: "ind-head",
      name: "npc-crm-independent",
      github_owner: "o",
      github_repo: "npc-crm-independent-6505dc",
      default_branch: "main",
      last_synced_sha: "h",
      crm_mode: "independent",
      sync_scope: "mirror",
      parent_clone_id: null,
    });
    const db = fakeSupabase(w);
    await finaliseConversion({
      supabase: db.client,
      octokit: fakeOctokit({}),
      conversionId: "conv",
    });
    expect(db.tables.clone_sync_exclusions).toHaveLength(2);
  });
});

describe("cancelling", () => {
  it("closes the open pull request and records the cancellation", async () => {
    const db = fakeSupabase(world());
    const octokit = fakeOctokit({ state: "open" });
    const res = await cancelCrmConversion({ supabase: db.client, octokit, conversionId: "conv" });
    expect(res.ok).toBe(true);
    expect(octokit.pulls.update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 7, state: "closed" }),
    );
    expect(octokit.git.deleteRef).toHaveBeenCalled();
    expect(db.tables.clone_crm_conversions[0].status).toBe("cancelled");
  });

  it("refuses a pull request that has already merged", async () => {
    const db = fakeSupabase(world());
    const octokit = fakeOctokit({ merged: true, state: "closed" });
    const res = await cancelCrmConversion({ supabase: db.client, octokit, conversionId: "conv" });
    expect(res.ok).toBe(false);
    expect(octokit.pulls.update).not.toHaveBeenCalled();
    expect(db.tables.clone_crm_conversions[0].status).toBe("proposed");
  });

  it("refuses a conversion that is already finishing", async () => {
    const db = fakeSupabase(world({ status: "merged" }));
    const res = await cancelCrmConversion({
      supabase: db.client,
      octokit: fakeOctokit({}),
      conversionId: "conv",
    });
    expect(res.ok).toBe(false);
  });
});
