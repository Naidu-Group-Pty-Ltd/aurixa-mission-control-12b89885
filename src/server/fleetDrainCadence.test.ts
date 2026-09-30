import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fleetDrainHasWork } from "./fleet-migration.server";
import { isMidSeed, scopeQueueToMode } from "./fleetMigrationEligibility.pure";
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Comments stripped, so prose describing a rule never satisfies a check for it. */
const code = (src: string) => stripComments(src);
const sqlCode = (src: string) => src.replace(/^[ \t]*--.*$/gm, "");

const CURSOR = { migrationId: "20261203000000", statementsDone: 25 };

/*
  THE CADENCE IS READ FROM THE MIGRATIONS, NEVER WRITTEN DOWN HERE.

  The whole claim of this change is a RELATION between two schedules — the
  drain must be faster than the sweep, and must never run beside it — and a
  test carrying its own copy of either one stops testing that the day somebody
  edits a schedule.

  And from the LAST migration that sets each schedule, not the first. This read
  the drain's five-minute step out of the file that created the job, and would have gone
  on reading it after a later migration moved the job — a test of a schedule
  production no longer runs, passing for ever.
*/
const MIGRATIONS = "supabase/migrations";
const migrationCode = readdirSync(join(process.cwd(), MIGRATIONS))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, sql: sqlCode(read(`${MIGRATIONS}/${f}`)) }));

/** Where a job's schedule was last set, and to what. */
const scheduleOf = (job: string): { schedule: string; file: string } => {
  let found: { schedule: string; file: string } | null = null;
  for (const { file, sql } of migrationCode) {
    const created = new RegExp(`cron\\.schedule\\(\\s*'${job}',\\s*'([^']+)'`).exec(sql);
    if (created) found = { schedule: created[1], file };
    // A later `cron.alter_job` in a migration that names the job by its
    // `jobname`, with the schedule either inline or held in a constant.
    if (!sql.includes(`jobname = '${job}'`)) continue;
    const altered = /cron\.alter_job\([^;]*?schedule\s*:=\s*('[^']+'|[a-z_]+)/.exec(sql);
    if (!altered) continue;
    const value = altered[1].startsWith("'")
      ? altered[1].slice(1, -1)
      : new RegExp(`${altered[1]}\\s+CONSTANT\\s+TEXT\\s*:=\\s*'([^']+)'`).exec(sql)?.[1];
    expect(value, `${file} alters ${job} to a schedule this test cannot read`).toBeTruthy();
    found = { schedule: value!, file };
  }
  expect(found, `no migration schedules ${job}`).not.toBeNull();
  return found!;
};

/**
 * The minutes of the hour a schedule fires in. Only the minute field may vary:
 * every fleet schedule is hourly-periodic, and one that is not would make the
 * relations below meaningless rather than false.
 */
const minutesOf = (schedule: string): number[] => {
  const [minute, ...rest] = schedule.trim().split(/\s+/);
  expect(rest, `${schedule} varies by more than the minute`).toEqual(["*", "*", "*", "*"]);
  const out = new Set<number>();
  for (const part of minute.split(",")) {
    const m = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(part);
    expect(m, `cannot read minute field ${part}`).not.toBeNull();
    const from = m![1] === "*" ? 0 : Number(m![1]);
    const to = m![1] === "*" ? 59 : m![2] !== undefined ? Number(m![2]) : m![3] ? 59 : from;
    const step = m![3] ? Number(m![3]) : 1;
    for (let x = from; x <= to; x += step) out.add(x);
  }
  return [...out].sort((a, b) => a - b);
};

/** The shortest gap, in minutes and around the hour, between two sets of firings. */
const closestApproach = (a: number[], b: number[]): number =>
  Math.min(...a.flatMap((x) => b.map((y) => Math.min((x - y + 60) % 60, (y - x + 60) % 60))));

const SWEEP_JOB = "fleet-migration-sync-30min";
const DRAIN_JOB = "fleet-migration-drain-5min";
const DRAIN_SQL = "supabase/migrations/20260920100000_schedule_fleet_migration_drain.sql";
const DRAIN_MOVE_SQL =
  "supabase/migrations/20260926160000_fleet_drain_leaves_the_sweep_its_minutes.sql";

describe("a clone mid-seed is the only thing a drain tick serves", () => {
  it("reads the cursor through the narrowing, never off the column", () => {
    expect(isMidSeed({ chunk_cursor: CURSOR })).toBe(true);
    expect(isMidSeed({ chunk_cursor: null })).toBe(false);
    expect(isMidSeed({})).toBe(false);
  });

  it("a cursor shape this lane cannot act on is not a seed in flight", () => {
    /*
      The case a truthiness check gets wrong, and gets wrong FOR EVER: a row
      carrying jsonb that `chunkCursorFor` refuses would be selected on every
      tick, and no pass can advance it, so nothing about the row ever changes.
    */
    for (const raw of [
      "20261203000000",
      42,
      [],
      {},
      { migrationId: "", statementsDone: 1 },
      { migrationId: "x", statementsDone: -1 },
      { migrationId: "x", statementsDone: 1.5 },
      { migrationId: "x" },
    ]) {
      expect(isMidSeed({ chunk_cursor: raw }), JSON.stringify(raw)).toBe(false);
    }
  });
});

describe("the mode narrows an eligible set and never widens one", () => {
  const rows = [
    { migration_version: "1", clone_id: "a", chunk_cursor: CURSOR },
    { migration_version: "2", clone_id: "b", chunk_cursor: null },
    { migration_version: "3", clone_id: "c" },
  ];

  it("a sweep serves everything it was handed", () => {
    expect(scopeQueueToMode(rows, "sweep").map((r) => r.clone_id)).toEqual(["a", "b", "c"]);
  });

  it("a drain serves only what is mid-seed", () => {
    expect(scopeQueueToMode(rows, "drain").map((r) => r.clone_id)).toEqual(["a"]);
  });

  it("a drain is always a subset of the sweep over the same rows", () => {
    const sweep = new Set(scopeQueueToMode(rows, "sweep").map((r) => r.clone_id));
    for (const r of scopeQueueToMode(rows, "drain")) expect(sweep.has(r.clone_id)).toBe(true);
  });

  it("never mutates or aliases the caller's array", () => {
    const before = [...rows];
    const swept = scopeQueueToMode(rows, "sweep");
    expect(swept).not.toBe(rows);
    expect(rows).toEqual(before);
  });
});

describe("the pass applies the mode after eligibility, and before it spends", () => {
  const lane = code(read("src/server/fleet-migration.server.ts"));
  const entry = lane.indexOf("export async function runFleetMigrationSync");

  it("finds the pass", () => {
    expect(entry).toBeGreaterThan(-1);
  });

  it("narrows the already-eligible rows rather than the whole table", () => {
    const body = lane.slice(entry);
    const scoped = body.indexOf("scopeQueueToMode(");
    expect(scoped, "the pass does not scope its queue to the mode").toBeGreaterThan(-1);
    // The eligibility filter feeds it — so a drain can reach no clone a sweep
    // could not, which is the whole safety argument for a second schedule.
    const fragment = body.slice(scoped, scoped + 200);
    expect(fragment).toContain("verdicts.filter((v) => v.verdict.eligible)");
  });

  it("selects nothing before it opens the prime corpus", () => {
    /*
      What makes a five-minute cadence affordable. The early return on an empty
      batch has to sit ABOVE the corpus open, or an idle drain tick pays for a
      GitHub tree walk and a read of the prime's ledger, 288 times a day.

      One open may sit above it: the sequence test that asks whether a block
      was caused by the lane's own order. That one is behind a SWEEP-only
      guard, so a drain tick still reaches the empty-batch return having read
      nothing from GitHub — which is the property, stated where it holds.
    */
    const body = lane.slice(entry, lane.indexOf("\nexport ", entry + 1));
    const earlyReturn = body.indexOf("if (!backends || backends.length === 0) return out;");
    expect(earlyReturn, "the empty-batch return is gone").toBeGreaterThan(-1);

    const opens: number[] = [];
    for (let at = body.indexOf("openScopedPrimeCorpus(supabase, source)"); at !== -1; ) {
      opens.push(at);
      at = body.indexOf("openScopedPrimeCorpus(supabase, source)", at + 1);
    }
    expect(opens.length, "the corpus open is gone").toBeGreaterThan(0);

    // The replay's own open is below the return.
    expect(opens.filter((at) => at > earlyReturn)).toHaveLength(1);

    // Anything above it is the sequence test, and only a sweep reaches it.
    const above = opens.filter((at) => at < earlyReturn);
    expect(above.length).toBeLessThanOrEqual(1);
    for (const at of above) {
      const guard = body.lastIndexOf('if (mode !== "sweep") continue;', at);
      expect(guard, "a corpus open above the empty-batch return is not sweep-only").toBeGreaterThan(
        -1,
      );
      // Nothing between the guard and the open may leave the guarded branch.
      expect(body.slice(guard, at)).not.toMatch(/\n {4}\}/);
    }
  });
});

describe("the drain's front door may only be more permissive than the pass", () => {
  const lane = code(read("src/server/fleet-migration.server.ts"));
  const fn = lane.slice(lane.indexOf("export async function fleetDrainHasWork"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);

  it("finds it", () => {
    expect(lane.indexOf("export async function fleetDrainHasWork")).toBeGreaterThan(-1);
    expect(body.length).toBeGreaterThan(40);
  });

  it("asks whether anything is mid-seed and nothing else", () => {
    /*
      It deliberately does NOT apply `migrationEligibility`. A clone whose claim
      has gone stale reads as ineligible here and IS served by the pass, because
      `reclaimStale` runs inside it — so asking the full question would skip the
      very tick that recovers it.
    */
    expect(body).toContain("isMidSeed");
    expect(body, "the pre-check must not re-judge eligibility").not.toContain(
      "migrationEligibility",
    );
  });

  /** A `clone_backends` double for the one chain this function uses. */
  const db = (answer: { data?: unknown[]; error?: { message: string } }) =>
    ({
      from: () => ({
        select: () => ({
          not: async () => ({ data: answer.data ?? null, error: answer.error ?? null }),
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it("says yes when a clone carries a cursor", async () => {
    await expect(fleetDrainHasWork(db({ data: [{ chunk_cursor: CURSOR }] }))).resolves.toBe(true);
  });

  it("says no when nothing is in flight", async () => {
    await expect(fleetDrainHasWork(db({ data: [] }))).resolves.toBe(false);
  });

  it("says no when every cursor is one no pass can act on", async () => {
    await expect(
      fleetDrainHasWork(db({ data: [{ chunk_cursor: { migrationId: "" } }] })),
    ).resolves.toBe(false);
  });

  it("fails OPEN: a read that failed is not a fleet with nothing to do", async () => {
    // The pass is what reports a broken read. A drain that silenced itself here
    // would stop for a reason nobody is ever told.
    await expect(fleetDrainHasWork(db({ error: { message: "boom" } }))).resolves.toBe(true);
  });
});

describe("two doors, one handler", () => {
  const sweepRoute = code(read("src/routes/hooks.fleet-migration-sync.tsx"));
  const drainRoute = code(read("src/routes/hooks.fleet-migration-drain.tsx"));
  /*
    THE HANDLER'S OWN BODY, NOT THE MODULE IT LIVES IN.

    It sits in the lane's module (see its header for the gate that decides
    that), and `fleetDrainHasWork` is DEFINED there too — hundreds of lines
    above. An ordering assertion over the whole file therefore compares the
    definition against the call and cannot see the call move at all: planted,
    the reordering passed. Sliced to the function, it fails.
  */
  const laneModule = code(read("src/server/fleet-migration.server.ts"));
  const handlerAt = laneModule.indexOf("export async function handleFleetMigrationCron");
  const handler = laneModule.slice(handlerAt);

  it("each route names its own mode and delegates", () => {
    expect(sweepRoute).toContain('handleFleetMigrationCron(request, "sweep")');
    expect(drainRoute).toContain('handleFleetMigrationCron(request, "drain")');
  });

  it("neither route carries the pass's logic", () => {
    // Two copies of the auth, the allowance and the answer's shape is how one
    // cadence comes to be missing a guard the other has.
    for (const [name, route] of [
      ["sweep", sweepRoute],
      ["drain", drainRoute],
    ] as const) {
      for (const forbidden of ["runFleetMigrationSync", "decideSpend", "verifyCronAuth"]) {
        expect(route, `${name} route re-implements ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("the slice is the handler and not the whole module", () => {
    // A slice from -1 is the whole file, and every ordering assertion below
    // would then be about where things are DEFINED rather than called.
    expect(handlerAt).toBeGreaterThan(-1);
    expect(handler).toContain("verifyCronAuth(request)");
  });

  it("the handler asks the cheap question before it touches GitHub", () => {
    const precheck = handler.indexOf("fleetDrainHasWork(");
    const allowance = handler.indexOf("readGitHubRemaining()");
    expect(precheck, "the drain pre-check is gone").toBeGreaterThan(-1);
    expect(allowance, "the allowance read is gone").toBeGreaterThan(-1);
    expect(precheck).toBeLessThan(allowance);
  });

  it("only the drain skips on the pre-check", () => {
    // A sweep with no seed in flight still has a fleet to walk.
    expect(handler).toContain('mode === "drain" && !(await fleetDrainHasWork(');
  });

  it("the two cadences are attributed apart in the usage meter", () => {
    expect(handler).toContain('beginGithubLane(mode === "drain" ? "fleet-migration-drain"');
  });
});

describe("the drain is scheduled, and faster than the sweep", () => {
  const drain = sqlCode(read(DRAIN_SQL));

  it("runs more often than the sweep it supplements", () => {
    const sweep = minutesOf(scheduleOf(SWEEP_JOB).schedule);
    const drainTicks = minutesOf(scheduleOf(DRAIN_JOB).schedule);
    expect(drainTicks.length).toBeGreaterThan(sweep.length);
  });

  it("posts to the drain door, not the sweep's", () => {
    expect(drain).toContain("'/hooks/fleet-migration-drain'");
    expect(drain).not.toContain("'/hooks/fleet-migration-sync'");
  });

  it("reads the secret inside the command, so a rotation needs no reschedule", () => {
    const command = drain.slice(drain.indexOf("cron.schedule("));
    expect(command).toContain("vault.decrypted_secrets");
    expect(command).toContain("cron_secret");
  });

  it("is idempotent, and re-running leaves a live job alone", () => {
    expect(drain).toContain("IF NOT EXISTS (");
    expect(drain).toContain("FROM cron.job");
    expect(drain).toContain("cron.unschedule('fleet-migration-drain-5min')");
  });
});

describe("two fleet passes never run at once", () => {
  /*
    Measured 26 Sep 2026, over the stretches of the day when a lone pass fitted
    its isolate: every lone drain tick answered 200, and three of the ten paired
    ticks — 13:30, 14:00 and 15:30 — came back as two 502s, one isolate killed
    for memory under both passes. At 15:30 both passes ended in the same instant
    and both claims were left standing. Pairing is not always fatal; it is the
    only condition under which a pass that fits alone has died.
  */
  const sweep = minutesOf(scheduleOf(SWEEP_JOB).schedule);
  const drainTicks = minutesOf(scheduleOf(DRAIN_JOB).schedule);

  it("reads the schedules production runs", () => {
    // The move is the drain's last word; the sweep's is still its own file.
    expect(scheduleOf(DRAIN_JOB).file).toBe(DRAIN_MOVE_SQL.split("/").pop());
    expect(sweep).toEqual([0, 30]);
    expect(drainTicks).toEqual([5, 10, 15, 20, 25, 35, 40, 45, 50, 55]);
  });

  it("the drain never fires in a minute the sweep fires in", () => {
    expect(drainTicks.filter((m) => sweep.includes(m))).toEqual([]);
  });

  it("leaves more than a pass's whole HTTP patience between a sweep and a drain", () => {
    // A pass cannot outlive the request that started it, and that request is
    // given `timeout_milliseconds` — read from the migration that set it, not
    // restated. Firings closer than that can overlap; firings further apart
    // cannot.
    const patience = /'timeout_milliseconds := 60000',\s*'timeout_milliseconds := (\d+)'/.exec(
      sqlCode(read("supabase/migrations/20260922150000_fleet_sync_http_patience.sql")),
    );
    expect(patience, "could not read the fleet jobs' HTTP patience").not.toBeNull();
    const patienceMinutes = Math.ceil(Number(patience![1]) / 60_000);
    expect(closestApproach(sweep, drainTicks)).toBeGreaterThan(patienceMinutes);
  });

  it("moves only the schedule, and only a job still on the old one", () => {
    const move = sqlCode(read(DRAIN_MOVE_SQL));
    // `alter_job` keeps the command — the URL, the vault-read secret and the
    // patience — so the move cannot re-point the job or drop its secret.
    expect(move).toMatch(/cron\.alter_job\(v_job\.jobid, schedule := v_new\)/);
    expect(move).not.toMatch(/cron\.(un)?schedule\(/);
    expect(move).toContain("WHERE jobname = 'fleet-migration-drain-5min'");
    // Asserted by effect: the stored schedule decides, so a job already moved
    // or set by hand is left as it is.
    expect(move).toMatch(
      /ELSIF v_job\.schedule = '\*\/5 \* \* \* \*' THEN\s*PERFORM cron\.alter_job/,
    );
  });
});
