/**
 * Every question asked of a clone's ledger is asked through the prime's
 * holdings, on every path.
 *
 * Structural — it reads the server sources — because the defect cannot be seen
 * from the types: `primeHoldings` is optional on the replay's scope, which is
 * what lets the provisioning replay (unscoped) and a pass with no corpus read
 * keep the version rule alone. So a caller that forgets it typechecks, lints,
 * builds, and asks a stamped clone for versions it was never given — which is
 * how the demo clone was sent 594 migrations it already held, and blocked on
 * the first (`primeHoldings.pure.ts`, 30 Oct 2026).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./sourceComments.pure";

const read = (p: string) =>
  stripComments(readFileSync(join(process.cwd(), "src/server", p), "utf8"));

/** The files that hand a replay a scope, as `dependencyFactsReachThePartition` lists them. */
const SCOPED = [
  "fleet-migration.server.ts",
  "self-healing.server.ts",
  "migration-sync.functions.ts",
];

describe("the prime's holdings reach every scoped replay", () => {
  it("every scope handed to a replay carries the holdings", () => {
    let scopes = 0;
    for (const f of SCOPED) {
      const src = read(f);
      for (const s of src.matchAll(/\{\s*corpus:\s*[A-Za-z_$][\w$.]*\s*,\s*runnableIds[^}]*\}/g)) {
        scopes += 1;
        expect(s[0], `${f} scopes a replay without the prime's holdings`).toMatch(
          /primeHoldings:\s*scoped\.primeHoldings/,
        );
      }
    }
    // Not vacuous: the fleet sync, the self-healing lane and the sync button.
    expect(scopes).toBeGreaterThanOrEqual(3);
  });

  it("the replay decides every send from the clone's versions WITH the holdings", () => {
    const src = read("backend-provisioning.server.ts");
    const fn = src.slice(src.indexOf("export async function applyPrimeMigrations"));
    const applied = fn.indexOf("const applied = withVersionsHeldThroughPrime(");
    expect(applied).toBeGreaterThan(-1);
    expect(fn.slice(applied, applied + 200)).toMatch(/scope\?\.primeHoldings/);
    // Before the pre-flight and the partition read it.
    expect(applied).toBeLessThan(fn.indexOf("assessLedgerState("));
    expect(applied).toBeLessThan(fn.indexOf("partitionByDependency("));
  });

  it("the self-healing lane counts what is pending the way its replay will", () => {
    const src = read("self-healing.server.ts");
    const union = src.indexOf(
      "applied = withVersionsHeldThroughPrime(applied, scopedMetas, scoped.primeHoldings)",
    );
    expect(union).toBeGreaterThan(-1);
    expect(union).toBeLessThan(
      src.indexOf("partitionByDependency(scopedMetas, runnableIds, applied)"),
    );
  });

  it("the clone page counts what is pending the way the button will send it", () => {
    const src = read("migration-sync.functions.ts");
    const standing = src.slice(src.indexOf("readCloneMigrationStanding({"));
    expect(standing.slice(0, standing.indexOf("});"))).toMatch(
      /heldThroughPrime:[\s\S]*versionsHeldThroughPrime\(\{[\s\S]*holdings: scoped\.primeHoldings/,
    );
  });

  it("holdings are derived from every file's digests, not only the ones attached to the scope", () => {
    const src = read("fleet-migration.server.ts");
    const fn = src.slice(src.indexOf("export async function openScopedPrimeCorpus"));
    expect(fn).toMatch(
      /primeHoldingsOf\(\{\s*files: corpus\.metas\.map\(\(m\) => \(\{ id: m\.id, name: m\.name, digests: digested\.get\(m\.path\) \}\)\)/,
    );
  });
});

describe("a block on a stamped clone can be discharged", () => {
  it("the sweep tests the block against the holdings before the order, and the order against the same set", () => {
    const src = read("fleet-migration.server.ts");
    const held = src.indexOf("const held = withVersionsHeldThroughPrime(");
    const sequence = src.indexOf("blockOvertakenBySequence({");
    expect(held).toBeGreaterThan(-1);
    expect(held).toBeLessThan(sequence);
    expect(src.slice(held, sequence)).toMatch(
      /blockIsDischarged\(v\.row\.migration_blocked_reason, \[\.\.\.held\]\)/,
    );
    expect(src.slice(sequence, sequence + 300)).toMatch(/cloneApplied: held/);
  });
});
