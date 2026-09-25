/**
 * The committed Subscription Agreement templates, read back out of the files.
 *
 * Every pin in `subscriptionTemplates.ts` is checked against the `.docx` it
 * describes — the digest, the control vocabulary, Schedule A3, Schedule A5,
 * the token allowance and clause 5.4's AML differences — and then against the
 * commercial catalogue, with the known disagreements named rather than
 * tolerated. Replacing a template file without updating the manifest, or a
 * catalogue price change the approved text does not carry, fails here.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MODULES, TIERS, moduleSaleBlock } from "@/lib/pricing/aurixa-catalog";
import { documentText, inventoryControls } from "./docxFill.pure";
import { partText, readDocx } from "./docxPackage.pure";
import {
  ADDITIONAL_LINE_TAGS,
  ADDITIONAL_LINES_TAG,
  SUBSCRIPTION_FIELD_TAGS,
} from "./subscriptionOffer.pure";
import {
  amlDifferenceCents,
  FLEXIBLE_AML_DIFFERENCE_CENTS,
  formatAud,
  formatCount,
} from "./subscriptionPricing.pure";
import {
  A3_INCLUDED,
  A3_ITEMS,
  A5_PACKS,
  catalogA5Packs,
  expectedA3Rows,
  purchasableItems,
  SUBSCRIPTION_TEMPLATES,
  SUBSCRIPTION_TIER_SLUGS,
  type SubscriptionTierSlug,
} from "./subscriptionTemplates";

function templateBytes(tier: SubscriptionTierSlug): Uint8Array {
  return new Uint8Array(readFileSync(`public${SUBSCRIPTION_TEMPLATES[tier].path}`));
}

async function templateParts(tier: SubscriptionTierSlug) {
  const pkg = await readDocx(templateBytes(tier));
  return { pkg, document: partText(pkg, "word/document.xml") };
}

/** Remove every content-control span, leaving the template's fixed text. */
function withoutControls(xml: string): string {
  const re = /<w:sdt(?=[\s>])[^>]*>|<\/w:sdt>/g;
  let depth = 0;
  let out = "";
  let pos = 0;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[0] === "</w:sdt>") {
      depth--;
      if (depth === 0) pos = m.index + m[0].length;
    } else {
      if (depth === 0) out += xml.slice(pos, m.index);
      depth++;
    }
  }
  return out + xml.slice(pos);
}

/**
 * The rows of the table whose text contains `marker`, as trimmed cell text.
 * The A3 and A5 tables hold no nested table, which is asserted rather than
 * assumed.
 */
function tableContaining(xml: string, marker: string): string[][] {
  const at = xml.indexOf(`>${marker}<`);
  expect(at, `table marker "${marker}"`).toBeGreaterThan(0);
  const start = xml.lastIndexOf("<w:tbl>", at);
  const end = xml.indexOf("</w:tbl>", at) + "</w:tbl>".length;
  const table = xml.slice(start, end);
  expect(table.indexOf("<w:tbl>", 1)).toBe(-1);
  const rows = table.match(/<w:tr(?=[\s>])[\s\S]*?<\/w:tr>/g) ?? [];
  return rows.map((row) =>
    (row.match(/<w:tc(?=[\s>])[\s\S]*?<\/w:tc>/g) ?? []).map((cell) =>
      documentText(cell).replace(/\s+/g, " ").trim(),
    ),
  );
}

describe.each(SUBSCRIPTION_TIER_SLUGS)("the %s template", (tier) => {
  const template = SUBSCRIPTION_TEMPLATES[tier];

  it("is the committed file the manifest names", () => {
    const digest = createHash("sha256").update(templateBytes(tier)).digest("hex");
    expect(digest).toBe(template.sha256);
  });

  it("declares exactly the Order vocabulary the composer fills, in order", async () => {
    const { document } = await templateParts(tier);
    const inventory = inventoryControls(document);
    expect(inventory.fields).toEqual([...SUBSCRIPTION_FIELD_TAGS]);
    expect(inventory.repeating).toEqual([
      { tag: ADDITIONAL_LINES_TAG, itemFields: [...ADDITIONAL_LINE_TAGS] },
    ]);
  });

  it("carries no square bracket outside its controls, in the body or any header, footer or note", async () => {
    const { pkg, document } = await templateParts(tier);
    expect(documentText(withoutControls(document))).not.toContain("[");
    for (const name of pkg.order) {
      if (!/^word\/(header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)) continue;
      const xml = partText(pkg, name);
      expect(xml, name).not.toMatch(/<w:sdt(?=[\s>])/);
      expect(documentText(xml), name).not.toContain("[");
    }
  });

  it("prints the Schedule A3 table the manifest transcribes", async () => {
    const { document } = await templateParts(tier);
    const rows = tableContaining(document, "Catalogue item");
    expect(rows[0]).toEqual(["Catalogue item", "This tier", "Monthly fee if separately purchased"]);
    expect(rows.slice(1).map(([label, thisTier, fee]) => ({ label, thisTier, fee }))).toEqual(
      expectedA3Rows(tier),
    );
  });

  it("prints the Schedule A5 credit packs the manifest transcribes", async () => {
    const { document } = await templateParts(tier);
    const rows = tableContaining(document, "Purchased Aurixa Credits");
    expect(rows.slice(1).map(([credits, total]) => [credits, total])).toEqual(
      A5_PACKS.map((p) => [formatCount(p.credits), formatAud(p.totalCents)]),
    );
  });

  it("states the included token allowance the manifest records", async () => {
    const { document } = await templateParts(tier);
    const text = documentText(document).replace(/\s+/g, " ");
    expect(text).toContain(
      `Included Subscription Tokens ${formatCount(template.includedTokensPerCycle)} each monthly Billing Cycle`,
    );
  });

  it("names its package and the version the manifest records", async () => {
    const { pkg, document } = await templateParts(tier);
    const text = documentText(document).replace(/\s+/g, " ");
    expect(text).toContain(`Package ${template.tierName} Legal identifier`);
    expect(partText(pkg, "docProps/core.xml")).toContain(`— ${template.version}</dc:title>`);
    expect(partText(pkg, "word/footer1.xml")).toContain(`${template.tierName} Agreement`);
  });

  // The file is public — the list page links to it — so its document
  // properties are part of what Aurixa publishes. The approved files first
  // arrived calling themselves an "approval draft" and naming the person who
  // last edited them; the owner's final documents must say neither.
  it("carries final document properties: no draft status, and no person named", async () => {
    const { pkg } = await templateParts(tier);
    for (const name of pkg.order.filter((n) => n.startsWith("docProps/"))) {
      expect(partText(pkg, name), name).not.toMatch(/draft/i);
    }
    const core = partText(pkg, "docProps/core.xml");
    for (const tag of ["dc:creator", "cp:lastModifiedBy"]) {
      const value = core.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? "";
      expect(["", "Aurixa Systems Pty Ltd"], tag).toContain(value);
    }
  });

  it("states clause 5.4's AML differences, which the catalogue reproduces", async () => {
    const { document } = await templateParts(tier);
    const text = documentText(document);
    const committed = amlDifferenceCents(tier, "committed_monthly");
    const flexible = amlDifferenceCents(tier, "flexible");
    expect(committed).toBe(12_750);
    expect(flexible).toBe(FLEXIBLE_AML_DIFFERENCE_CENTS);
    expect(text).toContain(
      `The monthly difference between the two discounted AML base options is ${formatAud(committed)}; it is $${flexible / 100} under flexible standard pricing.`,
    );
  });
});

describe("the manifest against the commercial catalogue", () => {
  it("records each tier's token allowance as the catalogue grants it", () => {
    for (const tier of SUBSCRIPTION_TIER_SLUGS) {
      const catalog = TIERS.find((t) => t.slug === tier);
      expect(SUBSCRIPTION_TEMPLATES[tier].includedTokensPerCycle).toBe(catalog?.monthlyCredits);
    }
  });

  it("lists the catalogue's credit packs in Schedule A5", () => {
    expect(A5_PACKS).toEqual(catalogA5Packs());
  });

  it("prices every catalogue-backed A3 row as the catalogue does", () => {
    for (const item of A3_ITEMS) {
      if (!item.catalogSlug || item.referenceMonthlyCents === null) continue;
      const mod = MODULES.find((m) => m.slug === item.catalogSlug);
      expect(mod, item.key).toBeDefined();
      expect(mod?.monthlyInclGstCents, item.key).toBe(item.referenceMonthlyCents);
    }
  });

  it("marks as not orderable exactly what the catalogue will not sell", () => {
    expect(moduleSaleBlock("lenders")).toBe("coming_soon");
    expect(moduleSaleBlock("builder-developer-portal")).toBe("direct_sale");
    const kinds = Object.fromEntries(A3_ITEMS.map((i) => [i.key, i.kind]));
    expect(kinds.lenders).toBe("not_for_sale");
    expect(kinds["builder-developer-portal"]).toBe("independent_contract");
  });

  /**
   * Where the approved text and the catalogue disagree about what a tier
   * includes. Each entry is a difference the owner has decided: the Growth
   * agreement includes Market News Feed, which the catalogue bundles only at
   * Scale, and it stays that way — a Growth signature provisions it as an
   * add-on (decided 25 September 2026). A new disagreement fails until it is
   * decided and named here.
   */
  const KNOWN_INCLUSION_DIFFERENCES = new Set(["growth:market-news-feed"]);

  it("includes per tier what the catalogue includes, apart from the named differences", () => {
    const differences: string[] = [];
    for (const tier of SUBSCRIPTION_TIER_SLUGS) {
      for (const item of A3_ITEMS) {
        if (item.kind !== "module" || !item.catalogSlug) continue;
        const inAgreement = A3_INCLUDED[tier].includes(item.key);
        const inCatalogue =
          MODULES.find((m) => m.slug === item.catalogSlug)?.includedIn.includes(tier) ?? false;
        if (inAgreement !== inCatalogue) differences.push(`${tier}:${item.key}`);
      }
    }
    expect(new Set(differences)).toEqual(KNOWN_INCLUSION_DIFFERENCES);
  });

  it("offers as additional lines only optional modules the tier does not include", () => {
    for (const tier of SUBSCRIPTION_TIER_SLUGS) {
      for (const item of purchasableItems(tier)) {
        expect(item.kind).toBe("module");
        expect(A3_INCLUDED[tier]).not.toContain(item.key);
        expect(item.referenceMonthlyCents).toBeGreaterThan(0);
      }
    }
  });
});
