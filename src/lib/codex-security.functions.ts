import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { Json } from "@/integrations/supabase/types";

// The nightly cron expression is NOT here: it is changed through
// setNightlySchedule, which reschedules the pg_cron job too. Saving it as a
// plain column used to look like it changed the fire time and changed nothing.
// Scans run nightly on Prime only (src/lib/codex-scan-policy.ts), so the PR
// scan, post-merge, PR check and fleet settings are gone from here. Fix PRs
// merge by themselves (src/lib/remediation-policy.ts), so the auto-merge
// ceiling is gone too; what remains is whether fixes are dispatched at all,
// and how many a night.
const SchedulingInput = z.object({
  codex_nightly_enabled: z.boolean().optional(),
  codex_scan_dedup_hours: z.number().int().min(0).max(168).optional(),
  // Since 20261018090000.
  codex_deep_scan_scope: z.enum(["off", "prime"]).optional(),
  codex_cascade_gate: z.enum(["off", "critical", "high"]).optional(),
  // Since 20261018120000.
  codex_autofix_enabled: z.boolean().optional(),
  codex_autofix_max_per_night: z.number().int().min(0).max(50).optional(),
});

const SCHEDULING_KEYS = [
  "id",
  "codex_nightly_enabled",
  "codex_nightly_cron",
  "codex_scan_dedup_hours",
  "codex_deep_scan_scope",
  "codex_cascade_gate",
  "codex_autofix_enabled",
  "codex_autofix_max_per_night",
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
    return {
      config,
      migrated: "codex_cascade_gate" in row,
      autofixMigrated: "codex_autofix_enabled" in row,
    };
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
          "codex_autofix_enabled" in data || "codex_autofix_max_per_night" in data
            ? "This setting needs migration 20261018120000_codex_autofix_settings — apply it, then try again."
            : "This setting needs migration 20261018090000_codex_findings_canonical — apply it, then try again.",
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

/**
 * Apply the ruleset that protects Mission Control's own default branch now,
 * rather than at tonight's run. Admin only, and recorded: it changes the
 * repository's settings through Mission Control's App.
 */
export const protectMissionControlMainNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { ensureMissionControlBranchProtection } =
      await import("@/server/mission-control-branch-protection.server");
    const result = await ensureMissionControlBranchProtection({ apply: true });
    const { writeAuditLog } = await import("@/server/audit.server");
    await writeAuditLog({
      action: `mission_control.branch_protection.${result.status}`,
      entityType: "github_ruleset",
      entityId: result.repo ?? null,
      actorUserId: userId,
      metadata: result as unknown as Record<string, unknown>,
    });
    return result;
  });

export const runNightlyNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: isAdmin } = await context.supabase.rpc("is_admin", { _user_id: context.userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");
    const { runNightlyScans } = await import("@/server/codex-scheduling.server");
    return await runNightlyScans();
  });

// A person may scan Prime now; nothing else (src/lib/codex-scan-policy.ts).
const EnqueueInput = z.object({
  kind: z.literal("manual").default("manual"),
  targetKind: z.literal("prime").default("prime"),
  ref: z.string().optional(),
  pathGlobs: z.array(z.string()).optional(),
});

/**
 * Queue a manual scan of Prime as an authenticated admin.
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

    const { data: p } = await supabase
      .from("prime_config")
      .select("github_owner, github_repo")
      .limit(1)
      .maybeSingle();
    if (!p) throw new Error("prime_config not set");
    const repoFullName = `${p.github_owner}/${p.github_repo}`;

    const { enqueueScanNoAuth } = await import("@/server/codex-scheduling.server");
    const result = await enqueueScanNoAuth({
      kind: data.kind,
      targetKind: data.targetKind,
      cloneId: null,
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

    // The semgrep rules the previous scan of the same repository ran, so the
    // drawer can say whether a change in findings came from the code or from
    // the rules (registry packs move between nights).
    let previousRules: { jobId: string; completedAt: string | null; semgrep: Json } | null = null;
    if (job.data?.created_at) {
      let prev = supabase
        .from("codex_scan_jobs")
        .select("id, completed_at, semgrep_rules:result_summary->rulesets->semgrep")
        .eq("status", "completed")
        .eq("target_kind", job.data.target_kind)
        .neq("id", job.data.id)
        .lt("created_at", job.data.created_at)
        .not("result_summary->rulesets->semgrep->>digest", "is", null)
        .order("created_at", { ascending: false })
        .limit(1);
      prev = job.data.clone_id ? prev.eq("clone_id", job.data.clone_id) : prev.is("clone_id", null);
      const { data: p, error: prevErr } = await prev.maybeSingle();
      if (prevErr)
        console.warn("[codex-security] previous scan rules unavailable:", prevErr.message);
      else if (p) {
        previousRules = {
          jobId: p.id,
          completedAt: p.completed_at,
          semgrep: p.semgrep_rules ?? null,
        };
      }
    }
    return { job: job.data, findings, events: events.data ?? [], source, previousRules };
  });

// -------- Clones: history only --------
//
// Clones are no longer scanned (src/lib/codex-scan-policy.ts); their page
// shows the scans that ran before, read-only.

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
