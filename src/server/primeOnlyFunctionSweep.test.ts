/**
 * The fleet half of taking the prime's own functions off the clones.
 *
 * `sweepPrimeOnlyFunctions` decides what one project loses and is pinned in
 * `primeOnlyProvisioning.test.ts`. This pins the pass the half-hourly catch-up
 * runs over it: every clone with a project is swept against ONE resolved
 * prime, a clone with no project is named rather than dropped, and a fleet
 * whose prime cannot be resolved deletes nothing anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
/** Source with comments removed — a comment quoting code is not code. */
import { stripComments } from "./sourceComments.pure";

type Answer<T> = { data: T; error: { message: string } | null };

const db = vi.hoisted(() => ({
  prime: null as unknown as Answer<{ supabase_project_ref: string } | null>,
  clones: null as unknown as Answer<Array<{ id: string; name: string | null }> | null>,
  backends: null as unknown as Answer<Array<{
    clone_id: string | null;
    supabase_project_ref: string | null;
  }> | null>,
}));

/**
 * The prime's retired functions, as `openRetiredFunctionRegister` would hand
 * them over: by default a register retiring nothing, so the tests below that
 * are about the prime's own functions read exactly as they did.
 */
const retired = vi.hoisted(() => ({
  opening: null as unknown,
  cloneCarries: null as unknown as ReturnType<typeof vi.fn>,
  opened: 0,
}));

vi.mock("@/server/retiredFunctions.server", () => ({
  openRetiredFunctionRegister: async () => {
    retired.opened += 1;
    return retired.opening;
  },
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => {
        if (table === "prime_config") {
          return { limit: () => ({ maybeSingle: async () => db.prime }) };
        }
        if (table === "clones") return Promise.resolve(db.clones);
        if (table === "clone_backends") return Promise.resolve(db.backends);
        throw new Error(`unexpected table ${table}`);
      },
    }),
  },
}));

import {
  fleetFunctionSweepIsNoteworthy,
  sweepPrimeOnlyFunctionsFromFleet,
  type FleetFunctionSweepResult,
} from "./primeOnlyFunctionSweep.server";
import { assembleRetiredRegister, type RetiredFunctionRegister } from "./retiredFunctions.pure";

const PRIME = "primeprimeprimeprime";
const DASHBOARD = "dashboarddashboardda";
const CRM = "crmcrmcrmcrmcrmcrmcr";

/**
 * Each project's deployed functions, and every request made. A function given
 * as `slug:open` is listed with `verify_jwt: false`, and as `slug:jwt` with
 * `verify_jwt: true`, as the Management API lists them.
 */
function projects(deployed: Record<string, string[]>) {
  const requests: Array<{ method: string; url: string }> = [];
  const fetch = vi.fn(async (url: unknown, init?: { method?: string }) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    requests.push({ method, url: u });
    const list = /\/projects\/([a-z]+)\/functions$/.exec(u);
    if (list && method === "GET") {
      const slugs = deployed[list[1]];
      if (!slugs) return new Response("project not found", { status: 404 });
      const listed = slugs.map((entry) => {
        const [slug, auth] = entry.split(":");
        return auth ? { slug, name: slug, verify_jwt: auth === "jwt" } : { slug, name: slug };
      });
      return new Response(JSON.stringify(listed), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "DELETE") return new Response(null, { status: 200 });
    return new Response("not stubbed", { status: 404 });
  });
  const deletes = () =>
    requests
      .filter((r) => r.method === "DELETE")
      .map((r) => r.url.replace(/^.*\/projects\/([a-z]+)\/functions\/(.+)$/, "$1:$2"));
  return { fetch, requests, deletes };
}

/** A register as the prime's two workflows would make one, retiring `names`. */
function registerOf(names: string[], primeCarries: string[] = []): RetiredFunctionRegister {
  return assembleRetiredRegister({
    readAt: "Naidu-Group-Pty-Ltd/npc-property-dashbord@d72032e1abcd",
    workflows: [
      {
        path: ".github/workflows/decommission-builder-portal-functions.yml",
        reading: { kind: "list", names },
      },
    ],
    primeTreePaths: primeCarries.map((n) => `supabase/functions/${n}/index.ts`),
  });
}

function openWith(register: RetiredFunctionRegister) {
  retired.opening = { ok: true, register, cloneCarries: retired.cloneCarries };
}

beforeEach(() => {
  retired.opened = 0;
  retired.cloneCarries = vi.fn(async () => ({ carries: new Set<string>() }));
  openWith(registerOf([]));
  vi.stubEnv("SB_MGMT_API_TOKEN", "test-token");
  db.prime = { data: { supabase_project_ref: PRIME }, error: null };
  db.clones = {
    data: [
      { id: "cd", name: "NPC Client Dashboard" },
      { id: "crm", name: "NPC CRM Independent" },
      { id: "new", name: "Not yet provisioned" },
    ],
    error: null,
  };
  db.backends = {
    data: [
      { clone_id: "cd", supabase_project_ref: DASHBOARD },
      { clone_id: "crm", supabase_project_ref: ` ${CRM} ` },
      { clone_id: "new", supabase_project_ref: null },
    ],
    error: null,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sweepPrimeOnlyFunctionsFromFleet", () => {
  it("sweeps every clone's project, adds up what it did, and names a clone with no project", async () => {
    const api = projects({
      [DASHBOARD]: ["listings-cache", "migration-dispatcher", "migration-job-status"],
      [CRM]: ["crm-send-message", "crm-calendar", "migration-orchestrator"],
    });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(result.refused).toBeNull();
    expect(result.considered).toBe(3);
    expect(result.deleted).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.deferred).toBe(0);
    // A CRM clone's own functions are never named by the register.
    expect(api.deletes()).toEqual([
      `${DASHBOARD}:migration-dispatcher`,
      `${DASHBOARD}:migration-job-status`,
      `${CRM}:migration-orchestrator`,
    ]);
    expect(result.outcomes.find((o) => o.cloneId === "new")).toEqual({
      cloneId: "new",
      cloneName: "Not yet provisioned",
      refused: "no_backend_project",
      sweep: null,
    });
    expect(fleetFunctionSweepIsNoteworthy(result)).toBe(true);
  });

  it("settles: a fleet holding none of them costs one read a project and writes nothing", async () => {
    const api = projects({ [DASHBOARD]: ["listings-cache"], [CRM]: ["crm-send-message"] });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(result.deleted).toBe(0);
    expect(api.requests.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(fleetFunctionSweepIsNoteworthy(result)).toBe(false);
  });

  it("deletes nothing anywhere when the prime cannot be resolved", async () => {
    db.prime = { data: null, error: { message: "connection refused" } };
    const api = projects({ [DASHBOARD]: ["migration-dispatcher"] });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(result.refused).toMatch(/could not be resolved/);
    expect(result.outcomes).toEqual([]);
    expect(api.requests).toEqual([]);
    expect(fleetFunctionSweepIsNoteworthy(result)).toBe(true);
  });

  it("and when the prime is not configured at all", async () => {
    db.prime = { data: null, error: null };
    const api = projects({ [DASHBOARD]: ["migration-dispatcher"] });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(result.refused).toMatch(/could not be resolved/);
    expect(api.requests).toEqual([]);
  });

  it("never sweeps the prime, even where a clone's row names the prime's project", async () => {
    db.backends = { data: [{ clone_id: "cd", supabase_project_ref: PRIME }], error: null };
    const api = projects({ [PRIME]: ["migration-dispatcher", "migration-job-status"] });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(api.deletes()).toEqual([]);
    expect(result.outcomes.find((o) => o.cloneId === "cd")?.sweep?.skipped).toMatch(
      /prime's own project/,
    );
  });

  it("names a read that failed rather than treating it as a fleet with nothing to delete", async () => {
    db.clones = { data: null, error: { message: "timeout" } };
    vi.stubGlobal("fetch", projects({}).fetch);
    expect((await sweepPrimeOnlyFunctionsFromFleet()).refused).toBe(
      "could not list clones: timeout",
    );

    db.clones = { data: [{ id: "cd", name: "NPC Client Dashboard" }], error: null };
    db.backends = { data: null, error: { message: "timeout" } };
    expect((await sweepPrimeOnlyFunctionsFromFleet()).refused).toBe(
      "could not read the clones' projects: timeout",
    );
  });

  it("carries a project whose functions could not be read as a skip, which is noteworthy", async () => {
    // The dashboard's project answers 404 to the list — a project that is
    // gone, or a token that cannot see it. Either way it is not empty.
    const api = projects({ [CRM]: [] });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(result.outcomes.find((o) => o.cloneId === "cd")?.sweep?.skipped).toMatch(
      /could not be read: HTTP 404/,
    );
    expect(fleetFunctionSweepIsNoteworthy(result)).toBe(true);
  });
});

describe("what the prime has retired, taken off with the rest", () => {
  // Measured 27 Oct 2026 on the dependent clones: twenty-seven `builder-*`
  // and `street-view`, nineteen of them answering without a JWT.
  const RETIRED = [
    "builder-portal-login",
    "builder-portal-reset-password",
    "builder-portal-admin",
    "street-view",
  ];

  /**
   * The clones' projects, and the prime's own: by default it runs none of the
   * retired functions, as measured on 27 Oct 2026.
   */
  const fleet = (deployed: Record<string, string[]>) =>
    projects({ [PRIME]: ["listings-cache:jwt", "builder-stock-marketplace:open"], ...deployed });

  beforeEach(() => {
    db.clones = {
      data: [
        {
          id: "cd",
          name: "NPC Client Dashboard",
          github_owner: "Naidu-Group-Pty-Ltd",
          github_repo: "npc-client-dashboard",
          default_branch: "main",
        },
        {
          id: "crm",
          name: "NPC CRM Independent",
          github_owner: "Naidu-Group-Pty-Ltd",
          github_repo: "npc-crm-independent-6505dc",
          default_branch: null,
        },
      ] as never,
      error: null,
    };
    openWith(registerOf(RETIRED));
  });

  it("deletes them by exact name, after the prime's own and the ones anybody can call first", async () => {
    const api = fleet({
      [DASHBOARD]: [
        "builder-portal-admin:jwt",
        "builder-portal-login:open",
        "listings-cache:jwt",
        "builder-stock-marketplace:open",
        "migration-dispatcher:jwt",
        "street-view:open",
        "builder-portal-reset-password:open",
      ],
      [CRM]: ["crm-send-message:jwt", "street-view:open"],
    });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(api.deletes()).toEqual([
      `${DASHBOARD}:migration-dispatcher`,
      `${DASHBOARD}:builder-portal-login`,
      `${DASHBOARD}:builder-portal-reset-password`,
      `${DASHBOARD}:street-view`,
      `${DASHBOARD}:builder-portal-admin`,
      `${CRM}:street-view`,
    ]);
    expect(result.deleted).toBe(6);
    const dashboard = result.outcomes.find((o) => o.cloneId === "cd")?.sweep;
    expect(dashboard?.deleted.find((d) => d.slug === "builder-portal-login")?.reason).toBe(
      "retired by the prime's .github/workflows/decommission-builder-portal-functions.yml, " +
        "which has deleted it from the prime's own project, and no tree carries its source; " +
        "it answers without a JWT",
    );
    expect(result.retired).toEqual({
      readAt: "Naidu-Group-Pty-Ltd/npc-property-dashbord@d72032e1abcd",
      names: 4,
      unreadable: [],
      refused: null,
      postponed: null,
    });
    expect(fleetFunctionSweepIsNoteworthy(result)).toBe(true);
  });

  it("reads the register once a pass, and a clone's own tree only where its project runs a retired function", async () => {
    const api = fleet({
      [DASHBOARD]: ["builder-portal-login:open"],
      [CRM]: ["crm-send-message:jwt"],
    });
    vi.stubGlobal("fetch", api.fetch);
    await sweepPrimeOnlyFunctionsFromFleet();
    expect(retired.opened).toBe(1);
    expect(retired.cloneCarries).toHaveBeenCalledTimes(1);
    expect(retired.cloneCarries).toHaveBeenCalledWith({
      owner: "Naidu-Group-Pty-Ltd",
      repo: "npc-client-dashboard",
      branch: "main",
    });
  });

  it("reads the prime's own project once a pass, and only when a clone runs a retired function", async () => {
    const primeReads = (api: ReturnType<typeof projects>) =>
      api.requests.filter(
        (r) => r.method === "GET" && r.url.endsWith(`/projects/${PRIME}/functions`),
      ).length;
    const busy = fleet({
      [DASHBOARD]: ["builder-portal-login:open"],
      [CRM]: ["street-view:open"],
    });
    vi.stubGlobal("fetch", busy.fetch);
    await sweepPrimeOnlyFunctionsFromFleet();
    expect(primeReads(busy)).toBe(1);

    const clean = fleet({ [DASHBOARD]: ["listings-cache:jwt"], [CRM]: ["crm-send-message:jwt"] });
    vi.stubGlobal("fetch", clean.fetch);
    await sweepPrimeOnlyFunctionsFromFleet();
    expect(primeReads(clean)).toBe(0);
  });

  it("keeps what the prime's own project still runs: dispatching its decommission is the decision", async () => {
    // A name merged onto a RETIRED list before the prime's workflow has run.
    const api = fleet({
      [PRIME]: ["listings-cache:jwt", "builder-portal-login:open"],
      [DASHBOARD]: ["builder-portal-login:open", "street-view:open"],
      [CRM]: ["builder-portal-login:open"],
    });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(api.deletes()).toEqual([`${DASHBOARD}:street-view`]);
    for (const id of ["cd", "crm"]) {
      expect(result.outcomes.find((o) => o.cloneId === id)?.sweep?.kept).toEqual([
        {
          slug: "builder-portal-login",
          why:
            "the prime's own project still runs it: it goes from the clones once the prime's " +
            ".github/workflows/decommission-builder-portal-functions.yml has been dispatched and has deleted it there",
        },
      ]);
    }
  });

  it("deletes nothing retired when the prime's own project cannot be listed, and still takes the prime's own off", async () => {
    // The prime's project answers 404: a token that cannot see it, or no project.
    const api = projects({
      [DASHBOARD]: ["builder-portal-login:open", "migration-dispatcher:jwt"],
      [CRM]: ["street-view:open"],
    });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(api.deletes()).toEqual([`${DASHBOARD}:migration-dispatcher`]);
    const why =
      "the prime's own project could not be listed, so whether its decommission has run cannot be told";
    expect(result.outcomes.find((o) => o.cloneId === "cd")?.sweep?.kept).toEqual([
      { slug: "builder-portal-login", why },
    ]);
    expect(result.outcomes.find((o) => o.cloneId === "crm")?.sweep?.kept).toEqual([
      { slug: "street-view", why },
    ]);
    // Neither clone's tree is worth reading on a pass that cannot decide.
    expect(retired.cloneCarries).not.toHaveBeenCalled();
    expect(fleetFunctionSweepIsNoteworthy({ ...result, deleted: 0 })).toBe(true);
  });

  it("asks a clone recording no default branch for its tree on main", async () => {
    const api = fleet({ [DASHBOARD]: [], [CRM]: ["street-view:open"] });
    vi.stubGlobal("fetch", api.fetch);
    await sweepPrimeOnlyFunctionsFromFleet();
    expect(retired.cloneCarries).toHaveBeenCalledWith({
      owner: "Naidu-Group-Pty-Ltd",
      repo: "npc-crm-independent-6505dc",
      branch: "main",
    });
  });

  it("keeps a retired function a tree still carries, and says which tree", async () => {
    retired.cloneCarries = vi.fn(async () => ({ carries: new Set(["builder-portal-login"]) }));
    openWith(registerOf(RETIRED, ["street-view"]));
    const api = fleet({
      [DASHBOARD]: ["builder-portal-login:open", "street-view:open", "builder-portal-admin:jwt"],
      [CRM]: [],
    });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(api.deletes()).toEqual([`${DASHBOARD}:builder-portal-admin`]);
    const kept = result.outcomes.find((o) => o.cloneId === "cd")?.sweep?.kept ?? [];
    expect(kept.map((k) => k.slug)).toEqual(["builder-portal-login", "street-view"]);
    expect(kept[0].why).toMatch(/^the clone's own tree still carries/);
    expect(kept[1].why).toMatch(
      /^the prime's tree still carries supabase\/functions\/street-view\//,
    );
    expect(fleetFunctionSweepIsNoteworthy({ ...result, deleted: 0 })).toBe(true);
  });

  it("deletes nothing retired from a clone whose own tree could not be read", async () => {
    retired.cloneCarries = vi.fn(async () => ({
      refused: "Naidu-Group-Pty-Ltd/npc-client-dashboard@main could not be read",
    }));
    openWith(registerOf(RETIRED));
    const api = fleet({
      [DASHBOARD]: ["builder-portal-login:open", "migration-dispatcher:jwt"],
      [CRM]: [],
    });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    // The prime's own function still goes: that half never needed the tree.
    expect(api.deletes()).toEqual([`${DASHBOARD}:migration-dispatcher`]);
    expect(result.outcomes.find((o) => o.cloneId === "cd")?.sweep?.kept).toEqual([
      {
        slug: "builder-portal-login",
        why:
          "the clone's own tree could not be read, so its source cannot be ruled out: " +
          "Naidu-Group-Pty-Ltd/npc-client-dashboard@main could not be read",
      },
    ]);
  });

  it("and from a clone recording no repository at all", async () => {
    db.clones = { data: [{ id: "cd", name: "NPC Client Dashboard" }], error: null };
    const api = fleet({ [DASHBOARD]: ["builder-portal-login:open"] });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(api.deletes()).toEqual([]);
    expect(retired.cloneCarries).not.toHaveBeenCalled();
    expect(result.outcomes[0].sweep?.kept?.[0].why).toMatch(
      /the clone records no repository to read its own tree from$/,
    );
  });

  it("deletes nothing retired anywhere on a register it could not read, and still takes the prime's own off", async () => {
    retired.opening = {
      ok: false,
      postponed: false,
      why: "the prime's workflows could not be listed at x@y: HTTP 502",
    };
    const api = fleet({
      [DASHBOARD]: ["builder-portal-login:open", "migration-dispatcher:jwt"],
      [CRM]: ["street-view:open"],
    });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(api.deletes()).toEqual([`${DASHBOARD}:migration-dispatcher`]);
    expect(retired.cloneCarries).not.toHaveBeenCalled();
    expect(result.retired).toEqual({
      readAt: null,
      names: 0,
      unreadable: [],
      refused: "the prime's workflows could not be listed at x@y: HTTP 502",
      postponed: null,
    });
    expect(fleetFunctionSweepIsNoteworthy({ ...result, deleted: 0 })).toBe(true);
  });

  it("puts the read off when the budget says so, which is not worth a line in the audit log", async () => {
    retired.opening = {
      ok: false,
      postponed: true,
      why: "900 call(s) left in the installation's window, below the scan floor of 1500",
    };
    const api = fleet({ [DASHBOARD]: ["builder-portal-login:open"], [CRM]: [] });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(api.deletes()).toEqual([]);
    expect(result.retired?.postponed).toMatch(/below the scan floor/);
    expect(result.retired?.refused).toBeNull();
    expect(fleetFunctionSweepIsNoteworthy(result)).toBe(false);
  });

  it("names a decommission workflow it could not read, while deleting what the others retire", async () => {
    openWith(
      assembleRetiredRegister({
        readAt: "prime@abc",
        workflows: [
          {
            path: ".github/workflows/decommission-builder-portal-functions.yml",
            reading: { kind: "list", names: ["builder-portal-login"] },
          },
          {
            path: ".github/workflows/decommission-retired-functions.yml",
            reading: { kind: "refused", why: "it assigns RETIRED 2 times" },
          },
        ],
        primeTreePaths: [],
      }),
    );
    const api = fleet({
      [DASHBOARD]: ["builder-portal-login:open", "street-view:open"],
      [CRM]: [],
    });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(api.deletes()).toEqual([`${DASHBOARD}:builder-portal-login`]);
    expect(result.retired?.unreadable).toEqual([
      {
        path: ".github/workflows/decommission-retired-functions.yml",
        why: "it assigns RETIRED 2 times",
      },
    ]);
    expect(fleetFunctionSweepIsNoteworthy({ ...result, deleted: 0 })).toBe(true);
  });

  it("never sweeps a retired function off the prime, even where a clone's row names the prime's project", async () => {
    // The prime's own list is the project being swept, so whatever it runs is
    // kept before the prime's ref is even compared; the comparison still
    // stands behind it for the prime-only functions.
    db.backends = { data: [{ clone_id: "cd", supabase_project_ref: PRIME }], error: null };
    const api = fleet({ [PRIME]: ["builder-portal-login:open", "migration-dispatcher:jwt"] });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(api.deletes()).toEqual([]);
    const sweep = result.outcomes.find((o) => o.cloneId === "cd")?.sweep;
    expect(sweep?.kept?.map((k) => k.slug)).toEqual(["builder-portal-login"]);
    expect(sweep?.kept?.[0].why).toMatch(/^the prime's own project still runs it/);
    expect(sweep?.skipped).toMatch(/prime's own project/);
  });

  it("shares the pass's cap with the prime's own functions, and names the rest for the next pass", async () => {
    const many = Array.from({ length: 12 }, (_, i) => `retired-fn-${String(i).padStart(2, "0")}`);
    openWith(registerOf(many));
    const api = fleet({ [DASHBOARD]: many.map((n) => `${n}:open`), [CRM]: [] });
    vi.stubGlobal("fetch", api.fetch);
    const result = await sweepPrimeOnlyFunctionsFromFleet();
    expect(result.deleted).toBe(10);
    expect(result.outcomes.find((o) => o.cloneId === "cd")?.sweep?.deferred).toEqual(
      many.slice(10),
    );
  });
});

describe("what the audit log is told", () => {
  const quiet: FleetFunctionSweepResult = {
    considered: 4,
    deleted: 0,
    failed: 0,
    deferred: 0,
    outcomes: [],
    refused: null,
  };

  it("writes nothing for the steady state and something for every kind of event", () => {
    expect(fleetFunctionSweepIsNoteworthy(quiet)).toBe(false);
    expect(fleetFunctionSweepIsNoteworthy({ ...quiet, deleted: 1 })).toBe(true);
    expect(fleetFunctionSweepIsNoteworthy({ ...quiet, failed: 1 })).toBe(true);
    expect(fleetFunctionSweepIsNoteworthy({ ...quiet, deferred: 1 })).toBe(true);
    expect(fleetFunctionSweepIsNoteworthy({ ...quiet, refused: "x" })).toBe(true);
  });
});

describe("the catch-up runs it first, and not behind the GitHub budget", () => {
  const route = () => readFileSync("src/routes/hooks.backend-catchup.tsx", "utf8");

  it("sweeps before the budget decides whether the catch-up proceeds", () => {
    // Taking the prime's own functions off reads nothing from GitHub, so a
    // pass the budget skips must still take them off.
    const r = route();
    const sweep = r.indexOf("sweepPrimeOnlyFunctionsFromFleet()");
    const budget = r.indexOf('decideSpend({ role: "scan"');
    expect(sweep).toBeGreaterThan(0);
    expect(budget).toBeGreaterThan(sweep);
  });

  it("and the retired half, which does read GitHub, asks the budget before its first call", () => {
    // Asserted on the source, comments stripped: the property is an ORDER
    // and a refusal that is read, which a double of the reader cannot show.
    const reader = stripComments(readFileSync("src/server/retiredFunctions.server.ts", "utf8"));
    const ask = reader.indexOf(
      'decideSpend({ role: "scan", remaining: await readGitHubRemaining() })',
    );
    expect(ask).toBeGreaterThan(0);
    expect(reader.slice(ask)).toMatch(
      /^[^;]*;\s*if \(!spend\.proceed\) return \{ ok: false, postponed: true, why: spend\.why \};/,
    );
    for (const call of ["getAppOctokit()", "fetchSupabaseTreePaths(", "getFileContent("]) {
      const at = reader.indexOf(call, reader.indexOf("export async function"));
      expect(at, call).toBeGreaterThan(ask);
    }
  });

  it("never fails the catch-up, and reports the sweep on both of its answers", () => {
    const r = route();
    const block = r.slice(
      r.indexOf("let primeOnlyFunctions"),
      r.indexOf('decideSpend({ role: "scan"'),
    );
    // Its own try: a sweep that throws is recorded and the catch-up goes on.
    expect(block).toMatch(/try \{[\s\S]*\} catch \(sweepErr\)/);
    expect(block).toContain('action: "prime_only_function_sweep"');
    expect(r).toContain("skipped: spend.why, primeOnlyFunctions");
    expect(r).toContain("...report, primeOnlyFunctions");
  });
});
