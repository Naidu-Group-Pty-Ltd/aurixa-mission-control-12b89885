import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ShieldCheck,
  ShieldAlert,
  GitPullRequest,
  GitMerge,
  CheckCircle2,
  Waves,
  PlayCircle,
  ArrowRight,
} from "lucide-react";
import { ProtectedRoute } from "@/components/protected-route";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listScanJobs } from "@/lib/codex-security.functions";
import { getPrimePosture } from "@/lib/codex-findings.functions";
import {
  FIX_IN_FLIGHT_STATUSES,
  getSecurityCascadeSummary,
  listRemediations,
} from "@/lib/codex-remediation.functions";
import { FIX_ENGINE_LABEL, isFixEngine } from "@/lib/codex-autofix-policy";
import { SCAN_POLICY_SUMMARY } from "@/lib/codex-scan-policy";

export const Route = createFileRoute("/security/")({
  component: () => (
    <ProtectedRoute>
      <AppShell>
        <SecurityOverviewPage />
      </AppShell>
    </ProtectedRoute>
  ),
  head: () => ({
    meta: [
      { title: "Security Overview — Aurixa Mission Control" },
      {
        name: "description",
        content:
          "Prime's security posture: the nightly scan, open findings, automatic fixes and their rollout to the fleet.",
      },
    ],
  }),
});

const sevOrder = ["critical", "high", "medium", "low", "info"] as const;
const sevColor: Record<string, string> = {
  critical: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  medium: "bg-amber-500 text-white",
  low: "bg-blue-500 text-white",
  info: "bg-slate-500 text-white",
};

function SecurityOverviewPage() {
  const jobsQ = useQuery({
    queryKey: ["codex-scan-jobs"],
    queryFn: () => listScanJobs(),
    refetchInterval: 30000,
  });
  const remQ = useQuery({
    queryKey: ["codex-remediations"],
    queryFn: () => listRemediations({ data: {} }),
    refetchInterval: 30000,
  });
  const primeQ = useQuery({
    queryKey: ["codex-prime-posture"],
    queryFn: () => getPrimePosture(),
    refetchInterval: 60000,
    retry: false,
  });
  const primeOpen = ((primeQ.data?.posture as any)?.open_findings ?? {}) as Record<string, number>;
  const cascadesQ = useQuery({
    queryKey: ["codex-security-cascades"],
    queryFn: () => getSecurityCascadeSummary(),
    refetchInterval: 60000,
  });

  const jobs = jobsQ.data?.jobs ?? [];
  const remediations = remQ.data?.remediations ?? [];
  const anyLoading = jobsQ.isLoading || remQ.isLoading;

  const inflight = jobs.filter((j: any) =>
    ["queued", "running", "pending"].includes(j.status),
  ).length;
  const lastNightly = jobs.find((j: any) => j.kind === "nightly_full");
  const failedRecent = jobs.filter((j: any) => j.status === "failed").length;

  // By status: the workflow reports `pr_state: "draft_open"`, which the old
  // pr_state list never matched, so this tile always read zero.
  const fixesInFlight = remediations.filter((r: any) =>
    (FIX_IN_FLIGHT_STATUSES as readonly string[]).includes(r.status),
  );
  const prsMerged24h = remediations.filter(
    (r: any) => r.merged_at && Date.now() - new Date(r.merged_at).getTime() < 86_400_000,
  );
  const recentlyMerged = remediations
    .filter(
      (r: any) => r.merged_at && Date.now() - new Date(r.merged_at).getTime() < 7 * 86_400_000,
    )
    .slice(0, 8);

  const cascadesInFlight = cascadesQ.data?.inFlight ?? 0;
  const cascadesHeld = cascadesQ.data?.held ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        eyebrow="security"
        icon={<ShieldCheck className="h-7 w-7 text-primary" />}
        title="Security Overview"
        description={`${SCAN_POLICY_SUMMARY} Claude fixes P0/P1 findings, Codex P2 and below, and every fix merges by itself once its checks pass.`}
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/security/scans">
                <PlayCircle className="h-4 w-4 mr-1" /> Open scans console
              </Link>
            </Button>
            <Button asChild>
              <Link to="/approvals">
                <CheckCircle2 className="h-4 w-4 mr-1" /> Cascade approvals
              </Link>
            </Button>
          </>
        }
      />

      {/* Top-line tiles */}
      {anyLoading && jobs.length === 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[120px] animate-pulse border /40" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Tile
            icon={<ShieldAlert className="h-4 w-4" />}
            label="Open findings (Prime)"
            hint="Clones receive Prime's fixes through the cascade"
            to="/security/scans"
          >
            <div className="flex flex-wrap gap-1.5 mt-1">
              {sevOrder.map((s) => (
                <Badge key={s} className={sevColor[s]}>
                  {s}: {primeOpen[s] ?? 0}
                </Badge>
              ))}
            </div>
          </Tile>
          <Tile
            icon={<PlayCircle className="h-4 w-4" />}
            label="Scans"
            to="/security/scans"
            hint={
              lastNightly
                ? `Last nightly: ${(lastNightly.completed_at || lastNightly.started_at || "").slice(0, 16).replace("T", " ")}`
                : "No nightly run yet"
            }
          >
            <div className="text-3xl font-semibold tabular-nums">{inflight}</div>
            <div className="text-xs text-muted-foreground">
              in flight · {failedRecent} failed (last 100)
            </div>
          </Tile>
          <Tile
            icon={<GitPullRequest className="h-4 w-4" />}
            label="Fixes"
            to="/security/scans"
            hint={`${prsMerged24h.length} merged by themselves in the last 24h`}
          >
            <div className="text-3xl font-semibold tabular-nums">{fixesInFlight.length}</div>
            <div className="text-xs text-muted-foreground">in flight — no review needed</div>
          </Tile>
          <Tile
            icon={<Waves className="h-4 w-4" />}
            label="Fleet cascades"
            to="/cascades"
            hint={`${cascadesQ.data?.delivered7d ?? 0} delivered to the fleet in 7 days`}
          >
            <div className="text-3xl font-semibold tabular-nums">{cascadesInFlight}</div>
            <div className="text-xs text-muted-foreground">
              security patches in flight
              {cascadesHeld > 0 ? ` · ${cascadesHeld} held for approval` : ""}
            </div>
          </Tile>
        </div>
      )}

      {/* Fixes in flight + recently merged */}
      <div className="grid gap-4 lg:grid-cols-2">
        <FixList
          icon={<GitPullRequest className="h-4 w-4" />}
          title="Fixes in flight"
          description="Being written, or opened and about to merge by themselves once their checks pass."
          empty="No fixes in flight."
          rows={fixesInFlight.slice(0, 8)}
        />
        <FixList
          icon={<GitMerge className="h-4 w-4" />}
          title="Merged in the last 7 days"
          description="On Prime, then to every clone through the cascade."
          empty="Nothing merged this week."
          rows={recentlyMerged}
        />
      </div>

      {/* Recent scan strip */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>Recent scans</CardTitle>
            <CardDescription>Latest 10 scans of Prime.</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm">
            <Link to="/security/scans">
              Full history <ArrowRight className="h-3 w-3 ml-1" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repo</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.slice(0, 10).map((j: any) => (
                <TableRow key={j.id}>
                  <TableCell className="font-mono text-xs">{j.repo_full_name}</TableCell>
                  <TableCell>{j.kind}</TableCell>
                  <TableCell>
                    <Badge variant={j.status === "failed" ? "destructive" : "outline"}>
                      {j.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs">
                    {j.started_at?.slice(0, 19).replace("T", " ") || "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {j.completed_at?.slice(0, 19).replace("T", " ") || "—"}
                  </TableCell>
                </TableRow>
              ))}
              {jobs.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                    No scans yet. Trigger one from the scans console.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Tile({
  icon,
  label,
  hint,
  to,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  to: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="hover:border-primary/40 transition-colors">
      <CardHeader className="pb-2">
        <CardDescription className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em]">
          {icon} {label}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Link to={to as any} className="block">
          {children}
          {hint && <div className="mt-2 text-[11px] text-muted-foreground">{hint}</div>}
        </Link>
      </CardContent>
    </Card>
  );
}

function FixList({
  icon,
  title,
  description,
  empty,
  rows,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  empty: string;
  rows: any[];
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            {icon} {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link to="/security/scans" hash="fix-prs">
            All fixes <ArrowRight className="h-3 w-3 ml-1" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch</TableHead>
                <TableHead>By</TableHead>
                <TableHead>State</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs truncate max-w-[180px]">
                    {r.branch_name}
                  </TableCell>
                  <TableCell className="text-xs">
                    {isFixEngine(r.engine) ? FIX_ENGINE_LABEL[r.engine] : "Codex"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.status.replace("_", " ")}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {r.pr_url ? (
                      <Button asChild size="sm" variant="ghost">
                        <a href={r.pr_url} target="_blank" rel="noreferrer">
                          PR <ArrowRight className="h-3 w-3 ml-1" />
                        </a>
                      </Button>
                    ) : (
                      <span className="text-muted-foreground text-xs">no PR yet</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
