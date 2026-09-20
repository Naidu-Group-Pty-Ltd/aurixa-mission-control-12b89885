/**
 * The blockage ledger: gather the facts, classify them, and keep the open set
 * honest.
 *
 * ## What it is for
 *
 * The auditor says WHETHER a clone is converging. This says WHY it is not, and
 * who can clear it. `CASCADE_PIPELINE_HEALTH.md` §4 has the argument; the rule
 * is that **a blockage may be silent, or permanent, but never both.**
 *
 * ## It costs no GitHub budget at all
 *
 * Every fact it reads is already in Mission Control's own tables: the
 * auditor's newest observation, the events carrying this clone's rows, the
 * result rows themselves, the exclusion count, and the drain's own blocked
 * notice. Nothing here touches a repository, so it runs in the same tick as
 * the auditor without asking `decideSpend` for anything.
 *
 * ## Three rules
 *
 * **It writes one table and reads the rest.** Not `cascade_events`, not
 * `cascade_results`, not `clones`, not `notifications` — a ledger that could
 * edit the record it classifies would be describing its own writes back to
 * itself. `blockageLedger.contract.test.ts` asserts it by source position.
 *
 * **A clearance is recorded and never announced.** An open row whose condition
 * is no longer detected is stamped `cleared_at` rather than deleted, and a
 * fingerprint that comes back opens a NEW row. That is `decideDriftReport`'s
 * rule — compare against what was last OBSERVED — and it is what makes a gap
 * that returned audible again rather than deduped into silence.
 *
 * **It notifies nobody yet.** Step 2 of the shipping order populates the
 * taxonomy from real passes so the classification can be checked against what
 * actually happens before it is allowed to speak. The escalation reads this
 * table and ships separately.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  classifyBlockages,
  parsePrRepo,
  type CloneBlockageFacts,
  type DetectedBlockage,
} from "./cascade/blockageTaxonomy.pure";
import { DEFAULT_CONVERGENCE_SLO_MINUTES } from "./convergenceAudit.server";

type Db = SupabaseClient<Database>;

/**
 * How far back the fact-gather reads result rows.
 *
 * Long enough to carry the standing conditions a freeze produces — the
 * September one ran three days and its retired events mattered afterwards —
 * and short enough that one query answers the whole fleet.
 */
export const FACT_WINDOW_DAYS = 45;

/** Result rows read per clone, newest first. Bounds the consecutive-failure walk. */
const RESULTS_PER_CLONE = 60;

export type BlockageLedgerReport = {
  clones: number;
  opened: number;
  stillOpen: number;
  cleared: number;
  /** Open rows nothing in the taxonomy could explain. The loud one. */
  unclassified: number;
  detail: Array<{ clone: string; open: string[] }>;
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function reconcileBlockageLedger(supabase: Db): Promise<BlockageLedgerReport> {
  const report: BlockageLedgerReport = {
    clones: 0,
    opened: 0,
    stillOpen: 0,
    cleared: 0,
    unclassified: 0,
    detail: [],
  };
  const now = new Date();

  const primeRes = await supabase.from("prime_config").select("*").limit(1).maybeSingle();
  if (primeRes.error) throw new Error(`Could not read prime config: ${primeRes.error.message}`);
  const sloMinutes =
    (primeRes.data as { convergence_slo_minutes?: number | null } | null)
      ?.convergence_slo_minutes ?? DEFAULT_CONVERGENCE_SLO_MINUTES;

  const clonesRes = await supabase
    .from("clones")
    .select("id, name, sync_scope, repo_full_name, github_owner, github_repo");
  // A candidate list that could not be READ is not an empty one — and here it
  // would clear every open blockage on the fleet.
  if (clonesRes.error) throw new Error(`Could not list clones: ${clonesRes.error.message}`);
  const clones = (clonesRes.data ?? []) as Array<{
    id: string;
    name: string | null;
    sync_scope: string | null;
    repo_full_name: string | null;
    github_owner: string | null;
    github_repo: string | null;
  }>;

  const since = new Date(now.getTime() - FACT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const facts = await gatherFacts(supabase, clones, since, sloMinutes);

  for (const clone of clones) {
    report.clones += 1;
    const f = facts.get(clone.id);
    if (!f) continue;
    const detected = classifyBlockages(f, now);
    const outcome = await reconcileOne(supabase, clone.id, detected, now);
    report.opened += outcome.opened;
    report.stillOpen += outcome.stillOpen;
    report.cleared += outcome.cleared;
    report.unclassified += detected.filter((d) => d.cls === "unclassified").length;
    report.detail.push({ clone: f.label, open: detected.map((d) => d.cls) });
  }

  return report;
}

/**
 * Everything the classifier needs, for the whole fleet, in a fixed number of
 * queries rather than a fixed number per clone.
 */
async function gatherFacts(
  supabase: Db,
  clones: Array<{
    id: string;
    name: string | null;
    sync_scope: string | null;
    repo_full_name: string | null;
    github_owner: string | null;
    github_repo: string | null;
  }>,
  since: string,
  sloMinutes: number,
): Promise<Map<string, CloneBlockageFacts>> {
  const ids = clones.map((c) => c.id);
  const out = new Map<string, CloneBlockageFacts>();
  if (ids.length === 0) return out;

  const exclusions = await supabase
    .from("clone_sync_exclusions")
    .select("clone_id")
    .in("clone_id", ids);
  if (exclusions.error) {
    throw new Error(`Could not read exclusion policies: ${exclusions.error.message}`);
  }
  const exclusionCount = new Map<string, number>();
  for (const row of (exclusions.data ?? []) as Array<{ clone_id: string }>) {
    exclusionCount.set(row.clone_id, (exclusionCount.get(row.clone_id) ?? 0) + 1);
  }

  // The auditor's newest reading per clone. Ordered once and taken first-seen,
  // which is cheaper than one query per clone and gives the same row.
  const observations = await supabase
    .from("clone_convergence_observations")
    .select("clone_id, state, owed_count, owed_fingerprint, unchanged_since, observed_at")
    .in("clone_id", ids)
    .order("observed_at", { ascending: false })
    .limit(ids.length * 8);
  if (observations.error) {
    throw new Error(`Could not read convergence observations: ${observations.error.message}`);
  }
  const newestObservation = new Map<string, CloneBlockageFacts["convergence"]>();
  for (const row of (observations.data ?? []) as Array<{
    clone_id: string;
    state: string;
    owed_count: number;
    owed_fingerprint: string | null;
    unchanged_since: string | null;
  }>) {
    if (newestObservation.has(row.clone_id)) continue;
    newestObservation.set(row.clone_id, {
      state: row.state,
      owedCount: row.owed_count,
      owedFingerprint: row.owed_fingerprint,
      unchangedSince: row.unchanged_since,
    });
  }

  const results = await supabase
    .from("cascade_results")
    .select(
      "id, clone_id, cascade_event_id, status, pr_url, diff_summary, error_message, created_at, updated_at",
    )
    .in("clone_id", ids)
    .gte("created_at", since)
    .order("created_at", { ascending: false });
  if (results.error) throw new Error(`Could not read cascade results: ${results.error.message}`);
  type ResultRow = {
    id: string;
    clone_id: string;
    cascade_event_id: string;
    status: string;
    pr_url: string | null;
    diff_summary: string | null;
    error_message: string | null;
    created_at: string;
    updated_at: string;
  };
  const resultsByClone = new Map<string, ResultRow[]>();
  for (const row of (results.data ?? []) as ResultRow[]) {
    const list = resultsByClone.get(row.clone_id) ?? [];
    if (list.length < RESULTS_PER_CLONE) list.push(row);
    resultsByClone.set(row.clone_id, list);
  }

  /*
    Every `pr_opened` row, whatever its age — not only those inside the fact
    window. The 43 rows this was built to find are from 26–28 August, and a
    window that excluded them would have made the ledger blind to exactly the
    fault that motivated it.
  */
  const openProposals = await supabase
    .from("cascade_results")
    .select("id, clone_id, pr_url, created_at")
    .in("clone_id", ids)
    .eq("status", "pr_opened");
  if (openProposals.error) {
    throw new Error(`Could not read open proposals: ${openProposals.error.message}`);
  }
  const proposalsByClone = new Map<string, CloneBlockageFacts["openProposals"]>();
  for (const row of (openProposals.data ?? []) as Array<{
    id: string;
    clone_id: string;
    pr_url: string | null;
    created_at: string;
  }>) {
    const list = proposalsByClone.get(row.clone_id) ?? [];
    list.push({
      resultId: row.id,
      prUrl: row.pr_url,
      prRepo: parsePrRepo(row.pr_url),
      createdAt: row.created_at,
    });
    proposalsByClone.set(row.clone_id, list);
  }

  const eventIds = [...new Set([...resultsByClone.values()].flat().map((r) => r.cascade_event_id))];
  type EventRow = {
    id: string;
    status: string;
    attempts: number | null;
    requires_approval: boolean | null;
    approved_at: string | null;
    next_attempt_at: string | null;
    worker_started_at: string | null;
    updated_at: string;
  };
  const eventById = new Map<string, EventRow>();
  if (eventIds.length > 0) {
    const events = await supabase
      .from("cascade_events")
      .select(
        "id, status, attempts, requires_approval, approved_at, next_attempt_at, worker_started_at, updated_at",
      )
      .in("id", eventIds);
    if (events.error) throw new Error(`Could not read cascade events: ${events.error.message}`);
    for (const row of (events.data ?? []) as EventRow[]) eventById.set(row.id, row);
  }

  /*
    The gate's own verdict, read rather than re-derived. `decideCascadeMerge`
    is the one authority on whether a proposal may merge; the drain writes its
    verdict here when the same failure recurs on a rebuilt head, and it clears
    the notice on the merge. UNREAD only — a notice a person has read is one
    they have seen, and re-reporting it is how a list stops being a list of
    what needs doing.
  */
  const blocked = await supabase
    .from("notifications")
    .select("clone_id, title, body, created_at")
    .eq("kind", "cascade_blocked")
    .is("read_at", null)
    .in("clone_id", ids)
    .order("created_at", { ascending: false });
  if (blocked.error) {
    throw new Error(`Could not read blocked notices: ${blocked.error.message}`);
  }
  const blockedByClone = new Map<string, CloneBlockageFacts["blockedNotice"]>();
  for (const row of (blocked.data ?? []) as Array<{
    clone_id: string | null;
    title: string;
    body: string;
    created_at: string;
  }>) {
    if (!row.clone_id || blockedByClone.has(row.clone_id)) continue;
    blockedByClone.set(row.clone_id, {
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
    });
  }

  /*
    THE PRIME VERSIONS EACH CLONE'S LAST PASS WAS HELD BEHIND.

    `partitionByDependency` has recorded `blockedBy` on every migration it
    skipped since it was written, into `clone_backends.migrations_applied`.
    Nothing had ever read it back — which is why two tenants sat at frontier
    `20261201100000` for days reading `status: ready`, with the condition's
    only trace being prose in `status_detail`.

    Read from the clone's own row, so this costs no GitHub call and no read of
    the prime: the blockage is reported from the same evidence that produced
    it. A read that FAILS throws rather than reporting no holes — an
    unreadable backend is not a fleet with nothing blocking it, and this
    function's other reads already answer to that rule.
  */
  const backends = await supabase
    .from("clone_backends")
    .select("clone_id, migrations_applied")
    .in("clone_id", ids);
  if (backends.error) {
    throw new Error(`Could not read clone backends: ${backends.error.message}`);
  }
  const holesByClone = new Map<string, CloneBlockageFacts["primeLedgerHoles"]>();
  for (const row of (backends.data ?? []) as Array<{
    clone_id: string;
    migrations_applied: unknown;
  }>) {
    const applied = Array.isArray(row.migrations_applied) ? row.migrations_applied : [];
    // version → the migrations it holds, in the order the pass recorded them.
    const held = new Map<string, string[]>();
    for (const entry of applied as Array<Record<string, unknown>>) {
      /*
        A HOLE THAT WITHHOLDS NOTHING IS STILL A HOLE.

        `blockedBy` names the holes a WITHHELD migration is sitting behind, so
        reading it alone reports a hole only while something is queued after
        it. A hole at the tail of the corpus queues nothing — and still means
        the prime is behind its own repository, which is the condition that
        went unreported for days in September 2026. `primeLedgerHole` is the
        pass's note about the hole itself, filed by `applyPrimeMigrations`
        before its replay loop runs.

        Both are read into the same map on purpose: a version can arrive by
        either route or by both, and the existing shape already carries the
        difference — `heldCount: 0` is a hole withholding nothing.
      */
      if (entry?.primeLedgerHole === true && typeof entry?.id === "string" && entry.id !== "") {
        if (!held.has(entry.id)) held.set(entry.id, []);
      }
      const blockedBy = Array.isArray(entry?.blockedBy) ? entry.blockedBy : [];
      const name = typeof entry?.name === "string" ? entry.name : null;
      for (const version of blockedBy) {
        if (typeof version !== "string") continue;
        const list = held.get(version) ?? [];
        if (name) list.push(name);
        held.set(version, list);
      }
    }
    if (held.size === 0) continue;
    holesByClone.set(
      row.clone_id,
      [...held.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([version, names]) => ({
          version,
          heldCount: names.length,
          firstHeld: names[0] ?? null,
        })),
    );
  }

  for (const clone of clones) {
    const rows = resultsByClone.get(clone.id) ?? [];

    /*
      Failures since the last success, which is the count nothing anywhere
      keeps. Failure is recorded per DELIVERY, so a clone failing every
      cascade for a month reads as several unrelated events; the walk stops at
      the first `succeeded` because that is the moment the run ended.
    */
    let consecutiveFailures = 0;
    for (const row of rows) {
      if (row.status === "succeeded") break;
      if (row.status === "failed") consecutiveFailures += 1;
    }

    const events: CloneBlockageFacts["events"] = [];
    const seenEvents = new Set<string>();
    for (const row of rows) {
      if (row.status === "succeeded" || row.status === "skipped") continue;
      if (seenEvents.has(row.cascade_event_id)) continue;
      seenEvents.add(row.cascade_event_id);
      const e = eventById.get(row.cascade_event_id);
      if (!e) continue;
      events.push({
        id: e.id,
        status: e.status,
        attempts: e.attempts ?? 0,
        requiresApproval: Boolean(e.requires_approval),
        approvedAt: e.approved_at,
        nextAttemptAt: e.next_attempt_at,
        workerStartedAt: e.worker_started_at,
        resultStatus: row.status,
        resultSummary: row.diff_summary,
        resultError: row.error_message,
        updatedAt: e.updated_at ?? row.updated_at,
      });
    }

    const repoFullName =
      clone.repo_full_name ??
      (clone.github_owner && clone.github_repo
        ? `${clone.github_owner}/${clone.github_repo}`
        : null);

    out.set(clone.id, {
      cloneId: clone.id,
      label: clone.name ?? repoFullName ?? clone.id,
      syncScope: clone.sync_scope,
      exclusionCount: exclusionCount.get(clone.id) ?? 0,
      repoFullName,
      convergence: newestObservation.get(clone.id) ?? null,
      openProposals: proposalsByClone.get(clone.id) ?? [],
      events,
      consecutiveFailures,
      blockedNotice: blockedByClone.get(clone.id) ?? null,
      primeLedgerHoles: holesByClone.get(clone.id) ?? [],
      sloMinutes,
    });
  }

  return out;
}

/**
 * Bring one clone's open set into line with what was just detected.
 *
 * Open rows whose condition still holds have their `last_seen_at` bumped;
 * conditions with no open row open one; open rows nothing detected are
 * CLEARED rather than deleted. A blockage records that a condition existed,
 * and destroying that record is how the second occurrence looks like the
 * first.
 */
async function reconcileOne(
  supabase: Db,
  cloneId: string,
  detected: DetectedBlockage[],
  now: Date,
): Promise<{ opened: number; stillOpen: number; cleared: number }> {
  const nowIso = now.toISOString();

  const openRes = await supabase
    .from("clone_sync_blockages")
    .select("id, fingerprint")
    .eq("clone_id", cloneId)
    .is("cleared_at", null);
  // An open set that could not be READ is not an empty one — acting on that
  // would open a duplicate of every standing blockage on every pass.
  if (openRes.error) {
    throw new Error(`Could not read open blockages: ${openRes.error.message}`);
  }
  const open = new Map(
    ((openRes.data ?? []) as Array<{ id: string; fingerprint: string }>).map((r) => [
      r.fingerprint,
      r.id,
    ]),
  );
  const detectedByFingerprint = new Map(detected.map((d) => [d.fingerprint, d]));

  let opened = 0;
  let stillOpen = 0;
  let cleared = 0;

  for (const d of detected) {
    const existing = open.get(d.fingerprint);
    if (existing) {
      const { error } = await supabase
        .from("clone_sync_blockages")
        .update({ last_seen_at: nowIso, detail: d.detail })
        .eq("id", existing);
      if (error) throw new Error(`Could not refresh blockage ${existing}: ${error.message}`);
      stillOpen += 1;
      continue;
    }
    const { error } = await supabase.from("clone_sync_blockages").insert({
      clone_id: cloneId,
      class: d.cls,
      owner: d.owner,
      self_heals: d.selfHeals,
      fingerprint: d.fingerprint,
      detail: d.detail,
      first_seen_at: d.since ?? nowIso,
      last_seen_at: nowIso,
    });
    if (error) throw new Error(`Could not open blockage ${d.fingerprint}: ${error.message}`);
    opened += 1;
  }

  for (const [fingerprint, id] of open) {
    if (detectedByFingerprint.has(fingerprint)) continue;
    const { error } = await supabase
      .from("clone_sync_blockages")
      .update({ cleared_at: nowIso })
      .eq("id", id);
    if (error) throw new Error(`Could not clear blockage ${id}: ${error.message}`);
    cleared += 1;
  }

  return { opened, stillOpen, cleared };
}

export { msg as blockageLedgerErrorMessage };
