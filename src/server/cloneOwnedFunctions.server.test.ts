/**
 * The lane that deploys a clone's own functions, driven through fakes of the
 * three things it talks to: the clone's repository, the prime's, and the
 * clone's Supabase project.
 *
 * `planFunctionBundles` is the real one — the grouping, entrypoint and
 * `verify_jwt` rules the prime's own deploy follows — so what reaches the
 * deploy here is what would reach it in production.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gh = vi.hoisted(() => ({
  resolvePrimeSource: vi.fn(),
  resolvePrimeBackendRef: vi.fn(),
  fetchDeclaredEdgeFunctionSlugs: vi.fn(),
  readRepoFunctionTree: vi.fn(),
  assembleFunctionBundles: vi.fn(),
}));
vi.mock("./prime-backend.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./prime-backend.server")>()),
  ...gh,
}));

const project = vi.hoisted(() => ({
  deployEdgeFunctions: vi.fn(),
  readProjectEdgeFunctionSlugs: vi.fn(),
}));
vi.mock("./backend-provisioning.server", () => project);

const {
  deployCloneOwnedFunctions,
  describeCloneOwnedOutcome,
  ownedFunctionSweepIsNoteworthy,
  sweepCloneOwnedFunctionsFromFleet,
} = await import("./cloneOwnedFunctions.server");

const PRIME_SOURCE = {
  owner: "Naidu-Group-Pty-Ltd",
  repo: "npc-property-dashbord",
  branch: "main",
};
const PRIME_PROJECT = "primeprimeprimeprime";
const CRM_PROJECT = "crmcrmcrmcrmcrmcrmcr";
const PRIME_DECLARED = ["airtable-proxy", "listings-cache"];
const CRM = ["crm-calendar", "crm-inbound-message", "crm-send-message"];

const CRM_CLONE = {
  id: "crm",
  github_owner: "Naidu-Group-Pty-Ltd",
  github_repo: "npc-crm-independent-6505dc",
  default_branch: "main",
};

/** The CRM clone's tree as measured: the prime's functions, plus three of its own on `_shared/crm`. */
function crmTree(overrides: { sharedSha?: string; sha?: string } = {}) {
  const files = [
    { rel: "_shared/cors.ts", sha: "cors-1" },
    { rel: "_shared/crm/provider.ts", sha: overrides.sharedSha ?? "crm-shared-1" },
    { rel: "airtable-proxy/index.ts", sha: "ap-1" },
    { rel: "listings-cache/index.ts", sha: "lc-1" },
    ...CRM.map((slug) => ({ rel: `${slug}/index.ts`, sha: `${slug}-1` })),
  ];
  return {
    sourceRepo: `${CRM_CLONE.github_owner}/${CRM_CLONE.github_repo}`,
    sourceRef: "main",
    sourceSha: overrides.sha ?? "c".repeat(40),
    files,
    configToml: [
      'project_id = "crmcrmcrmcrmcrmcrmcr"',
      ...CRM.map((slug) => `[functions.${slug}]\nverify_jwt = false`),
      "[functions.airtable-proxy]\nverify_jwt = true",
    ].join("\n"),
    declaredFunctionSlugs: [...PRIME_DECLARED, ...CRM].sort(),
  };
}

type Row = Record<string, unknown>;

/**
 * A Supabase double over two tables: `.select().eq().maybeSingle()`, an
 * awaited `.select().eq()`, and `.update().eq()` — recording every write.
 */
function fakeSupabase(
  tables: { clones: Row[]; clone_backends: Row[] },
  opts: { updateError?: { code?: string; message: string } } = {},
) {
  const updates: Array<{ table: string; patch: Row; where: [string, unknown] }> = [];
  const listReads: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const matching = () =>
      ((tables as Record<string, Row[]>)[table] ?? []).filter((r) =>
        filters.every(([c, v]) => r[c] === v),
      );
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => {
        filters.push([c, v]);
        return q;
      },
      maybeSingle: async () => ({ data: matching()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        listReads.push({ table, filters: [...filters] });
        return Promise.resolve({ data: matching(), error: null }).then(resolve, reject);
      },
      update: (patch: Row) => ({
        eq: async (c: string, v: unknown) => {
          updates.push({ table, patch, where: [c, v] });
          return { error: opts.updateError ?? null };
        },
      }),
    };
    return q;
  };
  return { client: { from } as never, updates, listReads };
}

function crmBackend(record: unknown = null, extra: Row = {}) {
  return {
    clone_id: "crm",
    supabase_project_ref: CRM_PROJECT,
    status: "ready",
    clone_owned_functions: record,
    ...extra,
  };
}

const octokit = {} as never;
const NOW = () => new Date("2026-09-28T12:00:00.000Z");

beforeEach(() => {
  for (const f of [...Object.values(gh), ...Object.values(project)]) f.mockReset();
  gh.resolvePrimeSource.mockResolvedValue(PRIME_SOURCE);
  gh.resolvePrimeBackendRef.mockResolvedValue(PRIME_PROJECT);
  gh.fetchDeclaredEdgeFunctionSlugs.mockResolvedValue(PRIME_DECLARED);
  gh.readRepoFunctionTree.mockResolvedValue(crmTree());
  gh.assembleFunctionBundles.mockImplementation(
    async (_o: unknown, _ref: unknown, plans: Array<Row>) =>
      plans.map((p) => ({ ...p, files: [] })),
  );
  project.readProjectEdgeFunctionSlugs.mockResolvedValue([...PRIME_DECLARED]);
  project.deployEdgeFunctions.mockImplementation(
    async (_ref: string, bundles: Array<{ slug: string; verifyJwt: boolean }>) =>
      bundles.map((b) => ({ slug: b.slug, success: true, verifyJwt: b.verifyJwt })),
  );
});

describe("deployCloneOwnedFunctions", () => {
  it("deploys the CRM clone's three functions from its OWN repository, to its own project, and records it", async () => {
    const sb = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend()] });

    const o = await deployCloneOwnedFunctions({
      supabase: sb.client,
      octokit,
      cloneId: "crm",
      now: NOW,
    });

    expect(o).toMatchObject({
      act: "deployed",
      owned: CRM,
      deployed: CRM,
      failed: [],
      recorded: true,
    });
    // Read from the clone's repository, never the prime's.
    expect(gh.readRepoFunctionTree).toHaveBeenCalledWith(octokit, {
      owner: CRM_CLONE.github_owner,
      repo: CRM_CLONE.github_repo,
      branch: "main",
    });
    expect(gh.assembleFunctionBundles.mock.calls[0][1]).toMatchObject({
      repo: CRM_CLONE.github_repo,
    });
    // To the clone's project, with the clone's own verify_jwt, and only the owned three.
    const [ref, bundles] = project.deployEdgeFunctions.mock.calls[0] as [string, Array<Row>];
    expect(ref).toBe(CRM_PROJECT);
    expect(bundles.map((b) => b.slug)).toEqual(CRM);
    expect(bundles.every((b) => b.verifyJwt === false)).toBe(true);
    // Each bundle carries the shared tree, which is where `_shared/crm` lives.
    const plans = gh.assembleFunctionBundles.mock.calls[0][2] as Array<{
      files: Array<{ rel: string }>;
    }>;
    expect(plans.every((p) => p.files.some((f) => f.rel === "_shared/crm/provider.ts"))).toBe(true);

    expect(sb.updates).toHaveLength(1);
    const written = sb.updates[0].patch.clone_owned_functions as Row;
    expect(written).toMatchObject({
      slugs: CRM,
      source_repo: "Naidu-Group-Pty-Ltd/npc-crm-independent-6505dc",
      source_sha: "c".repeat(40),
      deployed_at: "2026-09-28T12:00:00.000Z",
    });
    expect(typeof written.digest).toBe("string");
  });

  it("writes nothing and deploys nothing on the next pass, when nothing changed", async () => {
    const first = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend()] });
    await deployCloneOwnedFunctions({ supabase: first.client, octokit, cloneId: "crm", now: NOW });
    const record = first.updates[0].patch.clone_owned_functions;
    project.deployEdgeFunctions.mockClear();
    project.readProjectEdgeFunctionSlugs.mockResolvedValue([...PRIME_DECLARED, ...CRM]);

    const second = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend(record)] });
    const o = await deployCloneOwnedFunctions({
      supabase: second.client,
      octokit,
      cloneId: "crm",
      now: () => new Date("2026-09-28T12:30:00.000Z"),
    });

    expect(o.act).toBe("skip");
    expect(project.deployEdgeFunctions).not.toHaveBeenCalled();
    // Every write bumps `clone_backends.updated_at`; an unchanged pass makes none.
    expect(second.updates).toEqual([]);
  });

  it("redeploys all three when a shared file they are built from changes", async () => {
    const first = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend()] });
    await deployCloneOwnedFunctions({ supabase: first.client, octokit, cloneId: "crm", now: NOW });
    const record = first.updates[0].patch.clone_owned_functions;
    project.deployEdgeFunctions.mockClear();
    project.readProjectEdgeFunctionSlugs.mockResolvedValue([...PRIME_DECLARED, ...CRM]);
    gh.readRepoFunctionTree.mockResolvedValue(
      crmTree({ sharedSha: "crm-shared-2", sha: "d".repeat(40) }),
    );

    const second = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend(record)] });
    const o = await deployCloneOwnedFunctions({
      supabase: second.client,
      octokit,
      cloneId: "crm",
      now: NOW,
    });

    expect(o).toMatchObject({ act: "deployed", deployed: CRM });
    expect(second.updates).toHaveLength(1);
  });

  it("does nothing for a mirror, which owns nothing — and records that it looked", async () => {
    gh.readRepoFunctionTree.mockResolvedValue({
      ...crmTree(),
      declaredFunctionSlugs: [...PRIME_DECLARED],
    });
    const sb = fakeSupabase({
      clones: [{ ...CRM_CLONE, id: "nt", github_repo: "npc-test-76b3b3" }],
      clone_backends: [
        crmBackend(null, { clone_id: "nt", supabase_project_ref: "ntntntntntntntntntnt" }),
      ],
    });

    const o = await deployCloneOwnedFunctions({
      supabase: sb.client,
      octokit,
      cloneId: "nt",
      now: NOW,
    });

    expect(o).toMatchObject({ act: "none", owned: [] });
    expect(project.deployEdgeFunctions).not.toHaveBeenCalled();
    expect((sb.updates[0]?.patch.clone_owned_functions as Row | undefined)?.slugs).toEqual([]);
  });

  describe("refusals — each named, none deploying", () => {
    it("never deploys to the prime's own project", async () => {
      const sb = fakeSupabase({
        clones: [CRM_CLONE],
        clone_backends: [crmBackend(null, { supabase_project_ref: PRIME_PROJECT })],
      });
      const o = await deployCloneOwnedFunctions({
        supabase: sb.client,
        octokit,
        cloneId: "crm",
        now: NOW,
      });
      expect(o.act).toBe("refused");
      expect(o.why).toMatch(/prime's own project/);
      expect(project.deployEdgeFunctions).not.toHaveBeenCalled();
      expect(sb.updates).toEqual([]);
    });

    it("never acts when the prime's project is unknown", async () => {
      gh.resolvePrimeBackendRef.mockResolvedValue("");
      const sb = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend()] });
      const o = await deployCloneOwnedFunctions({
        supabase: sb.client,
        octokit,
        cloneId: "crm",
        now: NOW,
      });
      expect(o.act).toBe("refused");
      expect(project.deployEdgeFunctions).not.toHaveBeenCalled();
    });

    it("never acts without the prime's declared list — every function would look like the clone's", async () => {
      gh.fetchDeclaredEdgeFunctionSlugs.mockResolvedValue(null);
      const sb = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend()] });
      const o = await deployCloneOwnedFunctions({
        supabase: sb.client,
        octokit,
        cloneId: "crm",
        now: NOW,
      });
      expect(o.act).toBe("refused");
      expect(o.why).toMatch(/could not be read/);
      expect(gh.readRepoFunctionTree).not.toHaveBeenCalled();
      expect(project.deployEdgeFunctions).not.toHaveBeenCalled();
    });

    it("refuses a clone whose repository is the prime's", async () => {
      const sb = fakeSupabase({
        clones: [{ ...CRM_CLONE, github_repo: PRIME_SOURCE.repo }],
        clone_backends: [crmBackend()],
      });
      const o = await deployCloneOwnedFunctions({
        supabase: sb.client,
        octokit,
        cloneId: "crm",
        now: NOW,
      });
      expect(o.act).toBe("refused");
      expect(project.deployEdgeFunctions).not.toHaveBeenCalled();
    });

    it("refuses a clone with no project yet, and leaves any record untouched", async () => {
      const sb = fakeSupabase({
        clones: [CRM_CLONE],
        clone_backends: [crmBackend(null, { supabase_project_ref: null })],
      });
      const o = await deployCloneOwnedFunctions({
        supabase: sb.client,
        octokit,
        cloneId: "crm",
        now: NOW,
      });
      expect(o.act).toBe("refused");
      expect(sb.updates).toEqual([]);
    });

    it("refuses a clone that has diverged by more than the ceiling, and records nothing", async () => {
      const many = Array.from({ length: 21 }, (_, i) => `fn-${String(i).padStart(2, "0")}`);
      gh.readRepoFunctionTree.mockResolvedValue({
        ...crmTree(),
        files: many.map((slug) => ({ rel: `${slug}/index.ts`, sha: slug })),
        declaredFunctionSlugs: many,
      });
      const sb = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend()] });
      const o = await deployCloneOwnedFunctions({
        supabase: sb.client,
        octokit,
        cloneId: "crm",
        now: NOW,
      });
      expect(o.act).toBe("refused");
      expect(project.deployEdgeFunctions).not.toHaveBeenCalled();
      expect(sb.updates).toEqual([]);
    });
  });

  it("records a failed assembly as a failure per slug, so the next pass retries it", async () => {
    gh.assembleFunctionBundles.mockRejectedValue(
      new Error("Blob not found for crm-send-message/index.ts"),
    );
    const sb = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend()] });

    const o = await deployCloneOwnedFunctions({
      supabase: sb.client,
      octokit,
      cloneId: "crm",
      now: NOW,
    });

    expect(o.act).toBe("deployed");
    expect(o.deployed).toEqual([]);
    expect(o.failed.map((f) => f.slug)).toEqual(CRM);
    const results = (sb.updates[0].patch.clone_owned_functions as { results: Array<Row> }).results;
    expect(results.every((r) => r.success === false)).toBe(true);
  });

  describe("on a deployment the column's migration has not reached", () => {
    it("deploys only what the project does not run, and says the record could not be kept", async () => {
      const { clone_owned_functions: _omit, ...unmigrated } = crmBackend();
      void _omit;
      project.readProjectEdgeFunctionSlugs.mockResolvedValue([...PRIME_DECLARED, "crm-calendar"]);
      const sb = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [unmigrated] });

      const o = await deployCloneOwnedFunctions({
        supabase: sb.client,
        octokit,
        cloneId: "crm",
        now: NOW,
      });

      expect(o).toMatchObject({
        act: "deployed",
        deployed: ["crm-inbound-message", "crm-send-message"],
      });
      expect(o.recordRefused).toMatch(/20260928100000_clone_crm_mode/);
      // Never a write naming a column the table does not have.
      expect(sb.updates).toEqual([]);
    });

    it("redeploys nothing the project already runs", async () => {
      const { clone_owned_functions: _omit, ...unmigrated } = crmBackend();
      void _omit;
      project.readProjectEdgeFunctionSlugs.mockResolvedValue([...PRIME_DECLARED, ...CRM]);
      const sb = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [unmigrated] });
      const o = await deployCloneOwnedFunctions({
        supabase: sb.client,
        octokit,
        cloneId: "crm",
        now: NOW,
      });
      expect(o.act).toBe("skip");
      expect(project.deployEdgeFunctions).not.toHaveBeenCalled();
    });

    it("names the migration when the write itself is refused for the missing column", async () => {
      const sb = fakeSupabase(
        { clones: [CRM_CLONE], clone_backends: [crmBackend()] },
        {
          updateError: {
            code: "PGRST204",
            message: "Could not find the 'clone_owned_functions' column",
          },
        },
      );
      const o = await deployCloneOwnedFunctions({
        supabase: sb.client,
        octokit,
        cloneId: "crm",
        now: NOW,
      });
      expect(o.recorded).toBe(false);
      expect(o.recordRefused).toMatch(/20260928100000_clone_crm_mode/);
    });
  });

  it("takes the project ref from the caller when the backend row does not carry it yet", async () => {
    const sb = fakeSupabase({
      clones: [CRM_CLONE],
      clone_backends: [crmBackend(null, { supabase_project_ref: null })],
    });
    const o = await deployCloneOwnedFunctions({
      supabase: sb.client,
      octokit,
      cloneId: "crm",
      projectRef: CRM_PROJECT,
      primeDeclaredSlugs: PRIME_DECLARED,
      now: NOW,
    });
    expect(o.act).toBe("deployed");
    expect(project.deployEdgeFunctions.mock.calls[0][0]).toBe(CRM_PROJECT);
    // The caller's list is used; the prime is not read again.
    expect(gh.fetchDeclaredEdgeFunctionSlugs).not.toHaveBeenCalled();
  });
});

describe("describeCloneOwnedOutcome", () => {
  it("says what happened in one line", () => {
    expect(
      describeCloneOwnedOutcome({
        cloneId: "crm",
        act: "deployed",
        why: "no deploy of these functions from the clone's repository is on record",
        owned: CRM,
        deployed: ["crm-calendar"],
        failed: [{ slug: "crm-send-message", error: "413" }],
        retired: [],
        recorded: true,
      }),
    ).toBe(
      "Clone-owned functions deployed 1/2 — crm-calendar — failed: crm-send-message (413) — " +
        "no deploy of these functions from the clone's repository is on record",
    );
  });
});

describe("sweepCloneOwnedFunctionsFromFleet", () => {
  it("reads the prime's list once, and visits only clones whose backend is ready", async () => {
    const sb = fakeSupabase({
      clones: [CRM_CLONE, { ...CRM_CLONE, id: "new", github_repo: "npc-new" }],
      clone_backends: [
        crmBackend(),
        crmBackend(null, {
          clone_id: "new",
          status: "migrating",
          supabase_project_ref: "newnewnewnewnewnewne",
        }),
      ],
    });

    const sweep = await sweepCloneOwnedFunctionsFromFleet({
      supabase: sb.client,
      octokit,
      now: NOW,
    });

    expect(gh.fetchDeclaredEdgeFunctionSlugs).toHaveBeenCalledTimes(1);
    expect(sb.listReads).toEqual([{ table: "clone_backends", filters: [["status", "ready"]] }]);
    expect(sweep.considered).toBe(1);
    expect(sweep.deployed).toBe(3);
    expect(ownedFunctionSweepIsNoteworthy(sweep)).toBe(true);
  });

  it("stops before reading any clone when the prime's list cannot be read", async () => {
    gh.fetchDeclaredEdgeFunctionSlugs.mockResolvedValue(null);
    const sb = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend()] });
    const sweep = await sweepCloneOwnedFunctionsFromFleet({
      supabase: sb.client,
      octokit,
      now: NOW,
    });
    expect(sweep.refused).toMatch(/could not be read/);
    expect(sweep.considered).toBe(0);
    expect(gh.readRepoFunctionTree).not.toHaveBeenCalled();
  });

  it("a current fleet is not noteworthy", async () => {
    gh.readRepoFunctionTree.mockResolvedValue({
      ...crmTree(),
      declaredFunctionSlugs: [...PRIME_DECLARED],
    });
    const record = {
      slugs: [],
      source_repo: "x",
      source_sha: "y",
      digest: null,
      deployed_at: null,
      results: [],
      retired: [],
      checked_at: "2026-09-28T11:50:00.000Z",
    };
    const sb = fakeSupabase({ clones: [CRM_CLONE], clone_backends: [crmBackend(record)] });
    const sweep = await sweepCloneOwnedFunctionsFromFleet({
      supabase: sb.client,
      octokit,
      now: NOW,
    });
    expect(ownedFunctionSweepIsNoteworthy(sweep)).toBe(false);
  });
});
