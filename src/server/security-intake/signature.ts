// Per-source HMAC-SHA256 verification for the provider-neutral intake route.
// Same signature scheme as the Codex webhook (sha256=<hex>) but keyed by the
// source's own secret so vendors can rotate independently.

/**
 * The scheme itself, in one place. Verification and in-process signing both go
 * through this, so the two cannot drift into computing different digests over
 * the same bytes.
 */
export async function signIntakeBody(rawBody: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** `sha256=<hex>`, the form the header carries. */
export async function intakeSignatureHeader(rawBody: string, secret: string): Promise<string> {
  return `sha256=${await signIntakeBody(rawBody, secret)}`;
}

export async function verifyIntakeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | null,
): Promise<boolean> {
  if (!secret || !signatureHeader) return false;
  const hex = await signIntakeBody(rawBody, secret);
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;
  if (provided.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
