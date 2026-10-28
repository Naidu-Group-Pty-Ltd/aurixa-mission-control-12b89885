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
import { balanceEntitlements } from "./balanceEntitlements.pure";

const base = {
  addonSlugs: [] as string[],
  planSlug: "growth",
  amlExcluded: false,
  contractExcluded: [] as string[] | null,
};

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
    expect(JSON.parse(JSON.stringify(r))).toEqual({ addons: ["aml-ctf"], excluded: [] });
  });

  it("is ABSENT when the read failed, never sent as an empty list", () => {
    const r = balanceEntitlements({ ...base, contractExcluded: null });
    expect("excluded" in r).toBe(false);
    expect(JSON.parse(JSON.stringify(r))).toEqual({ addons: ["aml-ctf"] });
  });
});

describe("addons", () => {
  it("adds AML/CTF for a tenant on a known tier, as before", () => {
    expect(balanceEntitlements(base).addons).toEqual(["aml-ctf"]);
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
    expect(r.addons).toEqual(["aml-ctf", "call-logs"]);
    expect(r.addons).not.toContain("market-updates");
  });

  it("still derives AML/CTF when the exclusions could not be read", () => {
    // The prime subtracts the exclusions it last knew.
    const r = balanceEntitlements({
      ...base,
      addonSlugs: ["call-logs"],
      contractExcluded: null,
    });
    expect(r.addons).toEqual(["aml-ctf", "call-logs"]);
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
    expect(r.addons).toEqual(["aml-ctf", "call-logs", "integrations"]);
  });
});
