import { describe, expect, it } from "vitest";
import { trialOfferCodeFrom } from "./lead-capture.server";

describe("trialOfferCodeFrom", () => {
  it("keeps the website's trial offer code, normalised", () => {
    expect(trialOfferCodeFrom({ trialOfferCode: "partner-30" })).toBe("PARTNER-30");
    expect(trialOfferCodeFrom({ trial_offer_code: " EXPO 2027 " })).toBe("EXPO-2027");
  });
  it("drops anything that is not a code, and a lead with none has none", () => {
    expect(trialOfferCodeFrom({ trialOfferCode: "<script>" })).toBeNull();
    expect(trialOfferCodeFrom({ trialOfferCode: 30 })).toBeNull();
    expect(trialOfferCodeFrom({})).toBeNull();
  });
});
