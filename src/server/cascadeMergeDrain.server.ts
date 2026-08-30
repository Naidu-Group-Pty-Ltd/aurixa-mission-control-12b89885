/**
 * Merge the cascade pull requests whose checks have gone green.
 *
 * ## Why this has to exist
 *
 * `auto_merge` cannot merge at the moment it opens a pull request, and should
 * not try. Check runs appear asynchronously: `Vercel Preview Comments`
 * completes in the same second, while `verify` — install, typecheck, build and
 * ~19,000 tests — takes about seventeen minutes. A gate that reads the checks
 * once, immediately, sees either nothing at all or one fast green check.
 * `decideCascadeMerge` therefore refuses, correctly, and the engine leaves the
 * pull request open with the reason on it.
 *
 * Which would be the end of it. GitHub's own auto-merge is the mechanism
 * designed for exactly this wait, and it CANNOT BE ARMED on a repository with
 * no required status checks — which is every clone here, all with unprotected
 * default branches. So without this drain the honest gate turns into the old
 * symptom by another route: pull requests opened, nothing merged, and a
 * cascade summary reading `0 merged` for ever.
 *
 * This is the part that comes back and looks again.
 *
 * ## What it will and will not merge
 *
 * Only branches this engine names — `aurixa/cascade-…` — and only through
 * `decideCascadeMerge`, the same rule the engine uses, so there is one
 * definition of "green" rather than two that can drift. A pull request that is
 * failing, still running, or missing a required check is left exactly where it
 * is, with nothing written and nothing announced: a drain that reports on every
 * pull request it declined to merge every few minutes is one nobody reads.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import {
  CHECKS_PERMISSION_REMEDY,
  checksUnreadable,
  decideCascadeMerge,
  REQUIRED_CHECKS,
} from "./cascade/autoMergeGate.pure";

type Db = SupabaseClient<Database>;

/** Branches the cascade engine creates. Nothing else is ever touched. */
export const CASCADE_BRANCH_PREFIX = "aurixa/cascade-";

export type MergeDrainOutcome =
  | { clone: string; pr: number; outcome: "merged"; sha: string | null }
  | { clone: string; pr: number; outcome: "held"; reason: string; why: string }
  | { clone: string; pr: number; outcome: "failed"; error: string };

export type MergeDrainReport = {
  considered: number;
  merged: number;
  held: Record<string, number>;
  failed: number;
  detail: MergeDrainOutcome[];
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function drainCascadeMerges(
  supabase: Db,
  opts: { limitPerClone?: number } = {},
): Promise<MergeDrainReport> {
  const report: MergeDrainReport = {
    considered: 0,
    merged: 0,
    held: {},
    failed: 0,
    detail: [],
  };

  const { data, error } = await supabase
    .from("clones")
    .select("id, name, github_owner, github_repo, default_branch")
    .not("github_owner", "is", null)
    .not("github_repo", "is", null);
  // A candidate list that could not be READ is not an empty one — reporting
  // "nothing to merge" on a database fault is how a stalled fleet looks
  // healthy.
  if (error) throw new Error(`Could not list clones: ${error.message}`);

  const octokit = getAppOctokit();

  for (const raw of data ?? []) {
    const clone = raw as {
      name: string | null;
      github_owner: string | null;
      github_repo: string | null;
      default_branch: string | null;
    };
    if (!clone.github_owner || !clone.github_repo) continue;
    const label = clone.name ?? `${clone.github_owner}/${clone.github_repo}`;

    let open: Array<{ number: number; head: { ref: string; sha: string } }>;
    try {
      const { data: prs } = await octokit.pulls.list({
        owner: clone.github_owner,
        repo: clone.github_repo,
        state: "open",
        base: clone.default_branch || "main",
        per_page: opts.limitPerClone ?? 20,
      });
      open = prs as typeof open;
    } catch (e) {
      // One unreachable repository must not stop the others.
      report.failed += 1;
      report.detail.push({ clone: label, pr: 0, outcome: "failed", error: msg(e) });
      continue;
    }

    for (const pr of open.filter((p) => p.head.ref.startsWith(CASCADE_BRANCH_PREFIX))) {
      report.considered += 1;
      try {
        // Checks are read on the pull request's CURRENT head, so a push that
        // lands between the read and the merge invalidates nothing silently —
        // the merge below is by pull number and GitHub refuses a stale one.
        const { data: checkData } = await octokit.checks.listForRef({
          owner: clone.github_owner,
          repo: clone.github_repo,
          ref: pr.head.sha,
        });
        const verdict = decideCascadeMerge(
          (checkData.check_runs ?? []).map((c) => ({
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
          })),
          REQUIRED_CHECKS,
        );

        if (!verdict.merge) {
          report.held[verdict.reason] = (report.held[verdict.reason] ?? 0) + 1;
          report.detail.push({
            clone: label,
            pr: pr.number,
            outcome: "held",
            reason: verdict.reason,
            why: verdict.why,
          });
          continue;
        }

        // MERGE, never SQUASH — a squash rewrites the cascade commit naming the
        // prime SHA it came from, which is the one durable record of what a
        // clone has received.
        const { data: merged } = await octokit.pulls.merge({
          owner: clone.github_owner,
          repo: clone.github_repo,
          pull_number: pr.number,
          merge_method: "merge",
        });
        report.merged += 1;
        report.detail.push({
          clone: label,
          pr: pr.number,
          outcome: "merged",
          sha: merged.sha?.slice(0, 7) ?? null,
        });
      } catch (e) {
        // "I cannot see CI" is not "the cascade failed" — it is a missing
        // read-only permission, and the correct response to an unreadable
        // signal is to leave the pull request alone and say so.
        if (checksUnreadable(e)) {
          report.held.checks_unreadable = (report.held.checks_unreadable ?? 0) + 1;
          report.detail.push({
            clone: label,
            pr: pr.number,
            outcome: "held",
            reason: "checks_unreadable",
            why: CHECKS_PERMISSION_REMEDY,
          });
          continue;
        }
        report.failed += 1;
        report.detail.push({ clone: label, pr: pr.number, outcome: "failed", error: msg(e) });
      }
    }
  }

  return report;
}
