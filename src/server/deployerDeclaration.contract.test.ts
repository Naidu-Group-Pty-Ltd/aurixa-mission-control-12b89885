/**
 * The declaration is asserted by its EFFECT and its failure is never dropped.
 *
 * Structural, so asserted against the source: a double would agree with wrong
 * code, and what went wrong here was not logic but a discarded return value.
 *
 * The CARD's side of the declaration moved: it is standing state now, kept
 * true by `clone-deployer-declaration-reconcile` rather than offered as an
 * act, and `cloneDeployerDeclaration.contract.test.ts` owns those properties.
 * What remains here is the write itself and the paths that must not swallow
 * its failure.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const vars = stripComments(read("src/server/github-variables.server.ts"));
const sync = stripComments(read("src/server/backendSync.server.ts"));
const card = stripComments(read("src/components/clone-backend-deploy-card.tsx"));

const declare = vars.slice(
  vars.indexOf("export async function declareMissionControlDeploysBackend"),
);

describe("the write is asserted by its effect", () => {
  it("reads the variable back before reporting success", () => {
    /*
      Measured 2 Sep 2026: the declaration was made, threw nothing, and the
      variable was still absent — every one of that repository's 31 deploy
      runs failed for want of it. A write that returned is not a variable the
      workflow can read. Same rule this repo already writes down about the
      Airtable purge: asserted by its effect, never by its configuration.
    */
    const readBack = declare.indexOf("listRepoVariables(input)");
    const success = declare.indexOf("return { ok: true }");
    expect(readBack).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(-1);
    expect(readBack).toBeLessThan(success);
  });

  it("treats an unreadable read-back as failure, not success", () => {
    // "We wrote it and cannot confirm" is not "it is set". The deploy check
    // is the thing that finds out, and it finds out by going red.
    expect(declare).toMatch(/if \(seen === null\)[\s\S]{0,200}ok: false/);
  });

  it("fails when the variable is absent afterwards despite a clean write", () => {
    expect(declare).toMatch(
      /seen\[BACKEND_DEPLOYER_VARIABLE\] !== BACKEND_DEPLOYER_MISSION_CONTROL/,
    );
  });
});

describe("the failure is never dropped", () => {
  it("the cascade path keeps the declaration result", () => {
    // It was `await declareDeployer(...)` with the value discarded, so a
    // fleet-wide permission gap looked exactly like nothing happening.
    expect(sync).toMatch(/const deployer = await declareDeployer\(input\.cloneId\)/);
    expect(sync).toMatch(/return \{ requested: true,[^}]*deployer[^}]*\}/);
  });

  it("declareDeployer reports rather than swallowing", () => {
    const fn = sync.slice(sync.indexOf("async function declareDeployer"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/return \{ attempted: true, ok: false, error/);
    expect(body).toMatch(/return \{ attempted: true, ok: true/);
  });

  it("distinguishes 'nothing to declare on' from a failure to fix", () => {
    // A clone with no repository recorded is not a permission problem and
    // must not be reported as one.
    const fn = sync.slice(sync.indexOf("async function declareDeployer"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/attempted: false/);
  });
});

describe("reading a permission is not the same as being denied one", () => {
  it("the permission read answers null on failure", () => {
    const fn = vars.slice(vars.indexOf("export async function readInstallationPermissions"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/catch[\s\S]{0,120}return null/);
  });
});

describe("a stalled or failing run says why", () => {
  const deploy = stripComments(read("src/server/cloneBackendDeploy.server.ts"));

  it("last_error reaches the card instead of being read and dropped", () => {
    /*
      The column was in the select and never in the projection, so a run stuck
      in `executing` showed a status and nothing else — which is exactly what
      made the first live edge-function deploy undiagnosable without database
      access.
    */
    expect(deploy).toMatch(/lastError: typeof row\.last_error/);
    expect(card).toContain("run.lastError");
  });

  it("a resumable run's progress is visible", () => {
    // `executing` with 0 of 423 done and `executing` with 360 done are the
    // same word and different situations.
    expect(deploy).toContain("describeProgress(result)");
    expect(card).toContain("run.progress");
  });

  it("reports no progress rather than a fabricated zero", () => {
    // An empty result is the ordinary state for a pass that has not finished
    // its first batch; "0 deployed" would read as failure instead of not-yet.
    const fn = deploy.slice(deploy.indexOf("function describeProgress"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toMatch(/deployed === null\) return null/);
  });
});
