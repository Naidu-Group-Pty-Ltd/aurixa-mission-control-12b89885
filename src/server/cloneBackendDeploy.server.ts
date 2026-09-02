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
import {
  assessRepoWriteCapabilities,
  explainMissingDeployerVariable,
  type RepoWriteCapabilities,
} from "@/server/githubAppCapability.pure";
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
  /**
   * Why the last pass failed, when one did.
   *
   * `last_error` was READ and then discarded, so a run stuck in `executing`
   * or retrying showed a status and nothing else — which is precisely what
   * made the first live edge-function deploy undiagnosable without database
   * access. The column existed the whole time.
   */
  readonly lastError: string | null;
  /**
   * How far a resumable run has got: bundles deployed so far, and whether it
   * expects another pass. An `executing` row with no progress reads exactly
   * like one that is working, and they need different responses.
   */
  readonly progress: string | null;
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
  /** What GitHub says this App installation may write on this repository. */
  readonly capabilities: RepoWriteCapabilities;
  /**
   * Why this repository has no `BACKEND_DEPLOYED_BY`, when it has none.
   *
   * Null where the variable is set, or where nothing is known — an invented
   * explanation is worse than none. This is the line that turns "the deploy
   * check is red again" into a remedy an administrator can act on.
   */
  readonly deployerBlocker: string | null;
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
    capabilities: assessRepoWriteCapabilities(null),
    deployerBlocker: null,
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

  const [secretNames, variables, runs, lastTokenEvent, permissions] = await Promise.all([
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
    (async () => {
      const { readInstallationPermissions } = await import("@/server/github-variables.server");
      return readInstallationPermissions();
    })(),
  ]);

  // What Mission Control is PERMITTED to do here, asked of GitHub rather than
  // inferred from a write that quietly did nothing. A clone whose deploy check
  // fails on every push because one variable is missing must be able to say
  // which of "not written yet" and "not permitted" it is.
  const capabilities = assessRepoWriteCapabilities(permissions);
  const variableSet =
    (variables?.[BACKEND_DEPLOYER_VARIABLE] ?? null) === BACKEND_DEPLOYER_MISSION_CONTROL;

  return {
    capabilities,
    deployerBlocker: explainMissingDeployerVariable({ variableSet, capabilities }),
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
      lastError: typeof row.last_error === "string" && row.last_error ? row.last_error : null,
      progress: describeProgress(result),
    };
  });
}

/**
 * A resumable run's progress, in the units an operator cares about.
 *
 * Null where the run has recorded nothing — an empty `result` is the ordinary
 * state for a pass that has not finished one batch yet, and inventing a "0
 * deployed" for it would read as failure rather than as not-yet.
 */
function describeProgress(result: Record<string, unknown>): string | null {
  const deployed = typeof result.deployed === "number" ? result.deployed : null;
  if (deployed === null) return null;
  const resuming = result.resuming === true;
  const failed = Array.isArray(result.failed) ? result.failed.length : 0;
  const parts = [`${deployed} deployed`];
  if (failed > 0) parts.push(`${failed} failed`);
  parts.push(resuming ? "more to come" : "complete");
  return parts.join(" · ");
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

  // Through the shared helper, which logs a failed insert rather than
  // discarding it. An access decision that happened and was not recorded is
  // exactly the thing an audit trail exists to make impossible to miss.
  const { writeAuditLog } = await import("@/server/audit.server");
  await writeAuditLog({
    action: TOKEN_ATTACHED_ACTION,
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
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
  const { writeAuditLog } = await import("@/server/audit.server");
  await writeAuditLog({
    action: TOKEN_REMOVED_ACTION,
    entityType: "clone",
    entityId: input.cloneId,
    actorUserId: input.actorUserId,
    metadata: { repo: `${clone.github_owner}/${clone.github_repo}` },
  });

  return { ok: true };
}

/**
 * Declare Mission Control as this repository's backend deployer, now.
 *
 * The declaration already happens on every cascade that queues backend work,
 * but a clone whose cascade landed before that code shipped — or whose write
 * was refused — has no way back except waiting for the next cascade. This is
 * that way back, and it is also the diagnostic: it returns GitHub's own
 * refusal rather than a summary of it, because "Resource not accessible by
 * integration" names the remedy and "could not declare the deployer" does not.
 *
 * Idempotent, and verified by reading the variable back — a write that
 * returned without throwing is not a variable the workflow can read.
 */
export async function declareCloneDeployer(
  cloneId: string,
): Promise<{ ok: boolean; error: string | null }> {
  const { data: clone, error: cloneErr } = await admin
    .from("clones")
    .select("github_owner, github_repo")
    .eq("id", cloneId)
    .maybeSingle();
  if (cloneErr) return { ok: false, error: `Could not read the clone: ${cloneErr.message}` };
  if (!clone?.github_owner || !clone?.github_repo) {
    return { ok: false, error: "This clone has no GitHub repository on record." };
  }

  const { declareMissionControlDeploysBackend } = await import("@/server/github-variables.server");
  const declared = await declareMissionControlDeploysBackend({
    owner: clone.github_owner,
    repo: clone.github_repo,
  });
  return declared.ok ? { ok: true, error: null } : { ok: false, error: declared.error };
}
