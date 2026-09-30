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
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
/** Source with comments removed — a comment quoting code is not code. */
const code = (src: string): string =>
  stripComments(src);
/**
 * The same rule for SQL, and it is not decoration.
 *
 * A migration in this repository explains itself at length above the statement
 * it makes, and those explanations QUOTE the statement. An assertion read off
 * the raw file is therefore satisfied by the prose describing the code even
 * when the code is gone — which is exactly what happened: removing `greatest`
 * from the `update` left the header's copy of it, and the test passed over a
 * migration that no longer took a maximum at all. Caught by mutation.
 */
const sqlCode = (src: string): string => src.replace(/^[ \t]*--.*$/gm, "");

/**
 * The scheduled hook's behaviour, wherever it is written.
 *
 * The route file used to hold the handler; it now delegates to one shared with
 * `/hooks/fleet-migration-drain`, because `check-cron-coverage` refuses two
 * jobs pointing at one endpoint and a mode carried in a cron body is invisible
 * in `cron.job`. The shared handler sits in the lane's own module, for the
 * reason its header gives. The properties asserted through this are about the LANE — that
 * a failed sweep is reported rather than serialised as a success, that it runs
 * on the service role — and neither is about which file the line sits in.
 * Reading both keeps them true under either arrangement.
 */
const cronHook = [
  "src/routes/hooks.fleet-migration-sync.tsx",
  "src/server/fleet-migration.server.ts",
]
  .map((f) => code(read(f)))
  .join("\n");

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

  it("declares a budget of its own, derived from the patience its cron jobs give it", () => {
    // Not another lane's name and not a free literal. It was a literal — 45 s,
    // chosen when pg_net gave up at sixty — and it stayed there for days after
    // the jobs were given 150 s, so every pass spent its setup and a full seed
    // read to send one statement. A budget stated as the patience less the
    // headroom cannot fall behind the patience again unnoticed.
    expect(lane).toMatch(
      /const FLEET_PASS_BUDGET_MS = FLEET_HOOK_PATIENCE_MS - FLEET_PASS_HEADROOM_MS;/,
    );
  });

  it("names the same patience the migration gives both fleet jobs", () => {
    const literal = (name: string): number => {
      const m = new RegExp(`const ${name} = ([\\d_]+);`).exec(lane);
      expect(m, `${name} is not a plain literal in the lane`).not.toBeNull();
      return Number(m![1].replace(/_/g, ""));
    };
    const patience = literal("FLEET_HOOK_PATIENCE_MS");
    const headroom = literal("FLEET_PASS_HEADROOM_MS");

    const sql = sqlCode(read("supabase/migrations/20260922150000_fleet_sync_http_patience.sql"));
    const m = /'timeout_milliseconds := 60000',\s*'timeout_milliseconds := (\d+)'/.exec(sql);
    expect(m, "could not read the fleet jobs' patience from their migration").not.toBeNull();
    expect(patience).toBe(Number(m![1]));
    // Both jobs, by name — a patience given to one cadence is not the other's.
    expect(sql).toContain("'fleet-migration-sync-30min'");
    expect(sql).toContain("'fleet-migration-drain-5min'");

    // Room for the unit a pass may start just inside its budget, and for the
    // writes after it. Less than a third of the patience would leave a slow
    // statement to outlive the request.
    expect(headroom).toBeGreaterThanOrEqual(patience / 3);
    // And a budget that still does work: more than a claim's reserve and the
    // setup a pass pays before its first statement.
    expect(patience - headroom).toBeGreaterThan(45_000);
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

  it("does not beat from the cursor write, which the timer now covers", () => {
    /*
      The inverse of what this asserted when the cursor write was the only
      heartbeat there was. It is kept rather than deleted because the site is
      the one that regressed, and a test that says "not here" is what stops it
      being put back for the reason it was there the first time.
    */
    const at = lane.indexOf("onStatementDone");
    expect(at, "onStatementDone not found").toBeGreaterThan(-1);
    const body = lane.slice(at, at + 900);
    expect(body, "the cursor write is a second, unserialised heartbeat writer").not.toContain(
      "migration_heartbeat_at:",
    );
    // It still carries the cursor and still requires the claim.
    expect(body).toContain("chunk_cursor:");
    expect(body).toContain('.eq("worker_started_at", claimedAt)');
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

  it("reports a sweep that failed rather than throwing past everyone", () => {
    /*
      Nothing catches a throw here. `runFleetMigrationSync` has no try around
      the call, its caller checks `result.error` and would never see one, and
      the scheduled hook turns it into a 500 — so a failed sweep left no usage
      row, no error on any clone and nothing an operator reading Mission
      Control could see. Observable only in `net._http_response.status_code`,
      which is the "a green cron run is not a delivered request" trap from the
      other side.

      It matters more since the sweep began naming `migration_heartbeat_at`:
      between a merge and the moment `20260919133000` is applied the column
      does not exist and both statements answer 42703.

      Returning it must STOP the pass exactly as the throw did — proceeding
      with the sweep failed means leaked claims stay held and the candidate
      list is wrong — so the early return is asserted too, not just the type.
    */
    const body = reclaimBody();
    expect(body).not.toContain("throw new Error(");
    expect(body.match(/return `Could not reclaim/g) ?? []).toHaveLength(2);
    expect(lane).toContain("const reclaimError = await reclaimStale(supabase);");
    expect(lane).toMatch(
      /if \(reclaimError\) \{[\s\S]*?return \{ \.\.\.EMPTY, error: reclaimError \};/,
    );
    /*
      AND IT IS LOGGED, because the return alone is QUIETER than the throw was.

      The commit that made this change claimed the return reached "the caller's
      own `result.error` and the audit row with it". Only the first half is
      true, and only for the admin button: this return sits ABOVE
      `writeAuditLog`, so a pass that stops here writes no audit row, and the
      scheduled hook serialised the result as HTTP 200 `{"success":true,…}` —
      so the change made the failure LESS visible than the throw it replaced,
      which at least reached the hook's catch and a non-200 that
      `net._http_response.status_code` records. Found by review.
    */
    const at = lane.indexOf("if (reclaimError)");
    expect(lane.slice(at, lane.indexOf("return { ...EMPTY", at))).toMatch(/console\.error\(/);
    expect(cronHook).toContain("success: !result.error");
    expect(cronHook).toMatch(/status: result\.error \? 500 : 200/);
  });

  /*
    A CURSOR THE FILE NO LONGER MATCHES IS CLEARED, NOT LEFT ALONE.

    `chunkCursor: null` carries two meanings the caller is right to treat the
    same way — "nothing to store" and "this pass never reached the seed" — and
    for both, leaving the row's cursor standing is correct. The shape-mismatch
    path needs a third, and reads exactly like the second in every field it
    has: null cursor, migration not among the successes. So it fell into the
    "leave it alone" branch, the stale shape stayed on the row, and the next
    pass read it, hit the same mismatch, and held again. For ever, because
    nothing in that loop re-reads the file.

    Pinned across all three files rather than in one, because the defect was
    that the producer's intent and the consumer's reading disagreed and each
    was locally reasonable. Raised by review.
  */
  it("clears a cursor the prime's own file no longer matches", () => {
    const seedApply = code(read("src/server/backend-provisioning.server.ts"));
    // The producer says so explicitly, on the branch that means it.
    const refusal = seedApply.indexOf("changed on the prime since the last pass");
    expect(refusal, "the shape-mismatch refusal was not found").toBeGreaterThan(-1);
    const branch = seedApply.slice(Math.max(0, refusal - 500), refusal);
    expect(branch, "the discard is inferred from a null cursor rather than said").toContain(
      "cursorDiscarded: true",
    );
    /*
      And it survives the frame between — SET as well as declared.

      This read `toContain("chunkCursorDiscarded")`, which the `let … = false`
      and the return satisfy between them with nothing ever assigning it. A
      mutation that deleted the only assigning line passed this test, which is
      the fifth time on this branch that an assertion has been satisfied by a
      declaration rather than by behaviour. Both halves are now required: the
      producer's field is read, and the flag is set from it.
    */
    expect(seedApply, "the discard is declared and returned but never set").toMatch(
      /chunked\.cursorDiscarded[\s\S]{0,80}?chunkCursorDiscarded = true/,
    );
    expect(seedApply, "the discard does not leave applyPrimeMigrations").toMatch(
      /return \{[^}]*chunkCursorDiscarded[^}]*\}/,
    );
    // And the consumer acts on it, in the branch that writes null.
    const lane = code(read("src/server/fleet-migration.server.ts"));
    expect(lane, "the lane never reads the discard").toContain("chunkCursorDiscarded");
    expect(lane, "a discarded cursor is not cleared on the row").toMatch(
      /chunkCursorDiscarded \|\| cursorFileLanded[\s\S]{0,120}?chunk_cursor: null/,
    );
  });

  /*
    AND BOTH SWEEPS CARRY THE SAME GUARD.

    Splitting "old AND (quiet OR never beat)" into two statements repeats the
    guard that makes either one safe — the claimable status set and the pair
    that says a claim is actually held. Written twice, one of them can lose a
    line: a reclaim missing `.not("worker_started_at", "is", null)` would
    clear claims nobody holds, and one missing the status filter would reach
    rows this lane never touches.

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
    AND NO SWEEP FREES A CLAIM ON AGE ALONE.

    Review is right that a late beat can extend a claim past one window, and
    the obvious answer — an absolute age past which a claim is freed whatever
    its stamp says — was written here and then removed. It is the same shape
    as the `_not_after` deadline removed one round earlier: a rule that can
    free a claim a LIVE pass is holding, which is how two passes end up in one
    schema. Only the trigger differs.

    The trade decides it. The residual costs a delay — a claim held by nobody,
    a clone skipped until the beats drain — while a ceiling trades that for a
    chance of concurrent application, which is the wrong way round.

    Asserted as an absence, on both the constant and the shape of a sweep that
    reads no stamp, so re-adding it is a deliberate act against a stated
    argument rather than a plausible-looking commit. What would change the
    answer is a MEASURED invocation ceiling for this runtime; that is a fact
    about the platform rather than a guess about latency, and it is not in
    hand.
  */
  it("frees no claim on age alone, however old", () => {
    const lane = code(read("src/server/fleet-migration.server.ts"));
    expect(lane, "a claim-age ceiling is back").not.toMatch(/const CLAIM_CEILING/);
    const sweeps = reclaimBody().split(".update({ worker_started_at: null })").slice(1);
    for (const sweep of sweeps) {
      /*
        Every sweep reads the heartbeat — one for a stale stamp, one for the
        absence of any. A sweep that reads neither is one that frees a claim
        purely because it is old, whatever it is called.
      */
      const readsTheStamp =
        sweep.includes('.lt("migration_heartbeat_at"') ||
        sweep.includes('.is("migration_heartbeat_at"');
      expect(readsTheStamp, "a sweep frees a claim without reading its heartbeat").toBe(true);
    }
  });

  /*
    AND NO RELEASE IS ATTEMPTED WITH THE BEATS STILL RUNNING.

    `stop` used to be called only in the `finally`, which runs AFTER the
    release — so every beat dispatched during the replay was live while the
    claim was being released, and one committing after a FAILED release
    re-stamps a claim nobody holds. Stopping first means the abort has dropped
    everything unsent and the drain has given what was sent its two seconds.

    The first version of this fix put the stop on the success path and missed
    the catch, whose own release then ran with the timer live — the path where
    a failed release is MOST likely, because something has already gone wrong.
    Review caught that in the same round the reordering shipped: the sixth
    defect on this branch introduced by the previous fix.

    Which is why this is an ORDERING assertion and not a count. "Exactly two
    stops" was true of the commit that added the first and false of the one
    that fixed the path it had missed; a count is a fact about today's control
    flow, and the property is about order. A new exit added later is judged by
    the same rule without this test being touched.
  */
  it("attempts no release with the beats still running", () => {
    const lane = code(read("src/server/fleet-migration.server.ts"));
    /*
      Bounded to the clone loop: `reclaimStale` releases claims too, and it
      releases claims it does not hold by definition, so it is out of scope.
    */
    const loop = lane.slice(lane.indexOf("beatWhileClaimHeld(supabase"));
    expect(loop.length, "the clone loop was not found").toBeGreaterThan(0);

    type Marker = { at: number; kind: "stop" | "release" };
    const markers: Marker[] = [
      ...[...loop.matchAll(/await heartbeat\.stop\(\)/g)].map(
        (m): Marker => ({ at: m.index ?? -1, kind: "stop" }),
      ),
      ...[...loop.matchAll(/worker_started_at: null/g)].map(
        (m): Marker => ({ at: m.index ?? -1, kind: "release" }),
      ),
    ].sort((a, b) => a.at - b.at);

    const releases = markers.filter((m) => m.kind === "release");
    expect(releases.length, "no release write was found in the clone loop").toBeGreaterThan(1);

    let stopped = false;
    for (const m of markers) {
      if (m.kind === "stop") {
        stopped = true;
        continue;
      }
      expect(stopped, `a release at offset ${m.at} runs with the heartbeat still beating`).toBe(
        true,
      );
      // Each release consumes the stop before it: a second release on another
      // path needs its own, which is exactly what was missing.
      stopped = false;
    }

    // And the `finally` still stops them, because a throw past the last
    // release has no other exit.
    const finallyAt = loop.lastIndexOf("} finally {");
    expect(finallyAt, "the finally was not found").toBeGreaterThan(-1);
    expect(loop.slice(finallyAt), "the finally no longer stops the heartbeat").toContain(
      "await heartbeat.stop()",
    );
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
    const parts = after.split('.eq("clone_id", cloneId)');
    const writes: string[] = [];
    for (let i = 1; i < parts.length; i += 1) {
      /*
        ONLY A WRITE IS FENCED.

        A READ after the claim asserts nothing and changes nothing, so it
        needs no fence — and the blockage reconciliation takes one
        deliberately, to reconcile against the row as it is at the moment it
        writes rather than as it was before the claim was taken. Judged on
        what the statement this filter belongs to DOES rather than on a list
        of statements, so a write added later is still caught: the nearest
        `.from("clone_backends")` above it, and whether an `.update(` follows.
      */
      // `CLAIM_WRITE` anchors INSIDE the claim's own `.update({ … })`, so the
      // first filter after it belongs to that update by construction and
      // there is no `.update(` left above it to find. Every later segment is
      // judged on its own statement.
      const isClaim = i === 1;
      const head = parts.slice(0, i).join('.eq("clone_id", cloneId)');
      const opens = head.lastIndexOf('.from("clone_backends")');
      const statement = opens === -1 ? head : head.slice(opens);
      if (!isClaim && !statement.includes(".update(")) continue;
      writes.push(parts[i].slice(0, 200));
    }
    return writes;
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
    expect(body, "the heartbeat is not on a timer").toContain("setInterval(");
    // The beat no longer names the column: advancing it is the database's job,
    // so that the maximum is taken where the write commits.
    expect(body).toContain("fleet_claim_heartbeat");
  });

  /*
    AND ORDERING IS THE DATABASE'S, NOT THE CALLER'S.

    Three shapes were tried here and the first two each bought the next
    defect. Overlapping beats on an interval REORDERED, because each chose its
    timestamp before its request went out. Serialising them fixed that and made
    a HUNG beat end the heartbeat for ever, on an egress shared with the
    migration's own SQL — so the beat fails exactly when it is needed. Bounding
    each beat with an abort fixed that and turned a merely SLOW database into
    total silence, every beat past the ceiling discarded and the stamp never
    moving. Three rounds of review, one per shape.

    They were one fault: the caller defending an ordering it does not control,
    because it does not decide when a write commits. `fleet_claim_heartbeat`
    takes the MAXIMUM at the database, so commit order stops mattering — and
    then beats may be independent, a hang is harmless, and no abort is needed.
  */
  it("lets the database decide the value, so commit order cannot matter", () => {
    const sql = sqlCode(
      read("supabase/migrations/20260919153000_fleet_claim_heartbeat_monotonic.sql"),
    );
    expect(sql, "the stamp is not monotonic").toMatch(
      /set migration_heartbeat_at = greatest\(migration_heartbeat_at, clock_timestamp\(\)\)/,
    );
    // `now()` is the TRANSACTION's start, so two overlapping beats would still
    // offer values in the order they started rather than the order they ran.
    expect(sql, "now() is the transaction's start time, not the moment of the write").not.toMatch(
      /set migration_heartbeat_at = greatest\(migration_heartbeat_at, now\(\)\)/,
    );
    // And the fence is the function's own, so a reclaimed pass cannot beat
    // into its successor's claim however the call is made.
    expect(sql).toContain("and worker_started_at = _claimed_at");
    /*
      And it needs no privilege its caller lacks. The lane runs on
      `supabaseAdmin`, which is `service_role`, and that role already updates
      `clone_backends` through PostgREST — so a `security definer` here would
      be a standing escalation surface on a sensitive table for no benefit at
      all. The grants leave `service_role` the only grantee either way.
    */
    expect(sql, "the function runs with the definer's privileges for no reason").not.toContain(
      "security definer",
    );
    expect(sql).toContain("security invoker");
    /*
      AND REVOKING FROM `public` IS NOT REVOKING FROM `anon`.

      `pg_default_acl` on this database grants EXECUTE on every new `public`
      function to `anon` AND `authenticated` — measured, and written down in
      `20260828030000_schema_migration_queue.sql`, which records that 77 of 145
      public functions are anon-executable today and that of 45
      `REVOKE ALL ON FUNCTION` statements only 13 name `authenticated`. Those
      are role-specific grants and survive a revoke from the PUBLIC
      pseudo-role. Raised by review.
    */
    for (const role of ["public", "anon", "authenticated"]) {
      expect(sql, `execute is not revoked from ${role}`).toMatch(
        new RegExp(`revoke all on function public\\.fleet_claim_heartbeat[^;]*from ${role};`),
      );
    }
    expect(sql).toMatch(
      /grant execute on function public\.fleet_claim_heartbeat[^;]*to service_role/,
    );
  });

  /*
    AND THE LANE RUNS ON ONE PRIVILEGE SET, NOT TWO.

    `requireAdmin` is built on `requireSupabaseAuth`, whose client is the
    PUBLISHABLE key carrying the user's JWT — so the operator button ran the
    whole lane as `authenticated`, reaching `clone_backends` only through the
    "Admins can write" policy, while the scheduled hook ran the same code as
    `service_role`. Revoking EXECUTE from `authenticated` is only safe once
    that is true of both callers, which is why this is asserted rather than
    assumed.
  */
  it("is started on the service role by both of its callers", () => {
    expect(cronHook).toContain("runFleetMigrationSync(supabaseAdmin");
    const button = code(read("src/server/migration-sync.functions.ts"));
    expect(button, "the operator button runs the lane on the caller's own client").not.toContain(
      "runFleetMigrationSync(context.supabase",
    );
    expect(button).toContain("runFleetMigrationSync(supabaseAdmin");
  });

  /*
    AND A BEAT THAT IS OUT WHEN THE PASS ENDS IS CANCELLED — NOT DEADLINED.

    `clearInterval` stops the next beat and does nothing about one already
    dispatched, so the pass aborts them: every beat not yet sent is dropped,
    and one already sent has its connection closed, which Postgres answers by
    cancelling the statement where it can still see the socket.

    That half cannot backfire — an aborted beat means the next one goes — and
    it is the half that survived. A DEADLINE carried to the database beside it
    did not, and the test below is what stops it coming back.
  */
  it("cancels the beats that are out when the pass ends", () => {
    const body = beatBody();
    expect(body, "nothing cancels a beat when the pass ends").toContain("new AbortController()");
    expect(body).toContain("abortSignal(inflightBeats.signal)");
    /*
      Anchored on the MEMO rather than on `stop`'s syntax, which has now
      changed twice. `stopping ??=` is the first line of the returned stop's
      body and is behavioural — it is what makes three calls cost one drain —
      so an anchor on it cannot be broken by a reformat the way
      `stop: async () => {` was.
    */
    expect(body, "stop does not cancel them").toMatch(
      /stopping \?\?=[\s\S]{0,400}?inflightBeats\.abort\(\);/,
    );
  });

  /*
    AND NO DEADLINE ON THE BEAT. THIS IS A BAN, NOT AN OVERSIGHT.

    A `_not_after` argument was added so a beat queued behind a pass that had
    already ended could not refresh its claim. It is the fixed-latency silence
    fault of two rounds earlier rebuilt out of different parts: whenever the
    database is slower than the deadline EVERY beat expires, the stamp never
    moves, and a live pass reads as dead — after which the reclaim hands its
    clone to a second pass, which is the concurrent application the claim
    exists to prevent, caused by the guard meant to protect it.

    No number fixes it. Tight enough to bound a queued beat is tight enough to
    expire a slow live one; loose enough to be safe for a live pass only
    refuses beats that were about to be reclaimed anyway. The deadline measures
    TIME SINCE SENDING; the question is WHETHER THE PASS HAS STOPPED.

    So this asserts the absence, on both sides, rather than a tuning. The
    residual it declines to close — a late beat extending a claim by one
    reclaim window, only where the release write itself failed — is accepted
    and written down on the function.
  */
  it("gives a beat no deadline, on either side of the wire", () => {
    const body = beatBody();
    expect(body, "a beat carries a deadline again").not.toContain("_not_after");
    expect(body, "a beat is bounded by a timeout again").not.toContain("AbortSignal.timeout");
    const sql = sqlCode(
      read("supabase/migrations/20260919153000_fleet_claim_heartbeat_monotonic.sql"),
    );
    expect(sql, "the function takes a deadline again").not.toContain("_not_after");
    /*
      `clock_timestamp()` must survive — it is the value the stamp advances TO.
      What must not is a comparison that can refuse the write, so this matches
      the shape of a guard rather than the identifier, and would catch it under
      any parameter name.
    */
    expect(sql, "a beat can be refused on time again").not.toMatch(/clock_timestamp\(\)\s*[<>]/);
  });

  it("does not make one beat wait for another, and abandons none", () => {
    const body = beatBody();
    expect(body, "beats are serialised again, so a hang ends the chain").not.toContain(
      ".then(() =>",
    );
  });

  it("asks the database rather than composing the write itself", () => {
    const body = beatBody();
    // Anchored on the CALL, not on the receiver: prettier wraps the chain onto
    // its own line once the argument list grows, and `supabase.rpc(` then
    // stops matching — an assertion that tests nothing, which this suite has
    // been caught by before.
    expect(body, "the beat writes the column directly and can reorder").toContain(
      '.rpc("fleet_claim_heartbeat"',
    );
    // The function's own answer, not a row count: once the write is also
    // conditional on advancing, "no rows" can no longer mean "claim lost".
    //
    // `=== false` and not falsy: a transport failure returns `null` and has
    // already been handled above, so reading a bare falsy value as a lost
    // claim would end the heartbeat on a fault that says nothing about it.
    expect(body, "a lost claim is inferred rather than read").toContain("held === false");
  });

  /*
    AND A STOP THAT DOES NOT WAIT IS NOT A STOP — BUT MUST NOT WAIT FOR EVER.

    `clearInterval` cancels the next beat and does nothing about one already
    dispatched. A beat landing after the pass has moved on refreshes a claim
    nobody holds — and on the path where the release itself failed, that is
    exactly the claim the five-minute silence is supposed to be counting.
    Raised by review.

    The wait is bounded because it happens in a `finally`: a beat that never
    settles would otherwise hang the whole run, which is worse than the fault
    the wait prevents. And it is `allSettled`, which cannot reject, so `stop`
    cannot throw over the error the pass is already carrying.
  */
  it("drains the beats still in the air, on a bound, without throwing", () => {
    const body = beatBody();
    expect(body, "nothing tracks the beats in flight").toContain("outstanding.add(run)");
    expect(body, "the drain can reject and replace the pass's own error").toContain(
      "Promise.allSettled([...outstanding])",
    );
    expect(body, "a beat that never settles would hang the run").toContain("Promise.race([");
    expect(lane).toMatch(/const CLAIM_DRAIN_MS = [\d_]+;/);
    expect(laneBody, "the pass does not wait for the stop").toContain("await heartbeat.stop();");
  });

  it("fits several beats inside the reclaim window, so one lost beat is survivable", () => {
    const beat = /const CLAIM_HEARTBEAT_MS = ([\d_]+);/.exec(lane);
    expect(beat, "CLAIM_HEARTBEAT_MS is not declared as a plain number").not.toBeNull();
    const stale = /const STALE_CLAIM_MINUTES = (\d+);/.exec(lane);
    expect(stale).not.toBeNull();
    /*
      Two constants, and that is the WHOLE cadence — which it was not while the
      beats were serialised, because a slow beat then delayed the next one and
      this arithmetic described a system with no latency. Review said so, and
      the answer was not to model the latency but to remove it from the
      cadence: independent beats fire on the interval whatever the last one is
      doing, which is safe only because the database takes the maximum.
    */
    const beats = (Number(stale![1]) * 60_000) / Number(beat![1].replace(/_/g, ""));
    expect(
      beats,
      "a window this pass can miss in two beats turns a transient fault into a stolen claim",
    ).toBeGreaterThanOrEqual(4);
  });

  /*
    AND ONE MECHANISM WRITES THE COLUMN.

    The cursor write carried a heartbeat too, from before the timer existed.
    That is a second, unserialised writer of one column: a beat dispatched
    earlier can land after it and move the stamp BACKWARDS — the reordering
    serialising the timer had just closed, arriving through the other door.
    Also raised by review.

    Written as a count because the property is exclusivity, not the identity of
    any one site: the claim establishes the stamp, the beat advances it, and a
    third writer anywhere reopens the class.
  */
  it("has exactly one writer of the heartbeat in this file: the claim", () => {
    /*
      The claim establishes the stamp; every advance of it now happens inside
      `fleet_claim_heartbeat`, where the maximum is taken. A second writer HERE
      is a write that does not go through that maximum, which is the reordering
      this area has paid for three times — including the cursor write, which
      carried a heartbeat from before the timer existed.

      Written as a count because the property is exclusivity, not the identity
      of any one site.
    */
    /*
      A WRITE ASSIGNS A VALUE; A TYPE ANNOTATION DOES NOT.

      This counted every occurrence of the token, which was the same number
      until the ordering gained a row type that has to NAME the column to sort
      on it. Counting a declaration as a writer would have made adding the
      fairness key look like reintroducing the reordering — a true property
      reported by a test that had stopped measuring it.

      So the match requires a value, and the type keywords are excluded by
      name rather than by a general rule: a new writer whose value happens to
      begin with one of these three words is a shape this file does not have,
      and narrowing further would start excluding real writes.
    */
    const named = lane.split("\n").filter((l) => l.includes("migration_heartbeat_at:"));
    const writes = named.filter((l) => !/migration_heartbeat_at:\s*(string|number|Date)\b/.test(l));
    expect(writes.length, "a second heartbeat writer bypasses the database's maximum").toBe(1);
    /*
      And the shape that has to NAME the column is declared in exactly one
      place, which is no longer this file.

      This used to assert the lane held that declaration once. The queue order
      moved into `fleetMigrationEligibility.pure.ts` when #228 merged — the
      right home, beside the eligibility rules — so the lane has no row type at
      all now and the count went to zero, which read as "the ordering row's
      shape is declared more than once". A true property reported by an
      assertion that had stopped measuring it, for the second time on this one
      test.

      So it is asked where the shape actually is, and asked of the lane that it
      does NOT keep a private copy: two declarations of one row is how a write
      comes to hide behind the same words in the file the exclusion above does
      not scan.
    */
    const order = code(read("src/server/fleetMigrationEligibility.pure.ts"));
    expect(order.split("migration_heartbeat_at?: string | null").length - 1).toBe(1);
    expect(lane).not.toMatch(/migration_heartbeat_at\??:\s*(string|number|Date)\b/);
  });

  it("stops beating when the claim is gone, rather than saying a pass owns what it does not", () => {
    const body = beatBody();
    /*
      Bounded to the MISS BRANCH, not to the function. The stop it sets appears
      a second time in the returned `stop`, so an unbounded search finds that
      one and passes over a branch that no longer stops anything — caught by
      mutation, which is the only reason it is written this way.
    */
    const miss = body.indexOf("if (held === false)");
    // The returned stop, by its memo rather than by its signature — see the
    // anchor note above.
    const stop = body.indexOf("stopping ??=");
    expect(miss, "the claim-lost branch was not found").toBeGreaterThan(-1);
    expect(stop, "the returned stop was not found").toBeGreaterThan(miss);
    const branch = body.slice(miss, stop);
    expect(branch, "a beat told the claim is gone keeps beating").toContain("stopped = true");
    expect(branch, "the timer keeps firing after the claim is gone").toContain(
      "clearInterval(timer)",
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

  it("promises a resume only where there is a position to resume from", () => {
    /*
      A pass stops in one of two places and the sentence claimed the same thing
      about both. INSIDE a seed there is a cursor and the next pass really does
      carry on from that statement; BETWEEN migrations there is no position at
      all and the next pass starts the following migration from its beginning.

      Measured on `npc-test` at 00:00 on 20 Sep 2026: "3 statement(s) of a
      large seed sent … it resumes where it stopped", with `chunk_cursor` NULL
      and `migration_version` already moved to the seed it had just finished.
      The statements were real; the resume was not, and an operator waiting for
      that seed to continue was waiting for nothing.

      `chunksApplied` cannot stand in for the distinction — it counts statements
      sent THIS pass, which is equally true of a pass that finished a seed.
    */
    const at = lane.indexOf("pausedMidReplay\n");
    // Anchored on CODE. This slice used to begin at the trailing comment
    // `? // Said before the level reading`, which the shared strip removes —
    // a landmark made of prose is one the stripper is entitled to delete, and
    // the slice then silently became empty rather than failing to find it.
    const branch = lane.slice(at);
    const sentence = branch.slice(0, branch.indexOf("`Synced to ${syncedTo}`"));
    // The fact is the cursor the pass is about to WRITE, not a statement count.
    expect(sentence).toContain("chunkCursor !== null");
    expect(sentence).toMatch(/carries on from statement \$\{chunkCursor\.statementsDone\}/);
    // And the other readings are present and say something different.
    expect(sentence).toMatch(/finishing a large seed/);
    expect(sentence).toMatch(/starts from the one after/);
    /*
      INCLUDING THE ONE THE FIRST VERSION HAD NO BRANCH FOR.

      "The next pass starts from the one after X" was keyed on
      `chunkCursor === null && chunksApplied === 0` — which is precisely where
      `cursorWrite` resolves to `{}` and a STORED cursor survives untouched. So
      a pass that hit its deadline before reaching the seed promised a fresh
      start while the next pass resumes mid-seed from the cursor already on the
      row. The question the sentence answers is what the ROW WILL HOLD, not
      what this pass happened to do. Found by review.
    */
    expect(sentence).toMatch(/storedCursor !== null/);
    expect(sentence).toMatch(/did not reach the large seed it is part-way through/);
    expect(sentence).toMatch(/statement \$\{storedCursor\.statementsDone\}/);
    // The cleared-cursor reading is keyed on what clears it, not on a count.
    expect(sentence).toMatch(/chunkCursorDiscarded \|\| cursorFileLanded/);
    // The unconditional promise is gone.
    expect(sentence).not.toContain("it resumes where it stopped");
  });

  it("never reports a clone at the frontier on a pass that applied nothing", () => {
    /*
      `latestApplied` is what THIS pass applied and is null whenever the pass
      spent its budget inside one seed — the ordinary outcome. The fallback read
      "the prime's latest recorded migration", so `npc-client-dashboard` was
      described as level at 18:43 on 19 Sep 2026 in the same sentence as
      "4 migration(s) held back".

      The clone's own recorded version is on the row the pass already read, and
      it is a fact rather than a claim.
    */
    expect(lane).toMatch(
      /const syncedToFor = \(recorded: string \| null \| undefined\) =>\s*latestApplied \?\? recorded \?\? "no migration recorded yet";/,
    );
    expect(lane).toContain("const syncedTo = syncedToFor(backend.migration_version);");
    /*
      AND THE NO-OP PATH APPLIES IT TO A FRESHER READING.

      `backend` predates the claim and up to 45 s of network work. A manual
      sync that finishes inside that window advances the clone and writes its
      own accurate sentence; this pass then finds nothing to send, so
      `latestApplied` is null and the top-of-run rung names the version the
      sync replaced. The guard on `status_detail` would not catch it — it
      proves the sentence had not moved, not the version.
    */
    expect(lane).toContain("syncedTo: syncedToFor(recorded)");
    expect(lane).not.toContain(`latestApplied ?? "the prime's latest recorded migration"`);
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
    // Anchored on the column rather than on the end of the list: two more
    // joined it for the blockage reconciliation, and pinning the last name in
    // a select pins the order of a list nothing depends on the order of.
    expect(lane).toMatch(/migration_blocked_reason, chunk_cursor\b/);
  });

  it("writes the cursor on EVERY statement, not at the end of a pass", () => {
    const cb = lane.indexOf("onStatementDone:");
    expect(cb).toBeGreaterThan(-1);
    /*
      Sized to the callback's own update rather than to a byte count. A fixed
      700 went stale the moment a field was added above `console.error`, and the
      failure was about the window rather than about the rule — the third time
      that has happened in these files.
    */
    const cbEnd = lane.indexOf("if (!beat || beat.length === 0)", cb);
    expect(cbEnd, "could not find the end of onStatementDone").toBeGreaterThan(cb);
    const body = lane.slice(cb, cbEnd);
    expect(body).toContain('.from("clone_backends")');
    expect(body).toMatch(/chunk_cursor: \{[\s\S]{0,200}?migrationId: p\.migrationId/);
    expect(body).toMatch(/chunk_cursor: \{[\s\S]{0,200}?statementsDone: p\.statementsDone/);
    // And the file's SHAPE, so the next pass reads this 41 MB body once
    // instead of twice. Without it the cursor resumes correctly and pays the
    // first walk again on every single pass — which is the livelock this
    // block already exists to stop, at half speed rather than stopped.
    expect(body).toMatch(/chunk_cursor: \{[\s\S]{0,200}?shape: p\.shape/);
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

  it("names the BODY the cursor is into, so a re-released file is not resumed", () => {
    /*
      `statementsDone` is a count of chunks of ONE file. The shape check cannot
      tell a re-released body from the one the position was taken in — the
      template seed is 543 rows keyed by slug, and regenerating it rewrites
      `schema` and `design_meta` while the header, ON CONFLICT clause, tail and
      tuple COUNT all stay put — so without an identity the pass skips the
      prefix of the NEW body, leaves the OLD rows standing for it, and records
      the migration as applied. Raised by review on #227.

      Asserted on the lane rather than only on the replay, because the replay's
      check is inert if nobody hands it a `bodyIdentity`.
    */
    expect(lane).toContain("bodyIdentity: (m) => corpus.bodyIdentity(m)");
    // And it has to be WRITTEN, or the next pass has nothing to compare and the
    // refusal below restarts the seed on every single pass.
    const cb = lane.indexOf("onStatementDone:");
    expect(cb).toBeGreaterThan(-1);
    const write = lane.slice(cb, lane.indexOf('.eq("clone_id", cloneId)', cb));
    expect(write).toMatch(/chunk_cursor: \{[\s\S]*?bodySha: p\.bodySha/);
    /*
      Spread, not assigned. `undefined` and an absent key are the same to
      TypeScript and different in the jsonb this lands in, where an explicit
      null would read as "this body HAS no identity" rather than "nobody said" —
      and those two send the next pass to opposite behaviours.
    */
    expect(write).toMatch(/\.\.\.\(p\.bodySha === undefined \? \{\} : \{ bodySha: p\.bodySha \}\)/);
  });

  it("refuses the POSITION on the body's identity and keeps the SHAPE regardless", () => {
    const replay = code(read("src/server/backend-provisioning.server.ts"));
    /*
      `skip` and `cursorShape` both have to answer "is this cursor this body's?",
      and two spellings of that is how one of them comes to say yes where the
      other says no — a pass that skips the prefix of a body whose shape it then
      re-reads from scratch, or the reverse.
    */
    expect(replay).toContain(
      "const cursorIsForThisBody = cursorAppliesToBody(oversize.cursor, m.id, bodySha);",
    );
    expect(replay).toMatch(/const skip = cursorIsForThisBody \?/);
    /*
      AND THE SHAPE IS DELIBERATELY NOT GATED ON IT — two questions, not one.

      The POSITION must be refused when the body's identity does not match;
      that is what the identity is for. The remembered SHAPE must not be, and
      keeping it is safe because `chunkSeedStatements` re-derives the shape
      from the bytes it streams and compares all four fields: a shape that is
      wrong for this body cannot be used, only caught.

      Gating it cost a second full walk of the 41 MB seed — ~80 MB of blob
      traffic, a whole 45-second budget, zero statements advanced — and every
      cursor stored before `bodySha` existed lacks one, so the first pass after
      deploy would have paid it on every mid-seed clone. Nor does it stop at
      one pass: a pass that spends its budget reading has `applied === 0`, so
      the budget-stop never fires, so it writes no cursor, so the next pass
      refuses the same one and reads twice again. Found by review.
    */
    expect(replay).toMatch(/const cursorShape =\s*oversize\.cursor\?\.migrationId === m\.id \?/);
    expect(replay).not.toMatch(/const cursorShape =\s*cursorIsForThisBody/);
    /*
      The identity rule itself is pure and behaviourally tested — see
      `chunkCursorStore.pure.test.ts`. What is asserted HERE is that the replay
      does not grow a second copy of IT.

      Narrowed from also forbidding `oversize.cursor?.migrationId === m.id`,
      which was right while the two readers asked one question and is wrong now
      that they ask two: the migration-id check is the SHAPE's question, and the
      shape is deliberately not gated on the body's identity. Forbidding that
      spelling would have forbidden the fix.
    */
    expect(replay).not.toMatch(/oversize\.cursor\?\.bodySha === bodySha/);
  });

  it("puts the identity on every cursor it produces, not just the one it reads", () => {
    const replay = code(read("src/server/backend-provisioning.server.ts"));
    /*
      A pass that resumes correctly and then writes a cursor with NO identity
      hands the next pass a position it must refuse — a restart every pass, for
      ever, which is the livelock the cursor exists to end.

      Enumerated rather than listed, because listing them is how one is missed:
      this assertion found the upstream-refusal branch, which mints a cursor to
      preserve the statements that landed before the prime's body went
      unreadable and was the one site of four without an identity. Judged on
      comment-stripped source, so a comment naming the helper cannot satisfy it.
    */
    const fn = (() => {
      const at = replay.indexOf("async function applyChunkedSeed");
      expect(at, "applyChunkedSeed not found").toBeGreaterThan(-1);
      const to = replay.indexOf("\nasync function ", at + 1);
      expect(to, "no function after applyChunkedSeed").toBeGreaterThan(at);
      return replay.slice(at, to);
    })();
    const sites: number[] = [];
    for (
      let i = fn.indexOf("migrationId: m.id");
      i > -1;
      i = fn.indexOf("migrationId: m.id", i + 1)
    ) {
      sites.push(i);
    }
    // Five: the budget pause, the per-statement progress, the upstream refusal,
    // the ran-past-end reset, and the window pause — a pass that has sent every
    // statement it held with more of the seed still to go (see
    // `StatementWindow`). If a sixth appears this fails and is read.
    expect(sites, "the cursor-minting sites in applyChunkedSeed").toHaveLength(5);
    for (const at of sites) {
      // `identityOf()` before the object it is in closes. The window is the
      // object, not a byte count — a field added above it must not make this
      // pass by accident or fail for the wrong reason.
      const object = fn.slice(at, fn.indexOf("}", fn.indexOf("...identityOf()", at)) + 1);
      expect(object, `no identity on the cursor at offset ${at}`).toContain("...identityOf()");
      expect(object.indexOf("...identityOf()")).toBeGreaterThan(-1);
    }
    /*
      And the helper answers "nobody could name it" with an EMPTY object rather
      than an explicit undefined. Matched on the shape of that decision, not on
      its spelling: `{ bodySha: undefined }` and `{}` serialise identically
      through `JSON.stringify`, so no behavioural test can tell them apart here
      and an assertion on the exact characters would oppose a reformat rather
      than a regression. What it is worth pinning is that the null branch
      produces nothing at all — because the day a reader asks `"bodySha" in
      cursor` instead of comparing it, the two stop being the same.
    */
    expect(fn).toMatch(/identityOf = \(\) =>\s*\(?bodySha === null \? \{\} :/);
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
