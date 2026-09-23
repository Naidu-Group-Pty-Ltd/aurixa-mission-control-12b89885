// A VAPI API client for ONE client org, built from that org's own key.
//
// It never falls back to Mission Control's VAPI_API_KEY: a deploy that could
// not find the client's key must fail, not write the client's fleet into
// Aurixa's org. Retries follow the Python fleet scripts' `api()`: 429 and 5xx
// back off and retry, anything else is the answer.
import type { VapiApi } from "@/lib/voice-studio/vapiDeploy.pure";

const VAPI_BASE = "https://api.vapi.ai";
const ATTEMPTS = 4;

export class VapiHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "VapiHttpError";
    this.status = status;
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function vapiClient(apiKey: string): VapiApi {
  const call = async (
    method: string,
    path: string,
    body?: BodyInit,
    json = true,
  ): Promise<Record<string, any> | null> => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`${VAPI_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(json && body ? { "Content-Type": "application/json" } : {}),
        },
        body,
      });
      if (method === "GET" && res.status === 404) return null;
      if (res.ok) {
        const text = await res.text();
        return text ? (JSON.parse(text) as Record<string, any>) : {};
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < ATTEMPTS) {
        const after = Number(res.headers.get("retry-after"));
        await pause(
          Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 20_000) : 500 * 2 ** attempt,
        );
        continue;
      }
      const detail = (await res.text()).slice(0, 400);
      throw new VapiHttpError(
        res.status,
        `VAPI ${method} ${path.split("?")[0]} answered ${res.status}: ${detail}`,
      );
    }
  };

  return {
    get: (path) => call("GET", path),
    post: async (path, body) => (await call("POST", path, JSON.stringify(body))) ?? {},
    patch: async (path, body) => (await call("PATCH", path, JSON.stringify(body))) ?? {},
    uploadTextFile: async (fileName, mimetype, text) => {
      // KB_TEXT_PLAIN: multipart, text/plain, a .txt name - the only shape
      // VAPI's parser has been seen to accept.
      const form = new FormData();
      form.append("file", new Blob([text], { type: mimetype }), fileName);
      return (await call("POST", "/file", form, false)) ?? {};
    },
  };
}

/** Is this a working key for some VAPI org? One cheap read. */
export async function probeVapiKey(
  apiKey: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await vapiClient(apiKey).get("/assistant?limit=1");
    return { ok: true };
  } catch (err) {
    if (err instanceof VapiHttpError && (err.status === 401 || err.status === 403)) {
      return {
        ok: false,
        reason: "VAPI refused this key - check it is the org's PRIVATE key, not the public one",
      };
    }
    return { ok: false, reason: err instanceof Error ? err.message : "VAPI could not be reached" };
  }
}
