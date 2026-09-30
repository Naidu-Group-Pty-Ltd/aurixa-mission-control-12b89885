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

type Answer<T> = { data: T; error: { message: string } | null };

const db = vi.hoisted(() => ({
  prime: null as unknown as Answer<{ supabase_project_ref: string } | null>,
  clones: null as unknown as Answer<Array<{ id: string; name: string | null }> | null>,
  backends: null as unknown as Answer<Array<{
    clone_id: string | null;
    supabase_project_ref: string | null;
  }> | null>,
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

const PRIME = "primeprimeprimeprime";
const DASHBOARD = "dashboarddashboardda";
const CRM = "crmcrmcrmcrmcrmcrmcr";

/** Each project's deployed functions, and every request made. */
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
      return new Response(JSON.stringify(slugs.map((slug) => ({ slug, name: slug }))), {
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

beforeEach(() => {
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
    // The sweep reads nothing from GitHub, so a pass the budget skips must
    // still take the functions off.
    const r = route();
    const sweep = r.indexOf("sweepPrimeOnlyFunctionsFromFleet()");
    const budget = r.indexOf('decideSpend({ role: "scan"');
    expect(sweep).toBeGreaterThan(0);
    expect(budget).toBeGreaterThan(sweep);
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
