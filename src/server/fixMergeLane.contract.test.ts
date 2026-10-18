/**
 * The pr_merge lane: how an unattended security fix reaches Prime's `main`.
 *
 * Fixes merge with no person reading them (remediation-policy.ts), so the
 * order of the lane's checks is the safety argument, and it is asserted
 * against the source in the pattern of `drainTickClock.contract.test.ts`:
 *
 *   1. the PR is still this fix's own branch, on the commit that was checked;
 *   2. the patch is verified, secret-free and within the size bounds;
 *   3. the repository's CI — started by this lane, since a PR opened with the
 *      workflow's token starts none — has passed on that commit
 *      (fixCiGate.pure.ts decides; fixCiGate.pure.test.ts tests it). For a
 *      fix an admin released as well: Prime's default branch requires these
 *      checks and Mission Control's App is not on the bypass list
 *      (primeBranchProtection.pure.ts), so GitHub refuses the merge without
 *      them either way;
 *   4. only then the merge, pinned to that commit.
 *
 * Waiting for the CI costs no attempt: the gate bounds the wait itself.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./sourceComments.pure";

const healing = stripComments(
  readFileSync(join(process.cwd(), "src/server/self-healing.server.ts"), "utf8"),
);
const lane = healing.slice(
  healing.indexOf("async function executePrMerge"),
  healing.indexOf("async function executeSqlMigration"),
);
/** The checks only an unattended merge passes: from their `if` to the CI gate that follows them. */
const unattended = lane.slice(
  lane.indexOf("if (!approvedByHuman) {"),
  lane.indexOf("const mergeHead ="),
);
const at = (needle: string) => {
  const i = lane.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

describe("the fix merge lane", () => {
  it("is found", () => {
    expect(lane.length).toBeGreaterThan(2000);
  });

  it("checks the branch, the patch, then the CI, and merges last", () => {
    const mismatch = at("remediationPrMismatch(pr");
    const headPinned = at("pr.headSha !== verifiedHead");
    const patch = at("decideFixMerge({");
    const ci = at("decideFixCi({");
    const merge = at("mergeRemediationPRViaGitHub({");
    expect(mismatch).toBeLessThan(headPinned);
    expect(headPinned).toBeLessThan(patch);
    expect(patch).toBeLessThan(ci);
    expect(ci).toBeLessThan(merge);
  });

  it("applies the CI gate whoever released the fix", () => {
    // After the unattended-only checks close, not inside them.
    expect(unattended).toContain("decideFixMerge({");
    expect(unattended.trimEnd().endsWith("}")).toBe(true);
    expect(unattended).not.toContain("decideFixCi({");
    expect(at("decideFixCi({")).toBeGreaterThan(at("const mergeHead ="));
    expect(lane).toContain("fixCiSpec(rem.verification)");
  });

  it("reads the CI on the commit about to merge and starts it on the fix's own branch", () => {
    // The verified commit when unattended; the PR's head as it is when an
    // admin released it.
    expect(lane).toContain(
      "const mergeHead = approvedByHuman ? pr.headSha : (verifiedHead ?? pr.headSha);",
    );
    expect(lane).toContain("const head = mergeHead;");
    expect(lane).toMatch(/listFixCiRuns\(\{ owner, repo, headSha: head, installationId \}\)/);
    expect(lane).toMatch(/dispatchFixCi\(\{[^}]*ref: pr\.headRef/);
  });

  it("merges pinned to the commit that was checked, released by a person or not", () => {
    expect(lane).toContain("expectedHeadSha: mergeHead,");
  });

  it("closes a fix whose CI refused, and deletes the branch only at the checked commit", () => {
    expect(lane).toMatch(
      /verdict\.kind === "refuse"\) return declineFix\(run, rem, target, \[verdict\.why\], head\)/,
    );
    const decline = healing.slice(
      healing.indexOf("async function declineFix"),
      healing.indexOf("async function waitForFixCi"),
    );
    expect(decline).toContain("headSha: verifiedHead");
  });

  it("waits for the CI without spending an attempt", () => {
    const wait = healing.slice(
      healing.indexOf("async function waitForFixCi"),
      healing.indexOf("async function executePrMerge"),
    );
    // A fix an admin released stays released while it waits.
    expect(wait).toContain('status: run.status === "approved" ? "approved" : "planned"');
    expect(wait).toContain("attempts: run.attempts ?? 0");
    expect(wait).toContain("next_attempt_at:");
  });
});
