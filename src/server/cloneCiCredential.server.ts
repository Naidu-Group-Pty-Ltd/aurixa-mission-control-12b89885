/**
 * Give every clone repository the credentials its own scheduled CI needs: a
 * database URL to apply a migration and report drift with, and its own
 * service-role key for the sanctions, PEP and RBA refreshes. See
 * `cloneCiCredential.pure.ts` for why each is the shape it is, why neither is
 * a Supabase access token, and why both are written into the
 * `supabase-production` environment rather than the repository.
 *
 * The pass is idempotent and settles: GitHub never returns a secret's value,
 * so there is nothing to compare against and the write is repeated, once a
 * day (`REASSERT_AFTER_MS`) or at once when Mission Control has just changed
 * the value. A settled clone costs one variable listing, two reads of its
 * environment's branch policy and one metadata read per secret a pass, and a
 * re-write is recorded as `kept`, so a settled fleet files nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  CI_DB_URL_SECRET,
  CI_ENVIRONMENT,
  CI_ENVIRONMENT_POLICY,
  CI_PROJECT_REF_VARIABLE,
  CI_SERVICE_ROLE_SECRET,
  claimedSealedPassword,
  composeSessionPoolerUrl,
  decidePasswordSet,
  emptyCredentialSweep,
  judgeServiceRoleKey,
  pendingPassword,
  recordOutcome,
  type CredentialOutcome,
  type CredentialSweep,
  type PoolerFacts,
} from "./cloneCiCredential.pure";

type Db = SupabaseClient<Database>;

const MGMT_API = "https://api.supabase.com/v1";

/**
 * What Supabase says this project's shared pooler is.
 *
 * `null` where the answer could not be had — a failed read is not a project
 * without a pooler, and composing from a guessed host would produce a
 * credential that fails at connect time in somebody else's CI job.
 */
export async function readPoolerFacts(projectRef: string): Promise<PoolerFacts | null> {
  const token = process.env.SB_MGMT_API_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`${MGMT_API}/projects/${projectRef}/config/database/pooler`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`[cloneCiCredential] pooler config for ${projectRef}: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as unknown;
    // The endpoint has returned both an object and an array of one across
    // versions. Take whichever shape arrives rather than assuming.
    const row = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
    if (!row) return null;

    // Prefer the connection string Supabase composes itself: it is the one
    // place the host, the user and the port are guaranteed to agree.
    const connection = typeof row.connection_string === "string" ? row.connection_string : null;
    if (connection) {
      try {
        const u = new URL(connection);
        return {
          host: u.hostname,
          user: decodeURIComponent(u.username),
          port: u.port ? Number(u.port) : null,
        };
      } catch {
        // Fall through to the discrete fields.
      }
    }
    const host = typeof row.db_host === "string" ? row.db_host : null;
    const user = typeof row.db_user === "string" ? row.db_user : null;
    const port = typeof row.db_port === "number" ? row.db_port : null;
    if (!host && !user) return null;
    return { host, user, port };
  } catch (e) {
    console.error(`[cloneCiCredential] pooler config for ${projectRef}:`, e);
    return null;
  }
}

/**
 * Give a clone's database a password, through Supabase's own endpoint, and
 * keep it.
 *
 * Only ever called for a clone `decidePasswordSet` cleared: none confirmed,
 * and no deploy token of the tenant's own.
 *
 * The row is CLAIMED before Supabase is told: a new password is written, marked
 * pending (`pendingPassword`), only while the row holds nothing and still
 * names this project, and only the pass that wins that write goes on. Two
 * overlapping sweeps would otherwise both reset the database, and whichever
 * stored second could keep a password it no longer takes.
 *
 * A claim found already standing — another pass's, or one this pass's
 * predecessor stopped inside — is FINISHED rather than refused: the same
 * password is sent again and confirmed. That is what makes every interruption
 * recoverable. Stopped before the reset, the next pass makes it; stopped after
 * it, the next pass repeats it, which changes nothing; and a pending value is
 * never handed out as a credential in the meantime.
 */
async function setCloneDbPassword(input: {
  supabase: Db;
  cloneId: string;
  projectRef: string;
  /** The row's stored value when it is a standing claim, to be finished. */
  standingClaim: string | null;
}): Promise<{ ok: true; password: string } | { ok: false; reason: string }> {
  const token = process.env.SB_MGMT_API_TOKEN;
  if (!token) return { ok: false, reason: "SB_MGMT_API_TOKEN is not configured" };
  const { encryptSecret, decryptSecret } = await import("./crypto.server");

  let claim: string;
  let password: string;
  const standingSealed = claimedSealedPassword(input.standingClaim);
  if (input.standingClaim && standingSealed) {
    claim = input.standingClaim;
    // Re-read rather than trusted: the claim was read before the target was
    // resolved, and a re-provision in between would pair one project's claim
    // with another project's reset.
    const { data: standing, error: standingError } = await input.supabase
      .from("clone_backends")
      .select("clone_id")
      .eq("clone_id", input.cloneId)
      .eq("supabase_project_ref", input.projectRef)
      .eq("db_pass", claim);
    if (standingError) {
      return {
        ok: false,
        reason: `the standing claim could not be re-read: ${standingError.message}`,
      };
    }
    if (!standing || standing.length === 0) {
      return {
        ok: false,
        reason: `the standing claim no longer belongs to ${input.projectRef}; nothing was reset`,
      };
    }
    try {
      password = decryptSecret(standingSealed);
    } catch (e) {
      return {
        ok: false,
        reason: `the standing password claim could not be read: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else {
    const { generateSecurePassword } = await import("./backend-provisioning.server");
    password = generateSecurePassword();
    claim = pendingPassword(encryptSecret(password));
    const { data: claimed, error: claimError } = await input.supabase
      .from("clone_backends")
      .update({ db_pass: claim })
      .eq("clone_id", input.cloneId)
      .eq("supabase_project_ref", input.projectRef)
      .is("db_pass", null)
      .select("clone_id");
    if (claimError) {
      return { ok: false, reason: `the password could not be claimed: ${claimError.message}` };
    }
    if (!claimed || claimed.length === 0) {
      return {
        ok: false,
        reason:
          "another pass claimed a password for this clone, or it no longer points at " +
          `${input.projectRef}; the next pass finishes whatever stands`,
      };
    }
  }

  try {
    const res = await fetch(`${MGMT_API}/projects/${input.projectRef}/database/password`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason:
          `Supabase refused the password for ${input.projectRef}: HTTP ${res.status} ` +
          `${(await res.text()).slice(0, 200)}; the claim stands and the next pass sends it again`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      reason: `${e instanceof Error ? e.message : String(e)}; the claim stands and the next pass sends it again`,
    };
  }

  // Confirmed only over THIS claim, so a row that has moved on is left alone.
  const { data: confirmed, error: confirmError } = await input.supabase
    .from("clone_backends")
    .update({ db_pass: encryptSecret(password) })
    .eq("clone_id", input.cloneId)
    .eq("supabase_project_ref", input.projectRef)
    .eq("db_pass", claim)
    .select("clone_id");
  if (confirmError || !confirmed || confirmed.length === 0) {
    return {
      ok: false,
      reason:
        `Supabase took the password but it could not be confirmed` +
        (confirmError ? ` (${confirmError.message})` : " (the claim had moved)") +
        "; the next pass finishes whatever stands",
    };
  }
  return { ok: true, password };
}

/**
 * How long a credential already in the environment is trusted before it is
 * written again. GitHub cannot say whether it still holds what Mission Control
 * would send, so it is re-asserted, but once a day rather than every half
 * hour: the steady state is then one metadata read per secret. A value known
 * to have changed (a password set this pass) is written at once.
 */
const REASSERT_AFTER_MS = 24 * 3600 * 1000;

/** Write one secret into the clone's production environment, as an outcome. */
async function writeEnvironmentSecret(input: {
  owner: string;
  repo: string;
  name: string;
  value: string;
  changed: boolean;
  /** The only branch the environment admits if this write has to create it. */
  deploymentBranch: string | null;
}): Promise<CredentialOutcome> {
  const label = `${input.owner}/${input.repo}`;
  try {
    const { putEnvironmentSecret } = await import("./github-secrets.server");
    const { created } = await putEnvironmentSecret({
      owner: input.owner,
      repo: input.repo,
      environment: CI_ENVIRONMENT,
      deploymentBranch: input.deploymentBranch,
      name: input.name,
      value: input.value,
      ...(input.changed ? {} : { reassertAfterMs: REASSERT_AFTER_MS }),
    });
    return { repo: label, secret: input.name, state: created ? "distributed" : "kept" };
  } catch (e) {
    const { describeSecretError } = await import("./github-secrets.server");
    const { message } = describeSecretError(e, input.owner, input.repo);
    return { repo: label, secret: input.name, state: "failed", reason: message };
  }
}

/**
 * Keep the clone's production environment admitting its default branch and
 * nothing else, as outcomes for the sweep.
 *
 * Settled is silent: an environment already restricted produces no outcome at
 * all, so a quiet fleet files nothing. A refusal is reported beside the
 * credentials and never thrown, the way a refused secret is, because the
 * credentials are what keep this clone's scheduled refreshes running and they
 * must not wait on a permission this step lacks.
 */
async function restrictProductionEnvironment(input: {
  owner: string;
  repo: string;
  branch: string | null;
}): Promise<CredentialOutcome[]> {
  const label = `${input.owner}/${input.repo}`;
  if (!input.branch) {
    return [
      {
        repo: label,
        secret: CI_ENVIRONMENT_POLICY,
        state: "cannot",
        reason:
          "no default branch is recorded for this clone, so its production environment was " +
          "not restricted to one; naming a guessed branch would refuse its scheduled jobs",
      },
    ];
  }
  const { ensureEnvironmentBranchPolicy } = await import("./github-secrets.server");
  const outcome = await ensureEnvironmentBranchPolicy({
    owner: input.owner,
    repo: input.repo,
    environment: CI_ENVIRONMENT,
    branch: input.branch,
  });
  if (outcome.state === "unchanged") return [];
  const outcomes: CredentialOutcome[] = [];
  if (outcome.changes.length > 0) {
    outcomes.push({ repo: label, state: "restricted", detail: outcome.changes.join("; ") });
  }
  if (outcome.state === "failed") {
    outcomes.push({
      repo: label,
      secret: CI_ENVIRONMENT_POLICY,
      state: "failed",
      reason: outcome.reason,
    });
  }
  return outcomes;
}

/**
 * A credential as the sweep found it: a value to write, or why there is none.
 * A `failed` reason is something that went wrong this pass; a `cannot` one is
 * a state that will hold until somebody changes it.
 */
export type HeldCredential =
  /** `changed`: set this pass, so written at once rather than on the daily re-assertion. */
  { value: string | null; changed?: boolean } | { state: "cannot" | "failed"; reason: string };

/**
 * Write the clone's credentials into its production environment, and the
 * project ref beside them.
 *
 * The ref is a VARIABLE rather than a secret on purpose: the workflows fail
 * closed without a route, and an operator reading a red run needs to be able
 * to see which project it was pointed at. It is written whether or not either
 * credential could be, because it is a fact about the repository rather than
 * a credential. It is written only where the repository's variables, read
 * once per pass by the caller, do not already say it (or could not be read).
 */
export async function distributeCloneCiCredentials(input: {
  owner: string;
  repo: string;
  projectRef: string;
  password: HeldCredential;
  serviceRoleKey: HeldCredential;
  /** The repository's variables, or null when GitHub could not be asked. */
  variables: Readonly<Record<string, string>> | null;
  /** `clones.default_branch`: all a newly created environment admits. */
  deploymentBranch: string | null;
}): Promise<CredentialOutcome[]> {
  const label = `${input.owner}/${input.repo}`;
  const outcomes: CredentialOutcome[] = [];
  const target = { owner: input.owner, repo: input.repo };

  if (input.variables?.[CI_PROJECT_REF_VARIABLE] !== input.projectRef) {
    try {
      const { putRepoVariable } = await import("./github-variables.server");
      await putRepoVariable({ ...target, name: CI_PROJECT_REF_VARIABLE, value: input.projectRef });
    } catch (e) {
      outcomes.push({
        repo: label,
        secret: CI_PROJECT_REF_VARIABLE,
        state: "failed",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if ("reason" in input.password) {
    outcomes.push({ repo: label, secret: CI_DB_URL_SECRET, ...input.password });
  } else {
    const pooler = await readPoolerFacts(input.projectRef);
    const composed = pooler
      ? composeSessionPoolerUrl({
          projectRef: input.projectRef,
          password: input.password.value,
          pooler,
        })
      : {
          ok: false as const,
          reason: `Supabase would not report the pooler for ${input.projectRef}`,
        };
    outcomes.push(
      composed.ok
        ? await writeEnvironmentSecret({
            ...target,
            name: CI_DB_URL_SECRET,
            value: composed.url,
            changed: input.password.changed === true,
            deploymentBranch: input.deploymentBranch,
          })
        : { repo: label, secret: CI_DB_URL_SECRET, state: "cannot", reason: composed.reason },
    );
  }

  if ("reason" in input.serviceRoleKey) {
    outcomes.push({ repo: label, secret: CI_SERVICE_ROLE_SECRET, ...input.serviceRoleKey });
  } else {
    const key = judgeServiceRoleKey({
      projectRef: input.projectRef,
      key: input.serviceRoleKey.value,
    });
    outcomes.push(
      key.ok
        ? await writeEnvironmentSecret({
            ...target,
            name: CI_SERVICE_ROLE_SECRET,
            value: key.key,
            changed: false,
            deploymentBranch: input.deploymentBranch,
          })
        : { repo: label, secret: CI_SERVICE_ROLE_SECRET, state: "cannot", reason: key.reason },
    );
  }

  return outcomes;
}

/** Every clone with a repository and a provisioned backend. */
export async function reconcileCloneCiCredentials(supabase: Db): Promise<CredentialSweep> {
  const sweep = emptyCredentialSweep();

  const { data: clones, error } = await supabase
    .from("clones")
    .select("id, github_owner, github_repo, default_branch")
    .not("github_owner", "is", null)
    .not("github_repo", "is", null);
  if (error) {
    sweep.failed.push({ repo: "*", secret: "*", reason: error.message });
    return sweep;
  }
  const targets = (clones ?? []).filter((c) => c.github_owner && c.github_repo);
  if (targets.length === 0) return sweep;

  const { decryptSecret } = await import("./crypto.server");
  const { resolveCloneSecretTarget } = await import("./cloneAllowedOrigins.server");
  const { listRepoVariables } = await import("./github-variables.server");
  const { listRepoSecretNames, listEnvironmentSecretNames } =
    await import("./github-secrets.server");
  // The name a tenant's own deploy token is kept under, from the module that
  // writes it rather than spelled again here.
  const { ACCESS_TOKEN_SECRET } = await import("./cloneBackendDeploy.server");
  const { writeAuditLog } = await import("./audit.server");

  const readStored = (value: unknown, what: string): HeldCredential => {
    if (!value) return { value: null };
    try {
      return { value: decryptSecret(value as string) };
    } catch (e) {
      return {
        state: "cannot",
        reason: `the stored ${what} could not be read: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  };

  for (const clone of targets) {
    const owner = clone.github_owner as string;
    const repo = clone.github_repo as string;
    const label = `${owner}/${repo}`;
    sweep.considered += 1;

    const { data: backend, error: backendError } = await supabase
      .from("clone_backends")
      .select("supabase_project_ref, db_pass, service_role_key")
      .eq("clone_id", clone.id)
      .maybeSingle();

    if (backendError) {
      recordOutcome(sweep, {
        repo: label,
        secret: "*",
        state: "failed",
        reason: backendError.message,
      });
      continue;
    }
    if (!backend?.supabase_project_ref) {
      recordOutcome(sweep, { repo: label, state: "no_backend" });
      continue;
    }

    // Which refs may read what this pass writes, settled BEFORE it writes:
    // created restricted when absent, brought to the default branch when it
    // admits more. Ahead of the target check below as well, because an
    // environment that already holds a credential is worth restricting even
    // on a pass that refuses to write it another.
    const deploymentBranch = clone.default_branch ?? null;
    for (const outcome of await restrictProductionEnvironment({
      owner,
      repo,
      branch: deploymentBranch,
    })) {
      recordOutcome(sweep, outcome);
    }

    // The one sanctioned way to a clone's project ref for a credential: it
    // refuses the prime's project and Mission Control's own, so neither can be
    // handed out, or given a password, even if the row were wrong.
    let projectRef: string;
    try {
      projectRef = (await resolveCloneSecretTarget(supabase, clone.id)).projectRef;
      // Two reads of one row: a re-provision between them would pair this
      // row's credentials with another project.
      if (projectRef !== backend.supabase_project_ref) {
        throw new Error(
          `this clone moved from ${backend.supabase_project_ref} to ${projectRef} during the pass; the next pass reads it again`,
        );
      }
    } catch (e) {
      recordOutcome(sweep, {
        repo: label,
        secret: "*",
        state: "cannot",
        reason: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    const variables = await listRepoVariables({ owner, repo });
    // A standing claim is not a credential: it is finished below, and until it
    // is, nothing is handed out for it.
    const standingClaim = claimedSealedPassword(backend.db_pass as string | null)
      ? (backend.db_pass as string)
      : null;
    let password = standingClaim
      ? ({ value: null } as HeldCredential)
      : readStored(backend.db_pass, "database password");
    if ("value" in password && !password.value) {
      // Asked only when a password is missing: two listings, where the
      // tenant's own deploy token would be if it had one.
      const [repoSecrets, environmentSecrets] = await Promise.all([
        listRepoSecretNames({ owner, repo }),
        listEnvironmentSecretNames({ owner, repo, environment: CI_ENVIRONMENT }),
      ]);
      const decision = decidePasswordSet({
        passwordStored: false,
        tenantDeployTokenHeld:
          repoSecrets === null || environmentSecrets === null
            ? null
            : [...repoSecrets, ...environmentSecrets].includes(ACCESS_TOKEN_SECRET),
      });
      if (!decision.set) {
        password = {
          state: "cannot",
          reason: decision.reason ?? "no database password is stored for this clone",
        };
      } else {
        const set = await setCloneDbPassword({
          supabase,
          cloneId: clone.id,
          projectRef,
          standingClaim,
        });
        if (set.ok) {
          password = { value: set.password, changed: true };
          sweep.passwordsSet.push(label);
          await writeAuditLog({
            action: "clone_db_password_set",
            entityType: "clone",
            entityId: clone.id,
            // The fact and its reason, never the password.
            metadata: {
              repo: label,
              project_ref: projectRef,
              reason: standingClaim
                ? "a standing password claim was finished"
                : "no database password was stored for this clone",
            },
          });
        } else {
          password = { state: "failed", reason: set.reason };
        }
      }
    }

    const outcomes = await distributeCloneCiCredentials({
      owner,
      repo,
      projectRef,
      password,
      serviceRoleKey: readStored(backend.service_role_key, "service-role key"),
      variables,
      deploymentBranch,
    });
    for (const outcome of outcomes) recordOutcome(sweep, outcome);
  }

  return sweep;
}
