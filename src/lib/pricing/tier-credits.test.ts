// The monthly credit allowance each tier includes.
//
// These are not decoration: the same numbers are seeded into billing_plans,
// granted into a real token balance on a plan change, and printed on the
// pricing page. A drift here is a workspace that paid for one allowance and
// received another, so the figures are pinned rather than assumed.
import { describe, expect, it } from "vitest";
import { TIERS, tierBySlug, tierCreditRateCents, tierHeadlineCents } from "./aurixa-catalog";

describe("the allowances, as configured", () => {
  it.each([
    ["launch", 7_000],
    ["growth", 35_000],
    ["scale", 75_000],
  ])("%s includes %i credits a month", (slug, credits) => {
    expect(tierBySlug(slug as string)!.monthlyCredits).toBe(credits);
  });

  it("gives every sold tier an allowance", () => {
    // A tier with none would advertise a plan that grants nothing, which is
    // the state this replaced.
    for (const tier of TIERS) expect(tier.monthlyCredits).toBeGreaterThan(0);
  });

  it("never gives a dearer tier fewer credits", () => {
    const byPrice = [...TIERS].sort((a, b) => tierHeadlineCents(a) - tierHeadlineCents(b));
    for (let i = 1; i < byPrice.length; i++) {
      expect(byPrice[i].monthlyCredits).toBeGreaterThan(byPrice[i - 1].monthlyCredits);
    }
  });
});

describe("what the allowance is worth", () => {
  it("gets cheaper per credit as the tier goes up", () => {
    // The same property the top-up ladder has, and for the same reason: paying
    // more must never buy credits at a worse rate.
    const byPrice = [...TIERS].sort((a, b) => tierHeadlineCents(a) - tierHeadlineCents(b));
    for (let i = 1; i < byPrice.length; i++) {
      expect(tierCreditRateCents(byPrice[i])).toBeLessThan(tierCreditRateCents(byPrice[i - 1]));
    }
  });

  it("records where each tier sits against the top-up ladder", () => {
    // Worth stating rather than assuming, because the answer is not uniform
    // and the obvious guess is wrong. Attributing a tier's whole price to its
    // credits is the wrong model — the price buys the platform — but the
    // comparison still says something real about the entry tier:
    //
    //   Launch  $699   / 7,000  = 9.99c  — dearer than the 8.36c top-up rate
    //   Growth  $1,055 / 35,000 = 3.01c  — cheaper than any pack
    //   Scale   $2,210 / 75,000 = 2.95c  — cheaper still
    //
    // So on Launch the credits are an inclusion, not the value; from Growth up
    // the allowance alone is worth more than the subscription. If that stops
    // being true this test says so.
    expect(tierCreditRateCents(tierBySlug("launch")!)).toBeGreaterThan(8.36);
    expect(tierCreditRateCents(tierBySlug("growth")!)).toBeLessThan(4.76);
    expect(tierCreditRateCents(tierBySlug("scale")!)).toBeLessThan(4.76);
  });

  it("is measured against the price actually charged", () => {
    // Launch: $999 incl GST for 7,000 credits.
    expect(tierCreditRateCents(tierBySlug("launch")!)).toBeCloseTo(99900 / 7000, 6);
    expect(tierCreditRateCents(tierBySlug("scale")!)).toBeCloseTo(269900 / 75000, 6);
  });

  it("is zero rather than infinite for a tier with no credits", () => {
    expect(tierCreditRateCents({ ...TIERS[0], monthlyCredits: 0 })).toBe(0);
  });
});
