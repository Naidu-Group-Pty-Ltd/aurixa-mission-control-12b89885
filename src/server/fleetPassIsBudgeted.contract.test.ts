/**
 * The fleet migration sync is bounded, and what it stopped inside is resumable.
 *
 * Structural, reading the source, in the pattern of
 * `sqlMigrationLane.contract.test.ts`: what this file is about is the ORDER of
 * a claim against a deadline and the PRESENCE of a cursor on a call, and a
 * Supabase double would agree with wrong code on both.
 *
 * ## What was measured
 *
 * The lane passed `{ streamSql }` with no budget and no cursor, deliberately,
 * saying a killed pass "is reclaimed after `STALE_CLAIM_MINUTES` and re-sends
 * from the first statement … Slower, never wrong." Idempotent, yes. Slower,
 * no: a ~40 MB seed cannot be finished inside one invocation of this runtime,
 * so every pass restarted at statement 1 and was killed before the end, and
 * the seed never landed however often it was tried.
 *
 * It was invisible for as long as the body could not be fetched — a 403 comes
 * back in milliseconds, so the pass completed in about eight seconds and
 * reported an honest hold. On 19 Sep 2026, the day the streaming fetch first
 * worked, the two passes that followed both died mid-seed: no
 * `lane:fleet-migration-sync` usage row, `worker_started_at` left set on two
 * clones, and no clone's `migration_version` moved. A leaked claim does not
 * only delay its own clone — the candidate list is filtered on the claim being
 * free, so the fleet behind it waits too.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Source with comments removed — a comment quoting code is not code. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const lane = code(read("src/server/fleet-migration.server.ts"));
/**
 * The cadence, read from the migration that schedules the job rather than
 * written down here. The reclaim window below is only meaningful in relation
 * to it, and two copies of a number are how the two come to disagree.
 */
const FLEET_CADENCE_MINUTES = (() => {
  const sql = read("supabase/migrations/20260827070000_schedule_fleet_migration_sync.sql");
  const m = /cron\.schedule\(\s*'fleet-migration-sync-30min',\s*'\*\/(\d+) \* \* \* \*'/.exec(sql);
  expect(m, "could not read the fleet sync's cron schedule from its migration").not.toBeNull();
  return Number(m![1]);
})();

const entry = lane.indexOf("export async function runFleetMigrationSync");
const loop = lane.indexOf("for (const backend of backends)");
const laneBody = lane.slice(entry);

describe("the slices this file reads exist", () => {
  it("finds the lane and its clone loop", () => {
    // A slice from -1 is the whole file and every assertion below would pass
    // over it — the trap this suite's siblings have been caught by twice.
    expect(entry).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(entry);
  });
});

const CLAIM_GUARD = "if (Date.now() + CLAIM_RESERVE_MS >= deadlineAt)";
/**
 * The claim's own write. Anchored on the FIELD rather than on the whole
 * `.update({ … })` call: the call gained a second field when the heartbeat was
 * added, and a one-line anchor silently stopped matching — an assertion that
 * then tested nothing, which this suite has been caught by before.
 */
const CLAIM_WRITE = "worker_started_at: new Date().toISOString()";

describe("a pass is bounded", () => {
  it("takes its deadline at entry, before the first read", () => {
    const deadline = laneBody.indexOf("const deadlineAt =");
    const firstRead = laneBody.indexOf("await ");
    expect(deadline).toBeGreaterThan(-1);
    expect(firstRead).toBeGreaterThan(-1);
    expect(deadline).toBeLessThan(firstRead);
  });

  it("declares a budget of its own rather than borrowing another lane's name", () => {
    expect(lane).toMatch(/const FLEET_PASS_BUDGET_MS = 45_000;/);
  });

  it("checks the deadline BEFORE claiming, so an out-of-time pass leaks nothing", () => {
    const check = lane.indexOf(CLAIM_GUARD);
    const claim = lane.indexOf(CLAIM_WRITE);
    expect(check).toBeGreaterThan(loop);
    expect(claim).toBeGreaterThan(-1);
    expect(check, "the deadline must be read before the claim is taken").toBeLessThan(claim);
  });

  it("stops rather than skipping, so it does not walk the rest of the fleet for nothing", () => {
    const check = lane.indexOf(CLAIM_GUARD);
    const after = lane.slice(check, check + 160);
    expect(after).toContain("break;");
    expect(after).not.toContain("continue;");
  });

  /*
    BEING BEFORE THE DEADLINE IS NOT HAVING TIME TO DO ANYTHING.

    The guard was a bare `Date.now() >= deadlineAt`, so a claim could be taken
    with milliseconds left — and was, three times on 19 Sep. The replay's first
    act is opening a 40 MB seed, which cannot finish in what remained, and the
    isolate was killed holding the claim.

    The reserve is a floor rather than a measurement and the constant says so.
    What is pinned here is that there IS one and that it is subtracted from the
    time remaining, because a guard with no reserve is the shape that leaked.
  */
  it("reserves time for the work before taking a claim, not merely the deadline", () => {
    expect(lane).toMatch(/const CLAIM_RESERVE_MS = [\d_]+;/);
    expect(lane, "the claim guard spends no reserve").toContain(CLAIM_GUARD);
  });

  /*
    A LEAKED CLAIM MUST NOT COST A WHOLE PASS.

    The window was thirty minutes of AGE alone, which is exactly the cadence —
    the worst possible value, because it guarantees a claim leaked at 12:00:49
    is still 29.2 minutes old at 12:30 and is freed only at 13:00. Measured
    three times on 19 Sep; `backends` filters on the claim being free, so the
    clone is out of the fleet for the whole of that pass.

    Age alone could not be shortened, because age alone cannot tell a run that
    is working from one that is dead — so the number had to cover the slowest
    legitimate run. The heartbeat answers that question directly instead.
  */
  it("frees a claim before the next pass could have used it", () => {
    const m = /const STALE_CLAIM_MINUTES = (\d+);/.exec(lane);
    expect(m, "STALE_CLAIM_MINUTES is not declared as a plain number").not.toBeNull();
    expect(
      Number(m![1]),
      "a reclaim window at or past the cadence makes every leaked claim cost a full pass",
    ).toBeLessThan(FLEET_CADENCE_MINUTES);
  });

  const reclaimBody = (): string => {
    const at = lane.indexOf("async function reclaimStale");
    expect(at, "reclaimStale not found").toBeGreaterThan(-1);
    const end = lane.indexOf("\n}\n", at);
    expect(end, "no closing brace for reclaimStale").toBeGreaterThan(at);
    return lane.slice(at, end);
  };

  it("asks whether the run is ALIVE, not only whether the claim is old", () => {
    // Without this the window cannot be short: a slow-but-working run would be
    // stolen from and two passes would apply the same migrations at once.
    const body = reclaimBody();
    expect(body).toContain('.lt("worker_started_at", cutoff)');
    expect(body, "a claim is reclaimed on age alone, so a live run can be stolen").toContain(
      '.lt("migration_heartbeat_at", cutoff)',
    );
  });

  /*
    AND THE HEARTBEAT IS THIS LANE'S OWN COLUMN.

    The first version of this read `updated_at`, reasoning that the replay
    writes the cursor on every statement and the table's trigger bumps it. The
    reasoning is wrong in the direction that matters: `updated_at` is ROW-wide,
    and the reference-data lane claims and releases the same `ready` backend
    through `reference_sync_started_at` without ever looking at
    `worker_started_at`. Its cadence writes this row two minutes before every
    fleet pass, so a dead claim on any clone it touches would read as alive for
    ever — worse than the window it replaced. Raised by review.
  */
  it("never reads a timestamp another lane also writes", () => {
    expect(
      reclaimBody(),
      "updated_at is row-wide; the reference lane refreshes it minutes before every fleet pass",
    ).not.toContain("updated_at");
  });

  it("stamps the heartbeat WITH the claim, not only on the first statement", () => {
    // The longest silent stretch of a living pass is the initial download,
    // before any statement can be recorded. A heartbeat first written by
    // statement one is absent for exactly that stretch, which is the stretch
    // the window has to cover.
    const at = lane.indexOf(CLAIM_WRITE);
    expect(at, "the claim write was not found").toBeGreaterThan(-1);
    expect(
      lane.slice(at, at + 400),
      "the claim is taken without a heartbeat, so the download looks like death",
    ).toContain("migration_heartbeat_at: new Date().toISOString()");
  });

  it("beats it on every statement the replay sends", () => {
    const at = lane.indexOf("onStatementDone");
    expect(at, "onStatementDone not found").toBeGreaterThan(-1);
    expect(lane.slice(at, at + 700)).toContain("migration_heartbeat_at");
  });

  /*
    NEVER A COMPOSED FILTER.

    "old AND (quiet OR never beat)" reads as one `.or(...)`, and an `.or()`
    here would be a STRING with a timestamp interpolated into it — the filter
    this platform has already paid for once, where the screening consumer's
    claim predicate never parsed and had never once succeeded while its code
    and its test double agreed with each other.
  */
  it("composes no filter as a string", () => {
    expect(reclaimBody()).not.toContain(".or(");
  });

  /*
    AND THE TWO SWEEPS CARRY THE SAME GUARD.

    Splitting "old AND (quiet OR never beat)" into two statements repeats the
    guard that makes either one safe — the claimable status set and the pair
    that says a claim is actually held. Written twice, one of them can lose a
    line, and a reclaim missing `.not("worker_started_at", "is", null)` would
    clear claims nobody holds while a reclaim missing the status filter would
    reach rows this lane never touches.

    So the repetition is checked rather than trusted. This is what licenses
    writing it out instead of composing an `.or()`.
  */
  it("guards both sweeps identically", () => {
    const body = reclaimBody();
    const sweeps = body.split(".update({ worker_started_at: null })").slice(1);
    expect(sweeps, "expected exactly two reclaim statements").toHaveLength(2);
    for (const sweep of sweeps) {
      expect(sweep).toContain('.in("status", claimable)');
      expect(sweep).toContain('.not("worker_started_at", "is", null)');
      expect(sweep).toContain('.lt("worker_started_at", cutoff)');
    }
  });

  it("hands the same deadline to the replay, with the slowest migration reserved", () => {
    expect(lane).toContain(
      "{ isPastDeadline: (reserveMs) => Date.now() + reserveMs >= deadlineAt }",
    );
  });

  it("says a bounded pass was bounded, in the result and on the clone", () => {
    expect(lane).toMatch(/stoppedAtBudget: boolean;/);
    expect(lane).toMatch(/if \(pausedMidReplay\) out\.stoppedAtBudget = true;/);
    // The one reading this lane must never write about a clone it did not
    // finish examining is a bare "Synced to X".
    const paused = lane.indexOf("pausedMidReplay");
    const bareSynced = lane.lastIndexOf("`Synced to ${syncedTo}`");
    expect(bareSynced).toBeGreaterThan(paused);
  });
});

describe("what a pass stopped inside is resumable", () => {
  it("passes a cursor to the oversize option, read through the shared narrowing", () => {
    expect(lane).toContain("cursor: chunkCursorFor(backend.chunk_cursor)");
    // Never a cast: `jsonb` is `unknown`, and `as { … }` accepts a half-written
    // row and then uses it as a count of statements to SKIP.
    expect(lane).not.toMatch(/chunk_cursor as \{/);
  });

  it("reads the stored cursor off the row it claimed", () => {
    expect(lane).toMatch(/migration_blocked_reason, chunk_cursor"/);
  });

  it("writes the cursor on EVERY statement, not at the end of a pass", () => {
    const cb = lane.indexOf("onStatementDone:");
    expect(cb).toBeGreaterThan(-1);
    const body = lane.slice(cb, cb + 700);
    expect(body).toContain('.from("clone_backends")');
    expect(body).toContain("chunk_cursor: { migrationId: p.migrationId, statementsDone:");
    // A cursor that cannot be written puts the livelock back, so it is not
    // allowed to fail quietly.
    expect(body).toMatch(/console\.error\(/);
  });

  it("clears the cursor only when its own file landed, never merely on a null return", () => {
    /*
      Three states and the middle one is why this cannot be a plain write of
      whatever the replay returned: stopped inside the seed (store it), finished
      the seed (clear it), never reached the seed (leave it). The third also
      returns null, and clearing there throws away a live resume point.
    */
    expect(lane).toMatch(/const cursorFileLanded =\s*storedCursor !== null &&/);
    expect(lane).toContain("successes.some((r) => r.id === storedCursor.migrationId)");
    expect(lane).toMatch(/chunkCursor !== null\s*\?\s*\{ chunk_cursor: chunkCursor \}/);
    expect(lane).toMatch(/cursorFileLanded\s*\?\s*\{ chunk_cursor: null \}\s*:\s*\{\}/);
  });

  it("does not count a clone part-way through a seed as already level", () => {
    /*
      `upToDate` reads as "nothing to do on this clone". A pass that sent forty
      statements of a 40 MB seed and completed no migration satisfied it, which
      is the same defect `didNothing` had, in the counter rather than the
      sentence — and the counter is what an operator scans first.
    */
    const guard = lane.indexOf("out.upToDate++");
    expect(guard).toBeGreaterThan(-1);
    const condition = lane.slice(lane.lastIndexOf("if (", guard), guard);
    expect(condition).toContain("chunksApplied === 0");
    expect(condition).not.toContain("||");
  });

  it("counts statements sent as progress, so a part-sent seed is not 'nothing happened'", () => {
    const didNothing = lane.indexOf("const didNothing =");
    expect(didNothing).toBeGreaterThan(-1);
    const expr = lane.slice(didNothing, lane.indexOf(";", didNothing));
    expect(expr).toContain("chunksApplied === 0");
    // Every term is ANDed: one `||` here would make the whole reading true on a
    // pass that failed a migration.
    expect(expr).not.toContain("||");
  });
});

describe("the justification that was wrong is kept, not deleted", () => {
  it("the file still quotes 'Slower, never wrong' and says why it was not", () => {
    const src = read("src/server/fleet-migration.server.ts");
    expect(src).toContain("Slower, never wrong");
    expect(src).toMatch(/livelock/i);
  });
});
