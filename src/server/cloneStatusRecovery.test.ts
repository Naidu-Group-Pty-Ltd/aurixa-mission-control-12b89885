import { stripComments } from "@/server/sourceComments.pure";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A clone the self-healing lane repairs must rejoin the fleet.
 *
 * `clone_backends.status` is written by the fleet sync and the per-clone sync
 * button; both set `failed` on a refusal and clear it on their own next
 * success. The self-healing lane repairs clones too and used to write none of
 * it, so a clone IT fixed kept the other lane's verdict — measured 2026-09-12,
 * two clones reading "Migration failed at 20250124160000_…" while holding 28
 * of 28 target tables.
 */
const lane = readFileSync("src/server/self-healing.server.ts", "utf8");
const helper = lane.slice(
  lane.indexOf("async function clearStaleMigrationFailure"),
  lane.indexOf("async function executeSqlMigration("),
);
/**
 * The two halves, sliced apart.
 *
 * An assertion about the compare-and-swap must not be satisfiable by the fact
 * write, and an assertion about the fact must not be satisfiable by the
 * transition — which is the whole point of #232 and so the whole point of
 * reading them separately.
 */
const factWrite = helper.slice(
  helper.indexOf("async function recordAppliedVersion"),
  helper.indexOf("async function clearFailedVerdict"),
);
const transitionWrite = helper.slice(helper.indexOf("async function clearFailedVerdict"));

describe("clearStaleMigrationFailure", () => {
  it("exists and is called from the SQL migration lane", () => {
    expect(helper.length).toBeGreaterThan(0);
    const calls = lane.match(/await clearStaleMigrationFailure\(/g) ?? [];
    expect(calls.length).toBe(2); // the level path and the applied path
  });

  it("is a compare-and-swap on 'failed' and can never promote another status", () => {
    // The one rule that makes this safe to run beside the provisioning drain:
    // pending / provisioning / migrating / seeding_admin / suspended are the
    // drain's, and this must not touch them.
    expect(transitionWrite).toContain('.eq("status", "failed")');
  });

  it("never marks a clone failed", () => {
    expect(helper).not.toMatch(/status:\s*["']failed["']/);
  });

  it("moves migration_version only when something was applied", () => {
    // A pass that merely confirmed the clone level establishes no new version.
    // Renegotiated for #232: this used to pin the conditional spread inside
    // the single update. The condition is now the call itself, because the
    // version is written by a statement of its own.
    // The RULE, not its spelling: the fact write is reached only where a
    // version exists to record, and it is its own statement.
    expect(helper).toMatch(/latestApplied !== null\s*\?\s*await recordAppliedVersion\(/);
  });

  it("writes the version WITHOUT the status compare-and-swap — #232", () => {
    // THE DEFECT. The `sql_migration` lane reaches this from a remediation
    // ticket, not a failed status, so on a `ready` clone the CAS matched no
    // row and the version was silently dropped while the clone's own ledger
    // had moved. `migration_version` is a fact about what was applied and
    // cannot be conditional on a state transition succeeding.
    expect(factWrite).toContain("migration_version: latestApplied");
    expect(factWrite, "the fact must not be gated on a status").not.toContain('"status"');
    expect(factWrite).not.toMatch(/status:\s*["']/);
  });

  it("the version can only ever move forward", () => {
    // The provisioning drain may be mid-replay on the same clone and may have
    // recorded a later version already. Decided in the WHERE clause, so no
    // interleaving between a read and a write can defeat it.
    expect(factWrite).toContain('.lt("migration_version", latestApplied)');
    expect(factWrite).toContain('.is("migration_version", null)');
  });

  it("spells the NULL case separately rather than composing a filter", () => {
    // `.lt` does not match a NULL column, and a clone that has never recorded
    // a version is the commonest case here. The one-statement alternative is
    // an `.or()` naming both — the shape whose interpolated filter string
    // never parsed, so `screeningConsumer`'s claim had never once succeeded.
    expect(factWrite).not.toContain(".or(");
  });

  it("writes the fact BEFORE the transition", () => {
    // If the transition fails after the fact landed, the clone reads `failed`
    // at the right version: visible and recoverable. The other order leaves it
    // `ready` at a stale one, which is the defect itself.
    const fact = helper.indexOf("await recordAppliedVersion(");
    const transition = helper.indexOf("await clearFailedVerdict(");
    expect(fact).toBeGreaterThan(-1);
    expect(transition).toBeGreaterThan(fact);
  });

  it("does not write status_detail twice", () => {
    // The reading travels with whichever write it describes. Written in both,
    // a refused version write would still leave the clone announcing a level
    // it is not at.
    expect(factWrite).toContain("status_detail: `Synced to ${latestApplied}`");
    // The transition never states a LEVEL. It may state that it knows none —
    // see the test below — but `Synced to …` belongs to the write that
    // established it and to nothing else.
    expect(transitionWrite).not.toContain("Synced to");
  });

  it("never leaves the other lane's reason standing under a healthy status", () => {
    /*
      The state this closes: the forward-only WHERE matches nothing because the
      drain already carried the clone to this version, so no reading is
      written — and the compare-and-swap then flips `failed` to `ready` with
      `Provisioning ceiling exceeded` still in `status_detail`. Only the
      PROVISIONING path ever writes that column's `failed`; the migration lane
      writes `migration_blocked_*` instead and says so in its own comment. So
      the reason left behind is always another lane's.

      Null rather than a sentence, because the only thing this write has earned
      is that the verdict is stale. It does not know what level the clone is at
      — that is precisely the branch where the fact write matched nothing.
    */
    expect(transitionWrite).toContain("status_detail: null");
    expect(transitionWrite).toMatch(/versionRecorded\s*\?\s*\{\}/);
  });

  it("knows whether the reading landed rather than assuming it did", () => {
    // `recordAppliedVersion` used to return void, so the transition could not
    // tell "already at this version" from "just moved to it" — and those need
    // different readings.
    expect(helper).toContain("): Promise<boolean> {");
    expect(factWrite).toContain('.select("clone_id")');
    expect(factWrite).toContain("if (data && data.length > 0) recorded = true;");
  });

  it("clears the other lane's blocked pair rather than leaving it to rot", () => {
    expect(helper).toContain("migration_blocked_at: null");
    expect(helper).toContain("migration_blocked_reason: null");
    expect(helper).toContain("error_message: null");
  });

  it("can never fail the run that already applied the migrations", () => {
    expect(helper).toMatch(/try\s*\{[\s\S]*\}\s*catch\s*\(/);
  });

  it("reads the driver's answer rather than assuming the write landed", () => {
    // A PostgREST write resolves to `{ data, error }` and does not throw, so a
    // bare statement reports success whatever the database said. That is the
    // shape `screeningConsumer`'s claim had, where a database fault and losing
    // a race were indistinguishable. Here the two that must not look alike are
    // "matched no row" — the ordinary case — and "the database refused".
    expect(helper).toContain("const { error } = await admin");
    expect(helper).toMatch(/if \(error\)\s*\{/);
  });

  it("is best effort without being silent, on both failure paths", () => {
    // Not throwing is the point; saying nothing is not. Both the refused write
    // and a transport throw leave a repaired clone reporting a failure for
    // ever, so both are logged with whatever the driver said.
    // Renegotiated for #232: two writes, each with a refusal path and a throw
    // path, so four rather than two. Counted PER HALF rather than over the
    // whole helper — a single total is satisfied by both reports living in one
    // write, which is exactly the half that would then go quiet.
    for (const [name, half] of [
      ["the fact", factWrite],
      ["the transition", transitionWrite],
    ] as const) {
      expect((half.match(/console\.error\(/g) ?? []).length, name).toBe(2);
      expect((half.match(/if \(error\)\s*\{/g) ?? []).length, name).toBe(1);
      expect((half.match(/\}\s*catch\s*\(/g) ?? []).length, name).toBe(1);
    }
    expect(helper).toContain("error.message");
    expect(helper).toContain("e instanceof Error ? e.message : String(e)");
  });

  it("only clears on a pass with nothing held back", () => {
    // A clone still holding migrations back is not level, whatever it applied.
    expect(lane).toContain("if (orphaned.length === 0) await clearStaleMigrationFailure(");
    expect(lane).toContain("if (landed > 0 && heldBack === 0) {");
  });
});

describe("whose verdict the compare-and-swap is actually clearing", () => {
  /*
    `clearFailedVerdict` swaps on `clone_backends.status = 'failed'`, and the
    migration lane never writes that column. Measured 20 Sep 2026: the only
    writer of `status: "failed"` on `clone_backends` is the provisioning path
    in `src/lib/backend-provisioning.functions.ts`. `fleet-migration.server.ts`
    writes `migration_blocked_at` / `migration_blocked_reason` and says why in
    its own comment — "`status` is shared with the provisioning drain and says
    nothing reliable about a schema".

    So this repair clears a PROVISIONING verdict, always, on migration
    evidence. That is deliberate — the call site says "whatever verdict another
    lane left, it is not true now", and a pass that carried a clone level with
    the prime has proved the backend exists, is reachable and accepts DDL.

    It is asserted rather than trusted because the reasoning depends on it. The
    day the migration lane starts writing `status`, the swap stops being
    cross-lane and everything above needs rereading.
  */
  const migrationLane = stripComments(
    readFileSync("src/server/fleet-migration.server.ts", "utf8"),
  );

  it("the migration lane writes the blocked pair, never the shared status", () => {
    expect(migrationLane).toContain("migration_blocked_at:");
    expect(migrationLane).not.toMatch(/\bstatus:\s*["'`]failed["'`]/);
    expect(migrationLane).not.toMatch(/\bstatus:\s*["'`]ready["'`]/);
  });

  it("and the repair swaps on that shared status, knowingly", () => {
    expect(transitionWrite).toContain('.eq("status", "failed")');
  });
});
