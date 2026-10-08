import { describe, expect, it } from "vitest";
import { eligibilityFactsFrom, seatAvailableFrom, type GatewayFactsRow } from "./claimFacts.pure";
import { assessNativeEligibility } from "./eligibility.pure";

const now = new Date("2026-11-01T00:00:00Z");
const gw: GatewayFactsRow = {
  status: "active",
  cohort_enabled: true,
  licensed_portals: ["command-centre"],
  trial_started_at: "2026-10-01T00:00:00Z",
  trial_extension_hours: 0,
  legacy_clone: false,
  exception_granted_at: null,
};

describe("eligibilityFactsFrom", () => {
  it("a paid, unlocked, ready clone past its trial is eligible", () => {
    const facts = eligibilityFactsFrom({
      gateway: { ok: true, row: gw },
      backendStatus: { ok: true, row: { status: "ready" } },
      gate: { ok: true, row: { paid: true, locked: false } },
      portal: "command-centre",
      now,
    });
    expect(assessNativeEligibility(facts).outcome).toBe("eligible");
  });

  it("every failed read is unknown, never a yes", () => {
    const facts = eligibilityFactsFrom({
      gateway: { ok: false },
      backendStatus: { ok: false },
      gate: { ok: false },
      portal: "command-centre",
      now,
    });
    expect(facts.cohortEnabled).toBeNull();
    expect(facts.provisioningVerified).toBeNull();
    expect(facts.paymentVerified).toBeNull();
    expect(facts.subscriptionCurrent).toBeNull();
    expect(facts.portalLicensed).toBeNull();
    expect(facts.suspended).toBeNull();
    expect(assessNativeEligibility(facts).outcome).toBe("unknown");
  });

  it("no gate row verifies no payment, and locks nothing", () => {
    const facts = eligibilityFactsFrom({
      gateway: { ok: true, row: gw },
      backendStatus: { ok: true, row: { status: "ready" } },
      gate: { ok: true, row: null },
      portal: "command-centre",
      now,
    });
    expect(facts.paymentVerified).toBe(false);
    expect(facts.subscriptionCurrent).toBe(true);
    expect(assessNativeEligibility(facts).code).toBe("PAYMENT_NOT_VERIFIED");
  });

  it("an unlicensed portal and a suspended gateway are named", () => {
    const base = {
      backendStatus: { ok: true as const, row: { status: "ready" } },
      gate: { ok: true as const, row: { paid: true, locked: false } },
      now,
    };
    expect(
      eligibilityFactsFrom({ ...base, gateway: { ok: true, row: gw }, portal: "client" })
        .portalLicensed,
    ).toBe(false);
    expect(
      eligibilityFactsFrom({
        ...base,
        gateway: { ok: true, row: { ...gw, status: "suspended" } },
        portal: "command-centre",
      }).suspended,
    ).toBe(true);
  });

  it("a missing backend row is not provisioned", () => {
    expect(
      eligibilityFactsFrom({
        gateway: { ok: true, row: gw },
        backendStatus: { ok: true, row: null },
        gate: { ok: true, row: null },
        portal: "command-centre",
        now,
      }).provisioningVerified,
    ).toBe(false);
  });
});

describe("seatAvailableFrom", () => {
  it("unmetered when there is no entitlement or no limit", () => {
    expect(seatAvailableFrom({ entitlement: { ok: true, row: null }, boundDevices: null })).toBe(
      true,
    );
    expect(
      seatAvailableFrom({ entitlement: { ok: true, row: { seat_limit: null } }, boundDevices: 9 }),
    ).toBe(true);
  });
  it("caps at the plan's limit", () => {
    const e = { ok: true as const, row: { seat_limit: 2 } };
    expect(seatAvailableFrom({ entitlement: e, boundDevices: 1 })).toBe(true);
    expect(seatAvailableFrom({ entitlement: e, boundDevices: 2 })).toBe(false);
  });
  it("a failed read is unknown", () => {
    expect(seatAvailableFrom({ entitlement: { ok: false }, boundDevices: 0 })).toBeNull();
    expect(
      seatAvailableFrom({ entitlement: { ok: true, row: { seat_limit: 3 } }, boundDevices: null }),
    ).toBeNull();
  });
});
