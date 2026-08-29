// Cloudflare API v4 client — typed wrapper used by all server functions.
// Reads CLOUDFLARE_API_TOKEN from process.env (server-only).
import { withRetry, isTransientHttpError } from "@/lib/with-retry";

const CF_BASE = "https://api.cloudflare.com/client/v4";

export class CloudflareError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly errors: unknown,
  ) {
    super(message);
  }
}

type CFResponse<T> = {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
};

function token(): string {
  const t = process.env.CLOUDFLARE_API_TOKEN;
  if (!t) throw new Error("CLOUDFLARE_API_TOKEN not configured");
  return t;
}

async function cf<T>(path: string, init: RequestInit = {}): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(`${CF_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      const json = (await res.json()) as CFResponse<T>;
      if (!res.ok || !json.success) {
        throw new CloudflareError(
          json.errors?.[0]?.message ?? `Cloudflare API ${res.status}`,
          res.status,
          json.errors,
        );
      }
      return json.result;
    },
    {
      attempts: 3,
      shouldRetry: (err) => {
        if (err instanceof CloudflareError) {
          return err.status === 429 || err.status >= 500;
        }
        return isTransientHttpError(err);
      },
    },
  );
}

export type CFZone = {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
  plan?: { name: string };
};

export type TurnstileMode = "managed" | "non-interactive" | "invisible";

export type TurnstileWidget = {
  sitekey: string;
  /** Present only on create and rotate_secret — Cloudflare never reads it back. */
  secret?: string;
  name: string;
  domains: string[];
  mode: string;
  created_on?: string;
  modified_on?: string;
};

export const cloudflareApi = {
  verifyToken: () => cf<{ id: string; status: string }>("/user/tokens/verify"),
  listZones: (accountId?: string) =>
    cf<CFZone[]>(`/zones?per_page=50${accountId ? `&account.id=${accountId}` : ""}`),
  getZone: (zoneId: string) => cf<CFZone>(`/zones/${zoneId}`),
  setSecurityLevel: (
    zoneId: string,
    value: "off" | "essentially_off" | "low" | "medium" | "high" | "under_attack",
  ) =>
    cf(`/zones/${zoneId}/settings/security_level`, {
      method: "PATCH",
      body: JSON.stringify({ value }),
    }),
  setBotFightMode: (zoneId: string, enabled: boolean) =>
    cf(`/zones/${zoneId}/bot_management`, {
      method: "PUT",
      body: JSON.stringify({ fight_mode: enabled }),
    }).catch(() =>
      // Fallback for free plans
      cf(`/zones/${zoneId}/settings/security_level`, {
        method: "PATCH",
        body: JSON.stringify({ value: enabled ? "high" : "medium" }),
      }),
    ),
  getAnalytics: (zoneId: string, sinceHours = 24) =>
    cf<{
      totals: {
        requests: { all: number };
        threats: { all: number };
        bandwidth: { all: number };
      };
    }>(`/zones/${zoneId}/analytics/dashboard?since=-${sinceHours * 60}&until=0`).catch(() => ({
      totals: { requests: { all: 0 }, threats: { all: 0 }, bandwidth: { all: 0 } },
    })),

  // ── DNS records (subdomain hosting) ────────────────────────────────────
  listDnsRecords: (zoneId: string, params?: { name?: string; type?: string }) => {
    const q = new URLSearchParams({ per_page: "100" });
    if (params?.name) q.set("name", params.name);
    if (params?.type) q.set("type", params.type);
    return cf<Array<{ id: string; name: string; type: string; content: string; proxied: boolean }>>(
      `/zones/${zoneId}/dns_records?${q.toString()}`,
    );
  },
  createDnsRecord: (
    zoneId: string,
    body: {
      type: "A" | "AAAA" | "CNAME" | "TXT" | "MX";
      name: string;
      content: string;
      proxied?: boolean;
      ttl?: number;
      comment?: string;
      /** MX only — Cloudflare requires it on MX and rejects it elsewhere. */
      priority?: number;
    },
  ) => {
    // `proxied` is not a property a TXT record can have, and Cloudflare rejects
    // the whole request rather than ignoring the field. The default below used
    // to be applied unconditionally, so the first TXT record this client was
    // ever asked to write would have failed with a validation error that names
    // the field rather than the record type — and a domain-ownership challenge
    // that never lands looks exactly like DNS that has not propagated yet.
    // MX is in the same class: only A/AAAA/CNAME can sit behind the proxy.
    const proxyable = body.type !== "TXT" && body.type !== "MX";
    const payload = proxyable
      ? { ttl: 1, proxied: true, ...body }
      : { ttl: 1, ...body, proxied: undefined };
    return cf<{ id: string; name: string; type: string; content: string; proxied: boolean }>(
      `/zones/${zoneId}/dns_records`,
      { method: "POST", body: JSON.stringify(payload) },
    );
  },
  updateDnsRecord: (
    zoneId: string,
    recordId: string,
    body: Partial<{ type: string; name: string; content: string; proxied: boolean; ttl: number }>,
  ) =>
    cf<{ id: string; name: string; type: string; content: string; proxied: boolean }>(
      `/zones/${zoneId}/dns_records/${recordId}`,
      { method: "PATCH", body: JSON.stringify(body) },
    ),
  deleteDnsRecord: (zoneId: string, recordId: string) =>
    cf<{ id: string }>(`/zones/${zoneId}/dns_records/${recordId}`, { method: "DELETE" }),

  // ── Turnstile widgets (per-clone CAPTCHA identity) ─────────────────────
  //
  // A widget IS the (site key, secret) pair. `sitekey` is public — it is
  // rendered in the login page — and the `secret` is returned ONLY by create
  // and rotate_secret, never by a read. Callers must deliver it in the same
  // flow that obtained it.
  createTurnstileWidget: (
    accountId: string,
    body: { name: string; domains: string[]; mode?: TurnstileMode },
  ) =>
    cf<TurnstileWidget>(`/accounts/${accountId}/challenges/widgets`, {
      method: "POST",
      body: JSON.stringify({ mode: "managed", ...body }),
    }),

  getTurnstileWidget: (accountId: string, sitekey: string) =>
    cf<TurnstileWidget>(`/accounts/${accountId}/challenges/widgets/${sitekey}`),

  listTurnstileWidgets: (accountId: string) =>
    cf<TurnstileWidget[]>(`/accounts/${accountId}/challenges/widgets?per_page=50`),

  updateTurnstileWidget: (
    accountId: string,
    sitekey: string,
    body: { name?: string; domains?: string[]; mode?: TurnstileMode },
  ) =>
    cf<TurnstileWidget>(`/accounts/${accountId}/challenges/widgets/${sitekey}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  /** Returns the widget with a FRESH `secret`; the previous one stops verifying. */
  rotateTurnstileSecret: (accountId: string, sitekey: string) =>
    cf<TurnstileWidget>(`/accounts/${accountId}/challenges/widgets/${sitekey}/rotate_secret`, {
      method: "POST",
      body: JSON.stringify({ invalidate_immediately: true }),
    }),

  deleteTurnstileWidget: (accountId: string, sitekey: string) =>
    cf<TurnstileWidget>(`/accounts/${accountId}/challenges/widgets/${sitekey}`, {
      method: "DELETE",
    }),
};
