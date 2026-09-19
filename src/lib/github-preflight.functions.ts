// Preflight validation for the Aurixa GitHub App used by the clone wizard.
// Answers: (1) Are the GITHUB_APP_* secrets configured? (2) Is the App
// installed on the target owner (org or user)? (3) Does the installation
// have write access to a template repo when method === "template"?
//
// Issue #10 remediation: fail fast in the wizard before we create a clone
// row + kick off provisioning that would throw mid-flow anyway.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "@/integrations/supabase/role-middleware";
import { countGithubCall } from "@/server/githubUsageMeter";

const InputSchema = z.object({
  targetOwner: z.string().trim().min(1),
  method: z.enum(["fork", "template", "clone"]).optional(),
  templateOwner: z.string().trim().optional().nullable(),
  templateRepo: z.string().trim().optional().nullable(),
  // G9: after clone-repo creation, verify the specific repo is reachable
  // by the installation (either "all" selection or explicitly selected).
  targetRepo: z.string().trim().optional().nullable(),
});

export type GithubPreflightResult = {
  ok: boolean;
  appConfigured: boolean;
  installationFound: boolean;
  installationId?: number;
  accountType?: "Organization" | "User";
  targetOwner: string;
  templateAccessible?: boolean | null;
  templateRepoIsTemplate?: boolean | null;
  // G9 fields
  repositorySelection?: "all" | "selected" | null;
  targetRepo?: string | null;
  targetRepoAccessible?: boolean | null;
  contentsWritePermission?: boolean | null;
  workflowsPermission?: boolean | null;
  message?: string;
  hint?: string;
  installUrl?: string;
};

export const checkGithubAppPreflight = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((input) => InputSchema.parse(input))
  .handler(async ({ data }): Promise<GithubPreflightResult> => {
    const appId = process.env.GITHUB_APP_ID;
    const privateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY;
    const appConfigured = Boolean(appId && privateKeyRaw);

    if (!appConfigured) {
      return {
        ok: false,
        appConfigured: false,
        installationFound: false,
        targetOwner: data.targetOwner,
        message: "GitHub App is not configured on this environment.",
        hint: "Add GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY secrets in Settings before provisioning.",
      };
    }

    // Mint an App JWT (not an installation token) so we can hit
    // /orgs/{org}/installation and /users/{user}/installation.
    let jwt: string;
    try {
      const { createAppAuth } = await import("@octokit/auth-app");
      const forge = (await import("node-forge")).default;
      const normalize = (pem: string) => {
        let p = pem.replace(/\\n/g, "\n").trim();
        if (!p.includes("\n")) {
          const m = p.match(/-----BEGIN ([A-Z0-9 ]+?)-----([\s\S]+?)-----END \1-----/);
          if (m) {
            const label = m[1].trim();
            const body = m[2].replace(/\s+/g, "");
            const wrapped = body.match(/.{1,64}/g)?.join("\n") ?? body;
            p = `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----`;
          }
        }
        if (p.includes("-----BEGIN PRIVATE KEY-----")) return p;
        if (p.includes("-----BEGIN RSA PRIVATE KEY-----")) {
          const key = forge.pki.privateKeyFromPem(p);
          const asn1 = forge.pki.privateKeyToAsn1(key);
          const wrapped = forge.pki.wrapRsaPrivateKey(asn1);
          return forge.pki.privateKeyInfoToPem(wrapped).trim();
        }
        return p;
      };

      const auth = createAppAuth({ appId: appId!, privateKey: normalize(privateKeyRaw!) });
      const appAuth = await auth({ type: "app" });
      jwt = (appAuth as { token: string }).token;
    } catch (e) {
      return {
        ok: false,
        appConfigured: true,
        installationFound: false,
        targetOwner: data.targetOwner,
        message: `Could not mint GitHub App JWT: ${e instanceof Error ? e.message : String(e)}`,
        hint: "Check GITHUB_APP_PRIVATE_KEY format (PKCS#1 or PKCS#8 PEM).",
      };
    }

    const gh = async (path: string) => {
      // A raw fetch, so the octokit hook never sees it. This preflight is
      // operator-invoked rather than scheduled, but it spends the same
      // installation window as every lane that is.
      countGithubCall();
      return fetch(`https://api.github.com${path}`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "aurixa-mission-control",
        },
      });
    };

    // Try org first, then user. GitHub returns 404 for the wrong endpoint.
    const owner = data.targetOwner.replace(/^@/, "");
    let installRes = await gh(`/orgs/${encodeURIComponent(owner)}/installation`);
    let accountType: "Organization" | "User" | undefined;
    if (installRes.ok) {
      accountType = "Organization";
    } else if (installRes.status === 404) {
      installRes = await gh(`/users/${encodeURIComponent(owner)}/installation`);
      if (installRes.ok) accountType = "User";
    }

    if (!installRes.ok) {
      // App exists but not installed on that owner.
      return {
        ok: false,
        appConfigured: true,
        installationFound: false,
        targetOwner: owner,
        message: `Aurixa GitHub App is not installed on "${owner}".`,
        hint: "Install the Aurixa GitHub App on this org/user and grant it access to the repos you want provisioned.",
        installUrl: `https://github.com/apps`,
      };
    }

    const install = (await installRes.json()) as {
      id: number;
      account?: { login?: string; type?: string };
      permissions?: Record<string, string>;
      repository_selection?: "all" | "selected";
    };
    const installationId = install.id;
    const perms = install.permissions ?? {};
    const contentsWritePermission = perms.contents === "write" || perms.contents === "admin";
    const workflowsPermission = perms.workflows === "write" || perms.workflows === "admin";
    const repositorySelection = install.repository_selection ?? null;

    // Mint installation token once — reused for template + target repo checks.
    let installToken: string | null = null;
    const mintToken = async (): Promise<string | null> => {
      if (installToken) return installToken;
      try {
        const tokRes = await fetch(
          `https://api.github.com/app/installations/${installationId}/access_tokens`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "aurixa-mission-control",
            },
          },
        );
        if (!tokRes.ok) return null;
        const j = (await tokRes.json()) as { token: string };
        installToken = j.token;
        return installToken;
      } catch {
        return null;
      }
    };

    const getRepo = async (o: string, r: string) => {
      const token = await mintToken();
      if (!token) return null;
      const res = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "aurixa-mission-control",
          },
        },
      );
      return { ok: res.ok, status: res.status, body: res.ok ? await res.json() : null };
    };

    // Optional: verify template repo is reachable + flagged as a template.
    let templateAccessible: boolean | null = null;
    let templateRepoIsTemplate: boolean | null = null;
    if (data.method === "template" && data.templateOwner && data.templateRepo) {
      const r = await getRepo(data.templateOwner, data.templateRepo);
      if (r === null) {
        templateAccessible = false;
      } else {
        templateAccessible = r.ok;
        if (r.ok)
          templateRepoIsTemplate = Boolean((r.body as { is_template?: boolean })?.is_template);
      }
    }

    // G9 — verify target repo (already-created clone repo) is reachable.
    let targetRepoAccessible: boolean | null = null;
    if (data.targetRepo) {
      const r = await getRepo(owner, data.targetRepo);
      targetRepoAccessible = r === null ? false : r.ok;
    }

    const templateOk =
      data.method === "template"
        ? templateAccessible !== false && templateRepoIsTemplate !== false
        : true;
    const targetRepoOk = data.targetRepo ? targetRepoAccessible === true : true;
    const permsOk = contentsWritePermission !== false;
    const ok = templateOk && targetRepoOk && permsOk;

    let message: string | undefined;
    let hint: string | undefined;
    if (ok) {
      message = `App installed on ${accountType?.toLowerCase()} "${owner}" (installation #${installationId}${
        repositorySelection ? `, selection=${repositorySelection}` : ""
      }).`;
    } else if (!permsOk) {
      message = "GitHub App installation is missing 'contents: write' permission.";
      hint = "Update the App's repository permissions and re-authorize the installation.";
    } else if (targetRepoAccessible === false) {
      message = `App cannot access "${owner}/${data.targetRepo}".`;
      hint =
        repositorySelection === "selected"
          ? "Grant the Aurixa App access to this specific repository in the installation settings."
          : "Verify the repo exists and the App installation has not been suspended.";
    } else if (templateAccessible === false) {
      message = "App installed, but the template repo is not accessible to this installation.";
      hint =
        "Open the Aurixa App installation on the target org and grant it access to the template repo.";
    } else if (templateRepoIsTemplate === false) {
      message =
        "Repo exists, but it is not marked as a GitHub template. Enable 'Template repository' in its Settings.";
      hint = "In the template repo, Settings → General → check 'Template repository'.";
    }

    return {
      ok,
      appConfigured: true,
      installationFound: true,
      installationId,
      accountType,
      targetOwner: owner,
      templateAccessible,
      templateRepoIsTemplate,
      repositorySelection,
      targetRepo: data.targetRepo ?? null,
      targetRepoAccessible,
      contentsWritePermission,
      workflowsPermission,
      message,
      hint,
    };
  });
