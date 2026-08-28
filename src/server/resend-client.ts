/**
 * Resend REST client — the only place this codebase talks to Resend.
 *
 * Shaped after `src/server/hosting/vercel-client.ts` and
 * `src/server/cloudflare/client.ts` so the outbound clients read alike: a
 * typed error carrying the status, one `withRetry` policy, and the token read
 * from `process.env` at call time rather than at module load — a module-level
 * read makes the token's absence a boot failure instead of a dormant feature,
 * and this whole capability is DESIGNED to be dormant until
 * `RESEND_MASTER_API_KEY` is configured.
 *
 * ## Which key this is
 *
 * This is the platform's MASTER key (full access on the platform's Resend
 * team). It is used for exactly two kinds of call: managing domains, and
 * minting per-clone keys. It is never written to any clone. What a clone
 * receives is the OUTPUT of `createApiKey` — a `sending_access` key scoped by
 * `domain_id` to that clone's own verified domain, which cannot list domains,
 * mint keys, or send as anybody else.
 *
 * ## The one-shot token
 *
 * `POST /api-keys` returns the key token exactly once. There is no read-back.
 * Callers must write it to its destination in the same flow that minted it,
 * and store at most an identifier (id + last four) — never the token.
 */
import { withRetry, isTransientHttpError } from "@/lib/with-retry";

const RESEND_BASE = "https://api.resend.com";

export class ResendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Resend's own error name, e.g. "validation_error", when the body carried one. */
    public readonly code: string | null,
  ) {
    super(message);
    this.name = "ResendError";
  }
}

export function resendMasterToken(): string {
  const t = process.env.RESEND_MASTER_API_KEY?.trim();
  if (!t) throw new Error("RESEND_MASTER_API_KEY not configured");
  return t;
}

/**
 * Whether the dedicated-email capability is live. The UI asks this so a
 * deployment without the master key shows "not configured yet" instead of a
 * provision button that can only fail.
 */
export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_MASTER_API_KEY?.trim());
}

type ResendErrorBody = { statusCode?: number; name?: string; message?: string };

async function resend<T>(path: string, init: RequestInit = {}): Promise<T> {
  return withRetry(
    async () => {
      const res = await fetch(`${RESEND_BASE}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${resendMasterToken()}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      if (res.status === 204) return undefined as T;
      const body = (await res.json().catch(() => null)) as (ResendErrorBody & T) | null;
      if (!res.ok) {
        throw new ResendError(
          body?.message ?? `Resend API ${res.status}`,
          res.status,
          body?.name ?? null,
        );
      }
      return body as T;
    },
    {
      attempts: 3,
      shouldRetry: (err) => {
        if (err instanceof ResendError) return err.status === 429 || err.status >= 500;
        return isTransientHttpError(err);
      },
    },
  );
}

/**
 * A DNS record Resend requires for a domain, verbatim from their API.
 * `record` is Resend's role label (SPF / DKIM); `type`/`name`/`value` are what
 * actually goes into DNS. `priority` is present on MX records only.
 */
export type ResendDnsRecord = {
  record: string;
  name: string;
  type: string;
  value: string;
  ttl?: string;
  priority?: number;
  status?: string;
};

export type ResendDomain = {
  id: string;
  name: string;
  status: string; // not_started | pending | verified | failure | temporary_failure
  region?: string;
  records?: ResendDnsRecord[];
  created_at?: string;
};

export type ResendApiKeySummary = { id: string; name: string; created_at: string };

export const resendApi = {
  /**
   * Register a sending domain. 4xx on a name that already exists — callers
   * adopt the existing domain via `listDomains` rather than treating that as
   * failure (see `ensureDomain` in email-identity.server.ts).
   */
  createDomain: (body: { name: string; region?: string }) =>
    resend<ResendDomain>("/domains", { method: "POST", body: JSON.stringify(body) }),

  getDomain: (id: string) => resend<ResendDomain>(`/domains/${id}`),

  listDomains: () => resend<{ data: ResendDomain[] }>("/domains"),

  /** Ask Resend to (re)check the domain's DNS. Status arrives via getDomain. */
  verifyDomain: (id: string) =>
    resend<{ object: string; id: string }>(`/domains/${id}/verify`, { method: "POST" }),

  deleteDomain: (id: string) => resend<void>(`/domains/${id}`, { method: "DELETE" }),

  /**
   * Mint an API key. With `permission: "sending_access"` and a `domain_id`,
   * the key can send from that domain and do nothing else — the shape every
   * clone receives. The returned `token` is shown exactly once.
   */
  createApiKey: (body: {
    name: string;
    permission: "full_access" | "sending_access";
    domain_id?: string;
  }) =>
    resend<{ id: string; token: string }>("/api-keys", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  listApiKeys: () => resend<{ data: ResendApiKeySummary[] }>("/api-keys"),

  deleteApiKey: (id: string) => resend<void>(`/api-keys/${id}`, { method: "DELETE" }),
};
