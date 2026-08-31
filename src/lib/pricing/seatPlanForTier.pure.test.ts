import { describe, expect, it } from "vitest";
import { seatPlanForTier, seatPlanSlugForTier } from "./seatPlanForTier.pure";

/** The catalogue as it stands before the rename: launch, professional, growth.
 *  `growth` here is the row destined to BECOME Scale. */
const PRE_CUTOVER = [
  { slug: "launch", price_cents: 50400 },
  { slug: "professional", price_cents: 86000 },
  { slug: "growth", price_cents: 201500 },
  { slug: "enterprise", price_cents: 499000 },
];

/** After the rename: launch, growth, scale. `growth` here IS Growth. */
const POST_CUTOVER = [
  { slug: "launch", price_cents: 50400 },
  { slug: "growth", price_cents: 86000 },
  { slug: "scale", price_cents: 201500 },
  { slug: "enterprise", price_cents: 499000 },
];

describe("seatPlanSlugForTier", () => {
  it("before the cutover, Growth is the row called `professional`", () => {
    // The whole point. A naive slug match would take the row called `growth`,
    // which before the cutover is Scale at $2,015 — so a customer quoted $860
    // would be charged $2,015.
    expect(seatPlanSlugForTier("growth", PRE_CUTOVER)).toBe("professional");
  });

  it("before the cutover, Scale is the row called `growth`", () => {
    expect(seatPlanSlugForTier("scale", PRE_CUTOVER)).toBe("growth");
  });

  it("after the cutover, every tier is its own slug", () => {
    expect(seatPlanSlugForTier("launch", POST_CUTOVER)).toBe("launch");
    expect(seatPlanSlugForTier("growth", POST_CUTOVER)).toBe("growth");
    expect(seatPlanSlugForTier("scale", POST_CUTOVER)).toBe("scale");
  });

  it("launch is its own row in both, because it replaces itself", () => {
    expect(seatPlanSlugForTier("launch", PRE_CUTOVER)).toBe("launch");
  });

  it("a half-done cutover does not hand one row to two tiers", () => {
    // `professional` renamed, `growth` not yet: Growth has settled on its own
    // slug, so Scale must NOT also take it.
    const half = [
      { slug: "launch", price_cents: 50400 },
      { slug: "growth", price_cents: 86000 },
    ];
    expect(seatPlanSlugForTier("growth", half)).toBe("growth");
    expect(seatPlanSlugForTier("scale", half)).toBeNull();
  });

  it("a slug that is not a catalogue tier resolves only to itself", () => {
    expect(seatPlanSlugForTier("enterprise", POST_CUTOVER)).toBe("enterprise");
    expect(seatPlanSlugForTier("nonsense", POST_CUTOVER)).toBeNull();
  });

  it("an empty catalogue resolves nothing rather than guessing", () => {
    expect(seatPlanSlugForTier("growth", [])).toBeNull();
  });
});

describe("seatPlanForTier", () => {
  it("returns the right row and its quoted price on both catalogues", () => {
    for (const rows of [PRE_CUTOVER, POST_CUTOVER]) {
      const growth = seatPlanForTier("growth", rows, 86000);
      expect(growth.ok).toBe(true);
      if (growth.ok) expect(growth.row.price_cents).toBe(86000);

      const scale = seatPlanForTier("scale", rows, 201500);
      expect(scale.ok).toBe(true);
      if (scale.ok) expect(scale.row.price_cents).toBe(201500);
    }
  });

  it("refuses a row that does not cost what the customer was quoted", () => {
    // The backstop. The settling rule is inference about a cutover this
    // process cannot observe, and the cost of inferring wrong is a customer
    // charged more than twice what they agreed to.
    const wrong = seatPlanForTier("growth", POST_CUTOVER, 201500);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.reason).toBe("price_mismatch");
      expect(wrong.rowCents).toBe(86000);
    }
  });

  it("nothing quoted means nothing to check", () => {
    expect(seatPlanForTier("growth", POST_CUTOVER, null).ok).toBe(true);
  });

  it("no row at all is refused rather than substituted", () => {
    const r = seatPlanForTier("scale", [{ slug: "launch", price_cents: 50400 }], 201500);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_row");
  });
});
