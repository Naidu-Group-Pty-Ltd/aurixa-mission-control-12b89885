/**
 * Keep Prime's default branch protected, through Mission Control's own App.
 *
 * `primeBranchProtection.pure.ts` says what the protection is and decides
 * what to change; this reads GitHub, hands it over, and writes the answer.
 *
 * ## When it runs
 *
 * Every night, from `/hooks/codex-nightly` (`apply: true`), so a ruleset a
 * person deleted is back by morning and one that lost a rule gets it back.
 * Read-only from engine health (`apply: false`), which reports what the
 * nightly pass would do. And when an admin presses "Protect main now".
 *
 * ## What it refuses to do
 *
 * It never protects `main` without Lovable on the bypass list — Lovable
 * pushes there directly and would stop publishing — so an App id it could not
 * establish from Lovable's bot account is a refusal, not a guess. It never
 * requires a check `ci.yml` no longer has a job for: nothing would ever
 * report it, and every pull request would wait on it forever. It never
 * rewrites a ruleset whose bypass list it was not shown. And it never
 * switches back on a ruleset a person switched off.
 *
 * ## The permission it needs
 *
 * Rulesets and the "Allow auto-merge" setting are Administration on the
 * repository. Without "Administration: Read and write" every write here is
 * refused with a 403, which is reported as exactly that — with the setting to
 * change — rather than as a failure of the nightly scan around it.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getAppOctokit } from "@/server/github-app.server";
import {
  LOVABLE_BOT_USER_ID,
  PRIME_REQUIRED_CHECKS,
  PRIME_RULESET_NAME,
  appSlugFromBotLogin,
  decideProtection,
  desiredPrimeRuleset,
  missingRequiredChecks,
  type Ruleset,
} from "@/server/primeBranchProtection.pure";

export type ProtectionReport = {
  /** Whether `main` is protected as it should be once this returns. */
  ok: boolean;
  status:
    | "protected"
    | "created"
    | "updated"
    | "would_create"
    | "would_update"
    | "switched_off"
    | "needs_permission"
    | "blocked"
    | "error";
  detail: string;
  fix?: string;
  repo?: string;
  rulesetId?: number;
  rulesetUrl?: string;
  shortfall?: string[];
  lovableApp?: { id: number; slug: string } | null;
  autoMerge?: "on" | "turned_on" | "off" | "unknown";
};

type Octo = ReturnType<typeof getAppOctokit>;

const statusOf = (e: unknown) => (e as { status?: number })?.status;
const messageOf = (e: unknown) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
  (e instanceof Error ? e.message : String(e));

const PERMISSION_FIX =
  "Give the aurixa-mission-control GitHub App “Administration: Read and write” " +
  "(organisation Settings → Developer settings → GitHub Apps → aurixa-mission-control → " +
  "Permissions & events → Repository permissions), then accept the new permission on the " +
  "installation (organisation Settings → GitHub Apps → aurixa-mission-control → Review request). " +
  "The next nightly run, or “Protect main now”, applies the ruleset.";

/** Lovable's App, found from the bot account its commits carry — never from a name alone. */
async function resolveLovableApp(octokit: Octo): Promise<{ id: number; slug: string } | null> {
  const { data: bot } = await octokit.request("GET /user/{account_id}", {
    account_id: LOVABLE_BOT_USER_ID,
  });
  const slug = appSlugFromBotLogin((bot as { login?: unknown })?.login);
  if (!slug) return null;
  const { data: app } = await octokit.request("GET /apps/{app_slug}", { app_slug: slug });
  const id = (app as { id?: unknown })?.id;
  return typeof id === "number" ? { id, slug: (app as { slug?: string }).slug ?? slug } : null;
}

async function readCiWorkflow(
  octokit: Octo,
  where: { owner: string; repo: string; ref: string },
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({
      ...where,
      path: ".github/workflows/ci.yml",
    });
    const file = data as { type?: string; content?: string };
    if (file.type !== "file" || typeof file.content !== "string") return null;
    return Buffer.from(file.content, "base64").toString("utf8");
  } catch (e) {
    if (statusOf(e) === 404) return null;
    throw e;
  }
}

async function readOurRuleset(
  octokit: Octo,
  where: { owner: string; repo: string },
): Promise<Ruleset | null> {
  const { data: list } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", {
    ...where,
    includes_parents: false,
    per_page: 100,
  });
  const summary = (list as Array<{ id: number; name: string; source_type?: string }>).find(
    (r) => r.name === PRIME_RULESET_NAME && (r.source_type ?? "Repository") === "Repository",
  );
  if (!summary) return null;
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
    ...where,
    ruleset_id: summary.id,
  });
  return data as unknown as Ruleset;
}

/** The body GitHub's create and update take: what a ruleset says, without what GitHub adds. */
const writable = (r: Ruleset) => ({
  name: r.name,
  target: r.target ?? "branch",
  enforcement: r.enforcement,
  conditions: r.conditions ?? undefined,
  rules: r.rules ?? [],
  bypass_actors: r.bypass_actors ?? [],
});

export async function ensurePrimeBranchProtection(opts: {
  apply: boolean;
}): Promise<ProtectionReport> {
  const { data: prime } = await supabaseAdmin
    .from("prime_config")
    .select("github_owner, github_repo, default_branch, github_app_installation_id")
    .limit(1)
    .maybeSingle();
  if (!prime?.github_owner || !prime?.github_repo) {
    return {
      ok: false,
      status: "blocked",
      detail: "prime_config has no GitHub repository, so there is no branch to protect",
      fix: "Set github_owner / github_repo in prime_config.",
    };
  }
  const owner = prime.github_owner;
  const repo = prime.github_repo;
  const where = { owner, repo };
  const repoName = `${owner}/${repo}`;
  const octokit = getAppOctokit(prime.github_app_installation_id ?? undefined);

  try {
    const { data: repoData } = await octokit.repos.get(where);
    const branch = prime.default_branch || repoData.default_branch || "main";
    const rulesetsUrl = `https://github.com/${repoName}/settings/rules`;
    const autoMergeSetting = (repoData as { allow_auto_merge?: boolean }).allow_auto_merge;

    const ci = await readCiWorkflow(octokit, { ...where, ref: branch });
    const missing = ci === null ? [...PRIME_REQUIRED_CHECKS] : missingRequiredChecks(ci);
    if (missing.length > 0) {
      return {
        ok: false,
        status: "blocked",
        repo: repoName,
        detail:
          `.github/workflows/${ci === null ? "ci.yml is missing" : "ci.yml has no job named " + missing.map((m) => `“${m}”`).join(" or ")} ` +
          `on ${branch}. A required check nothing reports holds every pull request open, so ${branch} is not protected until it does.`,
        fix: `Restore the job${missing.length === 1 ? "" : "s"} in ci.yml, or update PRIME_REQUIRED_CHECKS in src/server/primeBranchProtection.pure.ts to the new name.`,
      };
    }

    const lovableApp = await resolveLovableApp(octokit).catch(() => null);
    if (!lovableApp) {
      return {
        ok: false,
        status: "blocked",
        repo: repoName,
        lovableApp: null,
        detail:
          `Could not find Lovable's GitHub App from its bot account (id ${LOVABLE_BOT_USER_ID}). ` +
          `Lovable pushes to ${branch} directly, so protecting it without Lovable on the bypass list would stop Lovable publishing.`,
        fix: "This is retried every night. If it persists, check that Lovable's GitHub integration is still connected to this repository.",
      };
    }

    const desired = desiredPrimeRuleset({
      lovableAppId: lovableApp.id,
      ownerIsOrganization: repoData.owner?.type === "Organization",
    });
    const existing = await readOurRuleset(octokit, where);
    const decision = decideProtection(existing, desired, branch);
    const base = { repo: repoName, lovableApp, rulesetUrl: rulesetsUrl };

    if (decision.kind === "stand_down") {
      return {
        ...base,
        ok: false,
        status: "switched_off",
        rulesetId: decision.id,
        detail: decision.why,
      };
    }
    if (decision.kind === "unreadable") {
      return {
        ...base,
        ok: false,
        status: "needs_permission",
        rulesetId: decision.id,
        detail: `${decision.why}, so it is left as it is.`,
        fix: PERMISSION_FIX,
      };
    }

    let status: ProtectionReport["status"] = "protected";
    let rulesetId = decision.kind === "create" ? undefined : decision.id;
    const shortfall = decision.kind === "update" ? decision.shortfall : undefined;
    if (decision.kind === "create" || decision.kind === "update") {
      if (!opts.apply) {
        return {
          ...base,
          ok: false,
          status: decision.kind === "create" ? "would_create" : "would_update",
          rulesetId,
          shortfall,
          detail:
            decision.kind === "create"
              ? `${branch} has no protection: any token that can write to the repository can push to it. The nightly run creates “${PRIME_RULESET_NAME}”.`
              : `“${PRIME_RULESET_NAME}” has drifted: ${decision.shortfall.join("; ")}. The nightly run puts it back.`,
          autoMerge: autoMergeSetting === undefined ? "unknown" : autoMergeSetting ? "on" : "off",
        };
      }
      try {
        // Routes typed as plain strings: Octokit's own types for these bodies
        // name every rule GitHub has, and a ruleset read back from GitHub is
        // written back as it came, whatever rules a person added to it.
        if (decision.kind === "create") {
          const create: string = "POST /repos/{owner}/{repo}/rulesets";
          const { data } = await octokit.request(create, { ...where, ...writable(decision.body) });
          rulesetId = (data as { id?: number }).id;
          status = "created";
        } else {
          const update: string = "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}";
          await octokit.request(update, {
            ...where,
            ruleset_id: decision.id,
            ...writable(decision.body),
          });
          status = "updated";
        }
      } catch (e) {
        if (statusOf(e) === 403 || statusOf(e) === 404) {
          return {
            ...base,
            ok: false,
            status: "needs_permission",
            rulesetId,
            shortfall,
            detail: `GitHub refused to ${decision.kind} the ruleset (${statusOf(e)}: ${messageOf(e)}). ${branch} is still unprotected.`,
            fix: PERMISSION_FIX,
          };
        }
        throw e;
      }
    }

    // "Allow auto-merge": what lets a proposal Mission Control cannot merge
    // itself — the digest manifest refresh — land the moment its checks pass.
    // It merges nothing by itself; each pull request has to be armed.
    let autoMerge: ProtectionReport["autoMerge"] =
      autoMergeSetting === undefined ? "unknown" : autoMergeSetting ? "on" : "off";
    if (opts.apply && autoMergeSetting === false) {
      try {
        await octokit.repos.update({ ...where, allow_auto_merge: true });
        autoMerge = "turned_on";
      } catch (e) {
        console.warn(
          `[branch-protection] could not allow auto-merge on ${repoName}:`,
          messageOf(e),
        );
      }
    }

    if (rulesetId) base.rulesetUrl = `${rulesetsUrl}/${rulesetId}`;
    const verb =
      status === "created"
        ? "Created"
        : status === "updated"
          ? `Restored (${(shortfall ?? []).join("; ")})`
          : "In place";
    return {
      ...base,
      ok: true,
      status,
      rulesetId,
      shortfall,
      autoMerge,
      detail:
        `${verb}: “${PRIME_RULESET_NAME}” on ${branch} — pull requests only, ` +
        `${PRIME_REQUIRED_CHECKS.map((c) => `“${c}”`).join(" and ")} required; ` +
        `Lovable (${lovableApp.slug}) and admins may push directly` +
        (autoMerge === "off"
          ? ". Auto-merge is off, so the digest refresh waits for a person"
          : ""),
    };
  } catch (e) {
    return {
      ok: false,
      status: "error",
      repo: repoName,
      detail: `Could not read or write ${repoName}'s rulesets: ${messageOf(e)}`,
      fix: "Retried every night. A 403 here means the App lacks Administration on the repository.",
    };
  }
}
