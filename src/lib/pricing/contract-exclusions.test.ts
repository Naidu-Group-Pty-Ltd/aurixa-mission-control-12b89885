import { describe, expect, it } from "vitest";
import {
  excludableModules,
  exclusionChoices,
  sortedUniqueSlugs,
  unknownExclusionSlugs,
  validateContractExclusions,
} from "./contract-exclusions";
import { AML_MODULE_SLUG, MODULES } from "./aurixa-catalog";

describe("validateContractExclusions", () => {
  it("accepts price-list slugs, de-duplicated and sorted", () => {
    expect(validateContractExclusions(["market-updates", "aml-ctf", "market-updates"])).toEqual({
      ok: true,
      slugs: ["aml-ctf", "market-updates"],
    });
  });

  it("accepts no exclusions at all", () => {
    expect(validateContractExclusions([])).toEqual({ ok: true, slugs: [] });
  });

  it("refuses a library module slug, which is the old vocabulary", () => {
    // `aml` and `commercial` are rows of `modules`. The price list calls them
    // `aml-ctf` and `commercial-industrial`.
    const r = validateContractExclusions(["aml", "commercial", "aml-ctf"]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Named once each, and the valid `aml-ctf` is not among them.
    expect(r.error).toMatch(/^Not on the price list: aml, commercial\. /);
  });

  it("refuses an unknown slug rather than holding it until signature", () => {
    const r = validateContractExclusions(["finance-portl"]);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("finance-portl") });
  });

  it("refuses a module the same selection buys as an add-on", () => {
    const r = validateContractExclusions(["call-logs", "aml-ctf"], {
      addonSlugs: ["call-logs", "integrations"],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("excluded as well: call-logs.");
  });

  it("accepts an exclusion of a priced module the plan does not include: it is inert", () => {
    expect(validateContractExclusions(["finance-portal"], { addonSlugs: [] })).toEqual({
      ok: true,
      slugs: ["finance-portal"],
    });
  });
});

describe("excludableModules", () => {
  const slugs = (plan: string | null) => excludableModules(plan).map((m) => m.slug);

  it("offers what each tier includes, and AML/CTF with every portal it brings, on every tier", () => {
    for (const tier of ["launch", "growth", "scale"]) {
      const expected = MODULES.filter(
        (m) => m.includedIn.includes(tier) || m.includedWithAml === true,
      ).map((m) => m.slug);
      expect(slugs(tier).filter((s) => s !== AML_MODULE_SLUG)).toEqual(expected);
      expect(slugs(tier)).toContain(AML_MODULE_SLUG);
    }
  });

  it("offers Launch Client Forms, AML/CTF and the four portals AML/CTF brings", () => {
    // The owner's decision of 29 Oct 2026: a contract can negotiate out one
    // portal, or AML/CTF and so all four.
    expect(slugs("launch").sort()).toEqual([
      "accountant-portal",
      "aml-ctf",
      "builder-developer-portal",
      "client-forms",
      "finance-portal",
      "solicitor-portal",
    ]);
  });

  it("offers nothing without a plan, and no AML for a plan that is not a tier", () => {
    expect(slugs(null)).toEqual([]);
    expect(slugs("enterprise")).toEqual([]);
  });
});

describe("exclusionChoices", () => {
  it("lists the plan's own modules by name, with no note", () => {
    expect(exclusionChoices({ planSlug: "launch", saved: [], selected: [] })).toEqual([
      { slug: "client-forms", name: "Client Forms", note: null },
      { slug: "aml-ctf", name: "AML / CTF Compliance", note: null },
      { slug: "finance-portal", name: "Finance Portal", note: null },
      { slug: "solicitor-portal", name: "Solicitor Portal", note: null },
      { slug: "accountant-portal", name: "Accountant Portal", note: null },
      { slug: "builder-developer-portal", name: "Builder / Developer Portal", note: null },
    ]);
  });

  it("still lists a saved exclusion the plan does not offer, so it can be removed", () => {
    const rows = exclusionChoices({
      planSlug: "launch",
      saved: ["marketing", "retired-module"],
      selected: ["marketing"],
    });
    expect(rows.slice(6)).toEqual([
      { slug: "marketing", name: "Marketing", note: "not in this tier" },
      { slug: "retired-module", name: "retired-module", note: "not on the price list" },
    ]);
  });

  it("keeps an unticked saved one listed, and lists each slug once", () => {
    const rows = exclusionChoices({
      planSlug: "launch",
      saved: ["marketing", "aml-ctf"],
      selected: ["aml-ctf"],
    });
    expect(rows.map((r) => r.slug)).toEqual([
      "client-forms",
      "aml-ctf",
      "finance-portal",
      "solicitor-portal",
      "accountant-portal",
      "builder-developer-portal",
      "marketing",
    ]);
  });

  it("lists only what is saved or ticked when no plan is picked", () => {
    expect(exclusionChoices({ planSlug: null, saved: [], selected: [] })).toEqual([]);
    expect(
      exclusionChoices({ planSlug: null, saved: ["aml-ctf"], selected: [] }).map((r) => r.note),
    ).toEqual(["not in this tier"]);
  });
});

describe("the list's shape", () => {
  it("is sorted and de-duplicated", () => {
    expect(sortedUniqueSlugs(["b", "a", "b"])).toEqual(["a", "b"]);
  });

  it("names the unknown slugs once each", () => {
    expect(unknownExclusionSlugs(["x", "aml-ctf", "x"])).toEqual(["x"]);
  });
});
