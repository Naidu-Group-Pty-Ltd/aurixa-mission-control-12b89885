import { afterEach, describe, expect, it } from "vitest";
import { RELEASE_SIGNING_KEY_ENV, releasePublicJwk, signManifest } from "./signing.server";

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return new Uint8Array(Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

async function freshPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
}

describe("release manifest signing", () => {
  afterEach(() => {
    delete process.env[RELEASE_SIGNING_KEY_ENV];
  });

  it("signs canonical bytes the published key verifies, whatever the key order", async () => {
    process.env[RELEASE_SIGNING_KEY_ENV] = await freshPem();
    const a = await signManifest({ b: 1, a: { d: 2, c: 3 } });
    const b = await signManifest({ a: { c: 3, d: 2 }, b: 1 });
    expect(a.payload).toBe(b.payload);
    const jwk = await releasePublicJwk();
    const pub = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: jwk.x },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" },
      pub,
      fromB64url(a.signature),
      new TextEncoder().encode(a.payload),
    );
    expect(ok).toBe(true);
    const tampered = await crypto.subtle.verify(
      { name: "Ed25519" },
      pub,
      fromB64url(a.signature),
      new TextEncoder().encode(a.payload.replace("1", "2")),
    );
    expect(tampered).toBe(false);
    expect(jwk).not.toHaveProperty("d");
  });

  it("refuses to sign with no key", async () => {
    await expect(signManifest({})).rejects.toThrow(RELEASE_SIGNING_KEY_ENV);
  });
});
