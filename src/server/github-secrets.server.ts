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
};

export type SyncSecretsResult = {
  ok: boolean;
  written: string[];
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

  return {
    ok: failed.length === 0 && configured.length > 0,
    written,
    skipped,
    failed,
    nothingConfigured: configured.length === 0,
  };
}

/**
 * The canonical set of Actions secrets that every Aurixa-managed repo
 * (Prime and each clone) needs for the Codex Security workflows.
 *
 * The scan and remediation workflows receive their callback URL and HMAC
 * secret as workflow_dispatch inputs, so the only secret they genuinely
 * require in the repo is the model API key. The rest are written for
 * operator convenience and for workflows that run outside a dispatch.
 */
export async function buildCodexRepoSecrets(): Promise<Record<string, string | undefined>> {
  const { remediationCallbackUrl, scanCallbackUrl } =
    await import("@/server/codex-security-client.server");
  return {
    // Authenticates the Codex CLI in both the scan reasoning pass and the
    // remediation patch author. CODEX_SECURITY_API_KEY is the legacy alias.
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? process.env.CODEX_SECURITY_API_KEY,
    CODEX_SECURITY_API_KEY: process.env.CODEX_SECURITY_API_KEY,
    CODEX_REMEDIATION_WEBHOOK_SECRET: process.env.CODEX_REMEDIATION_WEBHOOK_SECRET,
    CODEX_SECURITY_WEBHOOK_SECRET: process.env.CODEX_SECURITY_WEBHOOK_SECRET,
    CODEX_CALLBACK_URL: remediationCallbackUrl(),
    CODEX_SCAN_CALLBACK_URL: scanCallbackUrl(),
  };
}

export type SecretPreviewEntry = {
  name: string;
  configured: boolean;
  /** Why it matters, shown next to the name in the settings card. */
  purpose: string;
  required: boolean;
};

const SECRET_PURPOSES: Record<string, { purpose: string; required: boolean }> = {
  OPENAI_API_KEY: {
    purpose: "Codex CLI auth — the scan reasoning pass and every remediation patch",
    required: true,
  },
  CODEX_SECURITY_API_KEY: {
    purpose: "Legacy alias for OPENAI_API_KEY, kept for older workflow revisions",
    required: false,
  },
  CODEX_REMEDIATION_WEBHOOK_SECRET: {
    purpose: "Signs remediation PR callbacks (normally passed as a dispatch input)",
    required: false,
  },
  CODEX_SECURITY_WEBHOOK_SECRET: {
    purpose: "Signs scan result callbacks (normally passed as a dispatch input)",
    required: false,
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
