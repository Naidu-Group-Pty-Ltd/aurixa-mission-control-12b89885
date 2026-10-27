/**
 * The convergence auditor: ask the trees, write down the answer, act on
 * nothing.
 *
 * ## What it is for
 *
 * `CASCADE_PIPELINE_HEALTH.md` has the argument. The short form: every reading
 * the platform has of "is this clone in sync" is derived from the ledger the
 * actor wrote, so a wrong actor produces a reading wrong in the same
 * direction. This reads the two repositories instead.
 *
 * ## What it costs
 *
 * Two `listTreeEntries` calls per clone — six for today's fleet — every
 * fifteen minutes. Twenty-four an hour against an installation window of
 * 5,000, and it asks `decideSpend` at the SCAN floor first, so it yields to
 * the cascade exactly as `held-file-drift` and `drift-refresh` do. No blob is
 * ever fetched: a blob SHA is a hash of the content, which is the whole reason
 * a mirror cascade can afford to compare a tree of several thousand files.
 *
 * ## Four rules
 *
 * **It writes nothing it measures.** Not `cascade_events`, not
 * `cascade_results`, not `clones`. An auditor that could move the pointer it
 * audits is not an auditor, and `convergenceAudit.contract.test.ts` asserts
 * the absence by source rather than by reading the code and trusting it.
 *
 * **It reads through the engine's own partition.** `partitionCascadePaths`,
 * against the clone's own `clone_sync_exclusions`, fail-closed through
 * `requireExclusions`. Two implementations of "what the cascade owes" is how
 * the auditor and the actor would come to agree on nothing, and this module's
 * entire value is being the independent check on the other one.
 *
 * **A failed read is `unknown`, never `converged`.** One unreachable
 * repository does not blind the sweep to the rest of the fleet, and it does
 * not report that clone as healthy either. Nothing here writes to a
 * repository, so there is no half-done state to unwind.
 *
 * **It measures; it never repairs and, for now, never speaks.** Step 1 of the
 * shipping order writes observations only. The escalation that replaces
 * `drift_high` reads this table and arrives in its own change, once a week of
 * observations has shown the reading agrees with reality.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { getAppOctokit, listTreeEntries, type RepoRef } from "./github-app.server";
import {
  judgeConvergence,
  measureConvergence,
  owedSample,
  type ConvergenceMeasurement,
  type ConvergenceState,
  type PriorObservation,
} from "./cascade/convergence.pure";
import { requireExclusions, type SyncExclusion } from "./cascade/syncExclusions.pure";

type Db = SupabaseClient<Database>;

/** Fallback when `prime_config.convergence_slo_minutes` is unset. */
export const DEFAULT_CONVERGENCE_SLO_MINUTES = 90;

/**
 * How long an observation is kept.
 *
 * The series is the point — step 1 runs this beside the existing signals and
 * compares — so it is kept generously and pruned rather than sampled. Three
 * clones every fifteen minutes is 288 rows a day.
 */
export const OBSERVATION_RETENTION_DAYS = 30;

export type CloneConvergenceOutcome = {
  clone: string;
  state: ConvergenceState;
  owed: number;
  /**
   * Differing paths the engine composes for this clone, counted apart and
   * never owed (`measureConvergence`). Carried here because the observation
   * table has no column for it and no JSON column to hold one; the
   * observation's own `why` says it in words.
   */
  reconciled: number;
  /**
   * True when the auditor declined to measure this clone BY DESIGN — it
   * measures mirrors, and this is not one. Its reading is `unknown` like a
   * failed read, and never converged; it differs only in being the same
   * standing fact on every tick rather than news.
   */
  outOfScope: boolean;
  why: string;
};

export type ConvergenceAuditReport = {
  clones: number;
  converged: number;
  delivering: number;
  stalled: number;
  fallingBehind: number;
  unknown: number;
  /** Of `unknown`, the clones declined by scope rather than by a failed read. */
  outOfScope: number;
  /** Observations removed by the retention pass. */
  pruned: number;
  detail: CloneConvergenceOutcome[];
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function auditFleetConvergence(supabase: Db): Promise<ConvergenceAuditReport> {
  const report: ConvergenceAuditReport = {
    clones: 0,
    converged: 0,
    delivering: 0,
    stalled: 0,
    fallingBehind: 0,
    unknown: 0,
    outOfScope: 0,
    pruned: 0,
    detail: [],
  };

  const primeRes = await supabase.from("prime_config").select("*").limit(1).maybeSingle();
  if (primeRes.error) throw new Error(`Could not read prime config: ${primeRes.error.message}`);
  const prime = primeRes.data as {
    github_owner: string | null;
    github_repo: string | null;
    default_branch: string | null;
    convergence_slo_minutes?: number | null;
  } | null;
  // No prime is a fault, not a converged fleet. An empty report here would say
  // "everything holds what it is owed" about a comparison that never ran.
  if (!prime?.github_owner || !prime?.github_repo) {
    throw new Error("Prime not configured — nothing to measure a clone against");
  }
  const primeRef: RepoRef = {
    owner: prime.github_owner,
    repo: prime.github_repo,
    branch: prime.default_branch || "main",
  };
  const sloMinutes = prime.convergence_slo_minutes ?? DEFAULT_CONVERGENCE_SLO_MINUTES;

  const { data, error } = await supabase
    .from("clones")
    .select("id, name, github_owner, github_repo, default_branch, sync_scope, crm_mode")
    .not("github_owner", "is", null)
    .not("github_repo", "is", null);
  // A candidate list that could not be READ is not an empty one.
  if (error) throw new Error(`Could not list clones: ${error.message}`);

  const octokit = getAppOctokit();

  // Prime's tree is the same for every clone, so it is read once per pass
  // rather than once per clone. On a three-clone fleet that is four calls
  // instead of six; on a fleet of a hundred it is the difference between this
  // being affordable and not.
  let primeTree: Awaited<ReturnType<typeof listTreeEntries>> | null = null;
  let primeReadError: string | null = null;
  try {
    primeTree = await listTreeEntries(octokit, primeRef);
  } catch (e) {
    primeReadError = msg(e);
  }

  for (const raw of data ?? []) {
    const clone = raw as {
      id: string;
      name: string | null;
      github_owner: string | null;
      github_repo: string | null;
      default_branch: string | null;
      sync_scope: string | null;
      crm_mode: string | null;
    };
    if (!clone.github_owner || !clone.github_repo) continue;
    const label = clone.name ?? `${clone.github_owner}/${clone.github_repo}`;
    report.clones += 1;

    let outcome: CloneConvergenceOutcome;
    try {
      outcome = await auditOneClone({
        supabase,
        octokit,
        primeTree,
        primeReadError,
        clone,
        label,
        sloMinutes,
      });
    } catch (e) {
      // One unreachable repository, one unreadable exclusion policy, one
      // database fault — none of them is a reading, and none of them blinds
      // the sweep to the rest of the fleet.
      outcome = {
        clone: label,
        state: "unknown",
        owed: 0,
        reconciled: 0,
        outOfScope: false,
        why: msg(e),
      };
      await writeObservation(supabase, {
        cloneId: clone.id,
        state: "unknown",
        why: msg(e),
        measurement: null,
        unchangedSince: null,
        lastConvergedAt: null,
        sloMinutes,
        scope: clone.sync_scope ?? null,
        // Prime's head was read once for the whole pass, so it is known here
        // whatever went wrong with this clone; the clone's head is not in hand
        // here, and null says exactly that.
        primeSha: primeTree?.headSha ?? null,
        cloneSha: null,
      }).catch(() => undefined);
    }

    report.detail.push(outcome);
    if (outcome.state === "converged") report.converged += 1;
    else if (outcome.state === "delivering") report.delivering += 1;
    else if (outcome.state === "stalled") report.stalled += 1;
    else if (outcome.state === "falling_behind") report.fallingBehind += 1;
    else report.unknown += 1;
    if (outcome.outOfScope) report.outOfScope += 1;
  }

  report.pruned = await pruneObservations(supabase);
  return report;
}

async function auditOneClone(args: {
  supabase: Db;
  octokit: ReturnType<typeof getAppOctokit>;
  primeTree: Awaited<ReturnType<typeof listTreeEntries>> | null;
  primeReadError: string | null;
  clone: {
    id: string;
    github_owner: string | null;
    github_repo: string | null;
    default_branch: string | null;
    sync_scope: string | null;
    crm_mode: string | null;
  };
  label: string;
  sloMinutes: number;
}): Promise<CloneConvergenceOutcome> {
  const { supabase, octokit, primeTree, primeReadError, clone, label, sloMinutes } = args;

  const prior = await readPrior(supabase, clone.id);

  /*
    THE TWO HEADS A READING WAS TAKEN AT, WHEREVER THEY WERE READ.

    `listTreeEntries` reads each branch's head and then the tree of THAT head,
    so the SHA and the tree it returns are one commit. Both columns were
    written null on every row since the table was created, which left a
    reading impossible to tie to the commits it compared — the one question
    an operator asks of a surprising number. A side that was not read stays
    null: an absent SHA is "not read", never a guess.
  */
  const primeSha = primeTree?.headSha ?? null;
  let cloneSha: string | null = null;

  const unmeasurable = async (
    why: string,
    opts: { outOfScope?: boolean } = {},
  ): Promise<CloneConvergenceOutcome> => {
    const reading = judgeConvergence({
      now: new Date(),
      measurement: { kind: "unmeasurable", why },
      prior,
      sloMinutes,
    });
    await writeObservation(supabase, {
      cloneId: clone.id,
      state: reading.state,
      why: reading.why,
      measurement: null,
      unchangedSince: reading.unchangedSince,
      lastConvergedAt: reading.lastConvergedAt,
      sloMinutes,
      scope: clone.sync_scope ?? null,
      primeSha,
      cloneSha,
    });
    return {
      clone: label,
      state: reading.state,
      owed: 0,
      reconciled: 0,
      outOfScope: opts.outOfScope === true,
      why: reading.why,
    };
  };

  if (primeReadError) return unmeasurable(`Could not read prime's tree: ${primeReadError}`);
  if (!primeTree) return unmeasurable("Prime's tree was not read this pass");

  /*
    MODULE SCOPE IS NAMED, NOT GUESSED.

    A module-scoped clone's section of prime is resolved by the engine from
    `clone_modules`, the module library's `file_globs`, any version pin that
    overrides them, and the repository invariants added on top. Re-deriving
    that here would be a second implementation of "what this clone's section
    is" — which is precisely the disagreement this auditor exists to detect,
    reintroduced inside the auditor.

    So it reports `unknown` with the reason, visibly, rather than measuring a
    scope it is not the authority on. Every clone on this fleet is a mirror as
    of `20260909110000`; when a module-scoped clone needs measuring the right
    move is to extract the engine's resolver into a shared function, not to
    approximate it here. Named in CASCADE_PIPELINE_HEALTH.md §9.

    It is flagged `outOfScope` as well, because it is the same declared fact
    on every tick rather than a read that failed. Measured 27 Oct 2026: the
    CRM independent (`modules`) read `unknown` on all 96 ticks a day, and
    `unknown > 0` alone was enough to file a cascade-audit row on every one of
    them, whatever the rest of the fleet was doing. The reading stays
    `unknown`, never converged; only the tick's decision to write an audit row
    about it changes.
  */
  if (clone.sync_scope !== "mirror") {
    return unmeasurable(
      `sync_scope is '${clone.sync_scope ?? "modules"}' — the auditor measures mirrors. ` +
        `A module clone's section of prime is resolved by the engine's own glob and pin ` +
        `logic, and a second implementation of it here would be the disagreement this ` +
        `reading exists to find.`,
      { outOfScope: true },
    );
  }

  const cloneRef: RepoRef = {
    owner: clone.github_owner!,
    repo: clone.github_repo!,
    branch: clone.default_branch || "main",
  };

  let cloneTree: Awaited<ReturnType<typeof listTreeEntries>>;
  try {
    cloneTree = await listTreeEntries(octokit, cloneRef);
  } catch (e) {
    return unmeasurable(`Could not read ${cloneRef.owner}/${cloneRef.repo}: ${msg(e)}`);
  }
  cloneSha = cloneTree.headSha;

  // Fail-closed: an exclusion set that could not be READ is not an empty one,
  // and an empty one here would report every identity file as owed.
  const exRes = await supabase
    .from("clone_sync_exclusions")
    .select("pattern, reason, note")
    .eq("clone_id", clone.id);
  let exclusions: SyncExclusion[];
  try {
    exclusions = requireExclusions(clone.id, exRes.data as SyncExclusion[] | null, exRes.error);
  } catch (e) {
    return unmeasurable(msg(e));
  }
  /*
    A mirror with no exclusions is the state `assertMirrorPolicy` refuses to
    cascade into, and measuring it would report its whole identity as owed —
    a large, alarming and completely wrong number. It is a real fault and it
    is the CUSTODIAN's to repair (`policy_unseeded`), so this names it and
    measures nothing.
  */
  if (exclusions.length === 0) {
    return unmeasurable(
      "sync_scope is 'mirror' and clone_sync_exclusions is empty — the cascade refuses this " +
        "state, and measuring it would report this clone's own identity as owed",
    );
  }

  const measurement: ConvergenceMeasurement = measureConvergence({
    prime: primeTree.entries,
    clone: cloneTree.entries,
    exclusions,
    primeTruncated: primeTree.truncated,
    cloneTruncated: cloneTree.truncated,
    primeSizes: primeTree.sizes,
    crmMode: clone.crm_mode,
  });

  const reading = judgeConvergence({ now: new Date(), measurement, prior, sloMinutes });

  await writeObservation(supabase, {
    cloneId: clone.id,
    state: reading.state,
    why: reading.why,
    measurement: measurement.kind === "measured" ? measurement : null,
    unchangedSince: reading.unchangedSince,
    lastConvergedAt: reading.lastConvergedAt,
    sloMinutes,
    scope: "mirror",
    primeSha,
    cloneSha,
  });

  return {
    clone: label,
    state: reading.state,
    owed: measurement.kind === "measured" ? measurement.owed.length : 0,
    reconciled: measurement.kind === "measured" ? measurement.reconciled.length : 0,
    outOfScope: false,
    why: reading.why,
  };
}

/**
 * The previous pass's verdict for this clone.
 *
 * `lastConvergedAt` is carried forward on every row rather than looked up
 * across the series, so one read answers both clocks — and a row that says
 * "last converged at X" stays true however far the table is later pruned.
 */
async function readPrior(supabase: Db, cloneId: string): Promise<PriorObservation | null> {
  const { data, error } = await supabase
    .from("clone_convergence_observations")
    .select("state, owed_fingerprint, unchanged_since, last_converged_at")
    .eq("clone_id", cloneId)
    .order("observed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  // A prior that could not be read is treated as no prior: the pass still
  // records a fresh observation, and the worst case is one delayed
  // escalation rather than a fabricated clock.
  if (error || !data) return null;
  const row = data as {
    state: string;
    owed_fingerprint: string | null;
    unchanged_since: string | null;
    last_converged_at: string | null;
  };
  return {
    state: row.state as ConvergenceState,
    fingerprint: row.owed_fingerprint,
    unchangedSince: row.unchanged_since,
    lastConvergedAt: row.last_converged_at,
  };
}

async function writeObservation(
  supabase: Db,
  row: {
    cloneId: string;
    state: ConvergenceState;
    why: string;
    measurement: Extract<ConvergenceMeasurement, { kind: "measured" }> | null;
    unchangedSince: string | null;
    lastConvergedAt: string | null;
    sloMinutes: number;
    scope: string | null;
    primeSha: string | null;
    cloneSha: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("clone_convergence_observations").insert({
    clone_id: row.cloneId,
    state: row.state,
    why: row.why,
    owed_count: row.measurement?.owed.length ?? 0,
    owed_fingerprint: row.measurement?.fingerprint ?? null,
    owed_sample: row.measurement ? owedSample(row.measurement.owed) : [],
    deletion_candidates: row.measurement?.deletionCandidates ?? 0,
    held_count: row.measurement?.held ?? 0,
    oversize_held: row.measurement?.oversizeHeld ?? 0,
    compared_count: row.measurement?.compared ?? 0,
    unchanged_since: row.unchangedSince,
    last_converged_at: row.lastConvergedAt,
    slo_minutes: row.sloMinutes,
    scope: row.scope,
    prime_sha: row.primeSha,
    clone_sha: row.cloneSha,
  });
  // An observation that silently failed to write leaves the next pass reading
  // a stale prior and re-dating a clock that should have kept running.
  if (error) {
    throw new Error(`Could not write convergence observation: ${error.message}`);
  }
}

/**
 * Keep the series bounded.
 *
 * Reported rather than silent: a retention pass that could not run is a table
 * that grows, and this is the only place that would notice.
 */
async function pruneObservations(supabase: Db): Promise<number> {
  const cutoff = new Date(
    Date.now() - OBSERVATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data, error } = await supabase
    .from("clone_convergence_observations")
    .delete()
    .lt("observed_at", cutoff)
    .select("id");
  if (error) return 0;
  return (data ?? []).length;
}
