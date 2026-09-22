import { describe, expect, it } from "vitest";
import {
  moduleProductShape,
  planModuleSync,
  type ModuleRow,
} from "@/server/stripe-module-sync.server";
import {
  MODULES,
  PURCHASABLE_MODULES,
  gstComponentCents,
  isModulePurchasable,
  moduleBySlug,
} from "@/lib/pricing/aurixa-catalog";

/** A catalog row as the price-list migration leaves it: priced, live, unlinked. */
const row = (slug: string, over: Partial<ModuleRow> = {}): ModuleRow => ({
  id: `id-${slug}`,
  slug,
  name: slug,
  price_min_cents: moduleBySlug(slug)?.monthlyInclGstCents ?? 0,
  is_active: true,
  stripe_price_id: null,
  stripe_product_id: null,
  ...over,
});

const allRows = () => MODULES.map((m) => row(m.slug));

describe("planModuleSync", () => {
  it("plans every purchasable module and no others", () => {
    const plan = planModuleSync(allRows());
    expect(plan.modules.map((m) => m.slug).sort()).toEqual(
      PURCHASABLE_MODULES.map((m) => m.slug).sort(),
    );
    expect(plan.warnings).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  it("never plans an unsellable module, and says which it skipped", () => {
    const plan = planModuleSync(allRows());
    const withheld = MODULES.filter((m) => !isModulePurchasable(m.slug)).map((m) => m.slug);

    // The guard that matters, now for two reasons rather than one. Lenders is
    // on the pricing page so the roadmap is visible and has no price anyone
    // agreed to pay; the Builder / Developer Portal has a price and is sold
    // directly, on another deployment. Neither may reach Stripe — and both
    // must be REPORTED as skipped rather than quietly dropped, or "21 of 25"
    // reads as a bug.
    expect(withheld).toContain("lenders");
    expect(withheld).toContain("builder-developer-portal");
    expect(plan.skipped).toEqual(withheld);
    for (const slug of withheld) {
      expect(plan.modules.map((m) => m.slug)).not.toContain(slug);
    }
  });

  it("carries the sheet's tax-inclusive price, with GST derived not added", () => {
    const plan = planModuleSync(allRows());
    for (const op of plan.modules) {
      const mod = moduleBySlug(op.slug)!;
      expect(op.unitAmount).toBe(mod.monthlyInclGstCents);
      // The direction is the whole point: GST is CONTAINED in the amount
      // (÷11), never added to it. Getting this backwards overcharges every
      // customer by 10%.
      expect(op.gstComponent).toBe(gstComponentCents(op.unitAmount));
      expect(op.gstComponent).toBeLessThan(op.unitAmount);
      expect(op.unitAmount - op.gstComponent).toBeGreaterThan(0);
    }
  });

  it("pins the AML/CTF module to the gap between the tier headline prices", () => {
    // Not an arbitrary figure: 999−849, 1399−1249 and 2699−2549 all equal 150,
    // and the pricing page states it in as many words. If this module's price
    // moves without the tiers moving, the two published figures stop
    // reconciling.
    //
    // It is also the figure the model forbids replacing with the $400
    // reference component — that one is a bundle description, and Stripe is
    // where charging it would actually take somebody's money.
    const plan = planModuleSync(allRows());
    const aml = plan.modules.find((m) => m.slug === "aml-ctf");
    expect(aml?.unitAmount).toBe(15_000);
    expect(aml?.unitAmount).not.toBe(40_000);
  });

  it("treats a row as live only when price and link agree", () => {
    const mod = PURCHASABLE_MODULES[0];
    const linked = planModuleSync([
      row(mod.slug, { stripe_price_id: "price_live", stripe_product_id: "prod_live" }),
    ]);
    expect(linked.modules[0].alreadyLive).toBe(true);

    // Linked, but the row is advertising something else — the exact drift
    // between "what the page shows" and "what Stripe charges" this sync exists
    // to prevent.
    const stale = planModuleSync([
      row(mod.slug, { stripe_price_id: "price_live", price_min_cents: 1 }),
    ]);
    expect(stale.modules[0].alreadyLive).toBe(false);

    // Priced correctly but nothing behind it: the state every row starts in.
    expect(planModuleSync([row(mod.slug)]).modules[0].alreadyLive).toBe(false);

    // Off sale entirely.
    expect(
      planModuleSync([row(mod.slug, { stripe_price_id: "price_live", is_active: false })])
        .modules[0].alreadyLive,
    ).toBe(false);
  });

  it("refuses to invent catalog rows the migration never created", () => {
    const plan = planModuleSync([]);
    expect(plan.modules).toEqual([]);
    expect(plan.missing).toEqual(PURCHASABLE_MODULES.map((m) => m.slug));
    expect(plan.warnings.join(" ")).toMatch(/price list migration/i);
  });
});

describe("moduleProductShape", () => {
  it("names the tiers that already bundle the module", () => {
    // The likeliest support question about a module charge is "isn't this
    // already in my plan?", so the answer belongs on the invoice line itself.
    const dealPipeline = moduleProductShape(moduleBySlug("deal-pipeline")!);
    expect(dealPipeline.name).toBe("Aurixa Deal Pipeline");
    expect(dealPipeline.description).toContain("Growth");
    expect(dealPipeline.description).toContain("Scale");
    expect(dealPipeline.metadata.included_in).toBe("growth,scale");
  });

  it("says so plainly when no tier bundles it", () => {
    const agent = moduleProductShape(moduleBySlug("aurixa-agent")!);
    expect(agent.description).toContain("every tier");
    // Empty rather than absent: an update must be able to CLEAR a stale list,
    // and Stripe distinguishes the two.
    expect(agent.metadata.included_in).toBe("");
  });

  it("reads as a list, not a chain of ands", () => {
    // Client Forms is on all three tiers; "Launch and Growth and Scale" is
    // what a naive join produces and it appears on customer invoices.
    expect(moduleProductShape(moduleBySlug("client-forms")!).description).toContain(
      "Launch, Growth and Scale",
    );
  });

  it("warns that AML/CTF is already inside every tier headline", () => {
    // The one description where being wrong costs money rather than time. The
    // module matrix says `includedIn: []`, but every tier's headline price
    // already contains it — it IS the $195 gap between each tier's two
    // published figures — so describing it as an ordinary add-on would invite
    // a customer to buy what they are already paying for.
    const aml = moduleProductShape(moduleBySlug("aml-ctf")!);
    expect(aml.description).toMatch(/already contained in every tier/i);
    expect(aml.description).not.toMatch(/available on every tier as an add-on/i);
  });

  it("keeps the module's own caveat", () => {
    const callLogs = moduleProductShape(moduleBySlug("call-logs")!);
    expect(callLogs.description).toContain("custom build price");
  });

  it("does not stutter the brand on modules that already carry it", () => {
    // These two are named "Aurixa Intelligence Hub" and "Aurixa Agent" in the
    // price list. A blanket prefix bills the customer for "Aurixa Aurixa
    // Agent".
    expect(moduleProductShape(moduleBySlug("intelligence-hub")!).name).toBe(
      "Aurixa Intelligence Hub",
    );
    expect(moduleProductShape(moduleBySlug("aurixa-agent")!).name).toBe("Aurixa Agent");
    for (const mod of PURCHASABLE_MODULES) {
      expect(moduleProductShape(mod).name).not.toMatch(/Aurixa Aurixa/);
      expect(moduleProductShape(mod).name.startsWith("Aurixa ")).toBe(true);
    }
  });

  it("tags every product with the slug the sync searches on", () => {
    for (const mod of PURCHASABLE_MODULES) {
      expect(moduleProductShape(mod).metadata.aurixa_module).toBe(mod.slug);
    }
  });
});
