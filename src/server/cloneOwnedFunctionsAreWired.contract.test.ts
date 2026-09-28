/**
 * A lane nothing calls is a lane that does not exist.
 *
 * `cloneOwnedFunctions.server.ts` deploys the functions a clone carries and
 * the prime does not. It has two callers that matter — provisioning, so a
 * clone created under the CRM-independent parent comes up with its `crm-*`
 * functions, and the half-hourly catch-up, so a change to them reaches the
 * project — and an unused export typechecks, lints and builds. So the wiring
 * is asserted as SOURCE, with comments removed so a sentence about a call
 * cannot stand in for the call.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { stripComments } from "@/server/sourceComments.pure";

const provisioning = stripComments(
  readFileSync("src/lib/backend-provisioning.functions.ts", "utf8"),
);
const catchup = stripComments(readFileSync("src/routes/hooks.backend-catchup.tsx", "utf8"));
const lane = stripComments(readFileSync("src/server/cloneOwnedFunctions.server.ts", "utf8"));

describe("provisioning deploys a clone's own functions", () => {
  it("calls the lane through its shim, onto the project it just made", () => {
    expect(provisioning).toContain('"@/lib/_server-shims/cloneOwnedFunctions.server"');
    const call = provisioning.slice(provisioning.indexOf("deployCloneOwnedFunctions({"));
    expect(call).toMatch(
      /^deployCloneOwnedFunctions\(\{[\s\S]{0,400}projectRef:\s*result\.projectRef/,
    );
  });

  it("after the repository is re-pointed, and before the backend is called ready", () => {
    // The tree the lane reads is the one the clone will build from, so it
    // follows the re-target; and a clone reported `ready` should already run
    // what its front end calls.
    const retarget = provisioning.indexOf("await retargetCloneRepo(");
    const owned = provisioning.indexOf("await deployCloneOwnedFunctions(");
    const ready = provisioning.indexOf('status: "ready" as const');
    expect(retarget).toBeGreaterThan(-1);
    expect(owned).toBeGreaterThan(retarget);
    expect(ready).toBeGreaterThan(owned);
  });

  it("never names the record's column in provisioning's own writes", () => {
    // The ready update discards its error. On a deployment the migration has
    // not reached, an unknown column there fails the whole write — the
    // backend never becomes `ready`. The lane writes its record itself,
    // separately, and checks the error.
    expect(provisioning).not.toContain("clone_owned_functions");
  });
});

describe("the catch-up keeps them current", () => {
  it("sweeps the fleet, behind the GitHub budget the rest of the catch-up spends", () => {
    const gate = catchup.indexOf("decideSpend(");
    const sweep = catchup.indexOf("sweepCloneOwnedFunctionsFromFleet(");
    expect(gate).toBeGreaterThan(-1);
    expect(sweep).toBeGreaterThan(gate);
    // Read after the refusal branch, not inside it.
    expect(catchup.indexOf("if (!spend.proceed)")).toBeLessThan(sweep);
  });
});

describe("what the lane will not do", () => {
  it("never deletes a function from a project", () => {
    expect(lane).not.toMatch(/method:\s*["']DELETE["']/);
    expect(lane).not.toMatch(/delete[A-Z]\w*Function/);
  });

  it("reads liveness from the reader that can say it could not read", () => {
    // `listProjectEdgeFunctionSlugs` answers `[]` on a failed read — right
    // for its callers, wrong for one that decides from it what is MISSING.
    expect(lane).toContain("readProjectEdgeFunctionSlugs(");
    expect(lane).not.toContain("listProjectEdgeFunctionSlugs(");
  });

  it("never reads the prime through the cached readers a clone read would evict", () => {
    // `readRepoFunctionTree` goes around the one-entry tree and blob caches;
    // the prime's declared list is the only prime read here.
    expect(lane).not.toContain("fetchPrimeBackendSnapshot(");
    expect(lane).toContain("readRepoFunctionTree(");
  });
});
