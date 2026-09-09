import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  MIGRATION_CLAIMABLE_STATUSES,
  PROVISIONING_IN_FLIGHT,
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
