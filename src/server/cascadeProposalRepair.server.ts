/**
 * Repair a cascade proposal the clone's default branch has moved out from
 * under — automatically, on every clone, without anyone reading a diff.
 *
 * ## The problem this exists for
 *
 * A cascade opens a pull request against a clone. Between opening it and
 * landing it the clone's default branch can move: the merge drain lands an
 * earlier proposal, a Dependabot bump merges, somebody pushes a fix, Lovable
 * writes. If anything that lands touches a file the open proposal also carries,
 * GitHub marks the proposal `dirty` and it can never merge.
 *
 * At one clone that is an afternoon's annoyance. At a hundred it is a standing
 * job nobody can do: every conflict is a judgement about which side wins, made
 * by someone who did not write either side, on a repository they do not
 * otherwise work in. That does not scale and it should not have to.
 *
 * ## Why there is nothing to resolve
 *
 * A cascade branch holds exactly ONE commit, authored by nobody:
 *
 *     447b508  aurixa-mission-control[bot]
 *              chore(aurixa): cascade 17 file(s) from prime@fc01e33
 *
 * The engine builds it by taking the clone's tree and overwriting whole files
 * with prime's blobs. There is no history in it and no second line of
 * development to reconcile — it is a statement, and a statement is restated
 * rather than merged.
 *
 * So the repair is to build it again against the branch as it now is. Rebuilt
 * that way the conflict cannot exist, by construction:
 *
 *     base_tree = the clone's CURRENT tree
 *     parent    = the clone's CURRENT head
 *     ⇒ the proposal's merge base IS the head, so it fast-forwards.
 *
 * There is never a side to pick, so there is never a wrong side to pick. That
 * is the property that makes it safe to run unattended across a fleet.
 *
 * ## The three things it will not do
 *
 * **It will not touch a branch a person has committed to.** The pull request
 * body asks operators to fix a held file in the same merge, and regeneration
 * force-overwrites the branch. `decideProposalRepair` checks first, and this
 * module calls the builder only on its say-so — a test pins that ordering,
 * because a rebuild that ran before the check would already have destroyed the
 * commit the check exists to protect.
 *
 * **It will not re-scope.** The rebuild delivers the prime SHA the proposal
 * already promised, not prime's latest. Upgrading the payload would save a CI
 * run and would make the cascade event describe something it never carried.
 *
 * **It will not loop.** Past `MAX_REPAIRS` it stops and asks for a person. A
 * clone whose branch is written faster than a cascade completes cannot be
 * settled by rebuilding harder, and a repair loop burns CI on every clone at
 * once.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import type { getAppOctokit } from "./github-app.server";
import { regenerateCloneProposal } from "./cascade-engine.server";
import { notifyOperators, writeAuditLog } from "./audit.server";
import {
  decideProposalRepair,
  describeRepair,
  type ProposalCommit,
  type RepairAct,
} from "./cascade/proposalRepair.pure";

type Db = SupabaseClient<Database>;

/** The audit action a repair records under. Also how attempts are counted. */
export const PROPOSAL_REPAIR_ACTION = "cascade_proposal_repair";

/** How far back a proposal's earlier repairs are counted. */
const ATTEMPT_WINDOW_HOURS = 6;

export type ProposalRepairOutcome = {
  clone: string;
  pr: number;
  act: RepairAct["act"];
  reason?: string;
  why: string;
};

/**
 * Look at one conflicted proposal and either rebuild it or explain why not.
 *
 * Returns null when there is nothing to do — the ordinary answer, including
 * while GitHub is still computing mergeability.
 */
export async function repairConflictedProposal(args: {
  supabase: Db;
  octokit: ReturnType<typeof getAppOctokit>;
  clone: { id: string; label: string; owner: string; repo: string };
  prNumber: number;
  /** GitHub's three-valued `mergeable`, straight from `pulls.get`. */
  mergeable: boolean | null | undefined;
  /** The cascade event this proposal belongs to. */
  eventId: string;
}): Promise<ProposalRepairOutcome | null> {
  const { supabase, octokit, clone, prNumber, mergeable, eventId } = args;

  // Cheap exit first: reading the branch's commits costs a request, and the
  // overwhelming majority of proposals are healthy or still being computed.
  if (mergeable !== false) return null;

  const { data: rawCommits } = await octokit.pulls.listCommits({
    owner: clone.owner,
    repo: clone.repo,
    pull_number: prNumber,
    per_page: 20,
  });
  const commits: ProposalCommit[] = (
    rawCommits as Array<{ commit: { message: string }; author: { login?: string } | null }>
  ).map((c) => ({ message: c.commit.message, authorLogin: c.author?.login ?? null }));

  const attempts = await countRepairs(supabase, clone.id, prNumber);
  const decision = decideProposalRepair({ mergeable, commits, attempts });

  if (decision.act === "none") return null;

  if (decision.act === "hold") {
    // Told once per reason, not once per five-minute tick. A held proposal
    // stays held until a person acts, and repeating it hourly is how an
    // operator learns to filter this notification out.
    const alreadyTold = await alreadyReported(supabase, clone.id, prNumber, decision.reason);
    if (!alreadyTold) {
      await writeAuditLog({
        action: PROPOSAL_REPAIR_ACTION,
        entityType: "clone",
        entityId: clone.id,
        metadata: { pr: prNumber, act: "hold", reason: decision.reason, why: decision.why },
      });
      await notifyOperators({
        kind: "drift_medium",
        severity: "warning",
        title: `${clone.label}: cascade PR #${prNumber} cannot be rebuilt`,
        body: decision.why,
        cloneId: clone.id,
        url: `/clones/${clone.id}`,
        metadata: { pr: prNumber, reason: decision.reason, source: PROPOSAL_REPAIR_ACTION },
      });
    }
    return {
      clone: clone.label,
      pr: prNumber,
      act: "hold",
      reason: decision.reason,
      why: decision.why,
    };
  }

  // The event says which prime SHA this proposal promised. A repair rebases it;
  // it never swaps the payload for prime's latest.
  const { data: event, error: eventErr } = await supabase
    .from("cascade_events")
    .select("source_sha, mode")
    .eq("id", eventId)
    .maybeSingle();
  if (eventErr) throw new Error(`Could not read cascade event ${eventId}: ${eventErr.message}`);
  if (!event?.source_sha) {
    // No source SHA is not a reason to guess one. Rebuilding at prime's head
    // would deliver a payload this event never described.
    return {
      clone: clone.label,
      pr: prNumber,
      act: "hold",
      reason: "attempts_exhausted",
      why: "This proposal's cascade event records no prime SHA, so there is nothing to rebuild it from.",
    };
  }

  // Written BEFORE the rebuild, so a rebuild that crashes still counts as an
  // attempt. Counting only successes is how a failing repair runs for ever.
  await writeAuditLog({
    action: PROPOSAL_REPAIR_ACTION,
    entityType: "clone",
    entityId: clone.id,
    metadata: {
      pr: prNumber,
      act: "regenerate",
      attempt: attempts + 1,
      source_sha: event.source_sha,
      event_id: eventId,
      why: decision.why,
    },
  });

  const patch = await regenerateCloneProposal({
    supabase,
    octokit,
    cloneId: clone.id,
    sourceSha: event.source_sha,
    mode: event.mode,
  });

  // The rebuilt proposal is the same pull request, so it is the same record.
  // Writing the fresh patch onto the existing row keeps one row per cascade
  // rather than accumulating a row per repair.
  const { error: writeErr } = await supabase
    .from("cascade_results")
    .update(patch)
    .eq("cascade_event_id", eventId)
    .eq("clone_id", clone.id);
  if (writeErr) {
    throw new Error(`Rebuilt PR #${prNumber} but could not record it: ${writeErr.message}`);
  }

  return {
    clone: clone.label,
    pr: prNumber,
    act: "regenerate",
    why: describeRepair(prNumber, decision),
  };
}

/** How many times this proposal has been rebuilt inside the window. */
async function countRepairs(supabase: Db, cloneId: string, prNumber: number): Promise<number> {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_HOURS * 3600_000).toISOString();
  const { data, error } = await supabase
    .from("audit_log")
    .select("metadata")
    .eq("action", PROPOSAL_REPAIR_ACTION)
    .eq("entity_id", cloneId)
    .gte("created_at", since)
    .limit(50);
  // A history that could not be READ is not an empty history. Reporting zero
  // attempts on a database fault is exactly how the loop guard stops guarding.
  if (error) throw new Error(`Could not read repair history: ${error.message}`);
  return (data ?? []).filter((r) => {
    const m = r.metadata as { pr?: unknown; act?: unknown } | null;
    return m?.pr === prNumber && m?.act === "regenerate";
  }).length;
}

/** Whether this exact refusal has already been raised for this proposal. */
async function alreadyReported(
  supabase: Db,
  cloneId: string,
  prNumber: number,
  reason: string,
): Promise<boolean> {
  const since = new Date(Date.now() - ATTEMPT_WINDOW_HOURS * 3600_000).toISOString();
  const { data, error } = await supabase
    .from("audit_log")
    .select("metadata")
    .eq("action", PROPOSAL_REPAIR_ACTION)
    .eq("entity_id", cloneId)
    .gte("created_at", since)
    .limit(50);
  // Erring towards "already told" on a failed read would silence a real
  // refusal, so an unreadable history means say it.
  if (error) return false;
  return (data ?? []).some((r) => {
    const m = r.metadata as { pr?: unknown; act?: unknown; reason?: unknown } | null;
    return m?.pr === prNumber && m?.act === "hold" && m?.reason === reason;
  });
}
