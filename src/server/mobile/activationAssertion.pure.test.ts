import { describe, expect, it } from "vitest";
import {
  activationAudience,
  activationSubject,
  checkActivationPayload,
} from "./activationAssertion.pure";

const B43 = "A".repeat(43);
const NOW = 1_800_000_000;
const expected = {
  issuer: "https://mc.example/clone-issuer",
  audience: activationAudience("gw-1"),
  cloneId: "clone-1",
  nowSeconds: NOW,
};
function payload(over: Record<string, unknown> = {}) {
  return {
    iss: expected.issuer,
    aud: expected.audience,
    sub: activationSubject("clone-1"),
    iat: NOW,
    exp: NOW + 60,
    jti: "jti-0123456789abcdef",
    purpose: "mobile_activation",
    clone_id: "clone-1",
    gateway_id: "gw-1",
    portal: "command-centre",
    principal_kind: "superadmin",
    principal_ref: "user-1",
    grant_ref: "mga_x",
    install_id: "install-0123456789",
    device_thumbprint: B43,
    code_challenge: B43,
    code_challenge_method: "S256",
    ...over,
  };
}

describe("checkActivationPayload", () => {
  it("accepts a well-formed payload", () => {
    expect(checkActivationPayload(payload(), expected).ok).toBe(true);
  });

  it("refuses another clone's audience, subject or clone id", () => {
    expect(checkActivationPayload(payload({ aud: activationAudience("gw-2") }), expected)).toEqual({
      ok: false,
      reason: "audience",
    });
    expect(checkActivationPayload(payload({ sub: "clone:other" }), expected)).toEqual({
      ok: false,
      reason: "subject",
    });
    expect(checkActivationPayload(payload({ clone_id: "other" }), expected)).toEqual({
      ok: false,
      reason: "clone",
    });
  });

  it("refuses a long-lived or expired assertion", () => {
    expect(checkActivationPayload(payload({ exp: NOW + 300 }), expected)).toEqual({
      ok: false,
      reason: "lifetime",
    });
    expect(checkActivationPayload(payload({ iat: NOW - 200, exp: NOW - 140 }), expected)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses a payload for another purpose or without PKCE", () => {
    expect(checkActivationPayload(payload({ purpose: "builders" }), expected).ok).toBe(false);
    expect(checkActivationPayload(payload({ code_challenge_method: "plain" }), expected)).toEqual({
      ok: false,
      reason: "pkce",
    });
  });

  it("carries no password or refresh token field", () => {
    const keys = Object.keys(payload());
    expect(keys.some((k) => /password|refresh/i.test(k))).toBe(false);
  });
});
