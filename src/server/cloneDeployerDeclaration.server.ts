/**
 * Keeping every clone repository declared as Mission Control's to deploy.
 *
 * The reasoning — why this is standing state rather than an act, and why the
 * switch has no second position — is `cloneDeployerDeclaration.pure.ts`. This
 * is the part that talks to GitHub.
 *
 * One rule shapes the code rather than the decision: **a read that failed is
 * not a variable that is absent.** `listRepoVariables` answers `null` when
 * GitHub could not be asked, and writing on that basis would touch a
 * repository whose state nobody knows. Those are counted as `unknown` and
 * left alone.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { assessRepoWriteCapabilities } from "./githubAppCapability.pure";
import { planDeployerDeclaration, type DeclarationSweep } from "./cloneDeployerDeclaration.pure";

type Db = SupabaseClient<Database>;

/**
 * Bring every clone repository to the declared state, and report what moved.
 *
 * Settles: once a repository says it, a pass is one variable listing and no
 * write at all, so a quiet fleet costs a listing per clone and nothing else.
 */
export async function reconcileCloneDeployerDeclarations(supabase: Db): Promise<DeclarationSweep> {
  const sweep: DeclarationSweep = {
    permission: "unknown",
    considered: 0,
    declared: [],
    already: 0,
    cannot: [],
    unknown: [],
    failed: [],
  };

  const { data: clones, error } = await supabase
    .from("clones")
    .select("id, github_owner, github_repo")
    .not("github_owner", "is", null)
    .not("github_repo", "is", null);
  if (error) {
    sweep.failed.push({ repo: "*", error: error.message });
    return sweep;
  }

  const targets = (clones ?? []).filter((c) => c.github_owner && c.github_repo);
  if (targets.length === 0) return sweep;

  const { listRepoVariables, declareMissionControlDeploysBackend, readInstallationPermissions } =
    await import("./github-variables.server");
  const { BACKEND_DEPLOYER_VARIABLE } = await import("./github-variables.server");

  // Asked once for the whole sweep: the installation's permissions are a
  // property of the App, not of a repository, and asking per clone would be
  // one wasted call each.
  const capabilities = assessRepoWriteCapabilities(await readInstallationPermissions());
  // Recorded whatever the pass then does, so a row of `unknown` repositories
  // can be told apart from a row caused by a permission the App does not hold.
  sweep.permission = capabilities.variables.state;

  for (const clone of targets) {
    const owner = clone.github_owner as string;
    const repo = clone.github_repo as string;
    const label = `${owner}/${repo}`;
    sweep.considered += 1;

    const variables = await listRepoVariables({ owner, repo });
    const plan = planDeployerDeclaration({
      repo: label,
      // `null` from the reader means the LISTING failed, which is not the same
      // as a repository holding no such variable.
      variableValue:
        variables === null ? undefined : (variables[BACKEND_DEPLOYER_VARIABLE] ?? null),
      capabilities,
    });

    if (plan.act === "already") {
      sweep.already += 1;
      continue;
    }
    if (plan.act === "unknown") {
      sweep.unknown.push({ repo: label, why: plan.why });
      continue;
    }
    if (plan.act === "cannot") {
      sweep.cannot.push({ repo: label, why: plan.why });
      continue;
    }

    // `declareMissionControlDeploysBackend` reads the variable back before it
    // reports success, so a write that returned without throwing and changed
    // nothing is a failure here rather than a silent no-op.
    const declared = await declareMissionControlDeploysBackend({ owner, repo });
    if (declared.ok) sweep.declared.push(label);
    else sweep.failed.push({ repo: label, error: declared.error });
  }

  return sweep;
}
