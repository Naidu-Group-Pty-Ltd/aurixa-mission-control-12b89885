import { describe, it, expect } from "vitest";
import {
  applyContractExclusions,
  slugify,
  suggestModules,
  mapPricedModule,
  mapTierBaseline,
  resolveEntitledModules,
  diffModules,
  tierChain,
  buildFullMapping,
  ENTITLEMENT_ONLY_MODULES,
  ALWAYS_INSTALLED,
} from "./module-mapping";
import { MODULES } from "./aurixa-catalog";

/** Stand-in for the detected catalogue, covering the shapes that matter. */
const KNOWN = new Set([
  "platform-core",
  "auth",
  "index",
  "not-found",
  "settings",
  "user-management",
  "billing",
  "user-guide",
  "error-logs",
  "activity-logs",
  "overview",
  "calendar",
  "client",
  "reports",
  "generated-reports",
  "cash-flow",
  "reminders",
  "checklists",
  "game-plan",
  "portal",
  "white-label",
  "aml",
  "market-updates",
  "deal-pipeline",
  "commercial",
  "industrial",
  "listings",
  "agreements",
  "marketing",
  "model-hub",
  "finance-portal",
  "api-usage",
  "email",
  "call-logs",
  "lenders",
  "agent",
  "integrations",
  // A real approved module in production. Its absence here is what let the
  // `intelligence-hub` alias look unresolved while the test still passed.
  "report-qa",
]);

const priced = (slug: string) => MODULES.find((m) => m.slug === slug)!;

describe("slugify", () => {
  it("matches how detection forms slugs", () => {
    expect(slugify("Market Updates")).toBe("market-updates");
    expect(slugify("Commercial / Industrial")).toBe("commercial-industrial");
    expect(slugify("AML/CTF Compliance")).toBe("aml-ctf-compliance");
    expect(slugify("Billing & Usage")).toBe("billing-usage");
  });
});

describe("mapPricedModule", () => {
  it("matches an exact slug", () => {
    const m = mapPricedModule(priced("market-updates"), KNOWN);
    expect(m.kind).toBe("installs");
    expect(m.moduleSlugs).toEqual(["market-updates"]);
    expect(m.confidence).toBe("exact");
  });

  it("resolves a curated rename", () => {
    const m = mapPricedModule(priced("aml-ctf"), KNOWN);
    expect(m.kind).toBe("installs");
    expect(m.moduleSlugs).toEqual(["aml"]);
    expect(m.confidence).toBe("alias");
  });

  it("fans one priced line out to the two modules that build it", () => {
    const m = mapPricedModule(priced("commercial-industrial"), KNOWN);
    expect(m.moduleSlugs).toEqual(["commercial", "industrial"]);
  });

  it("treats a sub-feature as entitlement-only, installing nothing", () => {
    // Borrowing Capacity is a tab inside Clients, not a deployable.
    const m = mapPricedModule(priced("borrowing-capacity"), KNOWN);
    expect(m.kind).toBe("entitlement");
    expect(m.moduleSlugs).toEqual([]);
    expect(m.entitlementKey).toBe("clients.borrowing-capacity");
  });

  it("every entitlement-only slug names a real sub-module key", async () => {
    const { SUB_MODULE_MATRIX } = await import("./sub-module-matrix");
    const keys = new Set(SUB_MODULE_MATRIX.map((r) => r.key));
    for (const key of Object.values(ENTITLEMENT_ONLY_MODULES)) {
      expect(keys.has(key), `${key} missing from SUB_MODULE_MATRIX`).toBe(true);
    }
  });

  it("degrades a stale alias to unmapped rather than installing nothing silently", () => {
    // `aml` absent from the catalogue — the alias must not quietly succeed.
    const withoutAml = new Set([...KNOWN].filter((s) => s !== "aml"));
    const m = mapPricedModule(priced("aml-ctf"), withoutAml);
    expect(m.kind).toBe("unmapped");
    expect(m.moduleSlugs).toEqual([]);
  });

  it("surfaces candidates for an unmapped item instead of guessing", () => {
    // Deliberately a slug nobody sells. This assertion used to be made with
    // `intelligence-hub`, which was a REAL unmapped item — so the test that
    // was supposed to describe the unmapped path was instead pinning a live
    // defect in place, and fixing the defect would have "broken" the test.
    const m = mapPricedModule(
      {
        slug: "model-hubb",
        name: "Model Hubb",
        category: "Reports & Analysis",
        monthlyInclGstCents: 0,
        includedIn: [],
      },
      KNOWN,
    );
    expect(m.kind).toBe("unmapped");
    expect(m.reason).toMatch(/model-hub/);
  });

  it("maps the Intelligence Hub onto Report Q&A", () => {
    // The prime's own registries settle this: `entitlements/registry.ts`
    // declares `module.intelligence_hub` with `addonSlugs: ["intelligence-hub"]`
    // and `navigation/registry.ts` renders "Aurixa Intelligence Hub" at
    // `/report-qa`. Detection names the module `report-qa`, so the pricing
    // sheet and the repo never met.
    const m = mapPricedModule(priced("intelligence-hub"), KNOWN);
    expect(m.kind).toBe("installs");
    expect(m.moduleSlugs).toEqual(["report-qa"]);
  });

  // The guard for the class, not the instance.
  //
  // `intelligence-hub` was active, carried a live Stripe price, was included in
  // no plan (so purchase-only) and resolved to NOTHING: a customer could pay
  // $79/month for an addon that installed nothing and gated nothing. Nobody had
  // bought it, so there was no symptom anywhere — the only signal was a mapping
  // nobody read.
  //
  // A priced item is a promise. This asserts every one of them is kept.
  it("every priced item in the catalogue resolves to something", () => {
    const unresolved = MODULES.filter((m) => mapPricedModule(m, KNOWN).kind === "unmapped").map(
      (m) => `${m.slug} (${m.name})`,
    );
    expect(unresolved).toEqual([]);
  });
});

describe("suggestModules", () => {
  it("ranks whole-token matches above substring matches", () => {
    const s = suggestModules("call-logs", new Set(["call-logs", "logs-archive", "unrelated"]));
    expect(s[0]).toBe("call-logs");
  });

  it("returns nothing when no token is meaningful", () => {
    expect(suggestModules("ab", KNOWN)).toEqual([]);
  });
});

describe("mapTierBaseline", () => {
  it("maps baseline features and skips separately-priced ones", () => {
    const rows = mapTierBaseline("launch", KNOWN);
    const slugs = rows.flatMap((r) => r.moduleSlugs);
    expect(slugs).toContain("overview");
    expect(slugs).toContain("calendar");
    expect(slugs).toContain("aml");
    // Market Updates is sold separately, so it is not a launch baseline row.
    expect(rows.some((r) => r.sourceName === "Market Updates")).toBe(false);
  });

  it("returns nothing for an unknown tier", () => {
    expect(mapTierBaseline("enterprise", KNOWN)).toEqual([]);
  });
});

describe("tierChain", () => {
  it("walks inheritance so a higher tier includes what it builds on", () => {
    expect(tierChain("launch")).toEqual(["launch"]);
    expect(tierChain("growth")).toEqual(["launch", "growth"]);
    expect(tierChain("scale")).toEqual(["launch", "growth", "scale"]);
  });

  it("is empty for a plan that is not a tier", () => {
    expect(tierChain("nonexistent")).toEqual([]);
  });
});

describe("resolveEntitledModules", () => {
  const launch = resolveEntitledModules({ planSlug: "launch", knownModules: KNOWN });
  const growth = resolveEntitledModules({ planSlug: "growth", knownModules: KNOWN });
  const scale = resolveEntitledModules({ planSlug: "scale", knownModules: KNOWN });

  it("always includes the shell a clone cannot boot without", () => {
    for (const s of ALWAYS_INSTALLED) {
      if (KNOWN.has(s)) expect(launch.moduleSlugs).toContain(s);
    }
  });

  it("is monotonic — a higher tier is a strict superset", () => {
    for (const s of launch.moduleSlugs) expect(growth.moduleSlugs).toContain(s);
    for (const s of growth.moduleSlugs) expect(scale.moduleSlugs).toContain(s);
    expect(scale.moduleSlugs.length).toBeGreaterThan(launch.moduleSlugs.length);
  });

  it("adds exactly the modules a tier introduces", () => {
    // Market Updates no longer arrives with Growth — it is Scale-bundled and
    // otherwise an add-on.
    const delta = diffModules(launch.moduleSlugs, growth.moduleSlugs);
    expect(delta.toInstall).toEqual(["deal-pipeline"]);
    expect(delta.toRevoke).toEqual([]);
  });

  it("unions a purchased add-on onto the tier", () => {
    const r = resolveEntitledModules({
      planSlug: "launch",
      purchasedAddons: ["market-updates"],
      knownModules: KNOWN,
    });
    expect(r.moduleSlugs).toContain("market-updates");
    expect(r.addonModules).toContain("market-updates");
  });

  it("makes buying something the tier already includes a no-op", () => {
    const r = resolveEntitledModules({
      planSlug: "scale",
      purchasedAddons: ["marketing"],
      knownModules: KNOWN,
    });
    expect(r.moduleSlugs.filter((s) => s === "marketing")).toHaveLength(1);
  });

  it("carries the tier's sub-module entitlement keys", () => {
    expect(launch.entitlementKeys).toContain("clients.review");
    expect(launch.entitlementKeys).not.toContain("clients.borrowing-capacity");
    expect(scale.entitlementKeys).toContain("clients.borrowing-capacity");
  });

  it("unlocks a sub-module key bought as an add-on below its tier", () => {
    const r = resolveEntitledModules({
      planSlug: "launch",
      purchasedAddons: ["borrowing-capacity"],
      knownModules: KNOWN,
    });
    expect(r.entitlementKeys).toContain("clients.borrowing-capacity");
    // …without installing anything, because it is a tab inside Clients.
    expect(r.moduleSlugs).not.toContain("borrowing-capacity");
  });

  it("honours an operator override over the derived mapping", () => {
    // Scale, because market-updates is only reached through a tier at Scale
    // since the Scale-only bundling change; the override mechanics are what
    // is under test here.
    const r = resolveEntitledModules({
      planSlug: "scale",
      knownModules: KNOWN,
      overrides: { "module:market-updates": ["listings"] },
    });
    expect(r.moduleSlugs).toContain("listings");
    expect(r.moduleSlugs).not.toContain("market-updates");
  });

  it("never emits a module that is not in the catalogue", () => {
    const tiny = new Set(["platform-core", "client"]);
    const r = resolveEntitledModules({ planSlug: "scale", knownModules: tiny });
    for (const s of r.moduleSlugs) expect(tiny.has(s)).toBe(true);
  });

  it("reports unmapped items rather than dropping them", () => {
    // Exercised by REMOVING the target module rather than by naming an item
    // that is genuinely unmapped in production. This test used to buy
    // `intelligence-hub` against the full catalogue and assert it came back
    // unmapped — which it did, because it was a live defect. A test that
    // reaches for a real gap to demonstrate a mechanism makes fixing the gap
    // look like a regression.
    //
    // This is also the documented behaviour of a STALE alias: a mapping is
    // only claimed when the target actually exists, so it degrades to
    // `unmapped` (visible) rather than to a silent no-op install.
    const withoutReportQa = new Set([...KNOWN].filter((s) => s !== "report-qa"));

    const r = resolveEntitledModules({ planSlug: "scale", knownModules: withoutReportQa });
    // Intelligence Hub is addon-only so it is not in a tier; force it in.
    const withAddon = resolveEntitledModules({
      planSlug: "scale",
      purchasedAddons: ["intelligence-hub"],
      knownModules: withoutReportQa,
    });
    expect(withAddon.unmapped.length).toBeGreaterThan(r.unmapped.length);
    expect(withAddon.unmapped.some((u) => u.sourceSlug === "intelligence-hub")).toBe(true);
  });

  it("installs Report Q&A when the Intelligence Hub is purchased", () => {
    const withAddon = resolveEntitledModules({
      planSlug: "scale",
      purchasedAddons: ["intelligence-hub"],
      knownModules: KNOWN,
    });
    expect(withAddon.moduleSlugs).toContain("report-qa");
    expect(withAddon.unmapped.some((u) => u.sourceSlug === "intelligence-hub")).toBe(false);
  });

  it("degrades safely for an unrecognised plan", () => {
    const r = resolveEntitledModules({ planSlug: "mystery", knownModules: KNOWN });
    // Still returns the shell, so a clone is never left with nothing.
    expect(r.moduleSlugs).toContain("platform-core");
  });
});

describe("diffModules", () => {
  it("splits into install, revoke and unchanged", () => {
    const d = diffModules(["a", "b"], ["b", "c"]);
    expect(d.toInstall).toEqual(["c"]);
    expect(d.toRevoke).toEqual(["a"]);
    expect(d.unchanged).toEqual(["b"]);
  });

  it("is empty when the sets agree", () => {
    const d = diffModules(["a"], ["a"]);
    expect(d.toInstall).toEqual([]);
    expect(d.toRevoke).toEqual([]);
  });
});

describe("buildFullMapping", () => {
  const rows = buildFullMapping(KNOWN);

  it("covers every priced module exactly once", () => {
    const moduleRows = rows.filter((r) => r.sourceKind === "module");
    expect(moduleRows).toHaveLength(MODULES.length);
    expect(new Set(moduleRows.map((r) => r.sourceSlug)).size).toBe(MODULES.length);
  });

  it("leaves few enough unmapped rows to be an operator queue, not a project", () => {
    const unmapped = rows.filter((r) => r.kind === "unmapped");
    expect(unmapped.length).toBeLessThanOrEqual(3);
  });

  it("gives every row a reason an operator can act on", () => {
    for (const r of rows) expect(r.reason.length).toBeGreaterThan(10);
  });
});

describe("applyContractExclusions", () => {
  const base = {
    planSlug: "growth",
    moduleSlugs: ["platform-core", "market-updates", "call-logs"],
    entitlementKeys: ["k1"],
    includedModules: ["market-updates"],
    addonModules: [],
    unmapped: [],
  };

  it("subtracts excluded modules and names what it removed", () => {
    const r = applyContractExclusions(base, ["market-updates"]);
    expect(r.moduleSlugs).toEqual(["platform-core", "call-logs"]);
    expect(r.contractExcluded).toEqual(["market-updates"]);
  });

  it("an exclusion outside the resolution is inert", () => {
    const r = applyContractExclusions(base, ["not-in-plan"]);
    expect(r.moduleSlugs).toEqual(base.moduleSlugs);
    expect(r.contractExcluded).toEqual([]);
  });

  it("leaves entitlement keys alone — the module gate wins anyway", () => {
    const r = applyContractExclusions(base, ["market-updates"]);
    expect(r.entitlementKeys).toEqual(["k1"]);
  });
});
