/**
 * What Google's APIs say when they refuse, and how a refresh token becomes
 * an access token.
 *
 * YouTube Data, YouTube Analytics, Google Ads and Google's OAuth endpoint all
 * answer an error in one of three shapes, and the reason that decides what a
 * person should do is in a different place in each:
 *
 * - the classic envelope `{ error: { code, message, errors: [{ reason }] } }`
 *   (YouTube Data: `quotaExceeded`, `keyInvalid`, `accessNotConfigured`);
 * - the AIP-193 envelope `{ error: { code, status, details: [{ reason }] } }`
 *   (`API_KEY_INVALID`, `SERVICE_DISABLED`, `API_KEY_HTTP_REFERRER_BLOCKED`),
 *   with Google Ads nesting its own `errors: [{ errorCode: { … } }]` inside a
 *   `GoogleAdsFailure` detail;
 * - OAuth's `{ error: 'invalid_grant', error_description }`.
 *
 * The reason is read from whichever is present, never guessed from the HTTP
 * status alone: a 403 is a spent quota in one answer and a disabled API in the
 * next, and those send an operator to different screens.
 */
import type { SourceErrorReason } from './marketingTypes.pure.ts';
import { safeVendorMessage, type VendorRequest } from './vendorRequest.pure.ts';

export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** The refresh-token exchange, form-encoded as Google's token endpoint requires. */
export function googleTokenRequest(client: GoogleOAuthClient): VendorRequest {
  const form = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: client.refreshToken,
    grant_type: 'refresh_token',
  });
  return {
    method: 'POST',
    url: GOOGLE_OAUTH_TOKEN_URL,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  };
}

export type GoogleTokenResult =
  | { ok: true; accessToken: string; expiresInSeconds: number | null; scope: string | null }
  | { ok: false; reason: SourceErrorReason; message: string };

/** Read the token endpoint's answer. A refresh token Google no longer honours is a credential problem. */
export function parseGoogleToken(status: number, body: unknown): GoogleTokenResult {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && typeof b.access_token === 'string' && b.access_token !== '') {
    const expires = typeof b.expires_in === 'number' ? b.expires_in : Number(b.expires_in);
    return {
      ok: true,
      accessToken: b.access_token,
      expiresInSeconds: Number.isFinite(expires) ? expires : null,
      scope: typeof b.scope === 'string' ? b.scope : null,
    };
  }
  const code = typeof b.error === 'string' ? b.error : '';
  const description = safeVendorMessage(b.error_description) || safeVendorMessage(code);
  if (code === 'invalid_grant' || code === 'invalid_client' || status === 401) {
    return {
      ok: false,
      reason: 'credentials_rejected',
      message: description || 'Google refused the refresh token. Reconnect the account to mint a new one.',
    };
  }
  if (code === 'unauthorized_client' || code === 'access_denied') {
    return { ok: false, reason: 'permission_denied', message: description || 'This OAuth client may not use that refresh token.' };
  }
  if (status >= 500) return { ok: false, reason: 'vendor_unavailable', message: description || `Google's token service answered ${status}.` };
  if (status === 429) return { ok: false, reason: 'rate_limited', message: description || 'Google is rate limiting token requests.' };
  return { ok: false, reason: status >= 400 && status < 500 ? 'request_rejected' : 'unreadable_answer', message: description || `Google's token service answered ${status} without an access token.` };
}

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'RATE_LIMIT_EXCEEDED_DAILY', 'RESOURCE_TEMPORARILY_EXHAUSTED_QUOTA']);
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);
const KEY_REASONS = new Set(['keyInvalid', 'keyExpired', 'API_KEY_INVALID', 'API_KEY_EXPIRED', 'authError', 'invalidCredentials', 'OAUTH_TOKEN_INVALID', 'OAUTH_TOKEN_EXPIRED', 'OAUTH_TOKEN_REVOKED', 'OAUTH_TOKEN_DISABLED', 'OAUTH_TOKEN_HEADER_INVALID', 'NOT_ADS_USER', 'DEVELOPER_TOKEN_INVALID', 'DEVELOPER_TOKEN_PROHIBITED']);
const PERMISSION_REASONS = new Set([
  'accessNotConfigured',
  'SERVICE_DISABLED',
  'API_KEY_SERVICE_BLOCKED',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'API_KEY_ANDROID_APP_BLOCKED',
  'API_KEY_IOS_APP_BLOCKED',
  'forbidden',
  'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'USER_PERMISSION_DENIED',
  'DEVELOPER_TOKEN_NOT_APPROVED',
  'CUSTOMER_NOT_ENABLED',
  'CUSTOMER_NOT_ACTIVE',
  'ACTION_NOT_PERMITTED',
]);
const NOT_FOUND_REASONS = new Set(['notFound', 'channelNotFound', 'playlistNotFound', 'videoNotFound', 'CUSTOMER_NOT_FOUND', 'INVALID_CUSTOMER_ID']);

function collectReasons(body: unknown): string[] {
  const out: string[] = [];
  const err = (body as { error?: unknown } | null)?.error;
  if (!err || typeof err !== 'object') return out;
  const e = err as Record<string, unknown>;
  if (typeof e.status === 'string') out.push(e.status);
  for (const item of Array.isArray(e.errors) ? e.errors : []) {
    const reason = (item as Record<string, unknown>)?.reason;
    if (typeof reason === 'string') out.push(reason);
  }
  for (const detail of Array.isArray(e.details) ? e.details : []) {
    const d = detail as Record<string, unknown>;
    if (typeof d?.reason === 'string') out.push(d.reason);
    // Google Ads: details[].errors[].errorCode = { someError: 'ENUM_VALUE' }.
    for (const adsError of Array.isArray(d?.errors) ? d.errors : []) {
      const codeObj = (adsError as Record<string, unknown>)?.errorCode;
      if (codeObj && typeof codeObj === 'object') {
        for (const value of Object.values(codeObj as Record<string, unknown>)) {
          if (typeof value === 'string') out.push(value);
        }
      }
    }
  }
  return out;
}

function firstAdsMessage(body: unknown): string {
  const err = (body as { error?: Record<string, unknown> } | null)?.error;
  for (const detail of Array.isArray(err?.details) ? err.details : []) {
    for (const adsError of Array.isArray((detail as Record<string, unknown>)?.errors) ? (detail as { errors: unknown[] }).errors : []) {
      const m = (adsError as Record<string, unknown>)?.message;
      if (typeof m === 'string' && m.trim() !== '') return m;
    }
  }
  return '';
}

/**
 * Which kind of refusal a Google API answer is, with the vendor's own words.
 *
 * The message prefers Google Ads' per-error text over the envelope's generic
 * "Request contains an invalid argument", because the per-error text is the
 * one that names the field.
 */
export function googleErrorOf(status: number, body: unknown): { reason: SourceErrorReason; message: string } {
  const reasons = collectReasons(body);
  const err = (body as { error?: Record<string, unknown> } | null)?.error;
  const message = safeVendorMessage(firstAdsMessage(body)) || safeVendorMessage(err?.message) || `Google answered HTTP ${status}.`;
  const has = (set: Set<string>) => reasons.some((r) => set.has(r));

  if (has(QUOTA_REASONS)) return { reason: 'quota_exhausted', message };
  if (has(RATE_REASONS) || status === 429) return { reason: 'rate_limited', message };
  if (has(KEY_REASONS) || status === 401) return { reason: 'credentials_rejected', message };
  if (has(PERMISSION_REASONS)) return { reason: 'permission_denied', message };
  if (has(NOT_FOUND_REASONS) || status === 404) return { reason: 'not_found', message };
  if (status === 403) return { reason: 'permission_denied', message };
  if (status >= 500) return { reason: 'vendor_unavailable', message };
  if (status >= 400) return { reason: 'request_rejected', message };
  return { reason: 'unreadable_answer', message };
}
