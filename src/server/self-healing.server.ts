// The self-healing engine: plans and executes remediation runs for support
// tickets and verified security-scan remediations.
//
// Everything here obeys one rulebook — decideRemediation in
// src/lib/remediation-policy.ts. P2-and-below actions execute unattended;
// anything the policy flags (P0/P1, destructive SQL, unverified or
// oversized patches) parks as `awaiting_validation` and waits for an admin
// on /support/tickets. The policy is re-checked AT EXECUTION TIME, not just
// at planning: state can change between the two (a verification retracted,
// a priority overridden), and the check is cheap.
//
// Lanes:
//   pr_merge             — squash-merge a verified codex remediation PR
//                          (the existing scan → draft-PR pipeline authored
//                          and verified it; this lane only releases it).
//   sql_migration        — replay pending prime migrations onto the clone's
//                          Supabase project, scoped to what the prime has
//                          itself applied (the fleet sync's own rule),
//                          destructiveness-checked statement by statement
//                          first, and bounded to the invocation budget.
//   edge_function_deploy — redeploy the prime's function bundles onto the
//                          clone's Supabase project via the Management API.
//   monitor_recovery     — watch health beacons; resolve when healthy.
//   rescan               — enqueue a codex security scan; findings then
//                          flow the normal scan → remediation pipeline.

import type {
  EdgeFunctionBundle,
  EdgeFunctionDeployResult,
} from "@/server/backend-provisioning.server";
import type { Database, Json, TablesInsert, TablesUpdate } from "@/integrations/supabase/types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assessSqlDestructiveness } from "@/lib/destructive-sql";
import { decideRemediation } from "@/lib/remediation-policy";
import {
  severityToPriority,
  priorityAtOrBelow,
  type TicketPriority,
} from "@/lib/ticket-classification";
import { asJson, asRow } from "@/lib/json-cast";
import {
  countLanded,
  planEdgeDeployPass,
  planEdgeDeployResume,
  refreshedSince,
  runWithinBudget,
} from "@/server/edgeDeployBatch.pure";

function secretsCleanFromVerification(verification: Json | null | undefined): boolean {
  if (verification && typeof verification === "object" && !Array.isArray(verification)) {
    return verification.secrets_clean !== false;
  }
  return true;
}

// Per-run caps. Ordered queries, so a backlog above these drains in order.
const TICKET_ROLLUP_BATCH = 100;
const SLA_ESCALATION_BATCH = 50;

const DRAIN_BATCH = 10;
const MONITOR_RETRY_MINUTES = 5;
const MONITOR_HEALTHY_WITHIN_MINUTES = 15;
const AUTO_MERGE_SCAN_BATCH = 5;
const INGEST_LEDGER_RETENTION_DAYS = 7;

/**
 * Function bundles one pass may fetch and deploy.
 *
 * The same sixty the provisioning runner uses, for the same measured reason:
 * 423 bundles over ~1,033 files does not fit one invocation, of the GitHub
 * App's hourly quota or of the request itself. Measured 2 Sep 2026, this
 * lane's FIRST live run asked for all of them, ran thirty minutes and
 * deployed nothing at all before its invocation was killed.
 */
const EDGE_DEPLOY_BATCH = 60;

/**
 * How long one invocation of this lane may spend deploying before it stops
 * and hands the run back to the queue.
 *
 * The batch cap bounds what a pass FETCHES; it does not bound how long
 * deploying that batch takes. Measured 2 Sep 2026 against the live run: a
 * pass deployed ~18 bundles in about a minute and was then killed mid-batch,
 * leaving the row in `executing` where no lane reads it. Nothing looked at it
 * again until `reclaimStalledRuns` requeued it twenty minutes later, so the
 * fleet advanced ~18 bundles per twenty minutes and spent an attempt on each
 * — 88 of 423 deployed over five hours, 14 of 30 attempts gone, and the
 * arithmetic said it would exhaust its budget short of the last bundle.
 *
 * Stopping deliberately turns that twenty-minute stall into the drain's own
 * two-minute tick. The number is below the 60s at which pg_net stops waiting,
 * with room left for the five sweep steps that follow this one.
 */
const EDGE_DEPLOY_BUDGET_MS = 45_000;
/**
 * The same ceiling for the migration lane, for the same reason: a replay
 * that outlives its invocation is killed mid-loop, sits in `executing` until
 * the stall reclaim requeues it twenty minutes later, and starts the whole
 * replay again. Measured on `npc-client-dashboard`, 2 Sep 2026: eleven such
 * passes over three and a half hours, and not one migration landed.
 */
const SQL_MIGRATION_BUDGET_MS = 45_000;
/** Bodies fetched at once for the destructiveness gate. */
const SQL_GATE_FETCH_CONCURRENCY = 6;

/**
 * How long a run may sit in `executing` before it is presumed dead.
 *
 * `executeRemediationRun` accepts only `planned` and `approved`, so a row
 * left `executing` by a killed invocation is never looked at again by
 * anything — it is not on any work list and no lane reads that state. Twenty
 * minutes is far above any real invocation's budget and far below the point
 * where a stuck row stops looking like progress on the clone page.
 */
const RUN_STALL_MINUTES = 20;

const admin = supabaseAdmin;

// ── Planning ─────────────────────────────────────────────────────────────

export type PlanResult = { runsPlanned: number; notes: string[] };

/**
 * Plan the self-healing runs for an auto-remediable ticket. Called by the
 * ingest path right after classification; idempotent per ticket (re-planning
 * an already-planned ticket adds nothing).
 */
export async function planTicketRemediation(ticketId: string): Promise<PlanResult> {
  const notes: string[] = [];
  const { data: ticket } = await admin
    .from("support_tickets")
    .select("id, clone_id, priority, category, remediation_lane, auto_remediable, requires_human")
    .eq("id", ticketId)
    .maybeSingle();
  if (!ticket) return { runsPlanned: 0, notes: ["ticket not found"] };
  if (!ticket.auto_remediable || ticket.requires_human) {
    return { runsPlanned: 0, notes: ["ticket is not auto-remediable"] };
  }

  const { count: existing } = await admin
    .from("remediation_runs")
    .select("id", { count: "exact", head: true })
    .eq("ticket_id", ticket.id);
  if ((existing ?? 0) > 0) return { runsPlanned: 0, notes: ["runs already planned"] };

  type PlannedRun = Record<string, unknown> & {
    action_type: Database["public"]["Enums"]["remediation_action_type"];
    priority?: TicketPriority | null;
    _policyInput?: Record<string, unknown>;
  };
  const runs: PlannedRun[] = [];
  const base = { ticket_id: ticket.id, clone_id: ticket.clone_id, priority: ticket.priority };

  switch (ticket.remediation_lane) {
    case "security_scan": {
      // Verified draft PRs already waiting on findings in this scope are
      // released by the pr_merge lane; otherwise gather fresh evidence.
      const merges = await planVerifiedMergesForScope(ticket.clone_id, ticket.priority, ticket.id);
      runs.push(...(merges as PlannedRun[]));
      if (merges.length === 0) {
        runs.push({
          ...base,
          action_type: "rescan",
          plan: { reason: "no verified fixes waiting" },
        });
      }
      break;
    }
    case "redeploy": {
      if (ticket.clone_id) {
        runs.push({
          ...base,
          action_type: "sql_migration",
          plan: { mode: "catch_up" },
        });
        runs.push({
          ...base,
          action_type: "edge_function_deploy",
          plan: { slugs: null },
        });
      }
      runs.push({ ...base, action_type: "monitor_recovery", plan: {} });
      break;
    }
    case "monitor": {
      runs.push({ ...base, action_type: "monitor_recovery", plan: {} });
      break;
    }
    case "rescan": {
      runs.push({ ...base, action_type: "rescan", plan: { reason: ticket.category } });
      break;
    }
    default:
      return { runsPlanned: 0, notes: [`no lane: ${ticket.remediation_lane}`] };
  }

  let planned = 0;
  for (const run of runs) {
    const decision = decideRemediation({
      actionType: run.action_type,
      priority: run.priority ?? ticket.priority,
      // pr_merge runs planned above carry their verification snapshot.
      ...(run._policyInput ?? {}),
    });
    const { _policyInput, ...row } = run;
    const { error } = await admin.from("remediation_runs").insert(
      asRow<TablesInsert<"remediation_runs">>({
        ...row,
        status: decision.autoExecute ? "planned" : "awaiting_validation",
        requires_human: decision.requiresHuman,
        policy: asJson(decision),
      }),
    );
    if (error) {
      notes.push(`insert failed for ${row.action_type}: ${error.message}`);
      continue;
    }
    planned += 1;
    if (!decision.autoExecute) {
      await notifyAwaitingValidation(ticket.id, row.action_type, decision.reasons);
    }
  }

  if (planned > 0) {
    await admin.from("support_ticket_events").insert({
      ticket_id: ticket.id,
      event_type: "remediation.planned",
      payload: { runs: runs.map((r) => r.action_type), notes },
    });
  }
  return { runsPlanned: planned, notes };
}

/**
 * Find verified, still-open codex remediation PRs in the ticket's scope
 * (its clone, or prime when clone_id is null) and turn each into a
 * pr_merge run. Only findings at or below the auto-heal severity line
 * (medium ⇒ P2) qualify — critical/high stay with the two-key human gate.
 */
async function planVerifiedMergesForScope(
  cloneId: string | null,
  ticketPriority: string,
  ticketId: string | null,
): Promise<Array<Record<string, unknown>>> {
  let query = admin
    .from("codex_remediations")
    .select(
      "id, finding_id, clone_id, repo_full_name, pr_number, status, verified, verification, files_changed, lines_added, lines_removed, codex_findings!inner(severity, state)",
    )
    .eq("status", "pr_opened")
    .eq("verified", true)
    .limit(AUTO_MERGE_SCAN_BATCH);
  query = cloneId ? query.eq("clone_id", cloneId) : query.is("clone_id", null);
  const { data: candidates } = await query;

  type PlannedRun = Record<string, unknown> & {
    action_type: Database["public"]["Enums"]["remediation_action_type"];
    priority?: TicketPriority | null;
    _policyInput?: Record<string, unknown>;
  };
  const runs: PlannedRun[] = [];
  for (const rem of candidates ?? []) {
    const severity = rem.codex_findings?.severity ?? "medium";
    const findingPriority = severityToPriority(severity);
    if (!priorityAtOrBelow(findingPriority, "P2")) continue;
    const linesChanged = (rem.lines_added ?? 0) + (rem.lines_removed ?? 0);
    runs.push({
      ticket_id: ticketId,
      clone_id: rem.clone_id,
      finding_id: rem.finding_id,
      remediation_id: rem.id,
      action_type: "pr_merge",
      priority: findingPriority,
      plan: { pr_number: rem.pr_number, repo_full_name: rem.repo_full_name },
      _policyInput: {
        verified: rem.verified === true,
        secretsClean: secretsCleanFromVerification(rem.verification),
        filesChanged: rem.files_changed,
        linesChanged: rem.files_changed == null ? null : linesChanged,
      },
    });
  }
  return runs;
}

// ── Execution ────────────────────────────────────────────────────────────

async function markRun(runId: string, patch: Record<string, unknown>) {
  await admin
    .from("remediation_runs")
    .update(asRow<TablesUpdate<"remediation_runs">>(patch))
    .eq("id", runId);
}

/**
 * Say that a pass is still alive, and what it has done so far.
 *
 * `reclaimStalledRuns` reads `updated_at`, and until now a lane wrote
 * nothing between claiming a run and finishing its pass — so a pass that
 * was merely SLOW (a Management API answering in tens of seconds, a GitHub
 * read waiting out a rate limit) looked exactly like one that had died, was
 * requeued under it, and the drain started a second pass over the same
 * bundles or the same migrations while the first was still running. For
 * the deploy lane that is wasted work; for the migration lane it is two
 * replays racing for one ledger. Measured 2 Sep 2026: the deploy run was
 * "stalled" at 11:04 while it went on landing bundles until 11:28.
 *
 * Written after every item, so the reclaim's twenty minutes measure silence
 * between ITEMS — and an item that itself takes longer than that is the
 * budget's problem, not this one's. The table's trigger stamps `updated_at`
 * on any update; the progress is kept where the operator reads it.
 */
async function touchRun(run: any, progress: Record<string, unknown>) {
  await markRun(run.id, {
    result: { ...(run.result ?? {}), heartbeat_at: new Date().toISOString(), ...progress },
  });
}

async function ticketEvent(ticketId: string | null, eventType: string, payload: unknown) {
  if (!ticketId) return;
  await admin.from("support_ticket_events").insert({
    ticket_id: ticketId,
    event_type: eventType,
    payload: asJson(payload ?? {}),
  });
}

async function notifyAwaitingValidation(
  ticketId: string | null,
  actionType: string,
  reasons: string[],
) {
  await admin.from("notifications").insert({
    kind: "remediation_awaiting_validation",
    severity: "warning",
    title: `Self-healing needs validation · ${actionType.replace(/_/g, " ")}`,
    body: reasons.slice(0, 3).join("; ").slice(0, 400),
    url: "/support/tickets",
    metadata: { ticket_id: ticketId, action_type: actionType },
  });
  await ticketEvent(ticketId, "remediation.awaiting_validation", { actionType, reasons });
}

export async function executeRemediationRun(runId: string): Promise<{ status: string }> {
  const { data: run } = await admin
    .from("remediation_runs")
    .select("*")
    .eq("id", runId)
    .maybeSingle();
  if (!run) return { status: "missing" };
  if (!["planned", "approved"].includes(run.status)) return { status: run.status };

  const approvedByHuman = run.status === "approved";
  await markRun(run.id, {
    status: "executing",
    attempts: (run.attempts ?? 0) + 1,
    started_at: run.started_at ?? new Date().toISOString(),
  });

  try {
    switch (run.action_type) {
      case "pr_merge":
        return await executePrMerge(run, approvedByHuman);
      case "sql_migration":
        return await executeSqlMigration(run, approvedByHuman);
      case "edge_function_deploy":
        return await executeEdgeFunctionDeploy(run);
      case "monitor_recovery":
        return await executeMonitorRecovery(run);
      case "rescan":
        return await executeRescan(run);
      default:
        await markRun(run.id, {
          status: "awaiting_validation",
          last_error: `unknown action_type ${run.action_type}`,
        });
        return { status: "awaiting_validation" };
    }
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const exhausted = (run.attempts ?? 0) + 1 >= (run.max_attempts ?? 30);
    await markRun(run.id, {
      status: exhausted ? "failed" : "planned",
      last_error: message.slice(0, 2000),
      next_attempt_at: new Date(Date.now() + MONITOR_RETRY_MINUTES * 60_000).toISOString(),
      ...(exhausted ? { completed_at: new Date().toISOString() } : {}),
    });
    await ticketEvent(run.ticket_id, "remediation.error", {
      run_id: run.id,
      action_type: run.action_type,
      error: message,
      exhausted,
    });
    if (exhausted) {
      await admin.from("notifications").insert({
        kind: "remediation_failed",
        severity: "error",
        title: `Self-healing failed · ${run.action_type.replace(/_/g, " ")}`,
        body: message.slice(0, 400),
        clone_id: run.clone_id,
        url: "/support/tickets",
        metadata: { run_id: run.id, ticket_id: run.ticket_id },
      });
    }
    return { status: exhausted ? "failed" : "retrying" };
  }
}

/** Park a run for human validation and say why. */
async function parkRun(run: any, reasons: string[]): Promise<{ status: string }> {
  await markRun(run.id, {
    status: "awaiting_validation",
    requires_human: true,
    policy: { autoExecute: false, requiresHuman: true, reasons },
  });
  await notifyAwaitingValidation(run.ticket_id, run.action_type, reasons);
  return { status: "awaiting_validation" };
}

async function succeedRun(run: any, result: Record<string, unknown>): Promise<{ status: string }> {
  await markRun(run.id, {
    status: "succeeded",
    result,
    completed_at: new Date().toISOString(),
    last_error: null,
  });
  await ticketEvent(run.ticket_id, "remediation.succeeded", {
    run_id: run.id,
    action_type: run.action_type,
    ...result,
  });
  return { status: "succeeded" };
}

// ── Lane: pr_merge ───────────────────────────────────────────────────────

async function executePrMerge(run: any, approvedByHuman: boolean): Promise<{ status: string }> {
  const { data: rem } = await admin
    .from("codex_remediations")
    .select(
      "id, status, repo_full_name, pr_number, clone_id, finding_id, scan_job_id, verified, verification, files_changed, lines_added, lines_removed",
    )
    .eq("id", run.remediation_id)
    .maybeSingle();
  if (!rem) {
    await markRun(run.id, {
      status: "failed",
      last_error: "codex remediation row missing",
      completed_at: new Date().toISOString(),
    });
    return { status: "failed" };
  }
  if (rem.status === "merged") {
    return succeedRun(run, { already_merged: true, pr_number: rem.pr_number });
  }
  if (["closed", "rejected", "canceled", "failed"].includes(rem.status)) {
    await markRun(run.id, {
      status: "skipped",
      result: { reason: `remediation is ${rem.status}` },
      completed_at: new Date().toISOString(),
    });
    return { status: "skipped" };
  }
  if (!rem.pr_number) return parkRun(run, ["remediation has no PR yet"]);

  // Re-check the policy against live state unless a human already released it.
  if (!approvedByHuman) {
    const linesChanged = (rem.lines_added ?? 0) + (rem.lines_removed ?? 0);
    const decision = decideRemediation({
      actionType: "pr_merge",
      priority: run.priority,
      verified: rem.verified === true,
      secretsClean: secretsCleanFromVerification(rem.verification),
      filesChanged: rem.files_changed,
      linesChanged: rem.files_changed == null ? null : linesChanged,
    });
    if (!decision.autoExecute) return parkRun(run, decision.reasons);
  }

  const [owner, repo] = (rem.repo_full_name || "").split("/");
  if (!owner || !repo) return parkRun(run, ["remediation has no valid repo"]);

  let installationId: string | null = null;
  if (rem.clone_id) {
    const { loadCloneInstallationId } = await import("@/server/clone-installation.server");
    installationId = await loadCloneInstallationId(admin, rem.clone_id);
  } else {
    const { data: p } = await admin
      .from("prime_config")
      .select("github_app_installation_id")
      .limit(1)
      .maybeSingle();
    installationId = p?.github_app_installation_id ?? null;
  }

  const { mergeRemediationPRViaGitHub } = await import("@/server/codex-remediation.server");
  const merge = await mergeRemediationPRViaGitHub({
    owner,
    repo,
    prNumber: rem.pr_number,
    installationId,
    commitTitle: `Self-healing: codex remediation PR #${rem.pr_number}`,
    commitMessage: approvedByHuman
      ? "Released by an admin through the Mission Control self-healing queue."
      : "Auto-merged by Mission Control self-healing: verified patch within policy bounds.",
    method: "squash",
  });

  await admin
    .from("codex_remediations")
    .update({
      status: "merged",
      merged_at: new Date().toISOString(),
      merge_commit_sha: merge.sha,
      pr_state: "merged",
      completed_at: new Date().toISOString(),
      last_event: { auto_merged: !approvedByHuman, remediation_run_id: run.id },
    })
    .eq("id", rem.id);
  await admin
    .from("codex_findings")
    .update({ state: "fix_merged", resolved_at: new Date().toISOString() })
    .eq("id", rem.finding_id);
  if (rem.scan_job_id) {
    await admin.from("codex_scan_events").insert({
      job_id: rem.scan_job_id,
      event_type: approvedByHuman ? "remediation.merged" : "remediation.auto_merged",
      actor: approvedByHuman ? (run.approved_by ?? "system") : "system",
      payload: asJson({
        remediation_id: rem.id,
        sha: merge.sha,
        pr_number: rem.pr_number,
        run_id: run.id,
      }),
    });
  }

  // Deliberately NO automatic fleet cascade from an unattended merge — a
  // prime-scoped patch multiplying across every clone is exactly the blast
  // radius the human gate exists for. Tell the operators instead.
  if (!rem.clone_id) {
    await admin.from("notifications").insert({
      kind: "remediation_auto_completed",
      severity: "info",
      title: `Self-healed: PR #${rem.pr_number} merged on prime`,
      body: "Fleet cascade was NOT started automatically — review and cascade from /cascades if the fix should fan out.",
      url: "/cascades",
      metadata: { remediation_id: rem.id, run_id: run.id, sha: merge.sha },
    });
  }

  return succeedRun(run, { sha: merge.sha, pr_number: rem.pr_number, auto: !approvedByHuman });
}

// ── Lane: sql_migration ──────────────────────────────────────────────────

/**
 * Judge every body this pass would send, or say which could not be judged.
 *
 * Fetched a few at a time rather than one after another: the gate's cost is
 * GitHub round trips, and a sequential walk over a long backlog spent the
 * whole invocation before a single migration was applied. An unreadable body
 * — oversized, or a GitHub fault — is reported as offending rather than
 * waved through: an unread migration is not a migration judged
 * non-destructive.
 */
async function assessPendingMigrations(
  pending: ReadonlyArray<{ id: string; name: string }>,
  loadSql: (id: string) => Promise<string>,
): Promise<Array<{ migration: string; reasons: string[] }>> {
  const offending: Array<{ migration: string; reasons: string[] }> = [];
  for (let i = 0; i < pending.length; i += SQL_GATE_FETCH_CONCURRENCY) {
    const chunk = pending.slice(i, i + SQL_GATE_FETCH_CONCURRENCY);
    const judged = await Promise.all(
      chunk.map(async (m) => {
        try {
          const sql = await loadSql(m.id);
          const assessment = assessSqlDestructiveness(sql);
          return assessment.destructive
            ? { migration: m.name, reasons: assessment.findings.map((f) => f.reason) }
            : null;
        } catch (e) {
          return {
            migration: m.name,
            reasons: [e instanceof Error ? e.message : "could not be read from the prime repo"],
          };
        }
      }),
    );
    for (const j of judged) if (j) offending.push(j);
  }
  return offending;
}

async function executeSqlMigration(
  run: any,
  approvedByHuman: boolean,
): Promise<{ status: string }> {
  // Measured from lane entry, as the deploy lane measures: the corpus listing
  // and the ledger reads spend the same invocation as the replay.
  const deadlineAt = Date.now() + SQL_MIGRATION_BUDGET_MS;

  if (!run.clone_id) return parkRun(run, ["no clone scope — prime SQL is never self-applied"]);

  const { data: backend } = await admin
    .from("clone_backends")
    .select("supabase_project_ref, status")
    .eq("clone_id", run.clone_id)
    .maybeSingle();
  if (!backend?.supabase_project_ref) {
    await markRun(run.id, {
      status: "skipped",
      result: { reason: "clone has no provisioned backend" },
      completed_at: new Date().toISOString(),
    });
    return { status: "skipped" };
  }

  const { resolvePrimeSource } = await import("@/server/prime-backend.server");
  const source = await resolvePrimeSource(admin);
  if (!source) return parkRun(run, ["prime source repo is not configured"]);

  /*
    Scoped exactly as the fleet sync is scoped, through the same function.

    This lane used to take the raw repository listing and call everything the
    clone's ledger lacked "pending". On `npc-client-dashboard` that was 341
    files and 42 MB — the corpus and the prime's own ledger disagree by that
    much, which is the two-namespace problem `fleetCorpusScope.pure.ts` is
    written around — and fifty-eight of them drop policies or rewrite column
    types. The fleet sync withholds every one of them by design; this lane
    would have parked them for a human to approve as a batch, and an approval
    would have replayed rollback scripts against a tenant. A migration the
    prime has not run is not one a clone is behind on.

    A scope that could not be built THROWS rather than parks: a ledger that
    could not be read is a transient fault worth retrying, not a decision a
    person has to take.
  */
  const { openScopedPrimeCorpus } = await import("@/server/fleet-migration.server");
  const scoped = await openScopedPrimeCorpus(admin, source);
  if (!scoped.ok) throw new Error(scoped.error);
  const { corpus, runnable } = scoped;
  const runnableIds = new Set(runnable.map((m) => m.id));

  const { runSqlOnProject, applyPrimeMigrations } =
    await import("@/server/backend-provisioning.server");
  const { partitionByDependency } = await import("@/server/fleetCorpusScope.pure");

  // Which versions has the clone already applied? Same union the apply
  // helper uses; a fresh tracking table simply means "none yet".
  let applied = new Set<string>();
  try {
    const rows = (await runSqlOnProject(
      backend.supabase_project_ref,
      `SELECT version FROM supabase_migrations.schema_migrations
       UNION SELECT version FROM aurixa.schema_migrations`,
    )) as Array<{ version: string }>;
    applied = new Set((rows ?? []).map((r) => r.version));
  } catch {
    // Tracking tables may not exist yet — applyPrimeMigrations creates them.
  }

  // What will actually be SENT: runnable, absent from the clone, and not
  // sitting behind a hole. The gate below judges exactly this set — judging
  // an orphan the replay will skip anyway is a body fetched for nothing.
  const { send: pending, orphaned } = partitionByDependency(corpus.metas, runnableIds, applied);
  if (pending.length === 0) {
    return succeedRun(run, {
      pending: 0,
      withheld: scoped.withheld,
      held_back: orphaned.length,
      source_sha: scoped.sourceSha,
      note: "clone already at prime migration head within the fleet sync's scope",
    });
  }

  // The gate: every pending statement must be non-destructive, or the whole
  // batch parks. Applying "just the safe ones" would run migrations out of
  // order, which is worse than not applying any.
  if (!approvedByHuman) {
    const offending = await assessPendingMigrations(pending, corpus.loadSql);
    if (offending.length > 0) {
      return parkRun(
        run,
        offending.slice(0, 5).map((o) => `${o.migration}: ${o.reasons.slice(0, 3).join(", ")}`),
      );
    }
  }

  const { results, latestApplied, stoppedEarly } = await applyPrimeMigrations(
    backend.supabase_project_ref,
    runnable,
    // Alive, and which migration it is on — see `touchRun`.
    async (_status, detail) => touchRun(run, { in_flight: detail }),
    (m) => corpus.loadSql(m.id),
    // `runnable` alone cannot say whether a cleared version sits behind a
    // withheld one. The whole corpus can.
    { corpus: corpus.metas, runnableIds },
    { isPastDeadline: (reserveMs) => Date.now() + reserveMs >= deadlineAt },
  );
  const failed = (results ?? []).filter((r) => !r.success);
  if (failed.length > 0) {
    throw new Error(
      `migration ${failed[0].id ?? failed[0].name ?? "?"} failed: ${failed[0].error ?? "unknown"}`,
    );
  }
  const landed = (results ?? []).filter((r) => r.success && !r.skipped).length;
  const heldBack = (results ?? []).filter((r) => r.blockedBy && r.blockedBy.length > 0).length;

  // Whether a pass that stopped at the budget is charged for its invocation
  // is the same decision the deploy lane makes, taken by the same module:
  // a pass that landed something is attempt-neutral, one that landed nothing
  // counts, and a run that keeps counting eventually parks.
  const attempts = run.attempts ?? 1;
  const resume = planEdgeDeployResume({
    landed,
    moreRemain: stoppedEarly,
    stoppedEarly,
    attempts,
    maxAttempts: run.max_attempts ?? 30,
  });

  if (resume.kind === "park") {
    return parkRun(run, [
      `${landed} migration(s) applied this pass over ${attempts} passes and more remain`,
    ]);
  }

  if (resume.kind === "requeue") {
    await markRun(run.id, {
      status: "planned",
      // `run.attempts` is the count from BEFORE `executeRemediationRun`
      // incremented it, so writing it back undoes exactly this pass's
      // increment — never a reset.
      ...(resume.attemptNeutral ? { attempts: run.attempts ?? 0 } : {}),
      next_attempt_at: new Date().toISOString(),
      result: {
        resuming: true,
        applied_this_pass: landed,
        latest_applied: latestApplied ?? null,
        paused_at_budget: stoppedEarly,
        held_back: heldBack,
        source_sha: scoped.sourceSha,
      },
    });
    return { status: "resuming" };
  }

  return succeedRun(run, {
    applied: landed,
    latest_applied: latestApplied ?? null,
    held_back: heldBack,
    withheld: scoped.withheld,
    source_sha: scoped.sourceSha,
  });
}

/**
 * Deploy a batch, stopping at the invocation budget rather than being killed
 * by it.
 *
 * The stopping rule — one function at a time, the first always attempted,
 * partial results kept — is `runWithinBudget`, where it can be held to those
 * properties by a test. This supplies the real deploy and the real clock and
 * nothing else.
 */
async function deployWithinBudget(
  run: any,
  projectRef: string,
  batch: readonly EdgeFunctionBundle[],
  deadlineAt: number,
): Promise<{ results: EdgeFunctionDeployResult[]; stoppedEarly: boolean }> {
  const { deployEdgeFunctions } = await import("@/server/backend-provisioning.server");
  let done = 0;
  return runWithinBudget<EdgeFunctionBundle, EdgeFunctionDeployResult>({
    items: batch,
    runOne: async (fn) => {
      const out = (await deployEdgeFunctions(projectRef, [fn])) ?? [];
      done += 1;
      // Alive, and this far through the batch — see `touchRun`.
      await touchRun(run, { in_flight: { done, of: batch.length, last: fn.slug } });
      return out;
    },
    // Reserve the slowest deploy seen this pass: an item begun with less than
    // that left is one the invocation may not live to finish.
    isPastDeadline: (reserveMs) => Date.now() + reserveMs >= deadlineAt,
  });
}

// ── Lane: edge_function_deploy ───────────────────────────────────────────

async function executeEdgeFunctionDeploy(run: any): Promise<{ status: string }> {
  // Measured from lane entry, not from the first deploy: a slow snapshot read
  // spends the same invocation, so budgeting only the deploy loop would let
  // one pass overrun the ceiling it exists to respect.
  const deadlineAt = Date.now() + EDGE_DEPLOY_BUDGET_MS;

  if (!run.clone_id)
    return parkRun(run, ["no clone scope — prime functions are not self-deployed"]);

  const { data: backend } = await admin
    .from("clone_backends")
    .select("supabase_project_ref")
    .eq("clone_id", run.clone_id)
    .maybeSingle();
  if (!backend?.supabase_project_ref) {
    await markRun(run.id, {
      status: "skipped",
      result: { reason: "clone has no provisioned backend" },
      completed_at: new Date().toISOString(),
    });
    return { status: "skipped" };
  }

  const { resolvePrimeSource, fetchPrimeBackendSnapshot } =
    await import("@/server/prime-backend.server");
  const { getAppOctokit } = await import("@/server/github-app.server");
  const source = await resolvePrimeSource(admin);
  if (!source) return parkRun(run, ["prime source repo is not configured"]);

  const wanted: string[] | null = run.plan?.slugs ?? null;

  // What THIS run has already put on the clone — asked of the TARGET, never
  // of a diary the run keeps about itself. A pass that deployed sixty
  // bundles and then lost its invocation still counts, which is the whole
  // point: the state that has to survive is on the clone, not in a `result`
  // column the dying pass never got to write.
  const { listProjectEdgeFunctionFreshness } = await import("@/server/backend-provisioning.server");
  const freshness = await listProjectEdgeFunctionFreshness(backend.supabase_project_ref);
  const refreshed = refreshedSince(freshness, run.started_at);

  // This lane redeploys FUNCTION bundles; migration SQL bodies are half the
  // snapshot's round trips and nothing here reads them.
  //
  // `functionLimit` is applied only where this run owes the WHOLE fleet.
  // Against a named list it measures truncation over the UNFILTERED set, so
  // a pass could fetch sixty bundles containing none of the wanted ones and
  // then read its own empty batch as "nothing left to do" — succeeding on a
  // deployment it never performed. A named list is bounded by the cascade
  // that produced it and is sliced here instead.
  const snapshot = await fetchPrimeBackendSnapshot(getAppOctokit(), source, {
    includeMigrationSql: false,
    skipFunctionSlugs: refreshed,
    ...(wanted === null ? { functionLimit: EDGE_DEPLOY_BATCH } : {}),
  });

  const fetched = snapshot.functions ?? [];
  const pass = planEdgeDeployPass({
    wanted,
    fetched: fetched.map((fn) => fn.slug),
    truncated: snapshot.functionSourceTruncated,
    batchLimit: EDGE_DEPLOY_BATCH,
  });
  const chosen = new Set(pass.batch);
  const batch = fetched.filter((fn) => chosen.has(fn.slug));

  if (batch.length === 0) {
    return succeedRun(run, {
      deployed: refreshed.length,
      note:
        refreshed.length > 0
          ? "every bundle this run owed is on the clone"
          : "no function bundles to deploy",
      source_sha: snapshot.sourceSha ?? null,
    });
  }

  const { results, stoppedEarly } = await deployWithinBudget(
    run,
    backend.supabase_project_ref,
    batch,
    deadlineAt,
  );
  const failures = (results ?? []).filter((r) => r.error);
  if (failures.length === (results ?? []).length && failures.length > 0) {
    throw new Error(`all ${failures.length} function deploys failed: ${failures[0].error}`);
  }
  const landed = countLanded(results ?? []);
  const failedDetail = failures.map((f) => ({
    slug: f.slug,
    error: String(f.error).slice(0, 200),
  }));

  // More to come? Hand the run back to the queue rather than pronouncing a
  // partial deployment complete — the rule `functionSourceTruncated` is
  // documented for, and the shape `monitor_recovery` already uses.
  //
  // `stoppedEarly` is the other way there is more to come: the batch was not
  // finished because the invocation budget ran out. Those bundles never
  // became `refreshed`, so the next pass's snapshot asks for them again.
  //
  // Whether this pass is charged for the invocation it took is the pure
  // module's call — see `planEdgeDeployResume` for why it fails in both
  // directions and what makes the attempt-neutral case terminate.
  const attempts = run.attempts ?? 1;
  const resume = planEdgeDeployResume({
    landed,
    moreRemain: pass.moreRemain,
    stoppedEarly,
    attempts,
    maxAttempts: run.max_attempts ?? 30,
  });

  if (resume.kind === "park") {
    return parkRun(run, [
      `${refreshed.length + landed} bundle(s) deployed over ${attempts} passes and more remain`,
      ...(failedDetail.length > 0
        ? [`last pass could not deploy ${failedDetail[0].slug}: ${failedDetail[0].error}`]
        : []),
    ]);
  }

  if (resume.kind === "requeue") {
    await markRun(run.id, {
      status: "planned",
      // `run.attempts` is the count from BEFORE `executeRemediationRun`
      // incremented it, so writing it back undoes exactly this pass's
      // increment — never a reset, so a genuine earlier failure still counts.
      ...(resume.attemptNeutral ? { attempts: run.attempts ?? 0 } : {}),
      // Due now: the drain runs every two minutes and has already chosen
      // this pass's batch, so it is the NEXT pass that picks this up.
      next_attempt_at: new Date().toISOString(),
      result: {
        resuming: true,
        deployed: refreshed.length + landed,
        last_batch: landed,
        paused_at_budget: stoppedEarly,
        failed: failedDetail,
        source_sha: snapshot.sourceSha ?? null,
      },
    });
    return { status: "resuming" };
  }

  return succeedRun(run, {
    deployed: refreshed.length + landed,
    failed: failedDetail,
    source_sha: snapshot.sourceSha ?? null,
  });
}

// ── Lane: monitor_recovery ───────────────────────────────────────────────

async function executeMonitorRecovery(run: any): Promise<{ status: string }> {
  if (!run.clone_id) {
    // Nothing to observe. Blind auto-resolution would be lying to the
    // reporter, so this is one of the human edge cases.
    return parkRun(run, ["no health telemetry for this workspace — confirm recovery manually"]);
  }

  const since = new Date(Date.now() - MONITOR_HEALTHY_WITHIN_MINUTES * 60_000).toISOString();
  const { data: beacon } = await admin
    .from("clone_health_beacons")
    .select("severity, reported_at")
    .eq("clone_id", run.clone_id)
    .gte("reported_at", since)
    .order("reported_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (beacon && beacon.severity === "ok") {
    return succeedRun(run, { recovered_at: beacon.reported_at, beacon_severity: beacon.severity });
  }

  const attempts = run.attempts ?? 1;
  if (attempts >= (run.max_attempts ?? 30)) {
    return parkRun(run, [`no healthy beacon after ${attempts} checks — recovery needs a human`]);
  }

  // Not recovered yet: put the run back on the queue for the next pass.
  await markRun(run.id, {
    status: "planned",
    next_attempt_at: new Date(Date.now() + MONITOR_RETRY_MINUTES * 60_000).toISOString(),
    result: {
      waiting: true,
      last_beacon_severity: beacon?.severity ?? "none",
      checks: attempts,
    },
  });
  return { status: "waiting" };
}

// ── Lane: rescan ─────────────────────────────────────────────────────────

async function executeRescan(run: any): Promise<{ status: string }> {
  const { enqueueScanNoAuth } = await import("@/server/codex-scheduling.server");

  // owner/repo only — naming the generated `repo_full_name` column here
  // would fail the whole select on an unmigrated deployment (same trap the
  // nightly fan-out documents).
  let repoFullName = "";
  let ref: string | null = null;
  if (run.clone_id) {
    const { data: clone } = await admin
      .from("clones")
      .select("github_owner, github_repo, default_branch")
      .eq("id", run.clone_id)
      .maybeSingle();
    if (clone?.github_owner && clone?.github_repo) {
      repoFullName = `${clone.github_owner}/${clone.github_repo}`;
      ref = clone.default_branch || "main";
    }
  } else {
    const { data: prime } = await admin
      .from("prime_config")
      .select("github_owner, github_repo, default_branch")
      .limit(1)
      .maybeSingle();
    if (prime?.github_owner && prime?.github_repo) {
      repoFullName = `${prime.github_owner}/${prime.github_repo}`;
      ref = prime.default_branch || "main";
    }
  }
  if (!repoFullName) {
    return parkRun(run, ["no scannable repo for this scope"]);
  }

  const result = await enqueueScanNoAuth({
    kind: "manual",
    targetKind: run.clone_id ? "clone" : "prime",
    cloneId: run.clone_id ?? null,
    repoFullName,
    ref,
    requestPayload: { source: "self_healing", ticket_id: run.ticket_id, run_id: run.id },
    dedupWindowHours: 1,
  });

  if (result.skipped) {
    // A recent identical scan already ran — that evidence is as good as ours.
    return succeedRun(run, { scan: "skipped", reason: result.reason });
  }
  return succeedRun(run, { scan_job_id: result.jobId });
}

// ── The drain ────────────────────────────────────────────────────────────

export type SweepResult = {
  executed: Array<{ runId: string; action: string; status: string }>;
  ticketsRolledUp: number;
  slaEscalations: number;
  scanMergesPlanned: number;
  /** Runs whose invocation died mid-flight and were put back on the queue. */
  runsReclaimed: number;
};

/**
 * Put back on the queue any run whose invocation died while it held the row.
 *
 * `executeRemediationRun` accepts only `planned` and `approved`. A row left
 * in `executing` is therefore on no work list and read by no lane — it is
 * stuck for ever, and it reads as progress while it is stuck, which is worse
 * than reading as nothing. Measured 2 Sep 2026: the first live
 * `edge_function_deploy` run sat in `executing` with zero bundles deployed
 * and no error, and nothing in the engine could ever have moved it.
 *
 * Reclaiming is safe because every lane is idempotent by construction — a
 * redeploy overwrites, a merge is a no-op on an already-merged pull request,
 * a migration replay re-checks what is pending, a rescan re-enqueues. What
 * is NOT safe is retrying without end, so a run past its attempt budget goes
 * to a human instead of back to the queue.
 *
 * ## Why `updated_at` and not `started_at`
 *
 * `started_at` is the moment the run FIRST executed and is deliberately kept
 * across passes — `edge_function_deploy` measures "what have I already
 * deployed" from it. A resumable run therefore carries a `started_at` older
 * than this threshold long before anything is wrong, and reclaiming on that
 * would seize a run in the middle of a legitimate pass: two passes would then
 * execute the same row at once and burn its attempt budget racing itself.
 *
 * `updated_at` is trigger-maintained on every write, so it is the moment THIS
 * pass claimed the row. That is the clock a stall is measured on.
 */
async function reclaimStalledRuns(): Promise<number> {
  const stalledBefore = new Date(Date.now() - RUN_STALL_MINUTES * 60_000).toISOString();
  const { data: stalled } = await admin
    .from("remediation_runs")
    .select("id, attempts, max_attempts, action_type, ticket_id")
    .eq("status", "executing")
    .lt("updated_at", stalledBefore)
    .order("updated_at", { ascending: true })
    .limit(DRAIN_BATCH);

  let reclaimed = 0;
  for (const row of stalled ?? []) {
    const reasons = [
      `run stalled in "executing" for over ${RUN_STALL_MINUTES} minutes — its pass did not finish`,
    ];
    if ((row.attempts ?? 0) >= (row.max_attempts ?? 30)) {
      await markRun(row.id, {
        status: "awaiting_validation",
        requires_human: true,
        policy: { autoExecute: false, requiresHuman: true, reasons },
        last_error: `stalled after ${row.attempts ?? 0} attempt(s)`,
      });
      await notifyAwaitingValidation(row.ticket_id, row.action_type, reasons);
    } else {
      await markRun(row.id, {
        status: "planned",
        next_attempt_at: new Date().toISOString(),
        last_error: reasons[0],
      });
    }
    reclaimed += 1;
  }
  return reclaimed;
}

/**
 * One pass of the self-healing drain (pg_cron, every 2 minutes):
 *   0. Reclaim runs a dead invocation left stuck in `executing`.
 *   1. Execute due runs (planned/approved, next_attempt_at reached).
 *   2. Plan auto-merge runs for freshly verified scan remediations, so the
 *      security pipeline self-heals even without a ticket.
 *   3. Roll ticket statuses up from their runs' states.
 *   4. Escalate tickets that breached their SLA.
 *   5. Prune the ingest rate-limit ledger.
 */
export async function sweepSupportRemediations(): Promise<SweepResult> {
  const executed: SweepResult["executed"] = [];

  // 0. Reclaim runs a dead invocation left holding the row. Before step 1,
  //    so a reclaimed run is due on this pass rather than the next one.
  const runsReclaimed = await reclaimStalledRuns();

  // 1. Execute due runs, oldest first, bounded per pass.
  const { data: dueRuns } = await admin
    .from("remediation_runs")
    .select("id, action_type")
    .in("status", ["planned", "approved"])
    .lte("next_attempt_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(DRAIN_BATCH);
  for (const due of dueRuns ?? []) {
    const outcome = await executeRemediationRun(due.id);
    executed.push({ runId: due.id, action: due.action_type, status: outcome.status });
  }

  // 2. Ticket-less self-healing for the scan pipeline: any verified,
  //    still-open remediation PR at P2-or-below severity gets a pr_merge
  //    run (deduped on remediation_id).
  const scanMergesPlanned = await planScanAutoMerges();

  // 3. Roll ticket statuses up.
  const ticketsRolledUp = await rollUpTicketStatuses();

  // 4. SLA escalations.
  const slaEscalations = await escalateSlaBreaches();

  // 5. Ledger pruning.
  await admin
    .from("support_ingest_requests")
    .delete()
    .lt(
      "created_at",
      new Date(Date.now() - INGEST_LEDGER_RETENTION_DAYS * 24 * 60 * 60_000).toISOString(),
    );

  return { executed, ticketsRolledUp, slaEscalations, scanMergesPlanned, runsReclaimed };
}

async function planScanAutoMerges(): Promise<number> {
  const { data: candidates } = await admin
    .from("codex_remediations")
    .select(
      "id, finding_id, clone_id, repo_full_name, pr_number, verified, verification, files_changed, lines_added, lines_removed, codex_findings!inner(severity)",
    )
    .eq("status", "pr_opened")
    .eq("verified", true)
    .limit(AUTO_MERGE_SCAN_BATCH * 2);

  let planned = 0;
  for (const rem of candidates ?? []) {
    const priority = severityToPriority(rem.codex_findings?.severity ?? "medium");
    if (!priorityAtOrBelow(priority, "P2")) continue;

    const { count: existing } = await admin
      .from("remediation_runs")
      .select("id", { count: "exact", head: true })
      .eq("remediation_id", rem.id);
    if ((existing ?? 0) > 0) continue;

    const linesChanged = (rem.lines_added ?? 0) + (rem.lines_removed ?? 0);
    const decision = decideRemediation({
      actionType: "pr_merge",
      priority,
      verified: rem.verified === true,
      secretsClean: secretsCleanFromVerification(rem.verification),
      filesChanged: rem.files_changed,
      linesChanged: rem.files_changed == null ? null : linesChanged,
    });

    const { error } = await admin.from("remediation_runs").insert({
      ticket_id: null,
      finding_id: rem.finding_id,
      remediation_id: rem.id,
      clone_id: rem.clone_id,
      action_type: "pr_merge",
      priority,
      status: decision.autoExecute ? "planned" : "awaiting_validation",
      requires_human: decision.requiresHuman,
      policy: decision,
      plan: {
        pr_number: rem.pr_number,
        repo_full_name: rem.repo_full_name,
        source: "scan_pipeline",
      },
    });
    if (!error) {
      planned += 1;
      if (!decision.autoExecute) {
        await notifyAwaitingValidation(null, "pr_merge", decision.reasons);
      }
    }
  }
  return planned;
}

async function rollUpTicketStatuses(): Promise<number> {
  const { data: tickets } = await admin
    .from("support_tickets")
    .select("id, status, reference, priority, clone_id")
    .in("status", ["remediating", "awaiting_validation"])
    // Oldest first, so a backlog above the cap drains instead of starving.
    .order("updated_at", { ascending: true })
    .limit(TICKET_ROLLUP_BATCH);

  let changed = 0;
  for (const ticket of tickets ?? []) {
    const { data: runs } = await admin
      .from("remediation_runs")
      .select("status")
      .eq("ticket_id", ticket.id);
    if (!runs || runs.length === 0) continue;

    const statuses = runs.map((r: any) => r.status);
    const anyAwaiting = statuses.includes("awaiting_validation");
    const anyActive = statuses.some((s: string) =>
      ["planned", "approved", "executing"].includes(s),
    );
    const anyFailed = statuses.includes("failed");
    const anySucceeded = statuses.includes("succeeded");

    let next: string | null = null;
    if (anyAwaiting && ticket.status !== "awaiting_validation") next = "awaiting_validation";
    else if (!anyAwaiting && !anyActive) {
      if (anySucceeded && !anyFailed) next = "remediated";
      else if (anyFailed) next = "failed";
    }
    if (!next || next === ticket.status) continue;

    const patch: Record<string, unknown> = { status: next };
    if (next === "remediated") patch.resolved_at = new Date().toISOString();
    await admin
      .from("support_tickets")
      .update(asRow<TablesUpdate<"support_tickets">>(patch))
      .eq("id", ticket.id);
    await ticketEvent(ticket.id, "ticket.status_changed", { from: ticket.status, to: next });
    changed += 1;

    if (next === "remediated") {
      await admin.from("notifications").insert({
        kind: "remediation_auto_completed",
        severity: "success",
        title: `Self-healed · ${ticket.reference}`,
        body: `All remediation runs for ${ticket.reference} completed.`,
        clone_id: ticket.clone_id,
        url: "/support/tickets",
        metadata: { ticket_id: ticket.id },
      });
    } else if (next === "failed") {
      await admin.from("notifications").insert({
        kind: "remediation_failed",
        severity: "error",
        title: `Self-healing failed · ${ticket.reference}`,
        body: "Remediation runs exhausted their attempts. The ticket needs a person.",
        clone_id: ticket.clone_id,
        url: "/support/tickets",
        metadata: { ticket_id: ticket.id },
      });
    }
  }
  return changed;
}

async function escalateSlaBreaches(): Promise<number> {
  const { data: breached } = await admin
    .from("support_tickets")
    .select("id, reference, priority, sla_due_at")
    .is("sla_breached_at", null)
    .is("resolved_at", null)
    .not("sla_due_at", "is", null)
    .lt("sla_due_at", new Date().toISOString())
    .not("status", "in", "(resolved,closed)")
    // Longest-breached first. Unordered, the ticket that has been in breach
    // longest is exactly as likely to be skipped as one that just tipped over.
    .order("sla_due_at", { ascending: true })
    .limit(SLA_ESCALATION_BATCH);

  for (const ticket of breached ?? []) {
    await admin
      .from("support_tickets")
      .update({ sla_breached_at: new Date().toISOString() })
      .eq("id", ticket.id);
    await ticketEvent(ticket.id, "ticket.sla_breached", {
      sla_due_at: ticket.sla_due_at,
      priority: ticket.priority,
    });
    await admin.from("notifications").insert({
      kind: "support_ticket_escalated",
      severity: ticket.priority === "P0" || ticket.priority === "P1" ? "error" : "warning",
      title: `SLA breached · ${ticket.reference} (${ticket.priority})`,
      body: `Due ${ticket.sla_due_at}; still unresolved.`,
      url: "/support/tickets",
      metadata: { ticket_id: ticket.id },
    });
  }
  return (breached ?? []).length;
}
