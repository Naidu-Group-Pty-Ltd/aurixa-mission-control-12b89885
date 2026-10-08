/**
 * The activation assertion: what Mission Control hands the app after a claim,
 * and what the clone turns into a native session.
 *
 * It is signed by the same RS256 federation signer every other clone assertion
 * uses (`signCloneAssertion`), published at the same key set, so a clone holds
 * one JWKS URL and no second key. Three things make it single-purpose.
 *
 * - **Its audience is ONE clone's gateway** — `<origin>/activate/<gateway_id>`
 *   — so an assertion for one workspace is refused by every other.
 * - **It lives sixty seconds and its `jti` is spent once**, by the clone's
 *   `native_activation_jtis`.
 * - **It carries the PKCE challenge and the device thumbprint**, so only the
 *   installation that claimed it, holding the verifier and the device key, can
 *   exchange it. A copied assertion is useless to anyone else.
 *
 * No password and no refresh token is in it, or in anything that leads to it.
 *
 * The verifier below is the specification the clone's
 * `_shared/nativeAuth/assertion.pure.ts` mirrors; the two are kept in step by
 * the fixture both test suites read.
 */

import type { MobilePortal } from "./portals.pure";
import { isMobilePortal, MOBILE_GATEWAY_ORIGIN } from "./portals.pure";

export const ACTIVATION_PURPOSE = "mobile_activation";
export const ACTIVATION_LIFETIME_SECONDS = 60;
/** Tolerance for clock skew between MC and the clone. */
export const ACTIVATION_SKEW_SECONDS = 30;

export type PrincipalKind = "superadmin" | "staff" | "partner" | "client";

export type ActivationClaims = {
  purpose: typeof ACTIVATION_PURPOSE;
  clone_id: string;
  gateway_id: string;
  portal: MobilePortal;
  principal_kind: PrincipalKind;
  principal_ref: string;
  grant_ref: string;
  install_id: string;
  device_thumbprint: string;
  code_challenge: string;
  code_challenge_method: "S256";
};

export function activationAudience(gatewayId: string, origin = MOBILE_GATEWAY_ORIGIN): string {
  return `${origin}/activate/${gatewayId}`;
}

export function activationSubject(cloneId: string): string {
  return `clone:${cloneId}`;
}

const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;

export function isCodeChallenge(v: unknown): v is string {
  return typeof v === "string" && B64URL_43.test(v);
}

/** A device thumbprint is the base64url SHA-256 of the device's public key (RFC 7638 style). */
export function isThumbprint(v: unknown): v is string {
  return typeof v === "string" && B64URL_43.test(v);
}

export function isInstallId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(v);
}

export type VerifiedActivation =
  | { ok: true; claims: ActivationClaims & { jti: string; exp: number; iat: number } }
  | { ok: false; reason: string };

/**
 * Checks a DECODED, signature-verified payload. Signature verification is the
 * caller's (it needs the key set); everything after it is decided here.
 */
export function checkActivationPayload(
  payload: Record<string, unknown>,
  expected: { issuer: string; audience: string; cloneId: string; nowSeconds: number },
): VerifiedActivation {
  const fail = (reason: string): VerifiedActivation => ({ ok: false, reason });
  if (payload.iss !== expected.issuer) return fail("issuer");
  if (payload.aud !== expected.audience) return fail("audience");
  if (payload.sub !== activationSubject(expected.cloneId)) return fail("subject");
  if (payload.purpose !== ACTIVATION_PURPOSE) return fail("purpose");
  if (payload.clone_id !== expected.cloneId) return fail("clone");
  const exp = payload.exp;
  const iat = payload.iat;
  if (typeof exp !== "number" || typeof iat !== "number") return fail("times");
  if (exp - iat > ACTIVATION_LIFETIME_SECONDS) return fail("lifetime");
  if (expected.nowSeconds > exp + ACTIVATION_SKEW_SECONDS) return fail("expired");
  if (iat > expected.nowSeconds + ACTIVATION_SKEW_SECONDS) return fail("not_yet_valid");
  if (typeof payload.jti !== "string" || payload.jti.length < 16) return fail("jti");
  if (!isMobilePortal(payload.portal)) return fail("portal");
  if (!["superadmin", "staff", "partner", "client"].includes(payload.principal_kind as string))
    return fail("principal");
  if (typeof payload.principal_ref !== "string" || !payload.principal_ref) return fail("principal");
  if (typeof payload.grant_ref !== "string" || typeof payload.gateway_id !== "string")
    return fail("grant");
  if (!isInstallId(payload.install_id)) return fail("install");
  if (!isThumbprint(payload.device_thumbprint)) return fail("device");
  if (!isCodeChallenge(payload.code_challenge) || payload.code_challenge_method !== "S256")
    return fail("pkce");
  return {
    ok: true,
    claims: payload as unknown as ActivationClaims & { jti: string; exp: number; iat: number },
  };
}
