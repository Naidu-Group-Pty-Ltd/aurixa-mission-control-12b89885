/**
 * One applier inside a clone's schema at a time, and the fleet lane's claim
 * decides which.
 *
 * ## What this is here to make impossible
 *
 * Two lanes replay the prime's scoped migrations into a clone: the fleet
 * migration lane, every half hour, and the self-healing `sql_migration` lane,
 * whenever a cascade or a person queues a run. The fleet lane has always held
 * a claim on `clone_backends.worker_started_at` for every clone it serves —
 * compare-and-swap, fenced writes, a heartbeat the stale-claim sweep reads.
 * The `sql_migration` lane replayed without it, so nothing stopped the two
 * sending the same migration into the same schema at once.
 *
 * That is not a theoretical race. The second send fails on a duplicate object
 * the clone never really lacked; when the FLEET lane is the one that records
 * the failure it writes a block, and a block holds the clone out of the fleet
 * until somebody proves it discharged. Found 26 Sep 2026, while probing why
 * migrations were not landing on the independent: four cascade catch-up runs
 * were parked in `awaiting_validation` with nothing between them and the
 * fleet lane's clones but a person pressing "approve".
 *
 * So the lane takes the same claim the same way and releases it the same
 * way, and a claim somebody else holds costs it nothing but a wait.
 *
 * Structural — which statement takes the claim, where, and what the `finally`
 * does — so it is asserted against the source. A Supabase double would agree
 * with wrong code here; the order of statements in the file cannot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
/** Source with comments removed — a comment quoting code is not code. */
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const healing = stripComments(read("src/server/self-healing.server.ts"));
const fleet = stripComments(read("src/server/fleet-migration.server.ts"));

const laneStart = healing.indexOf("async function executeSqlMigration");
const laneEnd = healing.indexOf("async function deployWithinBudget");
const lane = healing.slice(laneStart, laneEnd);

const waitStart = healing.indexOf("async function waitForClaim");
const wait = healing.slice(waitStart, laneStart);

/** The claim statement, from the table it names to the select that proves it. */
const claimAt = lane.indexOf(".update({ worker_started_at: claimedAt");
const claim = lane.slice(
  lane.lastIndexOf('.from("clone_backends")', claimAt),
  lane.indexOf('.select("clone_id")', claimAt) + '.select("clone_id")'.length,
);

/** The replay and everything after it up to the end of its `finally`. */
const replayAt = lane.indexOf("replay = await applyPrimeMigrations(");
const finallyAt = lane.indexOf("} finally {", replayAt);
const release = lane.slice(finallyAt, lane.indexOf("const { results, latestApplied", finallyAt));

describe("the slices this file reads exist", () => {
  it("finds the lane, the wait, the claim, the replay and its finally", () => {
    // A slice from -1 is the whole file, and every assertion below would pass
    // over it.
    expect(laneStart).toBeGreaterThan(-1);
    expect(laneEnd).toBeGreaterThan(laneStart);
    expect(waitStart).toBeGreaterThan(-1);
    expect(waitStart).toBeLessThan(laneStart);
    expect(claimAt).toBeGreaterThan(-1);
    expect(claim.length).toBeGreaterThan(50);
    expect(claim.length).toBeLessThan(600);
    expect(replayAt).toBeGreaterThan(claimAt);
    expect(finallyAt).toBeGreaterThan(replayAt);
    expect(release.length).toBeGreaterThan(50);
  });
});

describe("the lane takes the fleet lane's claim, in the fleet lane's way", () => {
  it("claims only a backend the fleet lane itself may claim", () => {
    // Any other status is the provisioning worker's — a seed, a restore, a
    // teardown — and a replay sent into it is the collision this prevents.
    const gate = lane.indexOf("MIGRATION_CLAIMABLE_STATUSES");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(claimAt);
    // The same list the fleet lane claims and reclaims by, never a copy.
    expect(healing).toContain(
      'import { MIGRATION_CLAIMABLE_STATUSES } from "@/server/fleetMigrationEligibility.pure"',
    );
    expect(fleet).toContain("[...MIGRATION_CLAIMABLE_STATUSES]");
  });

  it("claims with a compare-and-swap the database decides, never a read then a write", () => {
    expect(claim).toContain("worker_started_at: claimedAt");
    // Stamped WITH the claim: a claim whose heartbeat is written later reads
    // as abandoned to the stale-claim sweep until the first beat lands.
    expect(claim).toContain("migration_heartbeat_at: claimedAt");
    expect(claim).toContain('.eq("clone_id", run.clone_id)');
    expect(claim).toContain('.eq("status", backend.status)');
    expect(claim).toContain('.is("worker_started_at", null)');
    // A row count is the only thing that says the swap happened.
    expect(claim).toContain('.select("clone_id")');
  });

  it("is the same statement the fleet lane claims with", () => {
    // Two spellings of one claim is how one of them stops excluding the other.
    for (const clause of [
      "worker_started_at: claimedAt",
      "migration_heartbeat_at: claimedAt",
      '.eq("status", backend.status)',
      '.is("worker_started_at", null)',
      '.select("clone_id")',
    ]) {
      expect(fleet).toContain(clause);
    }
  });

  it("claims only after the scope and the gate, so the claim covers the replay and nothing else", () => {
    // A claim held across the corpus read and the destructiveness gate would
    // hold the fleet lane off a clone for work that sends nothing.
    const scope = lane.indexOf("openScopedPrimeCorpus(admin, source)");
    const gate = lane.indexOf("assessPendingMigrations(pending");
    const level = lane.indexOf("if (pending.length === 0)");
    expect(scope).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(scope);
    expect(level).toBeGreaterThan(scope);
    expect(claimAt).toBeGreaterThan(gate);
    expect(claimAt).toBeGreaterThan(level);
  });

  it("a claim that ERRORED is thrown, never read as a claim somebody else won", () => {
    const after = lane.slice(claimAt, replayAt);
    expect(after).toMatch(/if \(claimErr\) throw new Error\(/);
    expect(after.indexOf("if (claimErr)")).toBeLessThan(after.indexOf("waitForClaim("));
  });

  it("a claim somebody else holds is a wait, not a park and not a failure", () => {
    const after = lane.slice(claimAt, replayAt);
    expect(after).toMatch(/if \(!claimed \|\| claimed\.length === 0\) \{\s*return waitForClaim\(/);
    expect(after).not.toContain("parkRun(");
  });
});

describe("the claim is held by a heartbeat and released, fenced, whatever the replay does", () => {
  it("beats with the fleet lane's own heartbeat from the moment it holds the claim", () => {
    const beat = lane.indexOf("beatWhileClaimHeld(admin, run.clone_id, claimedAt)");
    expect(beat).toBeGreaterThan(claimAt);
    expect(beat).toBeLessThan(replayAt);
    // Imported from the fleet lane rather than written again here.
    expect(lane).toMatch(
      /\{\s*openScopedPrimeCorpus,\s*beatWhileClaimHeld\s*\}\s*=\s*await import\("@\/server\/fleet-migration\.server"\)/,
    );
    expect(fleet).toContain("export function beatWhileClaimHeld(");
  });

  it("replays inside a try whose finally stops the beats before it releases", () => {
    // `try {` sits between the heartbeat and the replay, so a replay that
    // throws still reaches the release.
    const between = lane.slice(lane.indexOf("beatWhileClaimHeld("), replayAt);
    expect(between).toContain("try {");
    const stop = release.indexOf("await heartbeat.stop();");
    const freed = release.indexOf(".update({ worker_started_at: null })");
    expect(stop).toBeGreaterThan(-1);
    // Stopped FIRST, as the fleet lane orders it: a beat still in the air
    // after the release would stamp a claim this pass has let go.
    expect(freed).toBeGreaterThan(stop);
  });

  it("releases only the claim it took", () => {
    // Fenced on its own timestamp: a claim the stale sweep reclaimed and a
    // successor re-took is not this pass's to release.
    expect(release).toContain('.eq("clone_id", run.clone_id)');
    expect(release).toContain('.eq("worker_started_at", claimedAt)');
  });

  it("names a release that failed rather than dropping it", () => {
    // Not fatal — the stale sweep frees it five minutes after the beats stop —
    // but a clone skipped for that long should say why.
    expect(release).toMatch(/if \(releaseErr\) \{\s*console\.error\(/);
  });
});

describe("waiting for the claim costs the run nothing", () => {
  it("hands the run back planned, with the attempt it was charged undone", () => {
    /*
      `executeRemediationRun` charges an attempt before the lane runs. Waiting
      for a worker that is doing this very job is not a failed attempt, and
      charging it would park a run for being polite — so the count written back
      is the one from before this invocation, the rule every other requeue in
      the file follows.
    */
    expect(wait).toContain("attempts: run.attempts ?? 0");
    expect(wait).toContain("next_attempt_at:");
    expect(wait).toContain("waiting:");
    expect(wait).not.toContain("(run.attempts ?? 0) + 1");
    expect(wait).not.toContain("completed_at");
  });

  it("keeps an operator's approval while it waits", () => {
    /*
      `approvedByHuman` is read from the status alone, and the wait comes after
      the destructiveness gate the approval let the run past. Written back
      `planned`, an approved run meets that gate again and parks for the same
      approval — with nothing sent in between.
    */
    expect(healing).toContain('const approvedByHuman = run.status === "approved";');
    expect(wait).toContain('status: run.status === "approved" ? "approved" : "planned"');
    expect(wait).not.toMatch(/status: "planned"/);
    // Safe only because the drain still takes an approved run when it is due.
    const sweep = healing.slice(healing.indexOf("export async function sweepSupportRemediations"));
    expect(sweep).toContain('.in("status", ["planned", "approved"])');
  });

  it("every return the claim can produce is either the replay or a wait", () => {
    const beforeReplay = lane.slice(lane.indexOf("MIGRATION_CLAIMABLE_STATUSES"), replayAt);
    const returns = beforeReplay.match(/return [A-Za-z]+\(/g) ?? [];
    expect(returns.length).toBeGreaterThan(0);
    for (const r of returns) expect(r).toBe("return waitForClaim(");
  });
});
