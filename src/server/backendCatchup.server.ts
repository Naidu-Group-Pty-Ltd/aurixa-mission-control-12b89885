/**
 * Bring an EXISTING clone's backend up to the prime, without a cascade.
 *
 * ## The gap this closes
 *
 * `requestBackendSyncAfterCascade` already knows exactly what a clone's
 * backend owes: it diffs the prime between two of its own revisions and queues
 * the stale edge functions and any migrations. It works — eight
 * `edge_function_deploy` runs have succeeded through it. But it has exactly
 * two callers, the cascade engine and the merge drain, and **both fire only
 * when a cascade MERGES.**
 *
 * A cascade merges only when the clone repository's own CI goes green. Since
 * 05:35 UTC on 4 September GitHub has started no job on any of the three
 * private clone repositories, so nothing has merged — and therefore no clone
 * has had a single backend change since 04:00 that day, silently, while the
 * cascade itself opened its pull requests on schedule and recorded no error.
 *
 * That is not really a fact about Actions billing. The deploy does not need
 * the clone's CI at all: it reads the prime's repository and writes to the
 * clone's Supabase project through the Management API. **The catch-up was
 * simply chained to an event that can stop happening**, and a fleet-wide
 * backend fix is an ordinary act that had no ordinary lever — the same shape
 * as the fleet secret forward, one layer down.
 *
 * ## The four rules
 *
 * **It plans; it never advances the baseline.** `last_synced_sha` means the
 * clone's repository CONTENT is at that prime revision, and this deploys
 * FUNCTIONS. Advancing it here would tell the next cascade the files are
 * current and skip them — the clone would then run new functions against old
 * content, which is worse than being behind on both.
 *
 * **A clone with no recorded baseline owes everything**, which is what the
 * planner already does with a null `fromSha`. That is the safe direction: it
 * redeploys more than strictly necessary and never less.
 *
 * **It settles.** The planner widens an open run rather than queuing a second
 * one, so a sweep that runs every half hour cannot pile up work. A pass with
 * nothing owed reports `no_backend_work` and writes nothing at all.
 *
 * **A read that failed is not a clone with nothing owed.** Every refusal is
 * named and returned; the sweep answers 200 with them in the body, because one
 * clone that cannot be planned is not a failed sweep.
 */

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getAppOctokit } from "@/server/github-app.server";

export type CatchupOutcome = {
  cloneId: string;
  cloneName: string | null;
  /** Named refusal, or null when the planner was reached. */
  refused: string | null;
  /** What the planner answered, verbatim, when it was reached. */
  planned: string[];
};

export type BackendCatchupResult = {
  primeSha: string | null;
  considered: number;
  planned: number;
  outcomes: CatchupOutcome[];
  /** Fleet-level refusal — nothing was considered at all. */
  refused: string | null;
};

/**
 * Read the prime's current HEAD.
 *
 * The same read the cascade engine makes, for the same reason: the diff is
 * taken on the PRIME between two of its own revisions, so both ends must be
 * prime revisions or the comparison is meaningless (and answers 404, which is
 * the defect that once left two clones reading `failed` for a week).
 */
async function primeHead(): Promise<{ sha: string } | { error: string }> {
  const { data: prime, error } = await supabaseAdmin
    .from("prime_config")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (error) return { error: `could not read the prime configuration: ${error.message}` };
  if (!prime?.github_owner || !prime?.github_repo) return { error: "prime_not_configured" };

  try {
    const octokit = getAppOctokit();
    const { data: br } = await octokit.repos.getBranch({
      owner: prime.github_owner,
      repo: prime.github_repo,
      branch: prime.default_branch || "main",
    });
    return { sha: br.commit.sha };
  } catch (e) {
    // A rate limit or a network blip is a fact about this pass, not about the
    // fleet. Nothing is planned and nothing is recorded as owing nothing.
    return { error: `could not read the prime's HEAD: ${e instanceof Error ? e.message : "unknown"}` };
  }
}

/**
 * Plan the backend catch-up every clone owes against the prime as it stands.
 *
 * `reason` reaches the queued run's plan, so an operator reading
 * `remediation_runs` can tell a sweep-planned deploy from a cascade-planned
 * one without guessing.
 */
export async function runBackendCatchup(reason = "backend catch-up sweep"): Promise<BackendCatchupResult> {
  const head = await primeHead();
  if ("error" in head) {
    return { primeSha: null, considered: 0, planned: 0, outcomes: [], refused: head.error };
  }

  const { data: clones, error } = await supabaseAdmin
    .from("clones")
    .select("id, name, last_synced_sha");
  if (error) {
    return {
      primeSha: head.sha,
      considered: 0,
      planned: 0,
      outcomes: [],
      refused: `could not list clones: ${error.message}`,
    };
  }

  const { requestBackendSyncAfterCascade } = await import("@/server/backendSync.server");
  const outcomes: CatchupOutcome[] = [];
  let planned = 0;

  for (const clone of clones ?? []) {
    const row = clone as { id: string; name?: string | null; last_synced_sha?: string | null };
    const request = await requestBackendSyncAfterCascade({
      cloneId: row.id,
      reason,
      // Null is legitimate and means "owes every backend file" — the planner's
      // own safe reading, and never invented here.
      fromSha: row.last_synced_sha ?? null,
      toSha: head.sha,
    });
    if (!request.requested) {
      outcomes.push({
        cloneId: row.id,
        cloneName: row.name ?? null,
        refused: request.reason,
        planned: [],
      });
      continue;
    }
    planned += 1;
    outcomes.push({
      cloneId: row.id,
      cloneName: row.name ?? null,
      refused: null,
      planned: request.runs.map((r) => `${r.action}: ${r.outcome}`),
    });
  }

  return {
    primeSha: head.sha,
    considered: (clones ?? []).length,
    planned,
    outcomes,
    refused: null,
  };
}
