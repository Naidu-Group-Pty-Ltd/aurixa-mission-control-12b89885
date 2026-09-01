/**
 * What a cascade owes a clone's BACKEND, read off the paths it delivered.
 *
 * A cascade pushes the prime's files onto a clone's default branch. What
 * serves the clone is then rebuilt — `requestRedeployAfterPush` exists for
 * exactly that, and its comment explains why nothing else asks: Vercel
 * rebuilds on push only where its own GitHub App is installed, and Mission
 * Control forks clones through its App and never installs Vercel's.
 *
 * The same sentence is true of the backend and nothing acted on it. Edge
 * functions and migrations live in the same commit as the frontend, reach the
 * clone's default branch in the same push, and then sit there: the clone's own
 * `deploy-supabase-functions.yml` is the only thing that ever looked, and on
 * `npc-client-dashboard` it has failed all 28 times it has run since 19 August
 * for want of a repository secret. The frontend moved and the backend did not,
 * which is the worst of the three possible states — a deployment whose two
 * halves are from different commits.
 *
 * This module decides only WHAT is owed. `backendSync.server.ts` decides
 * whether to ask for it, and the two self-healing lanes do it.
 *
 * ## Why a shared file means every function
 *
 * `groupFunctionPaths` (prime-backend.server.ts) is the authority on how a
 * bundle is assembled, and it is explicit: `_shared/**` and the root
 * `import_map.json` / `deno.json*` are "the shared/root files that ship with
 * every bundle". So one edit under `_shared/` does not make one function
 * stale — it makes all of them stale, and a rule that mapped the path to no
 * slug at all would deploy nothing precisely when the most functions had
 * changed.
 *
 * `supabase/config.toml` widens the same way, for a different reason: it
 * carries the per-function `verify_jwt` declaration, MC sends that value in
 * the deploy metadata, and this repository has already recorded what a
 * config-only edit deploying nothing costs.
 *
 * ## What this deliberately does not do
 *
 * A cascade that DELETES a function directory produces no work here. Deploying
 * cannot remove a function, and removing one from a tenant's project is
 * destructive in a way redeploying never is — it is somebody's decision, not a
 * consequence of a file no longer existing upstream.
 */
import { isExcludedFunctionFile } from "@/server/prime-backend.server";

const FUNCTIONS_PREFIX = "supabase/functions/";
const MIGRATIONS_PREFIX = "supabase/migrations/";
const CONFIG_PATH = "supabase/config.toml";

/** Root files under `supabase/functions/` that ship inside every bundle. */
const SHARED_ROOT_FILES = /^(import_map\.json|deno\.jsonc?)$/;

export type CascadeBackendWork = {
  /**
   * Slugs whose bundle this cascade made stale, or `null` for EVERY function.
   *
   * `null` rather than a list of all of them, because that is the vocabulary
   * the lane already speaks: `edge_function_deploy` reads `plan.slugs` and
   * treats null as "no filter". Expanding it here would mean naming slugs this
   * module cannot see — it is given paths, not the prime's function inventory.
   */
  readonly staleFunctions: readonly string[] | null;
  /** Whether the cascade delivered any migration file. */
  readonly migrationsOwed: boolean;
  /** Why, in words an operator reads on the run row. */
  readonly reasons: readonly string[];
};

export const NO_BACKEND_WORK: CascadeBackendWork = {
  staleFunctions: [],
  migrationsOwed: false,
  reasons: [],
};

export function hasBackendWork(work: CascadeBackendWork): boolean {
  return work.migrationsOwed || work.staleFunctions === null || work.staleFunctions.length > 0;
}

/**
 * Decide what a cascade owes the backend, from the paths it wrote.
 *
 * Paths are repo-relative, exactly as `ClonePlan.writes` carries them.
 */
export function cascadeBackendWork(paths: readonly string[]): CascadeBackendWork {
  const slugs = new Set<string>();
  const reasons: string[] = [];
  let allFunctions = false;
  let migrations = 0;

  for (const path of paths) {
    if (path === CONFIG_PATH) {
      allFunctions = true;
      reasons.push("supabase/config.toml changed — it declares every function's verify_jwt");
      continue;
    }

    if (path.startsWith(MIGRATIONS_PREFIX)) {
      // Only `.sql` counts. The directory also carries README and tooling
      // files in some repositories, and a migration run planned for a README
      // is a run that reports "already at head" and teaches an operator to
      // ignore the lane.
      if (path.toLowerCase().endsWith(".sql")) migrations += 1;
      continue;
    }

    if (!path.startsWith(FUNCTIONS_PREFIX)) continue;

    const rel = path.slice(FUNCTIONS_PREFIX.length);
    if (!rel || isExcludedFunctionFile(rel)) continue;

    const slash = rel.indexOf("/");
    if (slash === -1) {
      if (SHARED_ROOT_FILES.test(rel)) {
        allFunctions = true;
        reasons.push(`${path} ships inside every function bundle`);
      }
      continue;
    }

    const top = rel.slice(0, slash);
    if (top === "_shared") {
      allFunctions = true;
      reasons.push("supabase/functions/_shared/ changed — it ships inside every bundle");
      continue;
    }
    slugs.add(top);
  }

  if (!allFunctions && slugs.size > 0) {
    const named = [...slugs].sort();
    reasons.push(
      named.length === 1
        ? `1 function changed: ${named[0]}`
        : `${named.length} functions changed: ${named.slice(0, 5).join(", ")}${
            named.length > 5 ? `, +${named.length - 5} more` : ""
          }`,
    );
  }
  if (migrations > 0) {
    reasons.push(`${migrations} migration file${migrations === 1 ? "" : "s"} delivered`);
  }

  return {
    staleFunctions: allFunctions ? null : [...slugs].sort(),
    migrationsOwed: migrations > 0,
    // De-duplicated: one cascade routinely carries a dozen `_shared/` files and
    // the same sentence a dozen times is not twelve reasons.
    reasons: [...new Set(reasons)],
  };
}
