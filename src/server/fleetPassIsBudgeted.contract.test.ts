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
const CLAIM_WRITE = "worker_started_at: claimedAt";
/** The identifier the lane names a lost claim by, read rather than repeated. */
const CLAIM_LOST_NAME = "CLAIM_LOST";

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
    ).toContain("migration_heartbeat_at: claimedAt");
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

  /*
    A CLAIM IS A NAME, NOT A FLAG.

    `STALE_CLAIM_MINUTES` went from thirty to five, which makes reclaiming a
    LIVE pass reachable in a way it was not before: `runSqlOnProject` carries
    no timeout, so a pass parked in one call can be reclaimed, come back, and
    go on writing. Every write it then makes matches on `clone_id` alone, so
    it writes into the successor's claim — and its result write sets
    `worker_started_at` to null, releasing a claim it does not hold and
    putting two passes inside one clone's schema at once. That is the
    concurrent application the compare-and-swap exists to stop, arriving a few
    minutes late through the back door. Raised by review.

    So the claimed timestamp is carried and required. What is pinned here is
    that it is ONE value (two `new Date()` calls cannot be compared to each
    other) and that every write after the claim carries it.
  */
  const fencedWrites = (): string[] => {
    const from = laneBody.indexOf(CLAIM_WRITE);
    expect(from, "the claim write was not found").toBeGreaterThan(-1);
    // Every `.eq("clone_id", cloneId)` after the claim is a write about a
    // clone this pass believes it holds. Collected by scanning rather than by
    // listing them, so a write added later is judged too.
    const after = laneBody.slice(from);
    return after
      .split('.eq("clone_id", cloneId)')
      .slice(1)
      .map((tail) => tail.slice(0, 200));
  };

  it("takes ONE timestamp for the claim and holds it", () => {
    expect(lane, "the fence is not a single captured value").toMatch(
      /const claimedAt = new Date\(\)\.toISOString\(\);/,
    );
    const at = lane.indexOf("const claimedAt =");
    const guard = lane.indexOf(CLAIM_GUARD);
    expect(guard).toBeGreaterThan(-1);
    expect(at, "the fence must be taken at the claim, after the budget guard").toBeGreaterThan(
      guard,
    );
  });

  it("fences every write that follows the claim on the claim it took", () => {
    const writes = fencedWrites();
    // The claim itself, the progress write, the result write, the release.
    expect(writes.length, "expected the claim and at least three writes after it").toBeGreaterThan(
      3,
    );
    // The first is the claim, which is fenced by `is null` instead: it is what
    // ESTABLISHES the name the others are fenced on.
    expect(writes[0]).toContain('.is("worker_started_at", null)');
    for (const w of writes.slice(1)) {
      expect(w, "a write after the claim does not require the claim it took").toContain(
        '.eq("worker_started_at", claimedAt)',
      );
    }
  });

  it("can SEE a fence miss, rather than writing and hoping", () => {
    // A fenced update that does not ask for rows back returns no error and no
    // rows on a miss, which is indistinguishable from a write that landed.
    for (const w of fencedWrites().slice(1)) {
      expect(w, "a fenced write that returns nothing cannot tell a miss from a hit").toContain(
        '.select("clone_id")',
      );
    }
  });

  it("STOPS the replay on a fence miss rather than sending the next statement", () => {
    const cb = lane.indexOf("onStatementDone:");
    expect(cb).toBeGreaterThan(-1);
    const body = lane.slice(cb, cb + 1900);
    // `ClaimLostError` and not a plain `Error`: the replay catches every
    // exception per migration and records it as one the clone refused, and
    // that class is the one thing it rethrows.
    expect(body, "a lost claim mid-seed must not continue sending").toMatch(
      /if \(!beat \|\| beat\.length === 0\) \{[\s\S]{0,500}?throw new ClaimLostError\(/,
    );
    // Distinct from a failed write, which is deliberately NOT fatal: the
    // statements landed and re-sending them is free.
    expect(body).toMatch(/console\.error\(/);
  });

  it("records no verdict about a clone whose row it no longer owns", () => {
    const at = lane.indexOf("if (!recorded || recorded.length === 0)");
    expect(at, "the result write does not check its fence").toBeGreaterThan(-1);
    const body = lane.slice(at, at + 500);
    expect(body).toContain(CLAIM_LOST_NAME);
    // Skipped, not fallen through: the `failed` status did not land either, so
    // the notification below it would be an alert about a row nobody wrote.
    expect(body).toContain("continue;");
  });

  it("names a lost claim in ONE place, because two sites report it", () => {
    expect(lane).toMatch(/const CLAIM_LOST = "[^"]+";/);
    // Both the throw and the result-write report read the same constant.
    const uses = lane.split("${CLAIM_LOST}").length - 1;
    expect(uses, "a lost claim is worded twice").toBe(2);
  });

  /*
    AND LIVENESS IS MEASURED, NOT INFERRED FROM WORK.

    The first heartbeat was written in `onStatementDone`, which belongs to the
    OVERSIZED-SEED path alone. Every other replay — an ordinary DDL, and above
    all one blocked inside the timeout-less `runSqlOnProject` — was silent from
    the claim onwards, so a five-minute window reclaims a pass that is working
    and a successor starts sending the same migrations into the same schema.
    The fence stops the reclaimed pass WRITING; it cannot recall SQL already
    dispatched. Raised by review, and a defect this change creates: at thirty
    minutes the same hole existed and was very hard to reach.
  */
  const beatBody = (): string => {
    const at = lane.indexOf("function beatWhileClaimHeld");
    expect(at, "beatWhileClaimHeld not found").toBeGreaterThan(-1);
    const end = lane.indexOf("\n}\n", at);
    expect(end, "no closing brace for beatWhileClaimHeld").toBeGreaterThan(at);
    return lane.slice(at, end);
  };

  it("beats on a CLOCK, so a silent stretch is not read as death", () => {
    const body = beatBody();
    expect(body, "the heartbeat is not on a timer").toContain("setTimeout(");
    expect(body).toContain("migration_heartbeat_at");
  });

  /*
    AND ONE BEAT AT A TIME.

    It was a `setInterval`, which does not wait for its own callback. A beat
    slower than the interval overlaps the next, and each captures `new Date()`
    before its request goes out — so two independently routed writes can commit
    in the other order and an older timestamp lands over a newer one. On a claim
    held past the window that makes a perfectly healthy pass look stale and
    hands its clone to a second pass: the concurrent application this mechanism
    exists to prevent, caused by the thing meant to prevent it. Raised by
    review.
  */
  it("never has two beats in flight, so an older timestamp cannot land last", () => {
    const body = beatBody();
    expect(body, "an interval does not wait for its own callback").not.toContain("setInterval(");
    // The next beat is scheduled from inside the completed one. Asserted on
    // the call rather than on the word `then`, because the ordering is the
    // property and a reschedule anywhere else reopens the overlap.
    const done = body.indexOf(".then(()");
    expect(done, "nothing reschedules after a beat completes").toBeGreaterThan(-1);
    // Bounded to the `.then` BLOCK, not to a character count after it: a
    // reschedule moved out beside the request still sits inside a generous
    // window, and that is exactly the mutation this has to catch.
    const closes = body.indexOf("});", done);
    expect(closes, "the .then block does not close").toBeGreaterThan(done);
    expect(
      body.slice(done, closes),
      "the next beat is not scheduled from inside the completed one",
    ).toContain("schedule()");
  });

  /*
    AND A STOP THAT DOES NOT WAIT IS NOT A STOP.

    `clearTimeout` cancels the next beat and does nothing about one already
    dispatched. A beat landing after the pass has moved on refreshes a claim
    nobody holds — and on the path where the release itself failed, that is
    exactly the claim the five-minute silence is supposed to be counting.
    Also raised by review.
  */
  it("waits for the beat that is already out before the pass moves on", () => {
    const body = beatBody();
    // The tracked promise must BE the beat. Asserting only that the name
    // appears is satisfied by a declaration and an await with nothing assigned
    // between them — caught by mutation.
    expect(body, "nothing tracks the beat currently in flight").toMatch(/inFlight = beat\(\)/);
    expect(body, "stop does not wait for it").toMatch(
      /stop: async \(\) => \{[\s\S]{0,300}?await inFlight;/,
    );
    expect(laneBody, "the pass does not wait for the stop").toContain("await heartbeat.stop();");
  });

  it("fits several beats inside the reclaim window, so one lost beat is survivable", () => {
    const beat = /const CLAIM_HEARTBEAT_MS = ([\d_]+);/.exec(lane);
    expect(beat, "CLAIM_HEARTBEAT_MS is not declared as a plain number").not.toBeNull();
    const stale = /const STALE_CLAIM_MINUTES = (\d+);/.exec(lane);
    expect(stale).not.toBeNull();
    const beats = (Number(stale![1]) * 60_000) / Number(beat![1].replace(/_/g, ""));
    expect(
      beats,
      "a window this pass can miss in two beats turns a transient fault into a stolen claim",
    ).toBeGreaterThanOrEqual(4);
  });

  it("stops beating when the claim is gone, rather than writing into a successor's row", () => {
    const body = beatBody();
    expect(body, "the beat is unfenced").toContain('.eq("worker_started_at", claimedAt)');
    expect(body).toContain('.select("clone_id")');
    /*
      Bounded to the MISS BRANCH, not to the function. The stop it sets appears
      a second time in the returned `stop`, so an unbounded search finds that
      one and passes over a branch that no longer stops anything — caught by
      mutation, which is the only reason it is written this way.
    */
    const miss = body.indexOf("if (!rows || rows.length === 0)");
    const stop = body.indexOf("stop: async ()");
    expect(miss, "the fence-miss branch was not found").toBeGreaterThan(-1);
    expect(stop, "the returned stop was not found").toBeGreaterThan(miss);
    expect(body.slice(miss, stop), "a beat that missed its fence keeps beating").toContain(
      "stopped = true",
    );
  });

  it("covers the WHOLE replay and stops in a finally", () => {
    const start = laneBody.indexOf("beatWhileClaimHeld(supabase");
    const replay = laneBody.indexOf("await applyPrimeMigrations(");
    expect(start, "the heartbeat is never started").toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(-1);
    expect(start, "the replay begins before anything says the pass is alive").toBeLessThan(replay);
    /*
      And OUTSIDE the try, not merely before the replay. Declared inside it the
      `finally` cannot see it — which the compiler catches, but the property
      this test is for is that the handle outlives the block it guards, and an
      assertion that only says "before the replay" is satisfied by the version
      that does not. Caught by mutation.
    */
    const tryAt = laneBody.lastIndexOf("try {", replay);
    expect(tryAt, "the replay is not inside a try").toBeGreaterThan(-1);
    expect(start, "the heartbeat handle is scoped inside the block it guards").toBeLessThan(tryAt);
    // Three exits — the result write's `continue`, a throw, and falling off
    // the end — so the stop cannot sit on any one of them.
    expect(laneBody, "a timer that outlives its pass holds a dead claim open").toMatch(
      /\} finally \{[\s\S]{0,500}?await heartbeat\.stop\(\);/,
    );
  });

  /*
    AND A LOST CLAIM HAS TO ESCAPE THE REPLAY.

    `applyPrimeMigrations` catches every exception per migration and records it
    as a migration that FAILED. A plain `Error` thrown by the fence was
    therefore converted into the clone's verdict: the specific reason replaced
    by the caller's generic one, and the fenced release never reached. Raised
    by review.
  */
  it("is rethrown by the replay rather than recorded as a migration the clone refused", () => {
    const replay = code(read("src/server/backend-provisioning.server.ts"));
    const at = replay.indexOf("export async function applyPrimeMigrations");
    expect(at, "applyPrimeMigrations not found").toBeGreaterThan(-1);
    const catchAt = replay.indexOf('error: e instanceof Error ? e.message : "SQL failed"', at);
    expect(catchAt, "the per-migration catch was not found").toBeGreaterThan(at);
    // Before the push, or the push has already happened.
    const before = replay.slice(replay.lastIndexOf("} catch (e) {", catchAt), catchAt);
    expect(before, "a lost claim is recorded as a failed migration").toContain(
      "if (e instanceof ClaimLostError) throw e;",
    );
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
