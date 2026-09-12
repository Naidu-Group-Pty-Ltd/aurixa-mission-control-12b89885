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
    expect(helper).toContain('.eq("status", "failed")');
  });

  it("never marks a clone failed", () => {
    expect(helper).not.toMatch(/status:\s*["']failed["']/);
  });

  it("moves migration_version only when something was applied", () => {
    // A pass that merely confirmed the clone level establishes no new version.
    expect(helper).toContain("...(latestApplied ? { migration_version: latestApplied } : {})");
  });

  it("clears the other lane's blocked pair rather than leaving it to rot", () => {
    expect(helper).toContain("migration_blocked_at: null");
    expect(helper).toContain("migration_blocked_reason: null");
    expect(helper).toContain("error_message: null");
  });

  it("can never fail the run that already applied the migrations", () => {
    expect(helper).toMatch(/try\s*\{[\s\S]*\}\s*catch\s*\{/);
  });

  it("only clears on a pass with nothing held back", () => {
    // A clone still holding migrations back is not level, whatever it applied.
    expect(lane).toContain("if (orphaned.length === 0) await clearStaleMigrationFailure(");
    expect(lane).toContain("if (landed > 0 && heldBack === 0) {");
  });
});
