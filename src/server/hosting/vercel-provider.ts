/**
 * Vercel implementation of the HostingProvider contract.
 *
 * The one rule this file exists to keep is R3: NEVER CREATE A SECOND PROJECT FOR
 * A CLONE. `provisionClone` learned the duplicate lesson expensively — a
 * double-click forked two GitHub repos, which is why `idempotency_key` exists —
 * and a duplicate hosting project is worse, because the second one takes the
 * custom domain while the first keeps building and serving.
 *
 * So `createOrAdoptProject` looks the project up by name FIRST and adopts it,
 * and treats a `409 Conflict` on create as an adoption rather than an error: two
 * drains racing on the same clone is a thing the queue is designed to survive,
 * and losing that race must not fail the job.
 */
import type { CloneEnvVar } from "./envPolicy.pure";
import type {
  CreateProjectInput,
  DeployResult,
  DomainResult,
  HostingProvider,
  ProjectResult,
} from "./providers";
import { VercelError, defaultTeamId, isVercelConfigured, vercelApi } from "./vercel-client";

function mapState(raw: string | null | undefined): DeployResult["state"] {
  switch ((raw ?? "").toUpperCase()) {
    case "READY":
      return "ready";
    case "ERROR":
      return "error";
    case "CANCELED":
      return "canceled";
    case "BUILDING":
    case "INITIALIZING":
      return "building";
    default:
      return "queued";
  }
}

/** Vercel returns a bare host on deployments; everything downstream wants an origin. */
function toOrigin(url: string | null | undefined): string | null {
  const u = url?.trim();
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

export const vercelProvider: HostingProvider = {
  slug: "vercel",
  status: "live",

  isConfigured: isVercelConfigured,

  async createOrAdoptProject(input: CreateProjectInput): Promise<ProjectResult> {
    const teamId = defaultTeamId();
    const repo = `${input.repo.owner}/${input.repo.name}`;

    const existing = await vercelApi.getProjectByName(input.name, teamId);
    if (existing) {
      return {
        projectId: existing.id,
        projectName: existing.name,
        teamId,
        origin: `https://${existing.name}.vercel.app`,
        adopted: true,
        raw: existing,
      };
    }

    try {
      const created = await vercelApi.createProject(
        {
          name: input.name,
          framework: input.framework ?? "vite",
          gitRepository: { type: "github", repo },
          rootDirectory: input.rootDirectory ?? null,
        },
        teamId,
      );
      return {
        projectId: created.id,
        projectName: created.name,
        teamId,
        origin: `https://${created.name}.vercel.app`,
        adopted: false,
        raw: created,
      };
    } catch (e) {
      // Lost a race with another drain (or with an operator). Adopting is the
      // correct outcome, not an error — the project we wanted now exists.
      if (e instanceof VercelError && e.status === 409) {
        const found = await vercelApi.getProjectByName(input.name, teamId);
        if (found) {
          return {
            projectId: found.id,
            projectName: found.name,
            teamId,
            origin: `https://${found.name}.vercel.app`,
            adopted: true,
            raw: found,
          };
        }
      }
      throw e;
    }
  },

  async syncEnv(projectId, vars: CloneEnvVar[], teamId) {
    const team = teamId ?? defaultTeamId();
    if (vars.length === 0) return { written: 0, removed: 0 };
    await vercelApi.upsertEnv(
      projectId,
      vars.map((v) => ({
        key: v.key,
        value: v.value,
        // "encrypted" is Vercel's at-rest classification and says nothing about
        // whether the bundler inlines the value — that is decided by the NAME,
        // in envPolicy. Encrypting everything is right at rest and changes
        // nothing about exposure in the artefact.
        type: "encrypted",
        target: v.targets,
      })),
      team,
    );
    return { written: vars.length, removed: 0 };
  },

  async describeProject(projectId, teamId) {
    const project = await vercelApi.getProjectByName(projectId, teamId ?? defaultTeamId());
    if (!project) return { found: false, name: null, linkedRepo: null };
    const org = project.link?.org;
    const repo = project.link?.repo;
    return {
      found: true,
      name: project.name ?? null,
      linkedRepo: org && repo ? `${org}/${repo}` : null,
    };
  },

  async deploy(projectId, opts): Promise<DeployResult> {
    const team = opts.teamId ?? defaultTeamId();
    const project = await vercelApi.getProjectByName(projectId, team);
    // Two different failures used to share one message here, and they send an
    // operator to different screens: a project this token cannot SEE (moved
    // into a team, renamed, deleted) and a project with no git link both read
    // as `project?.link?.org == null`. The night that mattered, the operator
    // had re-linked a repository in Vercel and the pipeline kept saying "no
    // linked GitHub repository" — with no way to tell whether the link had
    // gone to a different project or the project itself had left this token's
    // sight.
    if (!project) {
      throw new VercelError(
        `Vercel project ${projectId} is not visible to this token — it may have been ` +
          `moved into a team, renamed, or deleted. Check which project the token's ` +
          `account actually holds.`,
        404,
        "project_not_found",
      );
    }
    const org = project.link?.org;
    const repo = project.link?.repo;
    if (!org || !repo) {
      // A project with no git link cannot be deployed from a ref, and asking
      // Vercel to do it anyway answers 400 five times over five attempts. Fail
      // loudly with the reason instead.
      throw new VercelError(
        `Vercel project ${project.name ?? projectId} exists but has no linked GitHub ` +
          `repository. Link it in that project's Settings → Git.`,
        400,
        "no_git_link",
      );
    }
    const created = await vercelApi.createDeployment(
      {
        name: project.name,
        project: project.id,
        target: "production",
        gitSource: { type: "github", org, repo, ref: opts.ref },
      },
      team,
    );
    return {
      deploymentId: created.id ?? created.uid ?? "",
      url: toOrigin(created.url),
      state: mapState(created.readyState ?? created.status),
      raw: created,
    };
  },

  async getDeployment(deploymentId, teamId): Promise<DeployResult> {
    const d = await vercelApi.getDeployment(deploymentId, teamId ?? defaultTeamId());
    return {
      deploymentId: d.id ?? d.uid ?? deploymentId,
      url: toOrigin(d.url),
      state: mapState(d.readyState ?? d.status),
      raw: d,
    };
  },

  async latestProductionBuild(projectId, teamId) {
    const d = await vercelApi.latestProductionDeployment(projectId, teamId ?? defaultTeamId());
    if (!d) return null;
    const id = d.id ?? d.uid ?? null;
    return {
      deploymentId: id ?? "",
      url: toOrigin(d.url),
      state: mapState(d.readyState ?? d.status),
      raw: d,
    };
  },

  async attachDomain(projectId, domain, teamId): Promise<DomainResult> {
    const team = teamId ?? defaultTeamId();
    let d;
    try {
      d = await vercelApi.addDomain(projectId, domain, team);
    } catch (e) {
      // Already attached to THIS project is success. Already attached to
      // ANOTHER project is a real conflict and must not be swallowed — that is
      // the duplicate-project failure arriving by its second route.
      if (e instanceof VercelError && e.status === 409) {
        const existing = await vercelApi.getDomain(projectId, domain, team);
        if (!existing) throw e;
        d = existing;
      } else {
        throw e;
      }
    }
    return toDomainResult(d, domain);
  },

  async getDomain(projectId, domain, teamId): Promise<DomainResult> {
    const team = teamId ?? defaultTeamId();
    // Ask Vercel to re-check rather than reading a cached flag: the whole point
    // of this call is "has the DNS we just wrote taken effect yet".
    let d;
    try {
      d = await vercelApi.verifyDomain(projectId, domain, team);
    } catch {
      d = await vercelApi.getDomain(projectId, domain, team);
    }
    if (!d) {
      return { domain, verified: false, challenges: [], dnsTargetType: null, dnsTargetValue: null };
    }
    return toDomainResult(d, domain);
  },

  async removeProject(projectId, teamId) {
    await vercelApi.deleteProject(projectId, teamId ?? defaultTeamId());
  },
};

function toDomainResult(
  d: {
    name?: string;
    verified?: boolean;
    verification?: Array<{ type: string; domain: string; value: string; reason?: string }>;
  },
  fallbackDomain: string,
): DomainResult {
  const challenges = (d.verification ?? []).map((v) => ({
    type: v.type,
    domain: v.domain,
    value: v.value,
    reason: v.reason ?? null,
  }));
  // An apex domain needs an A record; anything with a label above it takes a
  // CNAME. Vercel publishes both values and they do not change per project.
  const name = d.name ?? fallbackDomain;
  const isApex = name.split(".").length <= 2;
  return {
    domain: name,
    verified: Boolean(d.verified),
    dnsTargetType: isApex ? "A" : "CNAME",
    dnsTargetValue: isApex ? "76.76.21.21" : "cname.vercel-dns.com",
    challenges,
    raw: d,
  };
}
