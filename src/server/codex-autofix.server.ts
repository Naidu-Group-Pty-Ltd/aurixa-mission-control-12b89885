// Fixes Mission Control dispatches by itself after the nightly Prime scan.
// Server-only; which findings, in what order and by which engine is decided by
// src/lib/codex-autofix-policy.ts (Claude for P0/P1, Codex for P2 and below).
//
// Run from the scan sweep (/hooks/codex-sweep, every ten minutes) rather than
// from the scan callback: dispatching a night's fixes inside the request the
// runner is waiting on would hold its callback open, and a retried callback
// must not dispatch twice. The sweep picks the latest completed full scan of
// Prime whose fixes have not been dispatched yet (an `autofix.dispatched`
// event on the job says they have), dispatches up to tonight's limit, and
// records what it did on that job.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { asJson } from "@/lib/json-cast";
import {
  parseAutofixLimit,
  selectAutofixCandidates,
  type AutofixFinding,
  type FixEngine,
} from "@/lib/codex-autofix-policy";
import {
  IN_FLIGHT_REMEDIATION_STATUSES,
  startRemediation,
} from "@/server/codex-remediation-start.server";

const admin = supabaseAdmin;

/** A completed scan older than this no longer starts fixes (its findings may have moved on). */
const SCAN_FRESH_HOURS = 36;
/** Automatic fixes that ended without a merge count against a finding for this long. */
const ATTEMPT_WINDOW_DAYS = 30;
const CANDIDATE_LIMIT = 500;

export type AutofixRunResult =
  | { ran: false; reason: string }
  | {
      ran: true;
      jobId: string;
      dispatched: Array<{ findingId: string; remediationId: string; engine: FixEngine }>;
      failed: Array<{ findingId: string; error: string }>;
      skipped: number;
    };

async function loadAutofixSettings(): Promise<{ enabled: boolean; limit: number }> {
  // `*`: before 20261018120000 the columns are absent and read as their
  // defaults — on, ten a night — rather than failing the select.
  const { data, error } = await admin.from("prime_config").select("*").limit(1).maybeSingle();
  if (error || !data) return { enabled: false, limit: 0 };
  const row = data as Record<string, unknown>;
  return {
    enabled: row.codex_autofix_enabled !== false,
    limit: parseAutofixLimit(row.codex_autofix_max_per_night),
  };
}

/** The latest completed full scan of Prime, if it is recent. */
async function latestPrimeScan(): Promise<{ id: string } | null> {
  const since = new Date(Date.now() - SCAN_FRESH_HOURS * 3_600_000).toISOString();
  const { data, error } = await admin
    .from("codex_scan_jobs")
    .select("id, kind, path_globs, result_summary")
    .eq("target_kind", "prime")
    .is("clone_id", null)
    .eq("status", "completed")
    .in("kind", ["nightly_full", "manual"])
    .gte("completed_at", since)
    .order("completed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  // A path-scoped manual scan saw part of the tree; it starts nothing.
  const scope = (data.result_summary as { scope?: { mode?: string } } | null)?.scope?.mode;
  if ((data.path_globs ?? []).length > 0 || (scope && scope !== "full")) return null;
  return { id: data.id };
}

async function alreadyDispatched(jobId: string): Promise<boolean> {
  const { count, error } = await admin
    .from("codex_scan_events")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId)
    .eq("event_type", "autofix.dispatched");
  // Unreadable: say yes. Dispatching twice is the expensive mistake.
  return error ? true : (count ?? 0) > 0;
}

async function openPrimeFindings(): Promise<AutofixFinding[]> {
  const run = (columns: string, withPr: boolean) => {
    let q = admin
      .from("codex_findings")
      .select(columns)
      .is("clone_id", null)
      .eq("state", "open")
      .neq("severity", "info")
      .limit(CANDIDATE_LIMIT);
    if (withPr) q = q.is("pr_number", null);
    return q;
  };
  let res = await run("id, severity, state, scanner, first_seen_at, clone_id, pr_number", true);
  if (res.error) {
    // Before 20261018090000 there is no pr_number (and no PR findings).
    res = await run("id, severity, state, scanner, created_at, clone_id", false);
  }
  if (res.error) throw new Error(res.error.message);
  return ((res.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    severity: String(r.severity),
    state: String(r.state),
    scanner: (r.scanner as string | null) ?? null,
    first_seen_at: ((r.first_seen_at ?? r.created_at) as string | null) ?? null,
    clone_id: (r.clone_id as string | null) ?? null,
    pr_number: (r.pr_number as number | null | undefined) ?? null,
  }));
}

async function remediationHistory(findingIds: string[]): Promise<{
  inFlight: Set<string>;
  failedAttempts: Map<string, number>;
}> {
  const inFlight = new Set<string>();
  const failedAttempts = new Map<string, number>();
  const since = new Date(Date.now() - ATTEMPT_WINDOW_DAYS * 86_400_000).toISOString();
  for (let i = 0; i < findingIds.length; i += 200) {
    const { data, error } = await admin
      .from("codex_remediations")
      .select("finding_id, status, requested_by, created_at")
      .in("finding_id", findingIds.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      if ((IN_FLIGHT_REMEDIATION_STATUSES as readonly string[]).includes(r.status)) {
        inFlight.add(r.finding_id);
      } else if (
        r.requested_by == null &&
        r.status !== "merged" &&
        String(r.created_at ?? "") >= since
      ) {
        failedAttempts.set(r.finding_id, (failedAttempts.get(r.finding_id) ?? 0) + 1);
      }
    }
  }
  return { inFlight, failedAttempts };
}

/**
 * Dispatch tonight's fixes, once per completed full scan of Prime. Never
 * throws for a single fix: one that cannot be dispatched is recorded and the
 * rest still go.
 */
export async function dispatchAutomaticFixes(): Promise<AutofixRunResult> {
  const settings = await loadAutofixSettings();
  if (!settings.enabled) return { ran: false, reason: "automatic fixes are switched off" };
  if (settings.limit === 0) return { ran: false, reason: "the nightly limit is 0" };

  const job = await latestPrimeScan();
  if (!job) return { ran: false, reason: "no recent completed full scan of Prime" };
  if (await alreadyDispatched(job.id)) {
    return { ran: false, reason: "this scan's fixes were already dispatched" };
  }

  const findings = await openPrimeFindings();
  const history = await remediationHistory(findings.map((f) => f.id));
  const { picks, skipped } = selectAutofixCandidates({
    findings,
    limit: settings.limit,
    inFlight: history.inFlight,
    failedAttempts: history.failedAttempts,
  });

  // Claimed before dispatching: a sweep that overlaps this one sees the event
  // and stands down, so a night's fixes go out once. Scan events are
  // append-only; the outcome follows as `autofix.summary`.
  const { error: claimErr } = await admin.from("codex_scan_events").insert({
    job_id: job.id,
    event_type: "autofix.dispatched",
    payload: asJson({
      picks: picks.map((p) => ({ finding_id: p.id, engine: p.engine, priority: p.priority })),
      limit: settings.limit,
    }),
  });
  if (claimErr) return { ran: false, reason: `could not record the dispatch: ${claimErr.message}` };

  const dispatched: Array<{ findingId: string; remediationId: string; engine: FixEngine }> = [];
  const failed: Array<{ findingId: string; error: string }> = [];
  for (const pick of picks) {
    const r = await startRemediation({
      findingId: pick.id,
      requestedBy: null,
      engine: pick.engine,
      source: "autofix",
    });
    if (r.ok)
      dispatched.push({ findingId: pick.id, remediationId: r.remediationId, engine: r.engine });
    else failed.push({ findingId: pick.id, error: r.error.slice(0, 300) });
  }

  const byEngine = dispatched.reduce<Record<string, number>>((acc, d) => {
    acc[d.engine] = (acc[d.engine] ?? 0) + 1;
    return acc;
  }, {});
  const { error: doneErr } = await admin.from("codex_scan_events").insert({
    job_id: job.id,
    event_type: "autofix.summary",
    payload: asJson({
      limit: settings.limit,
      dispatched: dispatched.length,
      by_engine: byEngine,
      failed,
      skipped: skipped.length,
      skipped_reasons: skipped.slice(0, 50),
    }),
  });
  if (doneErr) console.warn("[codex-autofix] dispatch summary not recorded:", doneErr.message);

  return { ran: true, jobId: job.id, dispatched, failed, skipped: skipped.length };
}
