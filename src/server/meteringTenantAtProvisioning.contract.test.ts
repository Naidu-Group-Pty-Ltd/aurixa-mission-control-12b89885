/**
 * Provisioning puts a new clone's metering tenant on the plan it was sold
 * (D16), through both doors.
 *
 * Measured 27 Oct 2026: neither the wizard nor the agreement path created the
 * tenant a clone meters under. The first call that needed it did, on the
 * cheapest active plan, `free`, whatever the clone had been sold: NPC Test
 * (`launch`), Preflight and the CRM (`scale`) all gate on `free`.
 *
 * Asserted on the source with comments stripped, as provisioning's other
 * contracts are; `clone-metering-tenant.server.test.ts` asserts what the
 * step itself does.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stripComments } from "./sourceComments.pure";

const core = stripComments(readFileSync("src/server/clone-provisioning.server.ts", "utf8"));
const agreement = stripComments(
  readFileSync("src/server/agreement-provisioning.server.ts", "utf8"),
);

const at = (needle: string) => {
  const i = core.indexOf(needle);
  expect(i, needle).toBeGreaterThan(-1);
  return i;
};

/**
 * The first submit's call, by the clone it passes. The retry assigns from the
 * same function earlier in the file, so the bare call text finds that one.
 */
const firstSubmitEffects = () => {
  const i = core.search(/= await startRequestedSideEffects\(\s*supabase,\s*userId,\s*inserted,/);
  expect(i, "the first submit's startRequestedSideEffects call").toBeGreaterThan(-1);
  return i;
};

describe("provisionCloneCore, first submit", () => {
  it("checks the sold plan before any repository exists, and refuses one billing_plans lacks", () => {
    const check = at("const sold = await resolveSoldPlan(data.planSlug);");
    expect(core.slice(check, check + 160)).toMatch(
      /if \(!sold\.ok\) return \{ ok: false, error: sold\.error \};/,
    );
    expect(at("getAppOctokit()")).toBeGreaterThan(check);
  });

  it("settles the metering tenant beside the clone row, before anything else runs", () => {
    const insert = at("const { data: inserted, error: insertErr } = await supabase");
    const metering = at(
      "const metering = await meterUnderSoldPlan(supabase, inserted, data, sold);",
    );
    expect(metering).toBeGreaterThan(insert);
    for (const later of [
      "await seedSyncExclusions(supabase, inserted.id)",
      'await supabase.from("clone_addon_purchases")',
      "reconcileCloneEntitlements({",
    ]) {
      expect(at(later), later).toBeGreaterThan(metering);
    }
    expect(firstSubmitEffects()).toBeGreaterThan(metering);
  });

  it("withholds the backend while the tenant is unsettled", () => {
    const call = core.slice(firstSubmitEffects());
    expect(call.slice(0, 200)).toMatch(/metering\.ok \? data : \{ \.\.\.data, backend: null \}/);
  });

  it("returns the failure, so the operator sees it and the retry finishes the clone", () => {
    const failure = at("if (!metering.ok) {");
    expect(core.slice(failure, failure + 120)).toMatch(/return \{\s*ok: false,/);
    expect(core.search(/return \{\s*ok: true,\s*cloneId: inserted\.id,/)).toBeGreaterThan(failure);
  });
});

describe("provisionCloneCore, the retry", () => {
  it("settles the tenant before it starts the side effects, and fails when it cannot", () => {
    const settle = core.slice(at("async function settleRetriedClone("));
    const meter = settle.indexOf(
      "const metering = await meterUnderSoldPlan(supabase, clone, data);",
    );
    expect(meter).toBeGreaterThan(-1);
    expect(settle.slice(meter, meter + 200)).toMatch(
      /return metering\.ok \? \{ ok: true \} : \{ ok: false, error: metering\.error \};/,
    );
    const branch = core.slice(at("if (existing) {"));
    expect(branch.indexOf("await startRequestedSideEffects(")).toBeGreaterThan(
      branch.indexOf("await settleRetriedClone(supabase, existing, data);"),
    );
  });

  it("reads the clone's billing identity, which the tenant is found by, and its slug", () => {
    expect(core).toMatch(
      /\.select\("id, github_url, name, slug, billing_user_id, billing_stripe_customer_id"\)\s*\.eq\("owner_user_id", userId\)/,
    );
  });
});

describe("the operator is told", () => {
  it("when the tenant could not be settled, and when it holds another paid plan", () => {
    const fn = core.slice(at("async function meterUnderSoldPlan("));
    const warnings = [...fn.matchAll(/await warnOnClone\(/g)];
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(fn).toMatch(
      /if \(!outcome\.ok\) \{[\s\S]*?await warnOnClone\([\s\S]*?"metering_tenant"/,
    );
    expect(fn).toMatch(
      /if \(outcome\.action === "conflict"\) \{[\s\S]*?await warnOnClone\([\s\S]*?"metering_tenant"/,
    );
  });
});

describe("the agreement path", () => {
  it("fails on a tenant provisioning could not settle, before it queues the backend", () => {
    const refused = agreement.indexOf("if (!created.ok) throw new Error(created.error);");
    expect(refused).toBeGreaterThan(agreement.indexOf("await provisionCloneCore("));
    expect(agreement.indexOf("await enqueueCloneBackendProvisioning(")).toBeGreaterThan(refused);
    // And it sells the agreement's own plan.
    expect(agreement).toMatch(/planSlug: agreement\.plan_slug,/);
  });
});
