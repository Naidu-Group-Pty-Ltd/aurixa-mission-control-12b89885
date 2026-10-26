/**
 * Give every clone repository the credentials its own scheduled CI needs: a
 * database URL to apply a migration and report drift with, and its own
 * service-role key for the sanctions, PEP and RBA refreshes. See
 * `cloneCiCredential.pure.ts` for why each is the shape it is, why neither is
 * a Supabase access token, and why both are written into the
 * `supabase-production` environment rather than the repository.
 *
 * The pass is idempotent and settles: GitHub never returns a secret's value,
 * so there is nothing to compare against and the write is simply repeated. It
 * is a few sealed-box PUTs per clone per sweep, which is the cheapest correct
 * thing available, and a re-write is recorded as `kept` so a settled fleet
 * files nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  CI_DB_URL_SECRET,
  CI_ENVIRONMENT,
  CI_PROJECT_REF_VARIABLE,
  CI_SERVICE_ROLE_SECRET,
  composeSessionPoolerUrl,
  decidePasswordSet,
  emptyCredentialSweep,
  judgeServiceRoleKey,
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
 * Only ever called for a clone `decidePasswordSet` cleared: none stored, and
 * Mission Control declared as the backend's deployer. Supabase is told first
 * and the row written second, so a failed write leaves a database whose
 * password nobody holds, which is where it already was, and the next pass
 * tries again. The row is written only while it still holds none, so a
 * password stored by anything else in the meantime is never overwritten.
 */
async function setCloneDbPassword(input: {
  supabase: Db;
  cloneId: string;
  projectRef: string;
}): Promise<{ ok: true; password: string } | { ok: false; reason: string }> {
  const token = process.env.SB_MGMT_API_TOKEN;
  if (!token) return { ok: false, reason: "SB_MGMT_API_TOKEN is not configured" };
  const { generateSecurePassword } = await import("./backend-provisioning.server");
  const password = generateSecurePassword();
  try {
    const res = await fetch(`${MGMT_API}/projects/${input.projectRef}/database/password`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `Supabase refused the password for ${input.projectRef}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`,
      };
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }

  const { encryptSecret } = await import("./crypto.server");
  const { data, error } = await input.supabase
    .from("clone_backends")
    .update({ db_pass: encryptSecret(password) })
    .eq("clone_id", input.cloneId)
    .is("db_pass", null)
    .select("clone_id");
  if (error) {
    return { ok: false, reason: `the new password could not be stored: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      reason:
        "a password was stored for this clone while this one was being set; the next pass uses it",
    };
  }
  return { ok: true, password };
}

/** Write one secret into the clone's production environment, as an outcome. */
async function writeEnvironmentSecret(input: {
  owner: string;
  repo: string;
  name: string;
  value: string;
}): Promise<CredentialOutcome> {
  const label = `${input.owner}/${input.repo}`;
  try {
    const { putEnvironmentSecret } = await import("./github-secrets.server");
    const { created } = await putEnvironmentSecret({
      owner: input.owner,
      repo: input.repo,
      environment: CI_ENVIRONMENT,
      name: input.name,
      value: input.value,
    });
    return { repo: label, secret: input.name, state: created ? "distributed" : "kept" };
  } catch (e) {
    const { describeSecretError } = await import("./github-secrets.server");
    const { message } = describeSecretError(e, input.owner, input.repo);
    return { repo: label, secret: input.name, state: "failed", reason: message };
  }
}

/**
 * A credential as the sweep found it: a value to write, or why there is none.
 * A `failed` reason is something that went wrong this pass; a `cannot` one is
 * a state that will hold until somebody changes it.
 */
export type HeldCredential =
  | { value: string | null }
  | { state: "cannot" | "failed"; reason: string };

/**
 * Write the clone's credentials into its production environment, and the
 * project ref beside them.
 *
 * The ref is a VARIABLE rather than a secret on purpose: the workflows fail
 * closed without a route, and an operator reading a red run needs to be able
 * to see which project it was pointed at. It is written whether or not either
 * credential could be, because it is a fact about the repository rather than
 * a credential.
 */
export async function distributeCloneCiCredentials(input: {
  owner: string;
  repo: string;
  projectRef: string;
  password: HeldCredential;
  serviceRoleKey: HeldCredential;
}): Promise<CredentialOutcome[]> {
  const label = `${input.owner}/${input.repo}`;
  const outcomes: CredentialOutcome[] = [];
  const target = { owner: input.owner, repo: input.repo };

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
        ? await writeEnvironmentSecret({ ...target, name: CI_DB_URL_SECRET, value: composed.url })
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
        ? await writeEnvironmentSecret({ ...target, name: CI_SERVICE_ROLE_SECRET, value: key.key })
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
    .select("id, github_owner, github_repo")
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

    // The one sanctioned way to a clone's project ref for a credential: it
    // refuses the prime's project and Mission Control's own, so neither can be
    // handed out, or given a password, even if the row were wrong.
    let projectRef: string;
    try {
      projectRef = (await resolveCloneSecretTarget(supabase, clone.id)).projectRef;
    } catch (e) {
      recordOutcome(sweep, {
        repo: label,
        secret: "*",
        state: "cannot",
        reason: e instanceof Error ? e.message : String(e),
      });
      continue;
    }

    let password = readStored(backend.db_pass, "database password");
    if ("value" in password && !password.value) {
      const decision = decidePasswordSet({
        passwordStored: false,
        variables: await listRepoVariables({ owner, repo }),
      });
      if (!decision.set) {
        password = {
          state: "cannot",
          reason: decision.reason ?? "no database password is stored for this clone",
        };
      } else {
        const set = await setCloneDbPassword({ supabase, cloneId: clone.id, projectRef });
        if (set.ok) {
          password = { value: set.password };
          sweep.passwordsSet.push(label);
          await writeAuditLog({
            action: "clone_db_password_set",
            entityType: "clone",
            entityId: clone.id,
            // The fact and its reason, never the password.
            metadata: {
              repo: label,
              project_ref: projectRef,
              reason: "no database password was stored for this clone",
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
    });
    for (const outcome of outcomes) recordOutcome(sweep, outcome);
  }

  return sweep;
}
