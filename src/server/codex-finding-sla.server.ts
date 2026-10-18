// The daily count of Codex findings past their response time. Server-only;
// run by the nightly hook (/hooks/codex-nightly), once a day.
//
// One notification, not one per finding: it names how many are overdue at
// each severity and the oldest few, and links to the explorer's "overdue"
// filter. Nothing is raised when nothing is overdue.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { notifyOperators } from "@/server/audit.server";
import {
  FINDING_SLA_DAYS,
  SLA_OPEN_STATES,
  ageInDays,
  overdueCutoffs,
} from "@/lib/codex-finding-sla";

export async function notifyOverdueFindings(nowMs = Date.now()): Promise<{
  overdue: number;
  notified: boolean;
}> {
  const filter = overdueCutoffs(nowMs)
    .map((c) => `and(severity.eq.${c.severity},first_seen_at.lt.${c.before})`)
    .join(",");
  const { data, count, error } = await supabaseAdmin
    .from("codex_findings")
    .select("id, title, severity, first_seen_at, clone_id", { count: "exact" })
    .in("state", [...SLA_OPEN_STATES])
    .is("pr_number", null)
    .or(filter)
    .order("first_seen_at", { ascending: true })
    .limit(200);
  if (error) {
    // Before 20261018090000 there is no pr_number to tell PR findings apart.
    console.warn("[codex-finding-sla] could not count overdue findings:", error.message);
    return { overdue: 0, notified: false };
  }
  const rows = data ?? [];
  const total = count ?? rows.length;
  if (total === 0) return { overdue: 0, notified: false };

  const bySeverity: Record<string, number> = {};
  for (const r of rows) bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
  const summary = (["critical", "high", "medium", "low"] as const)
    .filter((s) => bySeverity[s])
    .map((s) => `${bySeverity[s]} ${s} (over ${FINDING_SLA_DAYS[s]} days)`)
    .join(", ");
  const oldest = rows
    .slice(0, 3)
    .map(
      (r) =>
        `• ${r.title.replace(/\s+/g, " ").slice(0, 120)} — ${r.severity}, open ${ageInDays(r.first_seen_at, nowMs)} days`,
    );

  const notified = await notifyOperators({
    kind: "codex_findings_overdue",
    severity: bySeverity.critical || bySeverity.high ? "error" : "warning",
    title: `${total} security finding${total === 1 ? " is" : "s are"} past their response time`,
    body: [
      summary + (total > rows.length ? ` — and ${total - rows.length} more` : ""),
      ...oldest,
    ].join("\n"),
    url: "/security/scans?overdue=1",
    metadata: { overdue: total, by_severity: bySeverity },
  });
  return { overdue: total, notified };
}
