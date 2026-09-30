import { describe, expect, it } from "vitest";
import {
  orderRenames,
  planCatalogSync,
  tierApplyOrder,
  type PlanRow,
} from "./stripe-catalog-sync.server";
import { annualCents, gstComponentCents } from "@/lib/pricing/aurixa-catalog";

// The live catalog as it stands: four plans, of which two are being repurposed.
const LIVE: PlanRow[] = [
  { id: "1", slug: "launch", name: "Launch", price_cents: 74900 },
  { id: "2", slug: "professional", name: "Professional", price_cents: 275000 },
  { id: "3", slug: "growth", name: "Growth", price_cents: 650000 },
  { id: "4", slug: "enterprise", name: "Enterprise", price_cents: 1750000 },
];

describe("orderRenames — the slug collision that would break the cutover", () => {
  it("vacates growth before professional moves into it", () => {
    // Naively renaming professional→growth first hits the live growth row's
    // unique slug index. Growth must become scale first.
    const { ordered, blocked } = orderRenames(
      [
        { from: "professional", to: "growth", name: "Growth" },
        { from: "growth", to: "scale", name: "Scale" },
      ],
      new Set(["launch", "professional", "growth", "enterprise"]),
    );
    expect(blocked).toEqual([]);
    expect(ordered.map((o) => `${o.from}->${o.to}`)).toEqual([
      "growth->scale",
      "professional->growth",
    ]);
  });

  it("ignores a rename that is already where it belongs", () => {
    const { ordered } = orderRenames(
      [{ from: "launch", to: "launch", name: "Launch" }],
      new Set(["launch"]),
    );
    expect(ordered).toEqual([]);
  });

  it("moves straight away when the target slug is free", () => {
    const { ordered } = orderRenames(
      [{ from: "old", to: "brand-new", name: "New" }],
      new Set(["old"]),
    );
    expect(ordered).toHaveLength(1);
  });

  it("reports a genuine cycle instead of half-applying it", () => {
    // a→b and b→a cannot be done without a temporary name. Better to refuse
    // than to leave the catalog in a state nobody planned.
    const { ordered, blocked } = orderRenames(
      [
        { from: "a", to: "b", name: "B" },
        { from: "b", to: "a", name: "A" },
      ],
      new Set(["a", "b"]),
    );
    expect(ordered).toEqual([]);
    expect(blocked).toHaveLength(2);
  });
});

describe("planCatalogSync", () => {
  const plan = planCatalogSync(LIVE);

  it("plans the three tier moves and leaves enterprise alone", () => {
    expect(plan.renames.map((r) => `${r.from}->${r.to}`)).toEqual([
      "growth->scale",
      "professional->growth",
    ]);
    expect(plan.untouched).toEqual(["enterprise"]);
    expect(plan.warnings).toEqual([]);
  });

  it("mints a monthly and an annual price for every tier", () => {
    expect(plan.prices).toHaveLength(6);
    for (const slug of ["launch", "growth", "scale"]) {
      const forTier = plan.prices.filter((p) => p.tierSlug === slug);
      expect(forTier.map((p) => p.interval).sort()).toEqual(["month", "year"]);
    }
  });

  it("prices the tiers at the model's headline (with AML/CTF) figures", () => {
    const monthly = (slug: string) =>
      plan.prices.find((p) => p.tierSlug === slug && p.interval === "month")!.unitAmount;
    expect(monthly("launch")).toBe(99900);
    expect(monthly("growth")).toBe(139900);
    expect(monthly("scale")).toBe(269900);
  });

  it("carries the without-AML figure alongside, so both can be shown", () => {
    const base = (slug: string) =>
      plan.prices.find((p) => p.tierSlug === slug && p.interval === "month")!.baseAmount;
    expect(base("launch")).toBe(84900);
    expect(base("growth")).toBe(124900);
    expect(base("scale")).toBe(254900);
    expect(plan.prices.every((p) => p.includesAml)).toBe(true);
  });

  it("keeps the two figures exactly $150 apart on every tier", () => {
    // The whole AML structure reduced to the one thing Stripe acts on: the
    // amount charged moves by the net uplift, never by the $400 reference.
    for (const p of plan.prices.filter((x) => x.interval === "month")) {
      expect(p.unitAmount - p.baseAmount).toBe(15000);
    }
  });

  // The amounts Apply mints for the annual plan: twelve months of the headline
  // less clause 5.1's 15%, the same figures an agreement's annual prepayment
  // states for the with-AML base.
  it("prices the annual plan at twelve months of the base less 15%", () => {
    const yearly = (slug: string) =>
      plan.prices.find((p) => p.tierSlug === slug && p.interval === "year")!.unitAmount;
    expect(yearly("launch")).toBe(annualCents(99900));
    expect(yearly("launch")).toBe(1018980);
    expect(yearly("growth")).toBe(1426980);
    expect(yearly("scale")).toBe(2752980);
  });

  it("carries the GST contained in each amount, never added to it", () => {
    for (const p of plan.prices) {
      expect(p.gstComponent).toBe(gstComponentCents(p.unitAmount));
      expect(p.gstComponent).toBeLessThan(p.unitAmount);
    }
  });

  it("flags a tier with no row to reuse instead of silently skipping it", () => {
    // With Professional gone, the surviving 'growth' row is read as the Growth
    // tier itself rather than as Scale's source — so it is Scale that has
    // nothing left to reuse, and Scale that gets reported.
    const withoutProfessional = LIVE.filter((r) => r.slug !== "professional");
    const p = planCatalogSync(withoutProfessional);
    expect(p.missing).toContain("scale");
    expect(p.renames.find((r) => r.to === "growth")).toBeUndefined();
    expect(p.warnings.join(" ")).toMatch(/no catalog row available to become 'scale'/i);
  });

  it("is stable — planning twice gives the same plan", () => {
    expect(planCatalogSync(LIVE)).toEqual(plan);
  });
});

describe("tierApplyOrder — the bug that made Apply fail", () => {
  // Apply iterated TIERS in declaration order (launch, growth, scale) and threw
  // away the ordering the planner had just computed. So it tried to rename the
  // old Professional row to 'growth' while the live Growth row still held that
  // slug, and Postgres rejected it on the unique index. The plan was right; the
  // execution ignored it.
  const plan = planCatalogSync(LIVE);

  it("writes Scale before Growth, so the slug has vacated first", () => {
    const order = tierApplyOrder(plan).map((t) => t.slug);
    expect(order.indexOf("scale")).toBeLessThan(order.indexOf("growth"));
  });

  it("puts tiers that are not moving slug first — they cannot collide", () => {
    expect(tierApplyOrder(plan)[0].slug).toBe("launch");
  });

  it("never drops or duplicates a tier", () => {
    const order = tierApplyOrder(plan)
      .map((t) => t.slug)
      .sort();
    expect(order).toEqual(["growth", "launch", "scale"]);
  });

  it("no slug is ever written while still occupied", () => {
    // Replays the whole cutover against the live slug set.
    const occupied = new Set(LIVE.map((r) => r.slug));
    for (const tier of tierApplyOrder(plan)) {
      const rename = plan.renames.find((r) => r.to === tier.slug);
      if (!rename) continue;
      expect(occupied.has(rename.to)).toBe(false);
      occupied.delete(rename.from);
      occupied.add(rename.to);
    }
  });

  it("is a no-op ordering when nothing needs renaming", () => {
    const settled: PlanRow[] = [
      { id: "1", slug: "launch", name: "Launch", price_cents: 69900 },
      { id: "2", slug: "growth", name: "Growth", price_cents: 105500 },
      { id: "3", slug: "scale", name: "Scale", price_cents: 221000 },
    ];
    const p = planCatalogSync(settled);
    expect(p.renames).toEqual([]);
    expect(tierApplyOrder(p).map((t) => t.slug)).toEqual(["launch", "growth", "scale"]);
  });
});

describe("the cutover can be re-run after a partial failure", () => {
  // The state their first Apply left behind: Scale was renamed successfully,
  // Growth collided and never moved. A retry has to pick up from here.
  const HALF_APPLIED: PlanRow[] = [
    { id: "1", slug: "launch", name: "Launch", price_cents: 69900 },
    { id: "2", slug: "professional", name: "Professional", price_cents: 275000 },
    { id: "3", slug: "scale", name: "Scale", price_cents: 221000 },
    { id: "4", slug: "enterprise", name: "Enterprise", price_cents: 1750000 },
  ];

  it("does not warn about a rename a previous run already made", () => {
    // This is what blocked recovery: runCatalogSync refuses to apply while
    // there are warnings, so a half-finished cutover could never be finished.
    const p = planCatalogSync(HALF_APPLIED);
    expect(p.warnings).toEqual([]);
    expect(p.missing).toEqual([]);
  });

  it("still moves the rename that failed", () => {
    const p = planCatalogSync(HALF_APPLIED);
    expect(p.renames.map((r) => `${r.from}->${r.to}`)).toEqual(["professional->growth"]);
  });

  it("leaves the already-moved tier in place and still writes it", () => {
    const p = planCatalogSync(HALF_APPLIED);
    // No rename for scale means apply targets `scale` itself, so its row is
    // still brought up to the new price rather than skipped.
    expect(p.renames.find((r) => r.to === "scale")).toBeUndefined();
    expect(p.prices.filter((x) => x.tierSlug === "scale")).toHaveLength(2);
  });

  it("is idempotent once fully applied", () => {
    const DONE: PlanRow[] = [
      { id: "1", slug: "launch", name: "Launch", price_cents: 69900 },
      { id: "2", slug: "growth", name: "Growth", price_cents: 105500 },
      { id: "3", slug: "scale", name: "Scale", price_cents: 221000 },
      { id: "4", slug: "enterprise", name: "Enterprise", price_cents: 1750000 },
    ];
    const p = planCatalogSync(DONE);
    expect(p.renames).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.untouched).toEqual(["enterprise"]);
  });

  it("still reports a tier that genuinely has no row at all", () => {
    const p = planCatalogSync([{ id: "1", slug: "launch", name: "Launch", price_cents: 69900 }]);
    expect(p.missing.sort()).toEqual(["growth", "scale"]);
  });
});
