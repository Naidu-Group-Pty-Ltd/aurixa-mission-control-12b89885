/**
 * The two routes by which a clone's Supabase backend gets deployed, and the
 * operator surface over them.
 *
 * `cloneBackendDeploy.pure.ts` holds the rules; this is the plumbing — read
 * the repository's own configuration, probe a candidate token against the
 * Supabase API, place or remove it, and gather the trail.
 *
 * ## What is never done here
 *
 * The prime's own Management API token is never written anywhere outside
 * Mission Control. `SB_MGMT_API_TOKEN` reaches this file's imports and no
 * further: the only token that can be placed in a clone repository is one an
 * operator supplies for that clone, and only after the API has been asked what
 * it can actually see.
 *
 * ## The trail
 *
 * Nothing about the route is stored, because a stored answer is one nothing
 * has to keep true. GitHub reports which Actions secrets and variables a
 * repository holds — names only, never values — and the clone's workflow reads
 * those same two names, so the route is read off the thing that decides it.
 *
 * What IS recorded is each act: `audit_log` gets a row naming the clone, the
 * actor, the token's class and every check that ran. Never the token.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  classifyAccessToken,
  deriveDeployRoute,
  judgeTokenScope,
  type DeployRoute,
  type ScopeVerdict,
  type TokenClass,
} from "@/server/cloneBackendDeploy.pure";
import {
  BACKEND_DEPLOYER_MISSION_CONTROL,
  BACKEND_DEPLOYER_VARIABLE,
} from "@/server/github-variables.server";

const admin = supabaseAdmin;

const MGMT_API = "https://api.supabase.com/v1";

/** The names this platform reads and writes on a clone repository. */
export const ACCESS_TOKEN_SECRET = "SUPABASE_ACCESS_TOKEN";
export const PROJECT_REF_VARIABLE = "SUPABASE_PROJECT_REF";

export const TOKEN_ATTACHED_ACTION = "clone.backend_deploy_token_attached";
export const TOKEN_REMOVED_ACTION = "clone.backend_deploy_token_removed";

/** A probe is a question, not a wait. Ten seconds is generous for one GET. */
const PROBE_TIMEOUT_MS = 10_000;

export type BackendDeployRun = {
  readonly id: string;
  readonly action: string;
  readonly status: string;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly detail: string | null;
  readonly reasons: readonly string[];
};

export type BackendDeployState = {
  readonly route: DeployRoute;
  readonly repo: { readonly owner: string; readonly repo: string } | null;
  readonly projectRef: string | null;
  /** What Mission Control has queued or run for this clone's backend. */
  readonly runs: readonly BackendDeployRun[];
  /** The last time a token was placed or removed here, from the audit trail. */
  readonly lastTokenEvent: {
    readonly action: string;
    readonly at: string;
    readonly by: string | null;
  } | null;
  /** Set when the state itself could not be assembled. */
  readonly error: string | null;
};

/** Everything the card needs, in one read. */
export async function getCloneBackendDeployState(cloneId: string): Promise<BackendDeployState> {
  const empty: BackendDeployState = {
    route: deriveDeployRoute({
      hasAccessTokenSecret: null,
      deployerVariable: null,
      projectRefVariable: null,
      hasBackendProject: false,
    }),
    repo: null,
    projectRef: null,
    runs: [],
    lastTokenEvent: null,
    error: null,
  };

  const { data: clone, error: cloneErr } = await admin
    .from("clones")
    .select("github_owner, github_repo")
    .eq("id", cloneId)
    .maybeSingle();
  if (cloneErr) return { ...empty, error: `Could not read the clone: ${cloneErr.message}` };
  if (!clone?.github_owner || !clone?.github_repo) {
    return { ...empty, error: "This clone has no GitHub repository on record." };
  }

  const { data: backend } = await admin
    .from("clone_backends")
    .select("supabase_project_ref")
    .eq("clone_id", cloneId)
    .maybeSingle();
  const projectRef = backend?.supabase_project_ref ?? null;

  const [secretNames, variables, runs, lastTokenEvent] = await Promise.all([
    (async () => {
      const { listRepoSecretNames } = await import("@/server/github-secrets.server");
      return listRepoSecretNames({ owner: clone.github_owner, repo: clone.github_repo });
    })(),
    (async () => {
      const { listRepoVariables } = await import("@/server/github-variables.server");
      return listRepoVariables({ owner: clone.github_owner, repo: clone.github_repo });
    })(),
    readBackendRuns(cloneId),
    readLastTokenEvent(cloneId),
  ]);

  return {
    route: deriveDeployRoute({
      hasAccessTokenSecret: secretNames === null ? null : secretNames.includes(ACCESS_TOKEN_SECRET),
      deployerVariable: variables?.[BACKEND_DEPLOYER_VARIABLE] ?? null,
      projectRefVariable: variables?.[PROJECT_REF_VARIABLE] ?? null,
      hasBackendProject: Boolean(projectRef),
    }),
    repo: { owner: clone.github_owner, repo: clone.github_repo },
    projectRef,
    runs,
    lastTokenEvent,
    error: null,
  };
}

/**
 * The backend work Mission Control has queued or run for this clone.
 *
 * These are the rows the cascade plans. Showing them beside the route is the
 * whole point of the card: "Mission Control deploys this" is a claim, and a
 * list of runs with their outcomes is the evidence for it.
 */
async function readBackendRuns(cloneId: string): Promise<BackendDeployRun[]> {
  const { data, error } = await admin
    .from("remediation_runs")
    .select("id, action_type, status, created_at, completed_at, plan, policy, last_error, result")
    .eq("clone_id", cloneId)
    .in("action_type", ["edge_function_deploy", "sql_migration"])
    .order("created_at", { ascending: false })
    .limit(10);
  if (error || !data) return [];

  return data.map((row) => {
    const plan = (row.plan ?? {}) as { reasons?: string[]; slugs?: string[] | null; mode?: string };
    const policy = (row.policy ?? {}) as { reasons?: string[] };
    const result = (row.result ?? {}) as Record<string, unknown>;
    const detail =
      row.last_error ??
      (typeof result.note === "string" ? result.note : null) ??
      (typeof result.applied === "number" ? `${result.applied} migration(s) applied` : null) ??
      (typeof result.deployed === "number" ? `${result.deployed} function(s) deployed` : null) ??
      (plan.slugs === null
        ? "every function"
        : Array.isArray(plan.slugs)
          ? `${plan.slugs.length} function(s)`
          : null);
    return {
      id: row.id,
      action: row.action_type,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      detail,
      // The plan's reasons say WHY the work was owed; the policy's say why it
      // was allowed to run unattended. An operator reading a surprising run
      // wants the first, and one reading a parked run wants the second.
      reasons: [...(plan.reasons ?? []), ...(policy.reasons ?? [])].slice(0, 4),
    };
  });
}

async function readLastTokenEvent(cloneId: string): Promise<BackendDeployState["lastTokenEvent"]> {
  const { data } = await admin
    .from("audit_log")
    .select("action, created_at, actor_user_id")
    .in("action", [TOKEN_ATTACHED_ACTION, TOKEN_REMOVED_ACTION])
    .eq("entity_id", cloneId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { action: data.action, at: data.created_at, by: data.actor_user_id ?? null };
}

type ProbeResult = { readonly reachable: boolean | null };

/** One GET against the Management API, with the candidate token. */
async function probeProject(token: string, ref: string): Promise<ProbeResult> {
  try {
    const res = await fetch(`${MGMT_API}/projects/${encodeURIComponent(ref)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) return { reachable: true };
    // 401/403/404 all mean "this token does not get that project". Anything
    // else is the API having a bad day, and a bad day is not a proof.
    if ([401, 403, 404].includes(res.status)) return { reachable: false };
    return { reachable: null };
  } catch {
    return { reachable: null };
  }
}

/** Which projects the token can enumerate, or null where it cannot enumerate. */
async function probeVisibleProjects(token: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${MGMT_API}/projects`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ id?: string; ref?: string }>;
    if (!Array.isArray(body)) return null;
    return body.map((p) => p.ref ?? p.id ?? "").filter(Boolean);
  } catch {
    return null;
  }
}

export type AttachResult =
  | { ok: true; verdict: ScopeVerdict; tokenClass: TokenClass; projectRef: string }
  | { ok: false; error: string; verdict?: ScopeVerdict };

/**
 * Place an operator-supplied scoped token in this clone's repository, so its
 * own CI can deploy.
 *
 * The token is judged BEFORE it is written, and a refusal writes nothing at
 * all — not the secret, not the variables, not an audit row claiming an
 * attachment. There is no force parameter: a token that cannot be shown to be
 * confined to this clone has no safe use here, and an override would be the
 * only thing anybody ever reached for.
 */
export async function attachCloneDeployToken(input: {
  cloneId: string;
  token: string;
  actorUserId: string | null;
}): Promise<AttachResult> {
  const token = input.token.trim();
  if (!token) return { ok: false, error: "No token was supplied." };

  const { data: clone } = await admin
    .from("clones")
    .select("github_owner, github_repo")
    .eq("id", input.cloneId)
    .maybeSingle();
  if (!clone?.github_owner || !clone?.github_repo) {
    return { ok: false, error: "This clone has no GitHub repository on record." };
  }

  const { data: backend } = await admin
    .from("clone_backends")
    .select("supabase_project_ref")
    .eq("clone_id", input.cloneId)
    .maybeSingle();
  const projectRef = backend?.supabase_project_ref ?? null;
  if (!projectRef) {
    return {
      ok: false,
      error:
        "This clone has no provisioned Supabase project, so there is nothing a " +
        "token could be scoped to yet.",
    };
  }

  const tokenClass = classifyAccessToken(token);

  // A classic token is refused on its prefix, before it is sent anywhere. No
  // answer a probe could give would make an account-wide token safe in a
  // tenant's repository, so asking would only cost a round trip and put the
  // value on the wire.
  if (tokenClass !== "scoped") {
    const verdict = judgeTokenScope({
      tokenClass,
      cloneProjectRef: projectRef,
      visibleProjectRefs: null,
      readsCloneProject: null,
      readsPrimeProject: null,
      primeProjectRef: null,
    });
    return { ok: false, error: verdict.reason, verdict };
  }

  const { resolvePrimeBackendRef } = await import("@/server/prime-backend.server");
  let primeProjectRef: string | null = null;
  try {
    primeProjectRef = await resolvePrimeBackendRef(admin);
  } catch {
    primeProjectRef = null;
  }

  const [visibleProjectRefs, cloneProbe, primeProbe] = await Promise.all([
    probeVisibleProjects(token),
    probeProject(token, projectRef),
    primeProjectRef ? probeProject(token, primeProjectRef) : Promise.resolve({ reachable: null }),
  ]);

  const verdict = judgeTokenScope({
    tokenClass,
    cloneProjectRef: projectRef,
    visibleProjectRefs,
    readsCloneProject: cloneProbe.reachable,
    readsPrimeProject: primeProbe.reachable,
    primeProjectRef,
  });
  if (!verdict.ok) return { ok: false, error: verdict.reason, verdict };

  const { putRepoSecret } = await import("@/server/github-secrets.server");
  const { putRepoVariable, deleteRepoVariable } = await import("@/server/github-variables.server");

  try {
    await putRepoSecret({
      owner: clone.github_owner,
      repo: clone.github_repo,
      name: ACCESS_TOKEN_SECRET,
      value: token,
    });
    // Its target, written in the same act. The workflow fails closed without
    // this, and a token with nowhere to deploy is a red check with a more
    // confusing message than the one it replaced.
    await putRepoVariable({
      owner: clone.github_owner,
      repo: clone.github_repo,
      name: PROJECT_REF_VARIABLE,
      value: projectRef,
    });
    // The stand-down marker is REMOVED, not left beside a live token. Two
    // statements about who deploys is how a card comes to disagree with a
    // workflow — and the workflow prefers the token anyway, so leaving it
    // would only mislead whoever reads the repository.
    await deleteRepoVariable({
      owner: clone.github_owner,
      repo: clone.github_repo,
      name: BACKEND_DEPLOYER_VARIABLE,
    });
  } catch (e) {
    return {
      ok: false,
      error: `The token was accepted but could not be written: ${
        e instanceof Error ? e.message : String(e)
      }`,
      verdict,
    };
  }

  await admin.from("audit_log").insert({
    action: TOKEN_ATTACHED_ACTION,
    entity_type: "clone",
    entity_id: input.cloneId,
    actor_user_id: input.actorUserId,
    // The class and the checks, never the token. This row is a record that an
    // access decision was taken, not a copy of the credential it was about.
    metadata: {
      token_class: tokenClass,
      project_ref: projectRef,
      checks: [...verdict.checks],
      repo: `${clone.github_owner}/${clone.github_repo}`,
    },
  });

  return { ok: true, verdict, tokenClass, projectRef };
}

/**
 * Take the token back out and return this clone to Mission Control.
 *
 * The order matters: the deployer is declared BEFORE the secret is removed, so
 * there is no window in which the repository has neither a token nor a
 * declaration — which is the one state whose deploy check fails.
 */
export async function detachCloneDeployToken(input: {
  cloneId: string;
  actorUserId: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: clone } = await admin
    .from("clones")
    .select("github_owner, github_repo")
    .eq("id", input.cloneId)
    .maybeSingle();
  if (!clone?.github_owner || !clone?.github_repo) {
    return { ok: false, error: "This clone has no GitHub repository on record." };
  }
  const target = { owner: clone.github_owner, repo: clone.github_repo };

  try {
    const { putRepoVariable } = await import("@/server/github-variables.server");
    await putRepoVariable({
      ...target,
      name: BACKEND_DEPLOYER_VARIABLE,
      value: BACKEND_DEPLOYER_MISSION_CONTROL,
    });

    const { deleteRepoSecret } = await import("@/server/github-secrets.server");
    await deleteRepoSecret({ ...target, name: ACCESS_TOKEN_SECRET });
  } catch (e) {
    return {
      ok: false,
      error: `Could not hand this clone back to Mission Control: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }

  // `SUPABASE_PROJECT_REF` is deliberately LEFT. It is not a credential, it is
  // a fact about which project this repository belongs to, and removing it
  // would only mean typing it again next time.
  await admin.from("audit_log").insert({
    action: TOKEN_REMOVED_ACTION,
    entity_type: "clone",
    entity_id: input.cloneId,
    actor_user_id: input.actorUserId,
    metadata: { repo: `${clone.github_owner}/${clone.github_repo}` },
  });

  return { ok: true };
}
