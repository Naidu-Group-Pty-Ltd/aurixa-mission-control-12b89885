import { describe, expect, it } from "vitest";
import { decideClaim, nextGrantStatus, type ClaimInput } from "./grants.pure";
import type { EligibilityVerdict } from "./eligibility.pure";

const ELIGIBLE: EligibilityVerdict = {
  outcome: "eligible",
  code: "ELIGIBLE",
  effectiveTrialEnd: null,
  message: "",
};

function input(over: Partial<ClaimInput> = {}): ClaimInput {
  return {
    grant: {
      status: "active",
      portal: "command-centre",
      device_install_id: null,
      device_thumbprint: null,
    },
    ticket: "valid",
    requestedPortal: "command-centre",
    installId: "install-a",
    deviceThumbprint: "thumb-a",
    eligibility: ELIGIBLE,
    gatewayStatus: "active",
    seatAvailable: true,
    ...over,
  };
}

describe("grant state machine", () => {
  it("allows only the documented transitions", () => {
    expect(nextGrantStatus("issuable", "issue_link")).toBe("active");
    expect(nextGrantStatus("issuable", "claim")).toBeNull();
    expect(nextGrantStatus("active", "claim")).toBe("device_bound");
    expect(nextGrantStatus("device_bound", "reissue")).toBe("active");
    expect(nextGrantStatus("revoked", "issue_link")).toBeNull();
    expect(nextGrantStatus("revoked", "claim")).toBeNull();
  });
});

describe("decideClaim", () => {
  it("binds a device on the first valid claim", () => {
    expect(decideClaim(input())).toEqual({ ok: true, bindsDevice: true });
  });

  it("reads an unknown grant and a missing ticket the same", () => {
    const a = decideClaim(input({ grant: null }));
    const b = decideClaim(input({ ticket: "missing" }));
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: false, code: "AUTH_REQUIRED" });
  });

  it("refuses a used, expired, revoked or wrong-portal ticket", () => {
    expect(decideClaim(input({ ticket: "used" }))).toMatchObject({ code: "TICKET_USED" });
    expect(decideClaim(input({ ticket: "expired" }))).toMatchObject({ code: "INVITE_EXPIRED" });
    expect(decideClaim(input({ grant: { ...input().grant!, status: "revoked" } }))).toMatchObject({
      code: "GRANT_REVOKED",
    });
    expect(decideClaim(input({ requestedPortal: "client" }))).toMatchObject({
      code: "CONTEXT_MISMATCH",
    });
  });

  it("refuses a second device and lets the bound device retry", () => {
    const bound = {
      status: "device_bound" as const,
      portal: "command-centre" as const,
      device_install_id: "install-a",
      device_thumbprint: "thumb-a",
    };
    expect(
      decideClaim(input({ grant: bound, installId: "install-b", deviceThumbprint: "thumb-b" })),
    ).toMatchObject({ code: "ALREADY_CLAIMED" });
    expect(decideClaim(input({ grant: bound, ticket: "used_by_this_install" }))).toEqual({
      ok: true,
      bindsDevice: false,
    });
  });

  it("refuses the same install id presenting a different device key", () => {
    const bound = {
      status: "device_bound" as const,
      portal: "command-centre" as const,
      device_install_id: "install-a",
      device_thumbprint: "thumb-a",
    };
    expect(
      decideClaim(
        input({ grant: bound, ticket: "used_by_this_install", deviceThumbprint: "thumb-x" }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses an issuable grant: no link was ever sent", () => {
    expect(decideClaim(input({ grant: { ...input().grant!, status: "issuable" } }))).toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("refuses an ineligible or suspended workspace with its reason", () => {
    const trial: EligibilityVerdict = {
      outcome: "denied",
      code: "TRIAL_NOT_ENDED",
      effectiveTrialEnd: null,
      message: "m",
    };
    expect(decideClaim(input({ eligibility: trial }))).toMatchObject({
      status: 403,
      code: "TRIAL_NOT_ENDED",
    });
    expect(decideClaim(input({ gatewayStatus: "suspended" }))).toMatchObject({
      code: "SESSION_REVOKED",
    });
    expect(decideClaim(input({ gatewayStatus: null }))).toMatchObject({ code: "SESSION_REVOKED" });
  });

  it("refuses a portal whose native session is not built yet", () => {
    const g = {
      status: "active" as const,
      portal: "solicitor" as const,
      device_install_id: null,
      device_thumbprint: null,
    };
    expect(decideClaim(input({ grant: g, requestedPortal: "solicitor" }))).toMatchObject({
      code: "VERSION_INCOMPATIBLE",
    });
  });

  it("refuses a new device with no free seat, and an unreadable seat count", () => {
    expect(decideClaim(input({ seatAvailable: false }))).toMatchObject({ code: "SEAT_LIMIT" });
    expect(decideClaim(input({ seatAvailable: null }))).toMatchObject({
      code: "ENTITLEMENT_UNAVAILABLE",
    });
  });
});
