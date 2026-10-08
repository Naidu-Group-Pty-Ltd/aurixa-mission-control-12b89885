import { describe, expect, it } from "vitest";
import {
  assessNativeEligibility,
  claimErrorCodeFor,
  effectiveTrialEnd,
  type EligibilityFacts,
} from "./eligibility.pure";

const START = "2026-10-01T00:00:00.000Z";
const AFTER_TRIAL = "2026-10-15T00:00:01.000Z";

function facts(over: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    cohortEnabled: true,
    provisioningVerified: true,
    trialStartedAt: START,
    trialExtensionHours: 0,
    now: AFTER_TRIAL,
    paymentVerified: true,
    subscriptionCurrent: true,
    portalLicensed: true,
    suspended: false,
    legacyClone: false,
    exceptionGrantedAt: null,
    ...over,
  };
}

describe("effectiveTrialEnd", () => {
  it("is fourteen days of hours after the trial start, plus authorised extensions", () => {
    expect(effectiveTrialEnd(START, 0)).toBe("2026-10-15T00:00:00.000Z");
    expect(effectiveTrialEnd(START, 48)).toBe("2026-10-17T00:00:00.000Z");
  });
  it("has no end without a trial-start event, or with a negative extension", () => {
    expect(effectiveTrialEnd(null, 0)).toBeNull();
    expect(effectiveTrialEnd(START, -1)).toBeNull();
  });
});

describe("assessNativeEligibility (Draft 02 §11)", () => {
  it("admits a clone that meets every condition", () => {
    expect(assessNativeEligibility(facts())).toMatchObject({
      outcome: "eligible",
      code: "ELIGIBLE",
    });
  });

  it("refuses while the trial is still running, even when paid", () => {
    const v = assessNativeEligibility(facts({ now: "2026-10-14T23:59:59.000Z" }));
    expect(v).toMatchObject({ outcome: "denied", code: "TRIAL_NOT_ENDED" });
    expect(claimErrorCodeFor(v)).toBe("TRIAL_NOT_ENDED");
  });

  it("an extension moves the end", () => {
    expect(assessNativeEligibility(facts({ trialExtensionHours: 24 })).code).toBe(
      "TRIAL_NOT_ENDED",
    );
  });

  it("refuses an unpaid clone after the trial", () => {
    expect(assessNativeEligibility(facts({ paymentVerified: false })).code).toBe(
      "PAYMENT_NOT_VERIFIED",
    );
  });

  it("refuses a lapsed subscription", () => {
    const v = assessNativeEligibility(facts({ subscriptionCurrent: false }));
    expect(v.code).toBe("ENTITLEMENT_UNAVAILABLE");
    expect(claimErrorCodeFor(v)).toBe("ENTITLEMENT_UNAVAILABLE");
  });

  it("refuses an unlicensed portal and a suspended clone, ahead of any clock", () => {
    expect(assessNativeEligibility(facts({ portalLicensed: false, now: START })).code).toBe(
      "PORTAL_NOT_LICENSED",
    );
    expect(assessNativeEligibility(facts({ suspended: true, now: START })).code).toBe("SUSPENDED");
  });

  it("refuses when the cohort is off or provisioning is unverified", () => {
    expect(assessNativeEligibility(facts({ cohortEnabled: false })).code).toBe("COHORT_DISABLED");
    expect(assessNativeEligibility(facts({ provisioningVerified: false })).code).toBe(
      "PROVISIONING_UNVERIFIED",
    );
  });

  it("treats every unreadable fact as unknown, which grants nothing", () => {
    const unknowns: Array<Partial<EligibilityFacts>> = [
      { cohortEnabled: null },
      { provisioningVerified: null },
      { portalLicensed: null },
      { suspended: null },
      { paymentVerified: null },
      { subscriptionCurrent: null },
      { trialStartedAt: null },
      { now: "not a date" },
    ];
    for (const u of unknowns) {
      const v = assessNativeEligibility(facts(u));
      expect(v.outcome, JSON.stringify(u)).toBe("unknown");
      expect(claimErrorCodeFor(v)).not.toBeNull();
    }
  });

  it("gives a legacy clone no retrial: payment evidence alone admits it", () => {
    expect(
      assessNativeEligibility(
        facts({ legacyClone: true, trialStartedAt: null, paymentVerified: true }),
      ).outcome,
    ).toBe("eligible");
    expect(
      assessNativeEligibility(
        facts({ legacyClone: true, trialStartedAt: null, paymentVerified: false }),
      ).code,
    ).toBe("PAYMENT_NOT_VERIFIED");
  });

  it("lets an attributed exception stand in for the trial and payment, never the licence or a suspension", () => {
    const ex = {
      exceptionGrantedAt: "2026-10-02T00:00:00.000Z",
      paymentVerified: false,
      now: START,
    };
    expect(assessNativeEligibility(facts(ex)).outcome).toBe("eligible");
    expect(assessNativeEligibility(facts({ ...ex, portalLicensed: false })).code).toBe(
      "PORTAL_NOT_LICENSED",
    );
    expect(assessNativeEligibility(facts({ ...ex, suspended: true })).code).toBe("SUSPENDED");
  });

  it("words its message about the workspace, never the person", () => {
    for (const code of ["TRIAL_NOT_ENDED", "PAYMENT_NOT_VERIFIED", "SUSPENDED"] as const) {
      const v = assessNativeEligibility(
        facts(
          code === "TRIAL_NOT_ENDED"
            ? { now: START }
            : code === "SUSPENDED"
              ? { suspended: true }
              : { paymentVerified: false },
        ),
      );
      expect(v.message).toMatch(/workspace/);
      expect(v.message).not.toMatch(/\byou\b/i);
    }
  });
});
