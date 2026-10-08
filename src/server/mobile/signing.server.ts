/**
 * The organisation key every release manifest is signed with.
 *
 * Ed25519, PKCS8 PEM in `MOBILE_RELEASE_SIGNING_KEY`. Its public half is
 * compiled into every app as the trusted root (one rotation slot), and also
 * published at `/api/public/mobile/jwks` so an operator can check what the
 * apps should hold. The activation assertion is NOT signed with this key: it
 * uses the federation signer (`signCloneAssertion`), so a clone verifies one
 * RS256 key set it already knows.
 *
 * The manifest's bytes are `canonicalJson(manifest)` — the same bytes the app
 * re-serialises — so a signature can never fail over key order.
 */
import { canonicalJson } from "./releaseDescriptor.pure";

export const RELEASE_SIGNING_KEY_ENV = "MOBILE_RELEASE_SIGNING_KEY";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function releaseSigningKeyPresent(): boolean {
  return (process.env[RELEASE_SIGNING_KEY_ENV] ?? "").trim().length > 0;
}

async function importReleaseKey(): Promise<CryptoKey> {
  const pem = (process.env[RELEASE_SIGNING_KEY_ENV] ?? "").trim();
  if (!pem) throw new Error(`${RELEASE_SIGNING_KEY_ENV} is not set`);
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
}

export type ReleasePublicJwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg: "EdDSA";
  use: "sig";
  kid: string;
};

export async function releasePublicJwk(): Promise<ReleasePublicJwk> {
  const key = await importReleaseKey();
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  if (!jwk.x) throw new Error(`${RELEASE_SIGNING_KEY_ENV} did not export a public key`);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(jwk.x));
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: jwk.x,
    alg: "EdDSA",
    use: "sig",
    kid: `release-${b64url(new Uint8Array(digest)).slice(0, 16)}`,
  };
}

export type SignedManifest = { manifest: unknown; payload: string; signature: string; kid: string };

/** Sign a manifest. `payload` is exactly the bytes signed. */
export async function signManifest(manifest: unknown): Promise<SignedManifest> {
  const key = await importReleaseKey();
  const payload = canonicalJson(manifest);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, encoder.encode(payload));
  const { kid } = await releasePublicJwk();
  return { manifest, payload, signature: b64url(new Uint8Array(sig)), kid };
}
