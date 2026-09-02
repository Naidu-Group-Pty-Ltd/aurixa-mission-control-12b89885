/**
 * Merge the cascade pull requests that have gone green — and make Mission
 * Control's record of every cascade agree with what GitHub actually did.
 *
 * ## Why the merging half has to exist
 *
 * `auto_merge` cannot merge at the moment it opens a pull request, and should
 * not try. Check runs appear asynchronously: `Vercel Preview Comments`
 * completes in the same second, while `verify` — install, typecheck, build and
 * ~19,000 tests — takes about seventeen minutes. A gate that reads the checks
 * once, immediately, sees either nothing at all or one fast green check.
 * `decideCascadeMerge` therefore refuses, correctly, and the engine leaves the
 * pull request open with the reason on it.
 *
 * GitHub's own auto-merge is the mechanism designed for that wait, and it
 * CANNOT BE ARMED on a repository with no required status checks — which is
 * every clone here, all with unprotected default branches. So without this the
 * honest gate turns into the old symptom by another route: pull requests
 * opened, nothing merged, `0 merged` for ever.
 *
 * ## Why the reconciling half has to exist
 *
 * A cascade result reached `pr_opened` and stopped there permanently. Nothing
 * ever looked at the pull request again. This drain merged it on GitHub and
 * wrote an audit row; a person merging one by hand wrote nothing at all.
 * Neither reached `cascade_results`, `cascade_events.summary` or `clones`.
 *
 * Measured on 30 Aug 2026: #66 and #67 were merged at 07:55 and 08:35. Both
 * rows still read `pr_opened`, both parent events still read `0 merged · 1
 * PRs`, and the clone still read `140 commits behind` with `last_synced_sha`
 * frozen on a commit from before either landed — which is not cosmetic, because
 * `runDriftRefresh` measures drift FROM that pointer, so an unadvanced pointer
 * makes a clone that is up to date report as permanently behind.
 *
 * So Mission Control said one thing and GitHub said another, in both
 * directions, with no mechanism anywhere that could have reconciled them.
 *
 * ## The rule
 *
 * **The pull request's own state is the truth, and it is READ rather than
 * remembered.** Not "what this drain did" — that misses every merge a person
 * performed, every merge that landed while this control plane was down, and
 * every proposal an operator closed. One `pulls.get` answers all of them.
 *
 * That is also why the work list is Mission Control's UNRECONCILED ROWS rather
 * than GitHub's open pull requests: a merged pull request is not open any more,
 * so a drain that only enumerates open ones can never discover it. GitHub's
 * open list is still read, on top, so a pull request this engine opened but
 * failed to record is still merged when it goes green.
 *
 * ## What it will and will not merge
 *
 * Only branches this engine names — `aurixa/cascade-…` — and only through
 * `decideCascadeMerge`, the same rule the engine uses, so there is one
 * definition of "green" rather than two that can drift.
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
import {
  cascadeEventStatus,
  countResults,
  durableSummary,
  parsePrNumber,
  parsePrRepo,
  reconcileResultToPr,
  summariseCascade,
  type PullRequestFacts,
} from "./cascade/prReconcile.pure";
import { summaryOwesReconcile } from "./cascade/syncExclusions.pure";
import { repairConflictedProposal } from "./cascadeProposalRepair.server";

type Db = SupabaseClient<Database>;

/** Branches the cascade engine creates. Nothing else is ever touched. */
export const CASCADE_BRANCH_PREFIX = "aurixa/cascade-";

/**
 * Distinct pull requests read per clone per run.
 *
 * The backlog this was built to clear is not small: on 30 Aug 2026 the fleet
 * carried 86 rows still reading `pr_opened`, every cascade this platform had
 * ever run. Reading them all in one pass would be one long request against a
 * 60-second cron timeout, so it drains over several runs instead — newest
 * first, because the rows an operator is looking at are the recent ones.
 */
const MAX_PRS_PER_RUN = 25;

export type MergeDrainOutcome =
  | { clone: string; pr: number; outcome: "merged"; sha: string | null }
  | { clone: string; pr: number; outcome: "held"; reason: string; why: string }
  | { clone: string; pr: number; outcome: "failed"; error: string }
  /** The proposal had gone stale and was rebuilt on the clone's current head. */
  | { clone: string; pr: number; outcome: "repaired"; why: string }
  /** The record was behind and has been brought forward. */
  | { clone: string; pr: number; outcome: "reconciled"; to: string; rows: number; why: string };

export type MergeDrainReport = {
  considered: number;
  /**
   * Rows whose pull request lives in a repository this clone no longer is.
   *
   * Skipped without an API call, and deliberately NOT a reason to file an
   * audit row: it is a constant, not an event. This clone was moved off a
   * personal fork and 48 rows still name it, so a drain that reported the
   * number every five minutes would say the same thing for ever.
   *
   * Their status is left ALONE rather than rewritten. Marking them `skipped`
   * would claim a person declined them; marking them `succeeded` would claim a
   * merge nobody can see. What is true is that the outcome is unknowable from
   * here, and inventing one to tidy a count is how a record stops being a
   * record.
   */
  foreignRepo: number;
  merged: number;
  /** Rows whose recorded state was wrong and has been corrected. */
  reconciled: number;
  /** Cascade events whose summary was recounted. */
  recounted: number;
  /** Clones whose commit pointer was moved forward. */
  advanced: number;
  /** Already-landed rows whose summary still contradicted itself. */
  tidied: number;
  /** Conflicted proposals rebuilt on the clone's current head. */
  repaired: number;
  held: Record<string, number>;
  failed: number;
  detail: MergeDrainOutcome[];
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type CloneRow = {
  id: string;
  name: string | null;
  github_owner: string;
  github_repo: string;
  default_branch: string | null;
};

type ResultRow = {
  id: string;
  clone_id: string;
  cascade_event_id: string;
  pr_url: string | null;
  diff_summary: string | null;
};

export async function drainCascadeMerges(
  supabase: Db,
  opts: { limitPerClone?: number } = {},
): Promise<MergeDrainReport> {
  const report: MergeDrainReport = {
    considered: 0,
    foreignRepo: 0,
    merged: 0,
    reconciled: 0,
    recounted: 0,
    advanced: 0,
    tidied: 0,
    repaired: 0,
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

  // Every row Mission Control still believes is an open proposal. This is the
  // work list, because a merged pull request is no longer open and a drain that
  // enumerated only open ones could never find it.
  const unreconciled = await supabase
    .from("cascade_results")
    .select("id, clone_id, cascade_event_id, pr_url, diff_summary")
    .eq("status", "pr_opened")
    .not("pr_url", "is", null)
    .order("created_at", { ascending: false });
  if (unreconciled.error) {
    throw new Error(`Could not read cascade results: ${unreconciled.error.message}`);
  }
  const rowsByClone = new Map<string, ResultRow[]>();
  for (const row of (unreconciled.data ?? []) as ResultRow[]) {
    const list = rowsByClone.get(row.clone_id);
    if (list) list.push(row);
    else rowsByClone.set(row.clone_id, [row]);
  }

  const octokit = getAppOctokit();
  /** Events whose counts may have moved, recounted once at the end. */
  const touchedEvents = new Set<string>();
  /** Clones where something merged, so their pointer is re-derived. */
  const advancedClones = new Set<string>();

  for (const raw of data ?? []) {
    const clone = raw as CloneRow & { github_owner: string | null; github_repo: string | null };
    if (!clone.github_owner || !clone.github_repo) continue;
    const label = clone.name ?? `${clone.github_owner}/${clone.github_repo}`;
    const owner = clone.github_owner;
    const repo = clone.github_repo;

    const rows = rowsByClone.get(clone.id) ?? [];
    // Pull request number → EVERY row that records it.
    //
    // Several rows share one pull request whenever `pr` mode moved a single
    // proposal forward across several prime commits — #55 carries eleven of
    // them, #62 eight — and all of them landed when it merged. So the pull
    // request is read ONCE and the answer applied to each, rather than eleven
    // identical requests for one fact.
    const rowsByPr = new Map<number, ResultRow[]>();
    for (const row of rows) {
      const n = parsePrNumber(row.pr_url);
      if (n === null) continue;
      // A row whose URL names a DIFFERENT repository cannot be reconciled from
      // this one, and must never be looked up by number here: this clone was
      // re-pointed from `lavan96/npc-client-dashboard` to the organisation's
      // own repo, and 48 historical rows still carry the old URL. Reading
      // `pull/42` in the new repository answers about a real, unrelated pull
      // request — a Dependabot one — and would stamp its outcome onto a cascade
      // that has nothing to do with it.
      const at = parsePrRepo(row.pr_url);
      if (!at || at.owner !== owner || at.repo !== repo) {
        report.foreignRepo += 1;
        continue;
      }
      const list = rowsByPr.get(n);
      if (list) list.push(row);
      else rowsByPr.set(n, [row]);
    }

    // GitHub's open cascade pull requests, on top of the rows above: one this
    // engine opened but failed to record still deserves to be merged.
    let openNumbers: number[] = [];
    try {
      const { data: prs } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        base: clone.default_branch || "main",
        per_page: opts.limitPerClone ?? 20,
      });
      openNumbers = (prs as Array<{ number: number; head: { ref: string } }>)
        .filter((p) => p.head.ref.startsWith(CASCADE_BRANCH_PREFIX))
        .map((p) => p.number);
    } catch (e) {
      // One unreachable repository must not stop the others, and must not stop
      // this clone's own recorded rows from being reconciled either.
      report.failed += 1;
      report.detail.push({ clone: label, pr: 0, outcome: "failed", error: msg(e) });
    }

    // Oldest first. Two proposals open at once carry overlapping trees, and
    // landing the newer one first would put the older one's content on top.
    // The cap is applied to the NEWEST, then the survivors sorted back into
    // merge order — so a backlog drains from the end an operator is looking at
    // while merges still happen in the safe order.
    const all = [...new Set([...rowsByPr.keys(), ...openNumbers])];
    const numbers = all
      .sort((a, b) => b - a)
      .slice(0, MAX_PRS_PER_RUN)
      .sort((a, b) => a - b);

    for (const number of numbers) {
      report.considered += 1;
      const rowsForPr = rowsByPr.get(number) ?? [];
      try {
        const outcome = await handleOne({
          supabase,
          octokit,
          owner,
          repo,
          number,
          rows: rowsForPr,
          label,
          cloneId: clone.id,
        });
        report.detail.push(outcome);
        if (outcome.outcome === "merged") {
          report.merged += 1;
          advancedClones.add(clone.id);
        } else if (outcome.outcome === "held") {
          report.held[outcome.reason] = (report.held[outcome.reason] ?? 0) + 1;
        } else if (outcome.outcome === "repaired") {
          report.repaired += 1;
        } else if (outcome.outcome === "reconciled") {
          report.reconciled += outcome.rows;
          if (outcome.to === "succeeded") advancedClones.add(clone.id);
        }
        for (const row of rowsForPr) touchedEvents.add(row.cascade_event_id);
      } catch (e) {
        report.failed += 1;
        report.detail.push({ clone: label, pr: number, outcome: "failed", error: msg(e) });
      }
    }
  }

  // Recount the events whose results moved, and move the pointers of the clones
  // where something landed. Both are DERIVED from the reconciled rows rather
  // than incremented as we go, so neither can drift and neither can regress —
  // and both repair a record that was already wrong before this ran.
  for (const eventId of touchedEvents) {
    if (await recountEvent(supabase, eventId)) report.recounted += 1;
  }
  for (const cloneId of advancedClones) {
    if (await advanceClone(supabase, cloneId)) report.advanced += 1;
  }
  report.tidied = await tidyLandedSummaries(supabase);

  return report;
}

/**
 * Rewrite a landed row whose summary still contradicts itself.
 *
 * The first reconciliation ran before the engine's own legacy reasons were
 * recognised, so 38 rows came out reading `Merged as 6eaaf5a. No check has
 * reported on this pull request — nothing has built this tree. …` — merged, and
 * quoting a stale check verdict as though it were live. They are `succeeded`
 * now, so they have left the work list above and nothing would ever look at
 * them again.
 *
 * No API call: a landed row already carries its merge SHA, and the only thing
 * wrong with it is text. It goes through `durableSummary` — the SAME rule, not
 * a second one written in SQL — and stops matching once it is clean, so this
 * costs one query on a settled fleet and writes nothing.
 */
async function tidyLandedSummaries(supabase: Db): Promise<number> {
  const { data, error } = await supabase
    .from("cascade_results")
    .select("id, commit_sha, diff_summary")
    .eq("status", "succeeded")
    .not("diff_summary", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  // Cosmetic work must never take the drain down with it.
  if (error) {
    console.error("[cascade-merge-drain] could not read landed summaries:", error.message);
    return 0;
  }

  let tidied = 0;
  for (const row of (data ?? []) as Array<{
    id: string;
    commit_sha: string | null;
    diff_summary: string | null;
  }>) {
    const detail = durableSummary(row.diff_summary);
    const wanted = `Merged${row.commit_sha ? ` as ${row.commit_sha}` : ""}.${detail ? ` ${detail}` : ""}`;
    if (wanted === (row.diff_summary ?? "").trim()) continue;
    const { error: writeErr } = await supabase
      .from("cascade_results")
      .update({ diff_summary: wanted })
      .eq("id", row.id);
    if (writeErr) {
      console.error(`[cascade-merge-drain] could not tidy result ${row.id}:`, writeErr.message);
      continue;
    }
    tidied += 1;
  }
  return tidied;
}

/**
 * Read one pull request, merge it if it is green, and bring its Mission Control
 * row into line with whatever is true afterwards.
 */
async function handleOne(args: {
  supabase: Db;
  octokit: ReturnType<typeof getAppOctokit>;
  owner: string;
  repo: string;
  number: number;
  /** Every cascade result recording this pull request. Often more than one. */
  rows: ResultRow[];
  label: string;
  cloneId: string;
}): Promise<MergeDrainOutcome> {
  const { supabase, octokit, owner, repo, number, rows, label, cloneId } = args;

  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: number });
  let facts: PullRequestFacts = {
    state: pr.state === "closed" ? "closed" : "open",
    merged: Boolean(pr.merged),
    mergeCommitSha: pr.merge_commit_sha ?? null,
  };
  let mergedNow = false;
  let reason = "";

  // A proposal that cannot merge is REBUILT, not resolved and never retried.
  //
  // `pulls.merge` on a conflicted head answers 405, which lands in the catch
  // above as `failed` — and the drain comes back five minutes later and does it
  // again, for ever, filing an audit row each time and colouring the fleet red
  // over something no retry can fix.
  //
  // So a conflict hands off to `repairConflictedProposal`, which rebuilds the
  // proposal on the clone's current head through the engine's own construction.
  // That removes the conflict by construction rather than resolving it — see
  // `cascade/proposalRepair.pure.ts` for why a cascade branch has nothing in it
  // worth merging, and for the three things the repair refuses to do.
  //
  // This reads `mergeable` ONLY to refuse and to repair. It is never
  // permission: `clean` is also what a pull request with no checks at all
  // reports, so believing it would reopen the `no_checks` hole exactly where
  // nobody is watching. Every merge below still goes through
  // `decideCascadeMerge`.
  //
  // `null` is not `false`. GitHub computes mergeability asynchronously and
  // answers null until it has, so an unknown state falls through to the
  // ordinary path rather than being read as a conflict.
  if (facts.state === "open" && pr.mergeable === false) {
    const eventId = rows[0]?.cascade_event_id ?? null;
    if (eventId) {
      const repair = await repairConflictedProposal({
        supabase,
        octokit,
        clone: { id: cloneId, label, owner, repo },
        prNumber: number,
        mergeable: pr.mergeable,
        eventId,
      });
      if (repair?.act === "regenerate") {
        return {
          clone: label,
          pr: number,
          outcome: "repaired",
          why: repair.why,
        };
      }
      if (repair?.act === "hold") {
        return {
          clone: label,
          pr: number,
          outcome: "held",
          reason: repair.reason ?? "unrepairable",
          why: repair.why,
        };
      }
    }
    // No event to rebuild from — the proposal exists on GitHub and Mission
    // Control has no record of which cascade opened it, so there is nothing to
    // rebuild it from. Say so rather than retrying a merge that cannot succeed.
    const why =
      "This proposal conflicts with the clone's default branch, and Mission Control has no " +
      "cascade record for it to rebuild from. It has to be closed or resolved by hand.";
    await writeReconciliation(supabase, rows, facts, why);
    return { clone: label, pr: number, outcome: "held", reason: "conflicted", why };
  }

  if (facts.state === "open") {
    let verdict: ReturnType<typeof decideCascadeMerge> | null = null;
    try {
      // Checks are read on the pull request's CURRENT head, so a push landing
      // between the read and the merge invalidates nothing silently — the merge
      // below is by pull number and GitHub refuses a stale one.
      const { data: checkData } = await octokit.checks.listForRef({
        owner,
        repo,
        ref: pr.head.sha,
      });
      verdict = decideCascadeMerge(
        (checkData.check_runs ?? []).map((c) => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
        })),
        REQUIRED_CHECKS,
      );
    } catch (e) {
      // "I cannot see CI" is not "the cascade failed" — it is a missing
      // read-only permission, and the correct response to an unreadable signal
      // is to leave the pull request alone and say so.
      if (!checksUnreadable(e)) throw e;
      reason = CHECKS_PERMISSION_REMEDY;
      await writeReconciliation(supabase, rows, facts, reason);
      return {
        clone: label,
        pr: number,
        outcome: "held",
        reason: "checks_unreadable",
        why: reason,
      };
    }

    if (!verdict.merge) {
      await writeReconciliation(supabase, rows, facts, verdict.why);
      return {
        clone: label,
        pr: number,
        outcome: "held",
        reason: verdict.reason,
        why: verdict.why,
      };
    }

    // MERGE, never SQUASH — a squash rewrites the cascade commit naming the
    // prime SHA it came from, which is the one durable record of what a clone
    // has received.
    const { data: merged } = await octokit.pulls.merge({
      owner,
      repo,
      pull_number: number,
      merge_method: "merge",
    });
    facts = { state: "closed", merged: true, mergeCommitSha: merged.sha ?? null };
    mergedNow = true;
  }

  const applied = await writeReconciliation(supabase, rows, facts, reason);

  if (mergedNow) {
    return {
      clone: label,
      pr: number,
      outcome: "merged",
      sha: facts.mergeCommitSha?.slice(0, 7) ?? null,
    };
  }
  if (applied) {
    // The record was behind — a merge somebody else performed, or a proposal
    // somebody closed — and has been brought forward.
    return {
      clone: label,
      pr: number,
      outcome: "reconciled",
      to: applied.status,
      rows: applied.rows,
      why: applied.why,
    };
  }
  return {
    clone: label,
    pr: number,
    outcome: "held",
    reason: "already_recorded",
    why: "Mission Control's record already matches this pull request.",
  };
}

/**
 * Write one row's reconciliation, if there is a row and if anything changed.
 *
 * Returns what was applied, or null when nothing needed writing — which is the
 * ordinary case for a pull request that is open, unchanged, and being looked at
 * every five minutes.
 */
async function writeReconciliation(
  supabase: Db,
  rows: ResultRow[],
  facts: PullRequestFacts,
  openReason: string,
): Promise<{ status: string; rows: number; why: string } | null> {
  let applied: { status: string; why: string } | null = null;
  let written = 0;

  // Every row that recorded this pull request, not just one. When `pr` mode
  // moved a single proposal forward across several prime commits, ALL of those
  // cascades landed the moment it merged — leaving the rest at `pr_opened`
  // would replace one stale record with ten.
  for (const row of rows) {
    const decision = reconcileResultToPr({
      pr: facts,
      currentSummary: row.diff_summary,
      openReason,
    });
    if (!decision.changed) continue;

    const { error } = await supabase
      .from("cascade_results")
      .update({
        status: decision.status,
        diff_summary: decision.diffSummary,
        ...(decision.commitSha ? { commit_sha: decision.commitSha } : {}),
        ...(decision.status === "succeeded" ? { completed_at: new Date().toISOString() } : {}),
      })
      .eq("id", row.id);
    // A reconciliation that silently failed to write leaves exactly the stale
    // record this exists to remove, so it is raised rather than swallowed.
    if (error) throw new Error(`Could not reconcile result ${row.id}: ${error.message}`);
    written += 1;
    applied = { status: decision.status, why: decision.diffSummary };
  }

  return applied ? { ...applied, rows: written } : null;
}

/**
 * Recompose a cascade event's summary and status from its results as they now
 * stand.
 *
 * Derived, never incremented: `0 merged · 1 PRs` was frozen at the moment the
 * run finished and had no way to learn that the pull request later landed.
 */
async function recountEvent(supabase: Db, eventId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("cascade_results")
    .select("status, diff_summary")
    .eq("cascade_event_id", eventId);
  if (error) throw new Error(`Could not recount event ${eventId}: ${error.message}`);

  const counts = countResults(
    (data ?? []) as Array<{ status: string | null; diff_summary: string | null }>,
    summaryOwesReconcile,
  );
  const summary = summariseCascade(counts);
  const status = cascadeEventStatus(counts);

  const current = await supabase
    .from("cascade_events")
    .select("summary, status, worker_started_at, worker_finished_at")
    .eq("id", eventId)
    .maybeSingle();
  if (current.error) throw new Error(`Could not read event ${eventId}: ${current.error.message}`);
  // Never over an event that is still being executed. The engine writes the
  // event's status and summary itself when its pass ends; a recount in the
  // middle of that pass — from a result row that has already moved while its
  // siblings are still `queued` or `pushing` — rewrites a `running` event to
  // `completed`. Measured 2 Sep 2026 14:10: the drain had claimed 795d73d2
  // and was pushing preflight-property-group when this recount marked the
  // event `completed`; the invocation was then cut at 60 s, so the engine's
  // own write never came, the clone's row sat at `pushing` under a finished
  // event, and neither reclaim rule could see it. A pass is finished when
  // the engine says so, not when the counts happen to add up.
  if (current.data?.status === "running" || current.data?.status === "pending") return false;
  if (current.data?.worker_started_at && !current.data?.worker_finished_at) return false;
  if (current.data?.summary === summary && current.data?.status === status) return false;

  const { error: writeErr } = await supabase
    .from("cascade_events")
    .update({ summary, status })
    .eq("id", eventId);
  if (writeErr) throw new Error(`Could not update event ${eventId}: ${writeErr.message}`);
  return true;
}

/**
 * Move a clone's commit pointer to the newest prime SHA it has actually
 * received, and ask its deployment to rebuild.
 *
 * `last_synced_sha` is not a cosmetic field. `runDriftRefresh` measures
 * `commits_behind` FROM it, so a pointer that never advances makes a clone that
 * is up to date report as permanently behind — 140 commits, on a clone that had
 * merged two cascades in the preceding hour.
 *
 * It is DERIVED from the clone's own reconciled history rather than set from
 * whatever merged in this pass, so two pull requests landing out of order
 * cannot walk the pointer backwards.
 */
async function advanceClone(supabase: Db, cloneId: string): Promise<boolean> {
  // Ordered by this table's OWN column and re-sorted below by the event's.
  // Ordering on a referenced table is a PostgREST syntax that varies by client
  // version, and a query that errors here would take the whole drain down for
  // a tidiness gain — the JS sort is what actually decides.
  const { data, error } = await supabase
    .from("cascade_results")
    .select("cascade_event_id, cascade_events!inner(source_sha, created_at)")
    .eq("clone_id", cloneId)
    .eq("status", "succeeded")
    // The row's own creation, not `completed_at`: a bulk reconciliation stamps
    // every row it repairs with the same `completed_at`, which would make that
    // ordering meaningless exactly when it matters most.
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Could not read clone history ${cloneId}: ${error.message}`);

  type Joined = { cascade_events: { source_sha: string | null; created_at: string } | null };
  const newest = ((data ?? []) as unknown as Joined[])
    .map((r) => r.cascade_events)
    .filter((e): e is { source_sha: string | null; created_at: string } => Boolean(e?.source_sha))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  if (!newest?.source_sha) return false;

  const clone = await supabase
    .from("clones")
    .select("last_synced_sha")
    .eq("id", cloneId)
    .maybeSingle();
  if (clone.error) throw new Error(`Could not read clone ${cloneId}: ${clone.error.message}`);
  if (clone.data?.last_synced_sha === newest.source_sha) return false;
  // What the clone held before this merge, kept before the update moves it.
  const previousSha = clone.data?.last_synced_sha ?? null;

  const { error: writeErr } = await supabase
    .from("clones")
    .update({
      last_synced_sha: newest.source_sha,
      sync_status: "in_sync",
      commits_behind: 0,
      last_cascade_at: new Date().toISOString(),
    })
    .eq("id", cloneId);
  if (writeErr) throw new Error(`Could not advance clone ${cloneId}: ${writeErr.message}`);

  // Code reached the clone's default branch, so what serves it is now stale.
  //
  // The engine already does this on its own `succeeded` path, and its comment
  // explains why nothing else will: Vercel rebuilds on push only where its
  // GitHub App is installed, Mission Control forks clones through its own App
  // and never installs Vercel's, so on this fleet nothing else asks. A merge
  // performed HERE reached `main` exactly as a direct push would, and until now
  // nothing rebuilt after one.
  //
  // Never throws — a pointer that moved correctly must not report as failed
  // because a hosting row could not be updated.
  try {
    const { requestRedeployAfterPush } = await import("@/server/hosting/redeploy.server");
    await requestRedeployAfterPush({
      cloneId,
      reason: "cascade merge drain",
      sha: newest.source_sha,
    });
  } catch (e) {
    console.error("[cascade-merge-drain] redeploy request failed:", e);
  }

  // And the backend half, for the same reason and on the same terms as the
  // engine's own succeeded path. A pull request merged HERE reached `main`
  // exactly as a direct push would, so the edge functions and migrations it
  // carried are live in the repository and absent from the project.
  //
  // Never throws: a pointer that moved correctly must not report as failed
  // because a repair row could not be written.
  try {
    const { requestBackendSyncAfterCascade } = await import("@/server/backendSync.server");
    await requestBackendSyncAfterCascade({
      cloneId,
      reason: "cascade merge drain",
      fromSha: previousSha,
      toSha: newest.source_sha,
    });
  } catch (e) {
    console.error("[cascade-merge-drain] backend sync request failed:", e);
  }
  return true;
}
