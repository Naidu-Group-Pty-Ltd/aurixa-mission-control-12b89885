/**
 * The per-clone "Sync migrations" button takes the fleet lane's claim.
 *
 * ## What this is here to make impossible
 *
 * Three things replay the prime's scoped migrations into a clone: the fleet
 * migration lane, the self-healing `sql_migration` lane, and this button. The
 * first two hold one claim on `clone_backends.worker_started_at` — a
 * compare-and-swap, a heartbeat the stale-claim sweep reads, a release fenced
 * on the timestamp taken. The button held nothing: it wrote `status:
 * 'migrating'`, which no lane's claim reads, and replayed. Nothing stopped it
 * sending a migration into a schema the fleet sync was already sending it
 * into, and the second send fails on an object the first created, which blocks
 * the clone (`docs/DELIVERY_SYSTEM_PLAN.md` §4.3, W7).
 *
 * `migrating` was worse than no mark. It is a provisioning status: the fleet
 * lane's stale-claim sweep never looks at it, and the provisioning drain
 * requeues an in-flight status nobody has claimed, which is a re-provision of
 * a live tenant.
 *
 * Structural — which statement takes the claim, where, and which write lets
 * it go — so it is asserted against the source, as the remediation lane's
 * claim is (`sqlMigrationLaneClaim.contract.test.ts`). A Supabase double would
 * agree with wrong code here; the order of statements in the file cannot.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
/** Source with comments removed — a comment quoting code is not code. */
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const sync = stripComments(read("src/server/migration-sync.functions.ts"));
const fleet = stripComments(read("src/server/fleet-migration.server.ts"));

const handlerStart = sync.indexOf("export const syncCloneMigrations");
const handlerEnd = sync.indexOf("export const restampCloneMigrationLedger");
const handler = sync.slice(handlerStart, handlerEnd);

/** The claim statement, from the table it names to the select that proves it. */
const claimAt = handler.indexOf("worker_started_at: claimedAt,");
const claim = handler.slice(
  handler.lastIndexOf("await supabaseAdmin", claimAt),
  handler.indexOf('.select("clone_id")', claimAt) + '.select("clone_id")'.length,
);

/** The one write that records the press and lets the claim go. */
const settleAt = handler.indexOf("const settle = async");
const settle = handler.slice(settleAt, handler.indexOf("try {", settleAt));

const scopeAt = handler.indexOf("await openScopedPrimeCorpus(supabase, source)");
const heartbeatAt = handler.indexOf("beatWhileClaimHeld(supabaseAdmin, data.cloneId, claimedAt)");
const replayAt = handler.indexOf("await applyPrimeMigrations(");

describe("the slices this file reads exist", () => {
  it("finds the handler, the claim, the release, the scope, the heartbeat and the replay", () => {
    // A slice from -1 is the whole file, and every assertion below would pass
    // over it.
    expect(handlerStart).toBeGreaterThan(-1);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(claimAt).toBeGreaterThan(-1);
    expect(claim.length).toBeGreaterThan(50);
    expect(claim.length).toBeLessThan(600);
    expect(settleAt).toBeGreaterThan(claimAt);
    expect(settle.length).toBeGreaterThan(50);
    expect(scopeAt).toBeGreaterThan(-1);
    expect(heartbeatAt).toBeGreaterThan(-1);
    expect(replayAt).toBeGreaterThan(-1);
  });
});

describe("the button takes the fleet lane's claim, in the fleet lane's way", () => {
  it("claims with a compare-and-swap the database decides", () => {
    expect(claim).toContain('.from("clone_backends")');
    expect(claim).toContain("worker_started_at: claimedAt");
    // Stamped WITH the claim: a claim whose heartbeat is written later reads
    // as abandoned to the stale-claim sweep until the first beat lands.
    expect(claim).toContain("migration_heartbeat_at: claimedAt");
    expect(claim).toContain('.eq("clone_id", data.cloneId)');
    expect(claim).toContain('.eq("status", "ready")');
    expect(claim).toContain('.is("worker_started_at", null)');
    // A row count is the only thing that says the swap happened.
    expect(claim).toContain('.select("clone_id")');
  });

  it("claims on the service role, which the heartbeat is granted to", () => {
    expect(claim.startsWith("await supabaseAdmin")).toBe(true);
    expect(handler).toContain('await import("@/integrations/supabase/client.server")');
    // The fleet lane's own heartbeat, never a second implementation of it.
    expect(sync).toMatch(
      /import \{[^}]*\bbeatWhileClaimHeld\b[^}]*\} from "\.\/fleet-migration\.server"/,
    );
    expect(fleet).toContain("export function beatWhileClaimHeld(");
  });

  it("refuses, sending nothing, when another pass holds the clone", () => {
    const held = handler.slice(claimAt, heartbeatAt);
    expect(held).toContain("if (!claimed || claimed.length === 0)");
    expect(held).toContain("return { ok: false, error: SYNC_CLAIM_HELD }");
    // An errored claim is not a claim somebody else won.
    expect(held).toContain("if (claimErr)");
  });

  it("claims after the corpus is open and before the replay, so the claim covers the replay", () => {
    expect(scopeAt).toBeLessThan(claimAt);
    expect(claimAt).toBeLessThan(heartbeatAt);
    expect(heartbeatAt).toBeLessThan(replayAt);
  });

  it("never marks the row `migrating`, which is the provisioning worker's", () => {
    expect(handler).not.toContain('"migrating"');
  });
});

describe("the claim is let go in the write that records the press", () => {
  it("stops the beats before the release, so none lands on a claim already let go", () => {
    const stop = settle.indexOf("await heartbeat.stop()");
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(settle.indexOf('.from("clone_backends")'));
  });

  it("releases in the same statement as the record, fenced on the timestamp it took", () => {
    expect(settle).toContain("worker_started_at: null");
    expect(settle).toContain('.eq("worker_started_at", claimedAt)');
    // A fence that matched nothing is a claim reclaimed by another pass, and
    // is said as such rather than read as a write that landed.
    expect(settle).toContain('.select("clone_id")');
    expect(settle).toContain("released.length === 0");
  });

  it("writes nothing to the clone's row once it holds the claim, except through that release", () => {
    const afterClaim = handler.slice(heartbeatAt);
    const writes = afterClaim.split('.from("clone_backends")').length - 1;
    // The one inside `settle` itself.
    expect(writes).toBe(1);
    // The record of the replay, and the record of a replay that threw.
    expect(afterClaim.split("await settle(").length - 1).toBe(2);
    expect(afterClaim).toContain("const recordErr = await settle(");
    expect(afterClaim).toMatch(/const errorNotRecorded = settled\s*\?\s*null\s*:\s*await settle\(/);
  });

  it("stops the heartbeat on a path that threw before it could release", () => {
    const tail = handler.slice(handler.lastIndexOf("} finally {"));
    expect(tail).toContain("await heartbeat.stop()");
  });
});
