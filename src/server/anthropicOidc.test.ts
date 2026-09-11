/**
 * Mission Control as an OIDC issuer.
 *
 * One property is worth more than the rest: the published key set carries the
 * PUBLIC half and nothing else. A JWKS is fetched by anybody — that is what it
 * is for — so a private field leaking into it would hand the signing key to
 * the internet, and every signature would still verify, so nothing would look
 * wrong from either side.
 *
 * The key here is generated in the test rather than fixtured. A checked-in
 * private key is a credential in a repository even when it is a toy one, and
 * this way the assertions are made against a real RSA key every run.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://mc.example";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

let pem: string;
const saved = { ...process.env };

function decodeSegment(segment: string): Record<string, unknown> {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString("base64")}\n-----END PRIVATE KEY-----`;
});

afterEach(() => {
  process.env = { ...saved };
});

function configure() {
  process.env.ANTHROPIC_FEDERATION_PRIVATE_KEY = pem;
  process.env.MISSION_CONTROL_PUBLIC_URL = ORIGIN;
}

describe("the published key set", () => {
  it("carries the public half and no private field", async () => {
    configure();
    const { publicJwks } = await import("./anthropicOidc.server");
    const jwks = await publicJwks();

    expect(jwks.keys).toHaveLength(1);
    const [key] = jwks.keys;
    expect(key.kty).toBe("RSA");
    expect(key.alg).toBe("RS256");
    expect(key.use).toBe("sig");
    expect(key.n.length).toBeGreaterThan(100);

    // The whole point. `d` is the private exponent; the other five are the CRT
    // parameters, and any one of them reconstructs the key.
    for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) {
      expect(secret in key).toBe(false);
    }
    expect(JSON.stringify(jwks)).not.toContain("\"d\":");
  });

  it("derives a key id that is stable for a key", async () => {
    configure();
    const { publicJwks } = await import("./anthropicOidc.server");
    const first = await publicJwks();
    const second = await publicJwks();
    expect(first.keys[0].kid).toBe(second.keys[0].kid);
    expect(first.keys[0].kid.length).toBeGreaterThan(8);
  });

  it("reports no signing key rather than pretending to one", async () => {
    process.env = { ...saved };
    delete process.env.ANTHROPIC_FEDERATION_PRIVATE_KEY;
    const { signingKeyPresent } = await import("./anthropicOidc.server");
    expect(signingKeyPresent()).toBe(false);
  });
});

describe("a clone assertion", () => {
  it("names one clone, binds an audience, and verifies against the published key", async () => {
    configure();
    const { publicJwks, signCloneAssertion } = await import("./anthropicOidc.server");

    const subject = "clone:11111111-2222-3333-4444-555555555555";
    const jwt = await signCloneAssertion({ subject, audience: TOKEN_URL });
    const [header, payload, signature] = jwt.split(".");

    expect(decodeSegment(header)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const claims = decodeSegment(payload);
    expect(claims.sub).toBe(subject);
    expect(claims.aud).toBe(TOKEN_URL);
    expect(claims.iss).toBe(`${ORIGIN}/api/public/anthropic`);
    expect(typeof claims.jti).toBe("string");

    // Verified against the key set Anthropic would fetch, rather than against
    // the key we signed with — a published modulus that does not match the
    // signing key is a failure neither side could diagnose.
    const [jwk] = (await publicJwks()).keys;
    const verifyKey = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      true,
      ["verify"],
    );
    const sig = Uint8Array.from(
      Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      verifyKey,
      sig,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(ok).toBe(true);
  });

  it("gives every assertion a fresh jti, because Anthropic accepts one once", async () => {
    configure();
    const { signCloneAssertion } = await import("./anthropicOidc.server");
    const a = await signCloneAssertion({ subject: "clone:a", audience: TOKEN_URL });
    const b = await signCloneAssertion({ subject: "clone:a", audience: TOKEN_URL });
    expect(decodeSegment(a.split(".")[1]).jti).not.toBe(decodeSegment(b.split(".")[1]).jti);
  });

  it("signs the bootstrap under a different issuer from the clones", async () => {
    configure();
    const { signBootstrapAssertion, signCloneAssertion } = await import("./anthropicOidc.server");
    const bootstrap = decodeSegment((await signBootstrapAssertion({ audience: TOKEN_URL })).split(".")[1]);
    const clone = decodeSegment(
      (await signCloneAssertion({ subject: "clone:a", audience: TOKEN_URL })).split(".")[1],
    );
    expect(bootstrap.iss).not.toBe(clone.iss);
    expect(bootstrap.sub).toBe("mission-control:bootstrap");
  });

  it("refuses to sign with no key rather than emitting an unsigned token", async () => {
    process.env = { ...saved };
    delete process.env.ANTHROPIC_FEDERATION_PRIVATE_KEY;
    const { signCloneAssertion } = await import("./anthropicOidc.server");
    await expect(
      signCloneAssertion({ subject: "clone:a", audience: TOKEN_URL }),
    ).rejects.toThrow(/ANTHROPIC_FEDERATION_PRIVATE_KEY/);
  });
});
