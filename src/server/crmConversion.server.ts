/**
 * A CRM conversion's reads and writes — `crmConversion.pure.ts` decides.
 *
 * Four acts, and nothing here decides anything the pure module does not:
 *
 *  - **preview** — gathers what `judgeConversion` reads and, where it agrees,
 *    rehearses the proposal with the cascade engine's own dry run
 *    (`processClone({ dryRun: true, conversion })`), so the page shows the
 *    writes, removals, kept files and retired functions the real proposal
 *    would carry. Writes nothing anywhere.
 *  - **start** — claims the clone's one open slot (`clone_crm_conversions`'
 *    partial unique index is the lock), then builds the proposal with the
 *    same engine call, real this time. The pull request is recorded the moment
 *    it exists (`onProposal`), before anything else can go wrong.
 *  - **cancel** — closes an open proposal's pull request and records the
 *    cancellation. A merged conversion cannot be cancelled: the tree already
 *    changed, and finishing is what makes the record agree with it.
 *  - **drain** — run by `hooks.cascade-merge-drain` every five minutes: reads
 *    each open conversion's pull request, and finishes, cancels or fails it as
 *    `decideConversionStep` says. Finishing moves the clone under its new
 *    line (`finalisedCloneFields`), drops the routing holds a dependent clone
 *    no longer needs, deploys the functions the new line gives the clone and
 *    takes the retired ones off its project (`functionsToUndeploy`).
 *
 * Every read binds its error. A read that failed reaches the judge as
 * `readFailure`, never as an empty answer — "no children" read from a failed
 * query would let a parent be moved out from under its clones.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import { CRM_PARENT_COLUMN, isCrmMode, type CrmMode } from "@/lib/crmMode.pure";
import type { getAppOctokit, RepoRef } from "./github-app.server";
import { processClone, type ClonePlan } from "./cascade-engine.server";
import type { SyncExclusion } from "./cascade/syncExclusions.pure";
import { judgeCrmParent, type CrmParent, type CrmParentRow } from "./crmLineage.pure";
import {
  OPEN_CONVERSION_STATUSES,
  decideConversionStep,
  finalisedCloneFields,
  functionsToUndeploy,
  isConversionBranch,
  judgeConversion,
  routingHoldsToRetire,
  type ConversionCloneRow,
  type ConversionJudgement,
  type ConversionPrReading,
  type LeavingSourceRow,
} from "./crmConversion.pure";

type Db = SupabaseClient<Database>;
type Octokit = ReturnType<typeof getAppOctokit>;

const CLONE_COLUMNS =
  "id, name, github_owner, github_repo, default_branch, crm_mode, sync_scope, parent_clone_id, last_synced_sha";
const PARENT_COLUMNS =
  "id, name, github_owner, github_repo, github_url, default_branch, last_synced_sha, crm_mode, sync_scope, parent_clone_id";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What a conversion records in `plan` — the page's reading of the proposal. */
export interface ConversionPlanRecord {
  target: { id: string; name: string; repo: string; branch: string; headSha: string };
  leaving: { label: string; repo: string; branch: string };
  cautions: string[];
  writes: string[];
  deletes: string[];
  kept: Array<{ path: string; why: string }>;
  needsReconcile: string[];
  retiredFunctions: string[];
  releasedHolds: string[];
  refusal: string | null;
  summary: string;
  /** Filled in when the conversion finishes. */
  finish?: ConversionFinishRecord;
}

export interface ConversionFinishRecord {
  at: string;
  routingHoldsRemoved: string[];
  deployed: string;
  undeployed: string[];
  undeployFailed: Array<{ slug: string; error: string }>;
  undeployDeferred: string[];
  undeploySkipped: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gathering what the judgement reads
// ─────────────────────────────────────────────────────────────────────────────

export interface GatheredConversion {
  judgement: ConversionJudgement;
  clone: ConversionCloneRow | null;
}

export async function gatherConversion(args: {
  supabase: Db;
  octokit: Octokit;
  cloneId: string;
  toMode: unknown;
}): Promise<GatheredConversion> {
  const { supabase, octokit, cloneId } = args;
  let readFailure: string | null = null;
  const fail = (what: string, why: string) => {
    readFailure ??= `${what}: ${why}`;
  };

  const { data: cloneRow, error: cloneErr } = await supabase
    .from("clones")
    .select(CLONE_COLUMNS)
    .eq("id", cloneId)
    .maybeSingle();
  if (cloneErr) fail("the clone", cloneErr.message);
  const clone = (cloneRow ?? null) as ConversionCloneRow | null;

  const { data: cfg, error: cfgErr } = await supabase
    .from("prime_config")
    .select(
      "github_owner, github_repo, default_branch, crm_dependent_parent_clone_id, crm_independent_parent_clone_id",
    )
    .limit(1)
    .maybeSingle();
  if (cfgErr) fail("prime_config", cfgErr.message);
  const lineHeads = {
    dependent: (cfg?.[CRM_PARENT_COLUMN.dependent] as string | null | undefined) ?? null,
    independent: (cfg?.[CRM_PARENT_COLUMN.independent] as string | null | undefined) ?? null,
  };

  // The target line's head, judged the way provisioning judges it.
  const toMode = isCrmMode(args.toMode) ? args.toMode : null;
  const targetId = toMode ? lineHeads[toMode] : null;
  let targetRow: CrmParentRow | null = null;
  let targetReadFailed = false;
  if (targetId) {
    const { data, error } = await supabase
      .from("clones")
      .select(PARENT_COLUMNS)
      .eq("id", targetId)
      .maybeSingle();
    if (error) {
      targetReadFailed = true;
      fail("the target line's head", error.message);
    }
    targetRow = (data ?? null) as CrmParentRow | null;
  }
  const target = judgeCrmParent({
    mode: toMode ?? "dependent",
    parentId: targetId,
    parent: targetRow,
    readFailed: Boolean(cfgErr) || targetReadFailed,
    readError: cfgErr?.message ?? null,
  });

  // Children: a clone other clones read through cannot be carried across.
  let childCount = 0;
  if (clone) {
    const { count, error } = await supabase
      .from("clones")
      .select("id", { count: "exact", head: true })
      .eq("parent_clone_id", clone.id);
    if (error) fail("the clone's children", error.message);
    childCount = count ?? 0;
  }

  // Where the clone reads from today — the tree it leaves.
  let leaving: LeavingSourceRow | null = null;
  if (clone?.parent_clone_id) {
    const { data, error } = await supabase
      .from("clones")
      .select("name, github_owner, github_repo, default_branch")
      .eq("id", clone.parent_clone_id)
      .maybeSingle();
    if (error) fail("the clone's current parent", error.message);
    leaving = data ? { kind: "parent", ...data } : null;
  } else if (cfg) {
    leaving = {
      kind: "prime",
      name: "prime",
      github_owner: cfg.github_owner,
      github_repo: cfg.github_repo,
      default_branch: cfg.default_branch,
    };
  }

  let openConversion: { id: string; status: string } | null = null;
  if (clone) {
    const { data, error } = await supabase
      .from("clone_crm_conversions")
      .select("id, status")
      .eq("clone_id", clone.id)
      .in("status", [...OPEN_CONVERSION_STATUSES])
      .limit(1)
      .maybeSingle();
    if (error) fail("the clone's open conversions", error.message);
    openConversion = data ?? null;
  }

  // An open cascade proposal built from the line the clone leaves.
  let openCascadePr: { number: number; url: string } | null = null;
  if (clone?.github_owner && clone.github_repo) {
    try {
      const { data: open } = await octokit.pulls.list({
        owner: clone.github_owner,
        repo: clone.github_repo,
        state: "open",
        per_page: 100,
      });
      const pr = open.find((p) => (p.head?.ref ?? "").startsWith("aurixa/cascade-"));
      openCascadePr = pr ? { number: pr.number, url: pr.html_url } : null;
    } catch (e) {
      fail("the clone's open pull requests", message(e));
    }
  }

  const judgement = judgeConversion({
    clone,
    toMode: args.toMode,
    readFailure,
    lineHeads,
    childCount,
    target,
    targetScope: targetRow?.sync_scope ?? null,
    leaving,
    openConversion,
    openCascadePr,
  });
  return { judgement, clone };
}

// ─────────────────────────────────────────────────────────────────────────────
// Building the proposal (rehearsed or real)
// ─────────────────────────────────────────────────────────────────────────────

type OkJudgement = Extract<ConversionJudgement, { ok: true }>;

interface BuildOutcome {
  status: string;
  error: string | null;
  summary: string;
  plan: ConversionPlanRecord | null;
  headSha: string;
}

async function buildProposal(args: {
  supabase: Db;
  octokit: Octokit;
  clone: ConversionCloneRow;
  j: OkJudgement;
  conversionId: string;
  dryRun: boolean;
  onProposal?: (p: {
    number: number;
    url: string;
    branch: string;
    headSha: string;
  }) => Promise<void>;
}): Promise<BuildOutcome> {
  const { octokit, clone, j } = args;
  const target: CrmParent = j.target;
  const targetRef: RepoRef = {
    owner: target.githubOwner,
    repo: target.githubRepo,
    branch: target.defaultBranch,
  };
  const { data: branch } = await octokit.repos.getBranch({
    owner: targetRef.owner,
    repo: targetRef.repo,
    branch: targetRef.branch,
  });
  const headSha = branch.commit.sha;
  const cloneName = clone.name?.trim() || clone.github_repo || clone.id;

  let captured: ClonePlan | null = null;
  const result = await processClone({
    octokit,
    primeRef: targetRef,
    sourceSha: headSha,
    provenance: { label: target.name, deliveredSha: target.lastSyncedSha ?? headSha },
    mode: "pr",
    clone: {
      id: clone.id,
      name: cloneName,
      github_owner: clone.github_owner ?? "",
      github_repo: clone.github_repo ?? "",
      default_branch: clone.default_branch || "main",
      sync_scope: clone.sync_scope,
      // The membrane is the target line's: the clone is joining it.
      crm_mode: j.toMode,
    },
    supabase: args.supabase,
    scopeFilter: null,
    dryRun: args.dryRun,
    onPlan: (p) => {
      captured = p;
    },
    conversion: {
      conversionId: args.conversionId,
      cloneName,
      fromMode: j.fromMode,
      toMode: j.toMode,
      leaving: {
        ref: { owner: j.leaving.owner, repo: j.leaving.repo, branch: j.leaving.branch },
        label: j.leaving.label,
      },
      targetLabel: target.name,
      cautions: j.cautions,
      onProposal: args.onProposal,
    },
  });

  const p = captured as ClonePlan | null;
  const plan: ConversionPlanRecord | null = p
    ? {
        target: {
          id: target.id,
          name: target.name,
          repo: `${targetRef.owner}/${targetRef.repo}`,
          branch: targetRef.branch,
          headSha,
        },
        leaving: {
          label: j.leaving.label,
          repo: `${j.leaving.owner}/${j.leaving.repo}`,
          branch: j.leaving.branch,
        },
        cautions: j.cautions,
        writes: p.writes,
        deletes: p.deletes,
        kept: p.deletionKept.map((k) => ({ path: k.path, why: k.why })),
        needsReconcile: p.needsReconcile,
        retiredFunctions: p.conversion?.retiredFunctions ?? [],
        releasedHolds: p.conversion?.releasedHolds ?? [],
        refusal: p.conversion?.refusal ?? p.deletionRefusal ?? null,
        summary: p.summary,
      }
    : null;
  return {
    status: result.status ?? "failed",
    error: (result.error_message as string | null | undefined) ?? null,
    summary: (result.diff_summary as string | null | undefined) ?? "",
    plan,
    headSha,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

export type ConversionPreview =
  | { ok: false; reason: string; kind: string }
  | {
      ok: true;
      fromMode: CrmMode;
      toMode: CrmMode;
      targetName: string;
      leavingLabel: string;
      cautions: string[];
      /** The rehearsal's own answer: what the real proposal would carry. */
      plan: ConversionPlanRecord | null;
      summary: string;
      /** Set when the rehearsal itself refused (a refusal the proposal would hit too). */
      refusal: string | null;
    };

export async function previewCrmConversion(args: {
  supabase: Db;
  octokit: Octokit;
  cloneId: string;
  toMode: unknown;
}): Promise<ConversionPreview> {
  const { judgement, clone } = await gatherConversion(args);
  if (!judgement.ok) return { ok: false, reason: judgement.reason, kind: judgement.kind };
  if (!clone) return { ok: false, reason: "No such clone.", kind: "missing" };
  try {
    const built = await buildProposal({
      supabase: args.supabase,
      octokit: args.octokit,
      clone,
      j: judgement,
      conversionId: "preview",
      dryRun: true,
    });
    return {
      ok: true,
      fromMode: judgement.fromMode,
      toMode: judgement.toMode,
      targetName: judgement.target.name,
      leavingLabel: judgement.leaving.label,
      cautions: judgement.cautions,
      plan: built.plan,
      summary: built.summary,
      refusal: built.status === "failed" ? (built.error ?? built.summary) : null,
    };
  } catch (e) {
    return {
      ok: true,
      fromMode: judgement.fromMode,
      toMode: judgement.toMode,
      targetName: judgement.target.name,
      leavingLabel: judgement.leaving.label,
      cautions: judgement.cautions,
      plan: null,
      summary: "",
      refusal: `The rehearsal could not be built: ${message(e)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

export type ConversionStart =
  | { ok: false; reason: string; conversionId: string | null }
  | {
      ok: true;
      conversionId: string;
      status: "proposed" | "completed";
      prUrl: string | null;
      prNumber: number | null;
      summary: string;
    };

export async function startCrmConversion(args: {
  supabase: Db;
  octokit: Octokit;
  cloneId: string;
  toMode: unknown;
  requestedBy: string | null;
}): Promise<ConversionStart> {
  const { supabase, octokit } = args;
  const { judgement, clone } = await gatherConversion(args);
  if (!judgement.ok) return { ok: false, reason: judgement.reason, conversionId: null };
  if (!clone) return { ok: false, reason: "No such clone.", conversionId: null };

  // Claim the slot. The partial unique index is the lock: a second start for
  // the same clone fails HERE, whatever the judgement read a moment ago.
  const { data: claimed, error: claimErr } = await supabase
    .from("clone_crm_conversions")
    .insert({
      clone_id: clone.id,
      from_mode: judgement.fromMode,
      to_mode: judgement.toMode,
      from_parent_clone_id: clone.parent_clone_id,
      to_parent_clone_id: judgement.target.id,
      status: "proposed",
      delivered_sha: judgement.target.lastSyncedSha,
      requested_by: args.requestedBy,
    })
    .select("id")
    .single();
  if (claimErr || !claimed) {
    return {
      ok: false,
      conversionId: null,
      reason:
        claimErr?.code === "23505"
          ? "A conversion of this clone is already open. Finish or cancel it first."
          : `Could not record the conversion: ${claimErr?.message ?? "no row returned"}`,
    };
  }
  const conversionId = claimed.id;
  let proposal: { number: number; url: string; branch: string } | null = null;

  const record = async (patch: Database["public"]["Tables"]["clone_crm_conversions"]["Update"]) => {
    const { error } = await supabase
      .from("clone_crm_conversions")
      .update(patch)
      .eq("id", conversionId);
    if (error) {
      console.error(
        `[crm-conversion] ${conversionId}: could not record ${JSON.stringify(Object.keys(patch))}: ${error.message}`,
      );
    }
    return error;
  };

  let built: BuildOutcome;
  try {
    built = await buildProposal({
      supabase,
      octokit,
      clone,
      j: judgement,
      conversionId,
      dryRun: false,
      onProposal: async (p) => {
        proposal = p;
        await record({ pr_number: p.number, pr_url: p.url, branch: p.branch });
      },
    });
  } catch (e) {
    const why = `The proposal could not be built: ${message(e)}`;
    await record({ status: "failed", error: why });
    return { ok: false, reason: why, conversionId };
  }

  await record({ source_sha: built.headSha, plan: (built.plan ?? null) as unknown as Json });
  const opened = proposal as { number: number; url: string; branch: string } | null;

  // A proposal that exists is the conversion's, whatever status came back:
  // the drain reads its pull request from GitHub from here on.
  if (opened) {
    return {
      ok: true,
      conversionId,
      status: "proposed",
      prUrl: opened.url,
      prNumber: opened.number,
      summary: built.summary,
    };
  }
  if (built.status !== "skipped") {
    const why = built.error ?? (built.summary || "The proposal was refused.");
    await record({ status: "failed", error: why });
    return { ok: false, reason: why, conversionId };
  }

  // Nothing to deliver: the clone already carries the target line's tree.
  // The conversion is the record change alone, so it finishes now.
  await record({ status: "merged", merged_at: new Date().toISOString() });
  const done = await finaliseConversion({ supabase, octokit, conversionId });
  if (!done.ok) return { ok: false, reason: done.why, conversionId };
  return {
    ok: true,
    conversionId,
    status: "completed",
    prUrl: null,
    prNumber: null,
    summary: `Nothing to deliver — ${built.summary}. The clone was moved onto the line directly.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel
// ─────────────────────────────────────────────────────────────────────────────

export async function cancelCrmConversion(args: {
  supabase: Db;
  octokit: Octokit;
  conversionId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { supabase, octokit, conversionId } = args;
  const { data: row, error } = await supabase
    .from("clone_crm_conversions")
    .select("id, status, pr_number, branch, clone_id")
    .eq("id", conversionId)
    .maybeSingle();
  if (error) return { ok: false, reason: `Could not read the conversion: ${error.message}` };
  if (!row) return { ok: false, reason: "No such conversion." };
  if (row.status !== "proposed") {
    return {
      ok: false,
      reason:
        row.status === "merged"
          ? "This conversion's pull request has already merged; it is being finished, not cancelled."
          : `This conversion is already ${row.status}.`,
    };
  }
  if (row.pr_number) {
    const { data: clone, error: cloneErr } = await supabase
      .from("clones")
      .select("github_owner, github_repo")
      .eq("id", row.clone_id)
      .maybeSingle();
    if (cloneErr || !clone?.github_owner || !clone.github_repo) {
      return {
        ok: false,
        reason: `Could not read the clone's repository to close pull request #${row.pr_number}.`,
      };
    }
    try {
      const { data: pr } = await octokit.pulls.get({
        owner: clone.github_owner,
        repo: clone.github_repo,
        pull_number: row.pr_number,
      });
      if (pr.merged) {
        return {
          ok: false,
          reason: `Pull request #${row.pr_number} has already merged; the conversion will be finished.`,
        };
      }
      if (pr.state === "open") {
        await octokit.pulls.update({
          owner: clone.github_owner,
          repo: clone.github_repo,
          pull_number: row.pr_number,
          state: "closed",
        });
      }
      if (row.branch && isConversionBranch(row.branch)) {
        await octokit.git
          .deleteRef({
            owner: clone.github_owner,
            repo: clone.github_repo,
            ref: `heads/${row.branch}`,
          })
          .catch(() => undefined);
      }
    } catch (e) {
      return { ok: false, reason: `Could not close pull request #${row.pr_number}: ${message(e)}` };
    }
  }
  const { error: upErr } = await supabase
    .from("clone_crm_conversions")
    .update({
      status: "cancelled",
      error: "Cancelled by an operator. Nothing on the clone changed.",
    })
    .eq("id", conversionId)
    .eq("status", "proposed");
  if (upErr) return { ok: false, reason: `Could not record the cancellation: ${upErr.message}` };
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Finish
// ─────────────────────────────────────────────────────────────────────────────

export async function finaliseConversion(args: {
  supabase: Db;
  octokit: Octokit;
  conversionId: string;
}): Promise<{ ok: true; finish: ConversionFinishRecord } | { ok: false; why: string }> {
  const { supabase, octokit, conversionId } = args;
  const { data: row, error: rowErr } = await supabase
    .from("clone_crm_conversions")
    .select("*")
    .eq("id", conversionId)
    .maybeSingle();
  if (rowErr) return { ok: false, why: `could not read the conversion: ${rowErr.message}` };
  if (!row) return { ok: false, why: "no such conversion" };
  if (row.status === "completed") {
    const plan = (row.plan ?? {}) as unknown as ConversionPlanRecord;
    return plan.finish
      ? { ok: true, finish: plan.finish }
      : { ok: false, why: "already completed" };
  }
  if (row.status !== "merged") return { ok: false, why: `the conversion is ${row.status}` };

  const note = async (why: string, fatal: boolean) => {
    await supabase
      .from("clone_crm_conversions")
      .update(fatal ? { status: "failed", error: why } : { error: why })
      .eq("id", conversionId);
    return { ok: false as const, why };
  };

  if (!isCrmMode(row.to_mode)) return note(`"${row.to_mode}" is not a CRM line`, true);
  const toMode: CrmMode = row.to_mode;

  // The target head, judged again: it is what the clone is moved under.
  let targetRow: CrmParentRow | null = null;
  let targetErr: string | null = null;
  if (row.to_parent_clone_id) {
    const { data, error } = await supabase
      .from("clones")
      .select(PARENT_COLUMNS)
      .eq("id", row.to_parent_clone_id)
      .maybeSingle();
    targetErr = error?.message ?? null;
    targetRow = (data ?? null) as CrmParentRow | null;
  }
  const target = judgeCrmParent({
    mode: toMode,
    parentId: row.to_parent_clone_id,
    parent: targetRow,
    readFailed: targetErr !== null,
    readError: targetErr,
  });
  if (!target.ok) {
    // A read that failed is retried; a head that is gone or changed line is
    // not something a retry fixes, and says so.
    return note(
      `The clone's tree merged, but it could not be moved under its new line: ${target.reason}`,
      target.kind !== "unreadable",
    );
  }

  const { data: clone, error: cloneErr } = await supabase
    .from("clones")
    .select("id, default_branch")
    .eq("id", row.clone_id)
    .maybeSingle();
  if (cloneErr || !clone) {
    return note(`could not read the clone: ${cloneErr?.message ?? "no row"}`, false);
  }

  // 1. The record: parent, mode, scope, pointer — the one writer provisioning uses.
  const fields = finalisedCloneFields(target.parent, clone.default_branch, row.delivered_sha);
  const { error: moveErr } = await supabase.from("clones").update(fields).eq("id", clone.id);
  if (moveErr)
    return note(`could not move the clone under its new line: ${moveErr.message}`, false);

  // 2. The routing holds a dependent clone must not keep.
  let routingHoldsRemoved: string[] = [];
  const { data: exRows, error: exErr } = await supabase
    .from("clone_sync_exclusions")
    .select("pattern, reason, note")
    .eq("clone_id", clone.id);
  if (!exErr) {
    const retire = routingHoldsToRetire((exRows ?? []) as SyncExclusion[], toMode);
    if (retire.length > 0) {
      const { error: delErr } = await supabase
        .from("clone_sync_exclusions")
        .delete()
        .eq("clone_id", clone.id)
        .eq("reason", "manual_reconcile")
        .in("pattern", retire);
      if (!delErr) routingHoldsRemoved = retire;
    }
  }

  // 3. Functions: deploy what the new line gives the clone; take off what it retired.
  const { deployCloneOwnedFunctions, describeCloneOwnedOutcome } =
    await import("./cloneOwnedFunctions.server");
  const deployed = await deployCloneOwnedFunctions({
    supabase,
    octokit,
    cloneId: clone.id,
    force: true,
  });

  const plan = (row.plan ?? null) as unknown as ConversionPlanRecord | null;
  const retired = plan?.retiredFunctions ?? [];
  let undeployed: string[] = [];
  let undeployFailed: Array<{ slug: string; error: string }> = [];
  let undeployDeferred: string[] = [];
  let undeploySkipped: string | null = null;
  if (retired.length > 0) {
    const { resolvePrimeBackendRef, resolvePrimeSource, fetchDeclaredEdgeFunctionSlugs } =
      await import("./prime-backend.server");
    const { deleteProjectEdgeFunctions, readProjectEdgeFunctionSlugs } =
      await import("./backend-provisioning.server");
    const { data: backend } = await supabase
      .from("clone_backends_safe")
      .select("supabase_project_ref")
      .eq("clone_id", clone.id)
      .maybeSingle();
    const projectRef = (backend?.supabase_project_ref ?? "").trim();
    const primeSource = await resolvePrimeSource(supabase).catch(() => null);
    const primeDeclared = primeSource
      ? await fetchDeclaredEdgeFunctionSlugs(octokit, primeSource)
      : null;
    if (!projectRef) {
      undeploySkipped = "the clone has no Supabase project recorded";
    } else if (!primeDeclared) {
      // Without the prime's list a retired name could be one the prime owns.
      undeploySkipped = "the prime's declared functions could not be read, so nothing was removed";
    } else {
      const primeRef = (await resolvePrimeBackendRef(supabase).catch(() => "")).trim();
      const live = await readProjectEdgeFunctionSlugs(projectRef);
      const toRemove = functionsToUndeploy({ retired, live, primeDeclared });
      if (toRemove.length > 0) {
        const res = await deleteProjectEdgeFunctions(projectRef, toRemove, { primeRef });
        undeployed = res.deleted;
        undeployFailed = res.failed;
        undeployDeferred = res.deferred;
        undeploySkipped = res.skipped;
      }
    }
  }

  const finish: ConversionFinishRecord = {
    at: new Date().toISOString(),
    routingHoldsRemoved,
    deployed: describeCloneOwnedOutcome(deployed),
    undeployed,
    undeployFailed,
    undeployDeferred,
    undeploySkipped,
  };
  const leftover =
    undeployFailed.length > 0 || undeployDeferred.length > 0
      ? `Retired functions still on the project: ${[
          ...undeployFailed.map((f) => `${f.slug} (${f.error})`),
          ...undeployDeferred,
        ].join(", ")}. Remove them from the Supabase dashboard.`
      : null;
  const { error: doneErr } = await supabase
    .from("clone_crm_conversions")
    .update({
      status: "completed",
      completed_at: finish.at,
      error: leftover,
      plan: { ...(plan ?? {}), finish } as unknown as Json,
    })
    .eq("id", conversionId);
  if (doneErr) return { ok: false, why: `could not record completion: ${doneErr.message}` };
  return { ok: true, finish };
}

// ─────────────────────────────────────────────────────────────────────────────
// The drain
// ─────────────────────────────────────────────────────────────────────────────

export interface ConversionDrainReport {
  considered: number;
  completed: number;
  cancelled: number;
  failed: number;
  waiting: number;
  errors: string[];
}

export async function drainCrmConversions(
  supabase: Db,
  octokit: Octokit,
  now: number = Date.now(),
): Promise<ConversionDrainReport> {
  const report: ConversionDrainReport = {
    considered: 0,
    completed: 0,
    cancelled: 0,
    failed: 0,
    waiting: 0,
    errors: [],
  };
  const { data: rows, error } = await supabase
    .from("clone_crm_conversions")
    .select("id, clone_id, status, pr_number, created_at")
    .in("status", [...OPEN_CONVERSION_STATUSES])
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) {
    report.errors.push(`could not read open conversions: ${error.message}`);
    return report;
  }

  for (const row of rows ?? []) {
    report.considered += 1;
    let reading: ConversionPrReading | null = null;
    if (row.status === "proposed" && row.pr_number) {
      const { data: clone } = await supabase
        .from("clones")
        .select("github_owner, github_repo")
        .eq("id", row.clone_id)
        .maybeSingle();
      if (!clone?.github_owner || !clone.github_repo) {
        reading = { kind: "unreadable", why: "the clone's repository could not be read" };
      } else {
        try {
          const { data: pr } = await octokit.pulls.get({
            owner: clone.github_owner,
            repo: clone.github_repo,
            pull_number: row.pr_number,
          });
          reading = pr.merged
            ? { kind: "merged", mergeSha: pr.merge_commit_sha ?? null }
            : pr.state === "closed"
              ? { kind: "closed" }
              : { kind: "open" };
        } catch (e) {
          const status = (e as { status?: number }).status;
          reading = status === 404 ? { kind: "missing" } : { kind: "unreadable", why: message(e) };
        }
      }
    }

    const step = decideConversionStep({
      status: row.status,
      prNumber: row.pr_number,
      pr: reading,
      createdAt: Date.parse(row.created_at),
      now,
    });

    if (step.act === "wait" || step.act === "none") {
      report.waiting += 1;
      continue;
    }
    if (step.act === "cancel" || step.act === "fail") {
      const { error: upErr } = await supabase
        .from("clone_crm_conversions")
        .update({ status: step.act === "cancel" ? "cancelled" : "failed", error: step.why })
        .eq("id", row.id)
        .eq("status", row.status);
      if (upErr) report.errors.push(`${row.id}: ${upErr.message}`);
      else if (step.act === "cancel") report.cancelled += 1;
      else report.failed += 1;
      continue;
    }

    // finalise
    if (row.status === "proposed") {
      const { error: upErr } = await supabase
        .from("clone_crm_conversions")
        .update({
          status: "merged",
          merged_at: new Date(now).toISOString(),
          merge_sha: reading?.kind === "merged" ? reading.mergeSha : null,
        })
        .eq("id", row.id)
        .eq("status", "proposed");
      if (upErr) {
        report.errors.push(`${row.id}: ${upErr.message}`);
        continue;
      }
    }
    const done = await finaliseConversion({ supabase, octokit, conversionId: row.id });
    if (done.ok) report.completed += 1;
    else report.errors.push(`${row.id}: ${done.why}`);
  }
  return report;
}

/** Whether a drain pass is worth a line in the audit log. */
export function conversionDrainIsNews(r: ConversionDrainReport): boolean {
  return r.completed > 0 || r.cancelled > 0 || r.failed > 0 || r.errors.length > 0;
}

/** The page's read: a clone's conversions, newest first. */
export async function listCloneConversions(supabase: Db, cloneId: string) {
  const { data, error } = await supabase
    .from("clone_crm_conversions")
    .select(
      "id, status, from_mode, to_mode, pr_number, pr_url, error, plan, created_at, merged_at, completed_at",
    )
    .eq("clone_id", cloneId)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(`Could not read the clone's conversions: ${error.message}`);
  return data ?? [];
}
