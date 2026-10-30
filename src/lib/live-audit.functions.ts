// The Live Audit page's server functions (src/routes/live-audit.tsx).
//
// Reading is for operators and above, through their own session, so the
// tables' row-level security is what decides (operator+, migration
// 20261030133100). Everything that changes something — a run, a fix, a
// triage, the settings — is an admin's, checked here and written with the
// service role, because nothing grants `authenticated` a write on these
// tables. Every such change is in the audit log, and a triage is also on the
// finding's own history.
//
// Server-only modules are imported inside the handlers: route components load
// this file, and a static `*.server.ts` import would reach the client bundle.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { asJson, asRow } from "@/lib/json-cast";
import {
  CLAUDE_MODEL_ID,
  DEFAULT_AUDIT_MODEL,
  EFFORTS,
  FINDING_STATES,
  LIVE_AUDIT_MODES,
  OPEN_STATES,
  SEVERITIES,
  SEVERITY_RANK,
  triageTransition,
} from "@/lib/live-audit-policy";
import {
  LIVE_AUDIT_WORKFLOW_FILE,
  LIVE_AUDIT_WORKFLOW_VERSION,
  REMEDIATION_VERSION_FOR_DEFECTS,
} from "@/lib/live-audit-contract";

const UUID = z.string().uuid();
const EVIDENCE_BUCKET = "live-audit-evidence";

async function roleOf(
  supabase: any,
  userId: string,
): Promise<{ operator: boolean; admin: boolean }> {
  const [op, ad] = await Promise.all([
    supabase.rpc("is_operator", { _user_id: userId }),
    supabase.rpc("is_admin", { _user_id: userId }),
  ]);
  if (op.error || ad.error)
    throw new Error(`Could not check your role: ${(op.error ?? ad.error).message}`);
  return { operator: Boolean(op.data) || Boolean(ad.data), admin: Boolean(ad.data) };
}

async function requireOperator(supabase: any, userId: string) {
  const r = await roleOf(supabase, userId);
  if (!r.operator) throw new Error("Forbidden: operator or admin only");
  return r;
}

async function requireAdmin(supabase: any, userId: string) {
  const r = await roleOf(supabase, userId);
  if (!r.admin) throw new Error("Forbidden: admin only");
}

async function audit(entry: {
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string;
  metadata: Record<string, unknown>;
}) {
  const { writeAuditLog } = await import("@/server/audit.server");
  await writeAuditLog(entry);
}

const RUN_COLUMNS =
  "id, kind, mode, status, ref, target_url, created_at, dispatched_at, started_at, completed_at, " +
  "findings_reported, findings_new, regressions, findings_resolved, batches_received, cost_usd, complete, " +
  "auth_state, anthropic, last_error, workflow_run_url, dispatch_attempts, runner_version, requested_by";

const FINDING_COLUMNS =
  "id, fingerprint, state, resolution, severity, category, detector, title, route, route_template, " +
  "confidence, deterministic, reproduced, judged_by, occurrences, runs_seen, missed_runs, first_seen_at, " +
  "last_seen_at, resolved_at, triage_reason, triaged_at, fix_attempts, screenshot_path";

// ── Reading ───────────────────────────────────────────────────────────────

export const getLiveAuditOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }: { context: any }) => {
    const { supabase, userId } = context;
    const role = await requireOperator(supabase, userId);

    const [settingsRes, runsRes, openRes, fixesRes] = await Promise.all([
      supabase.from("live_audit_settings").select("*").eq("target_key", "prime").maybeSingle(),
      supabase
        .from("live_audit_runs")
        .select(RUN_COLUMNS)
        .eq("target_key", "prime")
        .order("created_at", { ascending: false })
        .limit(20),
      supabase
        .from("live_audit_findings")
        .select("severity, state")
        .eq("target_key", "prime")
        .in("state", [...OPEN_STATES])
        .limit(5000),
      supabase
        .from("live_audit_fixes")
        .select(
          "id, finding_id, status, model, branch_name, pr_number, pr_url, workflow_run_url, last_error, source, " +
            "created_at, dispatched_at, merged_at, fix_confirmed_at, completed_at, files_changed, lines_added, lines_removed",
        )
        .order("created_at", { ascending: false })
        .limit(25),
    ]);
    for (const r of [settingsRes, runsRes, openRes, fixesRes])
      if (r.error) throw new Error(r.error.message);

    const bySeverity: Record<string, number> = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    const byState: Record<string, number> = {};
    for (const f of (openRes.data ?? []) as Array<{ severity: string; state: string }>) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      byState[f.state] = (byState[f.state] ?? 0) + 1;
    }

    const fixes = (fixesRes.data ?? []) as Array<Record<string, any>>;
    const titles: Record<string, { title: string; severity: string; state: string }> = {};
    const findingIds = [...new Set(fixes.map((f) => f.finding_id))];
    if (findingIds.length) {
      const { data, error } = await supabase
        .from("live_audit_findings")
        .select("id, title, severity, state")
        .in("id", findingIds);
      if (error) throw new Error(error.message);
      for (const f of data ?? [])
        titles[f.id] = { title: f.title, severity: f.severity, state: f.state };
    }

    const { anthropicKeyConfigured } = await import("@/server/live-audit-fix.server");
    return {
      canAct: role.admin,
      settings: settingsRes.data ?? null,
      runs: runsRes.data ?? [],
      open: { total: (openRes.data ?? []).length, bySeverity, byState },
      fixes: fixes.map((f) => ({ ...f, finding: titles[f.finding_id] ?? null })),
      anthropicKey: anthropicKeyConfigured(),
      defaultModel: DEFAULT_AUDIT_MODEL,
    };
  });

const ListFindingsInput = z.object({
  view: z.enum(["open", "fixing", "resolved", "dismissed", "all"]).default("open"),
  severities: z.array(z.enum(SEVERITIES)).max(SEVERITIES.length).optional(),
  search: z.string().max(200).optional(),
  runId: UUID.optional(),
  limit: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).max(10_000).default(0),
});

const VIEW_STATES: Record<string, readonly string[] | null> = {
  open: ["open", "triaging"],
  fixing: ["fix_queued", "fix_in_progress", "fix_pr_open", "fix_merged"],
  resolved: ["resolved"],
  dismissed: ["dismissed", "false_positive"],
  all: null,
};

/** Characters that would break out of a PostgREST `or=(…)` filter. */
function searchTerm(raw: string): string {
  return raw
    .replace(/[,()"*]/g, " ")
    .replace(/[\\%_]/g, (m) => `\\${m}`)
    .trim();
}

export const listLiveAuditFindings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ListFindingsInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireOperator(supabase, userId);
    // Up to 500 at once, ranked here: severity is text in the table, and an
    // alphabetical "critical, high, info, low, medium" is not an order.
    let q = supabase
      .from("live_audit_findings")
      .select(FINDING_COLUMNS, { count: "exact" })
      .eq("target_key", "prime");
    const states = VIEW_STATES[data.view];
    if (states) q = q.in("state", [...states]);
    if (data.severities?.length) q = q.in("severity", data.severities);
    if (data.runId) q = q.eq("last_seen_run_id", data.runId);
    const term = data.search ? searchTerm(data.search) : "";
    if (term)
      q = q.or(
        `title.ilike.%${term}%,route.ilike.%${term}%,route_template.ilike.%${term}%,detector.ilike.%${term}%`,
      );
    const {
      data: rows,
      error,
      count,
    } = await q.order("last_seen_at", { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    const ranked = ((rows ?? []) as Array<Record<string, any>>).sort(
      (a, b) =>
        (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
        String(b.last_seen_at).localeCompare(String(a.last_seen_at)),
    );
    return {
      findings: ranked.slice(data.offset, data.offset + data.limit),
      total: count ?? ranked.length,
      truncated: (count ?? 0) > 500,
    };
  });

export const getLiveAuditFinding = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ findingId: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const role = await requireOperator(supabase, userId);
    const { data: finding, error } = await supabase
      .from("live_audit_findings")
      .select("*")
      .eq("id", data.findingId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!finding) throw new Error("Finding not found");

    const [eventsRes, obsRes, fixesRes] = await Promise.all([
      supabase
        .from("live_audit_events")
        .select(
          "id, event_type, from_state, to_state, reason, actor, run_id, fix_id, payload, created_at",
        )
        .eq("finding_id", data.findingId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("live_audit_observations")
        .select("run_id, occurrences, observed_at")
        .eq("finding_id", data.findingId)
        .order("observed_at", { ascending: false })
        .limit(20),
      supabase
        .from("live_audit_fixes")
        .select(
          "id, status, model, branch_name, pr_number, pr_url, workflow_run_url, verification, summary, last_error, source, " +
            "created_at, merged_at, fix_confirmed_at, completed_at, files_changed, lines_added, lines_removed",
        )
        .eq("finding_id", data.findingId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    for (const r of [eventsRes, obsRes, fixesRes]) if (r.error) throw new Error(r.error.message);

    // The screenshot is in a private bucket no session can read: the read of
    // the finding above, under row-level security, is the check, and the link
    // lasts ten minutes.
    let screenshotUrl: string | null = null;
    if ((finding as any).screenshot_path) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: signed, error: signErr } = await supabaseAdmin.storage
        .from(EVIDENCE_BUCKET)
        .createSignedUrl((finding as any).screenshot_path, 600);
      if (signErr) console.warn("[live-audit] screenshot not signed:", signErr.message);
      screenshotUrl = signed?.signedUrl ?? null;
    }

    const { anthropicKeyConfigured } = await import("@/server/live-audit-fix.server");
    return {
      canAct: role.admin,
      anthropicKey: anthropicKeyConfigured(),
      finding,
      events: eventsRes.data ?? [],
      observations: obsRes.data ?? [],
      fixes: fixesRes.data ?? [],
      screenshotUrl,
    };
  });

export const getLiveAuditRun = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ runId: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const role = await requireOperator(supabase, userId);
    const { data: run, error } = await supabase
      .from("live_audit_runs")
      .select(`${RUN_COLUMNS}, settings, phases, summary`)
      .eq("id", data.runId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!run) throw new Error("Run not found");
    const [eventsRes, newRes] = await Promise.all([
      supabase
        .from("live_audit_events")
        .select("id, event_type, from_state, to_state, reason, finding_id, payload, created_at")
        .eq("run_id", data.runId)
        .order("created_at", { ascending: true })
        .limit(300),
      supabase
        .from("live_audit_findings")
        .select("id, title, severity, state, route_template, detector")
        .eq("first_seen_run_id", data.runId)
        .limit(100),
    ]);
    if (eventsRes.error) throw new Error(eventsRes.error.message);
    if (newRes.error) throw new Error(newRes.error.message);
    return {
      canAct: role.admin,
      run,
      events: eventsRes.data ?? [],
      newFindings: ((newRes.data ?? []) as Array<Record<string, any>>).sort(
        (a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0),
      ),
    };
  });

// ── Acting ────────────────────────────────────────────────────────────────

export const startLiveAuditRun = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        mode: z.enum(LIVE_AUDIT_MODES).optional(),
        ref: z
          .string()
          .regex(/^[A-Za-z0-9._/-]{1,200}$/)
          .optional(),
        /** A verification run: the finding's page first, and its fingerprint named. */
        verifyFindingId: UUID.optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireAdmin(supabase, userId);
    let focusRoutes: string[] | undefined;
    let focusFingerprints: string[] | undefined;
    if (data.verifyFindingId) {
      const { data: f, error } = await supabase
        .from("live_audit_findings")
        .select("fingerprint, route, route_template")
        .eq("id", data.verifyFindingId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!f) throw new Error("Finding not found");
      const path = String(f.route ?? "").split(/[?#]/)[0];
      focusRoutes = [
        ...new Set([f.route_template, path].filter((p): p is string => !!p && p.startsWith("/"))),
      ];
      focusFingerprints = [f.fingerprint];
    }
    const { enqueueLiveAuditRun } = await import("@/server/live-audit-dispatch.server");
    const result = await enqueueLiveAuditRun({
      kind: data.verifyFindingId ? "verify" : "manual",
      requestedBy: userId,
      mode: data.mode,
      ref: data.ref ?? null,
      focusRoutes,
      focusFingerprints,
    });
    if (!result.ok) throw new Error(result.reason);
    await audit({
      action: "live_audit.run_requested",
      entityType: "live_audit_run",
      entityId: result.runId,
      actorUserId: userId,
      metadata: {
        mode: data.mode ?? null,
        ref: data.ref ?? null,
        verify: data.verifyFindingId ?? null,
      },
    });
    return result;
  });

export const cancelLiveAuditRunFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ runId: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireAdmin(supabase, userId);
    const { cancelLiveAuditRun } = await import("@/server/live-audit-dispatch.server");
    const result = await cancelLiveAuditRun({ runId: data.runId, by: userId });
    if (!result.ok) throw new Error(result.reason);
    await audit({
      action: "live_audit.run_canceled",
      entityType: "live_audit_run",
      entityId: data.runId,
      actorUserId: userId,
      metadata: { workflow_canceled: result.workflowCanceled },
    });
    return result;
  });

export const startLiveAuditFixFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ findingId: UUID }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireAdmin(supabase, userId);
    const { startLiveAuditFix } = await import("@/server/live-audit-fix.server");
    const result = await startLiveAuditFix({
      findingId: data.findingId,
      requestedBy: userId,
      source: "operator",
    });
    if (!result.ok) throw new Error(result.error);
    await audit({
      action: "live_audit.fix_requested",
      entityType: "live_audit_finding",
      entityId: data.findingId,
      actorUserId: userId,
      metadata: { fix_id: result.fixId, reused: result.reused },
    });
    return result;
  });

export const triageLiveAuditFinding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        findingId: UUID,
        state: z.enum(FINDING_STATES),
        reason: z.string().max(2000).optional(),
        severity: z.enum(SEVERITIES).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireAdmin(supabase, userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: f, error } = await supabaseAdmin
      .from("live_audit_findings")
      .select("id, state, severity, title")
      .eq("id", data.findingId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!f) throw new Error("Finding not found");

    const reason = data.reason?.trim() || null;
    const moving = data.state !== f.state;
    if (moving) {
      const verdict = triageTransition(f.state, data.state, reason);
      if (!verdict.ok) throw new Error(verdict.reason);
    }
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = {
      triaged_by: userId,
      triaged_at: now,
      triage_reason: reason,
    };
    if (moving) patch.state = data.state;
    // A person's severity sticks: the ingest keeps a triaged finding's severity.
    if (data.severity && data.severity !== f.severity) patch.severity = data.severity;
    if (data.state === "resolved" && moving) {
      patch.resolution = "manual";
      patch.resolved_at = now;
    } else if ((data.state === "open" || data.state === "triaging") && moving) {
      patch.resolution = null;
      patch.resolved_at = null;
      patch.missed_runs = 0;
      patch.absent_since = null;
    }
    // Only from the state the person saw: a run that moved it meanwhile wins.
    const { data: moved, error: upErr } = await supabaseAdmin
      .from("live_audit_findings")
      .update(asRow<TablesUpdate<"live_audit_findings">>(patch))
      .eq("id", f.id)
      .eq("state", f.state)
      .select("id");
    if (upErr) throw new Error(upErr.message);
    if (!moved?.length) throw new Error("It changed while you were looking; reload and try again.");

    const { error: evErr } = await supabaseAdmin.from("live_audit_events").insert({
      finding_id: f.id,
      actor: userId,
      event_type: moving ? "triaged" : "severity_changed",
      from_state: f.state,
      to_state: moving ? data.state : f.state,
      reason,
      payload: asJson({ severity: { from: f.severity, to: data.severity ?? f.severity } }),
    });
    if (evErr) console.warn("[live-audit] triage event not recorded:", evErr.message);
    await audit({
      action: "live_audit.finding_triaged",
      entityType: "live_audit_finding",
      entityId: f.id,
      actorUserId: userId,
      metadata: {
        title: f.title,
        from: f.state,
        to: data.state,
        reason,
        severity: data.severity ?? null,
      },
    });
    return { ok: true };
  });

const ModelInput = z.string().regex(CLAUDE_MODEL_ID, "a Claude model id").nullable();
// The runner's own pattern (lib/config.mjs on Prime): a name it would drop is
// never saved here, so the page never shows an allowance the run ignores.
const FunctionName = z.string().regex(/^[a-z0-9-]{2,80}$/, "a function name");

const SettingsInput = z
  .object({
    nightly_enabled: z.boolean(),
    mode: z.enum(LIVE_AUDIT_MODES),
    target_url: z
      .string()
      .url()
      .regex(/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/.*)?$/, "an https URL"),
    audit_model: ModelInput,
    fix_model: ModelInput,
    effort_scope: z.enum(EFFORTS),
    effort_explore: z.enum(EFFORTS),
    effort_triage: z.enum(EFFORTS),
    fix_effort: z.enum(EFFORTS),
    budget_usd: z.number().min(0).max(200),
    max_pages: z.number().int().min(1).max(400),
    max_journeys: z.number().int().min(0).max(40),
    max_steps: z.number().int().min(1).max(80),
    time_budget_minutes: z.number().int().min(5).max(85),
    viewports: z
      .array(z.enum(["desktop", "mobile"]))
      .min(1)
      .max(2),
    screenshots: z.enum(["issues", "off"]),
    guard_allow_functions: z.array(FunctionName).max(100),
    guard_block_functions: z.array(FunctionName).max(100),
    autofix_enabled: z.boolean(),
    autofix_max_per_run: z.number().int().min(0).max(20),
    autofix_min_confidence: z.number().min(0).max(1),
  })
  .partial();

export const updateLiveAuditSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => SettingsInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireAdmin(supabase, userId);
    const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length === 0) return { ok: true, changed: [] as string[] };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: before, error: readErr } = await supabaseAdmin
      .from("live_audit_settings")
      .select("*")
      .eq("target_key", "prime")
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!before)
      throw new Error("The live audit has no settings row for Prime; apply its migration.");
    const { error } = await supabaseAdmin
      .from("live_audit_settings")
      .update(asRow<TablesUpdate<"live_audit_settings">>({ ...patch, updated_by: userId }))
      .eq("target_key", "prime");
    if (error) throw new Error(error.message);
    const changed = Object.keys(patch).filter(
      (k) => JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify(patch[k]),
    );
    await audit({
      action: "live_audit.settings_updated",
      entityType: "live_audit_settings",
      entityId: "prime",
      actorUserId: userId,
      metadata: Object.fromEntries(
        changed.map((k) => [
          k,
          { from: (before as Record<string, unknown>)[k] ?? null, to: patch[k] },
        ]),
      ),
    });
    return { ok: true, changed };
  });

export const setLiveAuditNightlySchedule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ cron: z.string().regex(/^[0-9*/,\- ]{9,60}$/, "a five-field cron expression") })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireAdmin(supabase, userId);
    // As the person: the function checks `is_admin(auth.uid())` itself.
    const { data: result, error } = await supabase.rpc("live_audit_set_nightly_schedule", {
      p_cron: data.cron,
    });
    if (error) throw new Error(error.message);
    await audit({
      action: "live_audit.schedule_updated",
      entityType: "live_audit_settings",
      entityId: "prime",
      actorUserId: userId,
      metadata: { cron: data.cron, result },
    });
    return result as { applied?: boolean; reason?: string };
  });

// ── Engine health ─────────────────────────────────────────────────────────

export type LiveAuditHealthCheck = {
  key: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  /** What a person does about it, when it is not ok. */
  fix?: string;
};

// GitHub reads are cached per server instance, as the Codex panel's are: the
// files and the names change rarely, and each read spends the App's window.
const GITHUB_CACHE_MS = 10 * 60_000;
let setupCache: { at: number; value: unknown } | null = null;

export const getLiveAuditEngineHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }: { context: any }) => {
    const { supabase, userId } = context;
    await requireOperator(supabase, userId);
    const checks: LiveAuditHealthCheck[] = [];

    const { anthropicKeyConfigured } = await import("@/server/live-audit-fix.server");
    const { resolveLiveAuditMasterSecrets } = await import("@/server/live-audit-keys.server");
    const { resolvePrimeRepo, readLiveAuditPrimeSetup, liveAuditCallbackUrl } =
      await import("@/server/live-audit-dispatch.server");

    // ── The Anthropic key: what Claude runs on, in the audit and every fix ──
    const key = anthropicKeyConfigured();
    checks.push({
      key: "anthropic_key",
      label: "Anthropic key in Mission Control",
      status: key ? "ok" : "warn",
      detail: key
        ? "ANTHROPIC_API_KEY is set, and the Actions secret sync writes it into Prime's repository"
        : "Waiting on the Anthropic key: runs crawl and report from the browser alone; Claude's scoping, exploring and triage, and every fix, wait for it",
      fix: key
        ? undefined
        : "Set ANTHROPIC_API_KEY in Mission Control (a key from the Anthropic workspace the live audit should bill to), then run the Actions secret sync for Prime in Settings.",
    });

    const masters = await resolveLiveAuditMasterSecrets();
    checks.push({
      key: "callback_master",
      label: "Callback signing master",
      status: masters.current ? "ok" : "fail",
      detail: masters.current
        ? `${masters.mode === "env" ? "LIVE_AUDIT_WEBHOOK_SECRET" : "The Codex scan master"}; every run and fix signs with a key derived for it alone. Callbacks reach ${liveAuditCallbackUrl()}`
        : "No master: no run can be dispatched, because it could not report back",
      fix: masters.current
        ? undefined
        : "Set LIVE_AUDIT_WEBHOOK_SECRET (or configure the Codex scan master).",
    });

    checks.push({
      key: "cron_secret",
      label: "Cron shared secret",
      status: process.env.CRON_SECRET || process.env.DRIFT_REFRESH_TOKEN ? "ok" : "fail",
      detail:
        process.env.CRON_SECRET || process.env.DRIFT_REFRESH_TOKEN
          ? "The nightly run and the ten-minute sweep can authenticate"
          : "Missing: pg_cron's calls to /hooks/live-audit-* are refused",
    });

    // ── Prime ──────────────────────────────────────────────────────────────
    let prime: Awaited<ReturnType<typeof resolvePrimeRepo>> | null = null;
    try {
      prime = await resolvePrimeRepo();
    } catch (err) {
      checks.push({
        key: "prime_repo",
        label: "Prime repository",
        status: "fail",
        detail: (err as Error).message,
        fix: "Set github_owner and github_repo in prime_config.",
      });
    }
    if (prime) {
      checks.push({
        key: "prime_backend",
        label: "Prime's backend",
        status: prime.backendOrigin ? "ok" : "fail",
        detail: prime.backendOrigin
          ? `${prime.backendOrigin}: the audit signs in against it and the guard reads its function calls`
          : "prime_config names no Supabase project, so a live run cannot sign in or tell a read from a write",
        fix: prime.backendOrigin ? undefined : "Set supabase_project_ref in prime_config.",
      });

      const fresh = setupCache && Date.now() - setupCache.at < GITHUB_CACHE_MS;
      let setup: Awaited<ReturnType<typeof readLiveAuditPrimeSetup>> | null = null;
      try {
        setup = fresh
          ? (setupCache!.value as Awaited<ReturnType<typeof readLiveAuditPrimeSetup>>)
          : await readLiveAuditPrimeSetup();
        if (!fresh) setupCache = { at: Date.now(), value: setup };
      } catch (err) {
        checks.push({
          key: "prime_github",
          label: "Prime's repository on GitHub",
          status: "fail",
          detail: `Could not be read: ${(err as Error).message}`,
        });
      }
      if (setup) {
        const wf = setup.workflow;
        const wfCurrent = (wf.version ?? 0) >= LIVE_AUDIT_WORKFLOW_VERSION;
        checks.push({
          key: "workflow",
          label: "Live audit workflow on Prime",
          status: !wf.present || wf.dispatchable === false ? "fail" : wfCurrent ? "ok" : "warn",
          detail: wf.present
            ? `.github/workflows/${LIVE_AUDIT_WORKFLOW_FILE} on ${setup.repo}@${setup.branch}, version ${wf.version ?? "?"}`
            : wf.detail,
          fix: !wf.present
            ? `Merge the live audit's pull request on ${setup.repo}: the workflow must be on ${setup.branch} to be dispatched.`
            : wfCurrent
              ? undefined
              : `Prime's copy is older than the version ${LIVE_AUDIT_WORKFLOW_VERSION} this Mission Control dispatches.`,
        });
        const rem = setup.remediation;
        const remCurrent = (rem.version ?? 0) >= REMEDIATION_VERSION_FOR_DEFECTS;
        checks.push({
          key: "remediation",
          label: "Fix workflow on Prime",
          status: !rem.present ? "fail" : remCurrent ? "ok" : "fail",
          detail: rem.present
            ? `codex-remediation.yml version ${rem.version ?? "?"}${remCurrent ? ": fixes live-audit defects with Claude" : ""}`
            : rem.detail,
          fix: remCurrent
            ? undefined
            : `Copy .github/workflows/codex-remediation.yml from Mission Control into ${setup.repo}: version ${REMEDIATION_VERSION_FOR_DEFECTS} is the first that fixes a live-audit defect.`,
        });
        const names = (list: string[] | null, name: string) =>
          list === null ? null : list.includes(name);
        const primeKey = names(setup.repoSecrets, "ANTHROPIC_API_KEY");
        checks.push({
          key: "prime_anthropic_key",
          label: "Anthropic key in Prime's Actions secrets",
          status: primeKey === null ? "warn" : primeKey ? "ok" : key ? "fail" : "warn",
          detail:
            primeKey === null
              ? "Prime's secret names could not be read"
              : primeKey
                ? "ANTHROPIC_API_KEY is in Prime's repository"
                : "Prime's repository holds no ANTHROPIC_API_KEY",
          fix: primeKey
            ? undefined
            : "Run the Actions secret sync for Prime in Settings once Mission Control holds the key.",
        });
        const user = names(setup.repoVariables, "LIVE_AUDIT_USER_ID");
        checks.push({
          key: "audit_account",
          label: "The audit's staff account",
          status: user === null ? "warn" : user ? "ok" : "warn",
          detail:
            user === null
              ? "Prime's variable names could not be read"
              : user
                ? "LIVE_AUDIT_USER_ID names the account the audit signs in as"
                : "No LIVE_AUDIT_USER_ID: runs see only Prime's public pages",
          fix: user
            ? undefined
            : "Create a view-only admin account on Prime for the audit, and put its user id in the repository variable LIVE_AUDIT_USER_ID.",
        });
        // The session job reads the environment's copy first and the
        // repository's otherwise (Prime's DEPLOYMENT_PROTECTION.md moves it
        // into the environment alone), so either one mints.
        const inEnvironment = names(setup.productionSecrets, "SUPABASE_SERVICE_ROLE_KEY");
        const inRepository = names(setup.repoSecrets, "SUPABASE_SERVICE_ROLE_KEY");
        checks.push({
          key: "session_minting",
          label: "Session minting (supabase-production)",
          status: inEnvironment || inRepository ? "ok" : "warn",
          detail: inEnvironment
            ? "The session job can mint and revoke the audit's session"
            : inRepository
              ? "The session job can mint and revoke the audit's session, from the repository's copy of SUPABASE_SERVICE_ROLE_KEY"
              : inEnvironment === null || inRepository === null
                ? "Where SUPABASE_SERVICE_ROLE_KEY is kept could not be read"
                : "Neither the supabase-production environment nor the repository holds SUPABASE_SERVICE_ROLE_KEY: runs stay signed out",
        });
      }
    }

    // ── The settings, and the last run ─────────────────────────────────────
    const [{ data: settings, error: sErr }, { data: last, error: lErr }] = await Promise.all([
      supabase
        .from("live_audit_settings")
        .select("audit_model, fix_model, nightly_enabled, nightly_cron")
        .eq("target_key", "prime")
        .maybeSingle(),
      supabase
        .from("live_audit_runs")
        .select("id, status, completed_at, last_error, anthropic")
        .eq("target_key", "prime")
        .in("status", ["completed", "failed"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (sErr) throw new Error(sErr.message);
    if (lErr) throw new Error(lErr.message);
    checks.push({
      key: "models",
      label: "Models",
      status: settings?.audit_model && settings?.fix_model ? "ok" : "warn",
      detail: `Audit: ${settings?.audit_model ?? `not chosen (runs record the default, ${DEFAULT_AUDIT_MODEL})`} · Fixes: ${settings?.fix_model ?? "not chosen (the fix workflow's default)"}`,
      fix: settings?.audit_model && settings?.fix_model ? undefined : "Choose them under Settings.",
    });
    checks.push({
      key: "nightly",
      label: "Nightly run",
      status: settings?.nightly_enabled ? "ok" : "warn",
      detail: settings?.nightly_enabled
        ? `On, at ${settings.nightly_cron} (UTC)`
        : "Off: runs only when a person starts one",
    });
    if (last) {
      checks.push({
        key: "last_run",
        label: "Last finished run",
        status: last.status === "completed" ? "ok" : "fail",
        detail:
          last.status === "completed"
            ? `Completed ${last.completed_at ?? ""}`
            : `Failed: ${last.last_error ?? "no detail"}`,
      });
    }
    return { checks };
  });
