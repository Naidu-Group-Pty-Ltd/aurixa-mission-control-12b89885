/**
 * Vercel REST client — the only place this codebase talks to Vercel.
 *
 * Shaped after `src/server/cloudflare/client.ts` so the two outbound clients
 * read alike: a typed error carrying the status, one `withRetry` policy, and the
 * token read from `process.env` at call time rather than at module load (a
 * module-level read makes the token's absence a boot failure instead of a
 * dormant feature — see how the subdomain path stays dormant without
 * CLOUDFLARE_API_TOKEN).
 *
 * Two things Vercel does that Cloudflare does not:
 *
 *  1. **`Retry-After` on 429.** Vercel's limits are per-team and it tells you
 *     exactly how long to wait — often longer than a Worker request may live. So
 *     a 429 is surfaced rather than retried in-process, carrying its
 *     `retryAfterSeconds`, and the drain puts that into the job's
 *     `next_attempt_at` where the wait costs nothing.
 *  2. **A team-scoped query parameter on every request.** Omitting `teamId` on a
 *     team account does not error — it operates on the PERSONAL account, which
 *     is how you end up with a project nobody on the team can see. So `teamId`
 *     is threaded through every call rather than being read from a module
 *     constant.
 */
import { withRetry } from "@/lib/with-retry";

const VERCEL_BASE = "https://api.vercel.com";

export class VercelError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "VercelError";
  }
}

export function vercelToken(): string {
  const t = process.env.VERCEL_API_TOKEN;
  if (!t) throw new Error("VERCEL_API_TOKEN not configured");
  return t;
}

export function isVercelConfigured(): boolean {
  return Boolean(process.env.VERCEL_API_TOKEN);
}

/** The team the platform operates in, unless a call overrides it. */
export function defaultTeamId(): string | null {
  const t = process.env.VERCEL_TEAM_ID?.trim();
  return t ? t : null;
}

function withTeam(path: string, teamId?: string | null): string {
  const team = teamId ?? defaultTeamId();
  if (!team) return path;
  return path + (path.includes("?") ? "&" : "?") + `teamId=${encodeURIComponent(team)}`;
}

type VercelErrorBody = { error?: { code?: string; message?: string } };

async function vercel<T>(
  path: string,
  init: RequestInit & { teamId?: string | null } = {},
): Promise<T> {
  const { teamId, ...rest } = init;
  const url = `${VERCEL_BASE}${withTeam(path, teamId)}`;
  return withRetry(
    async () => {
      const res = await fetch(url, {
        ...rest,
        headers: {
          Authorization: `Bearer ${vercelToken()}`,
          "Content-Type": "application/json",
          ...(rest.headers ?? {}),
        },
      });
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // Vercel answers HTML for some gateway errors. Keep the status — it is
        // the part that decides whether this is worth retrying — and do not
        // pretend the body was JSON.
        json = null;
      }
      if (!res.ok) {
        const body = json as VercelErrorBody | null;
        const retryAfter = Number(res.headers.get("retry-after"));
        throw new VercelError(
          body?.error?.message ?? `Vercel API ${res.status}`,
          res.status,
          body?.error?.code ?? null,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        );
      }
      return json as T;
    },
    {
      attempts: 3,
      shouldRetry: (err) => {
        // 429 is NOT retried in-process. Vercel tells us how long to wait, and
        // that wait is often longer than a Worker request may live — burning it
        // inside one invocation costs the whole pass and arrives no earlier. The
        // drain persists `retryAfterSeconds` into `next_attempt_at` instead, so
        // the wait happens between ticks where it is free. A busy-wait here
        // would also block the event loop, which on Workers means blocking every
        // other request the isolate is serving.
        if (err instanceof VercelError) return err.status >= 500;
        return true; // network-level failure
      },
    },
  );
}

// ── Types (only the fields we use) ─────────────────────────────────────────

export type VercelProject = {
  id: string;
  name: string;
  accountId?: string;
  framework?: string | null;
  link?: { type?: string; org?: string; repo?: string } | null;
  latestDeployments?: Array<{ id: string; url?: string; readyState?: string }>;
};

export type VercelDeployment = {
  id: string;
  uid?: string;
  url?: string;
  readyState?: string;
  status?: string;
};

export type VercelDomain = {
  name: string;
  verified: boolean;
  verification?: Array<{ type: string; domain: string; value: string; reason?: string }>;
};

export type VercelEnvVar = {
  id: string;
  key: string;
  target?: string[];
  type?: string;
};

// ── Operations ─────────────────────────────────────────────────────────────

export const vercelApi = {
  getProjectByName(name: string, teamId?: string | null): Promise<VercelProject | null> {
    return vercel<VercelProject>(`/v9/projects/${encodeURIComponent(name)}`, { teamId }).catch(
      (e) => {
        if (e instanceof VercelError && e.status === 404) return null;
        throw e;
      },
    );
  },

  createProject(
    body: {
      name: string;
      framework?: string | null;
      gitRepository?: { type: "github"; repo: string };
      rootDirectory?: string | null;
      /** Held by the project from creation, before the link's first build reads it. */
      environmentVariables?: Array<{ key: string; value: string; type: string; target: string[] }>;
    },
    teamId?: string | null,
  ): Promise<VercelProject> {
    return vercel<VercelProject>("/v11/projects", {
      method: "POST",
      body: JSON.stringify(body),
      teamId,
    });
  },

  deleteProject(idOrName: string, teamId?: string | null): Promise<void> {
    return vercel<void>(`/v9/projects/${encodeURIComponent(idOrName)}`, {
      method: "DELETE",
      teamId,
    });
  },

  listEnv(projectId: string, teamId?: string | null): Promise<{ envs: VercelEnvVar[] }> {
    return vercel<{ envs: VercelEnvVar[] }>(`/v9/projects/${encodeURIComponent(projectId)}/env`, {
      teamId,
    });
  },

  upsertEnv(
    projectId: string,
    body: Array<{ key: string; value: string; type: string; target: string[] }>,
    teamId?: string | null,
  ): Promise<unknown> {
    // `upsert=true` makes this idempotent: re-pushing an unchanged variable is a
    // no-op instead of a 409 the caller has to distinguish from a real conflict.
    return vercel(`/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true`, {
      method: "POST",
      body: JSON.stringify(body),
      teamId,
    });
  },

  deleteEnv(projectId: string, envId: string, teamId?: string | null): Promise<void> {
    return vercel<void>(
      `/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}`,
      { method: "DELETE", teamId },
    );
  },

  createDeployment(
    body: {
      name: string;
      project: string;
      target: "production";
      gitSource: { type: "github"; org: string; repo: string; ref: string };
    },
    teamId?: string | null,
  ): Promise<VercelDeployment> {
    return vercel<VercelDeployment>("/v13/deployments", {
      method: "POST",
      body: JSON.stringify(body),
      teamId,
    });
  },

  /**
   * The most recent PRODUCTION deployment for a project.
   *
   * `limit=1` with `target=production` rather than fetching a page and filtering
   * client-side: the endpoint is paginated by time across every target, so a
   * project with a busy preview branch can push its last production build off
   * the first page entirely — and the sweep would then report "no production
   * build" for a clone that has been serving one for months.
   */
  latestProductionDeployment(
    projectId: string,
    teamId?: string | null,
  ): Promise<VercelDeployment | null> {
    const q = new URLSearchParams({ projectId, target: "production", limit: "1" });
    return vercel<{ deployments?: VercelDeployment[] }>(`/v6/deployments?${q.toString()}`, {
      teamId,
    }).then((r) => r.deployments?.[0] ?? null);
  },

  getDeployment(deploymentId: string, teamId?: string | null): Promise<VercelDeployment> {
    return vercel<VercelDeployment>(`/v13/deployments/${encodeURIComponent(deploymentId)}`, {
      teamId,
    });
  },

  addDomain(projectId: string, name: string, teamId?: string | null): Promise<VercelDomain> {
    return vercel<VercelDomain>(`/v10/projects/${encodeURIComponent(projectId)}/domains`, {
      method: "POST",
      body: JSON.stringify({ name }),
      teamId,
    });
  },

  getDomain(projectId: string, name: string, teamId?: string | null): Promise<VercelDomain | null> {
    return vercel<VercelDomain>(
      `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(name)}`,
      { teamId },
    ).catch((e) => {
      if (e instanceof VercelError && e.status === 404) return null;
      throw e;
    });
  },

  verifyDomain(projectId: string, name: string, teamId?: string | null): Promise<VercelDomain> {
    return vercel<VercelDomain>(
      `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(name)}/verify`,
      { method: "POST", teamId },
    );
  },
};
