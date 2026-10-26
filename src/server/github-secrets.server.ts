// Server-only helper to write Actions repository secrets via the
// Aurixa GitHub App installation. Values are sealed against the repo's
// Actions public key with crypto_box_seal (required by the GitHub REST API).
//
// The sealed box is computed by a pure-JavaScript implementation — see
// github-sealed-box.server.ts for why libsodium-wrappers cannot be used on
// the Cloudflare Workers runtime this app deploys to.
//
// Required GitHub App permission: `Repository → Secrets: Read & write`.
// If the installation lacks this permission, the API returns 403 —
// re-accept the App's updated permissions on the installation.
import { getAppOctokit } from "@/server/github-app.server";
import { isLocalEncryptionFailure, sealedBoxBase64 } from "@/server/github-sealed-box.server";

/**
 * GitHub's own constraint on Actions secret names. Violating it returns a
 * bare 422 with no useful body, so we check up front and say what is wrong.
 */
const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export function validateSecretName(name: string): string | null {
  if (!SECRET_NAME_PATTERN.test(name)) {
    return "must contain only uppercase letters, digits and underscores, and may not start with a digit";
  }
  if (name.startsWith("GITHUB_")) {
    return "names starting with GITHUB_ are reserved by GitHub Actions";
  }
  return null;
}

/**
 * Turn an Octokit error into something an operator can act on. GitHub's
 * messages for this endpoint are famously ambiguous — a bare "Not Found"
 * covers a missing repo, an uninstalled app, AND a missing permission.
 *
 * `fatal` marks a failure that is a property of the environment or the
 * repository rather than of one particular secret, so the caller knows the
 * remaining names cannot possibly succeed.
 */
export function describeSecretError(
  err: unknown,
  owner: string,
  repo: string,
): { status: number | null; message: string; fatal: boolean } {
  const status =
    (err as { status?: number })?.status ??
    (err as { response?: { status?: number } })?.response?.status ??
    null;
  const raw =
    (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
    (err instanceof Error ? err.message : String(err));
  const target = `${owner}/${repo}`;

  // Encryption runs before the first GitHub call, so a failure here is not a
  // permission problem and no amount of re-accepting App permissions will fix
  // it. Say so explicitly — this class of error previously surfaced as a raw
  // `Aborted(CompileError: ...)` repeated once per secret name.
  if (isLocalEncryptionFailure(err)) {
    return {
      status: null,
      fatal: true,
      message:
        `Mission Control could not encrypt the secrets for ${target} — this failed locally, ` +
        `before GitHub was contacted, so it is not a repository or App-permission problem. ` +
        `Actions secrets are sealed by a pure-JavaScript crypto_box_seal ` +
        `(src/server/github-sealed-box.server.ts); a Wasm-backed crypto library in this path ` +
        `cannot run on the Workers runtime. Detail: ${raw}`,
    };
  }

  if (status === 404) {
    return {
      status,
      fatal: true,
      message:
        `404: the Aurixa GitHub App cannot see ${target}. Either the App is not installed ` +
        `on ${owner}, ${target} is not in the installation's repository access list, or the ` +
        `installation lacks the "Secrets: Read & write" permission (GitHub reports that as 404).`,
    };
  }
  if (status === 403) {
    return {
      status,
      fatal: true,
      message:
        `403: the installation is missing the "Secrets: Read & write" permission for ${target}. ` +
        `Update the App's permissions, then re-accept them on the installation ` +
        `(github.com/settings/installations). Detail: ${raw}`,
    };
  }
  if (status === 401) {
    return {
      status,
      fatal: true,
      message:
        `401: GitHub rejected the App credentials. GITHUB_APP_PRIVATE_KEY probably does not ` +
        `match GITHUB_APP_ID, or GITHUB_APP_INSTALLATION_ID belongs to a different app. ` +
        `Detail: ${raw}`,
    };
  }
  if (status === 422) {
    // Specific to the value or name being written — the other secrets may
    // still be fine, so this one does not stop the run.
    return {
      status,
      fatal: false,
      message: `422: GitHub rejected the secret for ${target}: ${raw}`,
    };
  }
  return { status, fatal: false, message: status ? `${status}: ${raw}` : raw };
}

export type PutRepoSecretInput = {
  owner: string;
  repo: string;
  name: string;
  value: string;
  installationId?: string | null;
};

/** Encrypt + upsert a repository Actions secret. Idempotent. */
export async function putRepoSecret(input: PutRepoSecretInput): Promise<void> {
  const nameProblem = validateSecretName(input.name);
  if (nameProblem) {
    throw new Error(`Invalid secret name "${input.name}": ${nameProblem}`);
  }

  const octokit = getAppOctokit(input.installationId ?? undefined);

  const { data: pk } = await octokit.request(
    "GET /repos/{owner}/{repo}/actions/secrets/public-key",
    { owner: input.owner, repo: input.repo },
  );

  const encrypted_value = sealedBoxBase64(pk.key, input.value);

  await octokit.request("PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}", {
    owner: input.owner,
    repo: input.repo,
    secret_name: input.name,
    encrypted_value,
    key_id: pk.key_id,
  });
}

/**
 * Encrypt + upsert an Actions secret held by one deployment ENVIRONMENT of a
 * repository, rather than by the repository. Idempotent.
 *
 * The difference is who can read it. A repository secret reaches every job of
 * every workflow on every branch; an environment secret reaches only a job that
 * names the environment. The prime keeps its production credentials in
 * `supabase-production` for that reason (`docs/operations/DEPLOYMENT_PROTECTION.md`),
 * and every workflow that reads one names it, so a clone's copy belongs there
 * too.
 *
 * An environment that does not exist yet is created, with no rules: exactly
 * what GitHub does itself the first time a job names one. Its protection
 * (a branch policy, reviewers) is the repository owner's, so this never
 * changes an environment that exists.
 *
 * The secret's metadata is read first, and says two things. Whether it is NEW:
 * GitHub never returns a value, so a re-write cannot be compared with what it
 * replaces, and "it was already there" is what lets a sweep stay quiet once it
 * has settled. And when it was last written: given `reassertAfterMs`, a secret
 * written more recently than that is left alone, which turns a half-hourly
 * sweep's steady state into one read per secret rather than three calls and a
 * write. A caller that knows the value has just changed omits it.
 *
 * Required GitHub App permissions: `Environments: Read & write` (creating
 * one) and `Secrets: Read & write`.
 */
export async function putEnvironmentSecret(
  input: PutRepoSecretInput & { environment: string; reassertAfterMs?: number },
): Promise<{ created: boolean; written: boolean }> {
  const nameProblem = validateSecretName(input.name);
  if (nameProblem) {
    throw new Error(`Invalid secret name "${input.name}": ${nameProblem}`);
  }

  const octokit = getAppOctokit(input.installationId ?? undefined);
  const where = { owner: input.owner, repo: input.repo, environment_name: input.environment };

  let created = false;
  let writtenAt: string | null = null;
  try {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}",
      { ...where, secret_name: input.name },
    );
    writtenAt = data.updated_at ?? data.created_at ?? null;
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
    created = true;
  }

  if (!created && input.reassertAfterMs !== undefined && writtenAt) {
    const age = Date.now() - Date.parse(writtenAt);
    if (Number.isFinite(age) && age >= 0 && age < input.reassertAfterMs) {
      return { created: false, written: false };
    }
  }

  const readKey = () =>
    octokit.request(
      "GET /repos/{owner}/{repo}/environments/{environment_name}/secrets/public-key",
      where,
    );
  let pk: { key: string; key_id: string };
  try {
    pk = (await readKey()).data;
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
    await octokit.request("PUT /repos/{owner}/{repo}/environments/{environment_name}", where);
    pk = (await readKey()).data;
  }

  const encrypted_value = sealedBoxBase64(pk.key, input.value);

  await octokit.request(
    "PUT /repos/{owner}/{repo}/environments/{environment_name}/secrets/{secret_name}",
    { ...where, secret_name: input.name, encrypted_value, key_id: pk.key_id },
  );
  return { created, written: true };
}

/**
 * The NAMES of a repository's Actions secrets. GitHub never returns a value,
 * which is exactly what makes this safe to call for a status card.
 *
 * `null` where GitHub could not be asked — a failed read is not an empty
 * repository, and a caller that conflates them would report "nothing deploys
 * this" every time the API hiccuped.
 */
export async function listRepoSecretNames(input: {
  owner: string;
  repo: string;
  installationId?: string | null;
}): Promise<string[] | null> {
  try {
    const octokit = getAppOctokit(input.installationId ?? undefined);
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/secrets", {
      owner: input.owner,
      repo: input.repo,
      per_page: 100,
    });
    return (data.secrets ?? []).map((s) => s.name);
  } catch (e) {
    console.error("[github-secrets] could not list secret names:", e);
    return null;
  }
}

/** Remove a repository secret. One that is already gone is a success. */
export async function deleteRepoSecret(input: {
  owner: string;
  repo: string;
  name: string;
  installationId?: string | null;
}): Promise<void> {
  const octokit = getAppOctokit(input.installationId ?? undefined);
  try {
    await octokit.request("DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}", {
      owner: input.owner,
      repo: input.repo,
      secret_name: input.name,
    });
  } catch (e) {
    if ((e as { status?: number }).status !== 404) throw e;
  }
}

export type SyncSecretsInput = {
  owner: string;
  repo: string;
  installationId?: string | null;
  /** Explicit map of secret name → value. Undefined/empty values are skipped. */
  secrets: Record<string, string | undefined | null>;
  /** Names to delete from the repository (an absent one is not an error). */
  remove?: readonly string[];
};

export type SyncSecretsResult = {
  ok: boolean;
  written: string[];
  /** Deleted, or already absent. */
  removed: string[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; error: string }[];
  /** True when nothing was written because nothing was configured to write. */
  nothingConfigured: boolean;
};

/**
 * Best-effort push of multiple secrets; never throws.
 *
 * A failure that belongs to the environment or the repository — the App is not
 * installed, the installation lacks a permission, encryption cannot run here —
 * hits every secret identically. It is detected once and short-circuits the
 * rest, so an operator sees one explained cause plus a list of names that were
 * never attempted, rather than N copies of the same sentence.
 */
export async function syncRepoSecrets(input: SyncSecretsInput): Promise<SyncSecretsResult> {
  const written: string[] = [];
  const removed: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const failed: { name: string; error: string }[] = [];

  const entries = Object.entries(input.secrets);
  const configured = entries.filter(([, value]) => !!value);

  for (const [name] of entries) {
    if (!input.secrets[name]) {
      skipped.push({ name, reason: "not configured in Mission Control" });
    }
  }

  let fatal: string | null = null;

  for (const [name, value] of configured) {
    if (fatal) {
      // Repeating the full explanation here is what turned one broken
      // dependency into a six-line wall of identical errors. Point at the
      // cause instead; it is already attached to the secret that hit it.
      failed.push({
        name,
        error: "not attempted — see the failure above, it affects every secret",
      });
      continue;
    }
    try {
      await putRepoSecret({
        owner: input.owner,
        repo: input.repo,
        name,
        value: value as string,
        installationId: input.installationId ?? null,
      });
      written.push(name);
    } catch (e) {
      const { message, fatal: isFatal } = describeSecretError(e, input.owner, input.repo);
      failed.push({ name, error: message });
      // Properties of the runtime or of the repo + installation, not of this
      // particular secret — retrying the remaining names cannot succeed.
      if (isFatal) fatal = message;
    }
  }

  for (const name of input.remove ?? []) {
    if (fatal) {
      failed.push({
        name,
        error: "not attempted — see the failure above, it affects every secret",
      });
      continue;
    }
    try {
      await deleteRepoSecret({
        owner: input.owner,
        repo: input.repo,
        name,
        installationId: input.installationId ?? null,
      });
      removed.push(name);
    } catch (e) {
      const { message, fatal: isFatal } = describeSecretError(e, input.owner, input.repo);
      failed.push({ name, error: message });
      if (isFatal) fatal = message;
    }
  }

  return {
    ok: failed.length === 0 && (configured.length > 0 || (input.remove ?? []).length > 0),
    written,
    removed,
    skipped,
    failed,
    nothingConfigured: configured.length === 0,
  };
}

/**
 * The Actions secrets Prime's repository needs for the Codex Security
 * workflows. Prime only: clones are neither scanned nor fixed on their own
 * (src/lib/codex-scan-policy.ts), so they need none of these.
 *
 * The workflows receive their callback URL and a per-run callback key as
 * workflow_dispatch inputs, so all they genuinely need from the repository is
 * the two model keys: OpenAI's for Codex (P2-and-below fixes and the scan's
 * reasoning pass), Anthropic's for Claude (P0/P1 fixes).
 */
export async function buildCodexRepoSecrets(): Promise<Record<string, string | undefined>> {
  const { remediationCallbackUrl, scanCallbackUrl } =
    await import("@/server/codex-security-client.server");
  return {
    // CODEX_SECURITY_API_KEY is the legacy alias for the OpenAI key.
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? process.env.CODEX_SECURITY_API_KEY,
    CODEX_SECURITY_API_KEY: process.env.CODEX_SECURITY_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CODEX_CALLBACK_URL: remediationCallbackUrl(),
    CODEX_SCAN_CALLBACK_URL: scanCallbackUrl(),
  };
}

/**
 * Removed from Prime's repository on every sync: the callback-signing
 * MASTERS. Earlier syncs wrote them "for convenience", but per-run keys are
 * derived from them and they must never leave Mission Control — no workflow
 * reads them, and any workflow in the repository (Prime's is public) could.
 * Rotate both masters once they are gone (engine health → "Rotate signing key").
 */
export const RETIRED_CODEX_REPO_SECRETS = [
  "CODEX_REMEDIATION_WEBHOOK_SECRET",
  "CODEX_SECURITY_WEBHOOK_SECRET",
] as const;

/**
 * Removed from a clone's repository when its secrets are synced: everything
 * the Codex workflows used. Clones no longer run them, and only those two
 * workflows read these names.
 */
export const CLONE_CODEX_REPO_SECRETS = [
  "OPENAI_API_KEY",
  "CODEX_SECURITY_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_CALLBACK_URL",
  "CODEX_SCAN_CALLBACK_URL",
  ...RETIRED_CODEX_REPO_SECRETS,
] as const;

export type SecretPreviewEntry = {
  name: string;
  configured: boolean;
  /** Why it matters, shown next to the name in the settings card. */
  purpose: string;
  required: boolean;
};

const SECRET_PURPOSES: Record<string, { purpose: string; required: boolean }> = {
  OPENAI_API_KEY: {
    purpose: "Codex CLI auth — P2-and-below fixes and the scan reasoning pass",
    required: true,
  },
  CODEX_SECURITY_API_KEY: {
    purpose: "Legacy alias for OPENAI_API_KEY, kept for older workflow revisions",
    required: false,
  },
  ANTHROPIC_API_KEY: {
    purpose: "Claude Code auth — P0/P1 fixes",
    required: true,
  },
  CODEX_CALLBACK_URL: {
    purpose: "Remediation callback endpoint",
    required: false,
  },
  CODEX_SCAN_CALLBACK_URL: {
    purpose: "Scan result callback endpoint",
    required: false,
  },
};

/**
 * Which secrets a sync would actually push — names and configured/not only,
 * never values. Lets the settings card explain "0 written" before the
 * operator clicks, instead of reporting a hollow success afterwards.
 */
export async function previewCodexRepoSecrets(): Promise<{
  entries: SecretPreviewEntry[];
  configuredCount: number;
  missingRequired: string[];
}> {
  const secrets = await buildCodexRepoSecrets();
  const entries: SecretPreviewEntry[] = Object.entries(secrets).map(([name, value]) => ({
    name,
    configured: !!value,
    purpose: SECRET_PURPOSES[name]?.purpose ?? "",
    required: SECRET_PURPOSES[name]?.required ?? false,
  }));
  return {
    entries,
    configuredCount: entries.filter((e) => e.configured).length,
    missingRequired: entries.filter((e) => e.required && !e.configured).map((e) => e.name),
  };
}
