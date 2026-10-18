import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ShieldCheck,
  ShieldAlert,
  GitPullRequest,
  CheckCircle2,
  Waves,
  Users,
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
import { listScanJobs, listCloneCodexOverview } from "@/lib/codex-security.functions";
import { getPrimePosture } from "@/lib/codex-findings.functions";
import {
  AWAITING_REVIEW_STATUSES,
  getSecurityCascadeSummary,
  listRemediations,
} from "@/lib/codex-remediation.functions";

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
          "Fleet-wide security posture: Codex scans in flight, open findings, remediation PRs awaiting review, and cascade rollout.",
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
  const fleetQ = useQuery({
    queryKey: ["clone-codex-overview"],
    queryFn: () => listCloneCodexOverview(),
    refetchInterval: 60000,
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
  const clones = fleetQ.data?.clones ?? [];
  const remediations = remQ.data?.remediations ?? [];
  const anyLoading = jobsQ.isLoading || fleetQ.isLoading || remQ.isLoading;

  // Prime + fleet. Prime used to be left out of this tile entirely.
  const fleetOpen = clones.reduce(
    (acc, c) => {
      for (const s of sevOrder) acc[s] += c.openFindings?.[s] ?? 0;
      return acc;
    },
    {
      critical: primeOpen.critical ?? 0,
      high: primeOpen.high ?? 0,
      medium: primeOpen.medium ?? 0,
      low: primeOpen.low ?? 0,
      info: primeOpen.info ?? 0,
    } as Record<string, number>,
  );

  const inflight = jobs.filter((j: any) =>
    ["queued", "running", "pending"].includes(j.status),
  ).length;
  const lastNightly = jobs.find((j: any) => j.kind === "nightly_full");
  const failedRecent = jobs.filter((j: any) => j.status === "failed").length;

  // By status: the workflow reports `pr_state: "draft_open"`, which the old
  // pr_state list never matched, so this tile always read zero.
  const prsAwaiting = remediations.filter((r: any) =>
    (AWAITING_REVIEW_STATUSES as readonly string[]).includes(r.status),
  );
  const prsMerged24h = remediations.filter(
    (r: any) => r.merged_at && Date.now() - new Date(r.merged_at).getTime() < 86_400_000,
  );

  const cascadesInFlight = cascadesQ.data?.inFlight ?? 0;
  const cascadesHeld = cascadesQ.data?.held ?? 0;

  const clonesWithCritical = clones
    .filter((c) => (c.openFindings?.critical ?? 0) + (c.openFindings?.high ?? 0) > 0)
    .sort(
      (a, b) =>
        b.openFindings.critical - a.openFindings.critical ||
        b.openFindings.high - a.openFindings.high,
    )
    .slice(0, 8);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <PageHeader
        eyebrow="security"
        icon={<ShieldCheck className="h-7 w-7 text-primary" />}
        title="Security Overview"
        description="Autonomous scans, findings, remediation PRs, and fleet rollout — one screen."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to="/security/scans">
                <PlayCircle className="h-4 w-4 mr-1" /> Open scans console
              </Link>
            </Button>
            <Button asChild>
              <Link to="/approvals">
                <CheckCircle2 className="h-4 w-4 mr-1" /> Review approvals
              </Link>
            </Button>
          </>
        }
      />

      {/* Top-line tiles */}
      {anyLoading && clones.length === 0 && jobs.length === 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[120px] animate-pulse border /40" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Tile
            icon={<ShieldAlert className="h-4 w-4" />}
            label="Open findings (Prime + fleet)"
            hint={`Prime: ${
              sevOrder
                .filter((s) => (primeOpen[s] ?? 0) > 0)
                .map((s) => `${primeOpen[s]} ${s}`)
                .join(", ") || "none open"
            }`}
            to="/security/scans"
          >
            <div className="flex flex-wrap gap-1.5 mt-1">
              {sevOrder.map((s) => (
                <Badge key={s} className={sevColor[s]}>
                  {s}: {fleetOpen[s]}
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
            label="Remediation PRs"
            to="/security/scans"
            hint={`${prsMerged24h.length} merged in last 24h`}
          >
            <div className="text-3xl font-semibold tabular-nums">{prsAwaiting.length}</div>
            <div className="text-xs text-muted-foreground">awaiting review</div>
          </Tile>
          <Tile
            icon={<Waves className="h-4 w-4" />}
            label="Fleet cascades"
            to="/cascades"
            hint={`${cascadesQ.data?.delivered7d ?? 0} delivered in 7 days · ${clones.length} clones`}
          >
            <div className="text-3xl font-semibold tabular-nums">{cascadesInFlight}</div>
            <div className="text-xs text-muted-foreground">
              security patches in flight
              {cascadesHeld > 0 ? ` · ${cascadesHeld} held for approval` : ""}
            </div>
          </Tile>
        </div>
      )}

      {/* Hotspots + PRs awaiting */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-4 w-4" /> Clone hotspots
              </CardTitle>
              <CardDescription>Clones with open critical or high findings.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/security/scans">
                All clones <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {clonesWithCritical.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No clones have open critical or high findings. Nice.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Clone</TableHead>
                    <TableHead className="text-right">Critical</TableHead>
                    <TableHead className="text-right">High</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clonesWithCritical.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-right">
                        {c.openFindings.critical > 0 ? (
                          <Badge className={sevColor.critical}>{c.openFindings.critical}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {c.openFindings.high > 0 ? (
                          <Badge className={sevColor.high}>{c.openFindings.high}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button asChild size="sm" variant="ghost">
                          <Link to="/clones/$cloneId" params={{ cloneId: c.id }}>
                            Open <ArrowRight className="h-3 w-3 ml-1" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <GitPullRequest className="h-4 w-4" /> PRs awaiting review
              </CardTitle>
              <CardDescription>
                Codex-drafted remediation PRs pending sign-off or merge.
              </CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/approvals">
                Approvals <ArrowRight className="h-3 w-3 ml-1" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {prsAwaiting.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing waiting on you.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Repo</TableHead>
                    <TableHead>Branch</TableHead>
                    <TableHead>State</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {prsAwaiting.slice(0, 8).map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.repo_full_name}</TableCell>
                      <TableCell className="font-mono text-xs truncate max-w-[160px]">
                        {r.branch_name}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.pr_state ?? r.status}</Badge>
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
      </div>

      {/* Recent scan strip */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>Recent scans</CardTitle>
            <CardDescription>Latest 10 scan jobs across the fleet.</CardDescription>
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
