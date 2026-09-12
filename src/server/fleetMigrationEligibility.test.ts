import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  MIGRATION_CLAIMABLE_STATUSES,
  PROVISIONING_IN_FLIGHT,
  blockIsDischarged,
  blockedVersionFrom,
  migrationEligibility,
  type BackendFacts,
} from "./fleetMigrationEligibility.pure";

const HEALTHY: BackendFacts = {
  supabaseProjectRef: "abcdefghijklmnopqrst",
  status: "ready",
  workerStartedAt: null,
  migrationBlockedAt: null,
  migrationBlockedReason: null,
};

describe("migrationEligibility", () => {
  it("admits a ready backend with a project", () => {
    expect(migrationEligibility(HEALTHY)).toEqual({ eligible: true });
  });

  /*
    THE DEFECT THIS MODULE EXISTS TO CLOSE.

    `NPC Test` and `Preflight Property Group` were failed by the PROVISIONING
    drain's wall-clock ceiling on 8 Sep 2026 — never claimed once, nothing run,
    nothing judged about their schemas — and that verdict took them out of the
    migration lane for a day while both databases were healthy and level with
    the third clone.

    A `failed` row is only out of this lane when THIS lane put it there.
  */
  it("admits a failed backend that this lane did not block", () => {
    expect(migrationEligibility({ ...HEALTHY, status: "failed" })).toEqual({ eligible: true });
  });

  it("refuses a backend this lane blocked, and says which migration", () => {
    const v = migrationEligibility({
      ...HEALTHY,
      status: "ready",
      migrationBlockedAt: "2026-09-08T01:00:00.000Z",
      migrationBlockedReason: "20260916100000_seed.sql: relation already exists",
    });
    expect(v.eligible).toBe(false);
    if (v.eligible) throw new Error("unreachable");
    expect(v.reason).toBe("migration_blocked");
    expect(v.detail).toContain("20260916100000_seed.sql");
  });

  it("blocks on the STAMP, not on the status beside it", () => {
    // A blocked row that provisioning has since moved back to `ready` is
    // still blocked: only a successful migration pass clears the stamp.
    const v = migrationEligibility({
      ...HEALTHY,
      status: "ready",
      migrationBlockedAt: "2026-09-08T01:00:00.000Z",
      migrationBlockedReason: null,
    });
    expect(v.eligible).toBe(false);
  });

  it("refuses a backend with no project, because there is nothing to advance", () => {
    const v = migrationEligibility({ ...HEALTHY, supabaseProjectRef: null });
    expect(v.eligible).toBe(false);
    if (v.eligible) throw new Error("unreachable");
    expect(v.reason).toBe("no_project");
  });

  it.each([...PROVISIONING_IN_FLIGHT])("refuses %s — provisioning is writing it", (status) => {
    const v = migrationEligibility({ ...HEALTHY, status });
    expect(v.eligible).toBe(false);
    if (v.eligible) throw new Error("unreachable");
    expect(v.reason).toBe("provisioning_in_flight");
  });

  it("refuses a claimed backend whatever its status says", () => {
    const v = migrationEligibility({
      ...HEALTHY,
      status: "ready",
      workerStartedAt: "2026-09-08T01:00:00.000Z",
    });
    expect(v.eligible).toBe(false);
    if (v.eligible) throw new Error("unreachable");
    expect(v.reason).toBe("provisioning_in_flight");
  });

  it("refuses a suspended backend on its own terms, never as a fault", () => {
    const v = migrationEligibility({ ...HEALTHY, status: "suspended" });
    expect(v.eligible).toBe(false);
    if (v.eligible) throw new Error("unreachable");
    expect(v.reason).toBe("suspended");
    // The remedy is reinstatement, and the state resolves by itself. An
    // operator sent to look for a broken migration on a deliberately
    // suspended tenant wastes the trip, so this must never read as the
    // `migration_blocked` verdict beside it.
    expect(v.detail).toMatch(/reinstat/i);
    const blocked = migrationEligibility({
      ...HEALTHY,
      migrationBlockedAt: "2026-09-08T01:00:00.000Z",
      migrationBlockedReason: "x.sql: boom",
    });
    if (blocked.eligible) throw new Error("unreachable");
    expect(v.detail).not.toBe(blocked.detail);
  });
});

/*
  A status added to the database and to NEITHER list would fall silently into
  whichever side the control flow defaults to — the same shape as the defect
  this module closes: a state nobody classified, decided by accident.

  So the enum is READ from the migration that declares it rather than
  restated here. A literal copy would pass for ever after somebody adds a
  value to the database, which is exactly the failure mode.
*/
function declaredStatuses(): string[] {
  const dir = "supabase/migrations";
  for (const file of readdirSync(dir).sort()) {
    const sql = readFileSync(`${dir}/${file}`, "utf-8");
    const m = /CREATE TYPE public\.clone_backend_status AS ENUM\s*\(([^)]*)\)/i.exec(sql);
    if (m) return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  }
  throw new Error("clone_backend_status is not declared in supabase/migrations");
}

describe("the status partition", () => {
  it("covers the declared enum exactly — nothing in both lists, nothing in neither", () => {
    const ENUM = declaredStatuses();
    expect(ENUM.length).toBeGreaterThan(0);

    const overlap = (PROVISIONING_IN_FLIGHT as readonly string[]).filter((s) =>
      (MIGRATION_CLAIMABLE_STATUSES as readonly string[]).includes(s),
    );
    expect(overlap, "a status in both lists makes the mutex ambiguous").toEqual([]);

    const declared = new Set<string>([...PROVISIONING_IN_FLIGHT, ...MIGRATION_CLAIMABLE_STATUSES]);
    for (const value of ENUM) {
      expect(declared.has(value), `${value} is in neither list`).toBe(true);
    }
    expect([...declared].sort()).toEqual([...ENUM].sort());
  });

  it("reaches a stated decision for every declared status", () => {
    for (const status of declaredStatuses()) {
      const v = migrationEligibility({ ...HEALTHY, status });
      // Eligible or not, the verdict is one this module states about THIS
      // status rather than a fall-through nobody wrote.
      if (!v.eligible) expect(v.detail.length).toBeGreaterThan(20);
      expect(typeof v.eligible).toBe("boolean");
    }
  });
});

describe("a block the clone has since discharged", () => {
  /*
    The reason string, verbatim from `npc-test-76b3b3` on 12 Sep 2026. It was
    recorded at 09:31, the prime's copy of that file was fixed at 09:33, the
    clone applied the version at 10:14 — and every sync for the next five hours
    still excluded it, quoting a syntax error that no longer existed anywhere.
  */
  const REAL_REASON =
    "20250124160000_prepare_extensions_schema.sql: SQL execution failed on " +
    'umrtusxohxjxzodxorim: 400 — {"message":"Failed to run sql query: ERROR:  42601: ' +
    'syntax error at or near \\"current_schema\\"\\nLINE 29:   current_schema TEXT NOT NULL,"}';

  it("reads the version out of the reason the lane itself writes", () => {
    expect(blockedVersionFrom(REAL_REASON)).toBe("20250124160000");
  });

  it("discharges it when the clone's own ledger records that version", () => {
    // Both of that clone's ledgers held 20250124160000 the whole time.
    expect(blockIsDischarged(REAL_REASON, ["20250124120000", "20250124160000"])).toBe(true);
  });

  it("keeps the block while the clone does not hold it", () => {
    expect(blockIsDischarged(REAL_REASON, ["20250124120000"])).toBe(false);
  });

  it("never discharges a reason that names no version", () => {
    // The guard is allowed to be wrong in one direction only. A reason this
    // cannot parse proves nothing, so the block stands.
    for (const reason of [
      null,
      undefined,
      "",
      "A prime migration failed on this clone and it is held out of the fleet sync until repaired.",
      "prepare_extensions_schema.sql: failed",
      "2025012416000_short.sql: failed",
    ]) {
      expect(blockIsDischarged(reason, ["20250124160000", "20250124120000"])).toBe(false);
    }
  });

  it("never discharges against an empty applied-set", () => {
    // A failed ledger read must not reach here as `[]`. Empty is a CLAIM —
    // "this clone holds nothing" — and the caller keeps the block instead.
    expect(blockIsDischarged(REAL_REASON, [])).toBe(false);
  });

  it("matches the version only at the start of the reason", () => {
    // The stamp is the filename prefix the lane wrote, not any 14 digits that
    // happen to appear inside a driver's error text.
    expect(blockedVersionFrom("failed applying 20250124160000_x.sql")).toBeNull();
  });
});

describe("the lane's rehabilitation pass", () => {
  const lane = readFileSync("src/server/fleet-migration.server.ts", "utf8");
  const pass = lane.slice(
    lane.indexOf("A BLOCK THE CLONE HAS SINCE DISCHARGED IS NOT A BLOCK"),
    lane.indexOf("const skipped = verdicts.filter"),
  );

  it("exists, and runs before the eligible set is partitioned", () => {
    expect(pass.length).toBeGreaterThan(200);
    expect(lane.indexOf("blockIsDischarged(")).toBeLessThan(
      lane.indexOf("const skipped = verdicts.filter"),
    );
  });

  it("clears the block and never the status", () => {
    // `status` belongs to whichever lane last ran a migration here.
    // `clearStaleMigrationFailure` settles it on the pass that follows, and two
    // writers on one field is the fault this codebase keeps meeting.
    expect(pass).toContain("migration_blocked_at: null");
    expect(pass).toContain("migration_blocked_reason: null");
    expect(pass).not.toMatch(/status:\s*["']/);
  });

  it("keeps the block when the ledger could not be read", () => {
    // A read that FAILED says nothing. Passing its emptiness on as `[]` would
    // be a claim, and the one it makes is the opposite of the truth.
    expect(pass).toContain("if (!ledger.ok)");
    expect(pass).toMatch(/if \(!ledger\.ok\)[\s\S]{0,320}?continue;/);
  });

  it("only ever considers a clone already being excluded for this reason", () => {
    expect(pass).toContain('v.verdict.reason !== "migration_blocked"');
    expect(pass).toContain("if (v.verdict.eligible) continue;");
  });

  it("is not silent when it cannot do its job", () => {
    // Best effort, but a failed read and a refused write both leave a clone
    // fenced out of the fleet, which is exactly what nobody noticed for five
    // hours. Both paths log with the driver's own words.
    expect((pass.match(/console\.error\(/g) ?? []).length).toBe(2);
  });

  it("reports what it rehabilitated rather than letting a count move quietly", () => {
    expect(lane).toContain("rehabilitated: string[];");
    expect(lane).toContain("rehabilitated,");
  });
});
