// Where a scan or a PR check for a target actually goes on GitHub. Server-only.
//
// Shared by the scheduler (dispatch, PR check creation) and the scan webhook
// (PR check completion); it lives on its own so neither has to import the
// other.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const admin = supabaseAdmin;

export type DispatchTarget = {
  owner: string;
  repo: string;
  installationId: string | null;
  defaultBranch: string;
};

/**
 * Resolve the GitHub coordinates a scan must be dispatched against. The
 * workflow lives on a branch, so `defaultBranch` is what we dispatch on even
 * when the scan itself targets a PR head SHA.
 */
export async function resolveDispatchTarget(opts: {
  targetKind: "prime" | "clone";
  cloneId?: string | null;
  repoFullName: string;
}): Promise<DispatchTarget> {
  const [fallbackOwner, fallbackRepo] = (opts.repoFullName || "").split("/");

  if (opts.targetKind === "prime") {
    const { data: p } = await admin
      .from("prime_config")
      .select("github_owner, github_repo, default_branch, github_app_installation_id")
      .limit(1)
      .maybeSingle();
    return {
      owner: p?.github_owner || fallbackOwner || "",
      repo: p?.github_repo || fallbackRepo || "",
      installationId: p?.github_app_installation_id ?? null,
      defaultBranch: p?.default_branch || "main",
    };
  }

  if (!opts.cloneId) {
    return {
      owner: fallbackOwner || "",
      repo: fallbackRepo || "",
      installationId: null,
      defaultBranch: "main",
    };
  }

  // The installation id is fetched separately: it is an optional column, and
  // naming an unknown column fails the entire PostgREST select, which would
  // take owner/repo/branch down with it.
  const { loadCloneInstallationId } = await import("@/server/clone-installation.server");
  const [{ data: c }, installationId] = await Promise.all([
    admin
      .from("clones")
      .select("github_owner, github_repo, default_branch")
      .eq("id", opts.cloneId)
      .maybeSingle(),
    loadCloneInstallationId(admin, opts.cloneId),
  ]);
  return {
    owner: c?.github_owner || fallbackOwner || "",
    repo: c?.github_repo || fallbackRepo || "",
    installationId,
    defaultBranch: c?.default_branch || "main",
  };
}
