/**
 * Give every clone repository a credential its own CI can apply a migration
 * with — see `cloneCiCredential.pure.ts` for why it is a database URL and not
 * a Supabase access token.
 *
 * The pass is idempotent and settles: GitHub never returns a secret's value,
 * so there is nothing to compare against and the write is simply repeated. It
 * is one sealed-box PUT per clone per sweep, which is the cheapest correct
 * thing available.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  CI_DB_URL_SECRET,
  composeSessionPoolerUrl,
  emptyCredentialSweep,
  recordOutcome,
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
      console.error(
        `[cloneCiCredential] pooler config for ${projectRef}: HTTP ${res.status}`,
      );
      return null;
    }
    const body = (await res.json()) as unknown;
    // The endpoint has returned both an object and an array of one across
    // versions. Take whichever shape arrives rather than assuming.
    const row = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
    if (!row) return null;

    // Prefer the connection string Supabase composes itself: it is the one
    // place the host, the user and the port are guaranteed to agree.
    const connection =
      typeof row.connection_string === "string" ? row.connection_string : null;
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
 * Write the database URL, and the project ref beside it.
 *
 * The ref is a VARIABLE rather than a secret on purpose: the workflow fails
 * closed without it, and an operator reading a red run needs to be able to see
 * which project it was pointed at.
 */
export async function distributeCloneCiCredential(input: {
  owner: string;
  repo: string;
  projectRef: string;
  password: string | null;
}): Promise<{ ok: true } | { ok: false; reason: string; kind: "cannot" | "failed" }> {
  const pooler = await readPoolerFacts(input.projectRef);
  if (!pooler) {
    return {
      ok: false,
      kind: "cannot",
      reason: `Supabase would not report the pooler for ${input.projectRef}`,
    };
  }
  const composed = composeSessionPoolerUrl({
    projectRef: input.projectRef,
    password: input.password,
    pooler,
  });
  if (!composed.ok) return { ok: false, kind: "cannot", reason: composed.reason };

  try {
    const { putRepoSecret } = await import("./github-secrets.server");
    await putRepoSecret({
      owner: input.owner,
      repo: input.repo,
      name: CI_DB_URL_SECRET,
      value: composed.url,
    });
    const { putRepoVariable } = await import("./github-variables.server");
    await putRepoVariable({
      owner: input.owner,
      repo: input.repo,
      name: "SUPABASE_PROJECT_REF",
      value: input.projectRef,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, kind: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
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
    sweep.failed.push({ repo: "*", reason: error.message });
    return sweep;
  }
  const targets = (clones ?? []).filter((c) => c.github_owner && c.github_repo);
  if (targets.length === 0) return sweep;

  const { decryptSecret } = await import("./crypto.server");

  for (const clone of targets) {
    const owner = clone.github_owner as string;
    const repo = clone.github_repo as string;
    const label = `${owner}/${repo}`;

    const { data: backend, error: backendError } = await supabase
      .from("clone_backends")
      .select("supabase_project_ref, db_pass")
      .eq("clone_id", clone.id)
      .maybeSingle();

    if (backendError) {
      recordOutcome(sweep, { repo: label, state: "failed", reason: backendError.message });
      continue;
    }
    if (!backend?.supabase_project_ref) {
      recordOutcome(sweep, { repo: label, state: "no_backend" });
      continue;
    }

    let password: string | null = null;
    try {
      password = backend.db_pass ? decryptSecret(backend.db_pass as string) : null;
    } catch (e) {
      recordOutcome(sweep, {
        repo: label,
        state: "cannot",
        reason: `the stored database password could not be read: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    const result = await distributeCloneCiCredential({
      owner,
      repo,
      projectRef: backend.supabase_project_ref,
      password,
    });
    if (result.ok) recordOutcome(sweep, { repo: label, state: "distributed" });
    else recordOutcome(sweep, { repo: label, state: result.kind, reason: result.reason });
  }

  return sweep;
}
