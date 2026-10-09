// How the Marketing module asks a vendor anything.
//
// The engine describes every request (`VendorRequest`: method, URL, headers,
// body) and never performs one; this is the one place that does. Three rules:
//
// - **Never throws.** A refusal, a timeout or an unreadable answer comes back
//   as a status and a body; the engine's parsers turn that into the failure
//   words the page explains. A transport failure is status 0.
// - **Retries only what a retry can cure.** A dropped connection or a 5xx is
//   asked again, twice at most; a 429 is not, because asking a rate limiter
//   again inside the same second is how a limit becomes a ban.
// - **Credentials never reach a log line.** The engine puts them in headers;
//   this logs the host and the status only.
import { withRetry } from "@/lib/with-retry";
import type { VendorRequest } from "@/lib/marketing/marketingEngine";
import {
  googleTokenRequest,
  parseGoogleToken,
  type GoogleOAuthClient,
  type SourceState,
} from "@/lib/marketing/marketingEngine";

const DEFAULT_TIMEOUT_MS = 20_000;

export interface VendorAnswer {
  status: number;
  body: unknown;
}

class TransientAnswer extends Error {
  constructor(public answer: VendorAnswer) {
    super(`transient ${answer.status}`);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

async function once(request: VendorRequest, timeoutMs: number): Promise<VendorAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { unparsed: text.slice(0, 300) };
      }
    }
    return { status: res.status, body };
  } catch (error) {
    console.warn("[marketing] transport failure", {
      host: hostOf(request.url),
      kind: error instanceof Error ? error.name : "unknown",
    });
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Perform a described request, retrying a dropped connection or a 5xx. Never throws. */
export async function sendVendorRequest(
  request: VendorRequest,
  options: { timeoutMs?: number } = {},
): Promise<VendorAnswer> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await withRetry(
      async () => {
        const answer = await once(request, timeoutMs);
        if (answer.status === 0 || answer.status >= 500) throw new TransientAnswer(answer);
        return answer;
      },
      { attempts: 3, baseMs: 400, shouldRetry: (err) => err instanceof TransientAnswer },
    );
  } catch (error) {
    if (error instanceof TransientAnswer) {
      console.warn("[marketing] vendor did not recover", {
        host: hostOf(request.url),
        status: error.answer.status,
      });
      return error.answer;
    }
    return { status: 0, body: null };
  }
}

export function unreachable(vendor: string): SourceState {
  return {
    state: "error",
    reason: "vendor_unavailable",
    message: `${vendor} could not be reached, or did not answer within ${DEFAULT_TIMEOUT_MS / 1000} seconds.`,
    status: null,
  };
}

export function failed(
  reason: Extract<SourceState, { state: "error" }>["reason"],
  message: string,
  status: number | null,
): SourceState {
  return { state: "error", reason, message, status };
}

// ── Google OAuth ──────────────────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** An access token for a refresh token, cached per isolate until a minute before it expires. */
export async function googleAccessToken(
  client: GoogleOAuthClient,
  vendor: string,
): Promise<{ ok: true; token: string } | { ok: false; state: SourceState }> {
  const key = `${vendor}:${client.clientId}:${client.refreshToken.slice(-8)}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ok: true, token: cached.token };
  const answer = await sendVendorRequest(googleTokenRequest(client));
  if (answer.status === 0) return { ok: false, state: unreachable(vendor) };
  const parsed = parseGoogleToken(answer.status, answer.body);
  if (!parsed.ok) return { ok: false, state: failed(parsed.reason, parsed.message, answer.status) };
  const ttl = (parsed.expiresInSeconds ?? 3600) * 1000 - 60_000;
  tokenCache.set(key, { token: parsed.accessToken, expiresAt: Date.now() + Math.max(ttl, 0) });
  return { ok: true, token: parsed.accessToken };
}
