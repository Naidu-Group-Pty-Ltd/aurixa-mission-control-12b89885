/**
 * The balance response's entitlements: the contract with the prime (D18).
 *
 *     entitlements: { addons: string[], excluded?: string[] }
 *
 * `excluded` is present whenever the clone's row was read, `[]` for a key
 * with no clone, and absent only when the read failed — the prime then keeps
 * the exclusions it last knew. `addons` never carries an excluded slug.
 */
import { describe, expect, it } from "vitest";
import { AML_BUNDLED_MODULES, MODULES, isModulePurchasable } from "@/lib/pricing/aurixa-catalog";
import { balanceEntitlements } from "./balanceEntitlements.pure";

const base = {
  addonSlugs: [] as string[],
  planSlug: "growth",
  amlExcluded: false,
  contractExcluded: [] as string[] | null,
  billingExempt: false,
};

const priceList = MODULES.map((m) => m.slug).sort();

/**
 * AML/CTF and every partner portal it brings (the owner's decision of 29 Oct
 * 2026): what a tenant on a tier's headline SKU holds before buying anything.
 */
const withAml = ["aml-ctf", ...AML_BUNDLED_MODULES.map((m) => m.slug)].sort();
const plus = (...slugs: string[]) => [...new Set([...withAml, ...slugs])].sort();

describe("excluded", () => {
  it("is present, sorted and de-duplicated, when the clone's row was read", () => {
    const r = balanceEntitlements({
      ...base,
      contractExcluded: ["market-updates", "finance-portal", "market-updates"],
    });
    expect(r.excluded).toEqual(["finance-portal", "market-updates"]);
  });

  it("is present and empty when the row holds none — and for a key with no clone", () => {
    // The route passes [] for a platform-level key: no clone, no agreement.
    const r = balanceEntitlements({ ...base, contractExcluded: [] });
    expect(r).toHaveProperty("excluded", []);
    expect(JSON.parse(JSON.stringify(r))).toEqual({ addons: withAml, excluded: [] });
  });

  it("is ABSENT when the read failed, never sent as an empty list", () => {
    const r = balanceEntitlements({ ...base, contractExcluded: null });
    expect("excluded" in r).toBe(false);
    expect(JSON.parse(JSON.stringify(r))).toEqual({ addons: withAml });
  });
});

describe("addons", () => {
  it("adds AML/CTF, and every partner portal it brings, for a tenant on a known tier", () => {
    expect(balanceEntitlements(base).addons).toEqual(withAml);
    expect(withAml).toEqual([
      "accountant-portal",
      "aml-ctf",
      "builder-developer-portal",
      "finance-portal",
      "solicitor-portal",
    ]);
  });

  it("never adds AML/CTF when the contract excludes it", () => {
    const r = balanceEntitlements({ ...base, contractExcluded: ["aml-ctf"] });
    expect(r.addons).toEqual([]);
    expect(r.excluded).toEqual(["aml-ctf"]);
  });

  it("drops a purchased AML/CTF add-on that the contract excludes", () => {
    const r = balanceEntitlements({
      ...base,
      addonSlugs: ["aml-ctf"],
      contractExcluded: ["aml-ctf"],
    });
    expect(r.addons).toEqual([]);
  });

  it("filters an excluded add-on out and keeps the rest", () => {
    const r = balanceEntitlements({
      ...base,
      addonSlugs: ["market-updates", "call-logs"],
      contractExcluded: ["market-updates"],
    });
    expect(r.addons).toEqual(plus("call-logs"));
    expect(r.addons).not.toContain("market-updates");
  });

  it("still derives AML/CTF when the exclusions could not be read", () => {
    // The prime subtracts the exclusions it last knew.
    const r = balanceEntitlements({
      ...base,
      addonSlugs: ["call-logs"],
      contractExcluded: null,
    });
    expect(r.addons).toEqual(plus("call-logs"));
  });

  it("adds no AML/CTF for a without-AML SKU or for a plan that is not a tier", () => {
    expect(balanceEntitlements({ ...base, amlExcluded: true }).addons).toEqual([]);
    expect(balanceEntitlements({ ...base, planSlug: "enterprise" }).addons).toEqual([]);
    expect(balanceEntitlements({ ...base, planSlug: null }).addons).toEqual([]);
  });

  it("is sorted and carries each slug once", () => {
    const r = balanceEntitlements({
      ...base,
      addonSlugs: ["integrations", "aml-ctf", "call-logs", "integrations"],
    });
    expect(r.addons).toEqual(plus("call-logs", "integrations"));
  });
});

describe("the partner portals AML/CTF brings (29 Oct 2026)", () => {
  it("come with AML/CTF however it is held: by the tier's SKU, or bought", () => {
    expect(balanceEntitlements(base).addons).toEqual(withAml);
    // A without-AML SKU that bought AML/CTF back, and a plan that is no tier.
    expect(
      balanceEntitlements({ ...base, amlExcluded: true, addonSlugs: ["aml-ctf"] }).addons,
    ).toEqual(withAml);
    expect(
      balanceEntitlements({ ...base, planSlug: null, addonSlugs: ["aml-ctf"] }).addons,
    ).toEqual(withAml);
  });

  it("follow today's pricing without AML/CTF: only what was bought", () => {
    const r = balanceEntitlements({ ...base, amlExcluded: true, addonSlugs: ["solicitor-portal"] });
    expect(r.addons).toEqual(["solicitor-portal"]);
  });

  it("lose the one portal a contract excludes, and keep the rest", () => {
    const r = balanceEntitlements({ ...base, contractExcluded: ["solicitor-portal"] });
    expect(r.addons).toEqual(withAml.filter((s) => s !== "solicitor-portal"));
  });

  it("all go with an excluded AML/CTF, but a portal the tenant bought stays", () => {
    const r = balanceEntitlements({
      ...base,
      addonSlugs: ["finance-portal"],
      contractExcluded: ["aml-ctf"],
    });
    expect(r.addons).toEqual(["finance-portal"]);
  });
});

describe("a billing-exempt tenant (D17)", () => {
  // Only the prime's tenant is exempt (measured 28 Oct 2026: `scale`, no
  // clone). Its gate passes an exempt workspace on a live answer, and its
  // last-known-good cache keeps only the plan and these add-ons.
  const exempt = { ...base, planSlug: "scale", billingExempt: true };

  it("holds every module on the price list", () => {
    expect(balanceEntitlements(exempt).addons).toEqual(priceList);
  });

  it("including the add-on-only modules a tier never includes", () => {
    const { addons } = balanceEntitlements(exempt);
    for (const slug of ["solicitor-portal", "intelligence-hub", "integrations", "aurixa-agent"]) {
      expect(addons).toContain(slug);
    }
  });

  it("and the ones no checkout sells, which the prime's gate still checks", () => {
    // `lenders` is coming soon and the Builder / Developer Portal is a direct
    // sale. The exemption is not a purchase, so neither flag narrows it.
    const unsold = MODULES.filter((m) => !isModulePurchasable(m.slug)).map((m) => m.slug);
    expect(unsold.length).toBeGreaterThan(0);
    const { addons } = balanceEntitlements(exempt);
    for (const slug of unsold) expect(addons).toContain(slug);
  });

  it("still loses what its agreement excludes, and says so", () => {
    const r = balanceEntitlements({
      ...exempt,
      contractExcluded: ["solicitor-portal", "aml-ctf"],
    });
    expect(r.addons).toEqual(priceList.filter((s) => s !== "solicitor-portal" && s !== "aml-ctf"));
    expect(r.excluded).toEqual(["aml-ctf", "solicitor-portal"]);
  });

  it("keeps the whole list when the exclusions could not be read", () => {
    // The prime subtracts the exclusions it last knew.
    const r = balanceEntitlements({ ...exempt, contractExcluded: null });
    expect(r.addons).toEqual(priceList);
    expect("excluded" in r).toBe(false);
  });

  it("is not narrowed by a without-AML SKU, which records a purchase", () => {
    const r = balanceEntitlements({ ...exempt, amlExcluded: true });
    expect(r.addons).toContain("aml-ctf");
  });

  it("does not depend on the plan", () => {
    expect(balanceEntitlements({ ...exempt, planSlug: null }).addons).toEqual(priceList);
  });

  it("leaves a tenant that is not exempt with what it bought", () => {
    const r = balanceEntitlements({ ...base, planSlug: "scale", addonSlugs: ["call-logs"] });
    expect(r.addons).toEqual(plus("call-logs"));
  });
});
