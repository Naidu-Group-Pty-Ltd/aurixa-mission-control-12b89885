/**
 * Whether a value is Mission Control's own value for a name.
 *
 * The fleet's forwarded keys are Mission Control's own environment values
 * (`pushFleetSecretForwards` writes `process.env[name]`), so "is this the
 * platform's key" is this comparison and nothing else. It decides whose money
 * a key spends (`integrationLedgerStatus`), never whether a write happens.
 *
 * Compared as SHA-256 digests in constant time: the caller is a tenant's
 * request, and a comparison that returned sooner the more characters matched
 * would answer, one character at a time, what the platform's key is.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function isPlatformValue(name: string, value: string): boolean {
  const own = (process.env[name] ?? "").trim();
  if (!own || !value) return false;
  const a = createHash("sha256").update(own, "utf8").digest();
  const b = createHash("sha256").update(value.trim(), "utf8").digest();
  return timingSafeEqual(a, b);
}
