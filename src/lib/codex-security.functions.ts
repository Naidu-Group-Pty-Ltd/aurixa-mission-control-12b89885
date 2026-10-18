import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// The nightly cron expression is NOT here: it is changed through
// setNightlySchedule, which reschedules the pg_cron job too. Saving it as a
// plain column used to look like it changed the fire time and changed nothing.
const SchedulingInput = z.object({
  codex_nightly_enabled: z.boolean().optional(),
  codex_pr_scan_enabled: z.boolean().optional(),
  codex_post_merge_revalidate: z.boolean().optional(),
  codex_scan_dedup_hours: z.number().int().min(0).max(168).optional(),
  // Since 20261018090000.
  codex_deep_scan_scope: z.enum(["off", "prime", "fleet"]).optional(),
  codex_pr_check_enabled: z.boolean().optional(),
  codex_pr_check_fail_on: z.enum(["critical", "high", "medium", "low", "never"]).optional(),
  codex_auto_merge_ceiling: z.enum(["off", "info", "low", "medium"]).optional(),
  codex_cascade_gate: z.enum(["off", "critical", "high"]).optional(),
});

const SCHEDULING_KEYS = [
  "id",
  "codex_nightly_enabled",
  "codex_nightly_cron",
  "codex_pr_scan_enabled",
  "codex_post_merge_revalidate",
  "codex_scan_dedup_hours",
  "codex_deep_scan_scope",
  "codex_pr_check_enabled",
  "codex_pr_check_fail_on",
  "codex_auto_merge_ceiling",
  "codex_cascade_gate",
] as const;

export const getSchedulingConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // `*` rather than a column list: on a deployment that has not applied
    // 20261018090000 the newer settings are simply absent, not an error.
    const { data, error } = await context.supabase
      .from("prime_config")
      .select("*")
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { config: null, migrated: false };
    const row = data as Record<string, unknown>;
    const config = Object.fromEntries(SCHEDULING_KEYS.map((k) => [k, row[k] ?? null])) as Record<
      (typeof SCHEDULING_KEYS)[number],
      any
    >;
    return { config, migrated: "codex_cascade_gate" in row };
  });

export const updateSchedulingConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => SchedulingInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { data: existing } = await supabase
      .from("prime_config")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!existing) throw new Error("prime_config not initialized");
    const { error } = await supabase.from("prime_config").update(data).eq("id", existing.id);
    if (error) {
      if (error.code === "42703") {
        throw new Error(
          "This setting needs migration 20261018090000_codex_findings_canonical — apply it, then try again.",
        );
      }
      throw error;
    }
    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "codex_settings.updated",
      entityType: "prime_config",
      entityId: existing.id,
      actorUserId: userId,
      metadata: data,
    });
    return { ok: true };
  });

/**
 * Change when the nightly scan fires. Reschedules the pg_cron job itself
 * (codex_set_nightly_schedule) and records the expression; the old save wrote
 * the column only, so the page showed a schedule that was not the one running.
 */
export const setNightlySchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ cron: z.string().min(9).max(64) }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { data: result, error } = await supabase.rpc("codex_set_nightly_schedule", {
      p_cron: data.cron.trim(),
    });
    if (error) {
      if (error.code === "PGRST202") {
        throw new Error(
          "Rescheduling needs migration 20261018090000_codex_findings_canonical — apply it, then try again.",
        );
      }
      throw new Error(error.message);
    }
    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "codex_settings.nightly_schedule",
      entityType: "prime_config",
      actorUserId: userId,
      metadata: { cron: data.cron.trim(), result: result as any },
    });
    return result as { ok: boolean; applied: boolean; schedule: string; reason?: string };
  });

/**
 * Scan every clone now, from the server. The button used to loop over the
 * fleet in the operator's browser: closing the tab stopped the loop wherever
 * it had got to, and each clone cost a round trip from the browser.
 */
export const runFleetScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    // Every dispatch spends the App installation's hourly window; a fleet
    // pass is the biggest single spend this page can start.
    const { decideSpend } = await import("@/server/cascade/githubBudget.pure");
    const { readGitHubRemaining } = await import("@/server/githubAllowance.server");
    const spend = decideSpend({ role: "scan", remaining: await readGitHubRemaining() });
    if (!spend.proceed)
      throw new Error(`Not now: ${spend.why}. Try again after the window resets.`);
    const { runFleetScanNow } = await import("@/server/codex-scheduling.server");
    const result = await runFleetScanNow(userId);
    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "codex_scan.fleet_requested",
      entityType: "codex_scan_job",
      actorUserId: userId,
      metadata: { queued: result.queued, skipped: result.skipped.length },
    });
    return result;
  });

/**
 * Rotate the scan signing master. Jobs already running keep reporting under
 * the previous master for its grace window; new jobs are keyed from the new
 * one. Only meaningful when the master lives on the `codex` intake source —
 * an environment-variable master is rotated where it is configured.
 */
export const rotateScanSigningKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { rotateScanMasterSecret, ROTATION_GRACE_HOURS } =
      await import("@/server/codex-callback-keys.server");
    const result = await rotateScanMasterSecret();
    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: "codex_signing_key.rotated",
      entityType: "security_intake_source",
      actorUserId: userId,
      metadata: { ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) },
    });
    if (!result.ok) throw new Error(result.reason);
    return { ok: true, rotatedAt: result.rotatedAt, graceHours: ROTATION_GRACE_HOURS };
  });

export const runNightlyNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("is_admin", { _user_id: context.userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { runNightlyScans } = await import("@/server/codex-scheduling.server");
    return await runNightlyScans();
  });

const EnqueueInput = z.object({
  kind: z
    .enum(["manual", "nightly_full", "pr_open", "targeted_path", "post_merge_revalidate"])
    .default("manual"),
  targetKind: z.enum(["prime", "clone"]).default("prime"),
  cloneId: z.string().uuid().optional(),
  repoFullName: z.string().optional(),
  ref: z.string().optional(),
  pathGlobs: z.array(z.string()).optional(),
});

/**
 * Queue a scan as an authenticated admin.
 *
 * The insert-and-dispatch mechanics live in `enqueueScanNoAuth` so there is
 * exactly one implementation; this fn only adds the auth gate and repo
 * resolution. (The two used to be separate copies and had already drifted —
 * only one of them recorded dispatch failures.)
 */
export const enqueueScan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => EnqueueInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Admin-only gate (RLS also enforces, but fail fast).
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    let repoFullName = data.repoFullName || "";
    if (!repoFullName) {
      if (data.targetKind === "prime") {
        const { data: p } = await supabase
          .from("prime_config")
          .select("github_owner, github_repo")
          .limit(1)
          .maybeSingle();
        if (!p) throw new Error("prime_config not set");
        repoFullName = `${p.github_owner}/${p.github_repo}`;
      } else {
        if (!data.cloneId) throw new Error("cloneId required for clone scans");
        const { data: c } = await supabase
          .from("clones")
          .select("github_owner, github_repo")
          .eq("id", data.cloneId)
          .maybeSingle();
        if (!c) throw new Error("clone not found");
        repoFullName = `${c.github_owner}/${c.github_repo}`;
      }
    }

    const { enqueueScanNoAuth } = await import("@/server/codex-scheduling.server");
    const result = await enqueueScanNoAuth({
      kind: data.kind,
      targetKind: data.targetKind,
      cloneId: data.cloneId ?? null,
      repoFullName,
      ref: data.ref ?? null,
      pathGlobs: data.pathGlobs ?? null,
      requestedBy: userId,
      // Manual scans are explicit operator intent — never dedup them away.
      dedupWindowHours: 0,
      requestPayload: { source: "manual", requestedBy: userId },
    });

    if (result.skipped) throw new Error(result.reason);
    return {
      jobId: result.jobId,
      engine: result.engine,
      dispatchError: result.dispatchError ?? null,
    };
  });

export const listScanJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("codex_scan_jobs")
      .select(
        "id, kind, target_kind, clone_id, repo_full_name, ref, status, failure_count, last_error, started_at, completed_at, created_at, result_summary",
      )
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return { jobs: data ?? [] };
  });

const JobIdInput = z.object({ jobId: z.string().uuid() });

/**
 * One scan: the job, what it found, and its event log.
 *
 * "What it found" is every finding this scan OBSERVED. Findings are one record
 * per issue now, so `scan_job_id` names only the scan that first reported
 * one; reading by it showed a re-scan as having found nothing new — or
 * nothing at all.
 */
export const getScanDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => JobIdInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const [job, observed, events] = await Promise.all([
      supabase.from("codex_scan_jobs").select("*").eq("id", data.jobId).maybeSingle(),
      supabase
        .from("codex_finding_observations")
        .select("finding_id")
        .eq("job_id", data.jobId)
        .limit(2000),
      supabase
        .from("codex_scan_events")
        .select("*")
        .eq("job_id", data.jobId)
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
    if (job.error) throw job.error;
    if (events.error) throw events.error;

    let findings: any[] = [];
    let source: "observations" | "first_reported" = "observations";
    if (observed.error) {
      // Before 20261018090000 there are no observations to read.
      source = "first_reported";
      const res = await supabase
        .from("codex_findings")
        .select("*")
        .eq("scan_job_id", data.jobId)
        .order("severity", { ascending: true })
        .order("created_at", { ascending: false });
      if (res.error) throw res.error;
      findings = res.data ?? [];
    } else {
      const ids = (observed.data ?? []).map((o) => o.finding_id);
      for (let i = 0; i < ids.length; i += 200) {
        const res = await supabase
          .from("codex_findings")
          .select("*")
          .in("id", ids.slice(i, i + 200))
          .order("severity", { ascending: true });
        if (res.error) throw res.error;
        findings.push(...(res.data ?? []));
      }
      const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
    }
    return { job: job.data, findings, events: events.data ?? [], source };
  });

// -------- Phase 5: fleet views + per-clone controls --------

/**
 * Fleet overview, aggregated in Postgres.
 *
 * This used to pull the last 500 clone scan jobs and *every* open finding
 * across the fleet into the server function on each 30s poll, then group
 * them in JavaScript. `codex_fleet_overview()` does the DISTINCT ON and the
 * severity roll-up in one indexed query and returns one row per clone.
 */
/**
 * Pre-RPC aggregation, kept only as a rollout fallback for deployments that
 * have not applied the migration yet. Slower by design — it groups in JS.
 */
async function legacyFleetOverview(supabase: any) {
  const [clonesRes, jobsRes, findingsRes] = await Promise.all([
    supabase
      .from("clones")
      .select("id, name, slug, github_owner, github_repo, codex_nightly_enabled, sync_status")
      .order("name", { ascending: true }),
    supabase
      .from("codex_scan_jobs")
      .select("id, clone_id, status, kind, started_at, completed_at, created_at, result_summary")
      .eq("target_kind", "clone")
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("codex_findings").select("clone_id, severity").eq("state", "open"),
  ]);
  if (clonesRes.error) throw clonesRes.error;

  const lastByClone = new Map();
  for (const j of jobsRes.data ?? []) {
    if (j.clone_id && !lastByClone.has(j.clone_id)) lastByClone.set(j.clone_id, j);
  }
  const countsByClone = new Map();
  for (const f of findingsRes.data ?? []) {
    if (!f.clone_id) continue;
    const bucket = countsByClone.get(f.clone_id) ?? {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    bucket[f.severity] = (bucket[f.severity] ?? 0) + 1;
    countsByClone.set(f.clone_id, bucket);
  }

  const clones = (clonesRes.data ?? []).map((c: any) => ({
    ...c,
    repo_full_name: `${c.github_owner}/${c.github_repo}`,
    lastScan: lastByClone.get(c.id) ?? null,
    openFindings: countsByClone.get(c.id) ?? {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    },
  }));

  return { clones };
}

export const listCloneCodexOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("codex_fleet_overview");

    // PGRST202 = the function does not exist, i.e. this deployment has not
    // applied 20260727140000 yet. Fall back to the pre-RPC aggregation so the
    // fleet panel keeps working instead of erroring out mid-rollout.
    if (error) {
      if (error.code === "PGRST202") {
        return legacyFleetOverview(context.supabase);
      }
      throw error;
    }

    const clones = (data ?? []).map((row: any) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      repo_full_name: row.repo_full_name,
      github_owner: row.github_owner,
      github_repo: row.github_repo,
      codex_nightly_enabled: row.codex_nightly_enabled,
      sync_status: row.sync_status,
      lastScan: row.last_scan,
      openFindings: row.open_findings ?? {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
      },
    }));

    return { clones };
  });

const CloneNightlyInput = z.object({
  cloneId: z.string().uuid(),
  enabled: z.boolean(),
});

export const setCloneNightly = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => CloneNightlyInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("is_admin", { _user_id: context.userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { error } = await context.supabase
      .from("clones")
      .update({ codex_nightly_enabled: data.enabled })
      .eq("id", data.cloneId);
    if (error) throw error;
    return { ok: true };
  });

const ScanCloneInput = z.object({ cloneId: z.string().uuid() });

export const runCloneScanNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ScanCloneInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: isAdmin } = await context.supabase.rpc("is_admin", { _user_id: context.userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { enqueueScanNoAuth } = await import("@/server/codex-scheduling.server");
    const { data: clone } = await context.supabase
      .from("clones")
      .select("github_owner, github_repo")
      .eq("id", data.cloneId)
      .maybeSingle();
    if (!clone) throw new Error("clone not found");
    const repo = `${clone.github_owner}/${clone.github_repo}`;
    const r = await enqueueScanNoAuth({
      kind: "manual",
      targetKind: "clone",
      cloneId: data.cloneId,
      repoFullName: repo,
      dedupWindowHours: 0,
      requestPayload: { source: "manual_clone", requestedBy: context.userId },
    });
    return r;
  });

export const listCloneScanJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: jobs, error } = await context.supabase
      .from("codex_scan_jobs")
      .select(
        "id, kind, status, started_at, completed_at, created_at, result_summary, last_error, ref",
      )
      .eq("clone_id", data.cloneId)
      .order("created_at", { ascending: false })
      .limit(25);
    if (error) throw error;
    return { jobs: jobs ?? [] };
  });

export const listCloneOpenFindings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ cloneId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: findings, error } = await context.supabase
      .from("codex_findings")
      // `category` and `file_path` never existed on this table: the query
      // failed on every call and the clone card showed no findings at all.
      .select(
        "id, title, severity, state, scanner, rule_id, affected_file, affected_line, created_at, scan_job_id",
      )
      .eq("clone_id", data.cloneId)
      .eq("state", "open")
      .order("severity", { ascending: true })
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return { findings: findings ?? [] };
  });
