import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHOICE,
  choiceFromStored,
  normaliseOfferCode,
  pickableOffers,
  resolveTrialChoice,
  websiteOfferStatus,
  type TrialOfferSummary,
} from "./trialOffers.pure";

const PARTNER: TrialOfferSummary = {
  id: "00000000-0000-4000-8000-000000000001",
  code: "PARTNER-30",
  label: "Partner referral",
  trial_days: 30,
  active: true,
  expires_at: null,
};
const RETIRED: TrialOfferSummary = {
  ...PARTNER,
  id: "00000000-0000-4000-8000-000000000002",
  code: "EXPO-21",
  label: "Expo 2026",
  trial_days: 21,
  active: false,
};
const context = { offers: [PARTNER, RETIRED], defaultHours: 336 };

describe("resolveTrialChoice", () => {
  it("leaves the default's hours to the moment of arming", () => {
    // Undefined, not 336: a default an admin changes between this screen and
    // the arming is the default the gate gets.
    expect(resolveTrialChoice(DEFAULT_CHOICE, context)).toEqual({
      ok: true,
      hours: undefined,
      days: 14,
      offerCode: null,
      summary: "the platform default (14 days)",
    });
  });

  it("summarises the default with the fallback when the live one is unknown", () => {
    const resolved = resolveTrialChoice(DEFAULT_CHOICE, { offers: [], defaultHours: null });
    expect(resolved.ok && resolved.summary).toBe("the platform default (14 days)");
  });

  it("turns typed days into hours", () => {
    expect(resolveTrialChoice({ kind: "days", days: "45" }, context)).toEqual({
      ok: true,
      hours: 1080,
      days: 45,
      offerCode: null,
      summary: "45 days",
    });
  });

  it("refuses typed days it cannot use, in words", () => {
    expect(resolveTrialChoice({ kind: "days", days: "" }, context)).toEqual({
      ok: false,
      error: "Enter the trial length in days.",
    });
    expect(resolveTrialChoice({ kind: "days", days: "2.5" }, context)).toMatchObject({ ok: false });
    expect(resolveTrialChoice({ kind: "days", days: "400" }, context)).toEqual({
      ok: false,
      error: "A trial is between 1 and 365 days.",
    });
  });

  it("an offer gives its days and records its code", () => {
    expect(resolveTrialChoice({ kind: "offer", offerId: PARTNER.id }, context)).toEqual({
      ok: true,
      hours: 720,
      days: 30,
      offerCode: "PARTNER-30",
      summary: "Partner referral — 30 days",
    });
  });

  it("a retired or missing offer is refused rather than defaulted", () => {
    expect(resolveTrialChoice({ kind: "offer", offerId: RETIRED.id }, context)).toEqual({
      ok: false,
      error: "Expo 2026 has been retired.",
    });
    expect(resolveTrialChoice({ kind: "offer", offerId: "nope" }, context)).toMatchObject({
      ok: false,
    });
  });
});

describe("choiceFromStored", () => {
  it("null days is the default", () => {
    expect(choiceFromStored({ trial_days: null, trial_offer_code: null }, [PARTNER])).toEqual(
      DEFAULT_CHOICE,
    );
  });
  it("rebuilds the offer while it still gives the same days", () => {
    expect(choiceFromStored({ trial_days: 30, trial_offer_code: "PARTNER-30" }, [PARTNER])).toEqual(
      { kind: "offer", offerId: PARTNER.id },
    );
  });
  it("shows the stored days once the offer has changed, because the days are what provision", () => {
    const changed = { ...PARTNER, trial_days: 45 };
    expect(choiceFromStored({ trial_days: 30, trial_offer_code: "PARTNER-30" }, [changed])).toEqual(
      { kind: "days", days: "30" },
    );
    expect(choiceFromStored({ trial_days: 30, trial_offer_code: "GONE" }, [])).toEqual({
      kind: "days",
      days: "30",
    });
  });
});

describe("normaliseOfferCode", () => {
  it("upper-cases and joins words with hyphens", () => {
    expect(normaliseOfferCode(" partner 30 ")).toEqual({ ok: true, code: "PARTNER-30" });
    expect(normaliseOfferCode("expo-2027")).toEqual({ ok: true, code: "EXPO-2027" });
  });
  it("refuses blanks, punctuation and lengths outside 2–32", () => {
    expect(normaliseOfferCode("")).toEqual({ ok: false, error: "required" });
    expect(normaliseOfferCode("A")).toEqual({ ok: false, error: "bad_shape" });
    expect(normaliseOfferCode("30%OFF")).toEqual({ ok: false, error: "bad_shape" });
    expect(normaliseOfferCode("-LEADING")).toEqual({ ok: false, error: "bad_shape" });
    expect(normaliseOfferCode("X".repeat(33))).toEqual({ ok: false, error: "bad_shape" });
  });
  it("matches the database's CHECK", () => {
    // trial_offers_code_shape: ^[A-Z0-9][A-Z0-9-]{1,31}$
    expect(normaliseOfferCode("AB")).toEqual({ ok: true, code: "AB" });
    expect(normaliseOfferCode("X".repeat(32))).toEqual({ ok: true, code: "X".repeat(32) });
  });
});

describe("websiteOfferStatus", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  it("accepts an active offer with no end, or one that has not ended", () => {
    expect(websiteOfferStatus(PARTNER, now)).toBe("accepted");
    expect(websiteOfferStatus({ ...PARTNER, expires_at: "2026-12-01T00:00:00Z" }, now)).toBe(
      "accepted",
    );
  });
  it("names why it refuses", () => {
    expect(websiteOfferStatus(null, now)).toBe("unknown");
    expect(websiteOfferStatus(RETIRED, now)).toBe("retired");
    expect(websiteOfferStatus({ ...PARTNER, expires_at: "2026-11-01T00:00:00Z" }, now)).toBe(
      "expired",
    );
  });
});

describe("pickableOffers", () => {
  it("lists active offers only, by label", () => {
    const b = { ...PARTNER, id: "b", label: "Beta testers" };
    expect(pickableOffers([PARTNER, RETIRED, b]).map((o) => o.label)).toEqual([
      "Beta testers",
      "Partner referral",
    ]);
  });
});
