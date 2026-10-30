import { describe, it, expect } from "vitest";
import {
  applyContractExclusions,
  libraryModulesExcludedBy,
  libraryModulesOf,
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
  MODULE_COMPANIONS,
  NOT_SOLD_MODULES,
  unplacedModules,
  withCompanions,
  libraryModulesOfAmlBundle,
} from "./module-mapping";
import { AML_BUNDLED_MODULES, MODULES } from "./aurixa-catalog";
import { LIBRARY_AT_83A3218 } from "./liveLibrary.fixture";

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
  // Detected on the prime, which builds `src/pages/solicitor/` alongside
  // `src/components/solicitor-portal/` and canonicalises the pair onto the
  // portal spelling. Present here for the reason the note below gives: a
  // fixture that omits a real module lets an unresolved price look resolved.
  "solicitor-portal",
  // A real approved module in production. Its absence here is what let the
  // `intelligence-hub` alias look unresolved while the test still passed.
  "report-qa",
  // Approved in production since 8 Oct 2026, and sold as an add-on since 29 Oct.
  "accountant-portal",
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

  it("resolves a separately-deployed portal to that deployment, not to nothing", () => {
    // "Nothing installs here" and "we could not work out what this installs"
    // read identically in an unmapped index, and only one of them is a
    // question for a human. The Builder / Developer Portal is the settled one.
    const m = mapPricedModule(priced("builder-developer-portal"), KNOWN);
    expect(m.kind).toBe("external");
    expect(m.moduleSlugs).toEqual([]);
    expect(m.reason).toContain("aurixa-builders");
  });

  it("maps the Solicitor Portal onto the module the prime actually builds", () => {
    const m = mapPricedModule(priced("solicitor-portal"), KNOWN);
    expect(m.kind).toBe("installs");
    expect(m.moduleSlugs).toEqual(["solicitor-portal"]);
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

describe("libraryModulesOf", () => {
  it("is the translation the resolution installs by, for every priced module", () => {
    // Bought on a plan with no tier baseline, a priced module adds exactly its
    // library modules to the shell. An exclusion must withhold exactly those,
    // so the two translations are compared rather than restated.
    const shell = resolveEntitledModules({ planSlug: "no-such-plan", knownModules: KNOWN });
    for (const pm of MODULES) {
      const bought = resolveEntitledModules({
        planSlug: "no-such-plan",
        purchasedAddons: [pm.slug],
        knownModules: KNOWN,
      });
      const added = bought.moduleSlugs.filter((s) => !shell.moduleSlugs.includes(s));
      // Buying AML/CTF also brings every partner portal (the owner's decision
      // of 29 Oct 2026), which is its own translation, not AML/CTF's.
      const expected =
        pm.slug === "aml-ctf"
          ? [
              ...new Set([...libraryModulesOf(pm, KNOWN), ...libraryModulesOfAmlBundle(KNOWN)]),
            ].sort()
          : libraryModulesOf(pm, KNOWN);
      expect(expected, pm.slug).toEqual(added);
    }
  });

  it("takes the operator's override first, and only modules the catalogue holds", () => {
    const overrides = { "module:market-updates": ["listings", "not-detected"] };
    expect(libraryModulesOf(priced("market-updates"), KNOWN, overrides)).toEqual(["listings"]);
  });

  it("maps an entitlement-only item and an external one to nothing", () => {
    expect(libraryModulesOf(priced("client-ai"), KNOWN)).toEqual([]);
    expect(libraryModulesOf(priced("builder-developer-portal"), KNOWN)).toEqual([]);
  });
});

describe("libraryModulesExcludedBy", () => {
  it("unions what each excluded price-list slug maps to, and ignores an unknown one", () => {
    expect(libraryModulesExcludedBy(["commercial-industrial", "aml-ctf", "nope"], KNOWN)).toEqual([
      // Excluding AML/CTF withdraws the portals it brings as well.
      "accountant-portal",
      "aml",
      "commercial",
      "finance-portal",
      "industrial",
      "solicitor-portal",
    ]);
    expect(libraryModulesExcludedBy(["commercial-industrial"], KNOWN)).toEqual([
      "commercial",
      "industrial",
    ]);
  });
});

describe("applyContractExclusions", () => {
  const library = { knownModules: KNOWN };
  const scale = resolveEntitledModules({ planSlug: "scale", knownModules: KNOWN });
  const launch = resolveEntitledModules({ planSlug: "launch", knownModules: KNOWN });

  it("takes price-list slugs: an excluded tier module leaves every list it was on", () => {
    expect(scale.includedModules).toContain("market-updates");
    expect(scale.moduleSlugs).toContain("market-updates");
    const r = applyContractExclusions(scale, ["market-updates"], library);
    expect(r.includedModules).not.toContain("market-updates");
    expect(r.moduleSlugs).not.toContain("market-updates");
    expect(r.contractExcluded).toEqual(["market-updates"]);
    // Nothing else moves.
    expect(r.moduleSlugs).toEqual(scale.moduleSlugs.filter((s) => s !== "market-updates"));
    expect(r.entitlementKeys).toEqual(scale.entitlementKeys);
  });

  it("translates a price-list slug into the library modules it maps to", () => {
    // The library slug was the old vocabulary. The price list calls `aml`
    // `aml-ctf`, and sells Commercial / Industrial as one line built as two.
    const r = applyContractExclusions(scale, ["aml-ctf", "commercial-industrial"], library);
    expect(r.moduleSlugs).not.toContain("aml");
    expect(r.moduleSlugs).not.toContain("commercial");
    expect(r.moduleSlugs).not.toContain("industrial");
    expect(r.includedModules).not.toContain("commercial-industrial");
  });

  it("removes AML even though the tier's own baseline maps to it as well", () => {
    // `aml` reaches every tier through the "AML/CTF Compliance" baseline, not
    // through the priced line. A tier baseline keeps nothing an exclusion names.
    expect(launch.moduleSlugs).toContain("aml");
    const r = applyContractExclusions(launch, ["aml-ctf"], library);
    expect(r.moduleSlugs).not.toContain("aml");
    expect(r.contractExcluded).toEqual(["aml-ctf"]);
  });

  it("removes an entitlement-only item's key, which is its only gate", () => {
    expect(scale.entitlementKeys).toContain("clients.ai");
    const r = applyContractExclusions(scale, ["client-ai"], library);
    expect(r.entitlementKeys).not.toContain("clients.ai");
    expect(r.includedModules).not.toContain("client-ai");
    // Nothing installs for it, so nothing else leaves.
    expect(r.moduleSlugs).toEqual(scale.moduleSlugs);
  });

  it("leaves the keys of a module that installs alone: its module gate wins", () => {
    const r = applyContractExclusions(scale, ["finance-portal"], library);
    expect(r.moduleSlugs).not.toContain("finance-portal");
    expect(r.entitlementKeys).toEqual(scale.entitlementKeys);
  });

  it("keeps a library module another priced module in effect maps to, and says so", () => {
    // Two priced lines that share a library module, through overrides. Both
    // are included at Scale; the contract excludes one.
    const overrides = {
      "module:market-updates": ["listings"],
      "module:opportunity-marketplace": ["listings"],
    };
    const resolved = resolveEntitledModules({ planSlug: "scale", knownModules: KNOWN, overrides });
    const r = applyContractExclusions(resolved, ["market-updates"], {
      knownModules: KNOWN,
      overrides,
    });
    expect(r.moduleSlugs).toContain("listings");
    expect(r.includedModules).not.toContain("market-updates");
    expect(r.sharedModulesKept).toEqual([
      {
        moduleSlug: "listings",
        excludedBy: ["market-updates"],
        keptFor: ["opportunity-marketplace"],
      },
    ]);
  });

  it("keeps a shared module only for a priced module this resolution still has", () => {
    // Model Hub is not bought and not in Launch, so it keeps nothing.
    const overrides = {
      "module:client-forms": ["model-hub"],
      "module:model-hub": ["model-hub"],
    };
    const resolved = resolveEntitledModules({ planSlug: "launch", knownModules: KNOWN, overrides });
    expect(resolved.moduleSlugs).toContain("model-hub");
    const r = applyContractExclusions(resolved, ["client-forms"], {
      knownModules: KNOWN,
      overrides,
    });
    expect(r.moduleSlugs).not.toContain("model-hub");
    expect(r.sharedModulesKept).toEqual([]);
  });

  it("translates through the operator's override first", () => {
    // Nothing else at Scale maps to `email`, so only the override put it there.
    const overrides = { "module:market-updates": ["email"] };
    const resolved = resolveEntitledModules({ planSlug: "scale", knownModules: KNOWN, overrides });
    expect(resolved.moduleSlugs).toContain("email");
    const r = applyContractExclusions(resolved, ["market-updates"], {
      knownModules: KNOWN,
      overrides,
    });
    expect(r.moduleSlugs).not.toContain("email");
    expect(r.sharedModulesKept).toEqual([]);
  });

  it("an exclusion wins over an add-on bought on top of the tier", () => {
    const resolved = resolveEntitledModules({
      planSlug: "launch",
      purchasedAddons: ["call-logs"],
      knownModules: KNOWN,
    });
    const r = applyContractExclusions(resolved, ["call-logs"], library);
    expect(r.addonModules).not.toContain("call-logs");
    expect(r.moduleSlugs).not.toContain("call-logs");
  });

  it("an exclusion of a module the plan does not include changes nothing, and holds", () => {
    // Marketing: not in Launch, and not a portal AML/CTF brings.
    const r = applyContractExclusions(launch, ["marketing"], library);
    expect(r.moduleSlugs).toEqual(launch.moduleSlugs);
    expect(r.includedModules).toEqual(launch.includedModules);
    expect(r.addonModules).toEqual(launch.addonModules);
    expect(r.amlBundled).toEqual(launch.amlBundled);
    expect(r.entitlementKeys).toEqual(launch.entitlementKeys);
    // Still in effect: it is what stops a later upgrade handing it back.
    expect(r.contractExcluded).toEqual(["marketing"]);
  });

  it("reports a slug the price list does not know, and subtracts nothing for it", () => {
    // `aml` is a LIBRARY slug. Read as a price-list slug it names nothing.
    const r = applyContractExclusions(launch, ["aml", "not-a-module"], library);
    expect(r.unknownExclusions).toEqual(["aml", "not-a-module"]);
    expect(r.contractExcluded).toEqual([]);
    expect(r.moduleSlugs).toEqual(launch.moduleSlugs);
  });

  it("reports the exclusions in effect sorted and de-duplicated", () => {
    const r = applyContractExclusions(scale, ["marketing", "aml-ctf", "marketing"], library);
    expect(r.contractExcluded).toEqual(["aml-ctf", "marketing"]);
  });
});

describe("the partner portals AML/CTF brings (29 Oct 2026)", () => {
  const library = { knownModules: KNOWN };
  const launch = resolveEntitledModules({ planSlug: "launch", knownModules: KNOWN });
  const scale = resolveEntitledModules({ planSlug: "scale", knownModules: KNOWN });
  const portals = AML_BUNDLED_MODULES.map((m) => m.slug).sort();

  it("come with every tier, whose headline SKU carries AML/CTF", () => {
    for (const tier of ["launch", "growth", "scale"]) {
      const r = resolveEntitledModules({ planSlug: tier, knownModules: KNOWN });
      expect(r.amlBundled, tier).toEqual(portals.filter((s) => !r.includedModules.includes(s)));
    }
    expect(launch.amlBundled).toEqual([
      "accountant-portal",
      "builder-developer-portal",
      "finance-portal",
      "solicitor-portal",
    ]);
    // Scale includes the Finance Portal in its own right, so it is not bundled.
    expect(scale.includedModules).toContain("finance-portal");
    expect(scale.amlBundled).toEqual([
      "accountant-portal",
      "builder-developer-portal",
      "solicitor-portal",
    ]);
  });

  it("install the portals' library modules on the clone", () => {
    for (const slug of ["finance-portal", "solicitor-portal", "accountant-portal"]) {
      expect(launch.moduleSlugs, slug).toContain(slug);
    }
  });

  it("come with AML/CTF bought on a plan that is no tier, and not without it", () => {
    const none = resolveEntitledModules({ planSlug: "no-such-plan", knownModules: KNOWN });
    expect(none.amlBundled).toEqual([]);
    const bought = resolveEntitledModules({
      planSlug: "no-such-plan",
      purchasedAddons: ["aml-ctf"],
      knownModules: KNOWN,
    });
    expect(bought.amlBundled).toEqual(portals);
  });

  it("count a portal bought on top as the add-on it is, never twice", () => {
    const r = resolveEntitledModules({
      planSlug: "launch",
      purchasedAddons: ["solicitor-portal"],
      knownModules: KNOWN,
    });
    expect(r.addonModules).toEqual(["solicitor-portal"]);
    expect(r.amlBundled).not.toContain("solicitor-portal");
  });

  it("all go with an excluded AML/CTF, but not one the tier includes or the clone bought", () => {
    const r = applyContractExclusions(scale, ["aml-ctf"], library);
    expect(r.amlBundled).toEqual([]);
    expect(r.moduleSlugs).not.toContain("solicitor-portal");
    expect(r.moduleSlugs).not.toContain("accountant-portal");
    expect(r.includedModules).toContain("finance-portal");
    expect(r.moduleSlugs).toContain("finance-portal");

    const bought = resolveEntitledModules({
      planSlug: "launch",
      purchasedAddons: ["solicitor-portal"],
      knownModules: KNOWN,
    });
    const kept = applyContractExclusions(bought, ["aml-ctf"], library);
    expect(kept.moduleSlugs).toContain("solicitor-portal");
    expect(kept.moduleSlugs).not.toContain("finance-portal");
    expect(kept.moduleSlugs).not.toContain("accountant-portal");
  });

  it("lose only the one portal a contract excludes", () => {
    const r = applyContractExclusions(launch, ["solicitor-portal"], library);
    expect(r.amlBundled).toEqual(launch.amlBundled.filter((s) => s !== "solicitor-portal"));
    expect(r.moduleSlugs).not.toContain("solicitor-portal");
    expect(r.moduleSlugs).toContain("finance-portal");
    expect(r.moduleSlugs).toContain("aml");
  });
});

describe("placement", () => {
  /** Production's library at prime@83a3218, as the follow settled it. */
  const LIVE = new Set(LIBRARY_AT_83A3218);
  const launch = resolveEntitledModules({ planSlug: "launch", knownModules: LIVE });
  const scale = resolveEntitledModules({ planSlug: "scale", knownModules: LIVE });

  it("places every module production's library holds", () => {
    // 105 of these 143 resolved on no plan before the companions existed.
    expect(unplacedModules(LIVE)).toEqual([]);
  });

  it("names a module the follow brings in that nothing places, rather than dropping it", () => {
    const grown = new Set([...LIVE, "backend-something-new"]);
    expect(unplacedModules(grown)).toEqual(["backend-something-new"]);
  });

  it("puts a companion wherever its anchor goes: on a tier, and with an add-on", () => {
    // A report feed rides Generated Reports, which every tier has.
    expect(launch.moduleSlugs).toContain("backend-crime");
    // Partner Referrals rides Agreements: Scale, or the add-on on Launch.
    expect(launch.moduleSlugs).not.toContain("partner-referrals");
    expect(scale.moduleSlugs).toContain("partner-referrals");
    const bought = resolveEntitledModules({
      planSlug: "launch",
      purchasedAddons: ["agreements"],
      knownModules: LIVE,
    });
    expect(bought.moduleSlugs).toContain("partner-referrals");
    // Transitively: the Borrowing Capacity engine's console rides the page,
    // which rides Clients.
    expect(launch.moduleSlugs).toContain("bc-segment-engine-admin");
  });

  it("takes a companion out with the anchor a contract excludes", () => {
    const r = applyContractExclusions(scale, ["agreements", "aml-ctf"], { knownModules: LIVE });
    for (const gone of ["agreements", "partner-referrals", "aml", "backend-aml", "backend-didit"]) {
      expect(r.moduleSlugs, gone).not.toContain(gone);
    }
    expect(libraryModulesOf(MODULES.find((m) => m.slug === "aml-ctf")!, LIVE)).toEqual([
      "aml",
      "backend-aml",
      "backend-didit",
    ]);
  });

  it("installs nothing a companion rides with when its anchor is gone, and names it", () => {
    const without = new Set([...LIVE].filter((s) => s !== "messages"));
    const r = resolveEntitledModules({ planSlug: "scale", knownModules: without });
    expect(r.moduleSlugs).not.toContain("messaging");
    expect(unplacedModules(without)).toEqual(["backend-message", "backend-messaging", "messaging"]);
  });

  it("sells no module it says is not sold, nor any companion of one", () => {
    const everything = resolveEntitledModules({
      planSlug: "scale",
      purchasedAddons: MODULES.map((m) => m.slug),
      knownModules: LIVE,
    });
    const unsold = [...LIVE].filter((s) => !everything.moduleSlugs.includes(s)).sort();
    expect(unsold).toEqual([
      "-tests-",
      "backend-backfill",
      "backend-diagnose",
      "backend-migration",
      "backend-one",
      "backend-sync",
      "bc-segment-engine-admin.security.test",
      "ghl",
    ]);
    for (const slug of Object.keys(NOT_SOLD_MODULES)) expect(LIVE.has(slug), slug).toBe(true);
  });

  it("installs the Accountant Portal where AML/CTF is held, or where it is bought", () => {
    // Every tier's headline SKU carries AML/CTF, and AML/CTF brings the portals.
    expect(launch.amlBundled).toContain("accountant-portal");
    expect(launch.moduleSlugs).toContain("accountant-portal");
    // Without AML/CTF it is the add-on it always was.
    const withoutAml = applyContractExclusions(launch, ["aml-ctf"], { knownModules: LIVE });
    expect(withoutAml.moduleSlugs).not.toContain("accountant-portal");
    const bought = resolveEntitledModules({
      planSlug: "no-such-plan",
      purchasedAddons: ["accountant-portal"],
      knownModules: LIVE,
    });
    expect(bought.moduleSlugs).toContain("accountant-portal");
    expect(bought.addonModules).toEqual(["accountant-portal"]);
    expect(bought.amlBundled).toEqual([]);
  });

  it("is still the translation the resolution installs by, companions included", () => {
    const shell = resolveEntitledModules({ planSlug: "no-such-plan", knownModules: LIVE });
    for (const pm of MODULES) {
      const bought = resolveEntitledModules({
        planSlug: "no-such-plan",
        purchasedAddons: [pm.slug],
        knownModules: LIVE,
      });
      const added = bought.moduleSlugs.filter((s) => !shell.moduleSlugs.includes(s));
      const expected =
        pm.slug === "aml-ctf"
          ? [...new Set([...libraryModulesOf(pm, LIVE), ...libraryModulesOfAmlBundle(LIVE)])].sort()
          : libraryModulesOf(pm, LIVE);
      expect(expected, pm.slug).toEqual(added);
    }
  });

  it("names only modules production holds, so a typo cannot hide a gap", () => {
    for (const [companion, anchor] of Object.entries(MODULE_COMPANIONS)) {
      expect(LIVE.has(companion), companion).toBe(true);
      expect(LIVE.has(anchor), `${companion} → ${anchor}`).toBe(true);
    }
  });

  it("gives every module one place, never two", () => {
    // What the shell, the tiers' features and the price list place by
    // themselves, read off the mapping rather than restated here: an
    // entitlement-only item such as Borrowing Capacity places no module of its
    // name, so its page is a companion of Clients and not a second place.
    const placedElsewhere = new Set<string>([
      ...ALWAYS_INSTALLED,
      ...Object.keys(NOT_SOLD_MODULES),
      ...buildFullMapping(LIVE).flatMap((m) => m.moduleSlugs),
    ]);
    for (const companion of Object.keys(MODULE_COMPANIONS)) {
      expect(placedElsewhere.has(companion), companion).toBe(false);
    }
    // And the tier lines added for modules the sheet predates each place one.
    for (const slug of ["quantitative-reports", "templates", "automation", "report"]) {
      expect(placedElsewhere.has(slug), slug).toBe(true);
    }
  });

  it("follows every chain of anchors to a module placed some other way", () => {
    for (const start of Object.keys(MODULE_COMPANIONS)) {
      const seen = new Set<string>();
      let slug = start;
      while (MODULE_COMPANIONS[slug]) {
        expect(seen.has(slug), `cycle through ${start}`).toBe(false);
        seen.add(slug);
        slug = MODULE_COMPANIONS[slug];
      }
    }
  });

  it("adds companions only for anchors in the set, and only modules the catalogue holds", () => {
    expect(withCompanions(["templates"], new Set(["templates", "template-builder"]))).toEqual([
      "template-builder",
      "templates",
    ]);
    expect(withCompanions(["reports"], LIVE)).toEqual(["charts", "portfolio-reports", "reports"]);
  });
});
