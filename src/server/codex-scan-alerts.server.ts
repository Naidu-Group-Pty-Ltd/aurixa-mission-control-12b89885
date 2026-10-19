// Operator alerts from the Codex scan pipeline. Server-only.
//
// Until this existed the pipeline told nobody anything: a nightly scan could
// find a committed service-role key, a merged fix could turn out not to work,
// or a scanner could fail every night for a month, and the only way to learn
// it was to open /security/scans and look. Each alert below is one
// notification per event, raised once — at the scan that found it, or at the
// third failure in a row — never on every scan while a condition holds.
//
// Best effort throughout: an alert that cannot be raised is logged, and never
// fails the scan it describes.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { notifyOperators } from "@/server/audit.server";
import { SECRET_SCANNERS, degradedScanners } from "@/lib/codex-finding-lifecycle";
import {
  consecutiveFailureStreak,
  newFindingAlert,
  type AlertFinding,
} from "@/lib/codex-scan-alert-rules";

const admin = supabaseAdmin;

/** Consecutive failures that make a pattern worth a person's attention. */
export const FAILURE_STREAK_ALERT = 3;

type AlertJob = {
  id: string;
  kind: string;
  clone_id: string | null;
  target_kind: string;
  repo_full_name: string;
  last_error?: string | null;
};

async function targetLabel(job: AlertJob): Promise<string> {
  if (!job.clone_id) return "Prime";
  const { data } = await admin.from("clones").select("name").eq("id", job.clone_id).maybeSingle();
  return data?.name ?? job.repo_full_name;
}

/** The same target's recent non-PR jobs, newest first. */
async function recentJobs(job: AlertJob, columns: string, limit: number) {
  let q = admin
    .from("codex_scan_jobs")
    .select(columns)
    .neq("kind", "pr_open")
    .in("status", ["completed", "failed"])
    .order("created_at", { ascending: false })
    .limit(limit);
  q = job.clone_id
    ? q.eq("clone_id", job.clone_id)
    : q.is("clone_id", null).eq("target_kind", "prime");
  const { data, error } = await q;
  if (error) {
    console.warn("[codex-scan-alerts] could not read recent scans:", error.message);
    return null;
  }
  return (data ?? []) as unknown as Array<Record<string, any>>;
}

/**
 * A scan finished. Raise what it found that needs a person, and say so if one
 * of its scanners has now failed three scans running. PR scans are left to
 * their PR check — they describe code that has not merged.
 */
export async function alertOnScanCompleted(job: AlertJob): Promise<void> {
  if (job.kind === "pr_open") return;
  try {
    const label = await targetLabel(job);

    const { data: events, error } = await admin
      .from("codex_finding_events")
      .select("event_type, finding:codex_findings(id, title, severity, scanner, affected_file)")
      .eq("job_id", job.id)
      .in("event_type", ["first_seen", "regression", "fix_ineffective"])
      .limit(1000);
    if (error) {
      // Before 20261018090000 there is no per-finding history to read.
      if (!/does not exist|Could not find/i.test(error.message)) {
        console.warn("[codex-scan-alerts] could not read finding events:", error.message);
      }
    } else {
      const findings: AlertFinding[] = [];
      for (const e of events ?? []) {
        const f = (Array.isArray(e.finding) ? e.finding[0] : e.finding) as {
          title: string;
          severity: string;
          scanner: string | null;
        } | null;
        if (!f) continue;
        findings.push({
          event: e.event_type as AlertFinding["event"],
          title: f.title,
          severity: f.severity,
          secret: !!f.scanner && SECRET_SCANNERS.has(f.scanner),
        });
      }
      const alert = newFindingAlert(label, findings);
      if (alert) {
        await notifyOperators({
          kind: "codex_findings_detected",
          severity: alert.severity,
          title: alert.title,
          body: alert.body,
          cloneId: job.clone_id,
          url: `/security/scans?job=${job.id}`,
          metadata: { job_id: job.id, repo: job.repo_full_name, ...alert.counts },
        });
      }
    }

    // A scanner that has failed this scan and the two before it — and not
    // the one before those — has just become a pattern.
    const recent = await recentJobs(job, "id, status, result_summary", FAILURE_STREAK_ALERT + 1);
    if (!recent || recent[0]?.id !== job.id) return;
    const degradedByJob = recent.map((j) =>
      j.status === "completed" ? degradedScanners(j.result_summary) : null,
    );
    for (const d of degradedByJob[0] ?? []) {
      const streak = consecutiveFailureStreak(
        degradedByJob.map((list) => (list ? list.some((x) => x.name === d.name) : null)),
      );
      if (streak !== FAILURE_STREAK_ALERT) continue;
      await notifyOperators({
        kind: "codex_scanner_failing",
        severity: "warning",
        title: `${label}: ${d.name} has failed ${FAILURE_STREAK_ALERT} scans in a row`,
        body:
          `Latest reason: ${d.reason}. A scanner that fails resolves nothing by absence and ` +
          `finds nothing new, so its findings are frozen until it runs cleanly.`,
        cloneId: job.clone_id,
        url: `/security/scans?job=${job.id}`,
        metadata: { job_id: job.id, repo: job.repo_full_name, scanner: d.name },
      });
    }
  } catch (err) {
    console.warn("[codex-scan-alerts] completed-scan alert failed:", (err as Error).message);
  }
}

/** A scan failed outright. Say so once it has failed three times running. */
export async function alertOnScanFailed(job: AlertJob): Promise<void> {
  if (job.kind === "pr_open") return;
  try {
    const recent = await recentJobs(job, "id, status, last_error", FAILURE_STREAK_ALERT + 1);
    if (!recent || recent[0]?.id !== job.id) return;
    const streak = consecutiveFailureStreak(recent.map((j) => j.status === "failed"));
    if (streak !== FAILURE_STREAK_ALERT) return;
    const label = await targetLabel(job);
    await notifyOperators({
      kind: "codex_scanner_failing",
      severity: "error",
      title: `${label}: the last ${FAILURE_STREAK_ALERT} security scans failed`,
      body: `Latest error: ${String(recent[0].last_error ?? job.last_error ?? "unknown").slice(0, 300)}`,
      cloneId: job.clone_id,
      url: `/security/scans?job=${job.id}`,
      metadata: { job_id: job.id, repo: job.repo_full_name },
    });
  } catch (err) {
    console.warn("[codex-scan-alerts] failed-scan alert failed:", (err as Error).message);
  }
}
