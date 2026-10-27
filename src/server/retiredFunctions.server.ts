/**
 * Read the prime's retired functions for one pass of the function sweep.
 *
 * The rules are `retiredFunctions.pure.ts`'; this is the I/O around them.
 *
 * ## One commit
 *
 * The prime is read at its head, and every read after the first is pinned to
 * the commit the first one saw: the `supabase/` tree, then the workflows
 * directory, then each decommission workflow in it. A list and the tree it is
 * checked against describe the same commit, whatever the branch does while
 * the pass runs.
 *
 * ## It yields first
 *
 * It asks the installation's budget at the scan floor before its first call,
 * as the catch-up it runs in does for its own reads. A pass it skips deletes
 * nothing retired, and the next pass reads the lists. The prime's own
 * functions are taken off all the same, because that half reads nothing from
 * GitHub.
 *
 * ## It never throws
 *
 * Every way it cannot read is named. An unconfigured prime, a tree or a
 * directory that cannot be listed, a workflow that cannot be read: none of
 * them is ever an empty register. The sweep it feeds deletes nothing retired
 * on a register it does not have.
 */
import type { RepoRef } from "./github-app.server";
import { getAppOctokit, getFileContent } from "./github-app.server";
import { decideSpend } from "./cascade/githubBudget.pure";
import { readGitHubRemaining } from "./githubAllowance.server";
import { fetchSupabaseTreePaths, resolvePrimeSource } from "./prime-backend.server";
import {
  DECOMMISSION_WORKFLOW_PATH,
  assembleRetiredRegister,
  functionDirectoriesIn,
  readRetiredList,
  type RetiredFunctionRegister,
  type RetiredListReading,
} from "./retiredFunctions.pure";

/** A workflow is a few kilobytes. Anything this size is not one to read. */
const WORKFLOW_MAX_BYTES = 256 * 1024;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What a clone's own tree carries, or why it could not be read. */
export type CloneTreeReading = { carries: ReadonlySet<string> } | { refused: string };

export type RetiredRegisterOpening =
  | {
      ok: true;
      register: RetiredFunctionRegister;
      /** A clone's own function directories, read on the same installation. */
      cloneCarries: (ref: RepoRef) => Promise<CloneTreeReading>;
    }
  | {
      ok: false;
      /** True when the budget, not a failure, stopped it: the next pass reads it. */
      postponed: boolean;
      why: string;
    };

export async function openRetiredFunctionRegister(): Promise<RetiredRegisterOpening> {
  try {
    const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
    if (!spend.proceed) return { ok: false, postponed: true, why: spend.why };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const prime = await resolvePrimeSource(supabaseAdmin);
    if (!prime) {
      return { ok: false, postponed: false, why: "the prime's repository is not configured" };
    }
    const octokit = getAppOctokit();
    const tree = await fetchSupabaseTreePaths(octokit, prime);
    if (!tree) {
      return {
        ok: false,
        postponed: false,
        why: `the prime's supabase/ tree could not be read from ${prime.owner}/${prime.repo}@${prime.branch}`,
      };
    }
    const at = { owner: prime.owner, repo: prime.repo, branch: tree.commitSha };
    const readAt = `${prime.owner}/${prime.repo}@${tree.commitSha.slice(0, 12)}`;

    let listing: unknown;
    try {
      const res = await octokit.repos.getContent({
        owner: at.owner,
        repo: at.repo,
        path: ".github/workflows",
        ref: at.branch,
      });
      listing = res.data;
    } catch (e) {
      return {
        ok: false,
        postponed: false,
        why: `the prime's workflows could not be listed at ${readAt}: ${message(e)}`,
      };
    }
    if (!Array.isArray(listing)) {
      return {
        ok: false,
        postponed: false,
        why: `the prime's .github/workflows at ${readAt} is not a directory`,
      };
    }
    const paths = (listing as Array<{ type?: string; path?: string }>)
      .filter((e) => e.type === "file" && typeof e.path === "string")
      .map((e) => e.path as string)
      .filter((p) => DECOMMISSION_WORKFLOW_PATH.test(p))
      .sort();

    const workflows: Array<{ path: string; reading: RetiredListReading }> = [];
    for (const path of paths) {
      let reading: RetiredListReading;
      try {
        const file = await getFileContent(octokit, at, path, { maxBytes: WORKFLOW_MAX_BYTES });
        reading = !file
          ? { kind: "refused", why: `it could not be read at ${readAt}` }
          : file.binary
            ? { kind: "refused", why: "it is not text" }
            : readRetiredList(file.content);
      } catch (e) {
        reading = { kind: "refused", why: `it could not be read at ${readAt}: ${message(e)}` };
      }
      workflows.push({ path, reading });
    }

    return {
      ok: true,
      register: assembleRetiredRegister({ readAt, workflows, primeTreePaths: tree.paths }),
      cloneCarries: async (ref) => {
        const own = await fetchSupabaseTreePaths(octokit, ref);
        return own
          ? { carries: functionDirectoriesIn(own.paths) }
          : { refused: `${ref.owner}/${ref.repo}@${ref.branch} could not be read` };
      },
    };
  } catch (e) {
    return {
      ok: false,
      postponed: false,
      why: `the retired functions could not be read: ${message(e)}`,
    };
  }
}
