import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripNonCode } from "./heldFileStaleness.pure";
import { BLOCKAGE_POLICY } from "./blockageTaxonomy.pure";

/**
 * The ledger classifies the record. It must not be able to edit it.
 *
 * A classifier that could write `cascade_events` or `cascade_results` would be
 * describing its own writes back to itself, and the auditor beside it exists
 * precisely because a reading derived from the thing it measures is worth
 * nothing. Asserted by source position rather than by reading the code and
 * trusting it — the same thing `dryRunBoundary.test.ts` does for the
 * rehearsal, for the same reason.
 */
const ledger = stripNonCode(readFileSync("src/server/blockageLedger.server.ts", "utf8"));
const hook = stripNonCode(readFileSync("src/routes/hooks.cascade-audit.tsx", "utf8"));
const taxonomy = readFileSync("src/server/cascade/blockageTaxonomy.pure.ts", "utf8");

const CLASSIFIED_TABLES = [
  "cascade_events",
  "cascade_results",
  "clones",
  "notifications",
  "clone_sync_exclusions",
  "clone_convergence_observations",
];
const MUTATORS = [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("];

describe("the ledger writes nothing it classifies", () => {
  it("names no classified table beside a mutator", () => {
    for (const table of CLASSIFIED_TABLES) {
      for (const mutator of MUTATORS) {
        const pattern = new RegExp(
          `from\\(\\s*["']${table}["']\\s*\\)[\\s\\S]{0,240}?\\${mutator.replace(/[.()]/g, "\\$&")}`,
        );
        expect(pattern.test(ledger), `the ledger must never ${mutator} on ${table}`).toBe(false);
      }
    }
  });

  it("writes to exactly one table, its own", () => {
    const written = [
      ...ledger.matchAll(
        /from\(\s*["']([a-z_]+)["']\s*\)\s*\n?\s*\.(insert|update|upsert|delete)/g,
      ),
    ].map((m) => m[1]);
    expect([...new Set(written)]).toEqual(["clone_sync_blockages"]);
  });

  it("requests no cascade, merges nothing and touches no repository", () => {
    for (const forbidden of [
      "createCascadeForAllClones",
      "executeCascade",
      "processClone",
      "drainCascadeMerges",
      "getAppOctokit",
      "listTreeEntries",
      "octokit",
      "pulls.merge",
    ]) {
      expect(ledger.includes(forbidden), `the ledger must not reach ${forbidden}`).toBe(false);
    }
  });

  /*
    Step 2 populates the taxonomy from real passes so the classification can be
    checked against what actually happens before it is allowed to speak. The
    escalation reads this table and ships separately.
  */
  it("notifies nobody yet", () => {
    for (const source of [ledger, hook]) {
      expect(source.includes("notifyOperators")).toBe(false);
    }
    /* The hook may READ blocked notices through the ledger, never write one. */
    expect(/from\(\s*["']notifications["']\s*\)\s*\n?\s*\.insert/.test(ledger)).toBe(false);
  });

  it("spends no GitHub budget — it reads Mission Control's own tables", () => {
    expect(ledger.includes("decideSpend")).toBe(false);
    expect(ledger.includes("readGitHubRemaining")).toBe(false);
  });

  /*
    An open set that could not be READ is not an empty one: acting on that
    would clear every standing blockage on the fleet, or open a duplicate of
    each one on every pass.
  */
  it("fails closed on every list it reads", () => {
    for (const guard of [
      "Could not list clones",
      "Could not read open blockages",
      "Could not read cascade results",
      "Could not read exclusion policies",
    ]) {
      expect(ledger, `missing fail-closed guard: ${guard}`).toContain(guard);
    }
  });

  /*
    A blockage records that a condition existed. Destroying that record is how
    the second occurrence looks like the first — `decideDriftReport`'s rule,
    which is why a returning gap is audible again.
  */
  it("clears rather than deletes", () => {
    expect(ledger).toContain("cleared_at: nowIso");
    expect(/from\(\s*["']clone_sync_blockages["']\s*\)\s*\n?\s*\.delete/.test(ledger)).toBe(false);
  });
});

describe("the taxonomy is the custodian's permission, and it is one list", () => {
  /*
    `owner` and `self_heals` travel to the database on every row precisely so
    an act taken later can be audited against what was true when it was taken.
    The custodian in step 3 reads them; it must never carry its own list.
  */
  it("ci_red can never be made self-healing by an edit here", () => {
    expect(BLOCKAGE_POLICY.ci_red.selfHeals).toBe(false);
    /* And the source says why, so the next reader does not have to guess. */
    expect(taxonomy).toContain("THE ONE THAT MUST NEVER BE HEALED");
  });

  it("carries the owner and the self-heals flag onto every row it opens", () => {
    expect(ledger).toContain("owner: d.owner");
    expect(ledger).toContain("self_heals: d.selfHeals");
  });

  /*
    The drain's ceilings have one home. Two answers to "is this event
    exhausted?" is how the classifier comes to describe a fleet that is not the
    one running — the `globToRegex` lesson, applied again.
  */
  it("reads the drain's own limits rather than restating them", () => {
    expect(taxonomy).toContain('from "./drainLimits.pure"');
    expect(/MAX_ATTEMPTS\s*=\s*\d/.test(taxonomy)).toBe(false);
    expect(/STALL_MINUTES\s*=\s*\d/.test(taxonomy)).toBe(false);
  });
});
