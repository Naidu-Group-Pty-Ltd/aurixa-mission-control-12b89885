/**
 * THE LATERAL LANE, doing its reading and writing.
 *
 * `lateralMembranes.pure.ts` declares the boundary between the two parents and
 * `cascade/lateralExchange.pure.ts` takes every decision across it. This
 * module is the I/O around those decisions and nothing else: it reads the two
 * parents, the prime and the destination's rulebook, hands them to the pure
 * rules, and proposes what they allowed. No rule is written here — a rule that
 * lived in this file could not be asserted without a token. The whole account,
 * with the day-one measurement, is `docs/LATERAL_MEMBRANE.md`.
 *
 * ## When it runs
 *
 * On an idle tick of the cascade drain that falls in a lateral slot (every
 * `LATERAL_CADENCE_MINUTES`), and when an operator asks. A busy tick is
 * skipped, not queued: the vertical cascade has the tick, and parent-level
 * work is never more urgent than the prime's. The slot asks the installation's
 * budget at the SCAN floor — it is periodic, and the next slot covers the same
 * ground — while an operator's request asks at the ACTOR floor, because a
 * person is waiting on it.
 *
 * ## What a slot costs
 *
 * An idle slot reads one ledger row, one pull request per open proposal, and
 * three branch heads, then stops: `decideLateralRun` spends a pass only where
 * a head moved, a proposal was merged or declined, work was deferred, or a day
 * has passed. A pass reads three trees; asks the prime's history about each
 * candidate once (remembered for good where it held one, for a week where it
 * did not); walks both parents' histories for a pair of blobs once a day; and
 * reads the text of only what it is about to judge. Every walk and every read
 * is asked of the head the pass fingerprinted, never of a branch name, so the
 * trees and the histories describe one commit on each side.
 *
 * ## What it never does
 *
 * It never writes to either parent's default branch. Every change is a pull
 * request on `aurixa/lateral-from-<origin>`, landed — in `auto_merge` — by
 * the same gate the vertical cascade uses, on `verify` and `security`. It
 * never rebuilds a proposal a person has pushed to. It never merges while the
 * boundary is paused. And a read that FAILED is never taken for a fact that is
 * ABSENT: an unreadable history, a truncated tree, a rulebook that could not
 * be read — each defers or refuses, and the next slot asks again.
 *
 * ## The ledger
 *
 * One `audit_log` row per pass (`cascade.lateral_exchange`, entity
 * `lateral_boundary`), carrying both what the next slot reads back — the
 * fingerprint, the pause, the open proposals, the memo — and the report a
 * person reads. A slot that decides not to run writes nothing, so the audit
 * log holds one row per thing that happened rather than one per ten minutes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  FLEET_LATERALS,
  otherSide,
  type LateralBoundary,
} from "@/lib/cascade/membrane/lateralMembranes.pure";
import type { Membrane } from "@/lib/cascade/membrane/membrane.pure";
import { validateModuleGlobs } from "@/lib/module-globs";
import { mapWithConcurrencyUntil } from "@/lib/concurrency";
import {
  getAppOctokit,
  getFileContent,
  listTreeAt,
  OversizeFileError,
  type RepoFile,
  type RepoRef,
  type TreeListing,
} from "./github-app.server";
import { MAX_VERSION_WALK } from "./cascade/deletionPropagation.pure";
import { readInstalledGlobs } from "./cascade/installedGlobs.server";
import { ownProjectRef } from "./prime-backend.server";
import { readGitHubRemaining } from "./githubAllowance.server";
import { beginGithubLane, flushGithubUsage } from "./githubUsageMeter";
import { decideSpend } from "./cascade/githubBudget.pure";
import { classifyGitHubFailure } from "./cascade/rateLimitDeferral.pure";
import {
  assertMirrorPolicy,
  CASCADE_MAX_FILE_BYTES,
  requireExclusions,
  type SyncExclusion,
} from "./cascade/syncExclusions.pure";
import {
  chunkTreeEntries,
  toGitTreeParam,
  type DeliveryMode,
  type DeliveryTreeEntry,
} from "./cascade/treeDelivery.pure";
import {
  CHECKS_PERMISSION_REMEDY,
  checksUnreadable,
  decideCascadeMerge,
  reclassifyAgainstBase,
  type CheckRun,
} from "./cascade/autoMergeGate.pure";
import {
  DECLINED_DELETION,
  EMPTY_LATERAL_LEDGER,
  LATERAL_LEDGER_ACTION,
  LATERAL_LEDGER_ENTITY,
  SUPERSEDED_MARKER,
  SURVIVOR_READ_CEILING,
  composeLateralLedgerRow,
  decideLateral,
  decideLateralRun,
  decisionKey,
  describeLateralProposal,
  differingImportTargets,
  effectiveLateralMode,
  historyProbesFor,
  isLaneOnlyProposal,
  isWalkablePath,
  judgeLateralWrites,
  lateralBranchName,
  lateralCandidates,
  lateralDestinations,
  lateralFingerprint,
  lateralOrigin,
  lateralSurvivorCandidates,
  nextLateralMemo,
  planLateralDeletions,
  proposalCarries,
  readLateralLedger,
  readLateralReport,
  readProposalState,
  recalledDecision,
  survivorsNeeded,
  withoutDeclined,
  type LateralBoundaryReport,
  type LateralDestination,
  type LateralDirectionOutcome,
  type LateralDirectionReport,
  type LateralLedgerState,
  type LateralMemo,
  type LateralMode,
  type LateralProposalRecord,
  type LateralReconcile,
  type LateralSide,
  type OriginVerdict,
  type ProposalItem,
  type SettledLateralDecision,
  type SideHistory,
} from "./cascade/lateralExchange.pure";

export type {
  LateralBoundaryReport,
  LateralDirectionReport,
  LateralReconcile,
} from "./cascade/lateralExchange.pure";

type Db = SupabaseClient<Database>;
type Octo = ReturnType<typeof getAppOctokit>;
type Json = Database["public"]["Tables"]["audit_log"]["Insert"]["metadata"];

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

/** History walks in flight at once — the deletion probe's width, for the same secondary limit. */
const PROBE_WIDTH = 4;
/** Content reads in flight at once. */
const READ_WIDTH = 6;
/** Candidates whose origin one pass may ask the prime's history about. The rest wait a slot. */
const ORIGIN_PROBE_CAP = 80;
/** Paths whose direction one pass may walk both parents' histories for. */
const DIRECTION_PROBE_CAP = 40;
/** A pass is not started with less than this left of its invocation. */
const PASS_FLOOR_MS = 20_000;
/** Kept back, while reading, for delivering a direction and writing the ledger. */
const DELIVERY_RESERVE_MS = 12_000;
/** How long an operator's request may run. Inside a server function's ceiling. */
export const LATERAL_OPERATOR_BUDGET_MS = 45_000;

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

export type LateralTrigger = "slot" | "operator";

export type LateralExchangeReport = {
  /** Whether any boundary ran a pass. */
  ran: boolean;
  why: string;
  boundaries: LateralBoundaryReport[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Small readers
// ─────────────────────────────────────────────────────────────────────────────

function reasonOf(e: unknown): string {
  if (e && typeof e === "object" && "status" in e) {
    const status = (e as { status?: unknown }).status;
    const message = e instanceof Error ? e.message : "";
    if (typeof status === "number")
      return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`;
  }
  return e instanceof Error ? e.message : String(e ?? "unknown error");
}

/** A GitHub rate limit is the window's answer, never a path's — it is re-thrown to defer the pass. */
function rethrowIfLimited(e: unknown): void {
  if (classifyGitHubFailure(e).kind === "rate_limited") throw e;
}

const short = (sha: string) => sha.slice(0, 7);

type CloneRow = {
  id: string;
  name: string;
  github_owner: string;
  github_repo: string;
  default_branch: string | null;
  sync_scope: string | null;
};

type PrimeRow = {
  github_owner: string;
  github_repo: string;
  default_branch: string;
  default_cascade_mode: LateralMode;
  supabase_project_ref: string | null;
};

type Head = { sha: string; treeSha: string };

/** One parent, read at the head the pass fingerprinted. */
type SideState = {
  clone: CloneRow;
  repo: string;
  owner: string;
  branch: string;
  head: Head;
  tree: TreeListing;
};

/** The side's repository pinned to the head that was read, for every later read. */
const pinned = (side: SideState): RepoRef => ({
  owner: side.owner,
  repo: side.repo,
  branch: side.head.sha,
});

async function readHead(octokit: Octo, ref: RepoRef): Promise<Head> {
  const { data } = await octokit.repos.getBranch({
    owner: ref.owner,
    repo: ref.repo,
    branch: ref.branch,
  });
  return { sha: data.commit.sha, treeSha: data.commit.commit.tree.sha };
}

type LastRow = { state: LateralLedgerState; at: string; raw: Record<string, unknown> };

/** The boundary's last ledger row. A failed read is not an empty ledger. */
async function readLastRow(
  supabase: Db,
  boundary: LateralBoundary,
): Promise<{ ok: true; last: LastRow | null } | { ok: false; why: string }> {
  const { data, error } = await supabase
    .from("audit_log")
    .select("metadata, created_at")
    .eq("action", LATERAL_LEDGER_ACTION)
    .eq("entity_type", LATERAL_LEDGER_ENTITY)
    .eq("entity_id", boundary.ledgerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, why: error.message };
  if (!data) return { ok: true, last: null };
  const raw =
    data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
      ? (data.metadata as Record<string, unknown>)
      : {};
  return { ok: true, last: { state: readLateralLedger(raw), at: data.created_at, raw } };
}

async function writeRow(
  supabase: Db,
  boundary: LateralBoundary,
  row: Record<string, unknown>,
  actorUserId: string | null,
): Promise<boolean> {
  const { error } = await supabase.from("audit_log").insert({
    action: LATERAL_LEDGER_ACTION,
    entity_type: LATERAL_LEDGER_ENTITY,
    entity_id: boundary.ledgerId,
    actor_user_id: actorUserId,
    metadata: row as unknown as Json,
  });
  if (error) {
    console.error(`[lateral] the ledger row for ${boundary.id} was not written: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Whether the boundary is paused NOW, asked again right before anything lands.
 *
 * A pass reads the pause once, at its start, and then runs for up to a
 * minute. An operator who pauses inside that minute has written a newer row —
 * and a pass that merged, armed, or wrote its own row on the strength of the
 * old read would undo the pause without anyone seeing it happen. So each act
 * that can land a change, and the row the pass writes, asks this first. A
 * ledger that cannot be read here answers "paused": nothing lands on a
 * question nobody could answer.
 */
async function pausedNow(supabase: Db, boundary: LateralBoundary): Promise<boolean> {
  const read = await readLastRow(supabase, boundary);
  return read.ok ? (read.last?.state.paused ?? false) : true;
}

/** Both parents' registry rows and the prime's configuration. */
async function readSetup(
  supabase: Db,
  boundary: LateralBoundary,
): Promise<
  { ok: true; clones: Map<string, CloneRow>; prime: PrimeRow } | { ok: false; why: string }
> {
  const [clonesRes, primeRes] = await Promise.all([
    supabase
      .from("clones")
      .select("id, name, github_owner, github_repo, default_branch, sync_scope")
      .in("github_repo", [...boundary.sides]),
    supabase
      .from("prime_config")
      .select(
        "github_owner, github_repo, default_branch, default_cascade_mode, supabase_project_ref",
      )
      .limit(1)
      .maybeSingle(),
  ]);
  if (clonesRes.error)
    return { ok: false, why: `The clone registry could not be read: ${clonesRes.error.message}.` };
  if (primeRes.error)
    return {
      ok: false,
      why: `The prime's configuration could not be read: ${primeRes.error.message}.`,
    };
  if (!primeRes.data)
    return { ok: false, why: "No prime is configured, so no origin can be judged." };

  const clones = new Map<string, CloneRow>();
  for (const side of boundary.sides) {
    const rows = ((clonesRes.data ?? []) as CloneRow[]).filter((c) => c.github_repo === side);
    if (rows.length !== 1) {
      return {
        ok: false,
        why:
          rows.length === 0
            ? `\`${side}\` is not in the clone registry, so this boundary has no second side.`
            : `\`${side}\` is registered ${rows.length} times, and the lane will not guess which is the parent.`,
      };
    }
    clones.set(side, rows[0]);
  }
  return { ok: true, clones, prime: primeRes.data as PrimeRow };
}

/**
 * Every Supabase project ref this fleet owns — the prime's, every clone's and
 * Mission Control's own — for the membrane's `backend_ref` species to find
 * written bare. A read that failed refuses the pass: without the list, a
 * script handing another tenant's project to the Management API crosses as
 * an ordinary file.
 */
async function readKnownRefs(
  supabase: Db,
  primeRef: string | null,
): Promise<{ ok: true; refs: string[] } | { ok: false; why: string }> {
  const { data, error } = await supabase
    .from("clone_backends_safe")
    .select("supabase_project_ref")
    .not("supabase_project_ref", "is", null);
  if (error) {
    return {
      ok: false,
      why:
        `The fleet's project refs could not be read (${error.message}). They are what lets the ` +
        `membrane see a script naming another tenant's database, so nothing crossed without them.`,
    };
  }
  const refs = new Set<string>();
  for (const row of (data ?? []) as Array<{ supabase_project_ref: string | null }>) {
    if (row.supabase_project_ref) refs.add(row.supabase_project_ref.toLowerCase());
  }
  if (primeRef) refs.add(primeRef.toLowerCase());
  const own = ownProjectRef();
  if (own) refs.add(own);
  return { ok: true, refs: [...refs].sort() };
}

type DestinationRule =
  | { ok: true; writes: LateralDestination; deletes: LateralDestination }
  /** `transient` is a read that failed; otherwise the configuration itself refuses. */
  | { ok: false; why: string; transient: boolean };

/** The destination's own rulebook: its exclusions, and the modules it installed. */
async function readDestinationRule(supabase: Db, side: SideState): Promise<DestinationRule> {
  const scope: "mirror" | "modules" = side.clone.sync_scope === "mirror" ? "mirror" : "modules";
  const res = await supabase
    .from("clone_sync_exclusions")
    .select("pattern, reason, note")
    .eq("clone_id", side.clone.id);
  let exclusions: SyncExclusion[];
  try {
    exclusions = requireExclusions(side.clone.id, res.data as SyncExclusion[] | null, res.error);
  } catch (e) {
    return {
      ok: false,
      why: `its sync exclusions could not be read (${reasonOf(e)})`,
      transient: true,
    };
  }
  try {
    if (scope === "mirror") assertMirrorPolicy(side.clone.id, exclusions);
  } catch (e) {
    return { ok: false, why: reasonOf(e), transient: false };
  }

  let installed: string[] = [];
  if (scope === "modules") {
    const read = await readInstalledGlobs(supabase, side.clone.id);
    if (read.failed) {
      // Vertically a partial list delivers less. Here every path it omits is
      // REPORTED as outside the destination's modules, which is a statement
      // about the deployment made from a read that failed.
      return {
        ok: false,
        why: `its installed modules could not be read (${read.failed})`,
        transient: true,
      };
    }
    installed = validateModuleGlobs(read.globs).valid;
    if (installed.length === 0) {
      return {
        ok: false,
        why: "it has no installed modules, so nothing is offered to it — the vertical cascade's own answer",
        transient: false,
      };
    }
  }
  const { writes, deletes } = lateralDestinations({
    repo: side.repo,
    tree: side.tree.entries,
    scope,
    installedGlobs: installed,
    exclusions,
  });
  return { ok: true, writes, deletes };
}

/** Has the prime's history ever held this path? One page of one commit answers it. */
async function primeHeldPath(
  octokit: Octo,
  prime: RepoRef,
  path: string,
): Promise<OriginVerdict | { unsettled: string }> {
  try {
    const { data } = await octokit.repos.listCommits({
      owner: prime.owner,
      repo: prime.repo,
      sha: prime.branch,
      path,
      per_page: 1,
    });
    return Array.isArray(data) && data.length > 0 ? "held" : "never";
  } catch (e) {
    rethrowIfLimited(e);
    return { unsettled: reasonOf(e) };
  }
}

/**
 * One parent's history of one path, for the direction table.
 *
 * This is the vertical probe's walk (`probePrimeVersions`), asked of a parent,
 * with one difference that is the whole reason it is not that function. There
 * a revision that could not be read is skipped: fewer known versions means
 * fewer matches, and every rule reading them then KEEPS more — a skipped
 * version can only make the vertical lane hold a file. Here a missing version
 * can make this lane MOVE one. `went_back` needs each side's walk to find the
 * other's current copy, and a version skipped on a 502 turns "each has held
 * the other's" into "only one has", which reads as a clean direction and
 * writes over the side that went back — somebody's deliberate revert.
 *
 * So a 404 is skipped (it is the ordinary answer at the commit that removed
 * the path) and any other failed read leaves the history `unsettled`, which
 * defers the path to the next pass. A rate limit is re-thrown, as everywhere.
 */
async function sideHistory(
  octokit: Octo,
  ref: RepoRef,
  path: string,
  stopAt: string,
): Promise<SideHistory> {
  let commits: Array<{ sha: string }>;
  try {
    const { data } = await octokit.repos.listCommits({
      owner: ref.owner,
      repo: ref.repo,
      sha: ref.branch,
      path,
      // One more than the walk, so a full page says the history did not end.
      per_page: MAX_VERSION_WALK + 1,
    });
    if (!Array.isArray(data) || data.length === 0) return { kind: "never_primes" };
    commits = data as Array<{ sha: string }>;
  } catch (e) {
    rethrowIfLimited(e);
    return { kind: "unsettled", why: reasonOf(e) };
  }

  const versionsExhaustive = commits.length <= MAX_VERSION_WALK;
  const versions: string[] = [];
  for (const commit of commits.slice(0, MAX_VERSION_WALK)) {
    let sha: string | null = null;
    try {
      const { data } = await octokit.repos.getContent({
        owner: ref.owner,
        repo: ref.repo,
        path,
        ref: commit.sha,
      });
      // A directory answers with an array: not a version of this file.
      if (!Array.isArray(data) && "sha" in data && typeof data.sha === "string") sha = data.sha;
    } catch (e) {
      rethrowIfLimited(e);
      if ((e as { status?: unknown })?.status === 404) continue;
      return {
        kind: "unsettled",
        why: `the revision at ${short(commit.sha)} could not be read (${reasonOf(e)}), and a skipped version could turn a revert into a direction`,
      };
    }
    if (!sha) continue;
    if (!versions.includes(sha)) versions.push(sha);
    // Everything older is irrelevant once the other side's copy is found.
    if (sha === stopAt) return { kind: "prime_versions", versions, versionsExhaustive };
  }
  return { kind: "prime_versions", versions, versionsExhaustive };
}

type FileReads = {
  files: Map<string, RepoFile>;
  /** Paths that could not be read, with why. Absent is not the same as unread. */
  failed: Map<string, string>;
  /** Of `failed`, the ones past the size ceiling — a property of the file, not of this read. */
  oversize: Set<string>;
  /** Paths the budget stopped before. */
  unreached: string[];
};

/** Read files at a pinned head, bounded by the invocation's budget. */
async function readFiles(
  octokit: Octo,
  ref: RepoRef,
  paths: readonly string[],
  stop: () => boolean,
): Promise<FileReads> {
  const out: FileReads = {
    files: new Map(),
    failed: new Map(),
    oversize: new Set(),
    unreached: [],
  };
  const list = [...paths];
  const run = await mapWithConcurrencyUntil(
    list,
    READ_WIDTH,
    async (path) => {
      try {
        const file = await getFileContent(octokit, ref, path, { maxBytes: CASCADE_MAX_FILE_BYTES });
        if (file) out.files.set(path, file);
        else out.failed.set(path, `not a file at ${short(ref.branch)}`);
      } catch (e) {
        if (e instanceof OversizeFileError) {
          out.failed.set(path, `over the ${CASCADE_MAX_FILE_BYTES}-byte ceiling`);
          out.oversize.add(path);
          return;
        }
        rethrowIfLimited(e);
        out.failed.set(path, reasonOf(e));
      }
    },
    stop,
  );
  out.unreached = list.slice(run.processed);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pull requests
// ─────────────────────────────────────────────────────────────────────────────

type OpenProposal = { number: number; url: string; nodeId: string | null; headSha: string };

/** The open proposal from one origin into one destination, if there is one. The oldest wins. */
async function findOpenProposal(
  octokit: Octo,
  to: SideState,
  branch: string,
): Promise<OpenProposal | null> {
  const { data } = await octokit.pulls.list({
    owner: to.owner,
    repo: to.repo,
    state: "open",
    head: `${to.owner}:${branch}`,
    base: to.branch,
    sort: "created",
    direction: "asc",
    per_page: 10,
  });
  const pr = data[0];
  if (!pr) return null;
  return { number: pr.number, url: pr.html_url, nodeId: pr.node_id ?? null, headSha: pr.head.sha };
}

async function laneOwns(octokit: Octo, to: SideState, pr: number): Promise<boolean> {
  const { data } = await octokit.pulls.listCommits({
    owner: to.owner,
    repo: to.repo,
    pull_number: pr,
    per_page: 2,
  });
  return isLaneOnlyProposal(data.map((c) => ({ message: c.commit.message })));
}

async function carries(
  octokit: Octo,
  to: SideState,
  pr: number,
  items: readonly ProposalItem[],
): Promise<boolean> {
  const PAGE = 100;
  const { data } = await octokit.pulls.listFiles({
    owner: to.owner,
    repo: to.repo,
    pull_number: pr,
    per_page: PAGE,
  });
  return proposalCarries({
    items,
    files: data.map((f) => ({ filename: f.filename, status: f.status, sha: f.sha ?? null })),
    // A full page may have been cut short; that is not evidence of equality.
    listingComplete: data.length < PAGE,
  });
}

/** Point the lane's branch at a commit: create it, or move it if a closed proposal left it behind. */
async function pointBranch(
  octokit: Octo,
  to: SideState,
  branch: string,
  sha: string,
): Promise<void> {
  try {
    await octokit.git.createRef({
      owner: to.owner,
      repo: to.repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  } catch (e) {
    const status = (e as { status?: unknown })?.status;
    if (status === 422 && /already exists/i.test(reasonOf(e))) {
      // Only an OPEN proposal can carry a person's commits, and an open one
      // never reaches here — this is a branch whose proposal was closed.
      await octokit.git.updateRef({
        owner: to.owner,
        repo: to.repo,
        ref: `heads/${branch}`,
        sha,
        force: true,
      });
      return;
    }
    throw e;
  }
}

async function readChecks(
  octokit: Octo,
  owner: string,
  repo: string,
  ref: string,
): Promise<CheckRun[]> {
  const { data } = await octokit.checks.listForRef({ owner, repo, ref });
  return (data.check_runs ?? []).map((c) => ({
    name: c.name,
    status: c.status,
    conclusion: c.conclusion,
    started_at: c.started_at,
    completed_at: c.completed_at,
  }));
}

/**
 * Land a proposal on green, through the vertical cascade's own gate.
 *
 * `decideCascadeMerge` over the head's checks, `reclassifyAgainstBase` where
 * they failed, and `pulls.merge` with the head SHA that was judged — so a push
 * landing between the read and the merge is refused by GitHub rather than
 * merged unseen. MERGE, never SQUASH: the lateral commit names the origin
 * commit it came from, the one durable record of what crossed.
 */
async function mergeIfGreen(
  octokit: Octo,
  to: { owner: string; repo: string },
  pr: { number: number; headSha: string; baseRef: string },
  title: string,
): Promise<{ merged: boolean; why: string }> {
  let head: CheckRun[];
  try {
    head = await readChecks(octokit, to.owner, to.repo, pr.headSha);
  } catch (e) {
    rethrowIfLimited(e);
    if (checksUnreadable(e)) return { merged: false, why: CHECKS_PERMISSION_REMEDY };
    return { merged: false, why: `Its checks could not be read (${reasonOf(e)}).` };
  }
  let verdict = decideCascadeMerge(head);
  if (!verdict.merge && verdict.reason === "failing") {
    let base: CheckRun[] | null = null;
    try {
      const { data: branch } = await octokit.repos.getBranch({
        owner: to.owner,
        repo: to.repo,
        branch: pr.baseRef,
      });
      base = await readChecks(octokit, to.owner, to.repo, branch.commit.sha);
    } catch (e) {
      rethrowIfLimited(e);
      base = null;
    }
    verdict = reclassifyAgainstBase(verdict, head, base, pr.baseRef);
  }
  if (!verdict.merge) return { merged: false, why: verdict.why };
  try {
    await octokit.pulls.merge({
      owner: to.owner,
      repo: to.repo,
      pull_number: pr.number,
      merge_method: "merge",
      commit_title: title,
      sha: pr.headSha,
    });
    return { merged: true, why: `Merged on green — ${verdict.why}` };
  } catch (e) {
    rethrowIfLimited(e);
    return { merged: false, why: `Green, and GitHub refused the merge: ${reasonOf(e)}` };
  }
}

/**
 * Let GitHub hold the proposal and merge the moment its checks pass; where it
 * will not, ask the gate directly.
 *
 * Arming is race-free in a way reading is not — it cannot merge a head a
 * later push replaced — which is why it comes first, exactly as it does on the
 * vertical engine's proposals.
 */
async function landOrArm(
  octokit: Octo,
  to: SideState,
  pr: { number: number; nodeId: string | null; headSha: string },
  title: string,
): Promise<string> {
  if (pr.nodeId) {
    try {
      await octokit.graphql(
        `mutation($id: ID!) {
           enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE }) {
             pullRequest { autoMergeRequest { enabledAt } }
           }
         }`,
        { id: pr.nodeId },
      );
      return "Auto-merge armed: GitHub merges it once `verify` and `security` pass.";
    } catch (e) {
      rethrowIfLimited(e);
      // Refused where there is nothing to wait for, or where the repository
      // does not allow it. Falling through never means merging blind.
    }
  }
  const landed = await mergeIfGreen(
    octokit,
    to,
    { number: pr.number, headSha: pr.headSha, baseRef: to.branch },
    title,
  );
  return landed.why;
}

async function disarmAutoMerge(octokit: Octo, nodeId: string): Promise<void> {
  await octokit.graphql(
    `mutation($id: ID!) {
       disablePullRequestAutoMerge(input: { pullRequestId: $id }) {
         pullRequest { id }
       }
     }`,
    { id: nodeId },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconcile: what became of the proposals the last pass left open
// ─────────────────────────────────────────────────────────────────────────────

type Reconciled = {
  results: LateralReconcile[];
  /** Records still worth tracking: open, or unreadable this slot. */
  stillOpen: LateralProposalRecord[];
  declines: Array<{ to: string; items: readonly ProposalItem[]; url: string }>;
  /** Proposals merged or declined since the last pass — a reason to run one. */
  settled: number;
};

async function reconcileProposals(
  octokit: Octo,
  records: readonly LateralProposalRecord[],
  clones: ReadonlyMap<string, CloneRow>,
  mode: LateralMode,
  paused: boolean,
  dryRun: boolean,
  stillUnpaused: () => Promise<boolean>,
): Promise<Reconciled> {
  const out: Reconciled = { results: [], stillOpen: [], declines: [], settled: 0 };
  for (const record of records) {
    const clone = clones.get(record.to);
    const base = { from: record.from, to: record.to, pr: record.pr, url: record.url };
    if (!clone) {
      out.results.push({
        ...base,
        state: "unreadable",
        why: `\`${record.to}\` is no longer registered.`,
      });
      continue;
    }
    let pr: {
      state: string;
      merged_at: string | null;
      body: string | null;
      head: { sha: string };
      base: { ref: string };
    };
    try {
      ({ data: pr } = await octokit.pulls.get({
        owner: clone.github_owner,
        repo: clone.github_repo,
        pull_number: record.pr,
      }));
    } catch (e) {
      rethrowIfLimited(e);
      out.results.push({ ...base, state: "unreadable", why: reasonOf(e) });
      out.stillOpen.push(record);
      continue;
    }

    const state = readProposalState(pr);
    if (state === "merged") {
      out.results.push({ ...base, state, why: null });
      out.settled++;
      continue;
    }
    if (state === "declined") {
      out.results.push({
        ...base,
        state,
        why: "Closed without merging — these copies are not offered again until the origin changes them.",
      });
      out.declines.push({ to: record.to, items: record.items, url: record.url });
      out.settled++;
      continue;
    }
    if (state === "superseded") {
      out.results.push({
        ...base,
        state,
        why: "Closed by the lane: it no longer had anything to offer.",
      });
      out.settled++;
      continue;
    }

    // Open. In auto_merge the gate is asked every slot, because GitHub's own
    // auto-merge may have been refused or disarmed by a pause since.
    if (mode === "auto_merge" && !paused && !dryRun && (await stillUnpaused())) {
      const landed = await mergeIfGreen(
        octokit,
        { owner: clone.github_owner, repo: clone.github_repo },
        { number: record.pr, headSha: pr.head.sha, baseRef: pr.base.ref },
        `Aurixa lateral ${record.from} → ${record.to} (#${record.pr})`,
      );
      if (landed.merged) {
        out.results.push({ ...base, state: "merged", why: landed.why });
        out.settled++;
        continue;
      }
      out.results.push({ ...base, state: "open", why: landed.why });
    } else {
      out.results.push({
        ...base,
        state: "open",
        why: paused ? "Paused: left for a person, never merged by the lane." : null,
      });
    }
    out.stillOpen.push(record);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// One direction
// ─────────────────────────────────────────────────────────────────────────────

type RecordAct =
  | { kind: "keep" }
  | { kind: "set"; record: LateralProposalRecord }
  | { kind: "clear" };

/**
 * `retry` counts what the NEXT pass could settle differently — a read that
 * failed, a budget that ran out, a head that moved. It is what keeps the
 * boundary running every slot, so only a question with a different answer
 * next time may count: a capacity bound or a configuration answers the same
 * until something changes, and a head moving already re-runs the pass.
 */
type DirectionResult = { report: LateralDirectionReport; record: RecordAct; retry: number };

type PassContext = {
  supabase: Db;
  octokit: Octo;
  trigger: LateralTrigger;
  force: boolean;
  dryRun: boolean;
  actorUserId: string | null;
  nowMs: number;
  /** True once less than `reserveMs` of the invocation is left. */
  past: (reserveMs: number) => boolean;
};

const PAUSED_MID_PASS =
  "Paused while this pass ran: proposed, and left for a person — the lane neither armed nor merged it.";

function emptyDirection(from: string, to: string): LateralDirectionReport {
  return {
    from,
    to,
    outcome: "nothing",
    why: "",
    writes: [],
    deletes: [],
    held: [],
    keptDeletions: [],
    deletionRefusal: null,
    outOfScope: [],
    declined: [],
    unread: [],
    pr: null,
    merge: null,
  };
}

/**
 * Close a proposal that no longer offers anything, where a COMPLETE pass
 * says so.
 *
 * Left open, it is worse than stale. In `auto_merge` it is still armed, and a
 * copy the origin has since taken back would land on the destination anyway —
 * after which each side has held the other's copy and the path is held for a
 * person as `went_back`. A pass that deferred anything cannot conclude the
 * offer is empty, so only a complete one closes, and never over a person's
 * commits.
 */
async function closeStale(
  ctx: PassContext,
  to: SideState,
  branch: string,
): Promise<{ closed: { number: number; url: string } | null; why: string }> {
  const open = await findOpenProposal(ctx.octokit, to, branch);
  if (!open) return { closed: null, why: "" };
  if (!(await laneOwns(ctx.octokit, to, open.number))) {
    return {
      closed: null,
      why:
        `PR #${open.number} no longer matches anything to offer, but a person has pushed to it, ` +
        `so the lane leaves it for them to merge or close.`,
    };
  }
  const { data: pr } = await ctx.octokit.pulls.get({
    owner: to.owner,
    repo: to.repo,
    pull_number: open.number,
  });
  await ctx.octokit.pulls.update({
    owner: to.owner,
    repo: to.repo,
    pull_number: open.number,
    state: "closed",
    body:
      `${pr.body ?? ""}\n\n---\n\n_Closed by the lateral lane: a later pass found nothing left to ` +
      `offer this way — the copies converged, or the origin took the change back._\n\n${SUPERSEDED_MARKER}`,
  });
  return {
    closed: { number: open.number, url: open.url },
    why: `Closed PR #${open.number}: nothing is left to offer this way.`,
  };
}

async function passDirection(p: {
  ctx: PassContext;
  boundary: LateralBoundary;
  from: SideState;
  to: SideState;
  membrane: Membrane;
  primeTree: TreeListing;
  rule: DestinationRule;
  knownRefs: readonly string[];
  writes: readonly string[];
  deletes: ReadonlyArray<{ path: string; deletedOn: string }>;
  conflicts: ReadonlyArray<{ path: string; why: string }>;
  memo: LateralMemo;
  mode: LateralMode;
  boundaryComplete: boolean;
}): Promise<DirectionResult> {
  const { ctx, from, to } = p;
  const r = emptyDirection(from.repo, to.repo);
  const done = (outcome: LateralDirectionOutcome, why: string, record: RecordAct, retry = 0) => ({
    report: { ...r, outcome, why },
    record,
    retry,
  });

  if (!p.rule.ok) {
    return done(
      "refused",
      `Nothing was judged: ${to.repo}'s ${p.rule.why}.`,
      { kind: "keep" },
      p.rule.transient ? 1 : 0,
    );
  }

  // What would be offered, less what a person already declined here.
  const deleteSet = new Set(p.deletes.map((d) => d.path));
  const items: ProposalItem[] = [
    ...p.writes.map((path) => ({ path, sha: from.tree.entries.get(path) ?? "" })),
    ...p.deletes.map((d) => ({ path: d.path, sha: DECLINED_DELETION })),
  ].filter((i) => i.sha !== "");
  const { offer, declined } = withoutDeclined({ to: to.repo, items, memo: p.memo });
  r.declined = declined;
  const offerWrites = offer.filter((i) => !deleteSet.has(i.path)).map((i) => i.path);
  const offerDeletes = p.deletes.filter((d) => offer.some((i) => i.path === d.path));
  const branch = lateralBranchName(from.repo);
  const stop = () => ctx.past(DELIVERY_RESERVE_MS);

  // The origin's text for what may cross. A symbolic link or a file past the
  // ceiling is held on its tree entry alone and is never read.
  const readable = offerWrites.filter((path) => {
    const mode = from.tree.modes.get(path) ?? "100644";
    const bytes = from.tree.sizes.get(path);
    return (
      (mode === "100644" || mode === "100755") &&
      !(typeof bytes === "number" && bytes > CASCADE_MAX_FILE_BYTES)
    );
  });
  const origin = await readFiles(ctx.octokit, pinned(from), readable, stop);
  const originText = new Map<string, string | null>();
  for (const [path, f] of origin.files) originText.set(path, f.binary ? null : f.content);

  // The destination's copy of every import target the two sides hold differently.
  const targets = differingImportTargets({
    paths: offerWrites,
    originTree: from.tree.entries,
    originText,
    destinationTree: to.tree.entries,
  });
  const dest = await readFiles(ctx.octokit, pinned(to), targets, stop);
  const destinationText = new Map<string, string | null>();
  for (const [path, f] of dest.files) destinationText.set(path, f.binary ? null : f.content);

  // The destination's own work, where an overwrite or a deletion could break it.
  // Where it cannot be read in full, `capacity` says whether that is a bound
  // (the same next slot) or a read that failed (worth asking again).
  let survivors: Record<string, string> | null = {};
  let survivorsNote: string | null = null;
  let capacity = false;
  if (
    survivorsNeeded({
      writes: offerWrites,
      deletes: offerDeletes.map((d) => d.path),
      destinationTree: to.tree.entries,
    })
  ) {
    const candidates = lateralSurvivorCandidates({
      destinationTree: to.tree.entries,
      originTree: from.tree.entries,
      primeTree: p.primeTree.entries,
    });
    if (candidates.length > SURVIVOR_READ_CEILING) {
      survivors = null;
      capacity = true;
      survivorsNote =
        `${to.repo} holds ${candidates.length} source files of its own, past the ${SURVIVOR_READ_CEILING} ` +
        `this lane reads in one pass, so no overwrite of its source can be shown safe.`;
    } else {
      const read = await readFiles(ctx.octokit, pinned(to), candidates, stop);
      if (read.files.size !== candidates.length) {
        survivors = null;
        const unreadable = read.failed.size + read.unreached.length;
        capacity = read.unreached.length === 0 && read.oversize.size === read.failed.size;
        survivorsNote = capacity
          ? `${read.oversize.size} of ${to.repo}'s own source files are past the size ceiling, so what they import cannot be read.`
          : `${unreadable} of ${to.repo}'s own source files could not be read this pass.`;
      } else {
        survivors = {};
        for (const [path, f] of read.files) survivors[path] = f.binary ? "" : f.content;
      }
    }
  }

  const judgement = judgeLateralWrites({
    membrane: p.membrane,
    paths: offerWrites,
    originTree: from.tree.entries,
    originModes: from.tree.modes,
    originSizes: from.tree.sizes,
    originText,
    destination: p.rule.writes,
    destinationText,
    deletingOnDestination: new Set(offerDeletes.map((d) => d.path)),
    destinationSurvivors: survivors,
    knownRefs: p.knownRefs,
  });

  // What stays on the destination once this lands: its own work, less what
  // this delivery writes over — that arrives as the origin's copy.
  let surviving: Record<string, string> | null = null;
  if (survivors !== null) {
    const writing = new Set(judgement.write);
    surviving = {};
    for (const [path, text] of Object.entries(survivors))
      if (!writing.has(path)) surviving[path] = text;
  }
  const plan = planLateralDeletions({
    deletes: offerDeletes,
    destination: p.rule.deletes,
    survivingFiles: surviving,
  });

  r.writes = judgement.write;
  r.deletes = plan.deletes;
  r.held = judgement.held;
  r.unread = judgement.unread;
  r.keptDeletions = plan.kept;
  r.deletionRefusal = plan.refusal;
  r.outOfScope = [...new Set([...judgement.outOfScope, ...plan.outOfScope])].sort();

  const complete = p.boundaryComplete && judgement.unread.length === 0 && survivors !== null;
  const n = r.writes.length + r.deletes.length;
  // An overwrite held back by a capacity bound is asked again when a head
  // moves, which re-runs the pass anyway; only the rest is worth a slot.
  const boundUnread = capacity
    ? judgement.unread.filter((path) => to.tree.entries.has(path) && isWalkablePath(path)).length
    : 0;
  const retry = judgement.unread.length - boundUnread + (survivors === null && !capacity ? 1 : 0);
  const note = survivorsNote ? ` ${survivorsNote}` : "";

  if (n === 0) {
    if (!complete || ctx.dryRun) {
      return done(
        "nothing",
        (complete
          ? "Nothing may cross this way."
          : "Nothing may cross this way yet; some of it could not be settled this pass.") + note,
        { kind: "keep" },
        retry,
      );
    }
    const stale = await closeStale(ctx, to, branch);
    if (stale.closed) {
      r.pr = stale.closed;
      return done("closed_stale", stale.why, { kind: "clear" });
    }
    return done(
      "nothing",
      stale.why || "Nothing may cross this way.",
      stale.why ? { kind: "keep" } : { kind: "clear" },
    );
  }

  const text = describeLateralProposal({
    boundaryLabel: p.boundary.label,
    from: from.repo,
    to: to.repo,
    originHead: from.head.sha,
    writes: r.writes,
    deletes: r.deletes,
    held: r.held,
    conflicts: p.conflicts,
    outOfScope: r.outOfScope,
    keptDeletions: r.keptDeletions,
    deletionRefusal: r.deletionRefusal,
    declined: r.declined,
    mode: p.mode,
  });
  const offered: ProposalItem[] = [
    ...r.writes.map((path) => ({ path, sha: from.tree.entries.get(path) ?? "" })),
    ...r.deletes.map((path) => ({ path, sha: DECLINED_DELETION })),
  ];

  if (ctx.dryRun) {
    return done(
      "dry_run",
      `Would propose ${n} file(s) into ${to.repo}; nothing was written.${note}`,
      { kind: "keep" },
      retry,
    );
  }
  if (p.mode === "notify") {
    return done(
      "recorded",
      `${n} file(s) may cross into ${to.repo}. The rulebook is set to notify, so nothing was proposed.${note}`,
      { kind: "keep" },
      retry,
    );
  }
  if (ctx.past(DELIVERY_RESERVE_MS)) {
    return done(
      "deferred",
      "Judged, but too little of this invocation was left to deliver it.",
      { kind: "keep" },
      retry + 1,
    );
  }

  // ── Delivery ─────────────────────────────────────────────────────────────
  // The destination must still be the commit it was judged at: a vertical
  // cascade landing in between changes what an overwrite would break.
  const fresh = await readHead(ctx.octokit, { owner: to.owner, repo: to.repo, branch: to.branch });
  if (fresh.sha !== to.head.sha) {
    return done(
      "deferred",
      `${to.repo} moved from ${short(to.head.sha)} to ${short(fresh.sha)} after it was judged; the next pass judges it again.`,
      { kind: "keep" },
      retry + 1,
    );
  }

  const open = await findOpenProposal(ctx.octokit, to, branch);
  if (open && (await carries(ctx.octokit, to, open.number, offered))) {
    r.pr = { number: open.number, url: open.url };
    r.merge =
      p.mode !== "auto_merge"
        ? null
        : (await pausedNow(ctx.supabase, p.boundary))
          ? PAUSED_MID_PASS
          : await landOrArm(ctx.octokit, to, open, text.title);
    return done(
      "unchanged",
      `PR #${open.number} already carries exactly this offer.${note}`,
      {
        kind: "set",
        record: { from: from.repo, to: to.repo, pr: open.number, url: open.url, items: offered },
      },
      retry,
    );
  }
  if (open && !(await laneOwns(ctx.octokit, to, open.number))) {
    r.pr = { number: open.number, url: open.url };
    return done(
      "unchanged",
      `PR #${open.number} has commits a person pushed, so the lane will not rebuild it over them. ` +
        `Merge or close it, and the next pass proposes what is left.`,
      {
        kind: "set",
        record: { from: from.repo, to: to.repo, pr: open.number, url: open.url, items: offered },
      },
      retry,
    );
  }

  const entries: DeliveryTreeEntry[] = [];
  for (const path of r.writes) {
    const file = origin.files.get(path);
    if (!file) {
      // A write the judge let through has text by construction; this is
      // the invariant saying so rather than a path delivered empty.
      return done(
        "failed",
        `\`${path}\` was judged without being read.`,
        { kind: "keep" },
        retry + 1,
      );
    }
    const mode: DeliveryMode = from.tree.modes.get(path) === "100755" ? "100755" : "100644";
    if (file.binary) {
      const { data: blob } = await ctx.octokit.git.createBlob({
        owner: to.owner,
        repo: to.repo,
        content: file.base64,
        encoding: "base64",
      });
      entries.push({ path, mode, type: "blob", sha: blob.sha });
    } else {
      entries.push({ path, mode, type: "blob", content: file.content });
    }
  }
  for (const path of r.deletes) entries.push({ path, mode: "100644", type: "blob", sha: null });

  let treeSha = to.head.treeSha;
  for (const chunk of chunkTreeEntries(entries)) {
    const { data: tree } = await ctx.octokit.git.createTree({
      owner: to.owner,
      repo: to.repo,
      base_tree: treeSha,
      tree: chunk.map(toGitTreeParam),
    });
    treeSha = tree.sha;
  }
  const { data: commit } = await ctx.octokit.git.createCommit({
    owner: to.owner,
    repo: to.repo,
    message: text.commitMessage,
    tree: treeSha,
    parents: [to.head.sha],
  });

  let proposal: { number: number; url: string; nodeId: string | null; headSha: string };
  let outcome: LateralDirectionOutcome;
  if (open) {
    // Ownership was read before the commit above was built, and building it
    // spends calls. A person who pushed to the branch in that time pushed
    // AFTER the check, and the force below would drop their commit — so the
    // one fact that would show it is read again: where the branch points now.
    // The REST API offers no compare-and-swap on a ref, so what remains is
    // the moment between this read and that write, rather than the whole
    // build.
    const branchNow = await readHead(ctx.octokit, { owner: to.owner, repo: to.repo, branch });
    if (branchNow.sha !== open.headSha) {
      return done(
        "deferred",
        `PR #${open.number}'s branch moved from ${short(open.headSha)} to ${short(branchNow.sha)} ` +
          `while this pass built its replacement, so it was left as it is; the next pass reads it again.`,
        { kind: "keep" },
        retry + 1,
      );
    }
    await ctx.octokit.git.updateRef({
      owner: to.owner,
      repo: to.repo,
      ref: `heads/${branch}`,
      sha: commit.sha,
      force: true,
    });
    const { data: updated } = await ctx.octokit.pulls.update({
      owner: to.owner,
      repo: to.repo,
      pull_number: open.number,
      title: text.title,
      body: `${text.body}\n\n_Updated in place, so one proposal tracks this origin._`,
    });
    proposal = {
      number: open.number,
      url: open.url,
      nodeId: updated.node_id ?? null,
      headSha: commit.sha,
    };
    outcome = "updated";
  } else {
    await pointBranch(ctx.octokit, to, branch, commit.sha);
    const { data: created } = await ctx.octokit.pulls.create({
      owner: to.owner,
      repo: to.repo,
      title: text.title,
      head: branch,
      base: to.branch,
      body: text.body,
    });
    proposal = {
      number: created.number,
      url: created.html_url,
      nodeId: created.node_id ?? null,
      headSha: commit.sha,
    };
    outcome = "proposed";
  }
  r.pr = { number: proposal.number, url: proposal.url };
  r.merge =
    p.mode !== "auto_merge"
      ? null
      : (await pausedNow(ctx.supabase, p.boundary))
        ? PAUSED_MID_PASS
        : await landOrArm(ctx.octokit, to, proposal, text.title);
  return done(
    outcome,
    `${outcome === "proposed" ? "Opened" : "Updated"} PR #${proposal.number} with ${n} file(s) from ${from.repo}@${short(from.head.sha)}.${note}`,
    {
      kind: "set",
      record: {
        from: from.repo,
        to: to.repo,
        pr: proposal.number,
        url: proposal.url,
        items: offered,
      },
    },
    retry,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// One boundary
// ─────────────────────────────────────────────────────────────────────────────

function emptyBoundary(boundary: LateralBoundary): LateralBoundaryReport {
  return {
    boundary: boundary.id,
    label: boundary.label,
    outcome: "skipped",
    why: "",
    mode: null,
    candidates: 0,
    primeOwned: 0,
    conflicts: [],
    deferred: [],
    reconcile: [],
    directions: [],
    ledgerWritten: null,
  };
}

async function passBoundary(
  ctx: PassContext,
  boundary: LateralBoundary,
): Promise<LateralBoundaryReport> {
  const report = emptyBoundary(boundary);
  const finish = (
    outcome: LateralBoundaryReport["outcome"],
    why: string,
  ): LateralBoundaryReport => ({
    ...report,
    outcome,
    why,
  });

  const ledger = await readLastRow(ctx.supabase, boundary);
  if (!ledger.ok) {
    return finish(
      "refused",
      `The lateral ledger could not be read (${ledger.why}). It holds the pause, every decline and ` +
        `every open proposal, so nothing was asked without it.`,
    );
  }
  const last = ledger.last;
  const prior = last?.state ?? EMPTY_LATERAL_LEDGER;
  if (prior.paused && !ctx.force) {
    return finish(
      "paused",
      "Paused by an operator: nothing is read, proposed or merged across this boundary.",
    );
  }

  /*
    Everything this pass learns lands here, so a pass cut short — by a rate
    limit, by the invocation's budget, by a fault — still records what it
    settled. The next slot then resumes from the memo rather than re-asking
    the same histories, which is what makes a pass that never fits one tick
    converge instead of repeating itself.
  */
  const learned = {
    started: false,
    fingerprint: prior.fingerprint,
    heads: null as Record<string, string> | null,
    originAnswers: new Map<string, OriginVerdict>(),
    decisions: new Map<string, SettledLateralDecision>(),
    declines: [] as Reconciled["declines"],
    proposals: prior.proposals,
    memo: prior.memo,
  };

  const record = async (
    outcome: LateralBoundaryReport["outcome"],
    why: string,
    deferredCount: number,
  ): Promise<LateralBoundaryReport> => {
    const out = finish(outcome, why);
    if (ctx.dryRun || !learned.started) return out;
    // A refusal repeated exactly — same reason, same heads — is not written
    // again: the lane retries it every slot, and the audit log should hold one
    // row for it rather than one every ten minutes.
    const lastReport = last ? readLateralReport(last.raw) : null;
    if (
      (outcome === "refused" || outcome === "failed") &&
      lastReport?.outcome === outcome &&
      lastReport.why === out.why &&
      prior.fingerprint === learned.fingerprint
    ) {
      return { ...out, ledgerWritten: null };
    }
    const memo = nextLateralMemo({
      previous: learned.memo,
      nowMs: ctx.nowMs,
      originAnswers: learned.originAnswers,
      decisions: learned.decisions,
      declines: learned.declines,
    });
    // The pause as it stands NOW. A pause or resume written while this pass
    // ran is the newer act, and a row that copied the old value would undo it.
    const current = await readLastRow(ctx.supabase, boundary);
    const paused = current.ok ? (current.last?.state.paused ?? prior.paused) : prior.paused;
    const state: LateralLedgerState = {
      fingerprint: learned.fingerprint,
      paused,
      deferred: deferredCount,
      proposals: learned.proposals,
      memo,
    };
    const written = await writeRow(
      ctx.supabase,
      boundary,
      composeLateralLedgerRow({
        event: "exchange",
        state,
        report: out,
        trigger: ctx.trigger,
        heads: learned.heads,
      }),
      ctx.actorUserId,
    );
    return { ...out, ledgerWritten: written };
  };

  // A registry or configuration that refuses the boundary is recorded — once,
  // since `record` does not repeat an identical refusal — so the diagram can
  // say why nothing crosses, rather than showing a boundary that never ran.
  const setup = await readSetup(ctx.supabase, boundary);
  if (!setup.ok) {
    learned.started = true;
    return await record("refused", setup.why, 1);
  }
  const mode = effectiveLateralMode(setup.prime.default_cascade_mode, prior.paused);
  report.mode = mode;
  const primeRef: RepoRef = {
    owner: setup.prime.github_owner,
    repo: setup.prime.github_repo,
    branch: setup.prime.default_branch || "main",
  };

  try {
    // ── What became of the proposals left open ──────────────────────────────
    const rec = await reconcileProposals(
      ctx.octokit,
      prior.proposals,
      setup.clones,
      mode,
      prior.paused,
      ctx.dryRun,
      async () => !(await pausedNow(ctx.supabase, boundary)),
    );
    report.reconcile = rec.results;
    learned.declines = rec.declines;
    learned.proposals = rec.stillOpen;
    // This slot's declines apply to this pass: a proposal closed a minute ago
    // must not be re-opened by the pass that noticed it closing.
    const memo = nextLateralMemo({
      previous: prior.memo,
      nowMs: ctx.nowMs,
      originAnswers: new Map(),
      decisions: new Map(),
      declines: rec.declines,
    });

    // ── Heads, and whether a pass is worth running ──────────────────────────
    const [nameA, nameB] = boundary.sides;
    const cloneA = setup.clones.get(nameA)!;
    const cloneB = setup.clones.get(nameB)!;
    const refOf = (c: CloneRow): RepoRef => ({
      owner: c.github_owner,
      repo: c.github_repo,
      branch: c.default_branch || "main",
    });
    let heads: [Head, Head, Head];
    try {
      heads = await Promise.all([
        readHead(ctx.octokit, primeRef),
        readHead(ctx.octokit, refOf(cloneA)),
        readHead(ctx.octokit, refOf(cloneB)),
      ]);
    } catch (e) {
      rethrowIfLimited(e);
      return finish(
        "refused",
        `A branch head could not be read (${reasonOf(e)}); nothing was judged.`,
      );
    }
    const [primeHead, headA, headB] = heads;
    const headMap = {
      [`prime:${primeRef.repo}`]: primeHead.sha,
      [nameA]: headA.sha,
      [nameB]: headB.sha,
    };
    const fingerprint = lateralFingerprint(headMap);

    const run = decideLateralRun({
      nowMs: ctx.nowMs,
      force: ctx.force,
      fingerprint,
      proposalsSettled: rec.settled,
      last: last
        ? {
            fingerprint: prior.fingerprint,
            at: last.at,
            deferred: prior.deferred,
            paused: prior.paused,
          }
        : null,
    });
    if (!run.run) return finish("skipped", `Not run — ${run.why}.`);
    if (ctx.past(PASS_FLOOR_MS)) {
      return finish(
        "deferred",
        "Due, but too little of this invocation was left for a pass; the next slot runs it.",
      );
    }

    learned.started = true;
    learned.fingerprint = fingerprint;
    learned.heads = headMap;
    learned.memo = memo;

    // ── Trees, at exactly those heads ───────────────────────────────────────
    const [primeTree, treeA, treeB] = await Promise.all([
      listTreeAt(ctx.octokit, primeRef, primeHead.treeSha),
      listTreeAt(ctx.octokit, refOf(cloneA), headA.treeSha),
      listTreeAt(ctx.octokit, refOf(cloneB), headB.treeSha),
    ]);
    if (primeTree.truncated || treeA.truncated || treeB.truncated) {
      // A truncated tree cannot say a path is absent — and absence is the
      // whole of what this lane reads.
      return await record(
        "refused",
        "A repository tree was truncated by GitHub, and a partial tree read as whole would describe files that are not missing as missing.",
        1,
      );
    }
    const side = (clone: CloneRow, head: Head, tree: TreeListing): SideState => ({
      clone,
      repo: clone.github_repo,
      owner: clone.github_owner,
      branch: clone.default_branch || "main",
      head,
      tree,
    });
    const sides = new Map<string, SideState>([
      [nameA, side(cloneA, headA, treeA)],
      [nameB, side(cloneB, headB, treeB)],
    ]);

    // ── The rulebook each side is entered under ─────────────────────────────
    const known = await readKnownRefs(ctx.supabase, setup.prime.supabase_project_ref);
    if (!known.ok) return await record("refused", known.why, 1);
    const rules = new Map<string, DestinationRule>();
    for (const [name, s] of sides) rules.set(name, await readDestinationRule(ctx.supabase, s));

    // ── 1. Candidates, and which are parent-level work ──────────────────────
    const candidates = lateralCandidates({
      a: treeA.entries,
      b: treeB.entries,
      prime: primeTree.entries,
    });
    report.candidates = candidates.length;
    const deferred: Array<{ path: string; why: string }> = [];
    const parentLevel: string[] = [];
    const toAsk: string[] = [];
    for (const path of candidates) {
      const remembered = lateralOrigin(path, memo.origin, ctx.nowMs);
      if (remembered === "held") report.primeOwned++;
      else if (remembered === "never") parentLevel.push(path);
      else toAsk.push(path);
    }
    const asking = toAsk.slice(0, ORIGIN_PROBE_CAP);
    for (const path of toAsk.slice(ORIGIN_PROBE_CAP)) {
      deferred.push({
        path,
        why: "Its origin was not asked this pass — past the pass's cap; the next asks it.",
      });
    }
    const primePinned: RepoRef = { ...primeRef, branch: primeHead.sha };
    const asked = await mapWithConcurrencyUntil(
      asking,
      PROBE_WIDTH,
      (path) => primeHeldPath(ctx.octokit, primePinned, path),
      () => ctx.past(DELIVERY_RESERVE_MS * 2),
    );
    asked.results.forEach((answer, i) => {
      const path = asking[i];
      if (answer === "held") {
        learned.originAnswers.set(path, "held");
        report.primeOwned++;
      } else if (answer === "never") {
        learned.originAnswers.set(path, "never");
        parentLevel.push(path);
      } else {
        deferred.push({
          path,
          why: `The prime's history for this path could not be read (${answer.unsettled}), and an unread history is not an empty one.`,
        });
      }
    });
    for (const path of asking.slice(asked.processed)) {
      deferred.push({ path, why: "Not reached before this invocation's budget ran out." });
    }

    // ── 2. Which way each one moves ─────────────────────────────────────────
    const settled: SettledLateralDecision[] = [];
    const toWalk: Array<{ path: string; a: LateralSide; b: LateralSide; key: string }> = [];
    for (const path of parentLevel.sort()) {
      const a: LateralSide = { repo: nameA, sha: treeA.entries.get(path) ?? null };
      const b: LateralSide = { repo: nameB, sha: treeB.entries.get(path) ?? null };
      const key = decisionKey(path, a.sha, b.sha);
      const recalled = recalledDecision(memo, key, ctx.nowMs);
      if (recalled) settled.push(recalled);
      else toWalk.push({ path, a, b, key });
    }
    const walking = toWalk.slice(0, DIRECTION_PROBE_CAP);
    for (const w of toWalk.slice(DIRECTION_PROBE_CAP)) {
      deferred.push({
        path: w.path,
        why: "Its direction was not walked this pass — past the pass's cap; the next walks it.",
      });
    }
    const walked = await mapWithConcurrencyUntil(
      walking,
      PROBE_WIDTH,
      async (w) => {
        const a: LateralSide = { ...w.a };
        const b: LateralSide = { ...w.b };
        for (const probe of historyProbesFor(w.a, w.b)) {
          const s = sides.get(probe.repo)!;
          const history = await sideHistory(ctx.octokit, pinned(s), w.path, probe.stopAt);
          if (probe.repo === nameA) a.history = history;
          else b.history = history;
        }
        return decideLateral({ path: w.path, a, b });
      },
      () => ctx.past(DELIVERY_RESERVE_MS * 2),
    );
    walked.results.forEach((d, i) => {
      if (d.act === "defer") deferred.push({ path: d.path, why: d.why });
      else {
        learned.decisions.set(walking[i].key, d);
        settled.push(d);
      }
    });
    for (const w of walking.slice(walked.processed)) {
      deferred.push({ path: w.path, why: "Not reached before this invocation's budget ran out." });
    }

    const writesInto = new Map<string, string[]>([
      [nameA, []],
      [nameB, []],
    ]);
    const deletesOn = new Map<string, Array<{ path: string; deletedOn: string }>>([
      [nameA, []],
      [nameB, []],
    ]);
    for (const d of settled) {
      if (d.act === "write") writesInto.get(d.to)?.push(d.path);
      else if (d.act === "delete")
        deletesOn.get(d.on)?.push({ path: d.path, deletedOn: d.deletedOn });
      else report.conflicts.push({ path: d.path, kind: d.kind, why: d.why });
    }
    report.conflicts.sort((x, y) => x.path.localeCompare(y.path));
    report.deferred = deferred.sort((x, y) => x.path.localeCompare(y.path));

    // ── 3 & 4. Each direction, under its own destination's rulebook ─────────
    let retry = 0;
    let proposals = learned.proposals;
    for (const toName of boundary.sides) {
      const fromName = otherSide(boundary, toName)!;
      const dir = await passDirection({
        ctx,
        boundary,
        from: sides.get(fromName)!,
        to: sides.get(toName)!,
        membrane: boundary.toward[toName],
        primeTree,
        rule: rules.get(toName)!,
        knownRefs: known.refs,
        writes: writesInto.get(toName) ?? [],
        deletes: deletesOn.get(toName) ?? [],
        conflicts: report.conflicts,
        memo,
        mode,
        boundaryComplete: deferred.length === 0,
      });
      report.directions.push(dir.report);
      retry += dir.retry;
      const others = proposals.filter((x) => !(x.from === fromName && x.to === toName));
      if (dir.record.kind === "set") proposals = [...others, dir.record.record];
      else if (dir.record.kind === "clear") proposals = others;
      learned.proposals = proposals;
    }

    const deferredCount = deferred.length + retry;
    const moved = report.directions.filter((d) => d.writes.length + d.deletes.length > 0).length;
    return await record(
      "ran",
      `${candidates.length} path(s) differ between the parents outside the prime's tree; ` +
        `${report.primeOwned} of them the prime once held. ${settled.length} settled, ` +
        `${report.conflicts.length} for a person, ${deferred.length} deferred; ${moved} direction(s) had something to carry.`,
      deferredCount,
    );
  } catch (e) {
    const limited = classifyGitHubFailure(e);
    if (limited.kind === "rate_limited") {
      return await record(
        "deferred",
        `GitHub ${limited.detail} for the App's installation; resumes after ${limited.until.replace(/\.\d{3}Z$/, "Z")}.`,
        1,
      );
    }
    console.error(`[lateral] ${boundary.id}:`, reasonOf(e));
    return await record("failed", `The pass failed: ${reasonOf(e)}`, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the lateral lane across every declared boundary. Never throws.
 *
 * `remaining` is the installation's window when the caller already read it —
 * the drain has, one call earlier — so the slot does not spend a second read
 * on the same number.
 */
export async function runLateralExchange(args: {
  trigger: LateralTrigger;
  deadlineAt: number;
  force?: boolean;
  dryRun?: boolean;
  actorUserId?: string | null;
  remaining?: number | null;
  supabase?: Db;
}): Promise<LateralExchangeReport> {
  beginGithubLane(args.trigger === "slot" ? "lateral-exchange" : "lateral-exchange-operator");
  try {
    const remaining = args.remaining !== undefined ? args.remaining : await readGitHubRemaining();
    const spend = decideSpend({ role: args.trigger === "slot" ? "scan" : "actor", remaining });
    if (!spend.proceed) return { ran: false, why: `Not run — ${spend.why}.`, boundaries: [] };

    let octokit: Octo;
    try {
      octokit = getAppOctokit();
    } catch (e) {
      return {
        ran: false,
        why: `The GitHub App could not be reached: ${reasonOf(e)}`,
        boundaries: [],
      };
    }
    const ctx: PassContext = {
      supabase: args.supabase ?? supabaseAdmin,
      octokit,
      trigger: args.trigger,
      force: args.force === true,
      dryRun: args.dryRun === true,
      actorUserId: args.actorUserId ?? null,
      nowMs: Date.now(),
      past: (reserveMs) => Date.now() + reserveMs >= args.deadlineAt,
    };

    const boundaries: LateralBoundaryReport[] = [];
    for (const boundary of FLEET_LATERALS) {
      try {
        boundaries.push(await passBoundary(ctx, boundary));
      } catch (e) {
        // `passBoundary` records its own failures; this is the one before it
        // could — a read of the registry or the ledger that threw.
        boundaries.push({ ...emptyBoundary(boundary), outcome: "failed", why: reasonOf(e) });
      }
    }
    const ran = boundaries.filter((b) => b.outcome === "ran").length;
    return {
      ran: ran > 0,
      why:
        boundaries.map((b) => `${b.label}: ${b.outcome}`).join("; ") ||
        "No lateral boundary is declared.",
      boundaries,
    };
  } finally {
    await flushGithubUsage();
  }
}

/**
 * Pause or resume a boundary.
 *
 * A pause is a ledger row like any other — the last row's state, copied, with
 * `paused` set — so the slot reads it exactly where it reads everything else.
 * Pausing also DISARMS GitHub's auto-merge on every proposal the lane has
 * open: a pause that left an armed proposal to land on its own would stop the
 * lane and not the crossing. Resuming re-arms nothing; the next slot's gate
 * lands what is green.
 */
export async function setLateralExchangePaused(args: {
  paused: boolean;
  actorUserId: string | null;
  supabase?: Db;
}): Promise<
  | {
      ok: true;
      boundaries: Array<{
        boundary: string;
        paused: boolean;
        disarmed: Array<{ repo: string; pr: number; ok: boolean; why: string | null }>;
      }>;
    }
  | { ok: false; error: string }
> {
  const supabase = args.supabase ?? supabaseAdmin;
  beginGithubLane("lateral-exchange-operator");
  try {
    const out: Array<{
      boundary: string;
      paused: boolean;
      disarmed: Array<{ repo: string; pr: number; ok: boolean; why: string | null }>;
    }> = [];
    for (const boundary of FLEET_LATERALS) {
      const ledger = await readLastRow(supabase, boundary);
      if (!ledger.ok) {
        return {
          ok: false,
          error: `The lateral ledger for ${boundary.label} could not be read: ${ledger.why}`,
        };
      }
      const prior = ledger.last?.state ?? EMPTY_LATERAL_LEDGER;
      const disarmed: Array<{ repo: string; pr: number; ok: boolean; why: string | null }> = [];

      if (args.paused && prior.proposals.length > 0) {
        const setup = await readSetup(supabase, boundary);
        let octokit: Octo | null = null;
        try {
          octokit = getAppOctokit();
        } catch {
          octokit = null;
        }
        for (const record of prior.proposals) {
          const clone = setup.ok ? setup.clones.get(record.to) : undefined;
          if (!octokit || !clone) {
            disarmed.push({
              repo: record.to,
              pr: record.pr,
              ok: false,
              why: "could not be reached",
            });
            continue;
          }
          try {
            const { data: pr } = await octokit.pulls.get({
              owner: clone.github_owner,
              repo: clone.github_repo,
              pull_number: record.pr,
            });
            if (pr.state === "open" && pr.auto_merge && pr.node_id) {
              await disarmAutoMerge(octokit, pr.node_id);
              disarmed.push({ repo: record.to, pr: record.pr, ok: true, why: null });
            }
          } catch (e) {
            disarmed.push({ repo: record.to, pr: record.pr, ok: false, why: reasonOf(e) });
          }
        }
      }

      const written = await writeRow(
        supabase,
        boundary,
        composeLateralLedgerRow({
          event: args.paused ? "paused" : "resumed",
          state: { ...prior, paused: args.paused },
          report: ledger.last ? readLateralReport(ledger.last.raw) : null,
          trigger: "operator",
          heads: null,
        }),
        args.actorUserId,
      );
      if (!written) {
        return {
          ok: false,
          error: `The ${args.paused ? "pause" : "resume"} for ${boundary.label} could not be recorded.`,
        };
      }
      out.push({ boundary: boundary.id, paused: args.paused, disarmed });
    }
    return { ok: true, boundaries: out };
  } finally {
    await flushGithubUsage();
  }
}

/** One boundary as the panel draws it: the last exchange, and the rows before it. */
export type LateralLedgerView = {
  boundary: string;
  label: string;
  paused: boolean;
  /** When the last row was written and why. Null where no row exists yet. */
  lastEvent: { event: string; at: string; actorUserId: string | null } | null;
  /** The last exchange's report, which a pause row carries forward. */
  report: LateralBoundaryReport | null;
  /** Proposals the lane is tracking. */
  proposals: Array<{ from: string; to: string; pr: number; url: string; files: number }>;
  history: Array<{ at: string; event: string; outcome: string | null; why: string | null }>;
};

/**
 * What the ledger says about every boundary, for a reader.
 *
 * Reads rows only; asks GitHub nothing, so the panel costs no installation
 * calls however often it is opened.
 */
export async function readLateralExchangeLedger(
  supabase: Db = supabaseAdmin,
): Promise<LateralLedgerView[]> {
  const out: LateralLedgerView[] = [];
  for (const boundary of FLEET_LATERALS) {
    const { data, error } = await supabase
      .from("audit_log")
      .select("metadata, created_at, actor_user_id")
      .eq("action", LATERAL_LEDGER_ACTION)
      .eq("entity_type", LATERAL_LEDGER_ENTITY)
      .eq("entity_id", boundary.ledgerId)
      .order("created_at", { ascending: false })
      .limit(12);
    if (error)
      throw new Error(
        `The lateral ledger for ${boundary.label} could not be read: ${error.message}`,
      );
    const rows = (data ?? []).map((row) => ({
      at: row.created_at,
      actor: row.actor_user_id,
      raw:
        row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {},
    }));
    const latest = rows[0] ?? null;
    const state = latest ? readLateralLedger(latest.raw) : EMPTY_LATERAL_LEDGER;
    out.push({
      boundary: boundary.id,
      label: boundary.label,
      paused: state.paused,
      lastEvent: latest
        ? {
            event: typeof latest.raw.event === "string" ? latest.raw.event : "exchange",
            at: latest.at,
            actorUserId: latest.actor,
          }
        : null,
      report: latest ? readLateralReport(latest.raw) : null,
      proposals: state.proposals.map((p) => ({
        from: p.from,
        to: p.to,
        pr: p.pr,
        url: p.url,
        files: p.items.length,
      })),
      history: rows.map((row) => {
        const report = readLateralReport(row.raw);
        return {
          at: row.at,
          event: typeof row.raw.event === "string" ? row.raw.event : "exchange",
          outcome: report?.outcome ?? null,
          why: report?.why ?? null,
        };
      }),
    });
  }
  return out;
}
