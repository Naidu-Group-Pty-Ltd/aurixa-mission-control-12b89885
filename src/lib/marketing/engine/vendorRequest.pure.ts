/**
 * A vendor request, described rather than sent.
 *
 * Every builder in the engine returns one of these and the caller performs it
 * with whatever transport its runtime has — `meteredFetch` in the prime's edge
 * functions, `fetch` behind `withRetry` in Mission Control. Describing the
 * request keeps the engine free of network code and lets a test read exactly
 * what would have been sent.
 *
 * Credentials travel in HEADERS, never in the URL. Google's APIs take an API
 * key as `X-Goog-Api-Key` as readily as `?key=`, Meta's Graph API takes a
 * bearer token as readily as `?access_token=`, and a URL is what proxies, logs
 * and error messages repeat. A key that is never in a URL cannot leak through
 * one.
 */

export interface VendorRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  /** A serialised body, for POST. */
  body?: string;
}

/** `?a=1&b=2`, skipping undefined and null; arrays and objects are JSON, as TikTok expects. */
export function queryString(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/**
 * The text of a vendor's error, cut to a length a page can show, with
 * anything that looks like a credential removed.
 *
 * Vendors echo request fragments back in their messages. A message is shown
 * to a person and written to logs, so it is scrubbed of long opaque tokens
 * before it leaves the engine — the reader needs the vendor's words, never a
 * key.
 */
export function safeVendorMessage(message: unknown, maxLength = 300): string {
  if (typeof message !== 'string' || message.trim() === '') return '';
  const scrubbed = message
    // Long opaque runs: API keys, bearer tokens, access tokens.
    .replace(/[A-Za-z0-9_\-.]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return scrubbed.length > maxLength ? `${scrubbed.slice(0, maxLength - 1)}…` : scrubbed;
}
