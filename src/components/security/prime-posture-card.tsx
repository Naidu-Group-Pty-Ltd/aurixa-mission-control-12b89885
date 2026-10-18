// Prime's own security posture on /security/scans.
//
// The page showed the clone fleet and nothing for Prime — the repository
// every clone is cut from, and the one whose findings the cascade carries to
// all of them.
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getPrimePosture } from "@/lib/codex-findings.functions";
import { degradedScanners } from "@/lib/codex-finding-lifecycle";
import { reportedWorkflowVersion } from "@/lib/codex-workflow-contract";
import { formatDistanceToNow } from "@/lib/format";

const sevBadge: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-amber-500 text-white",
  low: "bg-blue-500 text-white",
  info: "bg-slate-500 text-white",
};

export function PrimePostureCard({
  onShowFindings,
  onOpenScan,
}: {
  onShowFindings: () => void;
  onOpenScan: (jobId: string) => void;
}) {
  const q = useQuery({
    queryKey: ["codex-prime-posture"],
    queryFn: () => getPrimePosture(),
    refetchInterval: 30_000,
  });
  if (q.isLoading) return null;
  if (q.isError) {
    return (
      <Card className="border-red-500/40">
        <CardHeader>
          <CardTitle className="text-base">Prime posture unavailable</CardTitle>
          <CardDescription>{(q.error as Error)?.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const p: any = q.data?.posture ?? {};
  const last = p.last_scan;
  const open = p.open_findings ?? {};
  const triage = p.triage;
  const summary = last?.result_summary ?? null;
  const degraded = summary ? degradedScanners(summary) : [];
  const incomplete = summary?.incomplete === true;
  const version = summary ? reportedWorkflowVersion(summary) : null;
  const openTotal = ["critical", "high", "medium", "low", "info"].reduce(
    (n, s) => n + (open[s] ?? 0),
    0,
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" /> Prime
          </CardTitle>
          <CardDescription>
            The repository every clone is cut from — its findings reach the whole fleet with the
            next cascade.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={onShowFindings}>
          View Prime&apos;s findings
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        <div className="space-y-1 text-xs">
          <div className="text-muted-foreground">Last full scan</div>
          {last ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={last.status === "failed" ? "destructive" : "outline"}>
                  {last.status}
                </Badge>
                <span>
                  {formatDistanceToNow(last.completed_at ?? last.started_at ?? last.created_at)}
                </span>
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => onOpenScan(last.id)}
                >
                  details
                </button>
                {last.workflow_run_url && (
                  <a
                    href={last.workflow_run_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-muted-foreground hover:underline"
                  >
                    run <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
              {version != null && (
                <div className="text-muted-foreground">
                  workflow v{version} · {last.kind}
                </div>
              )}
              {last.last_error && (
                <div className="text-red-500">{String(last.last_error).slice(0, 200)}</div>
              )}
              {incomplete && (
                <div className="flex items-center gap-1 text-amber-500">
                  <AlertTriangle className="h-3 w-3" /> Results incomplete — nothing was resolved by
                  absence
                </div>
              )}
              {degraded.length > 0 && (
                <div className="text-amber-500">
                  {degraded.map((d) => `${d.name}: ${d.reason}`).join(" · ")}
                </div>
              )}
            </>
          ) : (
            <div className="text-muted-foreground">Prime has never been scanned.</div>
          )}
        </div>
        <div className="space-y-1 text-xs">
          <div className="text-muted-foreground">Open findings</div>
          <div className="flex flex-wrap gap-1">
            {["critical", "high", "medium", "low", "info"].map((s) =>
              (open[s] ?? 0) > 0 ? (
                <Badge key={s} className={sevBadge[s]}>
                  {s}: {open[s]}
                </Badge>
              ) : null,
            )}
            {openTotal === 0 && <span className="text-muted-foreground">None open</span>}
          </div>
          {p.open_in_pull_requests ? (
            <div className="text-muted-foreground">
              +{p.open_in_pull_requests} in open pull requests (not counted)
            </div>
          ) : null}
        </div>
        <div className="space-y-1 text-xs">
          <div className="text-muted-foreground">Decisions</div>
          {triage ? (
            <div className="grid grid-cols-2 gap-x-3">
              <span>Triaging</span>
              <span className="tabular-nums">{triage.triaging}</span>
              <span>Fix in flight</span>
              <span className="tabular-nums">{triage.fix_in_flight}</span>
              <span title="Merged; the next full scan confirms or reopens">
                Fix merged, unconfirmed
              </span>
              <span className="tabular-nums">{triage.fix_merged}</span>
              <span>Dismissed</span>
              <span className="tabular-nums">{triage.dismissed}</span>
              <span>False positive</span>
              <span className="tabular-nums">{triage.false_positive}</span>
              {triage.secrets_absent > 0 && (
                <>
                  <span className="text-amber-500">Secrets to rotate</span>
                  <span
                    className="tabular-nums text-amber-500"
                    title="Deleted from the files but never marked rotated"
                  >
                    {triage.secrets_absent}
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="text-muted-foreground">
              Apply migration 20261018090000 to track decisions.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
