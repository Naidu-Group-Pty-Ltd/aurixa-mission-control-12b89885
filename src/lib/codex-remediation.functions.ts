import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

// Mirrors REMEDIATION_CALLBACK_KEY_VERSION in @/server/codex-callback-keys.server.
// Declared literally rather than imported: this module is loaded by route
// components, and a static `*.server.ts` import would fail client import
// protection (codex-callback-keys.server.test.ts pins the two equal).
export const REMEDIATION_CALLBACK_KEY_VERSION = "rem-v1";

const DraftInput = z.object({
  findingId: z.string().uuid(),
  baseRef: z.string().optional(),
});

/**
 * A person asks for a fix now. Same path as the nightly automatic fixes
 * (codex-remediation-start.server.ts): the engine follows the finding's
 * priority — Claude for P0/P1, Codex below — and the PR merges by itself once
 * its checks pass.
 */
export const draftRemediationPR = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => DraftInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Admin-only gate — RLS enforces too.
    const { data: isAdmin } = await supabase.rpc("is_admin", { _user_id: userId });
    if (!isAdmin) throw new Error("Forbidden: admin only");

    const { startRemediation } = await import("@/server/codex-remediation-start.server");
    const result = await startRemediation({
      findingId: data.findingId,
      requestedBy: userId,
      baseRef: data.baseRef ?? null,
      source: "operator",
    });
    if (!result.ok) throw new Error(result.error);
    return { remediationId: result.remediationId, reused: result.reused, engine: result.engine };
  });

const ListInput = z.object({
  jobId: z.string().uuid().optional(),
  findingId: z.string().uuid().optional(),
  /** Only fixes still in flight: being written, or with an open PR. */
  inFlight: z.boolean().optional(),
});

/**
 * Remediation statuses with a fix still in flight. Mirrors
 * IN_FLIGHT_REMEDIATION_STATUSES in @/server/codex-remediation-start.server
 * (declared here too: route components load this module).
 */
export const FIX_IN_FLIGHT_STATUSES = [
  "queued",
  "dispatched",
  "pr_opened",
  "pr_updated",
  "approved",
  "changes_requested",
] as const;

const REMEDIATION_BASE_COLUMNS =
  "id, finding_id, scan_job_id, repo_full_name, base_ref, branch_name, workflow_run_id, workflow_run_url, pr_number, pr_url, pr_state, status, last_error, dispatched_at, completed_at, created_at, requested_by, approvals_required, merged_at, merged_by, merge_commit_sha, clone_id, cascade_event_id";
// 20260728090000
const REMEDIATION_VERIFICATION_COLUMNS =
  "engine, model, verification, verified, files_changed, lines_added, lines_removed, fix_confirmed_at";
// 20261018090000: the commit approvals name, and how a merge happened.
const REMEDIATION_HEAD_COLUMNS = "head_sha, fix_ineffective_at, merged_via";

export const listRemediations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ListInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    // Newest schema first, then each older one: a deployment that has not
    // applied a migration yet keeps its remediation list rather than blanking
    // it over a missing column.
    const attempts = [
      `${REMEDIATION_BASE_COLUMNS}, ${REMEDIATION_VERIFICATION_COLUMNS}, ${REMEDIATION_HEAD_COLUMNS}`,
      `${REMEDIATION_BASE_COLUMNS}, ${REMEDIATION_VERIFICATION_COLUMNS}`,
      REMEDIATION_BASE_COLUMNS,
    ];
    let lastError: { code?: string; message?: string } | null = null;
    for (const columns of attempts) {
      let q = context.supabase
        .from("codex_remediations")
        .select(columns)
        .order("created_at", { ascending: false })
        .limit(100);
      if (data.jobId) q = q.eq("scan_job_id", data.jobId);
      if (data.findingId) q = q.eq("finding_id", data.findingId);
      if (data.inFlight) q = q.in("status", [...FIX_IN_FLIGHT_STATUSES]);
      const { data: rows, error } = await q;
      if (!error) {
        const remediations = (rows ?? []) as any[];
        if (!data.inFlight || remediations.length === 0) return { remediations };
        // The in-flight queue names what each fix is for.
        const { data: findings, error: fErr } = await context.supabase
          .from("codex_findings")
          .select("id, title, severity, scanner, affected_file, affected_line, clone_id, state")
          .in(
            "id",
            remediations.map((r) => r.finding_id),
          );
        if (fErr) throw fErr;
        const byId = new Map((findings ?? []).map((f) => [f.id, f]));
        // And where its merge stands: a fix whose CI is still running says
        // so (self-healing.server.ts `waitForFixCi`). Best effort — the list
        // stands without it.
        const { data: mergeRuns, error: runErr } = await context.supabase
          .from("remediation_runs")
          .select("remediation_id, status, last_error, next_attempt_at, created_at")
          .eq("action_type", "pr_merge")
          .in(
            "remediation_id",
            remediations.map((r) => r.id),
          )
          .order("created_at", { ascending: false });
        if (runErr) console.warn("[codex-remediation] merge runs unavailable:", runErr.message);
        const mergeRunByRemediation = new Map<string, unknown>();
        for (const run of mergeRuns ?? []) {
          if (run.remediation_id && !mergeRunByRemediation.has(run.remediation_id)) {
            mergeRunByRemediation.set(run.remediation_id, run);
          }
        }
        return {
          remediations: remediations.map((r) => ({
            ...r,
            finding: byId.get(r.finding_id) ?? null,
            merge_run: mergeRunByRemediation.get(r.id) ?? null,
          })),
        };
      }
      if (error.code !== "42703" && !/column .* does not exist/i.test(error.message ?? "")) {
        throw error;
      }
      lastError = error;
    }
    throw lastError;
  });

/**
 * Where merged Codex fixes stand on their way to the fleet: delivering now,
 * held for a person, or delivered. The overview's tile used to count
 * remediations with a cascade but no merge time — a combination that never
 * happens, since the cascade is created by the merge — so it always read 0.
 */
export const getSecurityCascadeSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await context.supabase
      .from("codex_remediations")
      .select(
        "id, merged_at, cascade_event_id, cascade:cascade_events(status, requires_approval, approved_at, completed_at)",
      )
      .not("cascade_event_id", "is", null)
      .gte("merged_at", since)
      .order("merged_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let inFlight = 0;
    let held = 0;
    let delivered7d = 0;
    for (const r of data ?? []) {
      const c = (Array.isArray(r.cascade) ? r.cascade[0] : r.cascade) as {
        status: string;
        requires_approval: boolean;
        approved_at: string | null;
        completed_at: string | null;
      } | null;
      if (!c) continue;
      if (c.status === "pending" && c.requires_approval && !c.approved_at) held += 1;
      else if (c.status === "pending" || c.status === "running") inFlight += 1;
      else if (
        (c.status === "completed" || c.status === "partial") &&
        c.completed_at &&
        Date.parse(c.completed_at) >= week
      ) {
        delivered7d += 1;
      }
    }
    return { inFlight, held, delivered7d };
  });
