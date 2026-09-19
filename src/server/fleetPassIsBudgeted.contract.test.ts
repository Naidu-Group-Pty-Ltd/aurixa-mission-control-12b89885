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
    const check = lane.indexOf("if (Date.now() >= deadlineAt)");
    const claim = lane.indexOf(".update({ worker_started_at: new Date().toISOString() })");
    expect(check).toBeGreaterThan(loop);
    expect(claim).toBeGreaterThan(-1);
    expect(check, "the deadline must be read before the claim is taken").toBeLessThan(claim);
  });

  it("stops rather than skipping, so it does not walk the rest of the fleet for nothing", () => {
    const check = lane.indexOf("if (Date.now() >= deadlineAt)");
    const after = lane.slice(check, check + 120);
    expect(after).toContain("break;");
    expect(after).not.toContain("continue;");
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
