/**
 * The half-hourly sweep records who wrote each clone's ledger rows.
 *
 * Structural, reading the source, in the pattern of
 * `fleetPassIsBudgeted.contract.test.ts`: what this file is about is WHERE a
 * call sits in the pass (after the replays, on a sweep, under the budget) and
 * that its failure is caught, and a Supabase double would agree with wrong
 * code on all four.
 *
 * ## What was measured
 *
 * `recordKnownProvenance` labels a canonical row that carries a body and has
 * no legacy row `external` (#379). Its only caller was the remediation lane's
 * `executeSqlMigration`, and the backend catch-up sweep retires every
 * `sql_migration` run: none was created after 23 Sep 2026. Measured 28 Oct
 * 2026, after #379 was published, the CRM's provenance table held 146
 * `applied` rows and 15 `asserted` rows from 19 Sep, and none of its 5
 * body-carrying versions had a row. The label had shipped with nothing to
 * write it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./sourceComments.pure";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const lane = stripComments(read("src/server/fleet-migration.server.ts"));

const entry = lane.indexOf("export async function runFleetMigrationSync");
const laneBody = lane.slice(entry);
const replay = laneBody.indexOf("await applyPrimeMigrations(");
const audit = laneBody.indexOf("await writeAuditLog({");
const call = laneBody.indexOf("await recordKnownProvenance(");

describe("the slices this file reads exist", () => {
  it("finds the lane, its replay, the backfill and the audit row", () => {
    // A slice from -1 is the whole file and every assertion below would pass
    // over it.
    expect(entry).toBeGreaterThan(-1);
    expect(replay).toBeGreaterThan(-1);
    expect(audit).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
  });
});

describe("the sweep records provenance", () => {
  it("imports the one backfill rather than restating it", () => {
    expect(lane).toMatch(
      /import \{ recordKnownProvenance \} from "\.\/migrationProvenance\.server";/,
    );
  });

  it("runs it after every replay of the pass and before the pass's audit row", () => {
    // After the LAST heartbeat stop, which closes the clone loop, so the
    // annotation never spends time a replay needed.
    const loopClosed = laneBody.lastIndexOf("await heartbeat.stop();", call);
    expect(loopClosed).toBeGreaterThan(replay);
    expect(call).toBeGreaterThan(loopClosed);
    expect(call).toBeLessThan(audit);
  });

  it("runs it on a sweep only, never on a drain tick", () => {
    const gate = laneBody.lastIndexOf('if (mode === "sweep") {', call);
    expect(gate).toBeGreaterThan(laneBody.lastIndexOf("await heartbeat.stop();", call));
  });

  it("reaches a clone only while the pass keeps its claim reserve, and says when it stopped", () => {
    const gate = laneBody.lastIndexOf('if (mode === "sweep") {', call);
    const between = laneBody.slice(gate, call);
    expect(between).toContain("if (Date.now() + CLAIM_RESERVE_MS >= deadlineAt) {");
    expect(between).toContain("out.provenanceStoppedAtBudget = true;");
  });

  it("never lets the backfill fail the pass", () => {
    const tail = laneBody.slice(call, audit);
    expect(tail).toMatch(/catch \(e\) \{\s*out\.provenance\.push\(\{ cloneName, error:/);
    // And a backfill that answered `ok: false` is reported, not dropped.
    expect(tail).toContain("{ cloneName, error: r.error }");
  });

  it("puts what it recorded, and where the budget stopped it, on the audit row", () => {
    const row = laneBody.slice(audit);
    expect(row).toContain("provenance: out.provenance.map(");
    expect(row).toContain("provenance_stopped_at_budget: out.provenanceStoppedAtBudget,");
  });
});
