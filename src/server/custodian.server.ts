/**
 * Re-run the work; never change the verdict.
 *
 * `custodian.pure.ts` holds the permission and the decisions. This gathers the
 * facts, asks it, and — for the one act that is switched on — performs.
 *
 * ## Four rules
 *
 * **The permission is asked before anything is read.** A blockage owned by a
 * person is refused and recorded before the pass spends a single call on it,
 * so a `ci_red` costs nothing and can never be halfway acted on.
 *
 * **It never clears its own blockage.** The ledger's next pass observes
 * whether the condition is gone and clears it then. A custodian that closed
 * what it had just repaired would make a repair that did not work look exactly
 * like one that did — the auditor's separation of actor from observer, one
 * level down.
 *
 * **Every act is written down, including the ones not taken.** A custodian
 * whose refusals were silent would be indistinguishable from one that was not
 * running.
 *
 * **It reads back before it writes.** The retarget verifies that the proposal
 * it is about to point at actually exists on the clone's repository, because a
 * repair that cannot be checked is a guess with a commit message.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { getAppOctokit } from "./github-app.server";
import {
  ACT_POLICY,
  MAX_ACTS_PER_TICK,
  MAX_ROWS_PER_ACT,
  decideRetarget,
  mayCustodianAct,
  type CustodialActName,
} from "./cascade/custodian.pure";
import type { BlockageClass, BlockageOwner } from "./cascade/blockageTaxonomy.pure";
import { planRequeue } from "./cascade/requeueDroppedClone.pure";
type CascadeModeValue = Database["public"]["Enums"]["cascade_mode"] | null;

type Db = SupabaseClient<Database>;

/** Performed acts of one kind, for one clone, in one day. */
export const MAX_PERFORMED_PER_DAY = 3;

export type CustodianOutcome = {
  clone: string;
  cls: BlockageClass;
  act: CustodialActName | null;
  outcome: "performed" | "would_perform" | "refused" | "failed";
  rows: number;
  detail: string;
};

export type CustodianReport = {
  blockages: number;
  performed: number;
  wouldPerform: number;
  refused: number;
  failed: number;
  dryRun: boolean;
  detail: CustodianOutcome[];
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runCustodian(
  supabase: Db,
  opts: { dryRun?: boolean } = {},
): Promise<CustodianReport> {
  const dryRun = opts.dryRun ?? false;
  const report: CustodianReport = {
    blockages: 0,
    performed: 0,
    wouldPerform: 0,
    refused: 0,
    failed: 0,
    dryRun,
    detail: [],
  };

  const { data, error } = await supabase
    .from("clone_sync_blockages")
    // `fingerprint` carries WHICH delivery a blockage is about —
    // `partial_clone_dropped:<eventId>` — which is what a repair for it has
    // to act on. It was selected by nothing, so no act could ever have been
    // scoped to the thing it was raised for.
    .select("id, clone_id, class, owner, self_heals, fingerprint, detail, first_seen_at")
    .is("cleared_at", null)
    .order("first_seen_at", { ascending: true });
  // An open set that could not be READ is not an empty one. Reporting "nothing
  // to repair" on a database fault is how a standing blockage goes unnoticed
  // by the thing built to notice it.
  if (error) throw new Error(`Could not read open blockages: ${error.message}`);
  const open = (data ?? []) as Array<{
    id: string;
    clone_id: string;
    class: string;
    owner: string;
    self_heals: boolean;
    fingerprint: string;
    detail: string;
    first_seen_at: string;
  }>;
  if (open.length === 0) return report;

  const clonesRes = await supabase
    .from("clones")
    .select("id, name, repo_full_name, github_owner, github_repo");
  if (clonesRes.error) throw new Error(`Could not list clones: ${clonesRes.error.message}`);
  const cloneById = new Map(
    (
      (clonesRes.data ?? []) as Array<{
        id: string;
        name: string | null;
        repo_full_name: string | null;
        github_owner: string | null;
        github_repo: string | null;
      }>
    ).map((c) => [c.id, c]),
  );

  let acted = 0;

  for (const b of open) {
    report.blockages += 1;
    const clone = cloneById.get(b.clone_id);
    const label = clone?.name ?? b.clone_id;

    /*
      THE PERMISSION IS ASKED FIRST, BEFORE ANYTHING IS READ.

      A blockage a person owns costs nothing and can never be halfway acted
      on, because the pass stops here rather than after gathering evidence it
      would have had to throw away.
    */
    const verdict = mayCustodianAct({
      cls: b.class as BlockageClass,
      owner: b.owner as BlockageOwner,
      selfHeals: b.self_heals,
    });

    if (!verdict.may) {
      const outcome = verdict.reportOnly ? "would_perform" : "refused";
      await record(supabase, {
        cloneId: b.clone_id,
        blockageId: b.id,
        cls: b.class,
        act: actNameFor(b.class as BlockageClass) ?? "none",
        outcome,
        rows: 0,
        detail: verdict.why,
        dryRun,
      });
      if (outcome === "would_perform") report.wouldPerform += 1;
      else report.refused += 1;
      report.detail.push({
        clone: label,
        cls: b.class as BlockageClass,
        act: actNameFor(b.class as BlockageClass),
        outcome,
        rows: 0,
        detail: verdict.why,
      });
      continue;
    }

    // Bounded per tick. A custodian that could act on the whole fleet in one
    // pass is one whose first bad day is also its worst.
    if (acted >= MAX_ACTS_PER_TICK) {
      report.detail.push({
        clone: label,
        cls: b.class as BlockageClass,
        act: verdict.act,
        outcome: "would_perform",
        rows: 0,
        detail: `Held: ${MAX_ACTS_PER_TICK} act(s) already taken this pass.`,
      });
      report.wouldPerform += 1;
      continue;
    }

    // And per clone per day, counted from the acts already recorded.
    const spent = await performedToday(supabase, b.clone_id, verdict.act);
    if (spent >= MAX_PERFORMED_PER_DAY) {
      const why = `Held: '${verdict.act}' has already run ${spent} time(s) for ${label} today.`;
      await record(supabase, {
        cloneId: b.clone_id,
        blockageId: b.id,
        cls: b.class,
        act: verdict.act,
        outcome: "refused",
        rows: 0,
        detail: why,
        dryRun,
      });
      report.refused += 1;
      report.detail.push({
        clone: label,
        cls: b.class as BlockageClass,
        act: verdict.act,
        outcome: "refused",
        rows: 0,
        detail: why,
      });
      continue;
    }

    acted += 1;
    let result: {
      outcome: CustodianOutcome["outcome"];
      rows: number;
      detail: string;
      reversal?: Json;
    };
    try {
      if (verdict.act === "retarget_proposal_urls") {
        result = await retargetProposalUrls(supabase, {
          cloneId: b.clone_id,
          label,
          currentRepo:
            clone?.repo_full_name ??
            (clone?.github_owner && clone?.github_repo
              ? `${clone.github_owner}/${clone.github_repo}`
              : null),
          dryRun,
        });
      } else if (verdict.act === "requeue_dropped_clone") {
        result = await requeueDroppedClone(supabase, {
          cloneId: b.clone_id,
          label,
          fingerprint: b.fingerprint,
          dryRun,
        });
      } else {
        // Permitted, enabled, and nothing implements it. Reported rather than
        // silently skipped: an act in the catalogue that does nothing is the
        // dead-control defect this repository names repeatedly.
        result = {
          outcome: "refused",
          rows: 0,
          detail: `'${verdict.act}' is enabled and has no implementation in this build.`,
        };
      }
    } catch (e) {
      result = { outcome: "failed", rows: 0, detail: msg(e) };
    }

    await record(supabase, {
      cloneId: b.clone_id,
      blockageId: b.id,
      cls: b.class,
      act: verdict.act,
      outcome: result.outcome,
      rows: result.rows,
      detail: result.detail,
      reversal: result.reversal,
      dryRun,
    });

    if (result.outcome === "performed") report.performed += 1;
    else if (result.outcome === "would_perform") report.wouldPerform += 1;
    else if (result.outcome === "failed") report.failed += 1;
    else report.refused += 1;

    report.detail.push({
      clone: label,
      cls: b.class as BlockageClass,
      act: verdict.act,
      outcome: result.outcome,
      rows: result.rows,
      detail: result.detail,
    });

    /*
      AND IT NEVER CLEARS ITS OWN BLOCKAGE.

      The ledger's next pass observes whether the condition is gone. A
      custodian that closed what it had just repaired would make a repair that
      did not work look exactly like one that did.
    */
  }

  return report;
}

/**
 * Point proposal records at the repository this clone actually has.
 *
 * Measured 18 Sep 2026: 43 rows named `lavan96/npc-client-dashboard` while the
 * clone's record read `Naidu-Group-Pty-Ltd/npc-client-dashboard`. The
 * repository had been transferred, which GitHub performs without renumbering —
 * pull request 27 is still the cascade this platform opened, merged on
 * 26 August, and 42 is the one proposal that 31 of those rows all track.
 *
 * It rewrites a URL and settles nothing. Whether each proposal merged, closed
 * or is still open is read from GitHub afterwards by the merge drain's
 * reconciler, which is the one implementation of that question — so this hands
 * the rows back to the machinery rather than doing its job.
 */
/**
 * Re-offer a clone's part of a delivery that landed for everybody else.
 *
 * The judgement is `planRequeue` in `cascade/requeueDroppedClone.pure.ts`,
 * which also carries why this mints a NEW scoped delivery rather than reviving
 * the settled one. This half does the reading, and then the two inserts.
 *
 * Still `enabled: false` in `ACT_POLICY`. That is deliberate and it is not the
 * same as unimplemented: pushing a tenant's code is an outward-facing act and
 * turning it on is an operator's decision, the way `retarget_proposal_urls`
 * was turned on by one. What changes here is that the decision is now a
 * one-line flip against a built, tested act instead of a flip against an else
 * branch that answers "no implementation in this build" — which is what
 * `selfHeals: true` had been promising for this class all along.
 */
async function requeueDroppedClone(
  supabase: Db,
  args: { cloneId: string; label: string; fingerprint: string; dryRun: boolean },
): Promise<{
  outcome: CustodianOutcome["outcome"];
  rows: number;
  detail: string;
  reversal?: Json;
}> {
  const { cloneId, label, fingerprint, dryRun } = args;

  // The blockage's fingerprint is `partial_clone_dropped:<eventId>` — the
  // taxonomy composes it so the row discharges itself when that event stops
  // being partial. Read rather than re-derived: one spelling of the identity.
  const sourceEventId = fingerprint.includes(":")
    ? fingerprint.slice(fingerprint.indexOf(":") + 1)
    : "";
  if (!sourceEventId) {
    return {
      outcome: "refused",
      rows: 0,
      detail: `Could not read which delivery dropped ${label} from the blockage fingerprint.`,
    };
  }

  const source = await supabase
    .from("cascade_events")
    .select("id, mode")
    .eq("id", sourceEventId)
    .maybeSingle();

  // A live delivery is any event not yet settled that carries a queued row for
  // this clone. Asked of the RESULT rows rather than the events, because that
  // is what decides whether a pass will actually reach this clone.
  const live = await supabase
    .from("cascade_results")
    .select("id, cascade_events!inner(status)")
    .eq("clone_id", cloneId)
    .eq("status", "queued")
    .in("cascade_events.status", ["pending", "running"])
    .limit(1);

  const prior = await supabase
    .from("cascade_events")
    .select("id")
    .contains("scope_filter", { retry_of: sourceEventId, requeue: true })
    .limit(1);

  const plan = planRequeue({
    sourceEventId,
    sourceMode: source.error ? null : ((source.data?.mode ?? null) as CascadeModeValue),
    cloneId,
    hasLiveDelivery: live.error ? null : (live.data ?? []).length > 0,
    alreadyRequeued: prior.error ? null : (prior.data ?? []).length > 0,
  });

  if (!plan.mint) return { outcome: "refused", rows: 0, detail: plan.why };
  if (dryRun) return { outcome: "would_perform", rows: 1, detail: `${plan.why} (dry run)` };

  const { data: ev, error: evError } = await supabase
    .from("cascade_events")
    .insert(plan.event)
    .select("id")
    .single();
  if (evError || !ev) {
    throw new Error(`Could not mint the re-queued delivery: ${evError?.message ?? "no row"}`);
  }

  // ARMED IN THE SAME ACT.
  //
  // An event with no result row is one `executeCascade` holds and re-holds
  // for want of something to do — the "claimed before any result row was
  // armed" branch. A delivery that cannot be armed is not a repair.
  const { error: rowError } = await supabase
    .from("cascade_results")
    .insert({ cascade_event_id: ev.id, clone_id: cloneId, status: "queued" });
  if (rowError) {
    throw new Error(`Minted ${ev.id} but could not arm it: ${rowError.message}`);
  }

  return {
    outcome: "performed",
    rows: 1,
    detail: `${plan.why} Delivery ${ev.id.slice(0, 8)} queued for ${label}.`,
    // Undoing a re-queue is deleting the delivery it minted, and only while
    // nothing has claimed it. Recorded so the reversal is a fact rather than a
    // reconstruction.
    reversal: { act: "requeue_dropped_clone", cascade_event_id: ev.id } as Json,
  };
}

async function retargetProposalUrls(
  supabase: Db,
  args: { cloneId: string; label: string; currentRepo: string | null; dryRun: boolean },
): Promise<{
  outcome: CustodianOutcome["outcome"];
  rows: number;
  detail: string;
  reversal?: Json;
}> {
  const { cloneId, label, currentRepo, dryRun } = args;

  const { data, error } = await supabase
    .from("cascade_results")
    .select("id, pr_url")
    .eq("clone_id", cloneId)
    .eq("status", "pr_opened")
    .not("pr_url", "is", null)
    .limit(MAX_ROWS_PER_ACT);
  if (error) throw new Error(`Could not read proposal records: ${error.message}`);

  const rows = (data ?? []) as Array<{ id: string; pr_url: string | null }>;
  const moves: Array<{ id: string; from: string; to: string; prNumber: number; repo: string }> = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const d = decideRetarget({ prUrl: row.pr_url, currentRepo });
    if (!d.retarget) {
      skipped.push(d.why);
      continue;
    }
    moves.push({ id: row.id, from: d.from, to: d.to, prNumber: d.prNumber, repo: d.repo });
  }

  if (moves.length === 0) {
    return {
      outcome: "refused",
      rows: 0,
      detail: `Nothing to repoint on ${label}. ${skipped[0] ?? "No proposal records were readable."}`,
    };
  }

  /*
    READ BACK BEFORE WRITING.

    A repair that cannot be checked is a guess with a commit message. One
    `pulls.get` per DISTINCT number — 12 for the 43 live rows — asks whether
    the proposal this is about to name actually exists on the clone's
    repository. A number that does not answer is left exactly as it was: a
    wrong record is better than a confidently wrong one.
  */
  const octokit = getAppOctokit();
  const distinct = [...new Map(moves.map((m) => [`${m.repo}#${m.prNumber}`, m])).values()];
  const verified = new Set<string>();
  const unverified: string[] = [];
  for (const m of distinct) {
    const [owner, repo] = m.repo.split("/");
    try {
      await octokit.pulls.get({ owner, repo, pull_number: m.prNumber });
      verified.add(`${m.repo}#${m.prNumber}`);
    } catch (e) {
      unverified.push(`#${m.prNumber} (${msg(e)})`);
    }
  }

  const writable = moves.filter((m) => verified.has(`${m.repo}#${m.prNumber}`));
  const note =
    `${writable.length} of ${moves.length} record(s) on ${label} repoint to ` +
    `${currentRepo}, across ${verified.size} verified proposal(s)` +
    (unverified.length > 0 ? `; left alone: ${unverified.join(", ")}` : "") +
    (skipped.length > 0 ? `; ${skipped.length} record(s) needed no change` : "");

  if (writable.length === 0) {
    return { outcome: "refused", rows: 0, detail: `Nothing verified. ${note}` };
  }
  if (dryRun) {
    return { outcome: "would_perform", rows: writable.length, detail: note };
  }

  for (const m of writable) {
    const { error: writeErr } = await supabase
      .from("cascade_results")
      .update({ pr_url: m.to })
      .eq("id", m.id)
      // The value it was when this decided. A row something else moved in
      // between is left to whatever moved it.
      .eq("pr_url", m.from);
    if (writeErr) throw new Error(`Could not repoint ${m.id}: ${writeErr.message}`);
  }

  return {
    outcome: "performed",
    rows: writable.length,
    detail: note,
    reversal: {
      table: "cascade_results",
      column: "pr_url",
      rows: writable.map((m) => ({ id: m.id, before: m.from, after: m.to })),
    } as unknown as Json,
  };
}

function actNameFor(cls: BlockageClass): CustodialActName | null {
  const policy = ACT_POLICY[cls];
  return policy && policy.kind === "act" ? policy.act : null;
}

/** Performed acts of this kind for this clone since midnight UTC. */
async function performedToday(supabase: Db, cloneId: string, act: string): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from("clone_custodial_acts")
    .select("id", { count: "exact", head: true })
    .eq("clone_id", cloneId)
    .eq("act", act)
    .eq("outcome", "performed")
    .gte("created_at", since.toISOString());
  // A cap that could not be READ is treated as spent. Failing open here would
  // remove the only bound on how often this writes.
  if (error) return MAX_PERFORMED_PER_DAY;
  return count ?? 0;
}

async function record(
  supabase: Db,
  row: {
    cloneId: string;
    blockageId: string | null;
    cls: string;
    act: string;
    outcome: CustodianOutcome["outcome"];
    rows: number;
    detail: string;
    reversal?: Json;
    dryRun: boolean;
  },
): Promise<void> {
  const { error } = await supabase.from("clone_custodial_acts").insert({
    clone_id: row.cloneId,
    blockage_id: row.blockageId,
    class: row.cls,
    act: row.act,
    outcome: row.outcome,
    rows_affected: row.rows,
    detail: row.detail,
    reversal: row.reversal ?? null,
    dry_run: row.dryRun,
  });
  // An act that happened and was not recorded is one nobody can reverse, which
  // is the one thing this table exists to prevent.
  if (error) throw new Error(`Could not record custodial act: ${error.message}`);
}
