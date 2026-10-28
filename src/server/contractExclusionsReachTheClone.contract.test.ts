/**
 * A contract's exclusions are on the clone before anything reconciles it, and
 * they reach the clone (D18).
 *
 * Measured 27 Oct 2026: the agreement path wrote
 * `clones.contract_excluded_module_slugs` only after `provisionCloneCore`
 * returned, so the reconcile inside it had already installed the excluded
 * modules; the second reconcile only recorded them as revoked. And the balance
 * response, the one answer a clone gates on, carried no exclusions at all.
 *
 * Asserted on the source with comments stripped, as provisioning's other
 * contracts are. There is no run to observe: the one agreement that has
 * provisioned a clone did so on 30 Aug 2026, and no clone has been created
 * since 19 Sep 2026 (measured 28 Oct 2026).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./sourceComments.pure";

const read = (path: string) => stripComments(readFileSync(path, "utf8"));
const core = read("src/server/clone-provisioning.server.ts");
const wizard = read("src/server/clone-provisioning.functions.ts");
const agreement = read("src/server/agreement-provisioning.server.ts");
const reconcile = read("src/server/entitlement-modules.server.ts");
const balance = read("src/routes/api.public.tokens.balance.ts");

describe("provisionCloneCore", () => {
  const insertAt = core.indexOf('.from("clones")\n    .insert({');
  const insert = core.slice(insertAt, core.indexOf(".select()", insertAt));

  it("writes the exclusions in the clone's own INSERT, ahead of the reconcile it runs", () => {
    expect(insertAt).toBeGreaterThan(-1);
    const field = insert.search(
      /contract_excluded_module_slugs: sortedUniqueSlugs\(data\.contractExcludedSlugs \?\? \[\]\)/,
    );
    expect(field).toBeGreaterThan(-1);
    expect(core.indexOf("reconcileCloneEntitlements({")).toBeGreaterThan(insertAt + field);
  });

  it("an idempotent retry records the request's exclusions before anything else", () => {
    const branch = core.slice(core.indexOf("if (existing) {"));
    const settleAt = branch.indexOf("await settleRetriedClone(supabase, existing, data);");
    expect(settleAt).toBeGreaterThan(-1);
    expect(branch.indexOf("await startRequestedSideEffects(")).toBeGreaterThan(settleAt);
    // A failed write fails the retry rather than reconciling the old exclusions.
    expect(branch.slice(settleAt, settleAt + 200)).toMatch(/if \(!settled\.ok\) return settled;/);

    // …and settling records them first, returning on failure.
    const settle = core.slice(core.indexOf("async function settleRetriedClone("));
    const recordAt = settle.indexOf("await recordContractExclusions(supabase, clone.id, data);");
    expect(recordAt).toBeGreaterThan(-1);
    expect(settle.slice(recordAt, recordAt + 120)).toMatch(/if \(!excluded\.ok\) return excluded;/);
  });

  it("and leaves a clone alone when the request names no exclusions (the wizard)", () => {
    const fn = core.slice(core.indexOf("async function recordContractExclusions("));
    expect(fn).toMatch(/if \(data\.contractExcludedSlugs === undefined\) return \{ ok: true \};/);
    expect(fn).toMatch(/\.update\(\{ contract_excluded_module_slugs: sortedUniqueSlugs\(/);
  });
});

describe("the agreement path", () => {
  it("hands the agreement's slugs to provisionCloneCore", () => {
    expect(agreement).toMatch(/const excludedSlugs = agreement\.excluded_module_slugs \?\? \[\];/);
    const call = agreement.slice(agreement.indexOf("await provisionCloneCore("));
    expect(call.slice(0, 1200)).toMatch(/contractExcludedSlugs: excludedSlugs,/);
  });

  it("no longer writes the clone's exclusions after the fact", () => {
    expect(agreement).not.toMatch(/contract_excluded_module_slugs/);
  });

  it("drops the picks the exclusions map to before the clone is created", () => {
    const dropAt = agreement.indexOf("effectiveModuleIds(moduleIds, excludedSlugs, {");
    expect(dropAt).toBeGreaterThan(-1);
    expect(agreement.indexOf("await provisionCloneCore(")).toBeGreaterThan(dropAt);
  });
});

describe("the wizard's door into the same pipeline", () => {
  it("holds a list sent to it to the agreement's rule", () => {
    const validator = wizard.slice(wizard.indexOf(".inputValidator("), wizard.indexOf(".handler("));
    expect(validator).toMatch(
      /validateContractExclusions\(slugs, \{ addonSlugs: input\.addonSlugs \?\? \[\] \}\)/,
    );
    expect(validator).toMatch(/if \(!checked\.ok\) throw new Error\(checked\.error\);/);
  });
});

describe("the reconcile", () => {
  it("translates the clone's slugs through the catalogue and overrides it resolves the plan with", () => {
    expect(reconcile).toMatch(
      /applyContractExclusions\(\s*resolveEntitledModules\(\{[\s\S]*?knownModules,\s*overrides,\s*\}\),\s*\(clone\.contract_excluded_module_slugs as string\[\] \| null\) \?\? \[\],\s*\{ knownModules, overrides \},\s*\)/,
    );
  });
});

describe("the balance response", () => {
  it("reads the clone's exclusions", () => {
    expect(balance).toMatch(
      /\.from\("clones"\)\s*\.select\("contract_excluded_module_slugs"\)\s*\.eq\("id", cloneId\)/,
    );
  });

  it("answers a key with no clone with no exclusions, not with a read", () => {
    expect(balance).toMatch(
      /const contractExcluded = addonCloneId \? await readContractExclusions\(addonCloneId\) : \[\];/,
    );
  });

  it("sends the helper's entitlements, never a hand-built list", () => {
    expect(balance).toMatch(/const entitlements = balanceEntitlements\(\{/);
    expect(balance).toMatch(/\n\s*entitlements,\n/);
    expect(balance).not.toMatch(/entitlements: \{/);
  });
});

describe("the superseded column", () => {
  it("is read nowhere: only the save that empties it and the generated types name it", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(full);
      }
    };
    walk("src");
    const naming = files
      .filter((f) => /excluded_module_ids/.test(read(f)))
      .map((f) => f.replace(/\\/g, "/"))
      .sort();
    expect(naming).toEqual([
      "src/integrations/supabase/types.ts",
      "src/lib/agreements.functions.ts",
    ]);

    const uses = [...read("src/lib/agreements.functions.ts").matchAll(/.*excluded_module_ids.*/g)]
      .map((m) => m[0].trim())
      .sort();
    expect(uses).toEqual([
      '"offer" | "issued_snapshot" | BuilderPartnerColumn | "excluded_module_ids"',
      "excluded_module_ids: [],",
    ]);
  });
});
