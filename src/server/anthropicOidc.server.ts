/**
 * Mission Control as an OIDC issuer, for one purpose.
 *
 * Anthropic's Workload Identity Federation accepts "any standards-compliant
 * OIDC issuer". A clone running on Supabase Edge Functions has no ambient
 * cloud workload identity Anthropic would trust, so Mission Control is the
 * issuer: it already authenticates every clone by the API key it holds, and it
 * already signs RS256 JWT-bearer assertions twice over (DocuSign, Google).
 * This is the third, and it reuses the same WebCrypto shape rather than adding
 * a library.
 *
 * ## What travels, and what does not
 *
 * The private key never leaves this process. What a clone receives is an
 * assertion naming ITSELF, valid for five minutes, useful only against the one
 * federation rule that matches its subject. Compare that with what a clone
 * holds today: a static organisation key, copied onto its project, able to act
 * in every workspace the organisation has, for ever.
 *
 * ## Why `explicit_url` rather than discovery
 *
 * Anthropic offers three ways to find an issuer's keys, and with
 * `{"type": "explicit_url"}` it fetches exactly one URL — the key set below —
 * and compares `issuer_url` as a string. That removes any need to serve
 * `/.well-known/openid-configuration`, which in this router would mean
 * escaping a path segment that begins with a dot for no benefit at all.
 */

import {
  BOOTSTRAP_ISSUER_PATH,
  BOOTSTRAP_SUBJECT,
  CLONE_ISSUER_PATH,
  FEDERATION_KEY_ENV,
  JWKS_PATH,
  identityClaims,
} from "./anthropicFederation.pure";

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function privateKeyPem(): string {
  return (process.env[FEDERATION_KEY_ENV] ?? "").trim();
}

export function signingKeyPresent(): boolean {
  return privateKeyPem().length > 0;
}

/**
 * Mission Control's own public origin.
 *
 * Anthropic fetches the key set from it, so it must be a real public HTTPS
 * host — the same value every clone already holds as `MISSION_CONTROL_URL`.
 */
export function missionControlOrigin(): string {
  const raw = (
    process.env.MISSION_CONTROL_PUBLIC_URL ??
    process.env.VITE_MISSION_CONTROL_URL ??
    process.env.MISSION_CONTROL_URL ??
    ""
  ).trim();
  return raw.replace(/\/+$/, "");
}

export function cloneIssuerUrl(): string {
  return `${missionControlOrigin()}${CLONE_ISSUER_PATH}`;
}

export function bootstrapIssuerUrl(): string {
  return `${missionControlOrigin()}${BOOTSTRAP_ISSUER_PATH}`;
}

export function jwksUrl(): string {
  return `${missionControlOrigin()}${JWKS_PATH}`;
}

function decodeBase64(b64: string) {
  try {
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(`${FEDERATION_KEY_ENV} is not a PKCS8 PEM private key`);
  }
}

/**
 * Import the signing key.
 *
 * `extractable: true` because the public half of the key set below is derived
 * from this same import — there is one key in the environment, not a pair to
 * keep in step, and a published modulus that does not match the signing key is
 * a failure nobody could diagnose from either side.
 */
async function importSigningKey(): Promise<CryptoKey> {
  const pem = privateKeyPem();
  if (!pem) throw new Error(`${FEDERATION_KEY_ENV} is not set`);
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");
  // Inferred rather than annotated: an explicit `Uint8Array` widens its buffer
  // to `ArrayBufferLike`, which `importKey` will not take.
  const der = decodeBase64(b64);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["sign"],
  );
}

export interface PublicJwk {
  kty: string;
  n: string;
  e: string;
  alg: "RS256";
  use: "sig";
  kid: string;
}

/**
 * A key id derived from the modulus.
 *
 * Stable for a given key and different for a different one, so rotating the
 * key rotates the `kid` without anybody choosing a name — and a token signed
 * under the old key stays verifiable for as long as both are published.
 */
async function keyIdFor(modulus: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(modulus));
  return base64Url(new Uint8Array(digest)).slice(0, 32);
}

/** The key set Anthropic fetches. Public halves only — asserted by a test. */
export async function publicJwks(): Promise<{ keys: PublicJwk[] }> {
  const key = await importSigningKey();
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (!jwk.n || !jwk.e) throw new Error(`${FEDERATION_KEY_ENV} did not export a public modulus`);
  return {
    keys: [
      {
        kty: "RSA",
        n: jwk.n,
        e: jwk.e,
        alg: "RS256",
        use: "sig",
        kid: await keyIdFor(jwk.n),
      },
    ],
  };
}

async function sign(claims: Record<string, unknown>): Promise<string> {
  const key = await importSigningKey();
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  const kid = jwk.n ? await keyIdFor(jwk.n) : undefined;

  const header = base64Url(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}) })),
  );
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(input));
  return `${input}.${base64Url(new Uint8Array(signature))}`;
}

/**
 * An assertion naming ONE clone.
 *
 * `aud` is Anthropic's token endpoint rather than a name of our own: an
 * assertion that names its audience cannot be replayed at a different one, and
 * the caller — the clone — is the only party that ever holds it.
 */
export async function signCloneAssertion(input: {
  subject: string;
  audience: string;
  nowSeconds?: number;
}): Promise<string> {
  const claims = identityClaims({
    issuer: cloneIssuerUrl(),
    subject: input.subject,
    audience: input.audience,
    nowSeconds: input.nowSeconds ?? Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  });
  return sign(claims as unknown as Record<string, unknown>);
}

/**
 * An assertion for Mission Control's own organisation-admin token.
 *
 * A different issuer and a fixed subject, matching the one rule a person
 * created in the Console. The separation is not tidiness: Anthropic locks an
 * issuer that backs an `org:admin` rule against OAuth edits, so sharing one
 * would make every clone's rule unmanageable through the API that creates them.
 */
export async function signBootstrapAssertion(input: {
  audience: string;
  nowSeconds?: number;
}): Promise<string> {
  const claims = identityClaims({
    issuer: bootstrapIssuerUrl(),
    subject: BOOTSTRAP_SUBJECT,
    audience: input.audience,
    nowSeconds: input.nowSeconds ?? Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
  });
  return sign(claims as unknown as Record<string, unknown>);
}
