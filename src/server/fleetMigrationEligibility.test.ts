import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  MIGRATION_CLAIMABLE_STATUSES,
  PROVISIONING_IN_FLIGHT,
  blockIsDischarged,
  blockIsUpstreamRefusal,
  blockedVersionFrom,
  compareMigrationQueue,
  migrationEligibility,
  orderMigrationQueue,
  type BackendFacts,
} from "./fleetMigrationEligibility.pure";
import { isUpstreamRateLimit } from "./provisioningBudget";
import { stripComments } from "./sourceComments.pure";

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

  /*
    A BLOCK WRITTEN FROM A QUOTA REFUSAL CAN NEVER PASS THE TEST ABOVE.

    Verbatim from `clone_backends.migration_blocked_reason` on
    `npc-client-dashboard` and `preflight-property-group`, written 14 Sep
    13:30 UTC and still standing on 19 Sep. Nothing was ever sent to those
    clones — GitHub refused to serve the body — so the version this reason
    names cannot enter their ledgers, because only a run applies anything and
    a blocked clone gets no run.
  */
  const QUOTA_REASON =
    "20261124000000_builder_portal_decommission.sql: API rate limit exceeded for " +
    "installation ID 157200201. If you reach out to GitHub Support for help, please " +
    "include the request ID BAA6:23251:A3CF0B:9EF25C:6AA7F6E3 and timestamp " +
    "2026-09-14 13:30:25 UTC.";

  it("recognises the quota refusal the lane actually recorded", () => {
    expect(blockIsUpstreamRefusal(QUOTA_REASON)).toBe(true);
  });

  it("is the reason the ledger route could not release those three", () => {
    // The whole corpus of the prime, and it still answers false: the version
    // is not there and cannot get there.
    expect(blockIsDischarged(QUOTA_REASON, ["20261122000000", "20261123000000"])).toBe(false);
  });

  it("retracts nothing that the clone itself refused", () => {
    // The evidence rule stays the ONLY route for a real block. A schema
    // rejection names no quota, so it keeps needing the ledger.
    expect(blockIsUpstreamRefusal(REAL_REASON)).toBe(false);
  });

  it("refuses an absent or empty reason", () => {
    for (const reason of [null, undefined, ""]) {
      expect(blockIsUpstreamRefusal(reason)).toBe(false);
    }
  });

  it("needs the limit NAMED, not merely a refusal", () => {
    // The same rule `isUpstreamRateLimit` states: a 403 alone is not enough,
    // because GitHub answers 403 for "you may not read this repository" too,
    // and retracting that would hide a permission fault behind a quota word.
    for (const reason of [
      "20261124000000_x.sql: 403 Forbidden",
      "20261124000000_x.sql: Resource not accessible by integration",
      "20261124000000_x.sql: rate limiting is configured on this installation",
      "20261124000000_x.sql: too many columns in the target table",
    ]) {
      expect(blockIsUpstreamRefusal(reason)).toBe(false);
    }
  });

  it("reads the phrase through the module that writes it, never a second copy", () => {
    // Two spellings of "is this a quota" is how the writer and the releaser
    // come to disagree about one string — so the eligibility module imports
    // the recognition rather than restating the regex.
    const pure = readFileSync("src/server/fleetMigrationEligibility.pure.ts", "utf8");
    expect(pure).toContain(
      'import { messageNamesUpstreamRateLimit } from "@/server/provisioningBudget"',
    );
    // Comment-stripped, because the module's header QUOTES the production
    // error text it exists to explain — and a test that fires on prose is one
    // that teaches the next person to delete the explanation. What must not
    // exist twice is the recognition, which is code.
    const code = stripComments(pure);
    // A plain substring, deliberately: a second spelling would be written as
    // `/\brate limit\b/`, and a word-boundary probe does not match that —
    // `\b` makes "brate" one word, so the assertion would miss precisely the
    // thing it is aimed at. Checked by planting one.
    expect(code, "the phrase must not be spelled twice").not.toMatch(/rate limit/i);
  });

  it("agrees with the error-object predicate on the same text", () => {
    // The block was written from a thrown error whose message is this string.
    // If these two ever disagree, a refusal recorded by one is unrecognisable
    // to the other, which is precisely the deadlock this closes.
    expect(isUpstreamRateLimit({ message: QUOTA_REASON })).toBe(
      blockIsUpstreamRefusal(QUOTA_REASON),
    );
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

  it("asks whether the block was ever this clone's BEFORE reading its ledger", () => {
    // Order is the whole point. `!ledger.ok` keeps the block, which is right
    // for a block the clone earned and wrong for one it never did — so a
    // transport failure must not be able to hold a quota refusal in place.
    const retraction = pass.indexOf("blockIsUpstreamRefusal(");
    const read = pass.indexOf("await readCloneMigrationLedger(");
    expect(retraction, "the sweep must test for an upstream refusal").toBeGreaterThan(-1);
    expect(read, "the sweep must still read the ledger for real blocks").toBeGreaterThan(-1);
    expect(retraction).toBeLessThan(read);
  });

  it("still requires the ledger for every block that is not a quota refusal", () => {
    // The narrow rule: retraction is gated on the signature, and everything
    // else falls through to the evidence test unchanged.
    expect(pass).toMatch(/if \(!upstreamRefusal\) \{/);
    expect(pass).toContain("blockIsDischarged(");
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

describe("the order the pass serves clones in", () => {
  const at = (version: string | null, statementsDone?: number, migrationId = "20261202000000") => ({
    migration_version: version,
    ...(statementsDone === undefined ? {} : { chunk_cursor: { migrationId, statementsDone } }),
  });

  it("puts the clone furthest behind first", () => {
    const order = orderMigrationQueue([at("20261204010000"), at("20261201100000"), at(null)]);
    expect(order.map((r) => r.migration_version)).toEqual([
      null,
      "20261201100000",
      "20261204010000",
    ]);
  });

  it("breaks a tie by least progress on the seed in flight", () => {
    // The measured fleet: three clones all recording 20261201100000, mid-way
    // through the same ~40 MB seed. Scan order was Preflight (39 statements),
    // NPC Client Dashboard (17), NPC Test (11) — and the leader led every pass.
    const order = orderMigrationQueue([
      at("20261201100000", 39),
      at("20261201100000", 17),
      at("20261201100000", 11),
    ]);
    expect(order.map((r) => r.chunk_cursor?.statementsDone)).toEqual([11, 17, 39]);
  });

  it("rotates: serving the laggard puts it behind its peers next pass", () => {
    // The property that makes this a queue rather than a different fixed
    // winner. 11 leads, advances past 17, and 17 leads next.
    const before = orderMigrationQueue([
      at("20261201100000", 39),
      at("20261201100000", 17),
      at("20261201100000", 11),
    ]);
    expect(before[0].chunk_cursor?.statementsDone).toBe(11);
    const after = orderMigrationQueue([
      at("20261201100000", 39),
      at("20261201100000", 17),
      at("20261201100000", 23),
    ]);
    expect(after[0].chunk_cursor?.statementsDone).toBe(17);
  });

  it("never lets progress outrank being further behind", () => {
    // A clone deep into a seed is still ahead of one that has not reached the
    // migration at all. Progress is a TIE-break and may not cross a frontier.
    const order = orderMigrationQueue([at("20261204010000", 0), at("20261201100000", 39)]);
    expect(order[0].migration_version).toBe("20261201100000");
  });

  it("treats a clone with no cursor as furthest behind, not as finished", () => {
    // Absent is never "done": a row with no cursor is one this lane has not
    // started, and the failure being closed is a clone never reached.
    const order = orderMigrationQueue([at("20261201100000", 4), at("20261201100000")]);
    expect(order[0].chunk_cursor).toBeUndefined();
  });

  it("reads a malformed cursor as no progress rather than trusting it", () => {
    // Through `chunkCursorFor`, so a negative, a float or a missing id cannot
    // become a position in the queue.
    for (const bad of [
      { migrationId: "20261202000000", statementsDone: -3 },
      { migrationId: "20261202000000", statementsDone: 1.5 },
      { statementsDone: 900 },
      "nonsense",
      null,
    ]) {
      expect(
        compareMigrationQueue(
          { migration_version: "x", chunk_cursor: bad },
          {
            migration_version: "x",
            chunk_cursor: { migrationId: "20261202000000", statementsDone: 1 },
          },
        ),
      ).toBeLessThan(0);
    }
  });

  /*
    THE THIRD AND FOURTH KEYS, AND THE CASE THE SECOND ONE CANNOT SEE.

    Two clones with no cursor both score zero on progress, the comparator
    returned 0, `Array#sort` is stable — and the order is the table's layout
    again. That is every clone that is NOT mid-seed, which after the seed lands
    is the whole fleet, and it bites whenever several migrations are owed and
    the budget runs out before the batch does: small migrations instead of one
    big seed, same clone never reached.
  */
  describe("and when neither is mid-seed", () => {
    const row = (id: string, version: string, heartbeat: string | null) => ({
      clone_id: id,
      migration_version: version,
      migration_heartbeat_at: heartbeat,
    });

    it("serves the one this lane claimed longest ago", () => {
      const order = orderMigrationQueue([
        row("recent", "20261201100000", "2026-09-19T18:30:00.000Z"),
        row("stale", "20261201100000", "2026-09-19T15:00:00.000Z"),
      ]);
      expect(order.map((r) => r.clone_id)).toEqual(["stale", "recent"]);
    });

    it("puts a clone this lane has NEVER held first", () => {
      const order = orderMigrationQueue([
        row("held", "20261201100000", "2026-09-19T15:00:00.000Z"),
        row("never", "20261201100000", null),
      ]);
      expect(order.map((r) => r.clone_id)).toEqual(["never", "held"]);
    });

    it("rotates, so no clone is last twice running", () => {
      // A budget that reaches exactly one clone a pass — the condition under
      // which "served last" and "never served" are the same thing.
      let rows = [
        row("a", "20261201100000", "2026-09-19T15:00:00.000Z"),
        row("b", "20261201100000", "2026-09-19T15:30:00.000Z"),
        row("c", "20261201100000", "2026-09-19T16:00:00.000Z"),
      ];
      const served: string[] = [];
      for (let pass = 0; pass < 6; pass += 1) {
        const first = orderMigrationQueue(rows)[0];
        served.push(first.clone_id);
        const stamp = `2026-09-19T17:0${pass}:00.000Z`;
        rows = rows.map((r) =>
          r.clone_id === first.clone_id ? { ...r, migration_heartbeat_at: stamp } : r,
        );
      }
      expect(served).toEqual(["a", "b", "c", "a", "b", "c"]);
    });

    it("never returns 0 for two DIFFERENT clones, whatever the other keys say", () => {
      // The property, rather than a case: a 0 is a decision handed to the
      // table's physical layout, and that is the defect this whole function
      // exists to close.
      const versions = ["20261201100000", "20261204010000"];
      const progress = [undefined, 0, 17];
      const beats = [null, "2026-09-19T15:00:00.000Z", "2026-09-19T18:00:00.000Z"];
      for (const av of versions)
        for (const bv of versions)
          for (const ap of progress)
            for (const bp of progress)
              for (const ah of beats)
                for (const bh of beats) {
                  const a = {
                    clone_id: "aaa",
                    migration_version: av,
                    migration_heartbeat_at: ah,
                    ...(ap === undefined
                      ? {}
                      : { chunk_cursor: { migrationId: "m", statementsDone: ap } }),
                  };
                  const b = {
                    clone_id: "bbb",
                    migration_version: bv,
                    migration_heartbeat_at: bh,
                    ...(bp === undefined
                      ? {}
                      : { chunk_cursor: { migrationId: "m", statementsDone: bp } }),
                  };
                  expect(compareMigrationQueue(a, b)).not.toBe(0);
                }
    });

    it("orders correctly for a caller that selects NEITHER new field", () => {
      // Both are optional, because the column arrived after the comparator did.
      // Such a caller must still get the first two keys, and must not throw.
      const order = orderMigrationQueue([
        { migration_version: "20261204010000" },
        { migration_version: "20261201100000" },
      ]);
      expect(order.map((r) => r.migration_version)).toEqual(["20261201100000", "20261204010000"]);
    });
  });

  it("does not mutate what it is given", () => {
    const rows = [at("20261201100000", 39), at("20261201100000", 11)];
    const copy = [...rows];
    orderMigrationQueue(rows);
    expect(rows).toEqual(copy);
  });

  it("is what the lane actually uses", () => {
    // The comparator is only worth testing if the pass calls it. This is the
    // class `builderPortalUiMounted.spec.ts` exists for: an unused export
    // typechecks, lints and builds.
    const lane = readFileSync("src/server/fleet-migration.server.ts", "utf8");
    expect(lane).toContain("orderMigrationQueue(");
    expect(lane).not.toMatch(/\.sort\(\(a, b\) => \{[\s\S]*?migration_version/);
  });
});
