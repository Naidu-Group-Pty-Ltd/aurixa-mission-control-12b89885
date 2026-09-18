import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripNonCode } from "./heldFileStaleness.pure";
import { ACT_POLICY } from "./custodian.pure";
import { BLOCKAGE_POLICY, type BlockageClass } from "./blockageTaxonomy.pure";

/**
 * The custodian is the first thing in this design that writes. What it may not
 * do matters more than what it may, and most of that is a source-level
 * property — so it is asserted by source position rather than by reading the
 * code and trusting it.
 */
const custodian = stripNonCode(readFileSync("src/server/custodian.server.ts", "utf8"));
const pure = readFileSync("src/server/cascade/custodian.pure.ts", "utf8");
const hook = stripNonCode(readFileSync("src/routes/hooks.cascade-audit.tsx", "utf8"));

describe("it may re-run work; it may never change a verdict", () => {
  /*
    The refusals from CASCADE_PIPELINE_HEALTH.md §5, each one a thing that
    would turn a repair into a decision.
  */
  it("merges nothing, and cannot reach the gate that would let it", () => {
    for (const forbidden of [
      "pulls.merge",
      "decideCascadeMerge",
      "drainCascadeMerges",
      "repairConflictedProposal",
      "resolveConflictedProposal",
      "git.createRef",
      "git.updateRef",
      "git.createCommit",
      "git.createTree",
      "createBlob",
    ]) {
      expect(custodian.includes(forbidden), `the custodian must not reach ${forbidden}`).toBe(false);
    }
  });

  it("touches no exclusion policy, no approval and no cap", () => {
    for (const forbidden of [
      "clone_sync_exclusions",
      "cascade_path_approvals",
      "DEFAULT_MIRROR_EXCLUSIONS",
      "MAX_DELETIONS_PER_CASCADE",
      "CASCADE_MAX_FILE_BYTES",
      "MAX_REPAIRS",
    ]) {
      expect(custodian.includes(forbidden), `the custodian must not reach ${forbidden}`).toBe(false);
    }
  });

  it("queues no cascade and runs no engine", () => {
    for (const forbidden of [
      "createCascadeForAllClones",
      "executeCascade",
      "processClone",
      "approveCascade",
    ]) {
      expect(custodian.includes(forbidden), `the custodian must not reach ${forbidden}`).toBe(false);
    }
  });

  it("notifies nobody", () => {
    expect(custodian.includes("notifyOperators")).toBe(false);
    expect(/from\(\s*["']notifications["']\s*\)/.test(custodian)).toBe(false);
  });

  /*
    THE PERMISSION IS ASKED BEFORE ANYTHING IS READ.

    A blockage a person owns costs nothing and can never be halfway acted on,
    because the pass stops at the gate rather than after gathering evidence it
    would have to throw away.
  */
  it("asks the permission before it reads any evidence", () => {
    const gate = custodian.indexOf("mayCustodianAct(");
    expect(gate).toBeGreaterThan(-1);
    const firstRepoRead = custodian.indexOf("getAppOctokit(");
    const firstResultRead = custodian.indexOf('from("cascade_results")');
    expect(firstRepoRead, "octokit is reached before the permission gate").toBeGreaterThan(gate);
    expect(firstResultRead, "results are read before the permission gate").toBeGreaterThan(gate);
  });

  /*
    A custodian that closed what it had just repaired would make a repair that
    did not work look exactly like one that did. The ledger's next pass
    observes whether the condition is gone and clears it then.
  */
  it("never clears its own blockage", () => {
    expect(
      /from\(\s*["']clone_sync_blockages["']\s*\)[\s\S]{0,300}?\.update/.test(custodian),
      "the custodian must not write clone_sync_blockages",
    ).toBe(false);
    expect(custodian.includes("cleared_at:")).toBe(false);
  });

  it("writes exactly two tables: its own ledger, and the record it repairs", () => {
    const written = [
      ...custodian.matchAll(/from\(\s*["']([a-z_]+)["']\s*\)\s*\n?\s*\.(insert|update|upsert|delete)/g),
    ].map((m) => m[1]);
    expect([...new Set(written)].sort()).toEqual(["cascade_results", "clone_custodial_acts"]);
  });

  /*
    The one write it performs changes ONE column. A repair that could touch
    anything else on a cascade result would be rewriting the record rather than
    repairing the pointer into it.
  */
  it("the repair rewrites one column and never a status", () => {
    const update = /from\(\s*["']cascade_results["']\s*\)\s*\n?\s*\.update\(([\s\S]{0,160}?)\)/.exec(
      custodian,
    );
    expect(update, "no cascade_results update found").not.toBeNull();
    const payload = update![1];
    expect(payload).toContain("pr_url");
    for (const forbidden of ["status", "diff_summary", "commit_sha", "delivered_sha", "completed_at"]) {
      expect(payload.includes(forbidden), `the repair must not write ${forbidden}`).toBe(false);
    }
  });

  /*
    A repair that cannot be checked is a guess with a commit message, and a row
    something else has moved since the decision belongs to whatever moved it.
  */
  it("reads the proposal back before writing, and writes against the value it decided on", () => {
    expect(custodian).toContain("octokit.pulls.get(");
    expect(custodian).toContain('.eq("pr_url", m.from)');
    expect(custodian.indexOf("octokit.pulls.get(")).toBeLessThan(
      custodian.indexOf('.eq("pr_url", m.from)'),
    );
  });

  it("records the means to reverse whatever it wrote", () => {
    expect(custodian).toContain("reversal");
    expect(custodian).toContain("before:");
    expect(custodian).toContain("after:");
  });

  /*
    A custodian whose refusals were silent would be indistinguishable from one
    that was not running — this programme's oldest lesson wearing an automation
    badge.
  */
  it("records the acts it does not take", () => {
    expect(custodian).toContain('outcome: "refused"');
    expect(custodian).toContain('outcome: "would_perform"');
    expect(custodian).toContain('outcome: "failed"');
  });

  it("fails closed on a cap it cannot read", () => {
    expect(custodian).toContain("if (error) return MAX_PERFORMED_PER_DAY");
  });
});

describe("the permission lives in one file, and it is the taxonomy's", () => {
  it("every act is declared for a class the taxonomy calls machinery", () => {
    for (const [cls, policy] of Object.entries(ACT_POLICY)) {
      if (policy.kind !== "act") continue;
      const declared = BLOCKAGE_POLICY[cls as BlockageClass];
      expect(declared.owner, `${cls} declares an act`).toBe("machinery");
      expect(declared.selfHeals, `${cls} declares an act`).toBe(true);
    }
  });

  it("the custodian carries no list of its own", () => {
    /* The owner is read from the row and checked against the taxonomy; a
       hard-coded class list here would be a second source of the permission. */
    expect(custodian.includes('"ci_red"')).toBe(false);
    expect(custodian.includes('"prime_author"')).toBe(false);
    expect(pure).toContain('from "./blockageTaxonomy.pure"');
  });

  /*
    Step 5 ships the catalogue reporting; step 6 enables one act. Both halves
    of that are visible here, so enabling a second one is a deliberate edit
    against a test that counts them.
  */
  it("exactly one act is switched on", () => {
    const enabled = Object.entries(ACT_POLICY).filter(([, p]) => p.kind === "act" && p.enabled);
    expect(enabled.map(([cls]) => cls)).toEqual(["repo_retargeted"]);
  });

  it("an enabled act with no implementation is reported, never silently skipped", () => {
    expect(custodian).toContain("has no implementation in this build");
  });
});

describe("the tick", () => {
  it("runs the custodian after the ledger it reads", () => {
    const ledger = hook.indexOf("reconcileBlockageLedger");
    const cust = hook.indexOf("runCustodian");
    expect(ledger).toBeGreaterThan(-1);
    expect(cust).toBeGreaterThan(ledger);
  });

  it("does not run the custodian on a ledger that did not complete", () => {
    expect(hook).toContain('"error" in blockages');
    expect(hook).toContain("the blockage ledger did not complete");
  });

  it("yields below the scan floor rather than the cascade's", () => {
    expect(hook).toContain('role: "scan"');
  });
});
