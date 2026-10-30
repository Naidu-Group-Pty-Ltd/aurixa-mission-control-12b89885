// Operator alerts from the live audit. Server-only.
//
// One notification per event, raised once: at the run that found something
// worth a person's attention, at the third failure in a row, at a fix that is
// waiting for a person to merge it. Never on every run while a condition
// holds. Best effort throughout: an alert that cannot be raised is logged and
// never fails the callback that raised it.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { notifyOperators } from "@/server/audit.server";

const admin = supabaseAdmin;

/** Consecutive failed runs that make a pattern. */
export const FAILURE_STREAK_ALERT = 3;

/** What a finished run found that deserves an interruption, from its events. Pure. */
export function runAlert(input: {
  newSevere: Array<{ title: string; severity: string; route_template: string | null }>;
  regressions: number;
}): { title: string; body: string; severity: "error" | "warning" } | null {
  if (input.newSevere.length === 0 && input.regressions === 0) return null;
  const critical = input.newSevere.filter((f) => f.severity === "critical").length;
  const parts: string[] = [];
  if (input.newSevere.length) {
    parts.push(
      `${input.newSevere.length} new ${critical ? "critical or high" : "high"}-severity defect${input.newSevere.length === 1 ? "" : "s"}`,
    );
  }
  if (input.regressions)
    parts.push(
      `${input.regressions} defect${input.regressions === 1 ? "" : "s"} back after being resolved or fixed`,
    );
  const sample = input.newSevere
    .slice(0, 3)
    .map((f) => `• [${f.severity}] ${f.title}${f.route_template ? ` (${f.route_template})` : ""}`)
    .join("\n");
  return {
    title: `Live audit of Prime: ${parts.join(", ")}`,
    body: sample || "Open the live audit to see which.",
    severity: critical ? "error" : "warning",
  };
}

export async function alertOnRunCompleted(runId: string): Promise<void> {
  try {
    const { data: run, error: runErr } = await admin
      .from("live_audit_runs")
      .select("id, regressions")
      .eq("id", runId)
      .maybeSingle();
    if (runErr) {
      console.warn("[live-audit-alerts] run not read:", runErr.message);
      return;
    }
    const { data: fresh, error } = await admin
      .from("live_audit_findings")
      .select("title, severity, route_template")
      .eq("first_seen_run_id", runId)
      .in("severity", ["critical", "high"]);
    if (error) {
      console.warn("[live-audit-alerts] new findings not read:", error.message);
      return;
    }
    const alert = runAlert({ newSevere: fresh ?? [], regressions: run?.regressions ?? 0 });
    if (!alert) return;
    await notifyOperators({
      kind: "live_audit_findings_detected",
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      url: `/live-audit?run=${runId}`,
      metadata: { run_id: runId },
    });
  } catch (err) {
    console.warn("[live-audit-alerts] completed-run alert failed:", (err as Error).message);
  }
}

export async function alertOnRunFailed(runId: string): Promise<void> {
  try {
    const { data, error } = await admin
      .from("live_audit_runs")
      .select("id, status, last_error")
      .eq("target_key", "prime")
      .in("status", ["completed", "failed"])
      .order("created_at", { ascending: false })
      .limit(FAILURE_STREAK_ALERT);
    if (error) {
      console.warn("[live-audit-alerts] recent runs not read:", error.message);
      return;
    }
    if (!data) return;
    // Exactly at the third: a fourth failure in a row raises nothing new.
    const streak = data.every((r) => r.status === "failed") && data.length === FAILURE_STREAK_ALERT;
    if (!streak) return;
    const { data: before, error: beforeErr } = await admin
      .from("live_audit_runs")
      .select("status")
      .eq("target_key", "prime")
      .in("status", ["completed", "failed"])
      .order("created_at", { ascending: false })
      .range(FAILURE_STREAK_ALERT, FAILURE_STREAK_ALERT)
      .maybeSingle();
    if (beforeErr) {
      console.warn("[live-audit-alerts] the run before the streak not read:", beforeErr.message);
      return;
    }
    if (before?.status === "failed") return;
    await notifyOperators({
      kind: "live_audit_run_failed",
      severity: "error",
      title: `The live audit of Prime has failed ${FAILURE_STREAK_ALERT} runs in a row`,
      body: (data[0]?.last_error ?? "See the latest run.").slice(0, 500),
      url: `/live-audit?run=${runId}`,
      metadata: { run_id: runId },
    });
  } catch (err) {
    console.warn("[live-audit-alerts] failure alert failed:", (err as Error).message);
  }
}

export async function alertOnFixReady(input: {
  fixId: string;
  findingTitle: string;
  prUrl: string | null;
  severity: string;
}): Promise<void> {
  await notifyOperators({
    kind: "live_audit_fix_ready",
    severity: input.severity === "critical" || input.severity === "high" ? "warning" : "info",
    title: `Claude drafted a fix: ${input.findingTitle.slice(0, 140)}`,
    body: "A person reviews and merges live-audit fixes while the audit is being proven on Prime.",
    url: input.prUrl ?? "/live-audit",
    metadata: { fix_id: input.fixId },
  }).catch(() => false);
}
