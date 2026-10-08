/**
 * How the mobile gateway's routes answer.
 *
 * Every refusal carries a stable `code` the apps switch on (the Draft 02 error
 * vocabulary) and a sentence a person can read. Nothing here is cached: every
 * answer concerns a credential or a decision that can change in seconds.
 */
import type { GatewayRefusal } from "./gateway.server";

const NO_STORE = { "content-type": "application/json", "cache-control": "no-store" };

export function mobileJson(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, ...extra } });
}

export function mobileRefusal(r: GatewayRefusal): Response {
  const extra: Record<string, string> = {};
  if (r.status === 429) extra["retry-after"] = "60";
  return mobileJson({ ok: false, code: r.code, message: r.message }, r.status, extra);
}

/** The caller's address for rate limiting only; never stored in the clear. */
export function mobileClientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim() || "unknown";
  return "unknown";
}

/** A JSON body, or null for anything that is not a JSON object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => "");
  if (!text || text.length > 16_384) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
