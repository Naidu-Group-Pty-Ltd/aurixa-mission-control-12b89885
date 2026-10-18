// The findings explorer: every finding Mission Control holds — one record per
// issue per target since 20261018090000 — and the decisions people make
// about them.
//
// Before this there was no way to look at a finding except inside the scan
// that first reported it, and no way to decide anything about one: "dismissed"
// and "false positive" existed as states that nothing could set, so a known
// false positive sat in every open count, every PR check and every gate for
// good. Triage here records who decided, why, and when, on the finding's own
// history (codex_finding_events) and in the audit log.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { asJson, asRow } from "@/lib/json-cast";
import { TRIAGE_STATES, validateTriage } from "@/lib/codex-finding-lifecycle";
import type { FindingState } from "@/lib/codex-finding-state";

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const STATES = [
  "open",
  "triaging",
  "fix_drafted",
  "pr_open",
  "fix_merged",
  "resolved",
  "dismissed",
  "false_positive",
] as const;

const BASE_COLUMNS =
  "id, title, severity, state, scanner, rule_id, cwe, cvss, affected_file, affected_line, clone_id, first_seen_at, last_seen_at, resolved_at, remediation_pr_url, remediation_pr_state, source_slug, scan_job_id, triaged_at";
const LIFECYCLE_COLUMNS =
  "target_key, pr_number, missed_scans, absent_since, resolution, triage_reason, triaged_by, last_seen_job_id";

function isMissingColumn(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error && (error.code === "42703" || /column .* does not exist/i.test(error.message ?? ""))
  );
}

function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  return (
    !!error &&
    (error.code === "42P01" ||
      error.code === "PGRST205" ||
      error.code === "PGRST202" ||
      /does not exist|Could not find/i.test(error.message ?? ""))
  );
}

/** Characters that would break out of a PostgREST `or=(…)` filter. */
function searchTerm(raw: string): string {
  return raw
    .replace(/[,()"*]/g, " ")
    .replace(/[\\%_]/g, (m) => `\\${m}`)
    .trim();
}

async function requireAdmin(supabase: any, userId: string) {
  const { data: isAdmin, error } = await supabase.rpc("is_admin", { _user_id: userId });
  if (error) throw new Error(`Could not check your role: ${error.message}`);
  if (!isAdmin) throw new Error("Forbidden: admin only");
}

async function displayNames(supabase: any, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (unique.length === 0) return {} as Record<string, string>;
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, display_name")
    .in("user_id", unique);
  if (error) return {} as Record<string, string>;
  const out: Record<string, string> = {};
  for (const p of data ?? []) if (p.display_name) out[p.user_id] = p.display_name;
  return out;
}

const ListFindingsInput = z.object({
  scope: z.enum(["all", "prime", "fleet", "clone"]).default("all"),
  cloneId: z.string().uuid().optional(),
  includePullRequests: z.boolean().default(false),
  states: z.array(z.enum(STATES)).max(STATES.length).optional(),
  severities: z.array(z.enum(SEVERITIES)).max(SEVERITIES.length).optional(),
  scanner: z.string().max(60).optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
});

export const listFindings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ListFindingsInput.parse(d ?? {}))
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const run = async (columns: string, lifecycle: boolean) => {
      let q = supabase.from("codex_findings").select(columns, { count: "exact" });
      if (data.scope === "prime") q = q.is("clone_id", null);
      else if (data.scope === "fleet") q = q.not("clone_id", "is", null);
      else if (data.scope === "clone") {
        if (!data.cloneId) throw new Error("cloneId is required for a clone's findings");
        q = q.eq("clone_id", data.cloneId);
      }
      if (lifecycle && !data.includePullRequests) q = q.is("pr_number", null);
      q = q.in("state", data.states?.length ? data.states : ["open", "triaging"]);
      if (data.severities?.length) q = q.in("severity", data.severities);
      if (data.scanner) q = q.eq("scanner", data.scanner);
      const term = data.search ? searchTerm(data.search) : "";
      if (term) {
        q = q.or(`title.ilike.%${term}%,affected_file.ilike.%${term}%,rule_id.ilike.%${term}%`);
      }
      return q
        .order("severity", { ascending: true })
        .order("last_seen_at", { ascending: false })
        .range(data.offset, data.offset + data.limit - 1);
    };

    let lifecycle = true;
    let res = await run(`${BASE_COLUMNS}, ${LIFECYCLE_COLUMNS}`, true);
    if (res.error && isMissingColumn(res.error)) {
      // Before 20261018090000: no PR targets, no triage columns.
      lifecycle = false;
      res = await run(BASE_COLUMNS, false);
    }
    if (res.error) throw new Error(res.error.message);

    const rows = (res.data ?? []) as any[];
    const cloneIds = [...new Set(rows.map((r) => r.clone_id).filter(Boolean))];
    const clones: Record<string, string> = {};
    if (cloneIds.length) {
      const { data: cs } = await supabase.from("clones").select("id, name").in("id", cloneIds);
      for (const c of cs ?? []) clones[c.id] = c.name;
    }
    const names = await displayNames(
      supabase,
      rows.map((r) => r.triaged_by),
    );

    return {
      findings: rows.map((r) => ({
        ...r,
        clone_name: r.clone_id ? (clones[r.clone_id] ?? null) : null,
        triaged_by_name: r.triaged_by ? (names[r.triaged_by] ?? null) : null,
      })),
      total: res.count ?? rows.length,
      lifecycle,
    };
  });

export const getFindingDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ findingId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: finding, error } = await supabase
      .from("codex_findings")
      .select("*")
      .eq("id", data.findingId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!finding) throw new Error("Finding not found");

    const [eventsRes, obsRes, remRes] = await Promise.all([
      supabase
        .from("codex_finding_events")
        .select("id, event_type, from_state, to_state, reason, actor, job_id, payload, created_at")
        .eq("finding_id", data.findingId)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("codex_finding_observations")
        .select("job_id, observed_at")
        .eq("finding_id", data.findingId)
        .order("observed_at", { ascending: false })
        .limit(20),
      supabase
        .from("codex_remediations")
        .select(
          "id, status, pr_number, pr_url, branch_name, created_at, merged_at, completed_at, fix_confirmed_at, last_error, verified",
        )
        .eq("finding_id", data.findingId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    // The history tables arrive with 20261018090000; before it there is
    // simply no history to show.
    if (eventsRes.error && !isMissingRelation(eventsRes.error))
      throw new Error(eventsRes.error.message);
    if (obsRes.error && !isMissingRelation(obsRes.error)) throw new Error(obsRes.error.message);
    if (remRes.error) throw new Error(remRes.error.message);

    const observations = (obsRes.data ?? []) as { job_id: string; observed_at: string }[];
    const jobs: Record<string, any> = {};
    if (observations.length) {
      const { data: js, error: jErr } = await supabase
        .from("codex_scan_jobs")
        .select("id, kind, status, ref, completed_at, workflow_run_url")
        .in(
          "id",
          observations.map((o) => o.job_id),
        );
      if (jErr) throw new Error(jErr.message);
      for (const j of js ?? []) jobs[j.id] = j;
    }

    const events = (eventsRes.data ?? []) as any[];
    const names = await displayNames(supabase, [
      ...events.map((e) => e.actor),
      (finding as any).triaged_by,
    ]);

    let cloneName: string | null = null;
    if (finding.clone_id) {
      const { data: c } = await supabase
        .from("clones")
        .select("name")
        .eq("id", finding.clone_id)
        .maybeSingle();
      cloneName = c?.name ?? null;
    }

    return {
      finding: { ...finding, clone_name: cloneName },
      events: events.map((e) => ({ ...e, actor_name: e.actor ? (names[e.actor] ?? null) : null })),
      observations: observations.map((o) => ({ ...o, job: jobs[o.job_id] ?? null })),
      remediations: remRes.data ?? [],
      triagedByName: (finding as any).triaged_by
        ? (names[(finding as any).triaged_by] ?? null)
        : null,
    };
  });

const TriageInput = z.object({
  state: z.enum(TRIAGE_STATES as unknown as [string, ...string[]]),
  reason: z.string().max(2000).optional(),
  resolution: z.enum(["rotated", "manual", "fixed"]).optional(),
});

type TriageOutcome = { id: string; ok: true } | { id: string; ok: false; error: string };

async function triageOne(
  supabase: any,
  userId: string,
  findingId: string,
  input: z.infer<typeof TriageInput>,
): Promise<TriageOutcome> {
  const { data: f, error } = await supabase
    .from("codex_findings")
    .select("id, state, scanner, title")
    .eq("id", findingId)
    .maybeSingle();
  if (error) return { id: findingId, ok: false, error: error.message };
  if (!f) return { id: findingId, ok: false, error: "not found" };

  const verdict = validateTriage({
    from: f.state as FindingState,
    to: input.state as (typeof TRIAGE_STATES)[number],
    reason: input.reason,
    resolution: input.resolution ?? null,
    scanner: f.scanner,
  });
  if (!verdict.ok) return { id: findingId, ok: false, error: verdict.error };

  const nowIso = new Date().toISOString();
  const reason = input.reason?.trim() || null;
  const patch: Record<string, unknown> = {
    state: input.state,
    triaged_at: nowIso,
    triaged_by: userId,
    triage_reason: reason,
  };
  if (input.state === "resolved") {
    patch.resolution = verdict.resolution;
    patch.resolved_at = nowIso;
  } else if (input.state === "open" || input.state === "triaging") {
    // Back in play: forget the absence bookkeeping and any old verdict.
    patch.resolution = null;
    patch.resolved_at = null;
    patch.missed_scans = 0;
    patch.absent_since = null;
  }

  // Only from the state the operator saw — a scan that moved the finding in
  // the meantime wins, and the operator is told to look again.
  const apply = (p: Record<string, unknown>) => {
    // Every caller branches on the result's `error`.
    return supabase
      .from("codex_findings")
      .update(asRow<TablesUpdate<"codex_findings">>(p))
      .eq("id", findingId)
      .eq("state", f.state)
      .select("id");
  };
  let res = await apply(patch);
  if (res.error && isMissingColumn(res.error)) {
    for (const k of ["triaged_by", "triage_reason", "resolution", "missed_scans", "absent_since"])
      delete patch[k];
    res = await apply(patch);
  }
  if (res.error) return { id: findingId, ok: false, error: res.error.message };
  if (!res.data?.length) {
    return {
      id: findingId,
      ok: false,
      error: "it changed while you were looking — reload and try again",
    };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error: evErr } = await supabaseAdmin.from("codex_finding_events").insert({
    finding_id: findingId,
    event_type: "triaged",
    from_state: f.state,
    to_state: input.state,
    reason,
    actor: userId,
    payload: asJson({ resolution: input.state === "resolved" ? verdict.resolution : null }),
  });
  if (evErr && !isMissingRelation(evErr))
    console.warn("[codex-findings] triage event not recorded:", evErr.message);

  const { writeAuditLog } = await import("@/server/audit.server");
  await writeAuditLog({
    action: "codex_finding.triaged",
    entityType: "codex_finding",
    entityId: findingId,
    actorUserId: userId,
    metadata: {
      title: f.title,
      from: f.state,
      to: input.state,
      reason,
      resolution: input.state === "resolved" ? verdict.resolution : null,
    },
  });
  return { id: findingId, ok: true };
}

export const triageFinding = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => TriageInput.extend({ findingId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireAdmin(supabase, userId);
    const outcome = await triageOne(supabase, userId, data.findingId, data);
    if (!outcome.ok) throw new Error(outcome.error);
    return { ok: true };
  });

export const bulkTriageFindings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    TriageInput.extend({ findingIds: z.array(z.string().uuid()).min(1).max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await requireAdmin(supabase, userId);
    const outcomes: TriageOutcome[] = [];
    for (const id of [...new Set(data.findingIds)]) {
      outcomes.push(await triageOne(supabase, userId, id, data));
    }
    return {
      updated: outcomes.filter((o) => o.ok).length,
      failed: outcomes.filter((o): o is Extract<TriageOutcome, { ok: false }> => !o.ok),
    };
  });

/**
 * Prime's own security posture. The page only ever showed the clone fleet —
 * Prime, the repository every clone is cut from, had no card, no counts and
 * no place in the navigation badge.
 */
export const getPrimePosture = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    const { data, error } = await supabase.rpc("codex_prime_overview");
    if (!error) return { posture: data as any, source: "rpc" as const };
    if (!isMissingRelation(error)) throw new Error(error.message);

    // Before 20261018090000: counted from the rows directly.
    const [lastRes, openRes] = await Promise.all([
      supabase
        .from("codex_scan_jobs")
        .select(
          "id, kind, status, ref, started_at, completed_at, created_at, last_error, result_summary",
        )
        .is("clone_id", null)
        .eq("target_kind", "prime")
        .neq("kind", "pr_open")
        .order("created_at", { ascending: false })
        .limit(1),
      supabase.from("codex_findings").select("severity").is("clone_id", null).eq("state", "open"),
    ]);
    if (lastRes.error) throw new Error(lastRes.error.message);
    if (openRes.error) throw new Error(openRes.error.message);
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of openRes.data ?? []) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    return {
      posture: {
        last_scan: lastRes.data?.[0] ?? null,
        open_findings: counts,
        triage: null,
        open_in_pull_requests: null,
      },
      source: "legacy" as const,
    };
  });
