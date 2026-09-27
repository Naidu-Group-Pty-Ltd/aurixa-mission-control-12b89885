/**
 * The prime's own feature, held back wherever a clone is BUILT or MEASURED.
 *
 * `primeOnlyFeatures.pure.ts` names the GoHighLevel account migration as the
 * prime's alone: it was built for one security incident on the prime and no
 * clone receives it. The cascade's half is pinned beside the register. This
 * pins the other half — provisioning, the migration replay and parity — by
 * driving each through the Management API it talks to, because every one of
 * them reads the prime and would otherwise copy what it found:
 *
 * - the function tree a clone is contracted to carry and is deployed from;
 * - the prime's pg_cron schedule, and what a migration schedules on its own;
 * - the prime's storage buckets;
 * - the parity reading that decides whether a clone matches.
 *
 * Measured 27 Sep 2026: every clone ran `migration-dispatcher-15s`, calling a
 * function every fifteen seconds that it will not be given; every clone held
 * the feature's bucket, private and empty, because a migration creates it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const primeConfig = vi.hoisted(() => ({
  read: vi.fn(
    async (): Promise<{
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    }> => ({
      data: { supabase_project_ref: "primeprimeprimeprime" },
      error: null,
    }),
  ),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ limit: () => ({ maybeSingle: primeConfig.read }) }),
    }),
  },
}));

import {
  applyPrimeMigrations,
  replicateCronJobs,
  replicateStorageBuckets,
  sweepPrimeOnlyCronJobs,
  type PrimeCronJob,
} from "./backend-provisioning.server";
import {
  classifyEdgeFunctionShortfall,
  diffBuckets,
  diffCron,
  primeOnlyParityLine,
} from "./handoff-parity.server";
import { isCloneFunctionPath } from "./prime-backend.server";
import { shouldSkipFunctionSource, withoutPrimeOnlyFunctions } from "./primeScanCache.pure";
import { CRON_UNSCHEDULE, recordingManagementApi } from "./managementApiRecorder.test-support";

const PRIME = "primeprimeprimeprime";
const CLONE = "cloneclonecloneclone";

/** The live prime-only job, written the way migration 20260725000000 writes it. */
const DISPATCHER_COMMAND = `select public.cron_invoke_signed_function(
  'migration-dispatcher',
  '{}'::jsonb
);`;
const ORDINARY_COMMAND = `select net.http_post(url := 'https://${PRIME}.supabase.co/functions/v1/listings-cache', body := '{}'::jsonb);`;

type Answer = unknown | ((query: string) => unknown);

/**
 * A Management API that answers `database/query` by the first pattern the
 * query matches, and records every request. A `Response` in the table is
 * returned as it stands, so a test can make one query fail.
 */
function managementApi(table: Array<[RegExp, Answer]>) {
  const queries: string[] = [];
  const requests: Array<{ url: string; method: string; body: string }> = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: unknown }) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url: u, method, body });
    if (u.endsWith("/database/query")) {
      const { query } = JSON.parse(body) as { query: string };
      queries.push(query);
      for (const [rx, answer] of table) {
        if (!rx.test(query)) continue;
        const value =
          typeof answer === "function" ? (answer as (q: string) => unknown)(query) : answer;
        return value instanceof Response ? value : json(value);
      }
      return json([]);
    }
    for (const [rx, answer] of table) {
      if (!rx.test(u)) continue;
      const value = typeof answer === "function" ? (answer as (q: string) => unknown)(u) : answer;
      return value instanceof Response ? value : json(value);
    }
    return json({ message: "not stubbed" }, 404);
  });
  return { fetch, queries, requests };
}

const SWEEP_READ = /select jobid, jobname, command from cron\.job/;

beforeEach(() => {
  vi.stubEnv("SB_MGMT_API_TOKEN", "test-token");
  primeConfig.read.mockClear();
  primeConfig.read.mockImplementation(async () => ({
    data: { supabase_project_ref: PRIME },
    error: null,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sweepPrimeOnlyCronJobs — the prime's own jobs, taken off a clone", () => {
  const schedule = [
    { jobid: 38, jobname: "migration-dispatcher-15s", command: DISPATCHER_COMMAND },
    { jobid: 5, jobname: "listings-cache-sync", command: ORDINARY_COMMAND },
  ];

  it("unschedules the prime's job by its id, and nothing else", async () => {
    const api = managementApi([[SWEEP_READ, schedule]]);
    vi.stubGlobal("fetch", api.fetch);
    const sweep = await sweepPrimeOnlyCronJobs(CLONE, { primeRef: PRIME });
    expect(sweep.skipped).toBeNull();
    expect(sweep.failed).toEqual([]);
    expect(sweep.unscheduled.map((j) => [j.jobid, j.jobname])).toEqual([
      [38, "migration-dispatcher-15s"],
    ]);
    const unscheduled = api.queries.filter((q) => CRON_UNSCHEDULE.test(q));
    expect(unscheduled).toEqual(["select cron.unschedule(38::bigint);"]);
  });

  it("never acts on the prime's own project", async () => {
    const api = managementApi([[SWEEP_READ, schedule]]);
    vi.stubGlobal("fetch", api.fetch);
    const sweep = await sweepPrimeOnlyCronJobs(PRIME, { primeRef: PRIME.toUpperCase() });
    expect(sweep.unscheduled).toEqual([]);
    expect(sweep.skipped).toMatch(/prime's own project/);
    expect(api.queries.some((q) => CRON_UNSCHEDULE.test(q))).toBe(false);
  });

  it("resolves the prime from prime_config when the caller did not name it", async () => {
    const api = managementApi([[SWEEP_READ, schedule]]);
    vi.stubGlobal("fetch", api.fetch);
    const sweep = await sweepPrimeOnlyCronJobs(CLONE);
    expect(primeConfig.read).toHaveBeenCalledTimes(1);
    expect(sweep.unscheduled.map((j) => j.jobid)).toEqual([38]);
  });

  it("and refuses when prime_config names the project it is looking at", async () => {
    primeConfig.read.mockImplementation(async () => ({
      data: { supabase_project_ref: CLONE },
      error: null,
    }));
    const api = managementApi([[SWEEP_READ, schedule]]);
    vi.stubGlobal("fetch", api.fetch);
    const sweep = await sweepPrimeOnlyCronJobs(CLONE);
    expect(sweep.unscheduled).toEqual([]);
    expect(api.queries.some((q) => CRON_UNSCHEDULE.test(q))).toBe(false);
  });

  it("fails closed when the prime cannot be resolved — a sweep that cannot tell where it is does nothing", async () => {
    primeConfig.read.mockImplementation(async () => ({
      data: null,
      error: { message: "connection refused" },
    }));
    const api = managementApi([[SWEEP_READ, schedule]]);
    vi.stubGlobal("fetch", api.fetch);
    const sweep = await sweepPrimeOnlyCronJobs(CLONE);
    expect(sweep.unscheduled).toEqual([]);
    expect(sweep.skipped).toMatch(/could not be resolved/);
    expect(api.queries.some((q) => CRON_UNSCHEDULE.test(q))).toBe(false);
  });

  it("does not ask for the prime when there is nothing of its own on the clone", async () => {
    const api = managementApi([[SWEEP_READ, [schedule[1]]]]);
    vi.stubGlobal("fetch", api.fetch);
    const sweep = await sweepPrimeOnlyCronJobs(CLONE);
    expect(sweep).toEqual({ unscheduled: [], failed: [], skipped: null });
    expect(primeConfig.read).not.toHaveBeenCalled();
  });

  it("never throws when the schedule cannot be read", async () => {
    const api = managementApi([[SWEEP_READ, new Response("boom", { status: 500 })]]);
    vi.stubGlobal("fetch", api.fetch);
    const sweep = await sweepPrimeOnlyCronJobs(CLONE, { primeRef: PRIME });
    expect(sweep.unscheduled).toEqual([]);
    expect(sweep.skipped).toMatch(/could not be read/);
  });

  it("records a job it could not unschedule, and still takes the rest", async () => {
    const byUrl = {
      jobid: 41,
      jobname: "ghl-contacts-drain",
      command: `select net.http_post(url := 'https://${CLONE}.supabase.co/functions/v1/ghl-migrate-contacts-worker');`,
    };
    const api = managementApi([
      [SWEEP_READ, [schedule[0], byUrl, schedule[1]]],
      [
        /cron\.unschedule\(38::bigint\)/,
        new Response("could not find valid entry", { status: 400 }),
      ],
    ]);
    vi.stubGlobal("fetch", api.fetch);
    const sweep = await sweepPrimeOnlyCronJobs(CLONE, { primeRef: PRIME });
    expect(sweep.failed.map((j) => j.jobid)).toEqual([38]);
    expect(sweep.unscheduled.map((j) => j.jobid)).toEqual([41]);
  });
});

describe("replicateCronJobs — the prime's own jobs are not copied, and are taken off", () => {
  const primeJobs: PrimeCronJob[] = [
    {
      jobid: 1,
      jobname: "migration-dispatcher-15s",
      schedule: "15 seconds",
      command: DISPATCHER_COMMAND,
      active: true,
      database: "postgres",
    },
    {
      jobid: 2,
      jobname: "listings-cache-sync",
      schedule: "*/5 * * * *",
      command: ORDINARY_COMMAND,
      active: true,
      database: "postgres",
    },
  ];
  // The clone as a migration left it: the dispatcher is already scheduled.
  const cloneSchedule = [
    {
      jobid: 38,
      jobname: "migration-dispatcher-15s",
      schedule: "15 seconds",
      command: DISPATCHER_COMMAND,
      active: true,
    },
  ];

  it("schedules the ordinary job, never the prime's, and sweeps the one a migration left", async () => {
    const api = managementApi([
      [/select jobname, schedule, command, active from cron\.job/, cloneSchedule],
      [SWEEP_READ, cloneSchedule],
    ]);
    vi.stubGlobal("fetch", api.fetch);
    const results = await replicateCronJobs(CLONE, PRIME, primeJobs);

    expect(api.queries.some((q) => /cron\.schedule\('migration-dispatcher/.test(q))).toBe(false);
    expect(api.queries.some((q) => /cron\.schedule\('listings-cache-sync'/.test(q))).toBe(true);
    expect(api.queries.filter((q) => CRON_UNSCHEDULE.test(q))).toEqual([
      "select cron.unschedule(38::bigint);",
    ]);

    const byName = new Map(results.map((r) => [r.jobname, r]));
    expect(byName.get("listings-cache-sync")?.status).toBe("replicated");
    expect(byName.get("migration-dispatcher-15s")?.status).toBe("skipped");
    expect(byName.get("migration-dispatcher-15s")?.reason).toMatch(/unscheduled from this clone/);
    // One entry per job: the sweep amends the skip rather than adding a second.
    expect(results.filter((r) => r.jobname === "migration-dispatcher-15s")).toHaveLength(1);
  });

  it("says why it skipped the prime's job when the clone does not have it", async () => {
    const api = managementApi([
      [/select jobname, schedule, command, active from cron\.job/, []],
      [SWEEP_READ, []],
    ]);
    vi.stubGlobal("fetch", api.fetch);
    const results = await replicateCronJobs(CLONE, PRIME, primeJobs);
    const skipped = results.find((r) => r.jobname === "migration-dispatcher-15s");
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.reason).toMatch(/^prime-only — GoHighLevel account migration/);
  });

  it("leaves the sweep to the next pass when the budget is spent", async () => {
    const api = managementApi([
      [/select jobname, schedule, command, active from cron\.job/, cloneSchedule],
      [SWEEP_READ, cloneSchedule],
    ]);
    vi.stubGlobal("fetch", api.fetch);
    const results = await replicateCronJobs(CLONE, PRIME, primeJobs, undefined, Date.now() - 1);
    expect(results.find((r) => r.jobname === "listings-cache-sync")?.status).toBe("deferred");
    expect(api.queries.some((q) => SWEEP_READ.test(q))).toBe(false);
  });
});

describe("replicateStorageBuckets — the prime's own bucket is left as the clone has it", () => {
  const ghl = {
    id: "ghl-marketing-dump",
    name: "ghl-marketing-dump",
    public: false,
    file_size_limit: null,
    allowed_mime_types: null,
  };
  const branding = {
    id: "brand-assets",
    name: "brand-assets",
    public: true,
    file_size_limit: null,
    allowed_mime_types: null,
  };
  const keys = [
    { name: "anon", api_key: "anon-key" },
    { name: "service_role", api_key: "service-key" },
  ];

  it.each([
    ["holds it with a configuration of its own", [{ ...ghl, public: true }]],
    ["does not hold it", []],
  ])("is neither created nor reconfigured when the clone %s", async (_label, onClone) => {
    const api = managementApi([
      [new RegExp(`/projects/${PRIME}/storage/buckets$`), [ghl, branding]],
      [new RegExp(`/projects/${CLONE}/storage/buckets$`), onClone],
      [/\/api-keys\?reveal=true$/, keys],
      [/\/storage\/v1\/bucket$/, { name: "brand-assets" }],
    ]);
    vi.stubGlobal("fetch", api.fetch);
    const results = await replicateStorageBuckets(PRIME, CLONE);

    const held = results.find((r) => r.id === "ghl-marketing-dump");
    expect(held?.status).toBe("withheld");
    expect(held?.withheld).toMatch(/^prime-only — GoHighLevel account migration/);
    const writes = api.requests.filter((r) => r.method !== "GET");
    expect(writes.some((w) => w.body.includes("ghl-marketing-dump"))).toBe(false);
    // An ordinary bucket still takes the create path.
    expect(writes.some((w) => w.body.includes("brand-assets"))).toBe(true);
    expect(results.find((r) => r.id === "brand-assets")?.status).toBe("created");
  });
});

describe("applyPrimeMigrations — what a replay scheduled is swept after it", () => {
  const MIGRATION = {
    id: "20260725000000",
    name: "20260725000000_schedule_dispatcher.sql",
    sql: "select 1;",
  };
  const dispatcherOnClone = [
    { jobid: 38, jobname: "migration-dispatcher-15s", command: DISPATCHER_COMMAND },
  ];

  it("unschedules the prime's job after a pass that sent something", async () => {
    const api = recordingManagementApi({ cronJobs: dispatcherOnClone });
    vi.stubGlobal("fetch", vi.fn(api.fetch));
    const out = await applyPrimeMigrations(CLONE, [MIGRATION]);
    expect(out.results[0].success).toBe(true);
    // What the clone was sent is still the migration alone.
    expect(api.bodies()).toEqual(["select 1;"]);
    expect(api.sent.filter((q) => CRON_UNSCHEDULE.test(q))).toEqual([
      "select cron.unschedule(38::bigint);",
    ]);
    expect(out.primeOnlyCronSweep?.unscheduled.map((j) => j.jobname)).toEqual([
      "migration-dispatcher-15s",
    ]);
  });

  it("reads nothing more when the pass sent nothing", async () => {
    const api = recordingManagementApi({
      applied: [MIGRATION.id],
      tables: 10,
      cronJobs: dispatcherOnClone,
    });
    vi.stubGlobal("fetch", vi.fn(api.fetch));
    const out = await applyPrimeMigrations(CLONE, [MIGRATION]);
    // Held already: the frontier moves, and nothing was sent.
    expect(out.results).toEqual([
      { id: MIGRATION.id, name: MIGRATION.name, success: true, skipped: true },
    ]);
    expect(api.bodies()).toEqual([]);
    expect(out.primeOnlyCronSweep).toBeNull();
    expect(api.sent.some((q) => SWEEP_READ.test(q))).toBe(false);
  });

  it("leaves the sweep to the pass that continues one the budget stopped", async () => {
    const api = recordingManagementApi({ cronJobs: dispatcherOnClone });
    vi.stubGlobal("fetch", vi.fn(api.fetch));
    const second = { id: "20260725000001", name: "20260725000001_more.sql", sql: "select 2;" };
    const out = await applyPrimeMigrations(
      CLONE,
      [MIGRATION, second],
      undefined,
      undefined,
      undefined,
      {
        // The first migration is always attempted; the second is refused.
        isPastDeadline: () => true,
      },
    );
    expect(out.stoppedEarly).toBe(true);
    expect(out.latestApplied).toBe(MIGRATION.id);
    expect(out.primeOnlyCronSweep).toBeNull();
    expect(api.sent.some((q) => SWEEP_READ.test(q))).toBe(false);
  });

  it("sweeps after a migration that failed — it may have committed what it scheduled", async () => {
    const api = recordingManagementApi({
      cronJobs: dispatcherOnClone,
      refuse: (q) => q === MIGRATION.sql,
    });
    vi.stubGlobal("fetch", vi.fn(api.fetch));
    const out = await applyPrimeMigrations(CLONE, [MIGRATION]);
    expect(out.results[0].success).toBe(false);
    expect(out.primeOnlyCronSweep?.unscheduled.map((j) => j.jobid)).toEqual([38]);
  });

  it("never fails the replay it follows", async () => {
    const api = recordingManagementApi({
      cronJobs: dispatcherOnClone,
      refuse: (q) => CRON_UNSCHEDULE.test(q),
    });
    vi.stubGlobal("fetch", vi.fn(api.fetch));
    const out = await applyPrimeMigrations(CLONE, [MIGRATION]);
    expect(out.results).toEqual([{ id: MIGRATION.id, name: MIGRATION.name, success: true }]);
    expect(out.latestApplied).toBe(MIGRATION.id);
    expect(out.primeOnlyCronSweep?.failed.map((j) => j.jobid)).toEqual([38]);
  });
});

describe("the function tree a clone is built from leaves the prime's own feature out", () => {
  it("reads a prime-only function's files, and its shared modules, as not a clone's", () => {
    expect(isCloneFunctionPath("supabase/functions/listings-cache/index.ts")).toBe(true);
    expect(isCloneFunctionPath("supabase/functions/_shared/cors.ts")).toBe(true);
    expect(isCloneFunctionPath("supabase/functions/migration-dispatcher/index.ts")).toBe(false);
    expect(isCloneFunctionPath("supabase/functions/ghl-migrate-contacts-worker/index.ts")).toBe(
      false,
    );
    expect(isCloneFunctionPath("supabase/functions/_shared/migration-jobs.ts")).toBe(false);
    expect(isCloneFunctionPath("src/pages/admin/GhlMigration.tsx")).toBe(false);
  });

  it("is asked at every place the tree is read, so the contract and the deploy set agree", () => {
    // The declared slugs are what a clone is CONTRACTED to carry and the
    // bundles are what it is GIVEN. A slug in the first that is never in the
    // second is a livelock: the pass that fetches no source waits for every
    // declared slug to be live on the clone.
    const src = readFileSync("src/server/prime-backend.server.ts", "utf8");
    expect(src).not.toMatch(/\.filter\(\(b\) => b\.path\.startsWith\(FUNCTIONS_PREFIX\)\)/);
    expect(src.split("isCloneFunctionPath(b.path)").length - 1).toBe(3);
  });

  it("reads a scan cached before the feature was held back through the same rule", () => {
    // A row keyed by commit still names the prime's functions. Read as it
    // stands, the skip would wait for them to go live on the clone — and they
    // never will — so every pass would buy the fetch the cache exists to skip.
    const cached = ["listings-cache", "migration-dispatcher", "ghl-account-preview"];
    const live = ["listings-cache"];
    const input = (declared: string[]) => ({
      resumingSchema: false,
      cachedSecretNames: ["OPENAI_API_KEY"],
      cachedDeclaredSlugs: declared,
      liveFunctionSlugs: live,
    });
    expect(shouldSkipFunctionSource(input(cached))).toBe(false);
    expect(withoutPrimeOnlyFunctions(cached)).toEqual(["listings-cache"]);
    expect(shouldSkipFunctionSource(input(withoutPrimeOnlyFunctions(cached)))).toBe(true);
  });

  it("and the provisioning pass does read the cache through it", () => {
    const src = readFileSync("src/lib/backend-provisioning.functions.ts", "utf8");
    expect(src).toMatch(
      /withoutPrimeOnlyFunctions\(cachedScan\.declared_function_slugs as string\[\]\)/,
    );
    // Read once, and the filtered value is what both the skip and the splice use.
    expect(src.split("cachedScan.declared_function_slugs as string[]").length - 1).toBe(1);
  });
});

describe("parity counts the prime's own feature as withheld, never as missing", () => {
  it("does not call an absent prime-only function a gap — even with no declared set to read", () => {
    const r = classifyEdgeFunctionShortfall(
      ["listings-cache", "migration-dispatcher", "ghl-account-preview"],
      ["listings-cache"],
      null,
    );
    expect(r.missing).toEqual([]);
    expect(r.undeclared).toEqual([]);
    expect(r.withheld).toEqual(["ghl-account-preview", "migration-dispatcher"]);
  });

  it("does not call it residue the prime's repository dropped", () => {
    // The declared set is read without the prime's own functions, so asked
    // second they would read as dead code on the prime. They are policy.
    const r = classifyEdgeFunctionShortfall(
      ["listings-cache", "migration-dispatcher"],
      ["listings-cache"],
      new Set(["listings-cache"]),
    );
    expect(r.undeclared).toEqual([]);
    expect(r.withheld).toEqual(["migration-dispatcher"]);
  });

  it("names a prime-only function the clone still runs, without calling it surplus", () => {
    const r = classifyEdgeFunctionShortfall(
      ["listings-cache", "migration-dispatcher"],
      ["listings-cache", "migration-dispatcher", "ghl-migrate-notes-worker"],
      new Set(["listings-cache"]),
    );
    expect(r.primeOnlyPresent).toEqual(["ghl-migrate-notes-worker", "migration-dispatcher"]);
    expect(r.extra).toEqual([]);
    expect(r.missing).toEqual([]);
  });

  type CronSnap = Parameters<typeof diffCron>[0];
  const cronSnap = (jobs: Array<Partial<PrimeCronJob> & { jobname: string }>) =>
    ({
      cronByName: new Map(
        jobs.map((j) => [
          j.jobname,
          { schedule: "* * * * *", command: "select 1", active: true, ...j },
        ]),
      ),
    }) as unknown as CronSnap;

  it("withholds the prime's job from a clone's schedule and names one the clone still runs", () => {
    const prime = cronSnap([
      { jobname: "migration-dispatcher-15s", command: DISPATCHER_COMMAND },
      { jobname: "listings-cache-sync" },
    ]);
    const absent = diffCron(prime, cronSnap([{ jobname: "listings-cache-sync" }]));
    expect(absent.missing_in_target).toEqual([]);
    expect(absent.withheld_by_policy).toEqual(["migration-dispatcher-15s"]);
    expect(absent.prime_only_in_target).toEqual([]);

    const present = diffCron(
      prime,
      cronSnap([
        {
          jobname: "migration-dispatcher-15s",
          command: DISPATCHER_COMMAND,
          schedule: "30 seconds",
        },
        { jobname: "listings-cache-sync" },
      ]),
    );
    expect(present.prime_only_in_target).toEqual(["migration-dispatcher-15s"]);
    // Not drift and not surplus: it should not be there at all.
    expect(present.schedule_drift).toEqual([]);
    expect(present.extra_in_target).toEqual([]);
  });

  it("still reports an ordinary job the clone lacks", () => {
    const d = diffCron(cronSnap([{ jobname: "listings-cache-sync" }]), cronSnap([]));
    expect(d.missing_in_target).toEqual(["listings-cache-sync"]);
  });

  type BucketSnap = Parameters<typeof diffBuckets>[0];
  const bucketSnap = (ids: Array<{ id: string; public?: boolean }>) =>
    ({
      bucketsById: new Map(
        ids.map((b) => [
          b.id,
          {
            id: b.id,
            name: b.id,
            public: b.public ?? false,
            file_size_limit: null,
            allowed_mime_types: null,
          },
        ]),
      ),
    }) as unknown as BucketSnap;

  it("withholds the prime's bucket and never reads its configuration as drift", () => {
    const prime = bucketSnap([{ id: "ghl-marketing-dump" }, { id: "brand-assets" }]);
    const absent = diffBuckets(prime, bucketSnap([{ id: "brand-assets" }]));
    expect(absent.missing_in_target).toEqual([]);
    expect(absent.withheld_by_policy).toEqual(["ghl-marketing-dump"]);

    const drifted = diffBuckets(
      prime,
      bucketSnap([{ id: "ghl-marketing-dump", public: true }, { id: "brand-assets" }]),
    );
    expect(drifted.config_drift).toEqual([]);
    expect(drifted.withheld_by_policy).toEqual([]);
  });

  it("says both halves in the summary, and nothing when there is nothing to say", () => {
    const none = { withheld_by_policy: [], prime_only_in_target: [] };
    expect(primeOnlyParityLine(none, none, { withheld_by_policy: [] })).toBe("");
    const line = primeOnlyParityLine(
      { withheld_by_policy: ["migration-dispatcher"], prime_only_in_target: [] },
      { withheld_by_policy: [], prime_only_in_target: ["migration-dispatcher-15s"] },
      { withheld_by_policy: [] },
    );
    expect(line).toMatch(/withheld by policy: edge-fns=1/);
    expect(line).toMatch(/still on this clone: cron=1/);
    expect(line).toMatch(/not blocking/);
  });
});
