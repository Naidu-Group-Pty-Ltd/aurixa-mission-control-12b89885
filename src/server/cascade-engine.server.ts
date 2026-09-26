// Server-only core of the cascade engine. The user-facing server function in
// cascade-engine.functions.ts wraps this with auth middleware; the GitHub
// webhook receiver invokes it directly with the admin client.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  CHECKS_PERMISSION_REMEDY,
  checksUnreadable,
  decideCascadeMerge,
} from "./cascade/autoMergeGate.pure";
import {
  describeMissingHeldReferences,
  describeStaleHeldReferences,
  findMissingHeldReferences,
  findStaleHeldReferences,
  type MissingHeldReference,
  type StaleHeldReference,
} from "./cascade/heldFileStaleness.pure";
import {
  chunkTreeEntries,
  toGitTreeParam,
  type DeliveryTreeEntry,
} from "./cascade/treeDelivery.pure";
import { readInstalledGlobs } from "./cascade/installedGlobs.server";
import {
  getAppOctokit,
  listFilesMatchingGlobs,
  listTreeEntries,
  getFileContent,
  OversizeFileError,
  copyBlobByStream,
  type RepoRef,
} from "./github-app.server";
import { cascadeEventStatus, summariseCascade } from "./cascade/prReconcile.pure";
import type { CascadeBudget, CascadeRunResult } from "@/lib/cascadeRunOutcome";
import {
  classifyGitHubFailure,
  describeDeferral,
  describePause,
} from "./cascade/rateLimitDeferral.pure";
import {
  describeLineageHold,
  LINEAGE_HOLD_RETRY_MS,
  orderByLineageDepth,
  resolveCascadeSource,
  type ParentCloneRow,
} from "./cascade/cloneCascadeSource.pure";
import {
  decideDeletion,
  deletionSuffixFor,
  describeDeletionPlan,
  planDeletions,
  probeRotationFor,
  withholdReferencedDeletions,
  MAX_DELETIONS_PER_CASCADE,
  MAX_DELETION_PROBES,
  type DeletionVerdict,
  type SettledDeletionEvidence,
} from "./cascade/deletionPropagation.pure";
import { probeDeletions, probeHeldPaths } from "./cascadeDeletions.server";
import {
  describeSpecsBroughtAcross,
  leftBehindSpecHold,
  MAX_LEFT_BEHIND_PROBES,
  MAX_SHIM_HOPS,
  pathsTheDeliveryChanges,
  specsBothSidesHoldDifferently,
  specsLeftBehind,
  subjectsOfKeptSpec,
  withLeftBehindNote,
  type CarryBasis,
  type LeftBehindCutShort,
  type LeftBehindSpec,
  type LeftBehindTouch,
  type SpecSide,
} from "./cascade/specsLeftBehind.pure";
import { gitBlobSha } from "./cascade/gitBlobSha.pure";
import { MAX_OUTSIDE_ROOT_PROBES, outsideRootCandidates } from "./cascade/outsideRootSubjects.pure";
import { decodeBase64Utf8, fetchBlobTextsBatched } from "./prime-backend.server";
import {
  decideHoldRelease,
  describeHoldReleases,
  holdReleaseSuffixFor,
  MAX_HOLD_RELEASE_PROBES,
  type HeldPathEvidence,
  type HoldRelease,
  type SettledHeldEvidence,
} from "./cascade/heldEvidence.pure";
import { judgingWorkflowHold } from "./cascade/judgingWorkflow.pure";
import {
  CONFIG_TOML_PATH,
  declaredFunctionCount,
  reconcileConfigToml,
} from "./cascade/configTomlReconcile.pure";
import {
  SECURITY_REGISTRY_PATH,
  reconcileSecurityRegistry,
} from "./cascade/securityRegistryReconcile.pure";
import {
  FUNCTION_COUNT_RATCHET_PATH,
  SECURITY_INVENTORY_PATH,
  cloneOnlyEdgeFunctions,
  functionCountRatchetHold,
  securityInventoryHold,
} from "./cascade/securityInventoryHold.pure";
import {
  reconcileFunctionCountRatchet,
  reconcileSecurityInventory,
} from "./cascade/securityBaselineReconcile.pure";
import {
  EDGE_TYPECHECK_BASELINE_PATH,
  describeKeptCounts,
  reconcileEdgeTypecheckBaseline,
} from "./cascade/edgeTypecheckBaselineReconcile.pure";
import {
  MAX_SUBJECTS_CARRIED,
  orphanSpecHoldAfterCarry,
  permeate,
  planSubjectCarry,
  strandedSubjects,
} from "@/lib/cascade/membrane/membrane.pure";
import { membraneInto } from "@/lib/cascade/membrane/fleetMembranes.pure";
import { isSpecPath } from "@/lib/cascade/membrane/ionSpecies.pure";
import { refreshCarrierRows } from "./cascade/carrierRefresh.server";
import {
  DEPLOY_WORKFLOW_PATH,
  readsDeployerDeclaration,
  reconcileDeployWorkflow,
} from "./cascade/deployWorkflowReconcile.pure";
import {
  assertMirrorPolicy,
  backendIdentityHold,
  CASCADE_MAX_FILE_BYTES,
  oversizeHold,
  oversizeHoldNotice,
  backendRefsIn,
  isShippedPath,
  partitionCascadePaths,
  approvableHeld,
  reportableHeld,
  reconcileSuffixFor,
  summaryOwesReconcile,
  requireExclusions,
  type HeldPath,
  type ExclusionReason,
  type SyncExclusion,
} from "./cascade/syncExclusions.pure";
import { isBlockedByApproval } from "./cascade-approvals.server";
import { validateClonePinsServer } from "./library-validation.server";
import { validateModuleGlobs } from "@/lib/module-globs";
import { mapWithConcurrency, mapWithConcurrencyUntil } from "@/lib/concurrency";
import {
  PROGRESS_FLUSH_EVERY,
  describePreparePause,
  describeProbePause,
  readProgress,
  resumableBlobs,
  resumableDeletionEvidence,
  resumableHeldEvidence,
  type CascadeProgress,
  type DeletionEvidenceEntry,
  type HeldEvidenceEntry,
} from "./cascade/passProgress.pure";

type CascadeResultUpdate = Database["public"]["Tables"]["cascade_results"]["Update"];

/**
 * Everything one cascade decided, before it wrote anything.
 *
 * This exists so a dry run can be the ENGINE rather than a second walk that
 * agrees with it on a good day. The one it replaced compared decoded strings
 * (so a binary read as unchanged), probed the first 30 files of a module and
 * called that the blast radius, applied no exclusion policy, had no concept of
 * a mirror, and could not see a deletion at all — every one of which made it
 * describe a cascade that would not happen.
 */
export type ClonePlan = {
  cloneId: string;
  scope: string;
  /** Paths this cascade would write. */
  writes: string[];
  /** Paths it would remove, having proved prime deleted them. */
  deletes: string[];
  /** Paths withheld by the exclusion policy or a content hold. */
  heldTotal: number;
  /** The subset a person is expected to reconcile by hand. */
  needsReconcile: string[];
  /**
   * The subset of THAT list held by the byte ceiling rather than by a
   * divergence, so no surface offers an approval over it.
   *
   * Published rather than re-derived: the approval dialog is drawn from paths
   * alone, and a path carries no reason, so a card asked to exclude oversize
   * holds had nothing to exclude them by. That is how the offer came to be
   * drawn over the one kind of hold an approval can never release.
   */
  oversizePaths: string[];
  /** Prime deletions NOT delivered, with the reason. */
  deletionKept: Array<{ path: string; reason: string; why: string }>;
  deletionRefusal: string | null;
  /**
   * The exact paths a bulk refusal withheld — what the approval surface
   * offers an operator, so the person approves the set the engine measured.
   */
  refusedDeletionPaths: string[];
  /** `manual_reconcile` holds this run released, and on what basis. */
  holdReleases: HoldRelease[];
  staleHeld: StaleHeldReference[];
  missingHeld: MissingHeldReference[];
  onlyInClone: number;
  unprobedDeletions: number;
  summary: string;
};
type SupabaseLike = SupabaseClient<Database>;

function shortSha(sha: string) {
  return sha.slice(0, 7);
}

/** The directory part of a repo path, or "" at the root. */
function directoryOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function branchName(sourceSha: string) {
  return `aurixa/cascade-${shortSha(sourceSha)}-${Date.now().toString(36)}`;
}

/**
 * Whether a GitHub failure means a tree or blob SHA we supplied no longer
 * exists in the repository — the one failure mode of reusing prepared blobs
 * across passes, since GitHub eventually collects unreferenced objects.
 * Deliberately narrow: a rate limit, a permission refusal and a network fault
 * all keep the list, because the list did not cause them.
 */
function isStaleObjectError(e: unknown): boolean {
  const status =
    e && typeof e === "object" && "status" in e ? (e as { status?: unknown }).status : null;
  if (status !== 404 && status !== 422) return false;
  const message = e instanceof Error ? e.message : String(e);
  return /\b(blob|tree)\b/i.test(message) && /\b(sha|not found|exist)\b/i.test(message);
}

/**
 * The newest prepared-blob list any pass has left for this clone, when the
 * current result row carries none of its own. Best-effort by design: the
 * borrow is an optimisation, so an unreadable table means "nothing to reuse"
 * and the pass pays full price exactly as it did before the ledger existed.
 */
async function borrowLatestProgress(
  supabase: SupabaseLike,
  cloneId: string,
  excludeResultId: string,
): Promise<unknown> {
  const { data, error } = await supabase
    .from("cascade_results")
    .select("progress")
    .eq("clone_id", cloneId)
    .not("progress", "is", null)
    .neq("id", excludeResultId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn(`[cascade] could not borrow progress for clone ${cloneId}: ${error.message}`);
    return null;
  }
  return (data as { progress?: unknown } | null)?.progress ?? null;
}

export type { CascadeBudget, CascadeRunResult };

/**
 * Settle the rows an event's own settling never reached.
 *
 * A settled event's `queued`/`pushing` rows are invisible to every sweeper:
 * the reclaim rules read PENDING events, reconciliation reads `pr_opened`
 * rows, and the pointer derivation reads `succeeded` ones — so a row left
 * non-terminal under a `failed` or `completed` carrier sits in the ledger for
 * ever as work that looks owed. Measured 16 Sep 2026: 124 such rows, 119 from
 * the September freeze and five minted as recently as 14–15 Sep by exactly
 * the exits below. The rule: **the act that settles an event without walking
 * its rows settles the rows too.**
 *
 * `skipped`, never `failed`: nothing failed IN the row — the carrier died
 * around it — and the message names the carrier's fate so the register reads
 * as a record instead of a mystery. Never throws: the event's own fate is
 * already written and correct, and orphaned rows are ledger debt, not a
 * reason to report the settle itself as failed.
 */
export async function terminaliseOrphanedRows(
  supabase: SupabaseLike,
  eventId: string,
  why: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("cascade_results")
    .update({
      status: "skipped",
      error_message: why,
      completed_at: new Date().toISOString(),
    })
    .eq("cascade_event_id", eventId)
    .in("status", ["queued", "pushing"])
    .select("id");
  if (error) {
    console.error(`[cascade] could not terminalise rows for ${eventId}:`, error.message);
    return 0;
  }
  return (data ?? []).length;
}

export async function executeCascade(
  supabase: SupabaseLike,
  cascadeEventId: string,
  opts?: {
    budget?: CascadeBudget;
    /**
     * The `worker_started_at` this caller's CLAIM wrote, when it claimed.
     * Measured 16 Sep 2026, 09:22–09:45: pg_cron abandons an invocation at
     * 60 s but the isolate keeps executing, so a superseded pass can finish
     * minutes later and write over a live claim's state — releasing it,
     * re-deferring it, or stamping it finished. With a fence, every EVENT
     * write below carries `.eq("worker_started_at", fence)`: the reclaim or
     * a newer claim rewrites that column, and the zombie's writes match
     * nothing. Callers that never claim (the manual trigger path) pass none
     * and write as before.
     */
    fence?: string;
  },
): Promise<CascadeRunResult> {
  const [eventRes, primeRes, queuedRes] = await Promise.all([
    supabase.from("cascade_events").select("*").eq("id", cascadeEventId).single(),
    supabase.from("prime_config").select("*").limit(1).maybeSingle(),
    supabase
      .from("cascade_results")
      .select("*, clones(*)")
      .eq("cascade_event_id", cascadeEventId)
      .eq("status", "queued"),
  ]);

  const event = eventRes.data;
  if (eventRes.error || !event) {
    return { ok: false, error: "Cascade event not found" };
  }
  if (event.status === "completed" || event.status === "failed") {
    return { ok: false, error: `Already ${event.status}` };
  }
  // Blast-radius gate — block engine if a second-operator approval is required
  // and not yet recorded. Engine will re-run via approveCascade.
  const gate = await isBlockedByApproval(supabase, cascadeEventId);
  if (gate.blocked) {
    return { ok: false, error: gate.reason ?? "Awaiting approval" };
  }
  const prime = primeRes.data;
  if (!prime) {
    return { ok: false, error: "Prime not configured — set it up in Settings first" };
  }

  // Every write that moves the EVENT goes through this. With a fence it
  // matches only while this invocation still holds the claim; without one
  // (a caller that never claimed) it writes as before. `false` means the
  // claim was superseded — the invocation is a zombie and must write nothing
  // more, because whatever it wanted to record, a newer pass knows better.
  const fence = opts?.fence ?? null;
  const updateEvent = async (
    patch: Database["public"]["Tables"]["cascade_events"]["Update"],
    what: string,
  ): Promise<boolean> => {
    let q = supabase.from("cascade_events").update(patch).eq("id", event.id);
    if (fence) q = q.eq("worker_started_at", fence);
    const { data, error } = await q.select("id");
    if (error) {
      throw new Error(`cascade ${event.id}: could not ${what}: ${error.message}`);
    }
    const written = (data ?? []).length > 0;
    if (!written) {
      console.warn(
        `[cascade] ${event.id}: ${what} fenced out — this invocation's claim was superseded`,
      );
    }
    return written;
  };

  // Armed, then claimable — and if claimed anyway, held rather than judged.
  //
  // The trigger commits the EVENT first and its result rows a moment later,
  // and the per-minute drain claimed one inside that gap: 807ms on 16 Sep
  // 2026 (event dd7180c7) — this pass read zero queued rows, honestly
  // completed "(of 0)", and the three rows landed a second later, stranded
  // under a completed carrier with the delivery silently lost. Zero QUEUED
  // rows is a normal end-state for a finished resume, so the question is
  // asked of the whole ledger: an event with NO rows in ANY status is not
  // one whose work is done, it is one whose creation has not finished (or
  // died trying). It is handed back for a later tick, before the pre-loop
  // exits below can fail it — failing an unarmed event settles it while its
  // rows may still be in flight, which is the same strand again. A count
  // that cannot be read holds too: unprovable-armed is not armed.
  if ((queuedRes.data ?? []).length === 0) {
    const { count, error: armError } = await supabase
      .from("cascade_results")
      .select("id", { count: "exact", head: true })
      .eq("cascade_event_id", event.id);
    if (armError || (count ?? 0) === 0) {
      const held = await updateEvent(
        {
          status: "pending",
          worker_started_at: null,
          next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
          summary:
            "Held: claimed before any result row was armed — the trigger that created this " +
            "event commits its rows a moment after the event itself.",
        },
        "hold an unarmed event",
      );
      if (!held) return { ok: false, error: "claim superseded — nothing written" };
      return { ok: true, status: "unarmed" };
    }
  }

  let octokit;
  try {
    octokit = getAppOctokit();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "GitHub App not configured";
    await updateEvent(
      { status: "failed", completed_at: new Date().toISOString(), summary: msg },
      "record the missing GitHub App",
    );
    await terminaliseOrphanedRows(
      supabase,
      event.id,
      "Skipped: the carrier event failed before any clone was processed (GitHub App not configured).",
    );
    return { ok: false, error: msg };
  }

  const primeRef: RepoRef = {
    owner: prime.github_owner,
    repo: prime.github_repo,
    branch: event.source_branch || prime.default_branch || "main",
  };
  let sourceSha: string;
  try {
    const { data: br } = await octokit.repos.getBranch({
      owner: primeRef.owner,
      repo: primeRef.repo,
      branch: primeRef.branch,
    });
    sourceSha = br.commit.sha;
  } catch (e) {
    // The same window the per-clone loop already defers on, one step earlier.
    // Measured 2 Sep 2026 at 15:10: event 9039d1ed reached this read with the
    // installation's hourly budget spent, and failed — "Cannot read prime …:
    // API rate limit exceeded for installation ID 157200201" — with two clones
    // still `queued`. A failed event is never claimed again, so the prime
    // commit it carried would have reached neither of them without a person
    // re-arming the row. The classifier was added for the loop below and this
    // read sits in front of it, which is the only reason it was not consulted
    // here.
    const failure = classifyGitHubFailure(e);
    if (failure.kind === "rate_limited") {
      const summary = describeDeferral({
        until: failure.until,
        detail: failure.detail,
        done: 0,
        total: 0,
      });
      const held = await updateEvent(
        {
          status: "pending",
          worker_started_at: null,
          next_attempt_at: failure.until,
          summary,
        },
        "hold the event after a rate limit on the prime read",
      );
      if (!held) return { ok: false, error: "claim superseded — nothing written" };
      return { ok: true, status: "deferred", until: failure.until, done: 0, total: 0 };
    }
    const msg = `Cannot read prime ${primeRef.owner}/${primeRef.repo}@${primeRef.branch}: ${e instanceof Error ? e.message : "unknown"}`;
    await updateEvent(
      { status: "failed", completed_at: new Date().toISOString(), summary: msg },
      "record the failed prime read",
    );
    await terminaliseOrphanedRows(
      supabase,
      event.id,
      "Skipped: the carrier event failed reading prime before any clone was processed.",
    );
    return { ok: false, error: msg };
  }

  // Deliberately NOT `source_sha: sourceSha`. The event's `source_sha` is
  // the push that created it — provenance, exactly as on the pass ledger —
  // and `uq_cascade_events_commit_sha` is UNIQUE over every commit event
  // whatever its status, so re-stamping the carrier to prime's current head
  // collides with whichever row already carries that head (after a fold,
  // one always does). Measured 16 Sep 2026 at 10:24:02: the re-stamp had
  // been violating the index on every pass since the fold existed — the old
  // unchecked write swallowed it, which is also why a working pass never
  // actually read `running` — and the first checked write failed the
  // carrier twice in 600 ms. What a pass DELIVERED is recorded where it
  // lands: each clone's `commit_sha`, the pull request title, the summary.
  const started = await updateEvent(
    { status: "running", started_at: new Date().toISOString() },
    "mark the event running",
  );
  if (!started) return { ok: false, error: "claim superseded — nothing written" };

  // The rows this pass will work. Read once above, and REPLACED by the
  // refresh below when it re-offers a finished clone — everything downstream
  // that asks what this pass is doing reads this, never the original query,
  // so the tally, the loop and the per-clone notifications all describe the
  // same set.
  let passRows = queuedRes.data ?? [];

  // ── Re-offer prime's head to the clones this carrier already finished ────
  //
  // `createCascadeForAllClones` stands every push down while an unclaimed
  // pending commit event exists, on the promise that "that event will deliver
  // this push's content anyway, because it reads prime's head when it runs".
  // `queuedRes`, read in this function's opening query, is
  // `.eq("status", "queued")` — so the promise covers only clones this carrier
  // has NOT finished, and a carrier held on lineage never settles, so no fresh
  // event is ever created to cover the rest. Nine prime commits reached no clone at all on 20 Sep 2026 through
  // exactly that gap; `carrierRefresh.pure.ts` carries the measurement.
  //
  // After the claim fence, because it writes result rows: a superseded
  // invocation must not re-arm work a newer pass has taken. Before the
  // pre-flight below, because those rows are this pass's work.
  //
  // It fires only when prime's head has MOVED, so it costs one pass per prime
  // commit rather than one per five-minute claim — the bound that keeps it
  // out of the budget multiplication `eventFold`'s header exists to stop.
  const carrierRefresh = await refreshCarrierRows(supabase, {
    eventId: event.id,
    event: {
      trigger: event.trigger,
      completed_at: event.completed_at ?? null,
      scope_filter: event.scope_filter ?? null,
    },
    head: sourceSha,
  });
  if (carrierRefresh.refreshed > 0) {
    const reread = await supabase
      .from("cascade_results")
      .select("*, clones(*)")
      .eq("cascade_event_id", event.id)
      .eq("status", "queued");
    // A re-read that FAILED is not an event with no work. Keeping the rows
    // this pass already holds means it delivers to whatever was queued before
    // the refresh and the next claim re-offers the rest — never that the pass
    // decides the carrier is finished off a fault.
    if (reread.error) {
      console.error(
        `[cascade] re-offered ${carrierRefresh.refreshed} row(s) on ${event.id} but could not re-read them:`,
        reread.error.message,
      );
    } else {
      passRows = reread.data ?? passRows;
    }
  }

  /**
   * Every summary this pass writes carries the re-offer, because a clone that
   * was finished and is being delivered again is the one thing on the row an
   * operator cannot work out from the counts. One composer rather than a
   * sentence at each write site: two spellings of the same fact is how the
   * hold's story and the tally's come to disagree.
   */
  const withRefreshNote = (summary: string): string =>
    carrierRefresh.note ? `${summary} ${carrierRefresh.note}` : summary;

  let succeeded = 0;
  let failed = 0;
  let opened = 0;
  let skipped = 0;
  /** Clones this run left owing a hand-reconcile. Counted as results land. */
  let owedReconcile = 0;

  // Pre-flight: validate clone library pins. If any pin references a missing,
  // unapproved, or empty library entry, fail that clone's queued result early
  // so the cascade can't push partial/wrong file sets.
  const queuedRows = passRows;
  const cloneIds = queuedRows
    .map((r) => (r as { clones: { id: string } | null }).clones?.id)
    .filter((v): v is string => Boolean(v));
  const pinCheck = await validateClonePinsServer(supabase, cloneIds);
  const blockedClones = new Map<string, string[]>();
  if (pinCheck.ok && pinCheck.issues.length > 0) {
    for (const issue of pinCheck.issues) {
      if (issue.severity !== "error") continue;
      const list = blockedClones.get(issue.cloneId) ?? [];
      list.push(`${issue.slug}@v${issue.version}: ${issue.reason}`);
      blockedClones.set(issue.cloneId, list);
    }
  }

  // ── Lineage: which repository each clone reads from ──────────────────────
  //
  // Off by default (`prime_config.cascade_follows_lineage`), and while it is
  // off every decision below resolves to prime and this whole block is inert.
  //
  // The parents are read ONCE, before the loop, and then kept current in
  // memory: a parent delivered earlier in this same pass has moved on from
  // what the query returned, and re-reading its row per clone would spend a
  // round trip per clone to learn something this loop already knows. A parent
  // outside the event (a cascade scoped to the children alone) is fetched here
  // too — its readiness is a fact about the fleet, not about this event.
  const followsLineage =
    (prime as { cascade_follows_lineage?: boolean }).cascade_follows_lineage === true;

  const parentState = new Map<string, ParentCloneRow>();
  let parentReadFailed = false;

  if (followsLineage) {
    const parentIds = [
      ...new Set(
        queuedRows
          .map((r) => (r as { clones: { parent_clone_id: string | null } | null }).clones)
          .map((c) => c?.parent_clone_id)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    if (parentIds.length > 0) {
      const { data: parentRows, error: parentErr } = await supabase
        .from("clones")
        .select("id, name, github_owner, github_repo, default_branch, last_synced_sha")
        .in("id", parentIds);
      // Checked, never discarded: a failed read here resolves every affected
      // clone to a HOLD rather than to prime, and a hold that happened because
      // nobody looked at the error is indistinguishable from one that was
      // decided.
      if (parentErr) {
        parentReadFailed = true;
        console.error(
          `[cascade] ${event.id}: could not read parent clones — every clone with a recorded parent is held this pass:`,
          parentErr.message,
        );
      }
      for (const row of parentRows ?? []) parentState.set(row.id, row as ParentCloneRow);
    }
  }

  /** Reasons, in the order the loop met them. Non-empty ⇒ the event is held. */
  const lineageHolds: string[] = [];

  // Bounded in time, and a stop is a pause rather than a death.
  //
  // A fleet event processes every queued clone in this one loop, inside one
  // hook invocation. Measured 2 Sep 2026: a first module-scope cascade to
  // `preflight-property-group` alone is 353 files, and with the mirror clone
  // and the pull-request handling beside it the pass outran the 60-second
  // window on every attempt — the isolate was cut, the results sat at
  // `pushing`, the 10-minute reclaim requeued them, the next claim spent an
  // attempt on the same read, and after three the event was dead with nothing
  // delivered. Asking the budget before each clone means a pass that cannot
  // fit another clone STOPS, leaves the rest `queued`, and hands the event
  // back for the next tick with the work it did kept.
  let attempted = 0;
  let slowestMs = 0;
  let stoppedEarly = false;
  let progressed = false;
  let deferred: { until: string; detail: string } | null = null;

  // Parents first, so a pass can deliver a parent and then its child in the
  // same run rather than holding the child for the next tick. With lineage off
  // the order is the query's, unchanged.
  const orderedRows = followsLineage
    ? orderByLineageDepth(
        queuedRows.map((r) => {
          const c = (r as { clones: { id: string; parent_clone_id: string | null } | null }).clones;
          return { id: c?.id ?? "", parent_clone_id: c?.parent_clone_id ?? null, row: r };
        }),
      ).map((entry) => entry.row)
    : queuedRows;

  for (const r of orderedRows) {
    if (attempted > 0 && opts?.budget?.isPastDeadline(slowestMs)) {
      stoppedEarly = true;
      break;
    }
    const cloneStartedAt = Date.now();
    const clone = (r as { clones: unknown }).clones as {
      id: string;
      name: string;
      github_owner: string;
      github_repo: string;
      default_branch: string;
      sync_scope: string | null;
      /**
       * What the clone held BEFORE this cascade. Read from the joined row,
       * which was fetched before the loop, so it is still the previous value
       * when the update below has already moved it — that is the whole point:
       * the backend catch-up needs the two revisions to diff between.
       */
      last_synced_sha: string | null;
      /** Which clone this one receives from. NULL ⇒ prime. */
      parent_clone_id: string | null;
    } | null;

    if (!clone) {
      await supabase
        .from("cascade_results")
        .update({
          status: "skipped",
          error_message: "Clone not found",
          completed_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      skipped++;
      continue;
    }

    const pinErrors = blockedClones.get(clone.id);
    if (pinErrors && pinErrors.length > 0) {
      await supabase
        .from("cascade_results")
        .update({
          status: "failed",
          error_message: `Pin validation failed: ${pinErrors.join("; ")}`,
          completed_at: new Date().toISOString(),
        })
        .eq("id", r.id);
      await supabase.from("clones").update({ sync_status: "failed" }).eq("id", clone.id);
      failed++;
      continue;
    }

    // Where does this clone read from? Decided BEFORE the row is marked
    // `pushing`, because a held clone must be left exactly as this pass found
    // it — `queued`, with its place in the queue and any prepared ledger kept.
    const sourceDecision = resolveCascadeSource({
      followsLineage,
      parentCloneId: clone.parent_clone_id,
      parent: clone.parent_clone_id ? (parentState.get(clone.parent_clone_id) ?? null) : null,
      parentReadFailed,
      primeSha: sourceSha,
    });

    if (sourceDecision.kind === "hold") {
      // Not `failed` and not `skipped`. Nothing went wrong and nothing was
      // decided about this clone's content — its parent simply does not carry
      // this commit yet. In `pr` mode that wait is a person's merge, so it can
      // outlive several passes; the event's own attempt ceiling is what
      // eventually puts it in front of somebody.
      lineageHolds.push(`${clone.name}: ${sourceDecision.why}`);
      const { error: holdError } = await supabase
        .from("cascade_results")
        .update({ error_message: sourceDecision.why })
        .eq("id", r.id);
      if (holdError) {
        throw new Error(
          `cascade ${event.id}: could not record ${clone.name}'s lineage hold: ${holdError.message}`,
        );
      }
      continue;
    }

    // The ref whose tree this clone copies, and its head. For prime this is
    // what every pass has always used; for a parent it is resolved here, the
    // same way and with the same failure classification.
    let readRef: RepoRef = primeRef;
    let readSha: string = sourceSha;
    let provenance: { label: string; deliveredSha: string } | undefined;

    if (sourceDecision.kind === "parent") {
      try {
        const { data: parentBranch } = await octokit.repos.getBranch({
          owner: sourceDecision.ref.owner,
          repo: sourceDecision.ref.repo,
          branch: sourceDecision.ref.branch,
        });
        readRef = sourceDecision.ref;
        readSha = parentBranch.commit.sha;
        provenance = { label: sourceDecision.label, deliveredSha: sourceSha };
      } catch (e) {
        // A source that cannot be READ is not a source that is empty. Holding
        // costs a tick; falling through to prime would deliver prime's whole
        // tree to a clone configured to receive its parent's filtered one.
        const why =
          `Could not read parent ${sourceDecision.ref.owner}/${sourceDecision.ref.repo}@` +
          `${sourceDecision.ref.branch}: ${e instanceof Error ? e.message : "unknown"}`;
        lineageHolds.push(`${clone.name}: ${why}`);
        const { error: holdError } = await supabase
          .from("cascade_results")
          .update({ error_message: why })
          .eq("id", r.id);
        if (holdError) {
          throw new Error(
            `cascade ${event.id}: could not record ${clone.name}'s unreadable parent: ${holdError.message}`,
          );
        }
        continue;
      }
    }

    await supabase
      .from("cascade_results")
      .update({ status: "pushing", started_at: new Date().toISOString() })
      .eq("id", r.id);

    try {
      // What an earlier pass already prepared, if the budget stopped it inside
      // this clone — or what the clone's LAST pass prepared, borrowed across
      // events. A blob created for prime@N is byte-identical for prime@N+1
      // wherever prime still holds the same blob at the path, and
      // `resumableBlobs` checks exactly that per entry; without the borrow,
      // every prime commit re-prepared the whole standing diff from scratch
      // (~300 files × 3 clones per commit through the September freeze), and
      // the App's hourly budget went to work already done.
      const ownRecord = (r as { progress?: unknown }).progress ?? null;
      const priorRecord = ownRecord ?? (await borrowLatestProgress(supabase, clone.id, r.id));
      // Progress is the LEDGER growing, not the blob count alone: a pass that
      // spent its whole tick settling deletion evidence prepared no blobs and
      // still moved the sweep forward. Counting only `prepared` made exactly
      // that pass read as "no progress", spend its attempt, and after three
      // ticks die inside a healthy convergence.
      const ledgerSize = (p: CascadeProgress | null) =>
        Object.keys(p?.prepared ?? {}).length + Object.keys(p?.deletion_evidence ?? {}).length;
      const priorPrepared = ledgerSize(readProgress(priorRecord));
      let preparedNow = priorPrepared;
      const patch = await processClone({
        octokit,
        // The ref this clone READS. `primeRef`/`sourceSha` unless its recorded
        // parent supplies it — `provenance` is what keeps the labels naming
        // the bytes and `delivered_sha` naming prime's commit.
        primeRef: readRef,
        sourceSha: readSha,
        provenance,
        mode: event.mode,
        clone,
        supabase,
        scopeFilter: event.scope_filter as Record<string, unknown> | null,
        // The list rides on the result row, written HERE rather than in
        // `processClone`, which stays write-free for the rehearsal's sake.
        resume: {
          progress: priorRecord,
          onProgress: async (progress) => {
            preparedNow = ledgerSize(progress);
            const { error: progressError } = await supabase
              .from("cascade_results")
              .update({ progress: progress as unknown as Json })
              .eq("id", r.id);
            if (progressError) {
              throw new Error(
                `cascade ${event.id}: could not record ${clone.name}'s progress: ${progressError.message}`,
              );
            }
          },
          budget: opts?.budget,
        },
      });

      if (patch.status === "queued") {
        // Paused inside this clone: the row keeps its list and its place in
        // the queue, and the event is handed back below.
        const { error: pauseError } = await supabase
          .from("cascade_results")
          .update(patch)
          .eq("id", r.id);
        if (pauseError) {
          throw new Error(
            `cascade ${event.id}: could not pause ${clone.name}: ${pauseError.message}`,
          );
        }
        if (preparedNow > priorPrepared) progressed = true;
        stoppedEarly = true;
        break;
      }

      // A finished pass KEEPS its list. The blobs it prepared exist in the
      // clone's repository whatever became of the proposal, and the next
      // event's pass — a different prime commit — reuses every entry whose
      // prime blob is still the one prime holds. Clearing here is what made
      // each of prime's ~50 daily commits a full re-preparation. An entry
      // that goes stale invalidates itself against the next pass's own tree
      // listing, and a blob GitHub has since garbage-collected fails the
      // tree write, which clears the list below and the pass after that
      // re-prepares fresh.
      await supabase.from("cascade_results").update(patch).eq("id", r.id);

      // Read off the patch, not off `passRows`: those rows were fetched
      // before this loop and still carry the pre-run `diff_summary`.
      if (summaryOwesReconcile((patch as { diff_summary?: string | null }).diff_summary)) {
        owedReconcile++;
      }

      if (patch.status === "succeeded") succeeded++;
      else if (patch.status === "pr_opened") opened++;
      else if (patch.status === "failed") failed++;
      else if (patch.status === "skipped") skipped++;

      if (patch.status === "succeeded" || patch.status === "pr_opened") {
        // Read before the update below overwrites it.
        const previousSha = clone.last_synced_sha ?? null;
        await supabase
          .from("clones")
          .update({
            sync_status: patch.status === "succeeded" ? "in_sync" : "cascading",
            // PRIME's commit, whatever repository the bytes were read from.
            // `last_synced_sha` means "the prime revision this clone carries"
            // to the merge drain, the drift beacon and the convergence audit,
            // and it is the readiness test a child's hold is decided on — so
            // it composes to any depth only while it keeps that one meaning.
            last_synced_sha: patch.status === "succeeded" ? sourceSha : undefined,
            last_cascade_at: new Date().toISOString(),
            commits_behind: patch.status === "succeeded" ? 0 : undefined,
          })
          .eq("id", clone.id);

        // A parent delivered THIS pass unblocks its children in THIS pass.
        // Without this the in-memory row still reads its pre-cascade SHA and
        // every child would hold for a tick that had nothing left to wait for.
        if (patch.status === "succeeded" && parentState.has(clone.id)) {
          const stale = parentState.get(clone.id)!;
          parentState.set(clone.id, { ...stale, last_synced_sha: sourceSha });
        }

        // Code reached the clone's default branch — rebuild what serves it.
        //
        // `succeeded` only, never `pr_opened`: a pull request is a proposal, and
        // the branch the deployment builds from does not have the change on it
        // yet. Rebuilding here would produce an identical artefact and tell an
        // operator the change had shipped.
        //
        // Vercel rebuilds on push by itself ONLY where its GitHub App is
        // installed on the repository. Mission Control forks clones through its
        // own App and never installs Vercel's, so on this fleet nothing else
        // asks. `requestRedeployAfterPush` decides whether the clone's state
        // makes a rebuild appropriate and never throws — a cascade that pushed
        // correctly must not report as failed because a hosting row could not be
        // updated.
        if (patch.status === "succeeded") {
          try {
            const { requestRedeployAfterPush } = await import("@/server/hosting/redeploy.server");
            await requestRedeployAfterPush({
              cloneId: clone.id,
              reason: `cascade ${event.id}`,
              sha: sourceSha,
            });
          } catch (e) {
            console.error("[cascade] redeploy request failed:", e);
          }

          // The same sentence, about the other half of the deployment.
          //
          // Edge functions and migrations rode in on this very push and
          // nothing deploys them: the clone's own workflow needs a
          // repository secret it does not have, and Mission Control — which
          // holds the credential and already has both lanes — was never asked.
          // A rebuilt frontend over a stale backend is worse than neither,
          // because the two halves are then from different revisions.
          //
          // Plans work; it does not do it. The self-healing lanes execute,
          // under the destructiveness gate they already enforce.
          try {
            const { requestBackendSyncAfterCascade } = await import("@/server/backendSync.server");
            await requestBackendSyncAfterCascade({
              cloneId: clone.id,
              reason: `cascade ${event.id}`,
              fromSha: previousSha,
              toSha: sourceSha,
            });
          } catch (e) {
            console.error("[cascade] backend sync request failed:", e);
          }
        }
      } else if (patch.status === "skipped" && patch.delivered_sha && !patch.pr_url) {
        // A verified no-op advances the pointer exactly as a merge does.
        // The pass resolved prime's head, compared trees, and found nothing
        // owed — "already in sync", or every difference withheld by this
        // clone's own policy — which is the same verification a merge gets,
        // taken by effect seconds ago. This is what lets a clone stamped
        // from a folded carrier's provenance read true again through the
        // engine's own machinery rather than a hand-edited ledger.
        //
        // `pr_url` excludes the "already proposed" skip: that row's claim
        // is conditional on a standing pull request, and reconciliation
        // flips it to `succeeded` when the proposal lands, where
        // `advanceClone` reads its delivered head.
        //
        // No redeploy and no backend sync: nothing reached the branch.
        if (clone.last_synced_sha !== patch.delivered_sha) {
          await supabase
            .from("clones")
            .update({
              sync_status: "in_sync",
              last_synced_sha: patch.delivered_sha,
              commits_behind: 0,
              last_cascade_at: new Date().toISOString(),
            })
            .eq("id", clone.id);
        }
      } else if (patch.status === "failed") {
        await supabase.from("clones").update({ sync_status: "failed" }).eq("id", clone.id);
      }
    } catch (e) {
      // A rate limit is a window, not a verdict. Measured 2 Sep 2026 at
      // 13:19:50: event 844df9e5 failed all three clones on "API rate limit
      // exceeded for installation ID 157200201", and a failed event is never
      // claimed again — so the prime commit it carried would have reached no
      // clone without a person re-arming the row. The clone goes back to
      // `queued`, the loop stops (every clone after it would hit the same
      // limit and spend what little is left), and the event waits for the
      // reset GitHub named.
      const failure = classifyGitHubFailure(e);
      if (failure.kind === "rate_limited") {
        const { error: requeueError } = await supabase
          .from("cascade_results")
          .update({
            status: "queued",
            started_at: null,
            error_message: `Deferred until ${failure.until}: ${e instanceof Error ? e.message : String(e)}`,
          })
          .eq("id", r.id);
        if (requeueError) {
          throw new Error(
            `cascade ${event.id}: could not requeue ${clone.name} after a rate limit: ${requeueError.message}`,
          );
        }
        deferred = { until: failure.until, detail: failure.detail };
        break;
      }
      failed++;
      await supabase
        .from("cascade_results")
        .update({
          status: "failed",
          error_message: e instanceof Error ? e.message : String(e),
          completed_at: new Date().toISOString(),
          // A tree write that names a blob GitHub no longer holds means the
          // reuse list has outlived its objects (unreferenced blobs are
          // eventually collected). The list caused the failure, so the list
          // goes with it — the next pass re-prepares fresh instead of failing
          // on the same stale SHA for ever.
          ...(isStaleObjectError(e) ? { progress: null } : {}),
        })
        .eq("id", r.id);
      await supabase.from("clones").update({ sync_status: "failed" }).eq("id", clone.id);
    }
    attempted++;
    slowestMs = Math.max(slowestMs, Date.now() - cloneStartedAt);
  }

  // Handed back rather than finished. The event is `pending` again with the
  // moment it may next be claimed, and the summary says what was done and why
  // it stopped, so the row is never a silent `running` and never a false
  // `completed`. The counts below are NOT written: a partial tally rendered as
  // a final one is how "1 of 3" comes to read as the whole fleet.
  if (deferred || stoppedEarly || lineageHolds.length > 0) {
    const done = succeeded + opened + failed + skipped;
    const total = queuedRows.length;

    // A lineage hold is PACED, not retried on the next tick, and it reports as
    // a deferral rather than a pause. Both halves matter: the drain spends an
    // attempt per claim and refunds only a deferral or a pass that delivered
    // something, so a `pr`-mode wait on a person's merge reported as a pause
    // would exhaust `FOLD_MAX_ATTEMPTS` in three minutes and fail an event
    // whose parent proposal was open and perfectly healthy.
    //
    // A budget pause still wins where both happened: that pass has work it can
    // do right now, and waiting five minutes to do it would be slower for no
    // reason.
    const lineageUntil =
      lineageHolds.length > 0 && !deferred && !stoppedEarly
        ? new Date(Date.now() + LINEAGE_HOLD_RETRY_MS).toISOString()
        : null;

    const summary = deferred
      ? describeDeferral({ until: deferred.until, detail: deferred.detail, done, total })
      : stoppedEarly
        ? describePause({ done, total })
        : describeLineageHold({
            held: lineageHolds.length,
            done,
            total,
            firstReason: lineageHolds[0],
            until: lineageUntil!,
          });
    const held = await updateEvent(
      {
        status: "pending",
        worker_started_at: null,
        next_attempt_at: deferred ? deferred.until : (lineageUntil ?? new Date().toISOString()),
        summary: withRefreshNote(summary),
      },
      "hold the event for its next pass",
    );
    if (!held) return { ok: false, error: "claim superseded — nothing written" };
    if (deferred) return { ok: true, status: "deferred", until: deferred.until, done, total };
    if (lineageUntil) return { ok: true, status: "deferred", until: lineageUntil, done, total };
    return { ok: true, status: "resuming", done, total, progressed };
  }

  const totalQueued = passRows.length;
  const finalStatus = cascadeEventStatus({ succeeded, opened, failed });
  // A cascade can do everything asked of it and still leave a clone unable to
  // go green, because a `manual_reconcile` path moved upstream and was held
  // back by design. That is not a failure of the cascade and it is not a
  // success either: it is work owed to a person, and reporting it as
  // `completed · success` is what left a clone red for twelve hours with the
  // explanation sitting unread in a pull request body.
  //
  // Composed by `summariseCascade` rather than here, because the engine is no
  // longer the only writer: a pull request that lands later is reconciled by
  // `cascadeMergeDrain`, which recounts this line. Two copies of the format is
  // how "0 merged" and "1 merged" come to be rendered in two different shapes.
  const summary = summariseCascade({
    succeeded,
    opened,
    failed,
    skipped,
    total: totalQueued,
    owedReconcile,
  });

  const finished = await updateEvent(
    {
      status: finalStatus,
      completed_at: new Date().toISOString(),
      summary: withRefreshNote(summary),
    },
    "record the final tally",
  );
  // A superseded pass records nothing else either: the notification, the
  // audit row and the clone summaries below all describe THIS pass's counts,
  // and a newer claim's pass is the one whose counts are true.
  if (!finished) return { ok: false, error: "claim superseded — nothing written" };

  // Through the helper rather than a bare insert: it checks the error and logs
  // it. A discarded audit write is a record that silently does not exist.
  const { writeAuditLog } = await import("@/server/audit.server");
  await writeAuditLog({
    action: "cascade.executed",
    entityType: "cascade_event",
    entityId: event.id,
    metadata: { mode: event.mode, succeeded, opened, failed, skipped, owedReconcile },
  });

  const kind =
    finalStatus === "completed"
      ? "cascade_completed"
      : finalStatus === "failed"
        ? "cascade_failed"
        : "cascade_partial";
  // `finalStatus` is deliberately untouched — the run did complete, and
  // collapsing "owes a human" into "failed" would make the two unreadable.
  // Severity is the attention channel, so that is what changes.
  const severity =
    finalStatus === "failed"
      ? "error"
      : finalStatus === "completed" && owedReconcile === 0
        ? "success"
        : "warning";

  // Not `notifyOperators()`: that helper has no `cascade_event_id`, and the
  // link from a notification back to its run is the whole point of this one.
  // So the error is checked here instead, the same way the helper checks it.
  const { error: notifyError } = await supabase.from("notifications").insert({
    kind,
    severity,
    title: `Cascade ${finalStatus} (${event.mode})`,
    body: summary,
    cascade_event_id: event.id,
    url: `/cascades/${event.id}`,
    metadata: { mode: event.mode, succeeded, opened, failed, skipped, owedReconcile },
  });
  if (notifyError) {
    console.error(`[cascade] could not raise the ${kind} notification:`, notifyError.message);
  }

  type NotifInsert = Database["public"]["Tables"]["notifications"]["Insert"];
  const cloneNotifs: NotifInsert[] = [];
  for (const r of passRows) {
    const clone = (r as { clones: { id: string; name: string } | null }).clones;
    if (!clone) continue;
    cloneNotifs.push({
      kind,
      severity,
      title: `${clone.name} · ${event.mode.replace("_", " ")}`,
      body: summary,
      clone_id: clone.id,
      cascade_event_id: event.id,
      url: `/cascades/${event.id}`,
      metadata: { mode: event.mode },
    });
  }
  if (cloneNotifs.length > 0) {
    await supabase.from("notifications").insert(cloneNotifs);
  }

  return {
    ok: true,
    status: finalStatus,
    counts: { succeeded, opened, failed, skipped, total: totalQueued },
  };
}

/**
 * Rebuild one clone's open cascade proposal on the branch as it now stands.
 *
 * This is the repair path for a conflicted proposal, and it is deliberately
 * not a new mechanism: it runs the SAME `processClone` an ordinary cascade
 * runs, which reads the clone's current head, re-partitions against the
 * clone's exclusions, re-runs both held-file guards, finds the open proposal
 * and force-updates it. A conflict cannot survive that, because the rebuilt
 * commit's parent IS the branch head — see `cascade/proposalRepair.pure.ts`.
 *
 * It re-bases and never RE-SCOPES. `sourceSha` is the prime commit the
 * proposal already promised, so the rebuilt proposal delivers exactly what its
 * cascade event says it delivers. Quietly upgrading the payload to prime's
 * latest would be one CI run cheaper and would make `cascade_events.source_sha`
 * describe something that event never carried.
 *
 * The caller owns the safety check. `processClone` force-updates the proposal
 * branch, so calling this on a branch somebody has committed to destroys their
 * work — `decideProposalRepair` is what stands in front of it.
 */
export async function regenerateCloneProposal(args: {
  supabase: SupabaseLike;
  octokit: ReturnType<typeof getAppOctokit>;
  cloneId: string;
  /** The prime SHA this proposal already promised. Never prime's latest. */
  sourceSha: string;
  mode: Database["public"]["Enums"]["cascade_mode"];
}): Promise<CascadeResultUpdate> {
  const { supabase, octokit, cloneId, sourceSha, mode } = args;

  const [primeRes, cloneRes] = await Promise.all([
    supabase.from("prime_config").select("*").limit(1).maybeSingle(),
    supabase
      .from("clones")
      .select("id, name, github_owner, github_repo, default_branch, sync_scope")
      .eq("id", cloneId)
      .maybeSingle(),
  ]);
  if (primeRes.error) throw new Error(`Could not read prime config: ${primeRes.error.message}`);
  if (cloneRes.error) throw new Error(`Could not read clone ${cloneId}: ${cloneRes.error.message}`);

  const prime = primeRes.data;
  if (!prime?.github_owner || !prime?.github_repo) {
    throw new Error("Prime not configured — nothing to rebuild a proposal from");
  }
  const clone = cloneRes.data;
  if (!clone?.github_owner || !clone?.github_repo) {
    throw new Error(`Clone ${cloneId} has no repository`);
  }

  return processClone({
    octokit,
    primeRef: {
      owner: prime.github_owner,
      repo: prime.github_repo,
      branch: prime.default_branch || "main",
    },
    sourceSha,
    mode,
    clone: {
      id: clone.id,
      name: clone.name ?? clone.github_repo,
      github_owner: clone.github_owner,
      github_repo: clone.github_repo,
      default_branch: clone.default_branch || "main",
      sync_scope: clone.sync_scope,
    },
    supabase,
    // A repair carries no scope filter of its own: the clone's own installed
    // modules and exclusions decide what it receives, exactly as on the run
    // that opened the proposal.
    scopeFilter: null,
  });
}

/**
 * One clone's cascade, decided and then written.
 *
 * Exported for the dry run, which calls it with `dryRun: true` so a rehearsal
 * and the real thing are one implementation rather than two that agree on a
 * good day.
 */
export async function processClone(args: {
  octokit: ReturnType<typeof getAppOctokit>;
  primeRef: RepoRef;
  sourceSha: string;
  mode: Database["public"]["Enums"]["cascade_mode"];
  clone: {
    id: string;
    name: string;
    github_owner: string;
    github_repo: string;
    default_branch: string;
    sync_scope: string | null;
  };
  supabase: SupabaseLike;
  scopeFilter: Record<string, unknown> | null;
  /**
   * Decide everything and write nothing. No blob, no tree, no commit, no
   * branch, no pull request, no issue — and `processClone` never writes to the
   * database on any path, so a dry run leaves GitHub and Mission Control
   * exactly as it found them.
   */
  dryRun?: boolean;
  /** Called with the decision, on the real path and the dry one alike. */
  onPlan?: (plan: ClonePlan) => void;
  /**
   * Carry a pass across invocations. Real path only: the engine supplies it
   * from `executeCascade` and never from a rehearsal, and `processClone`
   * itself still writes nothing — the list goes out through `onProgress`.
   * See `cascade/passProgress.pure.ts`.
   */
  resume?: {
    progress: unknown;
    onProgress: (progress: CascadeProgress) => Promise<void>;
    budget?: CascadeBudget;
  };
  /**
   * Set ONLY when this clone reads from its recorded parent rather than from
   * prime (`clones.parent_clone_id`, `prime_config.cascade_follows_lineage`).
   * Absent — every caller before lineage existed, and every clone that still
   * reads prime — leaves this function byte-identical to what it was.
   *
   * It exists because `sourceSha` does two jobs that only diverge here:
   *
   *  - it is the head of the ref being READ, which is what every label should
   *    name, and which for a routed child is the PARENT'S head; and
   *  - it is the prime revision being DELIVERED, which is what
   *    `delivered_sha` means to everything downstream —
   *    `cascadeMergeDrain.advanceClone` walks a clone's pointer to it and
   *    compares it against `cascade_events.source_sha`, prime's own.
   *
   * Collapsing the two would either label a child's pull request `prime@<a
   * sha prime never held>` or move its sync pointer onto a commit prime does
   * not have. So the label follows the bytes and the ledger follows prime.
   */
  provenance?: {
    /** The repository the bytes came from, as a reader should see it named. */
    label: string;
    /** The PRIME commit this delivery carries, whatever repo it was read from. */
    deliveredSha: string;
  };
}): Promise<CascadeResultUpdate> {
  const { octokit, primeRef, sourceSha, mode, clone, supabase, scopeFilter } = args;
  const dryRun = args.dryRun === true;

  /** What a label names. `prime` unless this clone read from its parent. */
  const sourceLabel = args.provenance?.label ?? "prime";
  /** What the ledger records. Always a PRIME commit. */
  const deliveredSha = args.provenance?.deliveredSha ?? sourceSha;

  const isMirror = clone.sync_scope === "mirror";

  // ── The boundary this delivery crosses ───────────────────────────────────
  //
  // Keyed on the two repositories, which is what this function holds on both
  // sides: `primeRef.repo` is already the PARENT'S repository for a clone
  // routed by lineage, so a child's membrane is the one on ITS edge rather
  // than the one prime sits behind. An edge the registry does not name
  // resolves to the standing organs and no new opinion, so every clone that
  // existed before this behaves exactly as it did.
  const membrane = membraneInto(clone.github_repo, primeRef.repo);

  // Read what this clone is allowed to receive BEFORE deciding anything else.
  //
  // Fail-closed by construction: `requireExclusions` throws when the query
  // errored or returned nothing at all, and `processClone`'s caller records the
  // throw as a failed cascade_result. A cascade that ran without its guard
  // rails cannot be undone by noticing afterwards -- see the module header.
  const exclusionRes = await supabase
    .from("clone_sync_exclusions")
    .select("pattern, reason, note")
    .eq("clone_id", clone.id);
  const exclusions = requireExclusions(
    clone.id,
    exclusionRes.data as SyncExclusion[] | null,
    exclusionRes.error,
  );
  if (isMirror) assertMirrorPolicy(clone.id, exclusions);

  // This clone's own Supabase project, for `backendIdentityHold` below.
  //
  // Read through the safe view, and read leniently on purpose: a clone with no
  // registered backend is an ordinary state (nothing has been provisioned yet),
  // and it must not stop a cascade. What it does is make every project ref
  // unresolvable rather than benign — see that function's header. So a missing
  // row and a failed read land in the same place, which is the strict one.
  const backendRes = await supabase
    .from("clone_backends_safe")
    .select("supabase_project_ref")
    .eq("clone_id", clone.id)
    .maybeSingle();
  const ownProjectRef =
    (backendRes.data as { supabase_project_ref: string | null } | null)?.supabase_project_ref ??
    null;

  // Module-sync cascades pin the file_globs to a single module so the push
  // only touches that module's files, not every installed module on the clone.
  // Always run overrides through validateModuleGlobs — the pinning caller
  // could hand us anything (module row, dry-run payload, webhook body).
  const rawOverride = Array.isArray(scopeFilter?.module_globs)
    ? (scopeFilter!.module_globs as unknown[]).filter((g): g is string => typeof g === "string")
    : null;
  const overrideGlobs = rawOverride ? validateModuleGlobs(rawOverride).valid : null;
  if (rawOverride && overrideGlobs && overrideGlobs.length !== rawOverride.length) {
    console.warn(
      `[cascade] dropped ${rawOverride.length - overrideGlobs.length} unsafe override glob(s) for clone ${clone.id}`,
    );
  }

  let installedGlobs: string[];
  let pinSummary: string | null = null;
  if (overrideGlobs && overrideGlobs.length > 0) {
    installedGlobs = overrideGlobs;
  } else {
    // One reader for both lanes — see `cascade/installedGlobs.server.ts`,
    // which also carries the library-pin rule that used to be written here.
    // The engine reads it leniently, exactly as it did inline: `failed` is the
    // lateral lane's to act on, and a partial list here still delivers nothing
    // the clone did not install.
    const installed = await readInstalledGlobs(supabase, clone.id);
    installedGlobs = installed.globs;
    pinSummary = installed.pinSummary;
  }

  if (!isMirror && installedGlobs.length === 0) {
    return {
      status: "skipped",
      diff_summary: "No installed modules — nothing to cascade",
      completed_at: new Date().toISOString(),
    };
  }

  const cloneRef: RepoRef = {
    owner: clone.github_owner,
    repo: clone.github_repo,
    branch: clone.default_branch || "main",
  };

  let cloneBranchSha: string;
  try {
    const { data: br } = await octokit.repos.getBranch({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      branch: cloneRef.branch,
    });
    cloneBranchSha = br.commit.sha;
  } catch (e) {
    throw new Error(
      `Clone ${cloneRef.owner}/${cloneRef.repo}@${cloneRef.branch} unreachable: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }

  // ── Which paths are candidates ────────────────────────────────────────────
  //
  // A module-scoped clone asks the globs of what it installed. A MIRROR asks
  // git: two recursive tree reads, and a path is a candidate when prime's blob
  // SHA differs from the clone's or the clone has no such blob. Content is then
  // fetched only for those, which is what makes a whole-tree cascade affordable
  // (see `listTreeEntries`).
  //
  // A path present in the clone and absent from prime is a CANDIDATE for
  // deletion and never on its own a reason to delete: the clone legitimately
  // carries files of its own -- its isolation spec, its transfer scripts -- and
  // a mirror that pruned "everything prime lacks" would remove the very things
  // that make it a clone rather than a copy. Prime's own history settles which
  // is which (`cascadeDeletions.server.ts`), and the clone's copy has to be
  // byte-identical to some version prime itself held before anything is removed.
  //
  // BOTH scopes, and the difference is where "the clone's section of prime"
  // stops. A mirror's section is the whole tree. A module-scoped clone's is the
  // globs of what it installed — so a file it holds INSIDE those globs that
  // prime no longer has is a deletion, and a file outside them is none of the
  // cascade's business and is never even a candidate.
  let candidatePaths: string[];
  let scopeLabel: string;
  let onlyInClone = 0;
  const deletionCandidates: Array<{ path: string; cloneSha: string }> = [];
  /** Directories prime's tree contains. Probe ORDER only — never a verdict. */
  const primeDirectories = new Set<string>();
  /**
   * The clone's blob SHA for every path it holds, when BOTH trees were listed
   * complete — the answer to "does the clone already have these bytes?" for
   * every candidate, paid for once. `null` when either listing was truncated,
   * in which case the prepare step reads the clone's copy per path as before:
   * a truncated tree cannot say a file is absent, only that it was not listed.
   */
  let cloneShaByPath: ReadonlyMap<string, string> | null = null;
  /** Prime's blob SHA per path, when its listing was complete. */
  let primeShaByPath: ReadonlyMap<string, string> | null = null;
  if (isMirror) {
    const [primeTree, cloneTree] = await Promise.all([
      listTreeEntries(octokit, primeRef),
      listTreeEntries(octokit, cloneRef),
    ]);
    // A truncated tree read as complete looks exactly like a clone that is
    // already in sync, which is the most expensive way for this to be wrong.
    if (primeTree.truncated || cloneTree.truncated) {
      throw new Error(
        `Tree listing truncated (prime=${primeTree.truncated}, clone=${cloneTree.truncated}); ` +
          `refusing to cascade a partial mirror`,
      );
    }
    candidatePaths = [];
    for (const [path, sha] of primeTree.entries) {
      if (cloneTree.entries.get(path) !== sha) candidatePaths.push(path);
    }
    cloneShaByPath = cloneTree.entries;
    primeShaByPath = primeTree.entries;
    for (const [path, sha] of cloneTree.entries) {
      if (!primeTree.entries.has(path)) {
        onlyInClone++;
        deletionCandidates.push({ path, cloneSha: sha });
      }
    }
    for (const path of primeTree.entries.keys()) primeDirectories.add(directoryOf(path));
    scopeLabel = "mirror";
  } else {
    /*
      INSTALLED MODULES, PLUS WHAT THE REPOSITORY NEEDS WHATEVER IS INSTALLED.

      A module's globs are drawn around a FEATURE; the prime's CI is drawn
      around the REPOSITORY. A module-scoped clone runs that CI and receives
      only the feature, so every check whose inputs cross a glob boundary is
      permanently red on it and nothing the cascade can send will ever fix it.

      Measured 8 Sep 2026 on `npc-test-76b3b3` (22 modules): three red checks,
      all three this. `supabase/functions/_shared/integrationSecrets.ts` is
      inside a module's globs and cascaded; `src/lib/integrations/registry.ts`,
      the source it is GENERATED from, is inside none and had never cascaded
      once — last written by "Initial commit" on 1 September. The clone
      regenerates from its own stale source and correctly reports a mismatch.
      `package-lock.json` and `docs/security/SECURITY_INVENTORY.json` are the
      same shape. `npc-client-dashboard`, a mirror, is green on all three.

      See `repositoryInvariants.pure.ts` for the list and the reason attached
      to each entry.

      ONE listing, not two. The widened set is fetched and the module's own
      section is then recovered from it locally, because the narrow set is
      still what decides DELETIONS and the two must not be confused.
    */
    const { REPOSITORY_INVARIANTS, globsForModuleScopedClone } =
      await import("@/server/cascade/repositoryInvariants.pure");
    candidatePaths = await listFilesMatchingGlobs(
      octokit,
      primeRef,
      globsForModuleScopedClone(installedGlobs),
    );
    scopeLabel = `installed modules + ${REPOSITORY_INVARIANTS.length} repository invariant(s)`;
    /*
      Every prime path inside the INSTALLED globs — the module's whole section,
      and deliberately NOT the widened set.

      This is the deletion question's input, and an invariant must never widen
      it. A repository invariant says "the clone needs prime's copy of this";
      it says nothing about removing a file prime lacks, and a `scripts/**`
      entry that also authorised deletion would put the clone's own tooling
      inside the destructive half of a pass that was only ever asked to add.
      Invariants widen what is SENT; they never widen what is REMOVED.
    */
    const primeInScope = await (async () => {
      const { validateModuleGlobs: v, globToRegex: g } = await import("@/lib/module-globs");
      const matchers = v(installedGlobs).valid.map(g);
      return new Set(candidatePaths.filter((path) => matchers.some((m) => m.test(path))));
    })();

    // Both trees, read once. The mirror branch above diffs the two trees and
    // reads content only for paths whose blob SHAs differ; this branch used to
    // list the module's section on prime and then read the PRIME copy and the
    // CLONE copy of every file in it, unchanged ones included, before deciding
    // anything. Measured 2 Sep 2026 on `preflight-property-group`: 7,923 files
    // in the clone, thousands inside its modules, two content reads each — the
    // pass died every time and the event burned its three claims without a
    // result row ever starting. A tree listing is one request; the SHAs in it
    // are hashes of the bytes, so a path whose SHA matches needs no read.
    let primeTree: Awaited<ReturnType<typeof listTreeEntries>>;
    let cloneTree: Awaited<ReturnType<typeof listTreeEntries>>;
    try {
      [primeTree, cloneTree] = await Promise.all([
        listTreeEntries(octokit, primeRef),
        listTreeEntries(octokit, cloneRef),
      ]);
    } catch (e) {
      throw new Error(
        `Cannot read the prime or clone tree for ${cloneRef.owner}/${cloneRef.repo}: ${e instanceof Error ? e.message : "unknown"}`,
      );
    }
    // A truncated tree cannot say a file is unchanged — it may simply not have
    // been listed — so the narrowing is skipped and every path is read, as
    // before. The safe direction costs requests; the other loses a file.
    if (!primeTree.truncated && !cloneTree.truncated) {
      candidatePaths = candidatePaths.filter(
        (path) => cloneTree.entries.get(path) !== primeTree.entries.get(path),
      );
      cloneShaByPath = cloneTree.entries;
      primeShaByPath = primeTree.entries;
    }

    // The clone's own tree, read for one more reason: a module-scoped cascade
    // otherwise only ever learns what prime HAS, so a file prime removed from
    // an installed module stays on the clone for ever.
    //
    // The glob set is re-validated here rather than trusted. `listFilesMatching
    // Globs` validates its own copy before building matchers, and a deletion
    // decided by an unvalidated pattern could reach outside the module in the
    // one direction that destroys something. The deletion question is asked
    // against the module's WHOLE section on prime (`primeInScope`), never the
    // narrowed candidate list: a file prime holds unchanged is not one prime
    // removed.
    const { validateModuleGlobs, globToRegex } = await import("@/lib/module-globs");
    const { valid } = validateModuleGlobs(installedGlobs);
    if (valid.length > 0) {
      const matchers = valid.map(globToRegex);
      // A truncated tree read looks exactly like a clone holding fewer files
      // than it does, which here means silently missing every deletion past the
      // cut. Refusing the deletion pass is the safe half of that.
      if (!cloneTree.truncated) {
        for (const [path, sha] of cloneTree.entries) {
          if (primeInScope.has(path)) continue;
          if (!matchers.some((rx) => rx.test(path))) continue;
          onlyInClone++;
          deletionCandidates.push({ path, cloneSha: sha });
        }
      }
      for (const path of primeInScope) primeDirectories.add(directoryOf(path));
    }
  }

  /*
    A PAYLOAD MUST CONTAIN WHAT IT IMPORTS.

    A module's globs are drawn around a FEATURE; an import crosses whatever
    boundary it needs to. So a payload built from globs alone is not
    import-closed, and the first unresolved import fails the WHOLE build — the
    proposal stays open with correct content and a red deployment, which is
    what happened to `npc-test-76b3b3` #11 and `preflight-property-group` #12
    for a day and a half:

        [vite:load-fallback] Could not load src/lib/calendar/bookingNotifications.pure
          (imported by src/pages/Calendar.tsx)

    The cascade had sent `Calendar.tsx` and had never sent what it imports.

    THIS RUNS BEFORE `partitionCascadePaths`, and that placement is the whole
    safety argument. A hand repair of the same defect on 9 Sep compared blobs
    against prime WITHOUT consulting the exclusions and overwrote
    `src/App.tsx` on one clone — a protected path that pins its client-facing
    mode. Feeding the closure's additions through the same partition every
    other candidate goes through makes that class of mistake impossible here:
    a closure can propose a protected path, and the guard rail still removes
    it. `differs from prime` and `should be replaced by prime` are different
    questions, and only the exclusion list answers the second.

    Content is read only for the SOURCE files already in the candidate list —
    which the tree comparison has narrowed to paths whose blob actually
    differs, so this is bounded by the size of the diff and not by the size of
    the repository. Each round widens the frontier, so newly-found files get
    their own imports read; four rounds is generous for a graph that converged
    in two on both clones, and the ceiling inside `closeOverImports` is what
    stops a runaway becoming a whole-repository proposal.
  */
  /**
   * The import closure, as a function, because it is asked TWICE.
   *
   * Its own comment calls its placement "the whole safety argument": a module
   * may not cross without what it imports. It ran once, over the paths this
   * clone's modules put in scope — and a subject the carry brings in behind a
   * spec is a delivered module that never met it, so it arrived without its
   * imports and no later round could notice. Null where the trees could not
   * be listed, which is the same condition the block below already answers to.
   */
  let importClosure:
    | ((seed: readonly string[], alreadyHave: ReadonlySet<string>) => Promise<string[]>)
    | null = null;

  if (primeShaByPath !== null && cloneShaByPath !== null) {
    const { closeOverImports } = await import("@/server/cascade/importClosure.pure");
    // Captured as consts so the narrowing survives into the closure below.
    const primeTree = primeShaByPath;
    const cloneTree = cloneShaByPath;
    const WALKABLE = /\.[cm]?[jt]sx?$/;
    const primeText = new Map<string, string>();
    const readInto = async (paths: readonly string[]) => {
      await mapWithConcurrency(
        paths.filter((p) => WALKABLE.test(p) && !primeText.has(p)),
        8,
        async (path) => {
          try {
            const f = await getFileContent(octokit, primeRef, path, {
              maxBytes: CASCADE_MAX_FILE_BYTES,
            });
            // Binary is never walked: a lossy reading of bytes that were never
            // text cannot contain an import, and asking is how a guard starts
            // reporting nonsense.
            if (f && !f.binary) primeText.set(path, f.content);
          } catch {
            // Unreadable is carried, not fatal. Refusing the whole closure
            // over one oversize blob would throw away every path it found.
          }
        },
      );
    };

    const closeOver = async (
      seed: readonly string[],
      alreadyHave: ReadonlySet<string>,
    ): Promise<string[]> => {
      let added: string[] = [];
      let frontier: readonly string[] = seed;
      for (let round = 0; round < 4 && frontier.length > 0; round += 1) {
        await readInto([...frontier]);
        const r = closeOverImports({
          seed: [...seed, ...added],
          prime: primeTree,
          clone: cloneTree,
          readPrime: (path) => primeText.get(path),
        });
        const fresh = r.added.filter((path) => !alreadyHave.has(path));
        const before = added.length;
        added = [...new Set([...added, ...fresh])];
        frontier = added.slice(before);
        if (r.truncated) break;
      }
      return added;
    };
    importClosure = closeOver;

    const closureAdded = await closeOver(candidatePaths, new Set(candidatePaths));
    if (closureAdded.length > 0) {
      candidatePaths = [...candidatePaths, ...closureAdded];
      scopeLabel = `${scopeLabel} + ${closureAdded.length} imported module(s)`;
    }
  }

  // The guard rail. Applied in BOTH scopes: a module glob that grows to cover
  // `src/integrations/**` would otherwise reach the clone's backend identity
  // by a different route than the one this was written for.
  const partition = partitionCascadePaths(candidatePaths, exclusions);

  // ── Recorded operator approvals for this clone ────────────────────────────
  //
  // Two of the engine's own refusals end in "a person has to decide", and
  // `cascade_path_approvals` is where the decision lives: `overwrite` releases
  // one held `manual_reconcile` path, `bulk_deletion` admits a deletion set
  // past the cap. Read FAIL-SAFE, not fail-closed: an approval only ever
  // WIDENS what a pass may do, so an unreadable table means no approvals and
  // the pass runs exactly as it would have before the table existed.
  const overwriteApproved = new Set<string>();
  const deletionApproved = new Set<string>();
  {
    const approvalsRes = await supabase
      .from("cascade_path_approvals")
      .select("kind, path")
      .eq("clone_id", clone.id)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString());
    if (approvalsRes.error) {
      console.warn(
        `[cascade] approvals unreadable for clone ${clone.id} — proceeding with none: ${approvalsRes.error.message}`,
      );
    }
    for (const row of (approvalsRes.data ?? []) as Array<{ kind: string; path: string }>) {
      if (row.kind === "overwrite") overwriteApproved.add(row.path);
      else if (row.kind === "bulk_deletion") deletionApproved.add(row.path);
    }
  }

  // ── The pass's ledger, opened before the first paid question ─────────────
  //
  // What a previous pass already prepared and already settled, reusable
  // wherever the fact it recorded still holds: a blob while prime still
  // holds the blob it was made from, a probe answer while the clone still
  // holds the blob it was asked about. Real path only: a rehearsal reuses
  // nothing and records nothing. Constructed HERE — above the HOLD probes,
  // which are the first paid question a pass asks: re-walking the same held
  // paths every pass was measured at ~90 calls and ~30 seconds of fixed
  // cost, which pushed every working tick past the 60-second isolate window.
  const resume = dryRun ? undefined : args.resume;
  const priorProgress = resume ? readProgress(resume.progress) : null;
  const known = resume ? resumableBlobs(priorProgress, primeShaByPath) : new Map<string, string>();
  const knownEvidence = resume
    ? resumableDeletionEvidence(priorProgress, cloneShaByPath ?? null)
    : new Map<string, SettledDeletionEvidence>();
  const knownHeldEvidence = resume
    ? resumableHeldEvidence(priorProgress, cloneShaByPath ?? null)
    : new Map<string, SettledHeldEvidence>();
  const evidenceLedger: Record<string, DeletionEvidenceEntry> = {};
  const heldLedger: Record<string, HeldEvidenceEntry> = {};
  const progress: CascadeProgress = {
    version: 1,
    source_sha: sourceSha,
    prepared: {},
    deletion_evidence: evidenceLedger,
    held_evidence: heldLedger,
    // The write list is not final until the hold releases below have run;
    // set once `primeFiles` exists.
    total: 0,
  };
  for (const [path, blob] of known) {
    const prime = primeShaByPath?.get(path);
    if (prime) progress.prepared[path] = { blob, prime };
  }
  for (const [path, evidence] of knownEvidence) {
    const clone = cloneShaByPath?.get(path);
    if (clone) evidenceLedger[path] = { clone, evidence };
  }
  for (const [path, evidence] of knownHeldEvidence) {
    const clone = cloneShaByPath?.get(path);
    if (clone) heldLedger[path] = { clone, evidence };
  }

  // ── A hold protects WORK, not a path ──────────────────────────────────────
  //
  // A `manual_reconcile` hold whose clone copy is byte-identical to a version
  // prime itself held is protecting stale prime content from newer prime
  // content — the September 2026 state, where the seeded hold froze
  // `clientFacing.ts` on two mirrors that had never edited it. The evidence
  // rule is the deletion rule's, asked of a live path; an operator's recorded
  // `overwrite` approval releases what evidence cannot (a hand-merged hybrid
  // matches no prime version even when every line of it is prime's).
  //
  // Placement is the safety argument: releases are decided BEFORE the write
  // list is read, so a released path flows through the prepare loop and its
  // content holds — `judgingWorkflowHold` and `backendIdentityHold` still run
  // on it like any other write. `protected` paths never reach this step:
  // `decideHoldRelease` refuses them whatever the evidence or the table says.
  const holdReleases: HoldRelease[] = [];
  {
    // Through `approvableHeld` rather than an inline filter: this set and the
    // set the approval dialog is drawn over are the two ends that drifted, and
    // one name is what stops them drifting again.
    const releasable = approvableHeld(partition.held);
    if (releasable.length > 0) {
      // Approved paths spend no probe, and neither does a path whose answer
      // an earlier pass settled about the very blob the clone still holds —
      // the walk's result cannot differ until the clone's copy does.
      // Evidence probes are bounded and only possible where the clone's blob
      // SHA is already known from the tree listing — a truncated listing
      // releases nothing, which is yesterday's behaviour.
      const needsEvidence = releasable
        .filter((h) => !overwriteApproved.has(h.path) && !knownHeldEvidence.has(h.path))
        .map((h) => ({ path: h.path, cloneSha: cloneShaByPath?.get(h.path) ?? null }))
        .filter((c): c is { path: string; cloneSha: string } => c.cloneSha !== null)
        .slice(0, MAX_HOLD_RELEASE_PROBES);
      const evidence: Map<string, HeldPathEvidence> =
        needsEvidence.length > 0
          ? await probeHeldPaths({ octokit, primeRef, candidates: needsEvidence })
          : new Map();
      for (const [path, answer] of evidence) {
        if (answer.kind === "unsettled") continue;
        const clone = cloneShaByPath?.get(path);
        if (clone) heldLedger[path] = { clone, evidence: answer };
      }
      const released = new Set<string>();
      for (const held of releasable) {
        const verdict = decideHoldRelease({
          held,
          cloneSha: cloneShaByPath?.get(held.path) ?? null,
          evidence: knownHeldEvidence.get(held.path) ?? evidence.get(held.path) ?? null,
          approved: overwriteApproved.has(held.path),
        });
        holdReleases.push(verdict);
        if (verdict.act === "release") released.add(held.path);
      }
      if (released.size > 0) {
        partition.write = [...partition.write, ...released];
        partition.held = partition.held.filter((h) => !released.has(h.path));
      }
    }
  }

  const primeFiles = partition.write;
  progress.total = primeFiles.length;
  const needsReconcile = reportableHeld(partition.held);

  if (mode === "notify" && !dryRun) {
    const body =
      `### Aurixa cascade — drift notice\n\n` +
      `Source \`${primeRef.owner}/${primeRef.repo}@${shortSha(sourceSha)}\` ` +
      `has **${primeFiles.length}** file(s) in your installed modules that may be behind.\n\n` +
      `_No commits were made. This is notify-only mode._\n\n` +
      `Files in scope:\n${primeFiles
        .slice(0, 20)
        .map((p) => `- \`${p}\``)
        .join("\n")}` +
      (primeFiles.length > 20 ? `\n\n…and ${primeFiles.length - 20} more.` : "");
    const { data: issue } = await octokit.issues.create({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      title: `Aurixa drift notice · ${sourceLabel}@${shortSha(sourceSha)} (${primeFiles.length} files)`,
      body,
      labels: ["aurixa", "drift-notice"],
    });
    return {
      status: "succeeded",
      diff_summary: `Drift issue #${issue.number} opened (${primeFiles.length} files in scope)`,
      pr_url: issue.html_url,
      files_changed: primeFiles.length,
      completed_at: new Date().toISOString(),
    };
  }

  // ── What prime deleted ────────────────────────────────────────────────────
  //
  // Candidates come from the tree comparison and mean nothing on their own.
  // Prime's history is asked about each one, and the clone's copy has to be
  // byte-identical to some version prime itself held before it is removed. The
  // exclusion policy is applied FIRST and for the ordinary reason: a
  // `protected` path is protected whatever the evidence says.
  //
  // Provisional here. A deletion still has to survive the reference check
  // below, which cannot run until the held files have been read.
  const deletionPartition = partitionCascadePaths(
    deletionCandidates.map((c) => c.path),
    exclusions,
  );
  const probeable = new Set(deletionPartition.write);
  let deletionVerdicts: DeletionVerdict[] = [];
  let unprobedDeletions = 0;
  let probePaused = false;
  if (probeable.size > 0) {
    let slowestChunkMs = 0;
    const probe = await probeDeletions({
      octokit,
      primeRef,
      candidates: deletionCandidates.filter((c) => probeable.has(c.path)),
      primeDirectories,
      // The window ROTATES between passes — with 442 clone-only paths against
      // a 100-probe budget the fixed order asked about the same head on every
      // pass and never examined the tail. Derived from the pass's own prime
      // SHA so one run still asks one deterministic set of questions.
      rotation: probeRotationFor(sourceSha),
      // An operator who approved a bulk deletion has asked for the whole
      // sweep: the pass that delivers it has to have probed every candidate,
      // or the set it delivers is the window rather than the retirement. The
      // lifted cap is never taken on a rehearsal — a dry run answers an open
      // HTTP request, and 442 probes is minutes, not a page load; its card
      // reads the rotated window exactly as before.
      maxProbes:
        !dryRun && deletionApproved.size > 0
          ? Math.min(Math.max(MAX_DELETION_PROBES, probeable.size), 500)
          : undefined,
      // Answers an earlier pass settled cost nothing this pass; answers this
      // pass settles ride the ledger chunk by chunk, so a pass cut anywhere
      // resumes from the cache instead of re-asking prime ~3 calls a path.
      known: knownEvidence,
      // Asked between chunks, never before the first — one chunk of progress
      // per tick is the floor that makes the sweep converge. The reserve is
      // the slowest chunk so far: one more like it.
      shouldStop: () =>
        resume?.budget !== undefined && resume.budget.isPastDeadline(slowestChunkMs),
      onChunk: async (settled, chunkMs) => {
        slowestChunkMs = Math.max(slowestChunkMs, chunkMs);
        if (!resume) return;
        for (const c of settled) {
          if (c.evidence.kind === "unsettled") continue;
          evidenceLedger[c.path] = { clone: c.cloneSha, evidence: c.evidence };
        }
        await resume.onProgress(progress);
      },
    });
    deletionVerdicts = probe.candidates.map(decideDeletion);
    unprobedDeletions = probe.unprobed;
    probePaused = probe.paused;
  }

  // The budget stopped the pass inside the probe phase. Every settled answer
  // is on the row; the engine hands the event back and the next pass resumes
  // from the cache. No plan, no tree, no commit: an approved sweep planned
  // from half its evidence is the window pretending to be the retirement.
  if (probePaused && resume) {
    await resume.onProgress(progress);
    const settled = [...probeable].filter((p) => evidenceLedger[p] !== undefined).length;
    return {
      status: "queued",
      started_at: null,
      diff_summary: describeProbePause({ settled, total: probeable.size }),
      progress: progress as unknown as Json,
    };
  }
  const pendingDeletes = deletionVerdicts.filter((v) => v.act === "delete").map((v) => v.path);

  // `sha: string` reuses an uploaded blob, `sha: null` DELETES the path, and
  // `content` inlines text for the chunked `createTree` chain — exactly one
  // of the two fields is ever set (`treeDelivery.pure.ts`).
  const treeEntries: DeliveryTreeEntry[] = [];

  // Bounded concurrency, and this is the difference between a cascade that
  // finishes and one that does not exist.
  //
  // The first mirror run measured 71 candidate paths, each needing a content
  // read and a blob create -- ~144 sequential round-trips. Run one at a time
  // that overruns the 60-second `timeout_milliseconds` on the pg_cron
  // `net.http_post` that drives the scheduled path, and outlives the isolate on
  // the webhook path. Both were observed: three cascade_events sat in `running`
  // with their results at `pushing`, `net._http_response` recorded
  // `timed_out = true` at exactly 60,000 ms, and no branch was ever created on
  // the clone. Nothing reported a failure, because nothing got far enough to.
  //
  // Eight at a time is chosen against GitHub's secondary rate limits rather
  // than for maximum speed: the work is IO, not CPU, and the same 144 calls
  // finish inside the budget with room to spare.
  type Prepared =
    | {
        kind: "blob";
        path: string;
        mode: "100644";
        type: "blob";
        /**
         * An uploaded (or ledger-reused) blob. Undefined exactly when
         * `inline` is set: text travels in the chunked `createTree` chain
         * rather than buying a per-file blob (`treeDelivery.pure.ts`).
         */
        sha: string | undefined;
        /** UTF-8 text for the tree chain to inline. Undefined for sha entries. */
        inline?: string;
        /**
         * The text this cascade delivers, kept only for source modules so
         * `findStaleHeldReferences` can read the exports it is about to
         * remove. Held to the same paths the check can act on, so a cascade of
         * images or lockfiles carries nothing extra.
         */
        content: string | null;
      }
    | { kind: "held"; held: HeldPath };

  // The pass's ledger (`resume`, `known`, `progress`) is opened above the
  // deletion probes — the probes are the first paid question. Only the
  // prepare loop's own pacing lives here.
  let freshlyPrepared = 0;
  /** Files this pass has paid a read for. See `shouldStop`. */
  let filesRead = 0;
  /**
   * Bytes this pass has carried as a stream.
   *
   * `shouldStop` already paces the pass on the slowest file it has seen, and
   * a 40 MB carry makes itself the slowest file, so the budget stops the pass
   * by construction after the first one. This is the guard for the FIRST one:
   * a pass that has not yet read anything has no measurement to reserve
   * against, and a fresh pass that began with four seeds would spend its whole
   * invocation on them before the budget had a number to work with.
   */
  let streamedBytes = 0;
  let slowestFileMs = 0;
  // Asked before each file is started, never before the first fresh one: a
  // pass that prepared nothing new would come back next tick exactly where
  // it was. The reserve is the slowest file so far — one more like it.
  /**
   * Whether this pass has spent enough of its window to stop.
   *
   * Counted in FILES READ, not in blobs uploaded. `freshlyPrepared` is the
   * resume LEDGER's counter and only a binary file buys a blob — text travels
   * inline in the chunked `createTree` chain — so on a delivery with no binary
   * in it that counter stayed at zero and this could never return true. Specs
   * and their subjects are `.ts`/`.tsx`, which is to say a carry is all text
   * by construction: the guard that stops the carry running past its window
   * was the one guard it could never reach, `cutShort: "budget"` was
   * unreachable, and the pass ran to the platform's own ceiling rather than
   * handing back a resumable row.
   *
   * The `> 0` is the same forward-progress guarantee it always was — a pass
   * that is already past its deadline still prepares one file rather than
   * looping having done nothing — measured on the thing that actually costs
   * the window.
   */
  const shouldStop = () =>
    resume?.budget !== undefined && filesRead > 0 && resume.budget.isPastDeadline(slowestFileMs);

  /**
   * The lane for a file too large to read: carry it without ever holding it.
   *
   * Reached only from the refusal that used to end in a hold, so the floor is
   * yesterday's behaviour — every way this can decline returns to that same
   * hold, and the file is reported exactly as it was. What it adds is the
   * fifteen files at prime that no pass had ever delivered.
   *
   * Three declines, and each says which it was rather than reporting one
   * shape of failure for three different remedies:
   *
   * - past `CASCADE_STREAM_MAX_FILE_BYTES`, which is GitHub's own blob
   *   ceiling. Nothing retries it and nothing here can release it.
   * - this pass's streaming allowance is spent. Not a failure at all — the
   *   next pass continues, and saying "bring it across by hand" here would
   *   have an operator race the engine.
   * - the carry was attempted and did not complete. The next pass retries.
   *
   * A streamed blob is LEDGERED like a binary one, and that matters more than
   * it looks: a 39 MB seed is then carried once per EVENT rather than once
   * per tick, because `resumableBlobs` matches on prime's sha and a streamed
   * blob's sha IS prime's sha — a git blob is a hash of its own bytes.
   */
  const carryOversizeByStream = async (
    e: OversizeFileError,
    path: string,
    fileStartedAt: number,
  ): Promise<Prepared> => {
    const { carryLaneFor, CASCADE_STREAM_BYTES_PER_PASS, CASCADE_STREAM_MAX_FILE_BYTES } =
      await import("@/server/cascade/blobStreamCarry.pure");
    if (carryLaneFor(e.bytes, e.maxBytes) !== "stream") {
      return {
        kind: "held",
        held: oversizeHold(path, e.bytes, CASCADE_STREAM_MAX_FILE_BYTES),
      };
    }
    // The tree listing already answered this, and the refusal carries it too.
    // Without it there is nothing to copy FROM, which is a fact about the read
    // rather than about the file.
    const primeSha = e.sha ?? primeShaByPath?.get(path);
    if (!primeSha) {
      return {
        kind: "held",
        held: oversizeHold(path, e.bytes, e.maxBytes, "prime's blob sha could not be read"),
      };
    }
    // A dry run composes no blob anywhere — the write boundary is never
    // reached — so prime's sha stands in, exactly as it does for a binary file.
    if (dryRun) {
      return {
        kind: "blob",
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: primeSha,
        inline: undefined,
        content: null,
      };
    }
    // Below the dry run deliberately. The allowance is PACING, not policy —
    // what it holds back this pass the next one carries — so a rehearsal that
    // reported a file as withheld because of it would describe a cascade that
    // never happens. A dry run answers what the cascade will do in the end.
    if (streamedBytes + e.bytes > CASCADE_STREAM_BYTES_PER_PASS) {
      return {
        kind: "held",
        held: oversizeHold(
          path,
          e.bytes,
          e.maxBytes,
          `this pass had already carried ${(streamedBytes / 1_048_576).toFixed(1)} MB, which ` +
            `is its allowance`,
        ),
      };
    }
    try {
      const blobSha = await copyBlobByStream(octokit, primeRef, cloneRef, path, primeSha, e.bytes);
      streamedBytes += e.bytes;
      if (resume) {
        progress.prepared[path] = { blob: blobSha, prime: primeSha };
        freshlyPrepared += 1;
        if (freshlyPrepared % PROGRESS_FLUSH_EVERY === 0) await resume.onProgress(progress);
      }
      slowestFileMs = Math.max(slowestFileMs, Date.now() - fileStartedAt);
      return {
        kind: "blob",
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobSha,
        inline: undefined,
        // Never judged on its text — it was never read. See the note on
        // `CASCADE_MAX_FILE_BYTES` for why that is right for this lane.
        content: null,
      };
    } catch (carryError) {
      // Held, never thrown. A carry that failed must not take the other
      // forty-seven files in the pass with it — which is the same rule the
      // ceiling itself was written for.
      slowestFileMs = Math.max(slowestFileMs, Date.now() - fileStartedAt);
      return {
        kind: "held",
        held: oversizeHold(
          path,
          e.bytes,
          e.maxBytes,
          carryError instanceof Error ? carryError.message : String(carryError),
        ),
      };
    }
  };

  /**
   * ONE CANDIDATE, JUDGED. Named rather than inline because it is asked
   * TWICE: once over the paths this clone's modules put in scope, and again
   * over the subjects a delivered spec would otherwise strand.
   *
   * That second pass is the whole safety argument for carrying a subject.
   * A subject pulled in because a spec names it is not privileged: it meets
   * the oversize ceiling, the judging-workflow rule, the backend-identity
   * rule and this edge's own membrane channels on exactly the terms every
   * other write does, because it is the same function. Injecting it into
   * the tree instead would have carried a file past every rule in this
   * engine on the strength of being MENTIONED, which is the opposite of
   * what a membrane is for.
   */
  const prepareOne = async (path: string): Promise<Prepared | null> => {
    // Reused from the previous pass: no read, no create. The tree
    // comparison already established the path differs, and the list
    // established prime's blob is still the one this was made from.
    //
    // A SPEC is never reused, and the exception is narrow on purpose. Every
    // other judgement on this path is a pure function of the file's own
    // text, so an answer settled in an earlier tick is the same answer now.
    // The membrane's spec channel is not: whether a spec strands its
    // subject is a fact about THIS delivery, and a resumed pass carries a
    // different one. Reuse also sets `content: null`, which takes the file
    // out of `deliveredSource` — the set that channel reads — so a banked
    // spec would cross having been judged against a partial delivery and
    // never re-asked. Specs are a small share of any cascade; the saving
    // this gives up is a file read, and what it buys is a verdict about the
    // delivery that is actually being made.
    const reusable = isSpecPath(path) ? undefined : known.get(path);
    if (reusable !== undefined) {
      return {
        kind: "blob",
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: reusable,
        content: null,
      };
    }
    const fileStartedAt = Date.now();
    // Counted here rather than at any exit below: every one of them has
    // attempted a read by this line, including the oversize refusal, and a
    // counter that four returns have to remember to touch is one a fifth
    // return will not.
    filesRead += 1;
    let primeFile: Awaited<ReturnType<typeof getFileContent>>;
    try {
      primeFile = await getFileContent(octokit, primeRef, path, {
        maxBytes: CASCADE_MAX_FILE_BYTES,
      });
    } catch (e) {
      // NOT held first. One file past the read ceiling used to kill the whole
      // pass — and the forty-seven beside it — on every attempt until the
      // event ran out of claims, and holding it was the fix. But "cannot be
      // held" is not "cannot be carried": the bytes never have to enter this
      // isolate, and a file too large to read is streamed from prime's blob
      // straight into the clone's, base64-encoded in flight. The hold below
      // is what is left when that cannot be done — which is a file past
      // GitHub's own ceiling, or a carry that failed. See
      // `blobStreamCarry.pure.ts` and `CASCADE_MAX_FILE_BYTES`.
      if (e instanceof OversizeFileError) {
        return await carryOversizeByStream(e, path, fileStartedAt);
      }
      throw e;
    }
    if (!primeFile) return null;

    // A mirror already knows this path differs -- the blob SHAs said so -- and
    // re-reading the clone's copy to confirm it would double the request count
    // of the one scope that cannot afford it.
    let cloneFile = null as Awaited<ReturnType<typeof getFileContent>> | null;
    let cloneFileRead = false;
    if (cloneShaByPath !== null) {
      // The tree listing already answered this for every path — a blob SHA
      // is a hash of the bytes — so reading the clone's copy here is a
      // request that cannot change the answer. It was made anyway, once per
      // candidate, on every module-scope pass: 353 of them on the first
      // cascade to `preflight-property-group`, repeated on each of the
      // attempts that followed, which is a third of what spent the App's
      // hourly budget on 2 Sep 2026. The clone's content is still fetched
      // below, lazily, where the backend-identity hold needs it.
      if (cloneShaByPath.get(path) === primeFile.sha) return null;
    } else if (!isMirror) {
      cloneFile = await getFileContent(octokit, cloneRef, path);
      cloneFileRead = true;
      // Compared by blob SHA, which IS a hash of the bytes, rather than by
      // the UTF-8 reading. Two different binaries decode to the same string
      // of replacement characters, so comparing the readings would report a
      // changed image as unchanged and never deliver it.
      if (cloneFile && cloneFile.sha === primeFile.sha) return null;
    }

    // A judge may not travel ahead of the tree it judges.
    //
    // The workflows directory is a repository invariant, so a module-scoped
    // clone receives prime's workflows — including `ci.yml`, which asks
    // questions about the whole repository while that clone holds a subset of
    // it. Measured 9 Sep 2026: prime's `builder-stock-pdf-worker` job runs
    // `deno check cloudflare/builder-stock-pdf-worker/src/index.ts` and
    // neither module-scoped clone holds that directory, so the check was red
    // on every pull request with nothing the cascade could ever send to fix
    // it.
    //
    // Decided from the workflow's own `on:` block rather than from a list of
    // filenames kept in this repository about another one — see
    // `judgingWorkflow.pure.ts`. Held rather than skipped, so the operator is
    // told which workflow did not arrive and why.
    //
    // Ordered ahead of the backend-identity rule because it is cheaper and
    // cannot overlap: `isShippedPath` covers `src/` and `public/` only, so no
    // workflow file ever reaches that branch.
    if (!primeFile.binary) {
      const workflowHold = judgingWorkflowHold({
        path,
        primeContent: primeFile.content,
        scope: isMirror ? "mirror" : "modules",
      });
      if (workflowHold) return { kind: "held", held: workflowHold };
    }

    // The content rule. Path exclusions protect what somebody remembered to
    // list; this protects the property itself.
    //
    // Cheap by construction. The clone's copy is only fetched when prime's
    // content actually names a Supabase project inside a path this clone
    // ships -- one file out of 71 on the first mirror run -- so the extra
    // read costs nothing on the paths that are not about identity, which is
    // nearly all of them.
    // Text only. `primeFile.content` is a lossy reading of a binary file, so
    // scanning it for a project reference asks a question of characters that
    // were never there — and a backend identity cannot be spelled in bytes
    // that are not text.
    if (
      !primeFile.binary &&
      isShippedPath(path) &&
      backendRefsIn(primeFile.content).some((r) => r !== ownProjectRef)
    ) {
      if (!cloneFileRead) {
        cloneFile = await getFileContent(octokit, cloneRef, path);
        cloneFileRead = true;
      }
      const hold = backendIdentityHold({
        path,
        primeContent: primeFile.content,
        cloneContent: cloneFile ? cloneFile.content : null,
        ownRef: ownProjectRef,
      });
      if (hold) return { kind: "held", held: hold };
    }

    // ── The membrane on this edge ──────────────────────────────────────
    //
    // Here rather than beside `partitionCascadePaths`, for the reason the
    // backend-identity hold above is here: these are judgements about what
    // a file SAYS, and the text is in hand exactly once, at this point,
    // because the pass is about to write it. Asking earlier would buy a
    // second read of every candidate.
    if (!primeFile.binary) {
      const verdict = permeate(membrane, { path, text: primeFile.content });
      if (verdict.kind === "blocked") return { kind: "held", held: verdict.held };
    }

    // The spec channel is NOT asked here. Whether a spec strands its subject
    // is a fact about what this pass WRITES, and this loop is what decides
    // that — a candidate reaching this line can still be held by the rules
    // above it, or be the file this very call is about to hold. It is asked
    // once, below, over the finished delivery.

    // Prime's bytes, passed through untouched.
    //
    // This used to be `Buffer.from(primeFile.content, "utf8")` — the UTF-8
    // READING re-encoded — which is a faithful round trip for text and
    // destruction for anything else. `aurixa-emblem-240.png` arrived on the
    // clone as 142,140 bytes of replacement characters where prime holds
    // 78,450 bytes of PNG, and was re-corrupted by every cascade that
    // carried it. 144 binary files were exposed, including 86 `.docx`
    // partner agreement templates that both portals hand to partners.
    //
    // TEXT costs no call here at all: it travels INLINE in the chunked
    // `createTree` chain (see `treeDelivery.pure.ts`), where one call
    // carries ~a hundred files. Per-file `createBlob` on an ~830-file
    // backfill spent a third of the App's hourly window PER CLONE —
    // measured 16 Sep 2026, 12:24–13:25, one window synced one clone —
    // so only binary files, which have no inline lane, still buy a blob,
    // and only they are worth ledgering for reuse.
    // A dry run needs to know WHICH paths would be written, not to upload
    // their bytes. Prime's blob SHA stands in: it is never used for anything
    // on this path, because the write boundary is never reached.
    if (!dryRun && !primeFile.binary) {
      slowestFileMs = Math.max(slowestFileMs, Date.now() - fileStartedAt);
      return {
        kind: "blob" as const,
        path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: undefined,
        inline: primeFile.content,
        content: /\.[cm]?tsx?$/.test(path) ? primeFile.content : null,
      };
    }
    const blobSha = dryRun
      ? primeFile.sha
      : (
          await octokit.git.createBlob({
            owner: cloneRef.owner,
            repo: cloneRef.repo,
            content: primeFile.base64,
            encoding: "base64",
          })
        ).data.sha;
    if (resume && !dryRun) {
      progress.prepared[path] = { blob: blobSha, prime: primeFile.sha };
      freshlyPrepared += 1;
      slowestFileMs = Math.max(slowestFileMs, Date.now() - fileStartedAt);
      // Written as it goes, so a pass cut by the platform rather than by
      // its own budget still leaves most of its work on the row.
      if (freshlyPrepared % PROGRESS_FLUSH_EVERY === 0) await resume.onProgress(progress);
    }
    return {
      kind: "blob" as const,
      path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: blobSha,
      inline: undefined,
      content: !primeFile.binary && /\.[cm]?tsx?$/.test(path) ? primeFile.content : null,
    };
  };

  const { results: prepared, stopped: preparePaused } = await mapWithConcurrencyUntil<
    string,
    Prepared | null
  >(primeFiles, 8, prepareOne, shouldStop);

  // The budget stopped the pass inside this clone. Everything prepared so far
  // is on the row; the engine hands the event back and the next pass starts
  // from the list rather than from the tree. No tree, no commit, no pull
  // request: a proposal that carries half the diff is worse than none.
  if (preparePaused && resume) {
    await resume.onProgress(progress);
    return {
      status: "queued",
      started_at: null,
      diff_summary: describePreparePause({
        prepared: Object.keys(progress.prepared).length,
        total: primeFiles.length,
      }),
      progress: progress as unknown as Json,
    };
  }
  const deliveredSource: Record<string, string> = {};

  /**
   * Prepared candidates, absorbed into the delivery. Named for the same
   * reason `prepareOne` is: the subjects a delivered spec carries in behind
   * it arrive here too, and two copies of "what a prepared entry becomes" is
   * how one of them comes to forget `deliveredSource` — the very map the spec
   * channel reads to decide whether anything is still stranded.
   *
   * Returns the paths that actually reached the tree, which is what lets the
   * carry loop tell "something crossed, ask again" from "nothing can".
   */
  const absorbPrepared = (entries: ReadonlyArray<Prepared | null>): string[] => {
    const written: string[] = [];
    for (const entry of entries) {
      if (!entry) continue;
      if (entry.kind === "held") {
        // Recorded in the same partition the path rules feed, so a content hold
        // reaches the pull request body, the withheld count and the "nothing to
        // cascade" reason by exactly the route a listed path does.
        partition.held.push(entry.held);
        needsReconcile.push(entry.held);
        continue;
      }
      if (entry.inline !== undefined) {
        treeEntries.push({
          path: entry.path,
          mode: entry.mode,
          type: entry.type,
          content: entry.inline,
        });
      } else {
        treeEntries.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: entry.sha });
      }
      if (entry.content !== null) deliveredSource[entry.path] = entry.content;
      written.push(entry.path);
    }
    return written;
  };

  absorbPrepared(prepared);

  // ── supabase/config.toml: one file, two kinds of fact ──────────────────
  //
  // The path stays excluded and is NOT written by the loop above. Its first
  // line names the Supabase project this deployment talks to, and prime's copy
  // landing here is the accident that once made a clone serve the prime's
  // production database. Everything else in it is repository fact — 435
  // `[functions.X] verify_jwt` declarations, the exposed schema list — and
  // excluding the file whole freezes those at whatever the clone forked with.
  //
  // An omitted `[functions.X]` block is not "no opinion": the CLI reads it as
  // `verify_jwt = true`. Measured 9 Sep 2026, four functions prime declares
  // OPEN had no block on a clone and would be gated behind a JWT their callers
  // cannot present.
  //
  // Stripped of `[functions.*]`, the two files differ by exactly one line, so
  // this is prime's file with the clone's own `project_id` put back rather
  // than a merge of two evolving documents. `reconcileConfigToml` reads the
  // result back and refuses on anything it cannot account for; a refusal is
  // held and named like any other.
  //
  // Its own step rather than part of the write path, because the write path is
  // exactly what must never carry this file.
  let configReconcileNote: string | null = null;
  // One line per baseline this pass computed rather than withheld. Reported
  // in the pull request body, because a number a machine rewrote in a file a
  // person is reviewing has to say that it did.
  const baselineNotes: string[] = [];
  // What the two reconciles below kept because prime has no opinion about it.
  // Read after both, to decide whether prime's security baseline can describe
  // this repository at all.
  let cloneOwnedFunctions: string[] = [];
  // What this repository's two declaration files will SAY once the pass
  // lands: prime's reconciled copy where it stands, the clone's own where the
  // reconcile refused and prime's was withheld. The baselines below count
  // from these rather than from either side's file, because a count taken
  // from a document that is not the one that lands is a number about a
  // repository that will not exist.
  let mergedToml: string | null = null;
  let mergedRegistryJson: string | null = null;
  /**
   * Paths a reconcile pump DECIDED, whether or not it wrote one.
   *
   * Every pump drops prime's copy from the tree and then either writes a
   * merged one or leaves the clone's file standing — the second case writes
   * nothing, because the merged result IS the clone's file. A dry run has the
   * same shape for a different reason: it composes no blob.
   *
   * A path in neither `treeEntries` nor `partition.held` is one the subject
   * carry below reads as STRANDED, and the carry answers a stranded subject
   * by delivering prime's RAW copy — undoing the reconcile inside its own
   * pass, in the reconcile's own steady state. `SECURITY_REGISTRY.json` is
   * the sharp case: it is a repository invariant rather than an exclusion
   * row, so nothing else in the carry would refuse it.
   *
   * So the decision is recorded here and the carry reads it as delivered,
   * which is what it is — the delivery covers this path. A REFUSAL is not
   * recorded: a held path is one a spec naming it should still strand on.
   */
  const reconciledPaths = new Set<string>();
  /**
   * The decided paths whose merge CHANGES the clone's file — the part of
   * `reconciledPaths` that is a write. A pump's steady state writes the
   * clone's own bytes back and is not here.
   *
   * The forward half reads `reconciledPaths`: a spec naming a pumped path is
   * judged by the merge, not stranded on it. The reverse half asks what the
   * delivery CHANGES, and reads this (`pathsTheDeliveryChanges`) — excluding
   * every pumped path left a kept spec about a `config.toml` the pump really
   * changed running its old assertions against the new merge.
   */
  const reconcileWrites = new Set<string>();
  /**
   * What a rehearsal's pumps would write. A dry run composes no entry for
   * `config.toml`, the registry or the deploy workflow, so without this it
   * would judge the kept specs against a delivery missing those writes and
   * answer differently from the pass it rehearses.
   */
  const rehearsedWrites = new Set<string>();
  if (mode !== "notify") {
    try {
      const [primeCfg, cloneCfg] = await Promise.all([
        getFileContent(octokit, primeRef, CONFIG_TOML_PATH),
        getFileContent(octokit, cloneRef, CONFIG_TOML_PATH),
      ]);
      if (primeCfg && cloneCfg && !primeCfg.binary && !cloneCfg.binary) {
        const verdict = reconcileConfigToml({
          primeToml: primeCfg.content,
          cloneToml: cloneCfg.content,
          ownRef: ownProjectRef,
        });
        if (verdict.ok) cloneOwnedFunctions = verdict.carriedForward;
        mergedToml = verdict.ok ? verdict.merged : cloneCfg.content;
        // Decided wherever it is not refused, INCLUDING the case that writes
        // nothing because the clone's file already says it.
        if (verdict.ok) reconciledPaths.add(CONFIG_TOML_PATH);
        if (!verdict.ok) {
          const held = {
            path: CONFIG_TOML_PATH,
            pattern: "(content: project identity)",
            reason: "manual_reconcile" as const,
            note: `Function declarations were not brought across: ${verdict.reason}.`,
          };
          partition.held.push(held);
          needsReconcile.push(held);
        } else if (verdict.changed) {
          const was = declaredFunctionCount(cloneCfg.content);
          const now = declaredFunctionCount(verdict.merged);
          const kept = verdict.carriedForward.length
            ? ` · kept ${verdict.carriedForward.length} declaration(s) this clone owns ` +
              `(${verdict.carriedForward.join(", ")})`
            : "";
          configReconcileNote =
            `${CONFIG_TOML_PATH} · ${now} function declaration(s), was ${was} · ` +
            `project ${verdict.ownRef} unchanged${kept}`;
          reconcileWrites.add(CONFIG_TOML_PATH);
          if (dryRun) rehearsedWrites.add(CONFIG_TOML_PATH);
          if (!dryRun) {
            const { data: cfgBlob } = await octokit.git.createBlob({
              owner: cloneRef.owner,
              repo: cloneRef.repo,
              content: Buffer.from(verdict.merged, "utf8").toString("base64"),
              encoding: "base64",
            });
            treeEntries.push({
              path: CONFIG_TOML_PATH,
              mode: "100644",
              type: "blob",
              sha: cfgBlob.sha,
            });
            deliveredSource[CONFIG_TOML_PATH] = verdict.merged;
          }
        }
      }
    } catch (e) {
      // Never fails the pass. The clone's own config is what it had a moment
      // ago, which is the state every cascade before this one left it in.
      console.warn(
        `[cascade] config.toml reconcile skipped for clone ${clone.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // ── the security registry: prime's entries, plus the clone's own ─────────
  //
  // `supabase/functions-registry/**` is a repository invariant, so prime's
  // registry travels everywhere — and the clone's own checker asserts that
  // every function on disk and every function declared in config.toml has an
  // entry. A clone owning functions prime does not therefore receives a
  // registry missing its own, and the check refuses the cascade's own
  // delivery. Excluding the file fails the other way: prime adds a function
  // and the entry never arrives.
  //
  // So it is reconciled, in the same shape as config.toml, and the write
  // path's copy is REPLACED rather than left to win — the invariant put it in
  // the tree a few hundred lines above.
  const dropFromTree = (path: string) => {
    for (let i = treeEntries.length - 1; i >= 0; i -= 1) {
      if (treeEntries[i].path === path) treeEntries.splice(i, 1);
    }
    delete deliveredSource[path];
  };

  if (mode !== "notify") {
    try {
      const [primeReg, cloneReg] = await Promise.all([
        getFileContent(octokit, primeRef, SECURITY_REGISTRY_PATH),
        getFileContent(octokit, cloneRef, SECURITY_REGISTRY_PATH),
      ]);
      if (primeReg && cloneReg && !primeReg.binary && !cloneReg.binary) {
        const verdict = reconcileSecurityRegistry({
          primeJson: primeReg.content,
          cloneJson: cloneReg.content,
        });
        // Either way prime's copy does not stand: it is replaced by the
        // reconciled one, or withheld for a person.
        dropFromTree(SECURITY_REGISTRY_PATH);
        mergedRegistryJson = verdict.ok ? verdict.merged : cloneReg.content;
        if (verdict.ok) reconciledPaths.add(SECURITY_REGISTRY_PATH);
        if (!verdict.ok) {
          const held = {
            path: SECURITY_REGISTRY_PATH,
            pattern: "(content: this clone's own function entries)",
            reason: "manual_reconcile" as const,
            note: `The security registry was not brought across: ${verdict.reason}.`,
          };
          partition.held.push(held);
          needsReconcile.push(held);
        } else {
          cloneOwnedFunctions = [...new Set([...cloneOwnedFunctions, ...verdict.carriedForward])];
          if (verdict.changed) {
            reconcileWrites.add(SECURITY_REGISTRY_PATH);
            if (dryRun) rehearsedWrites.add(SECURITY_REGISTRY_PATH);
          }
          if (verdict.changed && !dryRun) {
            const { data: regBlob } = await octokit.git.createBlob({
              owner: cloneRef.owner,
              repo: cloneRef.repo,
              content: Buffer.from(verdict.merged, "utf8").toString("base64"),
              encoding: "base64",
            });
            treeEntries.push({
              path: SECURITY_REGISTRY_PATH,
              mode: "100644",
              type: "blob",
              sha: regBlob.sha,
            });
            deliveredSource[SECURITY_REGISTRY_PATH] = verdict.merged;
          }
        }
      }
    } catch (e) {
      // Never fails the pass, for the same reason the config reconcile does
      // not: the clone's own registry is the state every cascade before this
      // one left it in.
      console.warn(
        `[cascade] SECURITY_REGISTRY.json reconcile skipped for clone ${clone.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // ── prime's security baseline cannot describe a repository it is not ─────
  //
  // Decided AFTER both reconciles, because what they carried forward is the
  // evidence: a clone that kept declarations or entries of its own owns
  // functions prime has never analysed, so prime's `SECURITY_INVENTORY.json`
  // is a static analysis of a different tree. A mirror carries nothing
  // forward and keeps today's behaviour exactly.
  // The declarations are the weaker evidence and were, on the one clone this
  // hold was written for, no evidence at all: it owns three function
  // directories and declares none of them. The generator counts directories,
  // so that is what decides. A tree that could not be listed answers `null`
  // rather than "none", and the declarations carry the decision alone.
  const ownedByTree = cloneOnlyEdgeFunctions({
    primePaths: primeShaByPath?.keys(),
    clonePaths: cloneShaByPath?.keys(),
  });
  if (ownedByTree !== null) {
    cloneOwnedFunctions = [...new Set([...cloneOwnedFunctions, ...ownedByTree])];
  }
  // ── the two baselines that state this repository's own function set ────
  //
  // `securityInventoryHold` and `functionCountRatchetHold` refuse prime's
  // copies of `SECURITY_INVENTORY.json` and `auditRemediation.spec.ts`, and
  // refusing is right: prime's numbers describe prime's tree. But a refusal
  // leaves the clone's numbers describing the tree it had BEFORE this pass,
  // and this pass changes that tree — so `security` and `verify` go red on
  // two files the cascade declined to write rather than on any it wrote
  // wrong. The hold's own note has always named `npm run security:inventory`
  // as the remedy, and nothing has ever run it, because this engine composes
  // a git tree over the GitHub API and cannot run npm.
  //
  // So the numbers are COMPUTED — from the config and registry this same pass
  // reconciled a few lines above, and from the two sides' own generator
  // output re-filed per path (`securityBaselineReconcile.pure.ts`). The hold
  // is what happens when they cannot be, which costs the pass exactly the red
  // check it already had.
  //
  // Gated on the holds' own trigger and no wider: this reconciles precisely
  // where today it withholds, and a clone owning nothing prime does not
  // receives prime's copies exactly as it does now.
  const inventoryHold = securityInventoryHold(cloneOwnedFunctions);
  const ratchetHold = functionCountRatchetHold(cloneOwnedFunctions);

  if ((inventoryHold || ratchetHold) && mode === "notify") {
    // A notify pass writes nothing and reconciles nothing, so it reads
    // nothing either: both holds stand exactly as they did before any of this
    // existed, rather than gaining a sentence about inputs nobody tried to
    // read. `mode === "notify" && !dryRun` has already returned far above;
    // this is the rehearsal of one, and a rehearsal that spends three API
    // reads to reach a foregone hold is three reads.
    for (const held of [inventoryHold, ratchetHold]) {
      if (!held) continue;
      dropFromTree(held.path);
      partition.held.push(held);
      needsReconcile.push(held);
    }
  } else if (inventoryHold || ratchetHold) {
    // Every path this repository holds once the pass lands, and the subset
    // the pass writes — the two together are what say which side supplied
    // each file's content. `treeEntries` is the delivery composed so far; the
    // only entries gated on `!dryRun` are the config and the registry, and
    // neither is a file the inventory's walk reads, so this is the same
    // answer on a dry run as on a real one.
    const deliveredPaths = treeEntries.filter((e) => e.sha !== null).map((e) => e.path);
    const mergedTreePaths = new Set([...(cloneShaByPath?.keys() ?? []), ...deliveredPaths]);

    // Read alongside the config and registry pairs above, in the same shape
    // and under the same rule: a read that fails never fails the pass, it
    // leaves the hold standing.
    let primeInventory: string | null = null;
    let cloneInventory: string | null = null;
    let primeRatchetSpec: string | null = null;
    try {
      const [pi, ci, ps] = await Promise.all([
        inventoryHold ? getFileContent(octokit, primeRef, SECURITY_INVENTORY_PATH) : null,
        inventoryHold ? getFileContent(octokit, cloneRef, SECURITY_INVENTORY_PATH) : null,
        ratchetHold ? getFileContent(octokit, primeRef, FUNCTION_COUNT_RATCHET_PATH) : null,
      ]);
      if (pi && !pi.binary) primeInventory = pi.content;
      if (ci && !ci.binary) cloneInventory = ci.content;
      if (ps && !ps.binary) primeRatchetSpec = ps.content;
    } catch (e) {
      console.warn(
        `[cascade] security baseline read skipped for clone ${clone.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    /**
     * Put a reconciled baseline into the delivery, or leave the hold standing
     * with the reason on it.
     *
     * Prime's copy is dropped either way — it is replaced by the reconciled
     * one or withheld for a person — which is the same rule the registry
     * above answers to.
     */
    const settleBaseline = async (
      held: HeldPath,
      outcome: { ok: true; merged: string; count: number } | { ok: false; reason: string } | null,
    ) => {
      dropFromTree(held.path);
      if (!outcome || !outcome.ok) {
        const why = outcome ? outcome.reason : "its inputs could not be read on this pass";
        partition.held.push({ ...held, note: `${held.note} Not reconciled here: ${why}.` });
        needsReconcile.push({ ...held, note: `${held.note} Not reconciled here: ${why}.` });
        return;
      }
      // A dry run composes no blob — it returns before `createTree` — but it
      // must still put the path back, INLINE. `dropFromTree` took it out, and
      // a path that is neither in the tree nor in `partition.held` is one the
      // subject carry below reads as stranded and re-delivers prime's raw
      // copy of: the rehearsal would then show the very file the real pass
      // replaces. It is also what `files_changed` counts.
      if (dryRun) {
        treeEntries.push({
          path: held.path,
          mode: "100644",
          type: "blob",
          content: outcome.merged,
        });
      } else {
        const { data: blob } = await octokit.git.createBlob({
          owner: cloneRef.owner,
          repo: cloneRef.repo,
          content: Buffer.from(outcome.merged, "utf8").toString("base64"),
          encoding: "base64",
        });
        treeEntries.push({ path: held.path, mode: "100644", type: "blob", sha: blob.sha });
      }
      deliveredSource[held.path] = outcome.merged;
      reconciledPaths.add(held.path);
      // A write only where the merge differs from the clone's copy, which the
      // clone's tree already answers by blob id (`gitBlobSha.pure.ts`).
      if (cloneShaByPath?.get(held.path) !== gitBlobSha(outcome.merged)) {
        reconcileWrites.add(held.path);
      }
      baselineNotes.push(`${held.path} · reconciled to ${outcome.count} function(s)`);
    };

    if (inventoryHold) {
      await settleBaseline(
        inventoryHold,
        primeInventory !== null && cloneInventory !== null && mergedToml && mergedRegistryJson
          ? reconcileSecurityInventory({
              primeInventoryJson: primeInventory,
              cloneInventoryJson: cloneInventory,
              mergedToml,
              mergedRegistryJson,
              mergedTreePaths,
              deliveredPaths,
            })
          : null,
      );
    }

    if (ratchetHold) {
      await settleBaseline(
        ratchetHold,
        primeRatchetSpec !== null && mergedToml
          ? reconcileFunctionCountRatchet({
              primeSpec: primeRatchetSpec,
              mergedToml,
              cloneOwnedFunctions,
            })
          : null,
      );
    }
  }

  // ── the deploy workflow: the same shape, found the same way ────────────
  //
  // `.github/workflows/deploy-supabase-functions.yml` is excluded for a reason
  // that was true of the file it was written about — it hard-coded a project
  // ref twice — and the exclusion then froze the other 500 lines with it.
  //
  // Measured 9 Sep 2026: npc-test-76b3b3 had failed 9 of 9 runs and
  // preflight-property-group 8 of 8, every push since each was created, while
  // npc-client-dashboard had 19 consecutive clean ones. The difference is a
  // date. Both failing clones were forked BEFORE the change that stands the
  // check down where Mission Control deploys, and the exclusion meant they
  // could never receive it — so Mission Control went on setting
  // `BACKEND_DEPLOYED_BY` on repositories whose workflow had no line that
  // reads it.
  //
  // The file carries no deploy target of its own any more: it resolves one
  // from the repository variable and, failing that, from the repository's OWN
  // `supabase/config.toml`. So this is a carry rather than a substitution —
  // guarded, because the thing being carried decides where a repository's code
  // is sent. `reconcileDeployWorkflow` refuses on any project ref outside the
  // one position that cannot select a target, reads the result back, and is
  // held and named like any other refusal.
  let deployWorkflowNote: string | null = null;
  if (mode !== "notify") {
    try {
      const [primeWf, cloneWf] = await Promise.all([
        getFileContent(octokit, primeRef, DEPLOY_WORKFLOW_PATH),
        getFileContent(octokit, cloneRef, DEPLOY_WORKFLOW_PATH),
      ]);
      if (primeWf && cloneWf && !primeWf.binary && !cloneWf.binary) {
        const verdict = reconcileDeployWorkflow({
          primeYaml: primeWf.content,
          cloneYaml: cloneWf.content,
          ownRef: ownProjectRef,
        });
        if (verdict.ok) reconciledPaths.add(DEPLOY_WORKFLOW_PATH);
        if (!verdict.ok) {
          const held = {
            path: DEPLOY_WORKFLOW_PATH,
            pattern: "(content: deploy target)",
            reason: "manual_reconcile" as const,
            note: `The deploy workflow was not brought across: ${verdict.reason}.`,
          };
          partition.held.push(held);
          needsReconcile.push(held);
        } else if (verdict.changed) {
          const gained =
            !readsDeployerDeclaration(cloneWf.content) && readsDeployerDeclaration(verdict.merged);
          deployWorkflowNote =
            `${DEPLOY_WORKFLOW_PATH} · carried from prime` +
            (gained ? " · gains the Mission Control stand-down" : "") +
            (verdict.cloneWasHazardous
              ? " · the copy it replaces defaulted its deploy target to another deployment"
              : "");
          reconcileWrites.add(DEPLOY_WORKFLOW_PATH);
          if (dryRun) rehearsedWrites.add(DEPLOY_WORKFLOW_PATH);
          if (!dryRun) {
            const { data: wfBlob } = await octokit.git.createBlob({
              owner: cloneRef.owner,
              repo: cloneRef.repo,
              content: Buffer.from(verdict.merged, "utf8").toString("base64"),
              encoding: "base64",
            });
            treeEntries.push({
              path: DEPLOY_WORKFLOW_PATH,
              mode: "100644",
              type: "blob",
              sha: wfBlob.sha,
            });
            deliveredSource[DEPLOY_WORKFLOW_PATH] = verdict.merged;
          }
        }
      }
    } catch (e) {
      // Never fails the pass, for the same reason the one above does not: the
      // clone keeps the workflow it had a moment ago, which is the state every
      // cascade before this one left it in.
      console.warn(
        `[cascade] deploy workflow reconcile skipped for clone ${clone.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // ── Which of prime's deletions this delivery makes ──────────────────────
  //
  // Decided HERE, before the spec channel, and the order is the fix. The
  // channel's reverse half asks what the delivery CHANGES on the clone, and a
  // removal is a change only once it is decided: `pendingDeletes` is the
  // provisional list, and the reference check and the bulk cap below can each
  // withhold any of it. Judged against the provisional list, a kept spec was
  // replaced for a file that then stayed exactly as it was.
  //
  // Three kinds of file can still import what prime deleted. A HELD file,
  // because the cascade cannot change it — `src/App.tsx` is `manual_reconcile`
  // on the client-facing mirror and imports from the AML shell. A CLONE-ONLY
  // file, because prime has never seen it. And a deletion this very check
  // WITHHOLDS: a kept file is an old prime version, and an old prime version
  // imports exactly what prime deleted beside it, because a decommission
  // leaves in one commit. Everything else is either delivered by this run
  // (prime's own content, which cannot import a path prime deleted) or
  // byte-identical to prime's copy, which cannot either.
  //
  // One more kind is asked later, and only once: a spec this clone keeps at a
  // different version from prime's. Whether it STAYS is the channel's to
  // decide — a kept spec left behind by a removal is brought across with it
  // where prime's history allows, and prime's copy cannot import the file
  // prime deleted — so it is a survivor only once the channel has spoken.
  // Counted here, it would withhold every removal it asserts about, and a spec
  // is never brought across for a removal that does not happen: the deletion
  // would be held for ever by the very spec it was meant to settle. Below the
  // channel the specs that stayed narrow the plan, and narrowing only ever
  // withholds, so no removal is made that the channel was not told about.
  //
  // Only read when there is a deletion to protect, so a run that deletes
  // nothing spends nothing.
  /** The clone's text of each file this pass has read, or null where it holds none. */
  const cloneTexts = new Map<string, string | null>();
  /**
   * The clone's copy of a file, read once per pass for every question asked
   * of it. Null where the clone holds none or it is binary. A read that FAILS
   * throws and is not remembered: a read that failed is not a file with no
   * imports.
   */
  const readCloneText = async (path: string): Promise<string | null> => {
    const known = cloneTexts.get(path);
    if (known !== undefined) return known;
    const f = await getFileContent(octokit, cloneRef, path);
    const text = f && !f.binary ? f.content : null;
    cloneTexts.set(path, text);
    return text;
  };
  /**
   * What must survive a removal: the clone's copy of every held source and of
   * the files only the clone holds, and `also`. A read that fails leaves the
   * file out — it is not a file with no imports, but it is also not evidence
   * against a deletion, and the bytes rule already stands.
   */
  const deletionSurvivors = async (
    also: ReadonlyMap<string, string>,
  ): Promise<Record<string, string>> => {
    const deleting = new Set(deletionVerdicts.filter((v) => v.act === "delete").map((v) => v.path));
    const heldSources = needsReconcile
      .map((h) => h.path)
      .filter((path) => /\.[cm]?tsx?$/.test(path));
    const cloneOnlySources = deletionCandidates
      .map((c) => c.path)
      .filter((p) => !deleting.has(p) && /\.[cm]?tsx?$/.test(p))
      .sort()
      .slice(0, 60);
    const surviving: Record<string, string> = Object.fromEntries(also);
    await Promise.all(
      [...new Set([...heldSources, ...cloneOnlySources])].map(async (path) => {
        try {
          const text = await readCloneText(path);
          if (text !== null) surviving[path] = text;
        } catch {
          /* leave it out — see above */
        }
      }),
    );
    return surviving;
  };
  /**
   * Withhold every deletion a survivor still imports, closed over its own
   * keeps: a withheld deletion is itself a survivor, and one pass over the
   * graph is not a closure. Measured 16 Sep 2026 on npc-client#189 — held
   * `src/App.tsx` kept `BuilderPortalAdmin.tsx`, the dialog only that page
   * imports was deleted, and the PR could not build. Each newly kept file's
   * source joins the survivors and is scanned like the rest, until nothing
   * more flips. Terminates: every iteration grows `surviving` or
   * `unreadableSurvivors`, both bounded by the verdict list.
   */
  const withholdStillReferenced = async (surviving: Record<string, string>): Promise<void> => {
    deletionVerdicts = withholdReferencedDeletions(deletionVerdicts, surviving);
    const unreadableSurvivors = new Set<string>();
    for (;;) {
      const unread = deletionVerdicts
        .filter((v) => v.act === "keep" && v.reason === "still_referenced")
        .map((v) => v.path)
        .filter((p) => !(p in surviving) && !unreadableSurvivors.has(p));
      if (unread.length === 0) break;
      await Promise.all(
        unread.map(async (path) => {
          try {
            // A read that fails is not a file with no imports — inventing an
            // empty one would ship the very break this check exists to stop.
            // The path is only excused from the closure, never given content.
            const text = await readCloneText(path);
            if (text !== null) surviving[path] = text;
            else unreadableSurvivors.add(path);
          } catch (e) {
            // A rate limit is the window, not this file: defer the clone
            // rather than deliver a tree the unread survivor may contradict.
            if (classifyGitHubFailure(e).kind === "rate_limited") throw e;
            unreadableSurvivors.add(path);
          }
        }),
      );
      deletionVerdicts = withholdReferencedDeletions(deletionVerdicts, surviving);
    }
  };
  if (pendingDeletes.length > 0) await withholdStillReferenced(await deletionSurvivors(new Map()));
  // Approvals are consulted only past the cap, and they are never evidence:
  // a path still has to earn its delete verdict from prime's history before
  // the approved set is even read. See `planDeletions`.
  let deletionPlan = planDeletions(deletionVerdicts, MAX_DELETIONS_PER_CASCADE, deletionApproved);
  /** The removals planned before the channel ran: the most the narrowing can withhold. */
  const plannedBeforeTheChannel: ReadonlySet<string> = new Set(deletionPlan.deletes);
  /**
   * The removals this delivery makes. Every question the channel asks about a
   * removal asks this set, never `pendingDeletes`.
   */
  let deletesCrossing: ReadonlySet<string> = new Set(deletionPlan.deletes);

  // ── The membrane's spec channel, over the FINISHED delivery ────────────
  //
  // Here rather than in the prepare loop, and the difference is a defect
  // rather than a preference. `partition.write` is the CANDIDATE set: a path
  // in it can still be held by the oversize rule, the workflow rule, the
  // backend-identity rule or the membrane's own per-file channels. Judging a
  // spec against the candidates lets it cross beside a subject that was held
  // three lines later — which is exactly the shape this channel exists to
  // refuse. By this point every write is decided, including the three
  // reconciles, so the set is the truth rather than an intention.
  //
  // It costs no read. `deliveredSource` already holds the text of every
  // `.ts`/`.tsx` this pass carries, which is every spec.
  //
  // The gate resolves by CARRYING, not by refusing.
  //
  // A spec and its subject travel together or neither does, and there are two
  // ways to satisfy that. Holding the spec leaves both, which is safe and is
  // what this did first. Carrying the subject brings both, which is what an
  // operator actually wants on a clone that already HOLDS the subject and is
  // simply behind on it — and the fleet's split is 176 files wide, so leaving
  // both meant a standing backlog nobody was going to clear by hand.
  //
  // Three things bound it.
  //
  // A carried subject is judged by `prepareOne`, the same function every
  // other write goes through, so it meets the oversize ceiling, the
  // judging-workflow rule, the backend-identity rule and this edge's own
  // channels on identical terms. Nothing is carried past a rule for having
  // been MENTIONED.
  //
  // A subject an existing rule already holds is never released by this.
  // `planSubjectCarry` returns those refusals and the spec stays stranded
  // with them, now saying which rule stopped which subject.
  //
  // And it answers to the same clock. `shouldStop` is the pass's own budget,
  // so a carry that runs out of window leaves the remaining specs held
  // exactly as they were before this existed, and the next tick resumes.
  //
  // Iterated to a fixed point. Each round either carries at least one subject
  // that was not carried before — a strictly growing subset of prime's paths —
  // or holds at least one spec, a strictly shrinking set; `attemptedSubjects`
  // is what makes the first of those monotone, since a subject that prepared
  // to a hold must not be re-attempted for ever.
  const attemptedSubjects = new Set<string>();
  const carriedSubjects: string[] = [];
  let carryStoppedOnBudget = false;
  let carryHitCeiling = false;
  // Fixed before the loop rather than inside it: `deliveredSource` shrinks as
  // specs are held, so a bound computed per round would move under its own
  // guard.
  //
  // Both halves of the worst case, and the second one was missing: carry
  // rounds are bounded by the 200-subject cap, hold rounds by the number of
  // specs — and a CARRIED subject can itself be a spec, so the set of specs
  // grows by up to the same cap while the loop runs. Counting only the specs
  // present at the start bounded the loop below its own worst case.
  //
  // ── …and the other direction: a spec this clone KEEPS, left behind ─────
  //
  // Everything above judges a spec the delivery CARRIES. The same sentence
  // binds the other way round, and nothing asked it: a subject the delivery
  // carries, asserted about by a spec it does NOT carry. On a mirror that
  // cannot happen — every spec that is behind is a candidate and crosses with
  // everything else — but on a module-scoped clone it is the common case, and
  // cascade PR #26 to `npc-crm-independent-6505dc` failed `verify` on four
  // specs the clone held at an older version while the files they test
  // crossed. See `specsLeftBehind.pure.ts`.
  //
  // Read ONCE, here, for the specs both sides hold at different versions that
  // the delivery is not already carrying: prime's copy and the clone's, since
  // either may name what the other does not — each resolved against its OWN
  // tree, with the modules it imports read from its own side, so a re-export
  // shim is looked through where it lives and an import only the clone holds
  // still names its subject. Batched by blob sha, eighty to a request. A read
  // that fails skips this half for the pass — which is what every pass did
  // before it — except a rate limit, which is the window's answer and defers
  // the clone like any other.
  //
  // "Crossing" for this half is what the delivery CHANGES on the clone
  // (`pathsTheDeliveryChanges`): prime's files written verbatim, a pump's
  // merge where it differs from the clone's file, and the removals the
  // finished deletion plan makes. Not `deliveredPaths`, which also counts
  // every path a pump decided — including its steady state, where the merged
  // file IS the clone's own and nothing is written; the first replay read that
  // as a change and held the clone's own `crmConversations.spec.ts` under
  // "this delivery updates supabase/config.toml" on a delivery that wrote no
  // `config.toml` at all. And not every pumped path left out either, which was
  // wrong the other way: a pump that does change `config.toml` changes it, and
  // a spec asserting about it has to be judged.
  const changedOnClone = () =>
    pathsTheDeliveryChanges({
      entries: treeEntries,
      reconciled: reconciledPaths,
      reconcileWrites,
      rehearsed: rehearsedWrites,
      removing: deletesCrossing,
    });
  const keptSpecSubjects = new Map<string, string[]>();
  /** Prime's text of each kept spec, for what its version would bring with it. */
  const primeKeptText = new Map<string, string>();
  /** The clone's text of each kept spec: what stays wherever the spec does not move. */
  const cloneKeptText = new Map<string, string>();
  if (primeShaByPath !== null && cloneShaByPath !== null) {
    const primeTree = primeShaByPath;
    const cloneTree = cloneShaByPath;
    const changedAtStart = changedOnClone();
    // Nor a path a pump decided. It is the pump's, written or deliberately left
    // as the clone's own, and carrying prime's raw copy in behind a subject
    // would undo the reconcile inside its own pass.
    const kept = specsBothSidesHoldDifferently({ primeSha: primeTree, cloneSha: cloneTree }).filter(
      (path) => !changedAtStart.has(path) && !reconciledPaths.has(path),
    );
    if (kept.length > 0) {
      const readTexts = async (
        ref: RepoRef,
        tree: ReadonlyMap<string, string>,
        paths: string[],
      ) => {
        const entries = paths
          .map((rel) => ({ rel, sha: tree.get(rel) }))
          .filter((e): e is { rel: string; sha: string } => e.sha !== undefined);
        const out = new Map<string, string>();
        for (const [rel, b64] of await fetchBlobTextsBatched(octokit, ref, entries)) {
          out.set(rel, decodeBase64Utf8(b64));
        }
        return out;
      };
      try {
        const [primeSpecs, cloneSpecs] = await Promise.all([
          readTexts(primeRef, primeTree, kept),
          readTexts(cloneRef, cloneTree, kept),
        ]);
        // Each side's copy against its own tree, its modules read from its own
        // repository. What this delivery carries is prime's and already in
        // hand, and a module both sides hold at one blob is read once.
        const treeOf = { prime: primeTree, clone: cloneTree } as const;
        const refOf = { prime: primeRef, clone: cloneRef } as const;
        const specsOf = { prime: primeSpecs, clone: cloneSpecs } as const;
        const textBySha = new Map<string, string>();
        const carried = new Map<string, string>(Object.entries(deliveredSource));
        const moduleText = (side: SpecSide["side"], path: string): string | undefined => {
          if (side === "prime" && carried.has(path)) return carried.get(path);
          const sha = treeOf[side].get(path);
          return sha === undefined ? undefined : textBySha.get(sha);
        };
        const sidesOf = (spec: string): SpecSide[] =>
          (["prime", "clone"] as const).map((side) => ({
            side,
            text: specsOf[side].get(spec),
            tree: treeOf[side],
            readText: (path: string) => moduleText(side, path),
          }));
        const unreadable = { prime: new Set<string>(), clone: new Set<string>() };
        // One read per hop and side: each round learns the modules the last one
        // reached. Prime's side first, so the clone's skips every blob the two
        // share.
        for (let hop = 0; hop <= MAX_SHIM_HOPS; hop += 1) {
          const unread = { prime: new Set<string>(), clone: new Set<string>() };
          for (const spec of kept) {
            subjectsOfKeptSpec({
              specPath: spec,
              sides: sidesOf(spec),
              onUnread: (side, path) => {
                if (!unreadable[side].has(path)) unread[side].add(path);
              },
            });
          }
          if (unread.prime.size === 0 && unread.clone.size === 0) break;
          for (const side of ["prime", "clone"] as const) {
            const asking = [...unread[side]]
              .filter((path) => {
                const sha = treeOf[side].get(path);
                return sha !== undefined && !textBySha.has(sha);
              })
              .sort();
            const read =
              asking.length > 0
                ? await readTexts(refOf[side], treeOf[side], asking)
                : new Map<string, string>();
            for (const path of unread[side]) {
              const sha = treeOf[side].get(path);
              const text = read.get(path);
              if (sha !== undefined && text !== undefined) textBySha.set(sha, text);
              if (moduleText(side, path) === undefined) unreadable[side].add(path);
            }
          }
        }
        for (const spec of kept) {
          const subjects = subjectsOfKeptSpec({ specPath: spec, sides: sidesOf(spec) });
          if (subjects.length > 0) keptSpecSubjects.set(spec, subjects);
        }
        for (const [spec, text] of primeSpecs) primeKeptText.set(spec, text);
        // The clone's copies are the pass's clone reads too: the narrowing
        // below asks the ones that stay what they import.
        for (const [spec, text] of cloneSpecs) {
          cloneKeptText.set(spec, text);
          cloneTexts.set(spec, text);
        }
      } catch (e) {
        if (classifyGitHubFailure(e).kind === "rate_limited") throw e;
        console.warn(
          `[cascade] the specs clone ${clone.id} keeps could not be read — a spec left behind by ` +
            `its subject is not looked for this pass: ${e instanceof Error ? e.message : String(e)}`,
        );
        keptSpecSubjects.clear();
        primeKeptText.clear();
        cloneKeptText.clear();
      }
    }
  }

  // ── …and a spec's subject outside the content roots, on evidence ────────
  //
  // `strandedSubjects` reads a subject under five roots only, so a spec that
  // asserts about a file anywhere else crosses without it. Outside those
  // roots are the files a clone is expected to keep its own version of — its
  // CI, its build, its per-deployment workflows — so a file there counts as a
  // spec's subject only where prime's own history shows the clone's copy is
  // byte-identical to a version prime held, or an operator approved
  // overwriting it: carrying it then loses nothing of the clone's. A file the
  // clone keeps its own version of stays the clone's. See
  // `outsideRootSubjects.pure.ts`.
  //
  // One verdict per path per pass, asked only while something can still be
  // carried, and at most `MAX_OUTSIDE_ROOT_PROBES` probes. A failed read is
  // not a verdict. A file never asked about is not carried; what that means
  // for its spec is decided where the spec is.
  const outsideVerdicts = new Map<string, HoldRelease>();
  /** Files outside the content roots carried beside a spec, and the specs that named them. */
  const outsideCarriedFor = new Map<string, Set<string>>();
  let outsideProbes = 0;
  const outsideHeld = (path: string): HeldPath => ({
    path,
    pattern: "",
    reason: "manual_reconcile",
    note: null,
  });
  const judgeOutsideRoot = async (paths: readonly string[]): Promise<void> => {
    const asking: Array<{ path: string; cloneSha: string }> = [];
    for (const path of paths) {
      if (outsideVerdicts.has(path)) continue;
      const cloneSha = cloneShaByPath?.get(path);
      if (cloneSha === undefined) continue;
      const approved = overwriteApproved.has(path);
      const known = knownHeldEvidence.get(path);
      if (approved || known) {
        outsideVerdicts.set(
          path,
          decideHoldRelease({
            held: outsideHeld(path),
            cloneSha,
            evidence: known ?? null,
            approved,
          }),
        );
        continue;
      }
      asking.push({ path, cloneSha });
    }
    if (asking.length === 0 || shouldStop()) return;
    const room = Math.max(0, MAX_OUTSIDE_ROOT_PROBES - outsideProbes);
    const batch = asking.slice(0, room);
    if (batch.length === 0) return;
    outsideProbes += batch.length;
    const evidence = await probeHeldPaths({
      octokit,
      primeRef,
      candidates: batch,
      maxProbes: batch.length,
    });
    for (const [path, answer] of evidence) {
      if (answer.kind === "unsettled") continue;
      const cloneSha = cloneShaByPath?.get(path) ?? null;
      if (cloneSha) heldLedger[path] = { clone: cloneSha, evidence: answer };
      outsideVerdicts.set(
        path,
        decideHoldRelease({ held: outsideHeld(path), cloneSha, evidence: answer, approved: false }),
      );
    }
  };
  /** Every spec seen left behind this pass: the crossing files it asserts about, and which go. */
  const leftBehind = new Map<string, LeftBehindSpec>();
  /**
   * The kept specs the delivery leaves behind as it stands NOW. The one way
   * this half asks, so no site can judge a spec against a different set: what
   * the delivery changes, and which of those it removes.
   */
  const keptLeftBehind = (): LeftBehindSpec[] =>
    specsLeftBehind({
      kept: keptSpecSubjects,
      crossing: changedOnClone(),
      removing: deletesCrossing,
    });
  /**
   * Every hold this half made or annotated, so each can be written again once
   * the delivery is final. A note is written when its spec is judged, and the
   * delivery still changes after that: a subject is held later in the pass, a
   * removal is withheld once the specs that stay are known. Keyed by spec.
   */
  const reverseHolds = new Map<
    string,
    { current: HeldPath; rebuild: (touch: LeftBehindTouch) => HeldPath | null }
  >();
  /** Put `next` where `prev` stands in both lists, or take `prev` out of both. */
  const replaceHold = (prev: HeldPath, next: HeldPath | null) => {
    for (const list of [partition.held, needsReconcile]) {
      const at = list.indexOf(prev);
      if (at === -1) continue;
      if (next) list[at] = next;
      else list.splice(at, 1);
    }
  };
  /** The evidence verdict per left-behind spec: may prime's copy replace the clone's? */
  const leftBehindVerdicts = new Map<string, HoldRelease>();
  /** A left-behind spec not judged this pass, and why. */
  const leftBehindCut = new Map<string, LeftBehindCutShort>();
  let leftBehindProbes = 0;

  const maxCarryRounds =
    MAX_SUBJECTS_CARRIED * 2 + Object.keys(deliveredSource).length + keptSpecSubjects.size + 1;

  // Imports owed by a subject the carry already brought across. Fed back in
  // as stranded paths, so they meet `planSubjectCarry`, the exclusions, the
  // ceiling and `prepareOne` on the terms every other candidate does.
  const importsOwed = new Set<string>();
  // Past the belt the carry stops being ATTEMPTED and the loop keeps going.
  // See where it is set.
  let carryingAllowed = true;

  for (let round = 0; ; round += 1) {
    const deliveredPaths = new Set([...treeEntries.map((t) => t.path), ...reconciledPaths]);
    const strandedBySpec = new Map<string, string[]>();
    const outsideNamedBy = new Map<string, string[]>();
    for (const [specPath, specText] of Object.entries(deliveredSource)) {
      const stranded = strandedSubjects({
        specPath,
        specText,
        primeSha: primeShaByPath,
        cloneSha: cloneShaByPath,
        crossing: deliveredPaths,
      });
      if (stranded.length > 0) strandedBySpec.set(specPath, stranded);
      if (primeShaByPath !== null && cloneShaByPath !== null) {
        const outside = outsideRootCandidates({
          specPath,
          specText,
          primeSha: primeShaByPath,
          cloneSha: cloneShaByPath,
          crossing: deliveredPaths,
        });
        if (outside.length > 0) outsideNamedBy.set(specPath, outside);
      }
    }
    // A file outside the content roots joins its spec's stranded subjects only
    // on evidence, and is then carried or holds the spec exactly as one inside
    // them does. One never asked about stays out, as it always has.
    if (outsideNamedBy.size > 0) {
      if (carryingAllowed) {
        await judgeOutsideRoot([...new Set([...outsideNamedBy.values()].flat())].sort());
      }
      for (const [specPath, outside] of outsideNamedBy) {
        const travelling = outside.filter((path) => outsideVerdicts.get(path)?.act === "release");
        if (travelling.length === 0) continue;
        strandedBySpec.set(specPath, [...(strandedBySpec.get(specPath) ?? []), ...travelling]);
        for (const path of travelling) {
          const naming = outsideCarriedFor.get(path) ?? new Set<string>();
          naming.add(specPath);
          outsideCarriedFor.set(path, naming);
        }
      }
    }
    // An import already delivered, or already put through the rules once, is
    // settled. Clearing them here is what makes the loop terminate: an owed
    // import that the exclusions refuse becomes `attempted` on its first
    // round and stops being asked for.
    for (const owed of [...importsOwed]) {
      if (deliveredPaths.has(owed) || attemptedSubjects.has(owed)) importsOwed.delete(owed);
    }
    // The other direction. A kept spec whose subject is crossing is carried
    // in behind it on the same terms as a subject — `planSubjectCarry`, the
    // exclusions, `prepareOne` — but only after prime's own history says the
    // clone's copy is an older version of prime's, or an operator approved
    // overwriting it. The spec is outside this clone's scope and no rule sent
    // it, so replacing it must lose nothing of the clone's. Everything else is
    // held for a person, naming the subject that crossed.
    const owedSpecs: string[] = [];
    if (keptSpecSubjects.size > 0) {
      const heldNow = new Set(partition.held.map((h) => h.path));
      const unjudged: Array<{ path: string; cloneSha: string }> = [];
      const leftBehindNow = keptLeftBehind();
      for (const lb of leftBehindNow) {
        leftBehind.set(lb.spec, lb);
        if (heldNow.has(lb.spec) || attemptedSubjects.has(lb.spec)) continue;
        if (leftBehindVerdicts.has(lb.spec)) continue;
        const cloneSha = cloneShaByPath?.get(lb.spec);
        if (cloneSha === undefined) continue;
        if (overwriteApproved.has(lb.spec) || knownHeldEvidence.has(lb.spec)) continue;
        unjudged.push({ path: lb.spec, cloneSha });
      }
      // Asked only while something can still be carried: a verdict nobody can
      // act on this pass is a request spent for nothing.
      let evidence = new Map<string, HeldPathEvidence>();
      if (carryingAllowed && unjudged.length > 0) {
        if (shouldStop()) {
          for (const u of unjudged) leftBehindCut.set(u.path, "budget");
        } else {
          const room = Math.max(0, MAX_LEFT_BEHIND_PROBES - leftBehindProbes);
          const asking = unjudged.slice(0, room);
          for (const u of unjudged.slice(room)) leftBehindCut.set(u.path, "probes");
          if (asking.length > 0) {
            leftBehindProbes += asking.length;
            evidence = await probeHeldPaths({
              octokit,
              primeRef,
              candidates: asking,
              maxProbes: asking.length,
            });
            for (const [path, answer] of evidence) {
              if (answer.kind === "unsettled") continue;
              const clone = cloneShaByPath?.get(path);
              if (clone) heldLedger[path] = { clone, evidence: answer };
            }
          }
        }
      }
      const releasing: string[] = [];
      for (const lb of leftBehindNow) {
        if (heldNow.has(lb.spec) || attemptedSubjects.has(lb.spec)) continue;
        let verdict = leftBehindVerdicts.get(lb.spec);
        if (verdict === undefined) {
          const approved = overwriteApproved.has(lb.spec);
          const answer = knownHeldEvidence.get(lb.spec) ?? evidence.get(lb.spec) ?? null;
          // Not judged this round and nothing on file: left for the sweep.
          if (!approved && answer === null) continue;
          verdict = decideHoldRelease({
            held: { path: lb.spec, pattern: "", reason: "manual_reconcile", note: null },
            cloneSha: cloneShaByPath?.get(lb.spec) ?? null,
            evidence: answer,
            approved,
          });
          leftBehindVerdicts.set(lb.spec, verdict);
          leftBehindCut.delete(lb.spec);
          if (verdict.act === "hold") {
            const held = leftBehindSpecHold({
              membrane,
              spec: lb.spec,
              touchedBy: lb.touchedBy,
              removed: lb.removed,
              why: verdict.why,
            });
            partition.held.push(held);
            needsReconcile.push(held);
            attemptedSubjects.add(lb.spec);
            const why = verdict.why;
            reverseHolds.set(lb.spec, {
              current: held,
              rebuild: (touch) =>
                touch.touchedBy.length + (touch.withheld?.length ?? 0) === 0
                  ? null
                  : leftBehindSpecHold({ membrane, spec: lb.spec, ...touch, why }),
            });
            continue;
          }
        }
        if (verdict.act === "release") releasing.push(lb.spec);
      }
      // Prime's copy may assert about a file outside the content roots that
      // the clone holds at an older version and no delivery would carry —
      // `reportTypography.spec.ts` reads a document under `.claude/`. Asked
      // BEFORE the spec moves: once it has, a file nobody asked about would
      // leave prime's newer assertions running against the older copy, which
      // is worse than the older spec this replaces. What the answers bring is
      // then carried beside the spec by the stranded-subject rule above.
      if (releasing.length > 0) {
        const outsideOf = new Map<string, string[]>();
        for (const spec of releasing) {
          const text = primeKeptText.get(spec);
          outsideOf.set(
            spec,
            text !== undefined && primeShaByPath !== null && cloneShaByPath !== null
              ? outsideRootCandidates({
                  specPath: spec,
                  specText: text,
                  primeSha: primeShaByPath,
                  cloneSha: cloneShaByPath,
                  crossing: deliveredPaths,
                })
              : [],
          );
        }
        if (carryingAllowed) {
          await judgeOutsideRoot([...new Set([...outsideOf.values()].flat())].sort());
        }
        for (const spec of releasing) {
          if ((outsideOf.get(spec) ?? []).some((path) => !outsideVerdicts.has(path))) {
            leftBehindCut.set(spec, shouldStop() ? "budget" : "outside_probes");
            continue;
          }
          leftBehindCut.delete(spec);
          owedSpecs.push(spec);
        }
      }
    }
    if (
      strandedBySpec.size === 0 &&
      (!carryingAllowed || (importsOwed.size === 0 && owedSpecs.length === 0))
    ) {
      break;
    }

    // Try to bring the subjects across before deciding the specs cannot go.
    const plan = planSubjectCarry({
      stranded: [...[...strandedBySpec.values()].flat(), ...importsOwed, ...owedSpecs],
      held: partition.held,
      attempted: attemptedSubjects,
      limit: Math.max(0, MAX_SUBJECTS_CARRIED - carriedSubjects.length),
    });
    if (plan.atCeiling) carryHitCeiling = true;
    // A round that can plan NOTHING will never mark an owed import attempted,
    // and `importsOwed` is only cleared of what was delivered or attempted —
    // so the loop would spin over a set nothing can consume until the belt
    // fires, re-scanning the whole delivery each time. Nothing more will be
    // carried this pass; the next tick re-derives what is owed from the
    // delivery it makes. Keyed on an empty plan rather than on `atCeiling`,
    // which is also true of a round that truncated and carried the rest.
    if (plan.carry.length === 0) carryingAllowed = false;

    // Through the PATH rules before the content rules, which is the order
    // every other candidate meets them in.
    //
    // `planSubjectCarry` refuses what `partition.held` already holds, and on a
    // MIRROR that is sufficient: `candidatePaths` there is every path whose
    // SHAs differ, so a stranded subject — which differs by definition — was
    // partitioned and its exclusions applied. On a MODULE-SCOPED clone it is
    // not: `candidatePaths` is the installed globs plus the repository
    // invariants, so a subject outside that scope was never put through
    // `partitionCascadePaths` at all, has no hold for the plan to see, and
    // would have been carried without its exclusions ever being asked.
    //
    // `backendIdentityHold` inside `prepareOne` would still have caught the
    // worst of it, but that is a different rule catching it by luck rather
    // than the rule that governs it. Partitioning here is the same function
    // over the same exclusions, so a protected path is protected whether the
    // clone installs the module it lives in or not.
    const gated = partitionCascadePaths(plan.carry, exclusions);
    // Marked attempted whichever way they went: a subject the exclusions hold
    // is settled, and re-planning it every round would never terminate.
    for (const h of gated.held) attemptedSubjects.add(h.path);
    const carryRefusals = [
      ...plan.refused,
      ...gated.held.map((h) => ({ subject: h.path, reason: h.reason })),
    ];
    for (const h of gated.held) partition.held.push(h);
    // Through `reportableHeld`, like every other producer of this list.
    //
    // `needsReconcile` is `reportableHeld(partition.held)` everywhere else,
    // and that filter keeps `protected` out on purpose: `decideHoldRelease`
    // refuses a protected path outright, so an approval drawn over one
    // reports success and releases nothing, for ever. Pushing `gated.held`
    // raw put exactly that button on the dry-run card — `partitionCascadePaths`
    // emits the exclusion row's OWN reason, and on a module-scoped clone a
    // carried subject outside the installed globs was never partitioned
    // before, so it has no earlier hold to be recognised by.
    needsReconcile.push(...reportableHeld(gated.held));

    if (carryingAllowed && gated.write.length > 0 && !carryStoppedOnBudget) {
      for (const subject of plan.carry) attemptedSubjects.add(subject);
      const { results: carried, stopped } = await mapWithConcurrencyUntil<string, Prepared | null>(
        gated.write,
        8,
        prepareOne,
        shouldStop,
      );
      // Deliberately NOT the `preparePaused` treatment. That one hands the
      // event back because half a module's diff is worse than none; this one
      // leaves a delivery that is already coherent — every spec whose subject
      // did not arrive is held with it — so it ships, and the next tick
      // carries the rest. The specs say they were cut short rather than
      // refused.
      // The budget stopped the carry, so stop attempting it — for the same
      // reason as above, and because "we ran out of window" and "we will try
      // again in a moment" are the same sentence.
      if (stopped) {
        carryStoppedOnBudget = true;
        carryingAllowed = false;
      }
      // Through the same absorber the main pass uses, so a carried subject
      // reaches `deliveredSource` and is itself re-read for stranded
      // subjects — a spec can carry a spec. A subject that met a rule of its
      // own is held by it, and the spec that named it strands again next
      // round, which is correct and now says which rule stopped it.
      const written = absorbPrepared(carried);
      carriedSubjects.push(...written);
      // A carried subject is a delivered module, so it answers to the import
      // closure like any other. Asking only at the top of the pass is how a
      // carried module arrives without what it imports, permanently: the
      // closure runs ~1,100 lines above this loop and nothing feeds back into
      // it. The answer is owed rather than written — it re-enters as a
      // stranded path next round and meets every rule on the way.
      if (written.length > 0 && importClosure) {
        const have = new Set([...treeEntries.map((t) => t.path), ...reconciledPaths]);
        for (const owed of await importClosure(written, have)) importsOwed.add(owed);
      }
      // Something crossed, so re-ask before condemning any spec.
      if (written.length > 0) continue;
    }

    // Nothing more can be carried for these specs. Hold them, naming the
    // refusals rather than repeating the generic instruction.
    //
    // Read from `partition.held` HERE rather than from `plan.refused`, which
    // was computed at the top of this round: where every carried subject met
    // a rule of its own, those holds were pushed by `absorbPrepared` a few
    // lines ago and the plan predates all of them. Using the plan would print
    // the generic instruction on exactly the case that has a specific answer.
    const refusedBySubject = new Map<string, { subject: string; reason: ExclusionReason }>();
    for (const r of carryRefusals) refusedBySubject.set(r.subject, r);
    for (const h of partition.held) {
      if (!refusedBySubject.has(h.path))
        refusedBySubject.set(h.path, { subject: h.path, reason: h.reason });
    }
    for (const [specPath, stranded] of strandedBySpec) {
      const refused = stranded
        .map((s) => refusedBySubject.get(s))
        .filter((r): r is { subject: string; reason: ExclusionReason } => r !== undefined);
      const held = orphanSpecHoldAfterCarry({
        membrane,
        specPath,
        stranded,
        refused,
        // The two facts this loop was computing and throwing away. "We could
        // not" and "we did not get to" send an operator to opposite places —
        // which is why the word is decided per SPEC rather than per pass.
        //
        // `carryStoppedOnBudget` and `carryHitCeiling` are set once for the
        // whole pass and were then stamped on every spec held in every later
        // round, including one whose subjects were each permanently refused
        // by a rule. That note reads "we ran out of time" over a list of
        // reasons we did not, and the operator waits for a next tick to
        // finish something no tick can.
        cutShort:
          refused.length === stranded.length
            ? null
            : carryStoppedOnBudget
              ? "budget"
              : carryHitCeiling
                ? "ceiling"
                : null,
      });
      // Brought in only because the clone's older copy was being left behind:
      // that older copy is what stays, and the hold says so.
      const lb = leftBehind.get(specPath);
      const hold = lb ? withLeftBehindNote(held, lb) : held;
      partition.held.push(hold);
      needsReconcile.push(hold);
      if (lb) {
        reverseHolds.set(specPath, {
          current: hold,
          rebuild: (touch) => withLeftBehindNote(held, touch),
        });
      }
      delete deliveredSource[specPath];
      for (let i = treeEntries.length - 1; i >= 0; i -= 1) {
        if (treeEntries[i].path === specPath) treeEntries.splice(i, 1);
      }
    }

    // A belt on top of the monotonicity argument above: a round that neither
    // carried nor held would loop, and this stops it.
    //
    // It stops the CARRY, not the loop. Holding a spec takes it out of the
    // delivery, and another spec may name it as a subject — so the round that
    // holds can strand one it did not see, and a bare `break` here shipped
    // that spec without its subject, which is the one thing this channel
    // exists to prevent. With carrying off, every remaining round holds at
    // least one spec and `deliveredSource` strictly shrinks, so it settles in
    // at most one round per spec.
    if (round >= maxCarryRounds) carryingAllowed = false;
  }

  // Every kept spec still left behind once the delivery is final, that no
  // rule already holds, is held here — never shipped past. Two ways to reach
  // this: prime's history cleared it and the carry stopped before it (the
  // budget or a ceiling), or it was never judged at all (the budget, or the
  // probe ceiling). Both clear on a later pass, and the note says which.
  if (keptSpecSubjects.size > 0) {
    const heldNow = new Set(partition.held.map((h) => h.path));
    for (const lb of keptLeftBehind()) {
      leftBehind.set(lb.spec, lb);
      if (heldNow.has(lb.spec)) continue;
      const cutShort: LeftBehindCutShort =
        leftBehindCut.get(lb.spec) ?? (carryStoppedOnBudget ? "budget" : "ceiling");
      const held = leftBehindSpecHold({
        membrane,
        spec: lb.spec,
        touchedBy: lb.touchedBy,
        removed: lb.removed,
        cutShort,
      });
      partition.held.push(held);
      needsReconcile.push(held);
      reverseHolds.set(lb.spec, {
        current: held,
        rebuild: (touch) =>
          touch.touchedBy.length + (touch.withheld?.length ?? 0) === 0
            ? null
            : leftBehindSpecHold({ membrane, spec: lb.spec, ...touch, cutShort }),
      });
    }
  }

  // ── …and the removals, once the specs that stay are known ───────────────
  //
  // A kept spec the channel did not bring across stays on the clone as it is,
  // and a file it imports cannot be removed beneath it: the reference check's
  // own rule, asked of the one kind of survivor it could not ask before the
  // channel ran (see "Which of prime's deletions this delivery makes"). The
  // held files are asked again as well, because the channel holds specs of
  // its own.
  //
  // Narrowing only ever withholds. A plan the bulk cap refused has nothing to
  // narrow, and a plan it accepted stays accepted with fewer paths in it —
  // still under the cap, or still wholly approved — so no removal is made
  // that the channel was not told about. What it withholds is named on every
  // hold that asserts about it, below.
  if (deletesCrossing.size > 0 && deletionPlan.refusal === null) {
    const landedNow = new Set(treeEntries.filter((t) => t.sha !== null).map((t) => t.path));
    const staying = new Map([...cloneKeptText].filter(([spec]) => !landedNow.has(spec)));
    await withholdStillReferenced(await deletionSurvivors(staying));
    deletionPlan = planDeletions(deletionVerdicts, MAX_DELETIONS_PER_CASCADE, deletionApproved);
    deletesCrossing = new Set(deletionPlan.deletes);
  }

  // ── the Edge Function type baseline follows the files it counts ───────
  //
  // `supabase/functions-registry/**` is a repository invariant, so prime's
  // `edge-typecheck-baseline.json` crosses on every pass — and it counts the
  // type errors in PRIME'S files. Where this clone keeps its own version of a
  // counted file, prime's number describes a file the clone does not hold,
  // and the gate reads an unchanged file as a regression. Cascade #23 to the
  // CRM failed `security` on `manage-ci-assessments` 0 → 4 over a file
  // nobody touched, and every later cascade would have failed the same way.
  //
  // AFTER the subject carry, because what crosses decides whose count
  // stands: a subject carried in behind a spec is prime's file, and prime's
  // count describes it. A delete crosses too — the clone's version does not
  // survive it. Nothing is asked unless prime's baseline is in the delivery
  // (identical files owe nothing), and a refusal leaves prime's copy standing,
  // which is what every pass did before this.
  //
  // Written inline rather than as a blob, so a rehearsal reports the file it
  // would write rather than dropping it.
  let edgeBaselineNote: string | null = null;
  if (
    mode !== "notify" &&
    primeShaByPath !== null &&
    cloneShaByPath !== null &&
    treeEntries.some((t) => t.path === EDGE_TYPECHECK_BASELINE_PATH && t.sha !== null)
  ) {
    try {
      const [primeBaseline, cloneBaseline] = await Promise.all([
        getFileContent(octokit, primeRef, EDGE_TYPECHECK_BASELINE_PATH),
        getFileContent(octokit, cloneRef, EDGE_TYPECHECK_BASELINE_PATH),
      ]);
      if (primeBaseline && cloneBaseline && !primeBaseline.binary && !cloneBaseline.binary) {
        const crossing = new Set<string>([
          ...treeEntries.filter((t) => t.sha !== null).map((t) => t.path),
          ...deletesCrossing,
        ]);
        const verdict = reconcileEdgeTypecheckBaseline({
          primeJson: primeBaseline.content,
          cloneJson: cloneBaseline.content,
          primeSha: primeShaByPath,
          cloneSha: cloneShaByPath,
          crossing,
        });
        if (!verdict.ok) {
          console.warn(
            `[cascade] ${EDGE_TYPECHECK_BASELINE_PATH} not reconciled for clone ${clone.id}, ` +
              `prime's copy stands: ${verdict.reason}`,
          );
        } else if (verdict.keptFromClone.length > 0) {
          dropFromTree(EDGE_TYPECHECK_BASELINE_PATH);
          // Where the clone's file already says what the reconcile says,
          // there is nothing to write and nothing to report as written.
          if (verdict.merged !== cloneBaseline.content) {
            treeEntries.push({
              path: EDGE_TYPECHECK_BASELINE_PATH,
              mode: "100644",
              type: "blob",
              content: verdict.merged,
            });
            deliveredSource[EDGE_TYPECHECK_BASELINE_PATH] = verdict.merged;
          }
          edgeBaselineNote = `${EDGE_TYPECHECK_BASELINE_PATH} · ${describeKeptCounts(verdict.keptFromClone)}`;
        }
      }
    } catch (e) {
      // Never fails the pass: prime's copy is what every pass before this
      // one delivered.
      console.warn(
        `[cascade] ${EDGE_TYPECHECK_BASELINE_PATH} reconcile skipped for clone ${clone.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  // ── Every note this half wrote, written again from the finished delivery ─
  //
  // A note was written when its spec was judged, and three things can happen
  // after that: a subject is held later in the pass, a removal is withheld by
  // the narrowing above, and the type baseline keeps the clone's own file. So
  // each is rewritten from what the delivery finally does. A withheld removal
  // is named as withheld; a hold left with nothing to say is dropped, because
  // nothing it asserts about changes and no removal waits on it — the spec
  // simply stays, as it would have without this half.
  if (reverseHolds.size > 0) {
    const finalLeftBehind = new Map(keptLeftBehind().map((lb) => [lb.spec, lb]));
    const withheldRemovals = [...plannedBeforeTheChannel].filter((p) => !deletesCrossing.has(p));
    for (const [spec, entry] of reverseHolds) {
      const lb = finalLeftBehind.get(spec);
      const subjects = new Set(keptSpecSubjects.get(spec) ?? []);
      const next = entry.rebuild({
        touchedBy: lb?.touchedBy ?? [],
        removed: lb?.removed ?? [],
        withheld: withheldRemovals.filter((path) => subjects.has(path)).sort(),
      });
      replaceHold(entry.current, next);
      if (next) entry.current = next;
      else reverseHolds.delete(spec);
    }
  }

  // Named in the pull request: a spec brought up to date with the file it
  // tests, and a file outside the content roots carried beside the spec that
  // asserts about it. Neither is in this clone's scope, so the diff would
  // otherwise show them with no reason given. Only what actually landed, and
  // named for what the delivery finally does: a file it was brought across
  // for that the delivery no longer changes is said to be unchanged.
  const basisOf = (verdict: HoldRelease | undefined): CarryBasis =>
    verdict?.act === "release" && verdict.basis === "approved" ? "approved" : "unedited";
  const landed = new Set(treeEntries.filter((t) => t.sha !== null).map((t) => t.path));
  const finalChanged = changedOnClone();
  const specsBroughtAcrossNote = describeSpecsBroughtAcross({
    specs: [...leftBehindVerdicts]
      .filter(([spec, verdict]) => verdict.act === "release" && landed.has(spec))
      .map(([spec, verdict]) => {
        const touchedBy = (keptSpecSubjects.get(spec) ?? []).filter(
          (subject) => subject !== spec && finalChanged.has(subject),
        );
        return {
          spec,
          touchedBy,
          removed: touchedBy.filter((subject) => deletesCrossing.has(subject)),
          unchanged: (leftBehind.get(spec)?.touchedBy ?? []).filter((s) => !finalChanged.has(s)),
          basis: basisOf(verdict),
        };
      }),
    outside: [...outsideCarriedFor]
      .filter(([path]) => landed.has(path))
      .map(([path, naming]) => ({
        path,
        specs: [...naming].filter((spec) => landed.has(spec)).sort(),
        basis: basisOf(outsideVerdicts.get(path)),
      }))
      .filter((o) => o.specs.length > 0),
  });

  // The finished pass's own ledger, carried on the result row so the NEXT
  // pass — for whatever prime commit — reuses every blob prime still holds.
  // Real path only; a rehearsal records nothing.
  //
  // AFTER the carry, not before it. The ledger holds what this pass paid for,
  // and a subject carried in behind a spec is paid for like any other file —
  // it buys a blob when it is binary. Evaluating the condition above the
  // carry meant a pass whose main loop prepared nothing and whose carry
  // prepared several recorded none of them, and bought them again next tick.
  const finalProgress: Partial<CascadeResultUpdate> =
    resume && Object.keys(progress.prepared).length > 0
      ? { progress: progress as unknown as Json }
      : {};

  // A cascade whose only work is a removal is still work. Keying this on
  // `treeEntries` alone would report "already in sync" while the clone still
  // held a file prime deleted — which is the whole defect this is here for.
  if (treeEntries.length === 0 && pendingDeletes.length === 0) {
    // "Nothing to write" and "nothing differed" are different states, and the
    // second one is the one an operator can safely ignore. A mirror whose only
    // differences were all withheld must not report as in sync.
    //
    // The test is `held > 0`, not `write.length === 0`. A content hold
    // (`backendIdentityHold`) is decided while the blob is being prepared, so
    // its path is still in `partition.write` — it passed the path rules — and
    // keying on that count would report a cascade that withheld every one of
    // its files as "already in sync". We are inside `treeEntries.length === 0`,
    // so nothing was written by definition; anything withheld therefore
    // accounts for every path that reached a decision.
    // The oversize clause rides on BOTH readings deliberately. "Already in
    // sync" is the stronger claim of the two, and a clone that is missing a
    // file prime holds is not in sync however little differed — so if a
    // ceiling ever holds a path on a pass that reports no differences, that
    // sentence has to carry the contradiction rather than hide it.
    const why =
      (partition.held.length > 0
        ? `Nothing to cascade: all ${partition.held.length} differing path(s) are withheld by this clone's exclusion policy`
        : `Already in sync with ${sourceLabel}@${shortSha(sourceSha)}`) +
      oversizeHoldNotice(partition.held);
    return {
      status: "skipped",
      diff_summary: why,
      files_changed: 0,
      completed_at: new Date().toISOString(),
      // A verified no-op is a claim about a revision: the pass resolved
      // prime's head, compared trees, and found nothing owed. The pointer
      // may advance on it exactly as on a merge, and this is what carries
      // the revision — provenance cannot, because a folded carrier's
      // `source_sha` predates what its pass actually verified.
      delivered_sha: deliveredSha,
    };
  }

  // Does this cascade break a file it is not allowed to touch?
  //
  // A `manual_reconcile` path is held because the clone's copy must win. That
  // hold cannot notice that a file the cascade DID deliver removed a symbol the
  // held file still imports — which is exactly how prime@909417c put
  // `src/App.tsx` on this clone's `main` importing an `AmlIntakeQueue` that
  // `AmlShellPages.tsx` had stopped exporting, failing every Vercel deployment
  // while the cascade reported the same "1 awaiting manual reconcile" it
  // reports on every healthy run.
  //
  // Only the clone's copy of the reportable held paths is read, and only when
  // this cascade actually delivers TypeScript — a handful of files on the runs
  // that can break this way, and no request at all on the ones that cannot.
  let staleHeld: StaleHeldReference[] = [];
  let missingHeld: MissingHeldReference[] = [];
  const heldSourcePaths = needsReconcile
    .map((h) => h.path)
    .filter((path) => /\.[cm]?tsx?$/.test(path));
  if (heldSourcePaths.length > 0 && Object.keys(deliveredSource).length > 0) {
    // The clone's copies, through the pass's one clone reader: the deletion
    // reference check has usually read them already.
    const heldFiles: Record<string, string> = {};
    const heldFilesPrime: Record<string, string> = {};
    await Promise.all(
      heldSourcePaths.flatMap((path) => [
        // A read that fails is not a file with no imports. Skipping it loses a
        // warning; inventing an empty one would claim the cascade is safe.
        (async () => {
          try {
            const text = await readCloneText(path);
            if (text !== null) heldFiles[path] = text;
          } catch {
            /* leave it out — see above */
          }
        })(),
        // The prime's copy of the same path: the one the cascade DECLINED to
        // write. Comparing the two in general is meaningless — they differ on
        // purpose, which is what "held" means — but comparing what each imports
        // from a module this run is delivering is not.
        (async () => {
          try {
            const f = await getFileContent(octokit, primeRef, path);
            if (f) heldFilesPrime[path] = f.content;
          } catch {
            /* leave it out — see above */
          }
        })(),
      ]),
    );
    staleHeld = findStaleHeldReferences({ heldFiles, cascadedFiles: deliveredSource });
    missingHeld = findMissingHeldReferences({
      heldFilesClone: heldFiles,
      heldFilesPrime,
      cascadedFiles: deliveredSource,
    });
  }
  const missingSuffix =
    missingHeld.length > 0
      ? ` · ${missingHeld.length} held file(s) MISSING new wiring: ${missingHeld
          .map((r) => `${r.heldPath} needs ${r.missing.join("/")}`)
          .join("; ")}`
      : "";
  const staleSuffix =
    staleHeld.length > 0
      ? ` · BREAKS ${staleHeld.length} held file(s): ${staleHeld
          .map((r) => `${r.heldPath} needs ${r.missing.join("/")}`)
          .join("; ")}`
      : "";

  for (const path of deletionPlan.deletes) {
    // `sha: null` is how a tree entry removes a path from `base_tree`.
    treeEntries.push({ path, mode: "100644" as const, type: "blob" as const, sha: null });
  }
  if (treeEntries.length === 0) {
    // Every deletion this run found was withheld — by a reference, by an edit,
    // or by the bulk refusal — and nothing else differed. Saying "in sync"
    // here would be the original defect wearing a new hat.
    return {
      status: "skipped",
      diff_summary:
        `Nothing to cascade: ${deletionPlan.kept.length} prime deletion(s) withheld` +
        `${deletionSuffixFor(deletionPlan)}${oversizeHoldNotice(partition.held)}`,
      files_changed: 0,
      completed_at: new Date().toISOString(),
      // Withheld-by-policy is still verified: nothing DELIVERABLE from this
      // revision is owed, which is what the pointer measures.
      delivered_sha: deliveredSha,
      ...finalProgress,
    };
  }

  // Build the "diff_summary" — first 5 file paths + count of remainder.
  // If any library pins were honored, surface that in the summary too.
  const summaryFiles = treeEntries.slice(0, 5).map((t) => t.path);
  const summarySuffix = treeEntries.length > 5 ? ` (+${treeEntries.length - 5} more)` : "";
  const pinSuffix = pinSummary ? ` · ${pinSummary}` : "";
  const heldSuffix = partition.held.length > 0 ? ` · ${partition.held.length} withheld` : "";
  const reconcileSuffix = reconcileSuffixFor(needsReconcile.length);
  const releaseSuffix = holdReleaseSuffixFor(holdReleases);
  const deleteSuffix = deletionSuffixFor(deletionPlan);
  const fileSummary = `${summaryFiles.join(", ")}${summarySuffix}${pinSuffix}${heldSuffix}${reconcileSuffix}${releaseSuffix}${deleteSuffix}${staleSuffix}${missingSuffix}`;

  // The decision, complete, and the last point before anything is written.
  // Emitted on BOTH paths deliberately: a dry run that took a different route
  // to its answer would be a second implementation again.
  args.onPlan?.({
    cloneId: clone.id,
    scope: scopeLabel,
    writes: treeEntries.filter((t) => t.sha !== null).map((t) => t.path),
    deletes: deletionPlan.deletes,
    heldTotal: partition.held.length,
    needsReconcile: needsReconcile.map((h) => h.path),
    // Named from the holds themselves rather than by re-filtering the path
    // list, which has no reasons on it.
    oversizePaths: needsReconcile.filter((h) => h.reason === "oversize").map((h) => h.path),
    deletionKept: deletionPlan.kept,
    deletionRefusal: deletionPlan.refusal,
    refusedDeletionPaths: deletionPlan.refusedPaths,
    holdReleases,
    staleHeld,
    missingHeld,
    onlyInClone,
    unprobedDeletions,
    summary: fileSummary,
  });

  if (dryRun) {
    return {
      status: "skipped",
      diff_summary: `[dry run] ${fileSummary}`,
      files_changed: treeEntries.length,
      completed_at: new Date().toISOString(),
    };
  }

  // Re-read the clone's head HERE, rather than trusting the one captured at the
  // top of this function.
  //
  // Everything between the two reads is slow: two recursive tree listings, a
  // blob fetch per changed file, and both held-file guards. The merge drain
  // runs every five minutes and merges an earlier proposal in exactly that
  // window — and then this proposal is built on a parent that no longer
  // exists on the branch, so GitHub reports it `dirty` and it can never merge.
  //
  // That is not hypothetical: pull request #71 was cut from `6eaaf5a` while
  // the drain merged #70 at 10:00:07, and arrived conflicted against a `main`
  // it had been current with seconds earlier.
  //
  // The base tree and the parent MUST come from the same read. A fresh parent
  // with a stale base tree is worse than the race it fixes: it would silently
  // revert whatever landed in between.
  let parentSha = cloneBranchSha;
  try {
    const { data: fresh } = await octokit.repos.getBranch({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      branch: cloneRef.branch,
    });
    parentSha = fresh.commit.sha;
  } catch {
    // A failed re-read is not a moved branch. Keeping the earlier value is the
    // old behaviour, which is wrong only in the window this closes — refusing
    // the whole cascade over it would be worse.
  }

  const { data: cloneCommit } = await octokit.git.getCommit({
    owner: cloneRef.owner,
    repo: cloneRef.repo,
    commit_sha: parentSha,
  });
  // The chunked chain: each call layers up to ~120 entries (bounded in bytes
  // too) over the tree the previous call produced, text travelling INLINE so
  // the server mints its blobs — one call per ~hundred files instead of one
  // per file. Chunks preserve order, paths are unique, and a deletion entry
  // (`sha: null`) composes over `base_tree` exactly as it did in one call.
  // A rate limit mid-chain throws to the per-clone classifier and the clone
  // defers; the part-built trees are unreachable objects GitHub collects.
  let chainedTreeSha = cloneCommit.tree.sha;
  for (const chunk of chunkTreeEntries(treeEntries)) {
    const { data: chunkTree } = await octokit.git.createTree({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      base_tree: chainedTreeSha,
      tree: chunk.map(toGitTreeParam),
    });
    chainedTreeSha = chunkTree.sha;
  }
  const newTree = { sha: chainedTreeSha };

  // A removal is marked in the commit body. The subject line's shape is
  // unchanged and deliberately so: `isEngineOnlyBranch` recognises an
  // unmodified proposal by this exact prefix, and a proposal the repair path
  // stops recognising is one that can never be rebuilt.
  const message =
    `chore(aurixa): cascade ${treeEntries.length} file(s) from ${sourceLabel}@${shortSha(sourceSha)}\n\n` +
    treeEntries.map((t) => `- ${t.sha === null ? "DELETE " : ""}${t.path}`).join("\n");

  // What the pull request has to say beyond the file list. `manual_reconcile`
  // paths are the reason this section exists: withholding them silently is how
  // a clone stops learning about new routes without anyone noticing.
  const cascadeBody = (lead: string) =>
    lead +
    `\n\nScope: **${scopeLabel}**.\n\n` +
    `Files synchronized:\n\n` +
    treeEntries
      .map((t) => `- \`${t.path}\`${t.sha === null ? " — **removed**, prime deleted it" : ""}`)
      .join("\n") +
    (staleHeld.length > 0
      ? `\n\n### ⚠ This cascade breaks a held file\n\n` +
        `A file this cascade delivers no longer exports something a withheld file still imports. ` +
        `Merging this as-is puts the clone's default branch in a state that cannot build — ` +
        `the bundler fails with "is not exported by", not a test.\n\n` +
        describeStaleHeldReferences(staleHeld)
          .map((l) => `- ${l}`)
          .join("\n") +
        `\n\nRepair the held file in the same merge, or carry the removal across by hand.`
      : "") +
    (missingHeld.length > 0
      ? `\n\n### ⚠ A held file is missing wiring this cascade delivered\n\n` +
        `Upstream uses something from a file this cascade DID deliver, and this clone's ` +
        `held copy does not. Nothing fails the build — the routes or components are simply ` +
        `absent here, and stay absent until somebody brings them across.\n\n` +
        describeMissingHeldReferences(missingHeld)
          .map((l) => `- ${l}`)
          .join("\n") +
        `\n\nAdd the import and its use to the held file in the same merge.`
      : "") +
    (configReconcileNote
      ? `\n\n### The Supabase config was reconciled, not copied\n\n` +
        `\`${CONFIG_TOML_PATH}\` is a **protected** exclusion and prime's copy was not written. ` +
        `What travelled is prime's file with this clone's own \`project_id\` line put back, so the ` +
        `per-function \`verify_jwt\` declarations arrive while the project this deployment talks ` +
        `to does not change. An omitted \`[functions.X]\` block is read by the CLI as ` +
        `\`verify_jwt = true\`, which gates a function prime declares open.\n\n` +
        `- ${configReconcileNote}`
      : "") +
    (baselineNotes.length
      ? `\n\n### The security baselines were recomputed, not copied\n\n` +
        `\`${SECURITY_INVENTORY_PATH}\` and \`${FUNCTION_COUNT_RATCHET_PATH}\` each state how ` +
        `many edge functions a repository has, so prime's copies state PRIME'S count. This ` +
        `deployment owns ${cloneOwnedFunctions.length} function(s) prime does not ` +
        `(${cloneOwnedFunctions.join(", ")}), so both were computed from the \`config.toml\` and ` +
        `security registry this same pass reconciled — the numbers describe the tree this ` +
        `proposal creates rather than either side's.\n\n` +
        baselineNotes.map((l) => `- ${l}`).join("\n")
      : "") +
    (edgeBaselineNote
      ? `\n\n### The Edge Function type baseline followed the files it counts\n\n` +
        `\`${EDGE_TYPECHECK_BASELINE_PATH}\` freezes the type errors in each edge-function file, ` +
        `and prime's copy counts PRIME'S files. Where this clone keeps its own version of a ` +
        `counted file, this clone's count for it was kept; every other count is prime's, and ` +
        `the total is re-summed.\n\n` +
        `- ${edgeBaselineNote}`
      : "") +
    (deployWorkflowNote
      ? `\n\n### The deploy workflow was carried, not copied\n\n` +
        `\`${DEPLOY_WORKFLOW_PATH}\` is a **protected** exclusion and was not written by the ` +
        `ordinary path. It carries no deploy target of its own any more — it resolves one from ` +
        `the \`SUPABASE_PROJECT_REF\` repository variable and, failing that, from THIS ` +
        `repository's own \`supabase/config.toml\` — so prime's copy can only ever deploy to ` +
        `this deployment's project. Every project ref outside the paired-origin declaration is ` +
        `refused rather than carried.\n\n` +
        `- ${deployWorkflowNote}`
      : "") +
    (holdReleases.some((r) => r.act === "release")
      ? `\n\n### Released from hold — the clone had done no work these holds protect\n\n` +
        `A \`manual_reconcile\` hold is honoured only where the clone's copy carries work that ` +
        `would be lost. Where the copy is byte-identical to a version prime itself held, or an ` +
        `operator recorded an overwrite approval in Mission Control, prime's current copy ` +
        `travels — through the same content holds as every other write. Protected paths are ` +
        `never released.\n\n` +
        describeHoldReleases(holdReleases)
      : "") +
    (specsBroughtAcrossNote
      ? `\n\n### Brought across beside the files they test\n\n` +
        `A spec and the file it asserts about travel together or neither does. None of these ` +
        `is in this clone's scope: each moved because a file it belongs with did, and only where ` +
        `nothing of this clone's is lost — the same evidence a held path is released on.\n\n` +
        specsBroughtAcrossNote
      : "") +
    (needsReconcile.length > 0
      ? `\n\n### Needs a human — ${needsReconcile.length} file(s) changed upstream and were held back\n\n` +
        `These carry deliberate divergence on this clone, so the cascade will never overwrite them. ` +
        `Prime has moved; someone has to decide what to carry across.\n\n` +
        needsReconcile.map((h) => `- \`${h.path}\`${h.note ? ` — ${h.note}` : ""}`).join("\n")
      : "") +
    (partition.held.length - needsReconcile.length > 0
      ? `\n\n_${partition.held.length - needsReconcile.length} further path(s) are owned by this clone and were withheld without comment._`
      : "") +
    (describeDeletionPlan(deletionPlan)
      ? `\n\n### What prime deleted\n\n${describeDeletionPlan(deletionPlan)}`
      : "") +
    (unprobedDeletions > 0
      ? `\n\n_${unprobedDeletions} further clone-only path(s) were not checked against prime's history this run._`
      : "") +
    (onlyInClone > 0
      ? `\n\n_${onlyInClone} path(s) exist only in this clone. A path is removed only where prime's ` +
        `own history shows it deleted AND this clone's copy is byte-identical to a version prime itself held._`
      : "");

  const { data: newCommit } = await octokit.git.createCommit({
    owner: cloneRef.owner,
    repo: cloneRef.repo,
    message,
    tree: newTree.sha,
    // Same read as the base tree above. See the comment there.
    parents: [parentSha],
  });

  // === One open cascade proposal per clone, in EVERY mode ===
  //
  // Opening a fresh pull request every time is what the first live run
  // actually did: prime merged eight pull requests in the minutes it took a
  // fix to deploy, eight cascades queued, and every one of them opened its own
  // pull request carrying THE SAME 57 files — #27 through #34 on the clone.
  //
  // That was fixed for `pr` mode and NOT for `auto_merge`, on the reasoning
  // that under auto-merge "the first will win and the rest will skip". It does
  // not, because auto-merge does not merge on the spot — it waits for checks
  // that take about seventeen minutes, and prime moves faster than that. On
  // 30 Aug 2026 three prime commits inside thirty-one minutes produced #67,
  // #68 and #69, all open together, all carrying overlapping trees cut from a
  // common ancestor. #67 merged; the other two were left proposing changes to
  // the same files, so at least one of them could only ever land as a conflict.
  //
  // So the rule is the one Dependabot has, and it belongs to both modes:
  //
  //   same tree  -> nothing new to say; report the pull request that already
  //                 says it, and open nothing.
  //   new tree   -> move that pull request's branch to the new commit. The
  //                 commit's parent is the clone's current default branch, so
  //                 the diff stays honest.
  //   none open  -> open one.
  //
  // Failing to LIST is not failing to find: if the lookup errors we fall
  // through to opening a new pull request, because a duplicate is a tidiness
  // problem and a cascade that silently did not propose anything is not.
  const intro =
    mode === "auto_merge"
      ? "Auto-merge: this lands on green and waits otherwise."
      : `Automated cascade from **${primeRef.owner}/${primeRef.repo}@${shortSha(sourceSha)}**.`;
  const title = `Aurixa cascade · ${sourceLabel}@${shortSha(sourceSha)} → ${treeEntries.length} file(s)`;

  const existing = await findOpenCascadePr(octokit, cloneRef);
  let proposal: { number: number; url: string; nodeId: string | null; headSha: string } | null =
    null;

  if (existing) {
    let existingTreeSha: string | null = null;
    try {
      const { data: headCommit } = await octokit.git.getCommit({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        commit_sha: existing.headSha,
      });
      existingTreeSha = headCommit.tree.sha;
    } catch {
      existingTreeSha = null;
    }

    if (existingTreeSha && existingTreeSha === newTree.sha) {
      // Nothing new to propose. The open pull request already carries this
      // exact tree, and the merge drain is what lands it once checks pass.
      return {
        status: "skipped",
        pr_url: existing.url,
        diff_summary: `Already proposed — PR #${existing.number} carries this exact tree (${treeEntries.length} file(s))`,
        files_changed: treeEntries.length,
        completed_at: new Date().toISOString(),
        // Tree-verified for THIS revision, but conditional on the standing
        // proposal: the pointer must not advance until it lands. `pr_url`
        // is what defers it — the engine's own stamp passes this row over,
        // and when the drain merges the pull request, reconciliation flips
        // every row naming it to `succeeded`, where `advanceClone` reads
        // the newest event's delivered head. That is how a proposal cut
        // for an older head and re-verified against a newer one stamps the
        // newer one.
        delivered_sha: deliveredSha,
        ...finalProgress,
      };
    }

    try {
      await octokit.git.updateRef({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        ref: `heads/${existing.branch}`,
        sha: newCommit.sha,
        // Its only writer is this engine, and the new commit sits on the
        // clone's current default branch rather than on the old proposal.
        force: true,
      });
      const { data: updated } = await octokit.pulls.update({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        pull_number: existing.number,
        title,
        body: cascadeBody(
          `${intro}\n\n` +
            `_This pull request was updated in place rather than replaced, so one proposal tracks prime._`,
        ),
      });
      proposal = {
        number: existing.number,
        url: existing.url,
        nodeId: updated.node_id ?? null,
        headSha: newCommit.sha,
      };
    } catch {
      // Branch deleted under an open pull request, or a race. Fall through and
      // open a fresh one.
      proposal = null;
    }
  }

  if (!proposal) {
    const branch = branchName(sourceSha);
    try {
      await octokit.git.createRef({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        ref: `refs/heads/${branch}`,
        sha: newCommit.sha,
      });
      const { data: pr } = await octokit.pulls.create({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        title,
        head: branch,
        base: cloneRef.branch,
        body: cascadeBody(intro),
      });
      proposal = {
        number: pr.number,
        url: pr.html_url,
        nodeId: pr.node_id ?? null,
        headSha: newCommit.sha,
      };
    } catch (prErr) {
      return {
        status: "failed",
        diff_summary: `Could not open a cascade pull request: ${fileSummary}`,
        files_changed: treeEntries.length,
        error_message: prErr instanceof Error ? prErr.message : "unknown",
        completed_at: new Date().toISOString(),
        ...finalProgress,
      };
    }
  }

  // The summary a result carries is written ONCE and read for as long as the
  // row exists, so it holds only what stays true: which pull request, and what
  // it carries. Why it has not merged yet is a fact about this minute, and
  // `cascadeMergeDrain` owns it — writing it here is what left rows reading
  // "No check has reported on this pull request" long after every check had.
  const durableSummary = `PR #${proposal.number} ${existing ? "updated" : "opened"}: ${fileSummary}`;

  // === auto_merge: always through a pull request, never past its checks ===
  //
  // This used to try `git.updateRef` first — a direct fast-forward push to the
  // clone's default branch, with no pull request and no checks — and only fell
  // back to a pull request when branch protection REFUSED the push. Every clone
  // in this fleet has an unprotected `main`, so that push always succeeded and
  // CI was never consulted at all.
  //
  // The comment that used to live here already said what that meant: protection
  // was doing the work this function thought it was doing itself, and where
  // protection is absent it merged a tree nothing had built. It named the day
  // it bit, 26 Aug 2026 — a cascade carrying a package.json/package-lock.json
  // pair that fails `npm ci`, six of eight checks red, a clone's `main` unable
  // to install or deploy. Then it went on to call `pulls.merge` immediately
  // whenever GitHub auto-merge could not be armed, which is the same hole one
  // level down.
  //
  // Both are gone. `decideCascadeMerge` reads the pull request's own check runs
  // and an unattended cascade merges only on green.
  if (mode === "auto_merge") {
    // Preferred: let GitHub hold it and merge the moment checks pass. That is
    // race-free in a way polling cannot be — it cannot merge a head that a
    // later push has replaced.
    //
    // `MERGE`, never `SQUASH`. A squash rewrites the cascade commit that names
    // the prime SHA it came from, which is the one durable record of what a
    // clone has received.
    if (proposal.nodeId) {
      try {
        await octokit.graphql(
          `mutation($id: ID!) {
             enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE }) {
               pullRequest { autoMergeRequest { enabledAt } }
             }
           }`,
          { id: proposal.nodeId },
        );
        return {
          status: "pr_opened",
          pr_url: proposal.url,
          commit_sha: newCommit.sha.slice(0, 7),
          delivered_sha: deliveredSha,
          diff_summary: durableSummary,
          files_changed: treeEntries.length,
          completed_at: new Date().toISOString(),
          ...finalProgress,
        };
      } catch {
        // Auto-merge is a repository setting and GitHub refuses to arm it on a
        // pull request with nothing to wait for. Falling through does NOT mean
        // merging blind — it means reading the checks ourselves.
      }
    }

    let checkData: {
      check_runs?: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        started_at?: string | null;
        completed_at?: string | null;
      }>;
    };
    try {
      ({ data: checkData } = await octokit.checks.listForRef({
        owner: cloneRef.owner,
        repo: cloneRef.repo,
        ref: proposal.headSha,
      }));
    } catch (e) {
      // A missing `checks: read` permission is not a broken cascade. The pull
      // request is open and correct; what is missing is the signal that would
      // let it merge unattended, and the drain will say so on its next pass.
      if (checksUnreadable(e)) {
        return {
          status: "pr_opened",
          pr_url: proposal.url,
          commit_sha: newCommit.sha.slice(0, 7),
          delivered_sha: deliveredSha,
          diff_summary: durableSummary,
          files_changed: treeEntries.length,
          completed_at: new Date().toISOString(),
          ...finalProgress,
        };
      }
      throw e;
    }
    const verdict = decideCascadeMerge(
      (checkData.check_runs ?? []).map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        started_at: c.started_at,
        completed_at: c.completed_at,
      })),
    );

    if (verdict.merge) {
      try {
        const { data: merged } = await octokit.pulls.merge({
          owner: cloneRef.owner,
          repo: cloneRef.repo,
          pull_number: proposal.number,
          merge_method: "merge",
          commit_title: `Aurixa cascade ${sourceLabel}@${shortSha(sourceSha)} (#${proposal.number})`,
        });
        return {
          status: "succeeded",
          commit_sha: merged.sha?.slice(0, 7) ?? null,
          delivered_sha: deliveredSha,
          pr_url: proposal.url,
          diff_summary: `Merged as ${merged.sha?.slice(0, 7) ?? "?"}. ${durableSummary}`,
          files_changed: treeEntries.length,
          completed_at: new Date().toISOString(),
          ...finalProgress,
        };
      } catch (mergeErr) {
        // Green and unmergeable is a real state — a conflict, or a head that
        // moved under us. The proposal stands and the drain will try again.
        console.error("[cascade] merge on green failed:", mergeErr);
      }
    }
    // Left open on purpose. A cascade that cannot land is a fact an operator
    // needs; one that lands anyway is the defect this block exists to remove.
  }

  return {
    status: "pr_opened",
    pr_url: proposal.url,
    commit_sha: newCommit.sha.slice(0, 7),
    delivered_sha: deliveredSha,
    diff_summary: durableSummary,
    files_changed: treeEntries.length,
    completed_at: new Date().toISOString(),
    ...finalProgress,
  };
}

/**
 * The clone's open cascade proposal, if it has one.
 *
 * Identified by the branch name this engine gives its own branches
 * (`aurixa/cascade-…`) rather than by author, because the pull request is
 * opened by whichever GitHub App installation is configured and that is not a
 * stable identity to match on.
 *
 * The OLDEST is chosen when several are open. That is the one a reviewer is
 * most likely already looking at, and after the duplicate storm there were
 * eight; picking the newest would have kept abandoning the one with the
 * comments on it.
 */
async function findOpenCascadePr(
  octokit: ReturnType<typeof getAppOctokit>,
  cloneRef: RepoRef,
): Promise<{ number: number; url: string; branch: string; headSha: string } | null> {
  try {
    const { data: open } = await octokit.pulls.list({
      owner: cloneRef.owner,
      repo: cloneRef.repo,
      base: cloneRef.branch,
      state: "open",
      sort: "created",
      direction: "asc",
      per_page: 100,
    });
    const mine = open.find((p) => (p.head?.ref ?? "").startsWith("aurixa/cascade-"));
    if (!mine) return null;
    return {
      number: mine.number,
      url: mine.html_url,
      branch: mine.head.ref,
      headSha: mine.head.sha,
    };
  } catch {
    return null;
  }
}
