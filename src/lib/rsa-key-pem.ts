/**
 * A GitHub App's RSA private key, PKCS#1 → PKCS#8, by wrapping the DER.
 *
 * GitHub downloads App keys as PKCS#1 (`BEGIN RSA PRIVATE KEY`) and the JWT
 * library under `@octokit/auth-app` imports only PKCS#8 (`BEGIN PRIVATE KEY`).
 * The two hold the same key: PKCS#8 is the PKCS#1 bytes inside an
 * `OCTET STRING`, after a version and the rsaEncryption algorithm identifier.
 * So the conversion is a wrap, not a cryptographic operation, and it needs no
 * crypto library — which is why it replaced `node-forge`, the one dependency
 * with a published high-severity advisory and no fixed release (Oct 2026). It
 * runs unchanged in the Worker, in the browser (the PEM helper on the auth
 * page) and in Node.
 *
 * The PKCS#1 bytes are checked before they are wrapped — one DER SEQUENCE
 * filling the whole body, a version, then the eight integers an RSA private
 * key is made of — so a truncated or mispasted key fails here, naming what is
 * wrong, rather than later inside the JWT library with a message about ASN.1.
 */

const RSA_PKCS1_HEADER = "-----BEGIN RSA PRIVATE KEY-----";
const PKCS8_HEADER = "-----BEGIN PRIVATE KEY-----";

/** version 0, then AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }. */
const PKCS8_RSA_PREFIX = [
  0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
];

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const OCTET_STRING = 0x04;

/**
 * Undo what secret stores do to a PEM: a literal `\n` for each newline, or
 * every newline flattened to a space. Rebuilt from the base64 between the
 * markers, wrapped at 64 characters as PEM is.
 */
export function normalizePemWhitespace(pem: string): string {
  let p = pem.replace(/\\n/g, "\n").trim();
  if (!p.includes("\n")) {
    const m = p.match(/-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]+?)-----END \1-----/);
    if (m) {
      const label = m[1].trim();
      const body = m[2].replace(/\s+/g, "");
      const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
      p = `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
    }
  }
  return p;
}

/** One DER element: its tag, and where its value starts and ends. */
function readElement(der: Uint8Array, at: number): { tag: number; start: number; end: number } {
  if (at + 2 > der.length) throw new Error("the key ends in the middle of an element");
  const tag = der[at];
  let length = der[at + 1];
  let start = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) throw new Error("the key has a length DER does not allow");
    if (start + count > der.length) throw new Error("the key ends in the middle of a length");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + der[start + i];
    start += count;
  }
  const end = start + length;
  if (end > der.length) throw new Error("the key is shorter than it says it is (truncated?)");
  return { tag, start, end };
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return [0x80 | bytes.length, ...bytes];
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new Error("the key's body is not base64");
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** The DER between a PEM's markers. Refuses an encrypted key: there is no passphrase to use. */
function pemBody(pem: string, label: string): Uint8Array<ArrayBuffer> {
  const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(pem);
  if (!m) throw new Error(`no “${label}” block found`);
  if (/Proc-Type:\s*4,ENCRYPTED/i.test(m[1])) {
    throw new Error(
      "the key is encrypted; decrypt it first (openssl rsa -in key.pem -out decrypted.pem)",
    );
  }
  return base64ToBytes(m[1].replace(/\s+/g, ""));
}

/** Checks that `der` is an RSAPrivateKey (RFC 8017 §A.1.2) before anything wraps it. */
function assertRsaPrivateKey(der: Uint8Array): void {
  const outer = readElement(der, 0);
  if (outer.tag !== SEQUENCE || outer.end !== der.length) {
    throw new Error("the key is not a single DER SEQUENCE");
  }
  let at = outer.start;
  const ints: Array<{ start: number; end: number }> = [];
  while (at < outer.end && ints.length < 9) {
    const el = readElement(der, at);
    if (el.tag !== INTEGER) break;
    ints.push(el);
    at = el.end;
  }
  if (ints.length < 9) {
    throw new Error("the key does not hold the version and eight integers of an RSA private key");
  }
  const version = ints[0];
  if (version.end - version.start !== 1 || der[version.start] > 1) {
    throw new Error("the key's version is not one RSA private keys use");
  }
}

/** PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`) → PKCS#8 PEM (`BEGIN PRIVATE KEY`), the same key. */
export function pkcs1ToPkcs8Pem(pem: string): string {
  const pkcs1 = pemBody(normalizePemWhitespace(pem), "RSA PRIVATE KEY");
  assertRsaPrivateKey(pkcs1);
  const body = [...PKCS8_RSA_PREFIX, OCTET_STRING, ...derLength(pkcs1.length), ...pkcs1];
  const der = new Uint8Array([SEQUENCE, ...derLength(body.length), ...body]);
  const lines = bytesToBase64(der).match(/.{1,64}/g) ?? [];
  return `${PKCS8_HEADER}\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

/**
 * What the GitHub App client is handed: PKCS#8 as it is, PKCS#1 converted, and
 * anything else passed through for the auth library to report in its words.
 */
export function ensurePkcs8Pem(pem: string): string {
  const normalized = normalizePemWhitespace(pem);
  if (normalized.includes(PKCS8_HEADER)) return normalized;
  if (normalized.includes(RSA_PKCS1_HEADER)) return pkcs1ToPkcs8Pem(normalized);
  return normalized;
}

/** The DER of a PKCS#8 PEM, for WebCrypto's `importKey("pkcs8", …)`. */
export function pkcs8PemToDer(pem: string): Uint8Array<ArrayBuffer> {
  return pemBody(normalizePemWhitespace(pem), "PRIVATE KEY");
}
