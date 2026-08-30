import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The engine's first spend was the one thing preflight never checked.
 *
 * The first autonomous run of the signed-agreement pipeline (30 Aug 2026, the
 * pre-test-flight dry run) cleared every guard preflight owns — six
 * credentials present, prime config resolvable, module catalogue populated,
 * the GitHub App branch probe green — and then died on its very first
 * creation call: `createUsingTemplate` answered **404**, because the prime
 * repository did not carry the template FLAG. The flag is a Settings
 * checkbox, not a property of the repository's contents, so nothing about a
 * healthy prime implies it; and GitHub reports the missing flag as "Not
 * Found" rather than anything that names the cause.
 *
 * Preflight exists precisely so an autonomous signature event refuses with a
 * named reason instead of burning a half-configured engine, so the template
 * flag belongs to it. These are source-level pins, in the repo's own style:
 * the rule is WHERE the check lives and WHAT the refusal says, not the
 * strings.
 */
const src = readFileSync("src/server/agreement-provisioning.server.ts", "utf8");

function sliceOf(fnName: string): string {
  const at = src.indexOf(`export async function ${fnName}`);
  expect(at, `${fnName} must exist`).toBeGreaterThan(-1);
  const next = src.indexOf("\nasync function", at + 1);
  const end = next === -1 ? src.length : next;
  return src.slice(at, end);
}

describe("preflight owns the template flag", () => {
  const preflight = sliceOf("assessProvisioningPreflight");

  it("reads the flag inside assessProvisioningPreflight, before anything is spent", () => {
    expect(preflight).toContain("is_template");
    expect(preflight).toContain("repos.get({");
  });

  it("repairs a missing flag itself rather than reporting it", () => {
    /* The App holds admin on the prime, and the flag is idempotent metadata.
       A preflight that could fix the one-checkbox misconfiguration and
       instead told a person to click it would be manufacturing operator
       work — the same shape as the portrait-backfill lesson in the prime. */
    expect(preflight).toContain("repos.update({");
    expect(preflight).toMatch(/is_template:\s*true/);
  });

  it("refuses with the one-checkbox remedy when the write is refused", () => {
    expect(preflight).toContain('tick "Template repository"');
  });

  it("knows fork is not a fallback for same-org provisioning", () => {
    /* GitHub will not fork a repository into the organisation that owns it,
       so for a clone born beside its prime the template path is the only
       path — the comment must keep saying so, because "just fall back to
       fork" is the obvious wrong fix. */
    expect(preflight).toMatch(/fork method is not[\s\S]{0,20}a fallback/i);
  });

  it("runs its probes only after the cheap checks passed", () => {
    const cheap = preflight.indexOf("is not configured");
    const probe = preflight.indexOf("repos.getBranch");
    const flag = preflight.indexOf("repos.get({");
    expect(cheap).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(cheap);
    expect(flag).toBeGreaterThan(probe);
  });
});

describe("the agreement path still provisions by template, under preflight", () => {
  it("provisionCloneCore is called with method template, after assessProvisioningPreflight", () => {
    const run = src.slice(src.indexOf("async function runProvisioning"));
    const preflightAt = run.indexOf("assessProvisioningPreflight()");
    const coreAt = run.indexOf("provisionCloneCore");
    const methodAt = run.indexOf('method: "template"');
    expect(preflightAt).toBeGreaterThan(-1);
    expect(coreAt).toBeGreaterThan(preflightAt);
    expect(methodAt).toBeGreaterThan(preflightAt);
  });
});
