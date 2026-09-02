/**
 * Repository Actions VARIABLES, written through the Aurixa GitHub App.
 *
 * A sibling of `putRepoSecret` and deliberately a separate file, because the
 * two are not the same thing and must not read as interchangeable. A secret is
 * sealed against the repository's public key and can never be read back; a
 * variable is plain text that anybody with read access to the repository can
 * see, and that is exactly why it is the right home for what this writes.
 *
 * `BACKEND_DEPLOYED_BY` is not a credential. It is a clone telling its own CI
 * who deploys its Supabase project, so the deploy workflow can stand down
 * instead of failing on every push — and the workflow requires that positive
 * assertion rather than inferring it from a missing token, because "nobody
 * configured a token" and "somebody else deploys this" look identical from
 * inside a workflow and only one of them is safe to be quiet about.
 *
 * ## Why nothing here writes a token
 *
 * The repair this replaces was to seal the prime's `SUPABASE_ACCESS_TOKEN`
 * into every clone repository. Supabase's own documentation is why that is the
 * wrong shape: a classic personal access token carries "every permission, on
 * every organization and every project you belong to today, and on every one
 * you create or join in the future". One copy per clone is fleet-wide database
 * administration in every clone repository, reachable from any workflow in any
 * of them. Mission Control keeps the credential and does the deploying itself;
 * what travels outward is this — a name, not a key.
 */
import { getAppOctokit } from "@/server/github-app.server";

/** GitHub's own rule for a variable name, stated rather than discovered. */
export function validateVariableName(name: string): string | null {
  if (!name) return "name is empty";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return "must start with a letter or underscore and contain only letters, digits and underscores";
  }
  if (/^GITHUB_/i.test(name)) return "names beginning GITHUB_ are reserved";
  return null;
}

export type PutRepoVariableInput = {
  owner: string;
  repo: string;
  name: string;
  value: string;
  installationId?: string | null;
};

/**
 * Create or update a repository Actions variable. Idempotent.
 *
 * GitHub splits this across two verbs — POST to create, PATCH to update — and
 * offers no upsert. Creating first and treating 409 as "already there" is the
 * order that races correctly: two provisioning passes for the same clone both
 * end with the variable set to the value they asked for, where a
 * read-then-write would have one of them decide on a stale answer.
 */
export async function putRepoVariable(input: PutRepoVariableInput): Promise<void> {
  const problem = validateVariableName(input.name);
  if (problem) throw new Error(`Invalid variable name "${input.name}": ${problem}`);

  const octokit = getAppOctokit(input.installationId ?? undefined);
  const target = { owner: input.owner, repo: input.repo };

  try {
    await octokit.request("POST /repos/{owner}/{repo}/actions/variables", {
      ...target,
      name: input.name,
      value: input.value,
    });
    return;
  } catch (e) {
    const status = (e as { status?: number }).status;
    // 409 is the only status that means "it exists, update it instead". Any
    // other failure is this call's failure and is re-thrown: a variable
    // silently not written is how the workflow it controls comes to be quiet
    // about a deployment nobody performed.
    if (status !== 409) throw e;
  }

  await octokit.request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", {
    ...target,
    name: input.name,
    value: input.value,
  });
}

/**
 * Every Actions variable on a repository, as a name → value map.
 *
 * Returns `null` when GitHub could not be asked. A caller must not read that
 * as "the repository has none" — which is why it is a distinct value rather
 * than an empty map.
 */
export async function listRepoVariables(input: {
  owner: string;
  repo: string;
  installationId?: string | null;
}): Promise<Record<string, string> | null> {
  try {
    const octokit = getAppOctokit(input.installationId ?? undefined);
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/variables", {
      owner: input.owner,
      repo: input.repo,
      per_page: 100,
    });
    return Object.fromEntries((data.variables ?? []).map((v) => [v.name, v.value]));
  } catch (e) {
    console.error("[github-variables] could not list variables:", e);
    return null;
  }
}

/** Remove a repository variable. A variable that is already gone is a success. */
export async function deleteRepoVariable(input: {
  owner: string;
  repo: string;
  name: string;
  installationId?: string | null;
}): Promise<void> {
  const octokit = getAppOctokit(input.installationId ?? undefined);
  try {
    await octokit.request("DELETE /repos/{owner}/{repo}/actions/variables/{name}", {
      owner: input.owner,
      repo: input.repo,
      name: input.name,
    });
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
}

/** The variable a clone's deploy workflow reads, and the one value it accepts. */
export const BACKEND_DEPLOYER_VARIABLE = "BACKEND_DEPLOYED_BY";
export const BACKEND_DEPLOYER_MISSION_CONTROL = "mission-control";

/**
 * The permissions GitHub granted this installation, or `null` when it could
 * not be asked.
 *
 * Read from the installation token itself rather than from a settings
 * endpoint: `@octokit/auth-app` returns the granted permission map alongside
 * the token, so this costs no extra request and needs no App-JWT auth path.
 *
 * `null` is deliberately distinct from an empty map. A map says "these are the
 * permissions"; null says "we could not find out", and the caller must not
 * turn the second into "the App is not permitted", which would send an
 * administrator to change a setting that was never wrong.
 */
export async function readInstallationPermissions(input?: {
  installationId?: string | null;
}): Promise<Record<string, string> | null> {
  try {
    const octokit = getAppOctokit(input?.installationId ?? undefined);
    const auth = (await octokit.auth({ type: "installation" })) as {
      permissions?: Record<string, string>;
    } | null;
    return auth?.permissions ?? null;
  } catch (e) {
    console.error("[github-variables] could not read installation permissions:", e);
    return null;
  }
}

/**
 * Tell a clone's CI that Mission Control deploys its Supabase project.
 *
 * Never throws. The caller is provisioning, and a clone that is otherwise
 * healthy must not be reported as failed because a repository variable could
 * not be written — the consequence of failing to write it is a red check on
 * that repository's deploy workflow, which is the loud, correct, recoverable
 * state rather than a silent one.
 */
export async function declareMissionControlDeploysBackend(input: {
  owner: string;
  repo: string;
  installationId?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await putRepoVariable({
      ...input,
      name: BACKEND_DEPLOYER_VARIABLE,
      value: BACKEND_DEPLOYER_MISSION_CONTROL,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[github-variables] could not declare the backend deployer:", error);
    return { ok: false, error };
  }

  // Asserted by its EFFECT, never by the call's status.
  //
  // This is the rule this repository already writes down about the Airtable
  // purge, and it is the one that would have caught this: a write that
  // returned without throwing is not a variable the workflow can read.
  // Measured 2 Sep 2026, the declaration was made and the variable was still
  // absent, and nothing anywhere could tell the difference.
  const seen = await listRepoVariables(input);
  if (seen === null) {
    return {
      ok: false,
      error:
        "the variable was written but could not be read back, so whether the " +
        "deploy check will see it is unknown",
    };
  }
  if (seen[BACKEND_DEPLOYER_VARIABLE] !== BACKEND_DEPLOYER_MISSION_CONTROL) {
    return {
      ok: false,
      error:
        `the write reported success but ${BACKEND_DEPLOYER_VARIABLE} is not set on ` +
        "the repository afterwards",
    };
  }
  return { ok: true };
}
