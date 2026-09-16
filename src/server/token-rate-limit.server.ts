import { supabaseAdmin } from "@/integrations/supabase/client.server";

const DEFAULT_LIMIT = 60; // per minute per key

/**
 * The default bucket — the shared per-key allowance almost every route uses.
 *
 * A bucket is an ENDPOINT FAMILY, never a key. `_key_id` is a uuid with a
 * foreign key to `clone_api_keys`, so a caller wanting a separate allowance
 * must name it here and never fold it into the key: the activation gate did
 * exactly that (`checkRateLimit(\`gate:${keyId}\`)`), Postgres answered
 * `22P02 invalid input syntax for type uuid`, and because this helper fails
 * CLOSED on a DB error all four routes that did it returned 429 to every
 * request ever made of them — the gate's verdict and CTA, and both storefront
 * purchase routes. `rateLimitBucket.test.ts` fails any call site that composes
 * its key id. See `20260916170000_rate_limit_bucket_and_public.sql`.
 */
export const DEFAULT_RATE_LIMIT_BUCKET = "";

// `retry_after_seconds` is present on both members (optional on success) so call
// sites can read it after an `if (!rl.ok)` guard without relying on
// discriminated-union narrowing. That was written when the project compiled
// without strictNullChecks and narrowing did not hold; the flag is on now, so
// this shape is belt-and-braces rather than load-bearing. It is only populated
// when `ok` is false.
export type RateLimitResult =
  | { ok: true; count: number; limit: number; retry_after_seconds?: undefined }
  | { ok: false; count: number; limit: number; retry_after_seconds: number };

/**
 * Increment + check the per-key per-minute rate limit. Backed by
 * `public.check_api_rate_limit` so two replicas share state.
 *
 * `bucket` separates one endpoint family's allowance from another's for the
 * SAME key — pass one where a chatty endpoint must not consume the budget a
 * metered one depends on. Omitted, every caller shares the key's one counter,
 * which is the behaviour every route had before the column existed.
 *
 * Fails CLOSED on DB error — better to short-circuit a few legitimate
 * requests than allow unbounded traffic when the limiter store is down.
 */
export async function checkRateLimit(
  keyId: string,
  limit = DEFAULT_LIMIT,
  bucket: string = DEFAULT_RATE_LIMIT_BUCKET,
): Promise<RateLimitResult> {
  const { data, error } = await supabaseAdmin.rpc("check_api_rate_limit", {
    _key_id: keyId,
    _limit: limit,
    _bucket: bucket,
  });
  if (error) {
    console.error("[rate-limit] DB error, failing closed:", error.message);
    return { ok: false, count: 0, limit, retry_after_seconds: 5 };
  }
  return data as RateLimitResult;
}

/**
 * The same limiter for callers that hold no API key at all.
 *
 * The storefront's purchase routes are reachable with no credential — the
 * identity is a `uid` carried in a pricing-page link, or a handoff id — so
 * there is no `clone_api_keys` row for `checkRateLimit` to count against.
 * They used to compose one (`storefront:checkout:${uid}`) and got a 429 on
 * every request, for the reason in the bucket note above.
 *
 * `scope` is what `bucket` is on the keyed side: the endpoint family. Counts
 * land in `public_rate_limits`, which has no foreign key, because an anonymous
 * caller is not a key.
 *
 * Fails CLOSED on DB error, exactly as its sibling does and for the same
 * reason — these routes mint Stripe sessions.
 */
export async function checkPublicRateLimit(
  scope: string,
  identity: string,
  limit = DEFAULT_LIMIT,
): Promise<RateLimitResult> {
  const { data, error } = await supabaseAdmin.rpc("check_public_rate_limit", {
    _scope: scope,
    _identity: identity,
    _limit: limit,
  });
  if (error) {
    console.error("[rate-limit] public DB error, failing closed:", error.message);
    return { ok: false, count: 0, limit, retry_after_seconds: 5 };
  }
  return data as RateLimitResult;
}
