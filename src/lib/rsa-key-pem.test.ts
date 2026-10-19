// The PKCS#1 → PKCS#8 wrap that replaced node-forge, held to what Node's own
// crypto writes for the same key, and to WebCrypto — which is what the JWT
// library under @octokit/auth-app and the browser PEM helper import it with.
import { createPrivateKey, createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ensurePkcs8Pem,
  normalizePemWhitespace,
  pkcs1ToPkcs8Pem,
  pkcs8PemToDer,
} from "./rsa-key-pem";

const keys = [1024, 2048, 4096].map((modulusLength) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength });
  return {
    modulusLength,
    pkcs1: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    pkcs8: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
});

describe("pkcs1ToPkcs8Pem", () => {
  it.each(keys)("writes exactly what Node writes for a $modulusLength-bit key", (k) => {
    expect(pkcs1ToPkcs8Pem(k.pkcs1)).toBe(k.pkcs8.trim());
  });

  it("gives a key that signs, and that the matching public key verifies", () => {
    const k = keys[1];
    const converted = createPrivateKey(pkcs1ToPkcs8Pem(k.pkcs1));
    const signature = createSign("sha256").update("github-app-key-test").sign(converted);
    const ok = createVerify("sha256")
      .update("github-app-key-test")
      .verify(createPrivateKey(k.pkcs1), signature);
    expect(ok).toBe(true);
  });

  it("gives a key WebCrypto imports, as the JWT library and the browser do", async () => {
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8PemToDer(pkcs1ToPkcs8Pem(keys[1].pkcs1)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    expect((key.algorithm as RsaHashedKeyAlgorithm).modulusLength).toBe(2048);
  });

  it("reads a key a secret store flattened", () => {
    const k = keys[1];
    const spaced = k.pkcs1.trim().replace(/\n/g, " ");
    const escaped = k.pkcs1.trim().replace(/\n/g, "\\n");
    expect(pkcs1ToPkcs8Pem(spaced)).toBe(k.pkcs8.trim());
    expect(pkcs1ToPkcs8Pem(escaped)).toBe(k.pkcs8.trim());
  });

  it.each([
    [
      "a truncated key",
      // The last two lines of the body gone: what a copy that stopped short leaves.
      (pem: string) => {
        const lines = pem.trim().split("\n");
        return [...lines.slice(0, -3), lines[lines.length - 1]].join("\n");
      },
      /truncated/,
    ],
    [
      "a body that is not base64",
      (pem: string) => pem.replace(/\n[A-Za-z0-9+/]{10}/, "\n!!!!!!!!!!"),
      /base64/,
    ],
    [
      "an encrypted key",
      (pem: string) =>
        pem.replace(
          "-----BEGIN RSA PRIVATE KEY-----\n",
          "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\n",
        ),
      /encrypted/,
    ],
    [
      "no RSA key block at all",
      () => "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
      /no “RSA PRIVATE KEY” block/,
    ],
    [
      "a SEQUENCE that is not an RSA key",
      () =>
        `-----BEGIN RSA PRIVATE KEY-----\n${btoa(String.fromCharCode(0x30, 0x03, 0x02, 0x01, 0x00))}\n-----END RSA PRIVATE KEY-----`,
      /eight integers/,
    ],
  ])("refuses %s, naming what is wrong", (_what, mangle, said) => {
    expect(() => pkcs1ToPkcs8Pem(mangle(keys[1].pkcs1))).toThrow(said);
  });
});

describe("the key @octokit/auth-app is handed", () => {
  it("signs the App JWT, and GitHub's check of it — the public key — passes", async () => {
    // The whole path getAppOctokit takes, short of the network: a PKCS#1 key
    // as GitHub downloads it, converted here, signed by the auth library with
    // WebCrypto (as it does in the Worker), verified with the public half.
    const { createAppAuth } = await import("@octokit/auth-app");
    const k = keys[1];
    const auth = createAppAuth({ appId: 3436936, privateKey: ensurePkcs8Pem(k.pkcs1) });
    const { token } = (await auth({ type: "app" })) as { token: string };
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).iss).toBe(3436936);
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(createPrivateKey(k.pkcs1), Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("ensurePkcs8Pem", () => {
  it("converts PKCS#1, keeps PKCS#8, and passes anything else through", () => {
    expect(ensurePkcs8Pem(keys[1].pkcs1)).toBe(keys[1].pkcs8.trim());
    expect(ensurePkcs8Pem(keys[1].pkcs8)).toBe(keys[1].pkcs8.trim());
    expect(ensurePkcs8Pem("not a key")).toBe("not a key");
  });

  it("normalises a flattened PKCS#8 key too", () => {
    const flat = keys[1].pkcs8.trim().replace(/\n/g, " ");
    expect(ensurePkcs8Pem(flat)).toBe(keys[1].pkcs8.trim());
    expect(normalizePemWhitespace(flat)).toBe(keys[1].pkcs8.trim());
  });
});
