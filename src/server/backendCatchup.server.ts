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
 * **And it never READS that baseline as the backend's, either** — the same
 * distinction, in the other direction, and the one that had been missed. The
 * cascade advances `last_synced_sha` when a pull request merges, whether or
 * not the deploy that merge requested ever landed, so a clone whose deploy
 * had parked was diffed head-against-head and answered `no_backend_work` for
 * ever.
 *
 * **Nor from a column another lane writes.** The replacement baseline was
 * `clone_backends.source_sha`, and the fleet migration lane rewrites that
 * column with the prime's HEAD on every pass — so the sweep went on diffing
 * head against head, one lane over. The baseline is now the newest succeeded
 * deploy run that PROVES a revision (`functionsBaseline.pure.ts`), which only
 * the deploy lane writes and only where every bundle it owed landed.
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
import { functionsBaselineByClone } from "@/server/functionsBaseline.pure";

/**
 * How many revision-recording deploy runs the sweep reads for the whole fleet.
 *
 * Only runs that PROVE a revision are counted, so this is a window over
 * proofs rather than over passes: each clone contributes about one per prime
 * change that touches its functions. A clone whose newest proof has fallen out
 * of the window owes everything and is redeployed in full — the safe side.
 */
const RECORDED_REVISION_WINDOW = 500;

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

  const { data: clones, error } = await supabaseAdmin.from("clones").select("id, name");
  if (error) {
    return {
      primeSha: head.sha,
      considered: 0,
      planned: 0,
      outcomes: [],
      refused: `could not list clones: ${error.message}`,
    };
  }

  // The from-baseline for FUNCTIONS is the revision the clone's functions are
  // PROVEN to be at — the newest succeeded `edge_function_deploy` that
  // records one — and never a column somebody else also writes.
  //
  // Two earlier readings were each a different fact wearing this one's name.
  // `clones.last_synced_sha` is the REPOSITORY's revision, advanced when a
  // cascade merges whether or not its deploy landed. `clone_backends.source_sha`
  // is rewritten with the prime's HEAD by the fleet migration lane on every
  // pass, so reading it diffed head against head and answered
  // `no_backend_work` about two clones whose functions had not moved for a
  // week. See `functionsBaseline.pure.ts` for the measurement and the rule.
  //
  // Filtered to runs that recorded a revision, so the window reaches back over
  // a long history rather than over the last few passes of a busy fleet. A
  // clone with no proof in it owes every backend file — the planner's own safe
  // reading, which costs a redeploy and can never skip one.
  const { data: deploys, error: deployErr } = await supabaseAdmin
    .from("remediation_runs")
    .select("clone_id, plan, result, completed_at")
    .eq("action_type", "edge_function_deploy")
    .eq("status", "succeeded")
    .eq("result->>revision_recorded", "true")
    .order("completed_at", { ascending: false })
    .limit(RECORDED_REVISION_WINDOW);
  // A read that FAILED is not a fleet with no recorded revisions — planning
  // every clone from nothing would redeploy the whole fleet on a database
  // blip, so the pass reports rather than guesses.
  if (deployErr) {
    return {
      primeSha: head.sha,
      considered: 0,
      planned: 0,
      outcomes: [],
      refused: `could not read the clones' functions revisions: ${deployErr.message}`,
    };
  }
  const functionsSha = functionsBaselineByClone(
    (deploys ?? []).map((d) => ({
      cloneId: (d as { clone_id: string | null }).clone_id,
      plan: (d as { plan: unknown }).plan,
      result: (d as { result: unknown }).result,
      completedAt: (d as { completed_at: string | null }).completed_at,
    })),
  );

  const { requestBackendSyncAfterCascade } = await import("@/server/backendSync.server");
  const outcomes: CatchupOutcome[] = [];
  let planned = 0;

  for (const clone of clones ?? []) {
    const row = clone as { id: string; name?: string | null };
    const request = await requestBackendSyncAfterCascade({
      cloneId: row.id,
      reason,
      // Null is legitimate and means "owes every backend file" — the planner's
      // own safe reading, and never invented here. The repository baseline is
      // deliberately NOT a fallback: it is the reading that was never the
      // backend's.
      fromSha: functionsSha.get(row.id) ?? null,
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
